import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { ApiError } from '../../apps/api/src/auth.js';
import { FolderSyncControls } from '../../apps/api/src/folder-sync-controls.js';
import type {
  FolderSync,
  FolderSyncDirectory,
} from '../../apps/api/src/folder-sync.js';
import { JobQueue } from '../../apps/api/src/jobs.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import { TestJobStore } from '../helpers/job-store.js';
import { paidOrganizerBilling } from '../helpers/organizer-billing.js';
import { createFolderSyncImportBridge } from '../../apps/api/src/folder-sync-imports.js';
import { CloudImportWorker } from '../../apps/api/src/cloud-import-worker.js';
import {
  cloudPhotoId,
  type ImportPhoto,
} from '../../apps/api/src/cloud-photo-import.js';
import { stableScanId } from '../../apps/api/src/scan-photo-preparation.js';

const origin = 'http://localhost:5173';
async function fixture() {
  const now = new Date().toISOString(),
    expiry = new Date(Date.now() + 86400000).toISOString();
  const event: LibraryRecord = {
    id: randomUUID(),
    ownerId: 'owner',
    kind: 'event',
    createdAt: now,
    expiresAt: expiry,
    members: [
      {
        userId: 'moderator',
        role: 'moderator',
        grantId: randomUUID(),
        addedAt: now,
      },
    ],
  };
  const sync: FolderSync = {
    consentPolicyVersion: 'folder-sync-v1',
    id: randomUUID(),
    ownerId: 'owner',
    actorId: 'moderator',
    membershipGrantId: event.members![0]!.grantId,
    eventId: event.id,
    provider: 'drive',
    generation: randomUUID(),
    folderId: 'private-folder-name',
    status: 'active',
    createdAt: now,
    nextRunAt: now,
    cursor: 'private-cursor',
    pages: 1,
    imported: 12,
    leaseToken: randomUUID(),
    leaseUntil: expiry,
    pending: {
      requestId: randomUUID(),
      fileIds: ['private-file-id'],
      nextCursor: null,
    },
  };
  const rows = new Map<string, LibraryRecord>([[event.id, event]]),
    sources = new Map<string, FolderSync>([[sync.id, sync]]);
  const library: LibraryStore = {
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable');
      return structuredClone(row);
    },
    list: async (owner, kind) =>
      [...rows.values()].filter(
        (row) => row.ownerId === owner && row.kind === kind,
      ),
    put: async (row) => {
      rows.set(row.id, row);
    },
    remove: async (id) => {
      rows.delete(id);
    },
    upload: vi.fn(),
    file: vi.fn(),
    removeFile: vi.fn(),
  };
  const directory: FolderSyncDirectory = {
    isSuppressed: async () => false,
    get: async (id) => structuredClone(sources.get(id)),
    candidates: async () => [],
    knownFiles: async () => new Set(),
    listEvent: async (owner, eventId) =>
      [...sources.values()]
        .filter((row) => row.ownerId === owner && row.eventId === eventId)
        .map((row) => structuredClone(row)),
    mutate: async (id, operation) => {
      const result = operation(structuredClone(sources.get(id)));
      if (result.record) sources.set(id, result.record);
      return result.result;
    },
  };
  const queue = new JobQueue(new TestJobStore());
  const job = await queue.enqueue({
    ownerId: 'owner',
    eventId: randomUUID(),
    requestId: sync.pending!.requestId,
    type: 'cloud-import',
    photoIds: sync.pending!.fileIds,
    consentPolicyVersion: 'cloud-import-v1',
    importSource: {
      provider: 'drive',
      generation: sync.generation,
      destinationEventId: event.id,
      folderSyncId: sync.id,
      actorId: 'moderator',
      membershipGrantId: sync.membershipGrantId!,
    },
  });
  sync.pending!.batchId = job.id;
  const authorizeFolderSync = vi.fn(async () => ({ expiresAt: expiry }));
  const access = vi.fn(async () => ({
    accessToken: 'synthetic-secret',
    generation: sync.generation,
    expiresAt: Date.now() + 60000,
  }));
  const controls = new FolderSyncControls(
    directory,
    library,
    { authorizeFolderSync },
    { access },
    queue,
  );
  const auth = {
    webOrigin: origin,
    secureCookies: false,
    provider: {
      getUser: async (id: string) => ({
        id,
        name: id,
        email: id + '@example.test',
        emailVerified: true,
      }),
      register: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
    },
  };
  const app = createApp(auth, { store: library, folderSyncControls: controls });
  const url = `/api/events/${event.id}/sources`;
  return {
    event,
    sync,
    rows,
    sources,
    library,
    directory,
    queue,
    job,
    controls,
    authorizeFolderSync,
    access,
    app,
    auth,
    url,
  };
}

