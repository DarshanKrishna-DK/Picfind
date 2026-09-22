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
import {
  createScanPhotoPreparer,
  scanPhotoId,
} from '../apps/api/src/scan-photo-preparation.js';
import { discoverState } from '../apps/api/src/discover-state.js';
import { libraryCapacity } from '../apps/api/src/capacity.js';
import type { BillingService } from '../apps/api/src/billing/service.js';
import type { FaceMatchingProvider } from '../packages/shared/src/ports.js';
import { ApiError } from '../apps/api/src/auth.js';

if (process.env.PICFIND_DISCOVER_STORAGE_TEST !== '1')
  throw new Error(
    'Set PICFIND_DISCOVER_STORAGE_TEST=1 for one generated source and one scan copy in real Appwrite. Face and billing adapters are synthetic. AWS calls: 0.',
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
  scanId = randomUUID(),
  photoId = randomUUID(),
  requestId = randomUUID();
const preparedId = scanPhotoId(scanId, photoId);
const store = new AppwriteLibraryStore(connection),
  jobs = new AppwriteJobStore(connection);
let providerCalls = 0,
  usageReservations = 0,
  storageReservations = 0;
const jobIds: string[] = [];
const matcher: FaceMatchingProvider = {
  healthCheck: async () => ({ provider: 'synthetic-test', ready: true }),
  ensureScope: async () => ({ modelVersion: 'synthetic-test' }),
  indexPhoto: async ({ scope, photoId: externalImageId }) => {
    assert.deepEqual(scope, { kind: 'scan', id: scanId.replaceAll('-', '') });
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
const billing = {
  retentionDays: async () => 7,
  reserveStorage: async () => {
    storageReservations++;
  },
  releaseStorage: async () => {},
} as unknown as BillingService;
const isolated = new Proxy(jobs, {
  get(target, property) {
    if (property === 'candidates')
      return async () => {
        const rows = [];
        for (const id of jobIds) {
          const row = await target.get(id);
          if (row) rows.push(row);
        }
        return rows;
      };
    const value: unknown = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  },
}) as JobStore;
const queue = new JobQueue(isolated);
const freshWorker = () =>
  new EventIndexWorker(
    queue,
    store,
    matcher,
    createPhotoIndexer({
      providerName: 'synthetic-test',
      reserveUsage: async () => {
        usageReservations++;
      },
    }),
    createScanPhotoPreparer(store, billing, libraryCapacity({}, 'development')),
  );
async function cleanup() {
  // Query only the disposable owner so even a lost enqueue acknowledgement is recoverable.
  for (const job of await jobs.list(ownerId)) {
    if (job.ownerId !== ownerId)
      throw new Error('Synthetic job cleanup ownership mismatch.');
    await jobs.remove(job.id);
  }
  for (const id of [preparedId, photoId, scanId]) {
    try {
      const row = await store.get(id);
      if (row.ownerId !== ownerId)
        throw new Error('Synthetic photo cleanup ownership mismatch.');
      if (id !== scanId) await store.removeFile(id);
      await store.remove(id);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
  console.info(
    'Removed disposable Discover jobs/manifests, scan, source photo and prepared copy.',
  );
}
try {
  const image = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#557766' },
  })
    .jpeg()
    .toBuffer();
  const createdAt = new Date().toISOString();
  await store.put(
    {
      id: scanId,
      ownerId,
      kind: 'job',
      purpose: 'discover-scan',
      processingSource: 'library',
      processingRequestId: requestId,
      consentPolicyVersion: 'face-matching-v1',
      consentAt: createdAt,
      state: 'running',
      createdAt,
    },
    true,
  );
  // Diagnostic metadata precedes storage so a failed upload remains discoverable for cleanup.
  await store.put(
    {
      id: photoId,
      ownerId,
      kind: 'photo',
      createdAt,
      filename: 'generated-discover.jpg',
      bytes: image.length,
      indexState: 'none',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
    true,
  );
  await store.upload(photoId, image);
  for (const attempt of [requestId, randomUUID()]) {
    const job = await queue.enqueue({
      ownerId,
      eventId: scanId,
      type: 'discover-library',
      requestId: attempt,
      photoIds: [photoId],
      consentPolicyVersion: 'face-matching-v1',
    });
    jobIds.push(job.id);
    await freshWorker().processNext();
    assert.equal((await queue.owned(job.id, ownerId)).status, 'complete');
  }
  assert.equal((await store.get(photoId)).indexState, 'none');
  assert.equal((await store.get(preparedId)).indexState, 'ready');
  const source = await store.file(photoId),
    prepared = await store.file(preparedId);
  assert.equal(source.ok, true);
  assert.equal(prepared.ok, true);
  assert.ok((await prepared.arrayBuffer()).byteLength > 0);
  await source.body?.cancel();
  const state = discoverState(
    await store.get(scanId),
    await store.list(ownerId, 'photo'),
    await queue.list(ownerId, scanId),
  );
  assert.equal(state.state, 'complete');
  assert.equal(state.indexed, 1);
  assert.deepEqual(state.matches, []);
  assert.equal(providerCalls, 1);
  assert.equal(usageReservations, 1);
  assert.equal(storageReservations, 1);
  assert.equal(await freshWorker().processNext(), false);
  console.info(
    'PASS: real Appwrite Discover manifests, independent stored scan copy, fresh-worker idempotency, progress and cleanup. Face/billing adapters SYNTHETIC; AWS calls: 0.',
  );
} finally {
  await cleanup();
}
