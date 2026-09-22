import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client, Query, TablesDB } from 'node-appwrite';
import { AppwriteJobStore } from '../apps/api/src/adapters/appwrite-jobs.js';
import { JobQueue, publicJob, type JobStore } from '../apps/api/src/jobs.js';

if (process.env.PICFIND_MANIFEST_STORAGE_TEST !== '1')
  throw new Error(
    'Set PICFIND_MANIFEST_STORAGE_TEST=1 to create and remove isolated private test rows.',
  );
loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
const {
  APPWRITE_ENDPOINT: endpoint,
  APPWRITE_PROJECT_ID: projectId,
  APPWRITE_API_KEY: apiKey,
} = process.env;
if (!endpoint || !projectId || !apiKey)
  throw new Error('Appwrite configuration is required.');
const config = { endpoint, projectId, apiKey };
const ownerId = 'manifest-check-' + randomUUID().slice(0, 20);
const eventId = randomUUID(),
  requestId = randomUUID();
const jobId = createHash('sha256')
  .update(`${ownerId}:${eventId}:${requestId}`)
  .digest('hex')
  .slice(0, 36);
const source = new AppwriteJobStore(config);
// This diagnostic can only claim its own isolated job, never another owner's work.
const isolated: JobStore = {
  list: source.list.bind(source),
  get: source.get.bind(source),
  remove: source.remove.bind(source),
  mutate: source.mutate.bind(source),
  candidates: async () => {
    const job = await source.get(jobId);
    return job ? [job] : [];
  },
};
const queue = new JobQueue(isolated);
const db = new TablesDB(
  new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey),
);
const input = {
  ownerId,
  eventId,
  requestId,
  photoIds: Array.from({ length: 7500 }, () => randomUUID()),
  consentPolicyVersion: 'face-matching-v1' as const,
};
try {
  const job = await queue.enqueue(input);
  assert.equal(job.id, jobId);
  const history = await queue.list(ownerId, eventId);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.photoIds, undefined);
  assert.equal(publicJob(history[0]!).total, 7500);
  assert.equal(
    (await queue.list('different-synthetic-owner', eventId)).length,
    0,
  );
  const reloaded = await new AppwriteJobStore(config).get(jobId);
  assert.deepEqual(reloaded?.photoIds, input.photoIds);
  const claim = await queue.claim('manifest-diagnostic');
  assert.equal(claim?.id, jobId);
  assert.equal(
    await queue.beginItem(jobId, claim!.leaseToken!),
    input.photoIds[0],
  );
  await queue.finishItem(jobId, claim!.leaseToken!, 'empty', 0);
  const replay = await queue.enqueue(input);
  assert.equal(replay.cursor, 1);
  const stored = await db.getRow({
    databaseId: 'picfind-library',
    tableId: 'processing-jobs',
    rowId: jobId,
  });
  const payload = String(stored.payload);
  assert.ok(Buffer.byteLength(payload) < 64000);
  assert.equal('photoIds' in JSON.parse(payload), false);
  console.info(
    'PASS: real Appwrite 7,500-ID manifest, metadata-only history, fresh reload, lease/checkpoint and request replay. Images: 0; Rekognition calls: 0.',
  );
} finally {
  for (const job of await source.list(ownerId, eventId)) {
    assert.equal(job.ownerId, ownerId);
    assert.equal(job.eventId, eventId);
    await source.remove(job.id);
  }
  assert.equal((await source.list(ownerId, eventId)).length, 0);
  const remaining = await db.listRows({
    databaseId: 'picfind-library',
    tableId: 'processing-manifests',
    queries: [
      Query.equal('ownerId', ownerId),
      Query.equal('jobId', jobId),
      Query.limit(1),
    ],
  });
  assert.equal(remaining.rows.length, 0);
  console.info('Removed the isolated job and all private manifest rows.');
}