describe('event source status and stop controls, no provider network', () => {
  it('lists sanitized owner status without revealing the moderator folder or private manifest', async () => {
    const f = await fixture();
    const result = await request(f.app)
      .get(f.url)
      .set('Cookie', 'picfind_session=owner')
      .expect(200);
    expect(result.body.sources[0]).toMatchObject({
      imported: 12,
      provider: 'drive',
      folder: null,
      sourceOwner: false,
      canStop: true,
    });
    for (const privateValue of [
      'private-cursor',
      'private-file-id',
      'private-folder-name',
      f.sync.generation,
      f.sync.leaseToken!,
    ])
      expect(JSON.stringify(result.body)).not.toContain(privateValue);
    expect(f.access).not.toHaveBeenCalled();
  });
  it('shows a moderator only their own current-grant sources', async () => {
    const f = await fixture();
    const other = {
      ...f.sync,
      id: randomUUID(),
      actorId: 'other',
      membershipGrantId: randomUUID(),
    };
    f.sources.set(other.id, other);
    const result = await request(f.app)
      .get(f.url)
      .set('Cookie', 'picfind_session=moderator')
      .expect(200);
    expect(result.body.sources).toHaveLength(1);
    expect(result.body.sources[0]).toMatchObject({
      folder: 'private-folder-name',
      sourceOwner: true,
    });
  });
  it('does not expose sources without sign-in or to event guests', async () => {
    const f = await fixture();
    await request(f.app).get(f.url).expect(401);
    await request(f.app)
      .get(f.url)
      .set('Cookie', 'picfind_session=guest')
      .expect(404);
  });
  it.each(['owner', 'moderator'])(
    'allows %s to stop this source and cancels its batch',
    async (actor) => {
      const f = await fixture();
      const response = await request(f.app)
        .post(f.url + '/' + f.sync.id + '/stop')
        .set('Cookie', 'picfind_session=' + actor)
        .set('Origin', origin)
        .send({})
        .expect(200);
      expect(response.body.source.status).toBe('paused');
      expect(f.sources.get(f.sync.id)?.leaseToken).toBeUndefined();
      expect(await f.queue.owned(f.job.id, 'owner')).toMatchObject({
        status: 'cancelled',
      });
      expect(f.sources.get(f.sync.id)?.pending?.fileIds).toEqual([
        'private-file-id',
      ]);
      expect(f.access).not.toHaveBeenCalled();
    },
  );
  it('forbids a moderator from stopping another actor source', async () => {
    const f = await fixture();
    f.sync.actorId = 'another';
    f.sync.membershipGrantId = randomUUID();
    await request(f.app)
      .post(f.url + '/' + f.sync.id + '/stop')
      .set('Cookie', 'picfind_session=moderator')
      .set('Origin', origin)
      .send({})
      .expect(404);
    expect(f.sync.status).toBe('active');
  });
  it('lets the owner stop a source even after its moderator has been removed', async () => {
    const f = await fixture();
    f.rows.get(f.event.id)!.members = [];
    await expect(
      f.controls.stop('owner', f.event.id, f.sync.id),
    ).resolves.toMatchObject({ status: 'paused' });
  });
  it('keeps the source paused if queue cancellation fails', async () => {
    const f = await fixture();
    vi.spyOn(f.queue, 'cancel').mockRejectedValueOnce(
      new Error('queue unavailable'),
    );
    await expect(
      f.controls.stop('owner', f.event.id, f.sync.id),
    ).rejects.toThrow('queue unavailable');
    expect(f.sources.get(f.sync.id)?.status).toBe('paused');
    await expect(
      f.controls.stop('owner', f.event.id, f.sync.id),
    ).resolves.toMatchObject({ status: 'paused' });
  });
  it('does not cancel an unrelated batch after detecting a corrupted reference', async () => {
    const f = await fixture(),
      cancel = vi.spyOn(f.queue, 'cancel');
    f.sync.pending!.requestId = randomUUID();
    await expect(
      f.controls.stop('owner', f.event.id, f.sync.id),
    ).rejects.toMatchObject({ code: 'SYNC_STORAGE_INVALID' });
    expect(f.sources.get(f.sync.id)?.status).toBe('paused');
    expect(cancel).not.toHaveBeenCalled();
  });
  it('requires trusted origin and rejects settings injected into stop', async () => {
    const f = await fixture();
    await request(f.app)
      .post(f.url + '/' + f.sync.id + '/stop')
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', 'https://attacker.example')
      .send({})
      .expect(403);
    await request(f.app)
      .post(f.url + '/' + f.sync.id + '/stop')
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .send({ ownerId: 'other' })
      .expect(400);
    expect(f.sources.get(f.sync.id)?.status).toBe('active');
  });
  it('reports an expired event as closed instead of promising another check', async () => {
    const f = await fixture();
    f.event.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect((await f.controls.list('owner', f.event.id))[0]).toMatchObject({
      status: 'expired',
      nextCheckAt: null,
      canStop: false,
    });
  });
  it('leaves status endpoints disabled without runtime controls', async () => {
    const f = await fixture(),
      app = createApp(f.auth, { store: f.library });
    await request(app)
      .get(f.url)
      .set('Cookie', 'picfind_session=owner')
      .expect(503);
  });
  it('uses only the source actor connection and returns no access token', async () => {
    const f = await fixture();
    expect(await f.controls.authorize(f.sync)).toEqual({
      expiresAt: f.event.expiresAt,
    });
    expect(f.access).toHaveBeenCalledWith(
      'moderator',
      'drive',
      f.sync.generation,
    );
  });
  it('does not access cloud credentials when billing authorization fails', async () => {
    const f = await fixture();
    f.authorizeFolderSync.mockRejectedValueOnce(
      new ApiError(402, 'ORGANIZER_REQUIRED', 'Upgrade'),
    );
    await expect(f.controls.authorize(f.sync)).rejects.toMatchObject({
      code: 'ORGANIZER_REQUIRED',
    });
    expect(f.access).not.toHaveBeenCalled();
  });
});

