import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  ApiError,
  type AuthenticationProvider,
} from '../../apps/api/src/auth.js';
import { createApp } from '../../apps/api/src/app.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import type { FaceMatchingProvider } from '../../packages/shared/src/ports.js';
import { JobQueue } from '../../apps/api/src/jobs.js';
import { createPhotoIndexer } from '../../apps/api/src/face-indexing.js';
import { EventIndexWorker } from '../../apps/api/src/processing-worker.js';
import { TestJobStore } from '../helpers/job-store.js';

function fixture() {
  const ownerId = randomUUID();
  const event: LibraryRecord = {
    id: randomUUID(),
    ownerId,
    kind: 'event',
    title: 'Synthetic event',
    createdAt: new Date().toISOString(),
  };
  const photos: LibraryRecord[] = Array.from({ length: 2 }, () => ({
    id: randomUUID(),
    ownerId,
    eventId: event.id,
    kind: 'photo',
    createdAt: new Date().toISOString(),
    indexState: 'none',
  }));
  const rows = new Map([event, ...photos].map((row) => [row.id, row]));
  const store: LibraryStore = {
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Missing');
      return structuredClone(row);
    },
    list: async (owner, kind) =>
      [...rows.values()]
        .filter((r) => r.ownerId === owner && r.kind === kind)
        .map((r) => structuredClone(r)),
    put: async (row) => {
      rows.set(row.id, structuredClone(row));
    },
    remove: async (id) => {
      rows.delete(id);
    },
    upload: vi.fn(),
    file: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    removeFile: vi.fn(async () => {}),
  };
  const matcher: FaceMatchingProvider = {
    healthCheck: vi.fn(),
    ensureScope: vi.fn(async () => ({ modelVersion: 'synthetic' })),
    deleteScope: vi.fn(async () => {}),
    deleteFaces: vi.fn(async () => {}),
    search: vi.fn(),
    indexPhoto: vi.fn(async ({ photoId }) => ({
      faceIds: [`face-${photoId}`],
      externalImageId: photoId,
      modelVersion: 'synthetic',
      unindexedReasons: [],
    })),
  };
  const reserveUsage = vi.fn(async () => {});
  const queue = new JobQueue(new TestJobStore());
  const worker = new EventIndexWorker(
    queue,
    store,
    matcher,
    createPhotoIndexer({ providerName: 'aws-rekognition', reserveUsage }),
  );
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
  const app = createApp(
    { provider, webOrigin: 'http://localhost:5173', secureCookies: false },
    { store, faceMatcher: matcher, jobQueue: queue },
  );
  const enqueue = () =>
    queue.enqueue({
      ownerId,
      eventId: event.id,
      requestId: randomUUID(),
      photoIds: photos.map((p) => p.id),
      consentPolicyVersion: 'face-matching-v1',
    });
  return {
    ownerId,
    event,
    photos,
    rows,
    store,
    matcher,
    reserveUsage,
    queue,
    worker,
    app,
    enqueue,
  };
}
describe('durable event processing integration without live AWS', () => {
  it('serves current owner-only readiness without provider calls or file reads', async () => {
    const f = fixture();
    const path = `/api/events/${f.event.id}/processing`;
    await request(f.app).get(path).expect(401);
    await request(f.app)
      .get(path)
      .set('Cookie', 'picfind_session=other')
      .expect(404);
    const first = await request(f.app)
      .get(path)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .expect(200);
    expect(first.body.readiness).toMatchObject({
      status: 'not-prepared',
      counts: { total: 2, waiting: 2, prepared: 0 },
    });
    await f.enqueue();
    await f.worker.processNext();
    for (const photo of f.photos) {
      f.rows.get(photo.id)!.modelVersion = 'synthetic-face-model';
    }
    for (const method of Object.values(f.matcher))
      vi.mocked(method).mockClear();
    vi.mocked(f.store.file).mockClear();
    const second = await request(f.app)
      .get(path)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .expect(200);
    expect(second.body.readiness).toMatchObject({
      status: 'ready',
      counts: { total: 2, waiting: 0, prepared: 2 },
      models: [{ version: 'synthetic-face-model', photos: 2 }],
    });
    const serialized = JSON.stringify(second.body.readiness);
    for (const photo of f.photos) {
      const saved = f.rows.get(photo.id)!;
      for (const identifier of [...saved.faceIds!, saved.externalImageId!])
        expect(serialized).not.toContain(identifier);
    }
    for (const method of Object.values(f.matcher))
      expect(method).not.toHaveBeenCalled();
    expect(f.store.file).not.toHaveBeenCalled();
  });

  it('removes expired and deleting photos from readiness and retry warnings', async () => {
    const f = fixture();
    f.rows.set(f.photos[0]!.id, {
      ...f.photos[0]!,
      expiresAt: '2000-01-01T00:00:00Z',
      indexState: 'failed',
      provider: 'aws-rekognition',
    });
    f.rows.set(f.photos[1]!.id, {
      ...f.photos[1]!,
      deletionStartedAt: new Date().toISOString(),
      indexState: 'queued',
      provider: 'aws-rekognition',
    });
    const response = await request(f.app)
      .get(`/api/events/${f.event.id}/processing`)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .expect(200);
    expect(response.body.retryUncertainRequired).toBe(false);
    expect(response.body.readiness).toMatchObject({
      status: 'empty',
      uncertain: 0,
      counts: { total: 0, waiting: 0, failed: 0 },
    });
  });

  it('queues consented work and returns progress before calling the provider', async () => {
    const f = fixture();
    const result = await request(f.app)
      .post(`/api/events/${f.event.id}/index-faces`)
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .set('X-PicFind-Consent', 'face-matching-v1')
      .send({ requestId: randomUUID() })
      .expect(202);
    expect(result.body.job.status).toBe('queued');
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
    await f.worker.processNext();
    const status = await request(f.app)
      .get(`/api/processing/jobs/${result.body.job.id}`)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .expect(200);
    expect(status.body.job).toMatchObject({
      status: 'complete',
      processed: 2,
      indexed: 2,
    });
    expect(status.body.job.leaseToken).toBeUndefined();
    expect(f.reserveUsage).toHaveBeenCalledTimes(2);
  });
  it('reuses completed photo metadata instead of repeating paid indexing', async () => {
    const f = fixture();
    await f.enqueue();
    await f.worker.processNext();
    await f.enqueue();
    await f.worker.processNext();
    expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(2);
    expect(f.reserveUsage).toHaveBeenCalledTimes(2);
  });
  it('stops after the current photo when cancellation arrives during indexing', async () => {
    const f = fixture();
    const job = await f.enqueue();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    vi.mocked(f.matcher.indexPhoto).mockImplementationOnce(
      async ({ photoId }) => {
        entered();
        await gate;
        return {
          faceIds: ['face'],
          externalImageId: photoId,
          modelVersion: 'synthetic',
          unindexedReasons: [],
        };
      },
    );
    const running = f.worker.processNext();
    await started;
    await f.queue.cancel(job.id, f.ownerId);
    release();
    await running;
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'cancelled',
      cursor: 1,
    });
    expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(1);
  });
  it('does not index an archived event or a photo moved to another owner', async () => {
    const f = fixture();
    const job = await f.enqueue();
    f.rows.set(f.event.id, { ...f.event, archived: true });
    await f.worker.processNext();
    expect((await f.queue.owned(job.id, f.ownerId)).failureCode).toBe(
      'EVENT_UNAVAILABLE',
    );
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
  });
  it('protects progress and cancellation from other accounts', async () => {
    const f = fixture();
    const job = await f.enqueue();
    await request(f.app)
      .get(`/api/processing/jobs/${job.id}`)
      .set('Cookie', 'picfind_session=someone-else')
      .expect(404);
    await request(f.app)
      .post(`/api/processing/jobs/${job.id}/cancel`)
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', 'picfind_session=someone-else')
      .expect(404);
    expect((await f.queue.owned(job.id, f.ownerId)).status).toBe('queued');
  });
  it('erases queued indexing and destination-scoped imports when deleting its event', async () => {
    const f = fixture();
    const job = await f.enqueue();
    const imported = await f.queue.enqueue({
      ownerId: f.ownerId,
      eventId: randomUUID(),
      type: 'cloud-import',
      requestId: randomUUID(),
      photoIds: ['cloud-photo'],
      importSource: {
        provider: 'drive',
        generation: randomUUID(),
        destinationEventId: f.event.id,
      },
      consentPolicyVersion: 'cloud-import-v1',
    });
    await request(f.app)
      .delete(`/api/events/${f.event.id}`)
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .expect(204);
    for (const id of [job.id, imported.id])
      await expect(f.queue.owned(id, f.ownerId)).rejects.toMatchObject({
        code: 'JOB_NOT_FOUND',
      });
    await f.worker.processNext();
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
  });
  it('marks a missing or transferred photo failed without sending its bytes to the provider', async () => {
    const f = fixture();
    const job = await f.enqueue();
    f.rows.set(f.photos[0]!.id, { ...f.photos[0]!, ownerId: 'another-owner' });
    await f.worker.processNext();
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'partial',
      failed: 1,
      indexed: 1,
    });
    expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(1);
  });
  it('stops the batch at its quota boundary instead of sending unpaid requests', async () => {
    const f = fixture();
    const job = await f.enqueue();
    f.reserveUsage.mockRejectedValue(
      new ApiError(402, 'ALLOWANCE_EXHAUSTED', 'Synthetic allowance used'),
    );
    await f.worker.processNext();
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'failed',
      failureCode: 'QUOTA_EXHAUSTED',
      cursor: 0,
    });
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
  });
  it('cancels and erases an owner job history without affecting another account', async () => {
    const f = fixture();
    const job = await f.enqueue();
    const other = await f.queue.enqueue({
      ownerId: 'another-owner',
      eventId: randomUUID(),
      requestId: randomUUID(),
      photoIds: [randomUUID()],
      consentPolicyVersion: 'face-matching-v1',
    });
    await f.queue.cancelOwner(f.ownerId);
    await f.queue.eraseOwner(f.ownerId);
    await expect(f.queue.owned(job.id, f.ownerId)).rejects.toMatchObject({
      status: 404,
    });
    expect((await f.queue.owned(other.id, 'another-owner')).status).toBe(
      'queued',
    );
  });
});
