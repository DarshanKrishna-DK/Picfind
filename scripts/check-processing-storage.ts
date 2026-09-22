import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { AppwriteJobStore } from '../apps/api/src/adapters/appwrite-jobs.js';
import { AppwriteLibraryStore } from '../apps/api/src/adapters/appwrite-library.js';
import { createPhotoIndexer } from '../apps/api/src/face-indexing.js';
import { JobQueue, type JobStore } from '../apps/api/src/jobs.js';
import { EventIndexWorker } from '../apps/api/src/processing-worker.js';
import type { FaceMatchingProvider } from '../packages/shared/src/ports.js';
import { ApiError } from '../apps/api/src/auth.js';

if (process.env.PICFIND_WORKER_STORAGE_TEST !== '1')
  throw new Error(
    'Set PICFIND_WORKER_STORAGE_TEST=1 for one generated image, real storage, and a synthetic face adapter. No AWS calls.',
  );
loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
const connection = {
  endpoint: process.env.APPWRITE_ENDPOINT!,
  projectId: process.env.APPWRITE_PROJECT_ID!,
  apiKey: process.env.APPWRITE_API_KEY!,
};
if (!connection.endpoint || !connection.projectId || !connection.apiKey)
  throw new Error('Appwrite configuration is required.');
const ownerId = randomUUID(),
  eventId = randomUUID(),
  photoId = randomUUID();
const store = new AppwriteLibraryStore(connection),
  jobs = new AppwriteJobStore(connection);
let jobId: string | undefined,
  providerCalls = 0,
  reservations = 0;
const matcher: FaceMatchingProvider = {
  healthCheck: async () => ({ provider: 'synthetic-test', ready: true }),
  ensureScope: async () => ({ modelVersion: 'synthetic-test' }),
  indexPhoto: async ({ photoId: externalImageId }) => {
    providerCalls++;
    return {
      faceIds: ['synthetic-not-a-real-face'],
      externalImageId,
      modelVersion: 'synthetic-test',
      unindexedReasons: [],
    };
  },
  search: async () => {
    throw new Error('This diagnostic never searches faces.');
  },
  deleteFaces: async () => {},
  deleteScope: async () => {},
};
async function cleanup() {
  for (const id of [photoId, eventId]) {
    try {
      const record = await store.get(id);
      if (record.ownerId !== ownerId)
        throw new Error('Synthetic cleanup ownership mismatch.');
      if (id === photoId) await store.removeFile(id);
      await store.remove(id);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
  if (jobId) {
    const record = await jobs.get(jobId);
    if (record && record.ownerId !== ownerId)
      throw new Error('Synthetic job ownership mismatch.');
    await jobs.remove(jobId);
  }
  console.info(
    'Removed the isolated worker job, event, photo and generated object.',
  );
}
try {
  const createdAt = new Date().toISOString(),
    image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#557766' },
    })
      .jpeg()
      .toBuffer();
  await store.put(
    {
      id: eventId,
      ownerId,
      kind: 'event',
      title: 'Disposable worker storage check',
      createdAt,
    },
    true,
  );
  // Diagnostic-only durable metadata comes first so its object is always discoverable for cleanup.
  await store.put(
    {
      id: photoId,
      ownerId,
      kind: 'photo',
      eventId,
      createdAt,
      filename: 'generated-worker.jpg',
      bytes: image.length,
      indexState: 'none',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
    true,
  );
  await store.upload(photoId, image);
  const isolated = new Proxy(jobs, {
    get(target, property) {
      if (property === 'candidates')
        return async () => {
          if (!jobId) return [];
          const row = await target.get(jobId);
          return row ? [row] : [];
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as JobStore;
  const queue = new JobQueue(isolated);
  jobId = (
    await queue.enqueue({
      ownerId,
      eventId,
      requestId: randomUUID(),
      photoIds: [photoId],
      consentPolicyVersion: 'face-matching-v1',
    })
  ).id;
  const worker = new EventIndexWorker(
    queue,
    store,
    matcher,
    createPhotoIndexer({
      providerName: 'synthetic-test',
      reserveUsage: async () => {
        reservations++;
      },
    }),
  );
  await worker.processNext();
  assert.equal((await queue.owned(jobId, ownerId)).status, 'complete');
  assert.equal((await store.get(photoId)).indexState, 'ready');
  assert.equal(providerCalls, 1);
  assert.equal(reservations, 1);
  assert.equal(await worker.processNext(), false);
  console.info(
    'PASS: real Appwrite queued worker, stored image read, durable indexing metadata and progress. Face adapter is SYNTHETIC; Rekognition calls: 0.',
  );
} finally {
  await cleanup();
}
