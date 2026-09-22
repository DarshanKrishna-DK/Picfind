import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { loadProjectEnvironment } from '../apps/api/src/load-environment.js';
import { AppwriteJobStore } from '../apps/api/src/adapters/appwrite-jobs.js';
import { AppwriteLibraryStore } from '../apps/api/src/adapters/appwrite-library.js';
import { ApiError } from '../apps/api/src/auth.js';
import { CloudImportWorker } from '../apps/api/src/cloud-import-worker.js';
import {
  cloudPhotoId,
  createCloudPhotoImporter,
} from '../apps/api/src/cloud-photo-import.js';
import { JobQueue, type JobStore } from '../apps/api/src/jobs.js';

if (process.env.PICFIND_CLOUD_IMPORT_STORAGE_TEST !== '1')
  throw new Error(
    'Set PICFIND_CLOUD_IMPORT_STORAGE_TEST=1. Uses one generated image, real Appwrite storage and a synthetic source; no AWS or cloud-photo access.',
  );
loadProjectEnvironment(import.meta.url);
const config = {
  endpoint: process.env.APPWRITE_ENDPOINT!,
  projectId: process.env.APPWRITE_PROJECT_ID!,
  apiKey: process.env.APPWRITE_API_KEY!,
};
if (!config.endpoint || !config.projectId || !config.apiKey)
  throw new Error('Appwrite configuration is required.');
const ownerId = randomUUID(),
  importId = randomUUID(),
  requestId = randomUUID(),
  generation = randomUUID();
const fileId = 'id:generated-diagnostic',
  photoId = cloudPhotoId(importId, fileId);
const store = new AppwriteLibraryStore(config),
  jobs = new AppwriteJobStore(config);
let jobId: string | undefined,
  reads = 0;
const isolated = new Proxy(jobs, {
  get(target, property) {
    if (property === 'candidates')
      return async () => {
        if (!jobId) return [];
        const job = await target.get(jobId);
        return job ? [job] : [];
      };
    const value: unknown = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  },
}) as JobStore;
const queue = new JobQueue(isolated);
try {
  const image = await sharp({
    create: { width: 16, height: 16, channels: 3, background: '#4488aa' },
  })
    .jpeg()
    .toBuffer();
  await store.put(
    {
      id: importId,
      ownerId,
      kind: 'job',
      purpose: 'import',
      source: 'dropbox',
      processingSource: 'cloud',
      processingRequestId: requestId,
      state: 'running',
      createdAt: new Date().toISOString(),
    },
    true,
  );
  const source = { provider: 'dropbox' as const, generation };
  const importer = createCloudPhotoImporter(
    store,
    {
      access: async (owner, provider, expected) => {
        assert.equal(owner, ownerId);
        assert.equal(provider, source.provider);
        assert.equal(expected, generation);
        return {
          accessToken: 'synthetic-only',
          generation,
          expiresAt: Date.now() + 3600000,
        };
      },
    },
    undefined,
    {
      production: false,
      libraryPhotos: 20,
      events: 20,
      eventPhotos: 20,
      discoverPhotos: 20,
    },
    async () => {
      reads++;
      return { name: 'generated-import.jpg', bytes: image };
    },
  );
  jobId = (
    await queue.enqueue({
      ownerId,
      eventId: importId,
      requestId,
      type: 'cloud-import',
      importSource: source,
      photoIds: [fileId],
      consentPolicyVersion: 'cloud-import-v1',
    })
  ).id;
  const worker = new CloudImportWorker(queue, store, importer);
  assert.equal(await worker.processNext(), true);
  const restarted = new JobQueue(new AppwriteJobStore(config));
  assert.equal((await restarted.owned(jobId, ownerId)).status, 'complete');
  assert.equal((await restarted.owned(jobId, ownerId)).imported, 1);
  const photo = await store.get(photoId);
  assert.equal(photo.importId, importId);
  assert.equal(photo.indexState, 'none');
  const storedImage = await store.file(photoId);
  assert.equal(storedImage.ok, true);
  assert.ok((await storedImage.arrayBuffer()).byteLength > 0);
  await importer(ownerId, importId, source, fileId, async () => {});
  assert.equal(reads, 1, 'Completed photo must not be downloaded again');
  assert.equal((await store.list(ownerId, 'photo')).length, 1);
  assert.equal(await worker.processNext(), false);
  console.info(
    'PASS: real Appwrite saved import, manifest, generated image, restart readback and duplicate prevention. Source adapter synthetic; AWS calls: 0.',
  );
} finally {
  await cleanup();
}
async function cleanup() {
  // Every target belongs to the random diagnostic owner; never claim unrelated jobs.
  try {
    await store.removeFile(photoId);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
  for (const kind of ['photo', 'job'] as const) {
    for (const row of await store.list(ownerId, kind)) {
      assert.equal(row.ownerId, ownerId);
      await store.remove(row.id);
    }
  }
  for (const job of await jobs.list(ownerId)) {
    assert.equal(job.ownerId, ownerId);
    await jobs.remove(job.id);
  }
  console.info(
    'Cleanup complete: isolated import, photo, upload intent, job and manifest removed.',
  );
}
