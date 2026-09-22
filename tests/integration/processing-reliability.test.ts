import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  ApiError,
  type AuthenticationProvider,
} from '../../apps/api/src/auth.js';
import { createApp } from '../../apps/api/src/app.js';
import { createPhotoIndexer } from '../../apps/api/src/face-indexing.js';
import { JobQueue, type EnqueueIndex } from '../../apps/api/src/jobs.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import { deletePhotoSafely } from '../../apps/api/src/photo-deletion.js';
import { EventIndexWorker } from '../../apps/api/src/processing-worker.js';
import type { FaceMatchingProvider } from '../../packages/shared/src/ports.js';
import { TestJobStore } from '../helpers/job-store.js';

function fixture(photoCount = 1) {
  const ownerId = randomUUID();
  const event: LibraryRecord = {
    id: randomUUID(),
    ownerId,
    kind: 'event',
    title: 'Synthetic reliability event',
    createdAt: new Date().toISOString(),
  };
  const photos: LibraryRecord[] = Array.from({ length: photoCount }, () => ({
    id: randomUUID(),
    ownerId,
    eventId: event.id,
    kind: 'photo',
    createdAt: new Date().toISOString(),
    indexState: 'none',
  }));
  const rows = new Map(
    [event, ...photos].map((row) => [row.id, structuredClone(row)]),
  );
  const store: LibraryStore = {
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Synthetic missing row');
      return structuredClone(row);
    },
    list: async (owner, kind) =>
      [...rows.values()]
        .filter((row) => row.ownerId === owner && row.kind === kind)
        .map((row) => structuredClone(row)),
    put: vi.fn(async (row) => {
      rows.set(row.id, structuredClone(row));
    }),
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
  const indexPhoto = createPhotoIndexer({
    providerName: 'aws-rekognition',
    reserveUsage,
  });
  let now = Date.parse('2026-09-21T00:00:00Z');
  const jobs = new TestJobStore();
  const queue = new JobQueue(jobs, { now: () => now, leaseMs: 30_000 });
  const worker = new EventIndexWorker(queue, store, matcher, indexPhoto);
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
  const post = (requestId: string = randomUUID(), retryUncertain = false) =>
    request(app)
      .post(`/api/events/${event.id}/index-faces`)
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `picfind_session=${ownerId}`)
      .set('X-PicFind-Consent', 'face-matching-v1')
      .send({ requestId, retryUncertain });
  const enqueue = (overrides: Partial<EnqueueIndex> = {}) =>
    queue.enqueue({
      ownerId,
      eventId: event.id,
      requestId: randomUUID(),
      photoIds: photos.map((photo) => photo.id),
      consentPolicyVersion: 'face-matching-v1',
      ...overrides,
    });
  return {
    ownerId,
    event,
    photos,
    rows,
    store,
    matcher,
    reserveUsage,
    indexPhoto,
    jobs,
    queue,
    worker,
    app,
    post,
    enqueue,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe('processing reliability with synthetic providers and storage only', () => {
  it('serializes overlapping A+B requests and preserves same-request idempotency', async () => {
    const f = fixture();
    const ids = [randomUUID(), randomUUID()];
    const responses = await Promise.all(ids.map((id) => f.post(id)));
    expect(responses.map((response) => response.status).sort()).toEqual([
      202, 409,
    ]);
    const accepted = responses.find((response) => response.status === 202)!;
    const rejected = responses.find((response) => response.status === 409)!;
    expect(rejected.body.error.code).toBe('PROCESSING_ACTIVE');
    expect(await f.queue.list(f.ownerId, f.event.id)).toHaveLength(1);
    const requestId = accepted.body.job.requestId as string;
    const replay = await f.post(requestId).expect(202);
    expect(replay.body.job.id).toBe(accepted.body.job.id);
    expect((await f.post(requestId, true).expect(409)).body.error.code).toBe(
      'JOB_REQUEST_REUSED',
    );
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
  });

  it('replays a completed request using its original photo snapshot', async () => {
    const f = fixture();
    const requestId = randomUUID();
    const first = await f.post(requestId).expect(202);
    await f.worker.processNext();
    const extra = { ...f.photos[0]!, id: randomUUID() };
    f.rows.set(extra.id, extra);
    const replay = await f.post(requestId).expect(202);
    expect(replay.body.job).toMatchObject({
      id: first.body.job.id,
      status: 'complete',
      total: 1,
    });
    expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(1);
  });

  it('blocks legacy queued B after A crashes, including a preauthorized job without a photo snapshot', async () => {
    const f = fixture();
    const a = await f.enqueue();
    const b = await f.enqueue({ retryUncertain: true });
    const claim = (await f.queue.claim('synthetic-crashed-worker'))!;
    expect(claim.id).toBe(a.id);
    await f.queue.beginItem(a.id, claim.leaseToken!);
    f.rows.set(f.photos[0]!.id, {
      ...f.photos[0]!,
      provider: 'aws-rekognition',
      indexState: 'queued',
    });
    f.advance(31_000);
    await f.worker.processNext();
    expect(await f.queue.owned(a.id, f.ownerId)).toMatchObject({
      status: 'interrupted',
    });
    expect(await f.queue.owned(b.id, f.ownerId)).toMatchObject({
      status: 'failed',
      failureCode: 'RETRY_UNCERTAIN_REQUIRED',
      cursor: 0,
    });
    expect(f.reserveUsage).not.toHaveBeenCalled();
    expect(f.matcher.ensureScope).not.toHaveBeenCalled();
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
  });

  it('requires new explicit authorization after an uncertain provider failure', async () => {
    const f = fixture();
    const firstRequest = randomUUID();
    await f.post(firstRequest).expect(202);
    vi.mocked(f.matcher.indexPhoto).mockRejectedValueOnce(
      Object.assign(new Error('Synthetic lost provider reply'), {
        name: 'TimeoutError',
      }),
    );
    await f.worker.processNext();
    const status = await request(f.app)
      .get(`/api/events/${f.event.id}/processing`)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .expect(200);
    expect(status.body.retryUncertainRequired).toBe(true);
    expect((await f.post().expect(409)).body.error.code).toBe(
      'RETRY_UNCERTAIN_REQUIRED',
    );
    expect((await f.post(firstRequest, true).expect(409)).body.error.code).toBe(
      'JOB_REQUEST_REUSED',
    );
    expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(1);
    const approved = await f.post(randomUUID(), true).expect(202);
    const job = await f.queue.owned(approved.body.job.id, f.ownerId);
    expect(job).toMatchObject({
      retryUncertain: true,
      retryUncertainPhotoIds: [f.photos[0]!.id],
    });
    await f.worker.processNext();
    expect((await f.queue.owned(job.id, f.ownerId)).status).toBe('complete');
    expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(2);
  });

  it('binds retry authorization and its photo snapshot into the request fingerprint', async () => {
    const f = fixture(2);
    const requestId = randomUUID();
    const job = await f.enqueue({ requestId });
    await expect(
      f.enqueue({
        requestId,
        retryUncertain: true,
        retryUncertainPhotoIds: [f.photos[0]!.id],
      }),
    ).rejects.toMatchObject({ code: 'JOB_REQUEST_REUSED' });
    const retryId = randomUUID();
    await f.enqueue({
      requestId: retryId,
      retryUncertain: true,
      retryUncertainPhotoIds: [f.photos[0]!.id],
    });
    await expect(
      f.enqueue({
        requestId: retryId,
        retryUncertain: true,
        retryUncertainPhotoIds: [f.photos[1]!.id],
      }),
    ).rejects.toMatchObject({ code: 'JOB_REQUEST_REUSED' });
    expect((await f.queue.owned(job.id, f.ownerId)).retryUncertain).toBe(false);
  });

  it('makes partial event deletion irreversible through PATCH, enqueue, and the worker', async () => {
    const f = fixture();
    f.rows.set(f.photos[0]!.id, {
      ...f.photos[0]!,
      indexState: 'ready',
      provider: 'aws-rekognition',
      faceIds: ['synthetic-face'],
      externalImageId: 'synthetic-photo',
    });
    await f.enqueue();
    vi.mocked(f.store.removeFile).mockRejectedValueOnce(
      new ApiError(503, 'STORAGE_UNAVAILABLE', 'Synthetic deletion failure'),
    );
    const remove = () =>
      request(f.app)
        .delete(`/api/events/${f.event.id}`)
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', `picfind_session=${f.ownerId}`);
    await remove().expect(503);
    expect(f.matcher.deleteScope).toHaveBeenCalledTimes(1);
    expect((await f.store.get(f.event.id)).deletionStartedAt).toBeTruthy();
    const restore = await request(f.app)
      .patch(`/api/events/${f.event.id}`)
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .send({ archived: false })
      .expect(409);
    expect(restore.body.error.code).toBe('EVENT_DELETING');
    expect((await f.post().expect(409)).body.error.code).toBe('EVENT_DELETING');
    const legacy = await f.enqueue();
    await f.worker.processNext();
    expect(await f.queue.owned(legacy.id, f.ownerId)).toMatchObject({
      status: 'failed',
      failureCode: 'EVENT_UNAVAILABLE',
    });
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
    await remove().expect(204);
    expect(f.rows.has(f.event.id)).toBe(false);
  });

  it.each([1, 2])(
    'reconciles a lost checkpoint acknowledgement for a %i-photo batch',
    async (count) => {
      const f = fixture(count);
      const job = await f.enqueue();
      const finish = f.queue.finishItem.bind(f.queue);
      const checkpoint = vi
        .spyOn(f.queue, 'finishItem')
        .mockImplementationOnce(async (...args) => {
          await finish(...args);
          throw new Error('Synthetic committed checkpoint with lost reply');
        });
      await f.worker.processNext();
      expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
        status: 'complete',
        cursor: count,
        indexed: count,
        failed: 0,
      });
      expect(checkpoint).toHaveBeenCalledTimes(count + 1);
      expect(checkpoint.mock.calls.every((call) => call[2] === 'indexed')).toBe(
        true,
      );
      expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(count);
      expect(f.reserveUsage).toHaveBeenCalledTimes(count);
    },
  );

  it('retries a failed checkpoint write without changing the successful photo outcome', async () => {
    const f = fixture();
    const job = await f.enqueue();
    const checkpoint = vi
      .spyOn(f.queue, 'finishItem')
      .mockRejectedValueOnce(
        new Error('Synthetic checkpoint outage before commit'),
      );
    await f.worker.processNext();
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'complete',
      indexed: 1,
      failed: 0,
      cursor: 1,
    });
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(checkpoint.mock.calls.every((call) => call[2] === 'indexed')).toBe(
      true,
    );
    expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(1);
  });

  it('leaves persistent checkpoint failure recoverable without repeating saved indexing', async () => {
    const f = fixture();
    const job = await f.enqueue();
    const checkpoint = vi
      .spyOn(f.queue, 'finishItem')
      .mockRejectedValue(new Error('Synthetic persistent checkpoint outage'));
    await expect(f.worker.processNext()).rejects.toThrow(
      'Synthetic persistent checkpoint outage',
    );
    expect(checkpoint).toHaveBeenCalledTimes(3);
    expect(await f.queue.owned(job.id, f.ownerId)).toMatchObject({
      status: 'running',
      cursor: 0,
      failed: 0,
    });
    expect((await f.store.get(f.photos[0]!.id)).indexState).toBe('ready');
    checkpoint.mockRestore();
    f.advance(31_000);
    await f.queue.claim('synthetic-recovery');
    const next = await f.enqueue();
    await f.worker.processNext();
    expect((await f.queue.owned(next.id, f.ownerId)).status).toBe('complete');
    expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(1);
    expect(f.reserveUsage).toHaveBeenCalledTimes(1);
  });

  it('preserves an unindexed photo after quota rejection so individual deletion is immediate', async () => {
    const f = fixture(2);
    const photo = f.photos[0]!;
    f.reserveUsage.mockRejectedValueOnce(
      new ApiError(402, 'ALLOWANCE_EXHAUSTED', 'Synthetic quota rejection'),
    );
    await expect(
      f.indexPhoto(
        f.matcher,
        f.store,
        photo,
        { kind: 'event', id: f.event.id },
        'synthetic-consent',
      ),
    ).rejects.toMatchObject({ code: 'ALLOWANCE_EXHAUSTED' });
    expect(await f.store.get(photo.id)).toEqual(photo);
    expect(f.matcher.ensureScope).not.toHaveBeenCalled();
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
    expect(
      await deletePhotoSafely(f.store, await f.store.get(photo.id), f.matcher),
    ).toBe('deleted');
    expect(f.rows.has(f.photos[1]!.id)).toBe(true);
    expect(f.matcher.deleteScope).not.toHaveBeenCalled();
  });

  it('preserves original indexing metadata when source preflight fails', async () => {
    const f = fixture();
    const photo = f.photos[0]!;
    vi.mocked(f.store.file).mockRejectedValueOnce(
      new ApiError(503, 'STORAGE_UNAVAILABLE', 'Synthetic unavailable source'),
    );
    await expect(
      f.indexPhoto(
        f.matcher,
        f.store,
        photo,
        { kind: 'event', id: f.event.id },
        'synthetic-consent',
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(await f.store.get(photo.id)).toEqual(photo);
    expect(f.reserveUsage).not.toHaveBeenCalled();
    expect(f.store.put).not.toHaveBeenCalled();
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
  });

  it('restores original metadata after a pre-provider marker write failure', async () => {
    const f = fixture();
    const photo = f.photos[0]!;
    vi.mocked(f.store.put).mockRejectedValueOnce(
      new ApiError(
        503,
        'STORAGE_UNAVAILABLE',
        'Synthetic marker write failure',
      ),
    );
    await expect(
      f.indexPhoto(
        f.matcher,
        f.store,
        photo,
        { kind: 'event', id: f.event.id },
        'synthetic-consent',
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(await f.store.get(photo.id)).toEqual(photo);
    expect(f.matcher.ensureScope).not.toHaveBeenCalled();
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
  });
});
