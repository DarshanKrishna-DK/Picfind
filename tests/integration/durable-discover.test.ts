import { randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import {
  ApiError,
  type AuthenticationProvider,
} from '../../apps/api/src/auth.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import type { FaceMatchingProvider } from '../../packages/shared/src/ports.js';
import { JobQueue } from '../../apps/api/src/jobs.js';
import { TestJobStore } from '../helpers/job-store.js';
import { createScanPhotoPreparer } from '../../apps/api/src/scan-photo-preparation.js';
import { createPhotoIndexer } from '../../apps/api/src/face-indexing.js';
import { EventIndexWorker } from '../../apps/api/src/processing-worker.js';
import type { BillingService } from '../../apps/api/src/billing/service.js';

const origin = 'http://localhost:5173';
async function fixture(accounting = false) {
  const ownerId = randomUUID();
  const photos: LibraryRecord[] = Array.from({ length: 2 }, (_, i) => ({
    id: randomUUID(),
    ownerId,
    kind: 'photo',
    filename: `source-${i}.jpg`,
    createdAt: new Date().toISOString(),
    indexState: 'none',
  }));
  const rows = new Map(photos.map((row) => [row.id, row]));
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < photos.length; i++)
    files.set(
      photos[i]!.id,
      await sharp({
        create: {
          width: 8,
          height: 8,
          channels: 3,
          background: i ? '#445566' : '#aabbcc',
        },
      })
        .jpeg()
        .toBuffer(),
    );
  const store: LibraryStore = {
    list: async (owner, kind) =>
      [...rows.values()]
        .filter((row) => row.ownerId === owner && row.kind === kind)
        .map((row) => structuredClone(row)),
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Missing');
      return structuredClone(row);
    },
    put: async (row, createOnly) => {
      if (createOnly && rows.has(row.id))
        throw new ApiError(409, 'CONFLICT', 'Duplicate');
      rows.set(row.id, structuredClone(row));
    },
    remove: async (id) => {
      rows.delete(id);
    },
    upload: vi.fn(async (id, bytes) => {
      files.set(id, new Uint8Array(bytes));
    }),
    file: vi.fn(async (id) => {
      const bytes = files.get(id);
      if (!bytes) throw new ApiError(404, 'NOT_FOUND', 'Missing');
      return new Response(new Uint8Array(bytes));
    }),
    removeFile: vi.fn(async (id) => {
      files.delete(id);
    }),
  };
  const matcher: FaceMatchingProvider = {
    healthCheck: vi.fn(),
    ensureScope: vi.fn(async () => ({ modelVersion: 'synthetic' })),
    deleteFaces: vi.fn(async () => {}),
    deleteScope: vi.fn(async () => {}),
    search: vi.fn(),
    indexPhoto: vi.fn(async ({ photoId }) => ({
      faceIds: [randomUUID()],
      externalImageId: photoId,
      modelVersion: 'synthetic',
      unindexedReasons: [],
    })),
  };
  const queue = new JobQueue(new TestJobStore());
  const reserveUsage = vi.fn(async () => {});
  const worker = new EventIndexWorker(
    queue,
    store,
    matcher,
    createPhotoIndexer({ providerName: 'aws-rekognition', reserveUsage }),
    createScanPhotoPreparer(store),
  );
  const auth: AuthenticationProvider = {
    register: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    getUser: async (id) => ({
      id,
      name: 'Synthetic',
      email: 'synthetic@example.test',
      emailVerified: true,
    }),
  };
  const app = createApp(
    { provider: auth, webOrigin: origin, secureCookies: false },
    {
      store,
      faceMatcher: matcher,
      jobQueue: queue,
      ...(accounting ? { billing: {} as BillingService } : {}),
    },
  );
  const input = {
    requestId: randomUUID(),
    photoIds: photos.map((row) => row.id),
    consent: true,
    policyVersion: 'face-matching-v1',
  };
  const start = (body = input) =>
    request(app)
      .post('/api/discover/scans')
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${ownerId}`)
      .send(body);
  return {
    ownerId,
    photos,
    rows,
    files,
    store,
    matcher,
    queue,
    app,
    input,
    start,
    reserveUsage,
    worker,
    auth,
  };
}
describe('durable Discover library scans with generated images and synthetic matching', () => {
  it('does not start paid indexing after its lease expires during copy preparation', async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const f = await fixture();
      const response = await f.start().expect(202);
      const prepare = createScanPhotoPreparer(f.store);
      const worker = new EventIndexWorker(
        f.queue,
        f.store,
        f.matcher,
        createPhotoIndexer({
          providerName: 'aws-rekognition',
          reserveUsage: f.reserveUsage,
        }),
        async (...args) => {
          const photo = await prepare(...args);
          now += 121000;
          await f.queue.claim('replacement-worker');
          return photo;
        },
      );
      await worker.processNext();
      expect(f.matcher.ensureScope).not.toHaveBeenCalled();
      expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
      expect(f.reserveUsage).not.toHaveBeenCalled();
      expect(
        (await f.queue.owned(response.body.scan.processing.id, f.ownerId))
          .status,
      ).toBe('interrupted');
    } finally {
      clock.mockRestore();
    }
  });
  it('revalidates the lease after downloading a prepared photo, before spending allowance', async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const f = await fixture();
      await f.start().expect(202);
      const file = vi.mocked(f.store.file).getMockImplementation()!;
      vi.mocked(f.store.file).mockImplementation(async (id) => {
        const response = await file(id);
        if (!f.photos.some((photo) => photo.id === id)) {
          now += 121000;
          await f.queue.claim('replacement-worker');
        }
        return response;
      });
      await f.worker.processNext();
      expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
      expect(f.reserveUsage).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
  it('repairs a lost final checkpoint from completed photo records without another paid request', async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const f = await fixture();
      vi.mocked(f.matcher.indexPhoto).mockResolvedValueOnce({
        faceIds: [],
        externalImageId: 'empty',
        modelVersion: 'synthetic',
        unindexedReasons: [],
      });
      const response = await f.start().expect(202);
      const finish = f.queue.finishItem.bind(f.queue);
      vi.spyOn(f.queue, 'finishItem').mockImplementation(async (...args) => {
        if (args[3] === 1)
          throw new Error('Synthetic final checkpoint unavailable');
        return finish(...args);
      });
      await expect(f.worker.processNext()).rejects.toThrow(
        'Synthetic final checkpoint unavailable',
      );
      expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(2);
      now += 121000;
      await f.queue.claim('restarted-worker');
      const recovered = await request(f.app)
        .post(`/api/discover/scans/${response.body.scan.id}/processing`)
        .set('Origin', origin)
        .set('Cookie', `picfind_session=${f.ownerId}`)
        .send({
          requestId: randomUUID(),
          consent: true,
          policyVersion: 'face-matching-v1',
        })
        .expect(202);
      expect(recovered.body.scan).toMatchObject({
        state: 'complete',
        errors: [],
      });
      expect(recovered.body.scan.processing).toMatchObject({
        status: 'complete',
        processed: 2,
        indexed: 1,
        empty: 1,
        failed: 0,
      });
      expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(2);
      expect(await f.queue.list(f.ownerId)).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });
  it('recovery exposes the saved request identity and never reports unaccepted work as running', async () => {
    const f = await fixture();
    vi.spyOn(f.queue, 'enqueue').mockRejectedValueOnce(
      new Error('Synthetic queue write outage'),
    );
    await f.start().expect(500);
    const library = await request(f.app)
      .get('/api/library')
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .expect(200);
    expect(library.body.scans[0]).toMatchObject({
      requestId: f.input.requestId,
      state: 'failed',
      resultsRetained: false,
    });
    expect(library.body.scans[0].errors.join(' ')).toContain('not accepted');
    const replay = await f.start().expect(202);
    expect(replay.body.scan.id).toBe(library.body.scans[0].id);
    expect(replay.body.scan.requestId).toBe(f.input.requestId);
    expect(await f.queue.list(f.ownerId)).toHaveLength(1);
  });

  it('keeps the library available when the processing store is offline', async () => {
    const f = await fixture();
    const list = vi
      .spyOn(f.queue, 'list')
      .mockRejectedValue(new Error('Synthetic queue outage'));
    const empty = await request(f.app)
      .get('/api/library')
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .expect(200);
    expect(empty.body.photos).toHaveLength(2);
    expect(list).not.toHaveBeenCalled();
    list.mockRestore();
    await f.start().expect(202);
    vi.spyOn(f.queue, 'list').mockRejectedValue(
      new Error('Synthetic queue outage'),
    );
    const unavailable = await request(f.app)
      .get('/api/library')
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .expect(200);
    expect(unavailable.body.photos).toHaveLength(2);
    expect(unavailable.body.scans[0]).toMatchObject({
      state: 'unavailable',
      resultsRetained: false,
    });
    expect(unavailable.body.scans[0].errors.join(' ')).toContain(
      'temporarily unavailable',
    );
  });
  it('supports a large immutable production snapshot without synchronous photo or provider work', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const f = await fixture(true);
      const ids = Array.from({ length: 3000 }, () => randomUUID());
      for (const id of ids)
        f.rows.set(id, {
          id,
          ownerId: f.ownerId,
          kind: 'photo',
          filename: 'synthetic.jpg',
          createdAt: new Date().toISOString(),
        });
      const response = await f.start({ ...f.input, photoIds: ids }).expect(202);
      expect(response.body.scan.processing.total).toBe(3000);
      expect(
        (await f.queue.owned(response.body.scan.processing.id, f.ownerId))
          .photoIds,
      ).toEqual(ids);
      expect(f.store.file).not.toHaveBeenCalled();
      expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('retains the twenty-photo development guard and rejects missing consent before processing', async () => {
    const f = await fixture();
    await f
      .start({
        ...f.input,
        photoIds: Array.from({ length: 21 }, () => randomUUID()),
      })
      .expect(400);
    await f.start({ ...f.input, consent: false }).expect(400);
    expect(await f.queue.list(f.ownerId)).toHaveLength(0);
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
  });
  it('does not expose or resume another account collection', async () => {
    const f = await fixture();
    const response = await f.start().expect(202);
    const path = `/api/discover/scans/${response.body.scan.id}`;
    await request(f.app)
      .get(path)
      .set('Cookie', 'picfind_session=foreign')
      .expect(404);
    await request(f.app)
      .post(path + '/processing')
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=foreign')
      .send({
        requestId: randomUUID(),
        consent: true,
        policyVersion: 'face-matching-v1',
      })
      .expect(404);
    await request(f.app)
      .post(path + '/processing/cancel')
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=foreign')
      .send({})
      .expect(404);
    expect(
      (await f.queue.owned(response.body.scan.processing.id, f.ownerId)).status,
    ).toBe('queued');
  });
  it('does not download a source that expired after the request was saved', async () => {
    const f = await fixture();
    await f.start().expect(202);
    f.rows.set(f.photos[0]!.id, {
      ...f.photos[0]!,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await f.worker.processNext();
    expect(f.store.file).not.toHaveBeenCalledWith(f.photos[0]!.id);
    expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(1);
  });
  it('requires production storage accounting before preparing any photo', async () => {
    const f = await fixture();
    const prepare = createScanPhotoPreparer(f.store, undefined, {
      production: true,
      libraryPhotos: 100,
      events: 100,
      eventPhotos: 100,
      discoverPhotos: 20,
    });
    await expect(
      prepare(f.ownerId, randomUUID(), f.photos[0]!.id),
    ).rejects.toMatchObject({ code: 'USAGE_ACCOUNTING_UNAVAILABLE' });
    expect(f.store.file).not.toHaveBeenCalled();
    expect(f.store.upload).not.toHaveBeenCalled();
  });
  it('a fresh worker prepares and indexes the saved snapshot without changing the source photos', async () => {
    const f = await fixture();
    const response = await f.start().expect(202);
    await f.worker.processNext();
    const result = await request(f.app)
      .get(`/api/discover/scans/${response.body.scan.id}`)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .expect(200);
    expect(result.body.scan).toMatchObject({
      state: 'complete',
      imported: 2,
      indexed: 2,
      resultsRetained: false,
    });
    expect(result.body.scan.processing).toMatchObject({
      status: 'complete',
      processed: 2,
    });
    expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(2);
    expect(f.reserveUsage).toHaveBeenCalledTimes(2);
    expect(f.store.upload).toHaveBeenCalledTimes(2);
    for (const photo of f.photos)
      expect(f.rows.get(photo.id)?.indexState).toBe('none');
    expect(vi.mocked(f.matcher.indexPhoto).mock.calls[0]![0].scope).toEqual({
      kind: 'scan',
      id: response.body.scan.id.replaceAll('-', ''),
    });
  });
  it('search uses per-photo references and does not persist the selfie or its result list', async () => {
    const f = await fixture();
    const created = await f.start().expect(202);
    await f.worker.processNext();
    const prepared = [...f.rows.values()].filter(
      (row) => row.scanId === created.body.scan.id && row.kind === 'photo',
    );
    vi.mocked(f.matcher.search).mockResolvedValue({
      modelVersion: 'synthetic',
      limitReached: false,
      matches: [
        {
          faceId: randomUUID(),
          externalImageId: prepared[0]!.externalImageId!,
          similarity: 97.5,
        },
      ],
    });
    const fileCount = f.files.size;
    const selfie = Buffer.from(f.files.get(f.photos[0]!.id)!);
    const response = await request(f.app)
      .post(`/api/discover/scans/${created.body.scan.id}/search`)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .set('Content-Type', 'application/octet-stream')
      .send(selfie)
      .expect(200);
    expect(response.body.matches).toEqual([
      expect.objectContaining({ photoId: prepared[0]!.id, similarity: 97.5 }),
    ]);
    expect(f.files.size).toBe(fileCount);
    expect(f.rows.get(created.body.scan.id)?.matches ?? []).toEqual([]);
    const restored = await request(f.app)
      .get(`/api/discover/scans/${created.body.scan.id}`)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .expect(200);
    expect(restored.body.matches).toEqual([]);
  });
  it('never reads or processes a source photo transferred to another account after enqueue', async () => {
    const f = await fixture();
    const response = await f.start().expect(202);
    f.rows.set(f.photos[0]!.id, { ...f.photos[0]!, ownerId: 'foreign' });
    await f.worker.processNext();
    const job = await f.queue.owned(
      response.body.scan.processing.id,
      f.ownerId,
    );
    expect(job).toMatchObject({ status: 'partial', failed: 1, indexed: 1 });
    expect(f.store.file).not.toHaveBeenCalledWith(f.photos[0]!.id);
  });
  it('pauses queued processing and resumes without duplicating successful copies or indexing', async () => {
    const f = await fixture();
    const response = await f.start().expect(202);
    const path = `/api/discover/scans/${response.body.scan.id}`;
    await request(f.app)
      .post(path + '/processing/cancel')
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .send({})
      .expect(200);
    await f.worker.processNext();
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
    await request(f.app)
      .post(path + '/processing')
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .send({
        requestId: randomUUID(),
        consent: true,
        policyVersion: 'face-matching-v1',
      })
      .expect(202);
    await f.worker.processNext();
    expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(2);
    await request(f.app)
      .post(path + '/processing')
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .send({
        requestId: randomUUID(),
        consent: true,
        policyVersion: 'face-matching-v1',
      })
      .expect(202);
    await f.worker.processNext();
    expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(2);
    expect(f.store.upload).toHaveBeenCalledTimes(2);
  });
  it('does not automatically repeat an uncertain paid request on resume', async () => {
    const f = await fixture();
    vi.mocked(f.matcher.indexPhoto).mockRejectedValueOnce(
      new Error('Synthetic lost provider reply'),
    );
    const response = await f.start().expect(202);
    await f.worker.processNext();
    const path = `/api/discover/scans/${response.body.scan.id}/processing`;
    const retry = {
      requestId: randomUUID(),
      consent: true,
      policyVersion: 'face-matching-v1',
    };
    const denied = await request(f.app)
      .post(path)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .send(retry)
      .expect(409);
    expect(denied.body.error.code).toBe('RETRY_UNCERTAIN_REQUIRED');
    expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(2);
    await request(f.app)
      .post(path)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .send({ ...retry, retryUncertain: true })
      .expect(202);
    await f.worker.processNext();
    expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(3);
    expect(f.store.upload).toHaveBeenCalledTimes(2);
  });
  it('quota exhaustion prevents a provider request and remains recoverable', async () => {
    const f = await fixture();
    f.reserveUsage.mockRejectedValueOnce(
      new ApiError(402, 'ALLOWANCE_EXHAUSTED', 'Synthetic exhausted allowance'),
    );
    const response = await f.start().expect(202);
    await f.worker.processNext();
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
    expect(
      await f.queue.owned(response.body.scan.processing.id, f.ownerId),
    ).toMatchObject({ status: 'failed', failureCode: 'QUOTA_EXHAUSTED' });
    await request(f.app)
      .post(`/api/discover/scans/${response.body.scan.id}/processing`)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .send({
        requestId: randomUUID(),
        consent: true,
        policyVersion: 'face-matching-v1',
      })
      .expect(202);
    await f.worker.processNext();
    expect(f.matcher.indexPhoto).toHaveBeenCalledTimes(2);
    expect(f.store.upload).toHaveBeenCalledTimes(2);
  });
  it('deletion fences queued work and replay cannot resurrect the deleted collection', async () => {
    const f = await fixture();
    const response = await f.start().expect(202);
    const path = `/api/discover/scans/${response.body.scan.id}`;
    await request(f.app)
      .delete(path)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=foreign')
      .expect(404);
    await request(f.app)
      .delete(path)
      .set('Origin', origin)
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .expect(204);
    await f.worker.processNext();
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
    expect(await f.queue.list(f.ownerId)).toEqual([]);
    expect(f.files.size).toBe(2);
    await f.start().expect(409);
    const library = await request(f.app)
      .get('/api/library')
      .set('Cookie', `picfind_session=${f.ownerId}`)
      .expect(200);
    expect(library.body.scans).toEqual([]);
  });
  it('prepared copies are durable and reserve storage only once across restarts', async () => {
    const f = await fixture();
    const billing = {
      retentionDays: vi.fn(async () => 30),
      reserveStorage: vi.fn(async () => {}),
      releaseStorage: vi.fn(async () => {}),
    } as unknown as BillingService;
    const scanId = randomUUID();
    const first = await createScanPhotoPreparer(f.store, billing)(
      f.ownerId,
      scanId,
      f.photos[0]!.id,
    );
    const second = await createScanPhotoPreparer(f.store, billing)(
      f.ownerId,
      scanId,
      f.photos[0]!.id,
    );
    expect(first.id).toBe(second.id);
    expect(billing.reserveStorage).toHaveBeenCalledTimes(1);
    expect(f.store.upload).toHaveBeenCalledTimes(1);
  });
  it('a lost preparation metadata reply does not upload or reserve again', async () => {
    const f = await fixture();
    const put = f.store.put.bind(f.store);
    let lost = false;
    f.store.put = async (row, createOnly) => {
      await put(row, createOnly);
      if (row.kind === 'photo' && row.scanId && !lost) {
        lost = true;
        throw new Error('Synthetic lost commit reply');
      }
    };
    const prepare = createScanPhotoPreparer(f.store);
    const scanId = randomUUID();
    const first = await prepare(f.ownerId, scanId, f.photos[0]!.id);
    expect((await prepare(f.ownerId, scanId, f.photos[0]!.id)).id).toBe(
      first.id,
    );
    expect(f.store.upload).toHaveBeenCalledTimes(1);
    expect(f.store.removeFile).not.toHaveBeenCalled();
  });
  it('saves a source snapshot and returns before copying or calling the face provider', async () => {
    const f = await fixture();
    const response = await f.start().expect(202);
    expect(response.body.scan.processing).toMatchObject({
      type: 'discover-library',
      status: 'queued',
      total: 2,
    });
    expect(f.matcher.indexPhoto).not.toHaveBeenCalled();
    expect(f.store.upload).not.toHaveBeenCalled();
    const job = await f.queue.owned(
      response.body.scan.processing.id,
      f.ownerId,
    );
    expect(job.photoIds).toEqual(f.input.photoIds);
  });
  it('replays a lost creation response without creating another collection or snapshot', async () => {
    const f = await fixture();
    const first = await f.start().expect(202);
    const retry = await f.start().expect(202);
    expect(retry.body.scan.id).toBe(first.body.scan.id);
    expect(retry.body.scan.processing.id).toBe(first.body.scan.processing.id);
    expect(await f.queue.list(f.ownerId)).toHaveLength(1);
    await f.start({ ...f.input, photoIds: [f.photos[0]!.id] }).expect(409);
  });
});