describe('consented event source creation with synthetic paid grants', () => {
  async function resumeFixture() {
    const f = await creationFixture(),
      created = await f.post().expect(201),
      id = created.body.source.id as string;
    f.sources.get(id)!.pending = {
      requestId: randomUUID(),
      fileIds: ['file-a', 'file-b'],
      nextCursor: null,
    };
    const bridge = createFolderSyncImportBridge({
      queue: f.queue,
      store: f.library,
      syncs: f.directory,
      authorize: (sync) => f.controls.authorize(sync),
      stage: (sync, root) => f.billing.stageFolderSyncImport(sync, root),
      publish: (sync, root, photo) =>
        f.billing.commitFolderSyncPhoto(sync, root, photo),
    });
    const enqueue = async () => {
      const sync = structuredClone(f.sources.get(id)!);
      const batch = await bridge.enqueue(sync, sync.pending!, async () => {});
      f.sources.get(id)!.pending!.batchId = batch;
      return batch;
    };
    let failSecond = true;
    const copies: string[] = [];
    const importer: ImportPhoto = async (
      owner,
      rootId,
      source,
      fileId,
      guard,
    ) => {
      await guard();
      await bridge.assert(owner, await f.library.get(rootId), source, fileId);
      const photoId = cloudPhotoId(rootId, fileId);
      const previous = f.rows.get(photoId);
      if (previous) return previous;
      if (fileId === 'file-b' && failSecond)
        throw new ApiError(415, 'INVALID_IMAGE', 'Synthetic failure');
      copies.push(fileId);
      const photo: LibraryRecord = {
        id: photoId,
        ownerId: owner,
        eventId: f.event.id,
        importId: rootId,
        folderSyncId: id,
        uploadedBy: 'moderator',
        kind: 'photo',
        source: 'drive',
        sourcePhotoId: stableScanId('cloud-import-source', 'drive:' + fileId),
        createdAt: new Date().toISOString(),
        expiresAt: f.event.expiresAt!,
      };
      await f.library.put(photo);
      return photo;
    };
    const worker = new CloudImportWorker(f.queue, f.library, importer, bridge),
      originalBatch = await enqueue();
    await f.queue.cancel(f.job.id, 'owner');
    await worker.processNext();
    expect(await f.queue.owned(originalBatch, 'owner')).toMatchObject({
      status: 'partial',
      imported: 1,
      failed: 1,
    });
    await f.controls.stop('moderator', f.event.id, id);
    const resume = (
      requestId = randomUUID(),
      actor = 'moderator',
      consent = true,
    ) => {
      const call = request(f.app)
        .post(f.url + '/' + id + '/resume')
        .set('Cookie', 'picfind_session=' + actor)
        .set('Origin', origin);
      if (consent) call.set('X-PicFind-Consent', 'folder-sync-v1');
      return call.send({ requestId, generation: f.input.generation });
    };
    return {
      ...f,
      id,
      bridge,
      enqueue,
      worker,
      originalBatch,
      copies,
      resume,
      allowSecond: () => {
        failSecond = false;
      },
    };
  }
  async function creationFixture() {
    const f = await fixture();
    const billing = await paidOrganizerBilling(
      f.rows,
      'owner',
      undefined,
      f.sources,
    );
    const controls = new FolderSyncControls(
      f.directory,
      f.library,
      billing,
      { access: f.access },
      f.queue,
    );
    const app = createApp(f.auth, {
      store: f.library,
      folderSyncControls: controls,
    });
    const input = {
      requestId: randomUUID(),
      provider: 'drive' as const,
      generation: f.sync.generation,
      folderId: 'new-folder',
    };
    const post = (
      body: object = input,
      actor = 'moderator',
      consent = true,
    ) => {
      const call = request(app)
        .post(f.url)
        .set('Cookie', 'picfind_session=' + actor)
        .set('Origin', origin);
      if (consent) call.set('X-PicFind-Consent', 'folder-sync-v1');
      return call.send(body);
    };
    return { ...f, billing, controls, app, input, post };
  }
  it.each(['owner', 'moderator'])(
    'creates an event-owned source for %s with persisted consent',
    async (actor) => {
      const f = await creationFixture(),
        response = await f.post(f.input, actor).expect(201);
      const stored = f.sources.get(response.body.source.id)!;
      expect(stored).toMatchObject({
        ownerId: 'owner',
        actorId: actor,
        eventId: f.event.id,
        folderId: 'new-folder',
        consentPolicyVersion: 'folder-sync-v1',
        status: 'active',
      });
      expect(f.access).toHaveBeenCalledWith(actor, 'drive', f.sync.generation);
      expect(stored.membershipGrantId).toBe(
        actor === 'moderator' ? f.sync.membershipGrantId : undefined,
      );
      expect(stored.pending).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain('synthetic-secret');
      expect(await f.library.list('owner', 'photo')).toHaveLength(0);
    },
  );
  it('requires explicit copy-and-sync consent', async () => {
    const f = await creationFixture();
    await f.post(f.input, 'moderator', false).expect(400);
    expect(f.sources.size).toBe(1);
    expect(f.access).not.toHaveBeenCalled();
  });
  it('rejects injected owner, status or membership authority', async () => {
    const f = await creationFixture();
    await f
      .post({
        ...f.input,
        ownerId: 'other',
        status: 'active',
        membershipGrantId: randomUUID(),
      })
      .expect(400);
    expect(f.sources.size).toBe(1);
  });
  it('rejects guests before using any cloud connection', async () => {
    const f = await creationFixture();
    await f.post(f.input, 'guest').expect(404);
    expect(f.access).not.toHaveBeenCalled();
  });
  it('does not enable an entire account root', async () => {
    const f = await creationFixture();
    await f.post({ ...f.input, folderId: 'root' }).expect(400);
    expect(f.sources.size).toBe(1);
  });
  it('replays creation without duplicate definitions or reactivating a stopped source', async () => {
    const f = await creationFixture(),
      first = await f.post().expect(201);
    f.sources.get(first.body.source.id)!.status = 'paused';
    const replay = await f.post().expect(201);
    expect(replay.body.source).toMatchObject({
      id: first.body.source.id,
      status: 'paused',
    });
    expect(f.sources.size).toBe(2);
  });
  it('rejects reuse of a request for another folder', async () => {
    const f = await creationFixture();
    await f.post().expect(201);
    const response = await f
      .post({ ...f.input, folderId: 'another-folder' })
      .expect(409);
    expect(JSON.stringify(response.body)).toContain('SYNC_REQUEST_REUSED');
    expect(f.sources.size).toBe(2);
  });
  it('rejects duplicate folders under another request ID', async () => {
    const f = await creationFixture();
    await f.post().expect(201);
    const response = await f
      .post({ ...f.input, requestId: randomUUID() })
      .expect(409);
    expect(JSON.stringify(response.body)).toContain('SYNC_ALREADY_CONFIGURED');
  });
  it('enforces the active-source limit under concurrent creation', async () => {
    const f = await creationFixture();
    for (let i = 0; i < 6; i++) {
      const record = { ...f.sync, id: randomUUID(), folderId: 'seed-' + i };
      f.sources.set(record.id, record);
    }
    const responses = await Promise.all([
      f.post({ ...f.input, folderId: 'last-slot-a' }),
      f.post({ ...f.input, requestId: randomUUID(), folderId: 'last-slot-b' }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(
      [...f.sources.values()].filter((row) => row.status === 'active'),
    ).toHaveLength(8);
  });
  it('bounds retained definitions as well as active sources', async () => {
    const f = await creationFixture();
    f.sources.clear();
    for (let i = 0; i < 32; i++) {
      const row = {
        ...f.sync,
        id: randomUUID(),
        folderId: 'old-' + i,
        status: 'paused' as const,
      };
      f.sources.set(row.id, row);
    }
    await f.post().expect(409);
    expect(f.sources.size).toBe(32);
  });
  it('does not create after a source connection changes', async () => {
    const f = await creationFixture();
    f.access.mockRejectedValueOnce(
      new ApiError(409, 'SOURCE_CONNECTION_CHANGED', 'Changed'),
    );
    await f.post().expect(409);
    expect(f.sources.size).toBe(1);
  });
  it('rechecks the moderator grant after source authorization', async () => {
    const f = await creationFixture();
    f.access.mockImplementationOnce(async () => {
      f.rows.get(f.event.id)!.members![0]!.grantId = randomUUID();
      return {
        accessToken: 'synthetic-secret',
        generation: f.sync.generation,
        expiresAt: Date.now() + 60000,
      };
    });
    const response = await f.post().expect(409);
    expect(JSON.stringify(response.body)).toContain('MEMBERSHIP_CHANGED');
    expect(f.sources.size).toBe(1);
  });
  it('requires stopping and explicit confirmation before replacing a connected account', async () => {
    const f = await creationFixture();
    const changed = {
      ...f.input,
      generation: randomUUID(),
      folderId: f.sync.folderId,
    };
    let response = await f.post(changed).expect(409);
    expect(JSON.stringify(response.body)).toContain('SYNC_STOP_REQUIRED');
    f.sources.get(f.sync.id)!.status = 'paused';
    response = await f.post(changed).expect(409);
    expect(JSON.stringify(response.body)).toContain(
      'SYNC_RECONNECT_CONFIRMATION_REQUIRED',
    );
    response = await f
      .post({
        ...changed,
        replacesSyncId: f.sync.id,
        acceptConnectionChange: true,
      })
      .expect(201);
    expect(response.body.source.id).not.toBe(f.sync.id);
    expect(f.sources.get(response.body.source.id)?.imported).toBe(0);
    expect(f.sources.get(f.sync.id)?.imported).toBe(12);
  });
  it('resumes a partial batch with stable photo IDs and without recopying completed photos', async () => {
    const f = await resumeFixture(),
      previous = await f.queue.owned(f.originalBatch, 'owner');
    await f.resume().expect(200);
    expect(f.sources.get(f.id)?.pending?.preservedFileIndexes).toEqual([0]);
    f.allowSecond();
    const batch = await f.enqueue();
    await f.worker.processNext();
    const resumed = await f.queue.owned(batch, 'owner');
    expect(resumed.eventId).toBe(previous.eventId);
    expect(resumed.requestId).not.toBe(previous.requestId);
    expect(resumed).toMatchObject({ status: 'complete', imported: 2 });
    expect(f.copies).toEqual(['file-a', 'file-b']);
    expect(await f.bridge.inspect(f.sources.get(f.id)!, batch)).toBe(
      'complete',
    );
  });
  it('does not restore a deleted completed photo during resume', async () => {
    const f = await resumeFixture(),
      job = await f.queue.owned(f.originalBatch, 'owner');
    f.rows.delete(cloudPhotoId(job.eventId, 'file-a'));
    await f.resume().expect(409);
    expect(f.sources.get(f.id)?.status).toBe('paused');
    expect(f.copies).toEqual(['file-a']);
  });
  it('keeps the deletion safeguard after resume has been accepted', async () => {
    const f = await resumeFixture(),
      job = await f.queue.owned(f.originalBatch, 'owner');
    await f.resume().expect(200);
    f.rows.delete(cloudPhotoId(job.eventId, 'file-a'));
    f.allowSecond();
    const batch = await f.enqueue();
    await f.worker.processNext();
    expect(await f.queue.owned(batch, 'owner')).toMatchObject({
      status: 'failed',
    });
    expect(f.copies).toEqual(['file-a']);
    expect(f.rows.has(cloudPhotoId(job.eventId, 'file-a'))).toBe(false);
  });
  it('requires fresh resume consent and denies owner impersonation of a moderator connection', async () => {
    const f = await resumeFixture();
    await f.resume(randomUUID(), 'moderator', false).expect(400);
    await f.resume(randomUUID(), 'owner').expect(404);
    expect(f.sources.get(f.id)?.status).toBe('paused');
  });
  it('replays a resume request without creating another attempt', async () => {
    const f = await resumeFixture(),
      requestId = randomUUID();
    const first = await f.resume(requestId).expect(200),
      second = await f.resume(requestId).expect(200);
    expect(second.body.source).toEqual(first.body.source);
    expect(f.sources.get(f.id)?.pending?.attemptId).toBe(requestId);
  });
  it('rejects a changed connection on the resume endpoint', async () => {
    const f = await resumeFixture();
    await request(f.app)
      .post(f.url + '/' + f.id + '/resume')
      .set('Cookie', 'picfind_session=moderator')
      .set('Origin', origin)
      .set('X-PicFind-Consent', 'folder-sync-v1')
      .send({ requestId: randomUUID(), generation: randomUUID() })
      .expect(409);
    expect(f.sources.get(f.id)?.status).toBe('paused');
  });
  it('does not recreate a removed import root during recovery', async () => {
    const f = await resumeFixture(),
      job = await f.queue.owned(f.originalBatch, 'owner');
    f.rows.delete(job.eventId);
    await f.resume().expect(409);
    expect(f.rows.has(job.eventId)).toBe(false);
    expect(f.sources.get(f.id)?.status).toBe('paused');
  });
  it('resumes a source without a pending batch while retaining receipt counts', async () => {
    const f = await creationFixture(),
      created = await f.post().expect(201),
      id = created.body.source.id as string;
    f.sources.get(id)!.imported = 12;
    f.sources.get(id)!.cursor = 'old-private-cursor';
    await f.controls.stop('moderator', f.event.id, id);
    await f.controls.resume(
      'moderator',
      f.event.id,
      id,
      randomUUID(),
      f.input.generation,
    );
    expect(f.sources.get(id)).toMatchObject({
      status: 'active',
      cursor: null,
      pages: 0,
      imported: 12,
    });
  });
  it('does not resume beyond the event active-source cap', async () => {
    const f = await resumeFixture();
    for (let i = 0; i < 7; i++) {
      const row = { ...f.sync, id: randomUUID(), folderId: 'another-' + i };
      f.sources.set(row.id, row);
    }
    await f.resume().expect(409);
    expect(f.sources.get(f.id)?.status).toBe('paused');
  });
  it('will not authorize an old source that lacks automatic-import consent', async () => {
    const f = await creationFixture(),
      old = { ...f.sync };
    delete old.consentPolicyVersion;
    await expect(f.controls.authorize(old)).rejects.toMatchObject({
      code: 'SYNC_CONSENT_REQUIRED',
    });
    expect(f.access).not.toHaveBeenCalled();
  });
});

describe('real organizer policy for folder sync with synthetic paid grants', () => {
  it('authorizes the event owner plan rather than a moderator personal account', async () => {
    const f = await fixture(),
      billing = await paidOrganizerBilling(f.rows, 'owner');
    await expect(billing.authorizeFolderSync(f.sync)).resolves.toEqual({
      expiresAt: f.event.expiresAt,
    });
    f.rows.get(f.event.id)!.members = [];
    await expect(billing.authorizeFolderSync(f.sync)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('rejects an unpaid owner even if the source actor has an organizer plan', async () => {
    const f = await fixture(),
      billing = await paidOrganizerBilling(f.rows, 'moderator');
    await expect(billing.authorizeFolderSync(f.sync)).rejects.toMatchObject({
      code: 'ORGANIZER_REQUIRED',
    });
  });
  it('requires a finite future event expiry', async () => {
    const f = await fixture(),
      billing = await paidOrganizerBilling(f.rows, 'owner');
    delete f.rows.get(f.event.id)!.expiresAt;
    await expect(billing.authorizeFolderSync(f.sync)).rejects.toMatchObject({
      code: 'SYNC_EXPIRED',
    });
  });
  it('rejects an old moderator grant after reinvitation', async () => {
    const f = await fixture(),
      billing = await paidOrganizerBilling(f.rows, 'owner');
    f.rows.get(f.event.id)!.members![0]!.grantId = randomUUID();
    await expect(billing.authorizeFolderSync(f.sync)).rejects.toMatchObject({
      code: 'MEMBERSHIP_CHANGED',
    });
  });
});
