import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  ApiError,
  type AuthenticationProvider,
} from '../../apps/api/src/auth.js';
import { createApp } from '../../apps/api/src/app.js';
import { JobQueue } from '../../apps/api/src/jobs.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import {
  SourceConnections,
  type SourceConnectionRecord,
  type SourceConnectionStore,
} from '../../apps/api/src/source-connections.js';
import { TestJobStore } from '../helpers/job-store.js';
import {
  combineProcessingStatus,
  createCloudImportRuntime,
} from '../../apps/api/src/cloud-import-runtime.js';

async function fixture(enabled = true, faceJobsEnabled?: boolean) {
  const owner = randomUUID(),
    rows = new Map<string, LibraryRecord>(),
    grants = new Map<string, SourceConnectionRecord>();
  const sourceStore: SourceConnectionStore = {
    get: async (id) => structuredClone(grants.get(id)),
    remove: async (id) => {
      grants.delete(id);
    },
    mutate: async (id, operation) => {
      const change = operation(structuredClone(grants.get(id)));
      if (change.record) grants.set(id, structuredClone(change.record));
      return change.result;
    },
  };
  const connections = new SourceConnections(
    sourceStore,
    'a'.repeat(64),
    async () => {
      throw new Error('No live refresh allowed in tests');
    },
  );
  const connect = () =>
    connections.connect(owner, 'dropbox', {
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      accessExpiresAt: Date.now() + 3600000,
    });
  const { generation } = await connect();
  const store: LibraryStore = {
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Missing');
      return structuredClone(row);
    },
    list: async (id, kind) =>
      [...rows.values()]
        .filter((row) => row.ownerId === id && row.kind === kind)
        .map((row) => structuredClone(row)),
    put: async (row, create) => {
      if (create && rows.has(row.id))
        throw new ApiError(409, 'CONFLICT', 'Exists');
      rows.set(row.id, structuredClone(row));
    },
    remove: async (id) => {
      rows.delete(id);
    },
    upload: vi.fn(),
    removeFile: vi.fn(),
    file: vi.fn(),
  };
  const provider: AuthenticationProvider = {
    register: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    getUser: async (secret) => ({
      id: secret,
      name: 'Synthetic',
      email: 'synthetic@example.test',
      emailVerified: true,
    }),
  };
  const queue = new JobQueue(new TestJobStore());
  const app = createApp(
    { provider, webOrigin: 'http://localhost:5173', secureCookies: false },
    {
      store,
      jobQueue: queue,
      sourceConnections: connections,
      cloudImportsEnabled: enabled,
      ...(faceJobsEnabled === undefined
        ? {}
        : {
            faceJobsEnabled,
            faceMatcher: {
              healthCheck: vi.fn(),
              ensureScope: vi.fn(),
              deleteScope: vi.fn(),
              deleteFaces: vi.fn(),
              indexPhoto: vi.fn(),
              search: vi.fn(),
            },
          }),
    },
  );
  const data = {
    provider: 'dropbox',
    generation,
    requestId: randomUUID(),
    ids: ['id:first', 'id:second'],
  };
  const post = (
    path: string,
    body: object,
    consent = 'cloud-import-v1',
    asOwner = owner,
  ) =>
    request(app)
      .post('/api/imports/queued' + path)
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', 'picfind_session=' + asOwner)
      .set('X-PicFind-Consent', consent)
      .send(body);
  return {
    app,
    owner,
    rows,
    queue,
    connections,
    generation,
    data,
    post,
    connect,
    store,
  };
}
describe('saved cloud import API without cloud-provider calls', () => {
  it('requires authentication, a trusted origin, and import-specific consent', async () => {
    const f = await fixture();
    await request(f.app)
      .post('/api/imports/queued')
      .set('Origin', 'http://localhost:5173')
      .send(f.data)
      .expect(401);
    await request(f.app)
      .post('/api/imports/queued')
      .set('Origin', 'https://untrusted.example')
      .set('Cookie', 'picfind_session=' + f.owner)
      .send(f.data)
      .expect(403);
    await f.post('', f.data, 'face-matching-v1').expect(400);
    expect(await f.queue.list(f.owner)).toHaveLength(0);
  });
  it('queues an immutable import and returns before downloading any photos', async () => {
    const f = await fixture(),
      response = await f.post('', f.data).expect(202);
    expect(response.body.job).toMatchObject({
      status: 'queued',
      total: 2,
      imported: 0,
      source: 'dropbox',
    });
    const saved = await f.queue.owned(response.body.job.id, f.owner);
    expect(saved).toMatchObject({
      type: 'cloud-import',
      consentPolicyVersion: 'cloud-import-v1',
      importSource: { generation: f.generation },
    });
    expect(saved.photoIds).toEqual(f.data.ids);
    expect(JSON.stringify(response.body)).not.toContain('synthetic-access');
    expect(response.body.job.photoIds).toBeUndefined();
    expect(response.body.job.leaseToken).toBeUndefined();
    const library = await request(f.app)
      .get('/api/library')
      .set('Cookie', 'picfind_session=' + f.owner)
      .expect(200);
    expect(library.body.jobs[0]).toMatchObject({
      state: 'running',
      processing: { status: 'queued' },
    });
  });
  it('reuses the original request and rejects a different selection with that request id', async () => {
    const f = await fixture(),
      first = await f.post('', f.data).expect(202);
    const repeat = await f
      .post('', { ...f.data, ids: [...f.data.ids].reverse() })
      .expect(202);
    expect(repeat.body.job.id).toBe(first.body.job.id);
    await f.post('', { ...f.data, ids: ['id:other'] }).expect(409);
    expect(await f.queue.list(f.owner)).toHaveLength(1);
  });
  it('checks connection generation before creating an import record', async () => {
    const f = await fixture();
    await f.post('', { ...f.data, generation: randomUUID() }).expect(409);
    expect(f.rows.size).toBe(0);
    const access = await request(f.app)
      .get('/api/imports/queued/connection/dropbox')
      .set('Cookie', 'picfind_session=' + f.owner)
      .expect(200);
    expect(access.body).toEqual({
      provider: 'dropbox',
      generation: f.generation,
    });
  });
  it('never allows another owner to inspect, pause or resume an import', async () => {
    const f = await fixture(),
      job = (await f.post('', f.data).expect(202)).body.job,
      stranger = randomUUID();
    await request(f.app)
      .get('/api/imports/queued/' + job.id)
      .set('Cookie', 'picfind_session=' + stranger)
      .expect(404);
    await f
      .post('/' + job.id + '/pause', {}, 'cloud-import-v1', stranger)
      .expect(404);
    await f
      .post(
        '/' + job.id + '/resume',
        { requestId: randomUUID(), generation: f.generation },
        'cloud-import-v1',
        stranger,
      )
      .expect(404);
  });
  it('checks ownership and availability of the destination event', async () => {
    const f = await fixture(),
      eventId = randomUUID();
    f.rows.set(eventId, {
      id: eventId,
      ownerId: randomUUID(),
      kind: 'event',
      createdAt: new Date().toISOString(),
    });
    await f.post('', { ...f.data, eventId }).expect(404);
    f.rows.set(eventId, {
      ...f.rows.get(eventId)!,
      ownerId: f.owner,
      archived: true,
    });
    await f.post('', { ...f.data, eventId }).expect(409);
    expect(await f.queue.list(f.owner)).toHaveLength(0);
  });
  it('pauses and creates one idempotent recovery attempt with the original photo snapshot', async () => {
    const f = await fixture(),
      job = (await f.post('', f.data).expect(202)).body.job;
    await f.post('/' + job.id + '/pause', {}).expect(200);
    const body = { requestId: randomUUID(), generation: f.generation };
    const resumed = (await f.post('/' + job.id + '/resume', body).expect(202))
      .body.job;
    expect(resumed.importId).toBe(job.importId);
    expect(resumed.id).not.toBe(job.id);
    expect((await f.queue.owned(resumed.id, f.owner)).photoIds).toEqual(
      f.data.ids,
    );
    const repeat = (await f.post('/' + job.id + '/resume', body).expect(202))
      .body.job;
    expect(repeat.id).toBe(resumed.id);
    await f
      .post('/' + job.id + '/resume', { ...body, requestId: randomUUID() })
      .expect(409);
    const list = await request(f.app)
      .get('/api/imports/queued')
      .set('Cookie', 'picfind_session=' + f.owner)
      .expect(200);
    expect(list.body.jobs.map((row: { id: string }) => row.id)).toEqual([
      resumed.id,
    ]);
  });
  it('requires explicit confirmation before a resumed job uses a reconnected source', async () => {
    const f = await fixture(),
      job = (await f.post('', f.data).expect(202)).body.job;
    await f.post('/' + job.id + '/pause', {}).expect(200);
    const { generation } = await f.connect(),
      body = { requestId: randomUUID(), generation };
    await f.post('/' + job.id + '/resume', body).expect(409);
    const resumed = (
      await f
        .post('/' + job.id + '/resume', {
          ...body,
          acceptConnectionChange: true,
        })
        .expect(202)
    ).body.job;
    expect(
      (await f.queue.owned(resumed.id, f.owner)).importSource?.generation,
    ).toBe(generation);
  });
  it('does not mutate jobs or download anything when the feature is disabled', async () => {
    const f = await fixture(false);
    await f.post('', f.data).expect(503);
    expect(f.rows.size).toBe(0);
    const capabilities = await request(f.app)
      .get('/api/capabilities')
      .expect(200);
    expect(capabilities.body.cloudImports).toBe(false);
  });
  it('bounds development imports and rejects source credentials in payloads', async () => {
    const f = await fixture();
    await f
      .post('', {
        ...f.data,
        ids: Array.from({ length: 21 }, (_, index) => 'id:' + index),
      })
      .expect(400);
    await f
      .post('', { ...f.data, accessToken: 'should-not-be-accepted' })
      .expect(400);
    expect(f.rows.size).toBe(0);
  });
});

