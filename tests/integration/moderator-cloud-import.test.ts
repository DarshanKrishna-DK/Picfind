import { randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { ApiError } from '../../apps/api/src/auth.js';
import { JobQueue } from '../../apps/api/src/jobs.js';
import { CloudImportWorker } from '../../apps/api/src/cloud-import-worker.js';
import { createCloudPhotoImporter } from '../../apps/api/src/cloud-photo-import.js';
import type { CloudFileReader } from '../../apps/api/src/cloud-file-reader.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import {
  SourceConnections,
  type SourceConnectionRecord,
  type SourceConnectionStore,
  type SourceProvider,
} from '../../apps/api/src/source-connections.js';
import { paidOrganizerBilling } from '../helpers/organizer-billing.js';
import { TestJobStore } from '../helpers/job-store.js';

const origin = 'http://localhost:5173';
const moderator = {
  id: 'moderator',
  name: 'Morgan',
  email: 'morgan@example.test',
  emailVerified: true,
};
async function fixture(provider: SourceProvider = 'dropbox') {
  const rows = new Map<string, LibraryRecord>();
  const billing = await paidOrganizerBilling(rows, 'owner');
  const event = await billing.saveOrganizerEvent(
    'owner',
    randomUUID(),
    {
      title: 'Collaboration',
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    },
    true,
  );
  const member = await billing.inviteEventMember('owner', event.id, moderator);
  const objects = new Map<string, Uint8Array>();
  const store: LibraryStore = {
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable');
      return structuredClone(row);
    },
    list: async (owner, kind) =>
      [...rows.values()]
        .filter((row) => row.ownerId === owner && row.kind === kind)
        .map((row) => structuredClone(row)),
    put: async (row, create) => {
      if (create && rows.has(row.id))
        throw new ApiError(409, 'CONFLICT', 'Exists');
      rows.set(row.id, structuredClone(row));
    },
    remove: async (id) => {
      rows.delete(id);
    },
    upload: vi.fn(async (id, bytes) => {
      objects.set(id, new Uint8Array(bytes));
    }),
    removeFile: vi.fn(async (id) => {
      objects.delete(id);
    }),
    file: async (id) => new Response(new Uint8Array(objects.get(id) ?? [])),
  };
  const grants = new Map<string, SourceConnectionRecord>();
  const sourceStore: SourceConnectionStore = {
    get: async (id) => structuredClone(grants.get(id)),
    remove: async (id) => {
      grants.delete(id);
    },
    mutate: async (id, op) => {
      const change = op(structuredClone(grants.get(id)));
      if (change.record) grants.set(id, structuredClone(change.record));
      return change.result;
    },
  };
  const connections = new SourceConnections(
    sourceStore,
    'a'.repeat(64),
    async () => {
      throw new Error('No external refresh allowed');
    },
  );
  const { generation } = await connections.connect('moderator', provider, {
    accessToken: 'synthetic-moderator',
    refreshToken: 'synthetic-refresh',
    accessExpiresAt: Date.now() + 3600000,
  });
  await connections.connect('owner', provider, {
    accessToken: 'synthetic-owner',
    refreshToken: 'synthetic-owner-refresh',
    accessExpiresAt: Date.now() + 3600000,
  });
  const access = vi.spyOn(connections, 'access');
  const jobs = new TestJobStore(),
    queue = new JobQueue(jobs);
  const app = createApp(
    {
      webOrigin: origin,
      secureCookies: false,
      provider: {
        getUser: async (secret) => ({
          id: secret,
          name: secret,
          email: `${secret}@example.test`,
          emailVerified: true,
        }),
        register: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
      },
    },
    {
      store,
      billing,
      jobQueue: queue,
      sourceConnections: connections,
      cloudImportsEnabled: true,
    },
  );
  const bytes = await sharp({
    create: { width: 16, height: 16, channels: 3, background: '#338877' },
  })
    .jpeg()
    .toBuffer();
  const read = vi.fn<CloudFileReader>(async () => ({
    name: 'synthetic.jpg',
    bytes: Buffer.from(bytes),
  }));
  const importer = createCloudPhotoImporter(
    store,
    connections,
    billing,
    {
      production: false,
      libraryPhotos: 20,
      events: 20,
      eventPhotos: 20,
      discoverPhotos: 20,
    },
    read,
  );
  const worker = new CloudImportWorker(queue, store, importer);
  const enqueue = (actor = 'moderator') =>
    request(app)
      .post('/api/imports/queued')
      .set('Cookie', `picfind_session=${actor}`)
      .set('Origin', origin)
      .set('X-PicFind-Consent', 'cloud-import-v1')
      .send({
        requestId: randomUUID(),
        provider,
        generation,
        ids: ['selected-photo'],
        eventId: event.id,
      });
  return {
    app,
    event,
    member,
    rows,
    objects,
    store,
    billing,
    connections,
    access,
    generation,
    queue,
    worker,
    read,
    enqueue,
  };
}
describe('moderator cloud jobs, synthetic providers only', () => {
  it.each(['drive', 'dropbox', 'onedrive', 'box'] as const)(
    'imports %s from the moderator account into organizer storage',
    async (provider) => {
      const f = await fixture(provider),
        reserve = vi.spyOn(f.billing, 'reserveStorage');
      const queued = await f.enqueue().expect(202);
      const job = await f.queue.owned(queued.body.job.id, 'owner');
      expect(job.importSource).toMatchObject({
        actorId: 'moderator',
        membershipGrantId: f.member.grantId,
        destinationEventId: f.event.id,
      });
      await f.worker.processNext();
      expect((await f.queue.owned(job.id, 'owner')).status).toBe('complete');
      expect(f.read).toHaveBeenCalledOnce();
      expect(f.read.mock.calls[0]?.[1]).toBe('synthetic-moderator');
      expect(f.access.mock.calls.every((call) => call[0] === 'moderator')).toBe(
        true,
      );
      const photos = [...f.rows.values()].filter((row) => row.kind === 'photo');
      expect(photos).toHaveLength(1);
      expect(photos[0]).toMatchObject({
        ownerId: 'owner',
        eventId: f.event.id,
        uploadedBy: 'moderator',
      });
      expect(reserve.mock.calls[0]?.[0]).toBe('owner');
      expect(reserve.mock.calls[0]?.[4]).toBe('organizer');
      const personal = await request(f.app)
        .get('/api/library')
        .set('Cookie', 'picfind_session=moderator')
        .expect(200);
      expect(personal.body.photos).toEqual([]);
    },
  );
  it('does not download from a queued grant revoked and then reissued', async () => {
    const f = await fixture(),
      queued = await f.enqueue().expect(202);
    await f.billing.revokeEventMember('owner', f.event.id, 'moderator');
    await f.billing.inviteEventMember('owner', f.event.id, moderator);
    await f.worker.processNext();
    expect(f.read).not.toHaveBeenCalled();
    expect((await f.queue.owned(queued.body.job.id, 'owner')).failureCode).toBe(
      'EVENT_UNAVAILABLE',
    );
    await request(f.app)
      .get(`/api/imports/queued/${queued.body.job.id}`)
      .set('Cookie', 'picfind_session=moderator')
      .expect(404);
    const list = await request(f.app)
      .get(`/api/imports/queued?eventId=${f.event.id}`)
      .set('Cookie', 'picfind_session=moderator')
      .expect(200);
    expect(list.body.jobs).toEqual([]);
  });
  it('lets the owner pause but only the source account holder resume', async () => {
    const f = await fixture(),
      queued = await f.enqueue().expect(202),
      id = queued.body.job.id;
    const ownerList = await request(f.app)
      .get(`/api/imports/queued?eventId=${f.event.id}`)
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(ownerList.body.jobs[0].canResume).toBe(false);
    await request(f.app)
      .post(`/api/imports/queued/${id}/pause`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .expect(200);
    const resume = (actor: string) =>
      request(f.app)
        .post(`/api/imports/queued/${id}/resume`)
        .set('Cookie', `picfind_session=${actor}`)
        .set('Origin', origin)
        .set('X-PicFind-Consent', 'cloud-import-v1')
        .send({ requestId: randomUUID(), generation: f.generation });
    await resume('owner').expect(403);
    const resumed = await resume('moderator').expect(202);
    expect(resumed.body.job.canResume).toBe(true);
    await f.worker.processNext();
    expect((await f.queue.owned(resumed.body.job.id, 'owner')).status).toBe(
      'complete',
    );
  });
  it('rejects a guest and another moderator probing someone else source job', async () => {
    const f = await fixture();
    await f.enqueue('guest').expect(404);
    const queued = await f.enqueue().expect(202);
    await f.billing.inviteEventMember('owner', f.event.id, {
      ...moderator,
      id: 'second',
      email: 'second@example.test',
    });
    for (const actor of ['guest', 'second']) {
      await request(f.app)
        .get(`/api/imports/queued/${queued.body.job.id}`)
        .set('Cookie', `picfind_session=${actor}`)
        .expect(404);
      await request(f.app)
        .post(`/api/imports/queued/${queued.body.job.id}/pause`)
        .set('Cookie', `picfind_session=${actor}`)
        .set('Origin', origin)
        .expect(404);
    }
  });
  it('cleans up an uploaded object if membership is revoked before publication', async () => {
    const f = await fixture(),
      queued = await f.enqueue().expect(202);
    vi.mocked(f.store.upload).mockImplementation(async (id, bytes) => {
      f.objects.set(id, new Uint8Array(bytes));
      await f.billing.revokeEventMember('owner', f.event.id, 'moderator');
    });
    await f.worker.processNext();
    expect((await f.queue.owned(queued.body.job.id, 'owner')).failureCode).toBe(
      'EVENT_UNAVAILABLE',
    );
    expect(f.objects.size).toBe(0);
    expect([...f.rows.values()].filter((row) => row.kind === 'photo')).toEqual(
      [],
    );
    expect(f.store.removeFile).toHaveBeenCalledOnce();
  });
});