describe('saved import review API regressions', () => {
  it('binds a partially enqueued root to its original connection generation', async () => {
    const f = await fixture(),
      enqueue = f.queue.enqueue.bind(f.queue);
    f.queue.enqueue = vi
      .fn(enqueue)
      .mockRejectedValueOnce(new Error('Synthetic enqueue failure'));
    await f.post('', f.data).expect(500);
    const { generation } = await f.connect();
    await f.post('', { ...f.data, generation }).expect(409);
    expect(await f.queue.list(f.owner)).toHaveLength(0);
  });
  it('keeps cloud imports available without accepting face jobs when their worker is disabled', async () => {
    const f = await fixture(true, false),
      eventId = randomUUID(),
      photoId = randomUUID();
    f.rows.set(eventId, {
      id: eventId,
      ownerId: f.owner,
      kind: 'event',
      createdAt: new Date().toISOString(),
    });
    f.rows.set(photoId, {
      id: photoId,
      ownerId: f.owner,
      eventId,
      kind: 'photo',
      createdAt: new Date().toISOString(),
      indexState: 'none',
    });
    const status = await request(f.app)
      .get('/api/events/' + eventId + '/processing')
      .set('Cookie', 'picfind_session=' + f.owner)
      .expect(200);
    expect(status.body.enabled).toBe(false);
    await request(f.app)
      .post('/api/events/' + eventId + '/index-faces')
      .set('Cookie', 'picfind_session=' + f.owner)
      .set('Origin', 'http://localhost:5173')
      .set('X-PicFind-Consent', 'face-matching-v1')
      .send({ requestId: randomUUID() })
      .expect(503);
    await request(f.app)
      .post('/api/discover/scans')
      .set('Cookie', 'picfind_session=' + f.owner)
      .set('Origin', 'http://localhost:5173')
      .send({
        photoIds: [photoId],
        requestId: randomUUID(),
        consent: true,
        policyVersion: 'face-matching-v1',
      })
      .expect(503);
    await f.post('', f.data).expect(202);
    expect(
      (await f.queue.list(f.owner)).every((job) => job.type === 'cloud-import'),
    ).toBe(true);
  });
});
describe('independent cloud-import runtime gates', () => {
  it('stays disabled without touching Appwrite or requiring AWS', async () => {
    const runtime = createCloudImportRuntime(
      { APPWRITE_ENDPOINT: '', APPWRITE_PROJECT_ID: '', APPWRITE_API_KEY: '' },
      undefined,
      {},
    );
    expect(runtime.enabled).toBe(false);
    expect(runtime.queue).toBeUndefined();
    expect(runtime.status().enabled).toBe(false);
    await runtime.stop();
  });
  it('fails closed when explicitly enabled without durable grants and storage', () => {
    expect(() =>
      createCloudImportRuntime(
        {
          APPWRITE_ENDPOINT: '',
          APPWRITE_PROJECT_ID: '',
          APPWRITE_API_KEY: '',
        },
        undefined,
        { CLOUD_IMPORT_WORKER_ENABLED: 'true' },
      ),
    ).toThrow('persistent cloud connections');
  });
  it('does not report ready while either enabled worker has never succeeded', () => {
    const good = {
      enabled: true,
      running: false,
      lastSuccessAt: '2026-09-21T00:00:00.000Z',
      error: null,
    };
    expect(
      combineProcessingStatus(good, { ...good, lastSuccessAt: null })
        .lastSuccessAt,
    ).toBeNull();
    expect(
      combineProcessingStatus(good, {
        ...good,
        enabled: false,
        lastSuccessAt: null,
      }).lastSuccessAt,
    ).toBe(good.lastSuccessAt);
  });
});
describe('event-scoped import history and expiry', () => {
  it.each(['2000-01-01T00:00:00.000Z', 'not-a-date'])(
    'rejects a closed or invalid event expiry: %s',
    async (expiresAt) => {
      const f = await fixture(),
        eventId = randomUUID();
      f.rows.set(eventId, {
        id: eventId,
        ownerId: f.owner,
        kind: 'event',
        createdAt: new Date().toISOString(),
        expiresAt,
      });
      const response = await f.post('', { ...f.data, eventId }).expect(409);
      expect(response.body.error.code).toBe('EVENT_UNAVAILABLE');
      expect(await f.queue.list(f.owner)).toHaveLength(0);
    },
  );
  it('separates personal, Event A and Event B import history', async () => {
    const f = await fixture(),
      events = [randomUUID(), randomUUID()];
    for (const id of events)
      f.rows.set(id, {
        id,
        ownerId: f.owner,
        kind: 'event',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });
    const personal = (await f.post('', f.data).expect(202)).body.job;
    const eventJobs = [];
    for (const eventId of events)
      eventJobs.push(
        (
          await f
            .post('', { ...f.data, requestId: randomUUID(), eventId })
            .expect(202)
        ).body.job,
      );
    const list = async (eventId?: string) =>
      (
        await request(f.app)
          .get('/api/imports/queued' + (eventId ? '?eventId=' + eventId : ''))
          .set('Cookie', 'picfind_session=' + f.owner)
          .expect(200)
      ).body.jobs;
    expect((await list()).map((job: { id: string }) => job.id)).toEqual([
      personal.id,
    ]);
    for (const [index, id] of events.entries())
      expect((await list(id)).map((job: { id: string }) => job.id)).toEqual([
        eventJobs[index].id,
      ]);
  });
  it("does not expose another owner's event import history", async () => {
    const f = await fixture(),
      eventId = randomUUID();
    f.rows.set(eventId, {
      id: eventId,
      ownerId: randomUUID(),
      kind: 'event',
      createdAt: new Date().toISOString(),
    });
    await request(f.app)
      .get('/api/imports/queued?eventId=' + eventId)
      .set('Cookie', 'picfind_session=' + f.owner)
      .expect(404);
    await request(f.app)
      .get('/api/imports/queued?eventId=invalid')
      .set('Cookie', 'picfind_session=' + f.owner)
      .expect(400);
  });
  it('refuses to resume a saved import after its destination expires', async () => {
    const f = await fixture(),
      eventId = randomUUID();
    f.rows.set(eventId, {
      id: eventId,
      ownerId: f.owner,
      kind: 'event',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    const job = (await f.post('', { ...f.data, eventId }).expect(202)).body.job;
    await f.post('/' + job.id + '/pause', {}).expect(200);
    f.rows.set(eventId, {
      ...f.rows.get(eventId)!,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    await f
      .post('/' + job.id + '/resume', {
        requestId: randomUUID(),
        generation: f.generation,
      })
      .expect(409);
    expect(await f.queue.list(f.owner)).toHaveLength(1);
  });
  it('never reassigns an existing import request to another event', async () => {
    const f = await fixture(),
      first = randomUUID(),
      second = randomUUID();
    for (const id of [first, second])
      f.rows.set(id, {
        id,
        ownerId: f.owner,
        kind: 'event',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      });
    await f.post('', { ...f.data, eventId: first }).expect(202);
    await f.post('', { ...f.data, eventId: second }).expect(409);
    expect(await f.queue.list(f.owner)).toHaveLength(1);
  });
});

describe('transactional event import staging integration', () => {
  it('does not write a root or enqueue when transactional staging refuses', async () => {
    const f = await fixture();
    const eventId = randomUUID();
    f.rows.set(eventId, {
      id: eventId,
      ownerId: f.owner,
      kind: 'event',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    f.store.stageEventImport = vi.fn(async () => {
      throw new ApiError(409, 'IMPORT_UNAVAILABLE', 'Synthetic race');
    });
    await f.post('', { ...f.data, eventId }).expect(409);
    expect(f.store.stageEventImport).toHaveBeenCalledOnce();
    expect(
      [...f.rows.values()].filter((row) => row.kind === 'job'),
    ).toHaveLength(0);
    expect(await f.queue.list(f.owner)).toEqual([]);
  });
  it('uses staging for first creation and an idempotent event retry only', async () => {
    const f = await fixture();
    const eventId = randomUUID();
    f.rows.set(eventId, {
      id: eventId,
      ownerId: f.owner,
      kind: 'event',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });
    f.store.stageEventImport = vi.fn(async (actor, root) => {
      expect(actor).toBe(f.owner);
      f.rows.set(root.id, root);
      return root;
    });
    await f.post('', { ...f.data, eventId }).expect(202);
    await f.post('', { ...f.data, eventId }).expect(202);
    expect(f.store.stageEventImport).toHaveBeenCalledTimes(2);
    await f.post('', { ...f.data, requestId: randomUUID() }).expect(202);
    expect(f.store.stageEventImport).toHaveBeenCalledTimes(2);
  });
});
