import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client, TablesDB } from 'node-appwrite';
import { AppwriteJobStore } from '../apps/api/src/adapters/appwrite-jobs.js';
import { JobQueue } from '../apps/api/src/jobs.js';
loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
if (process.env.PICFIND_JOB_STORAGE_TEST !== '1')
  throw new Error(
    'Set PICFIND_JOB_STORAGE_TEST=1 to create and remove one isolated synthetic job.',
  );
const {
  APPWRITE_ENDPOINT: endpoint,
  APPWRITE_PROJECT_ID: projectId,
  APPWRITE_API_KEY: apiKey,
} = process.env;
if (!endpoint || !projectId || !apiKey)
  throw new Error('Appwrite configuration is required.');
const store = new AppwriteJobStore({ endpoint, projectId, apiKey });
const db = new TablesDB(
  new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey),
);
const input = {
  ownerId: `job-smoke-${randomUUID()}`,
  eventId: randomUUID(),
  requestId: randomUUID(),
  photoIds: [randomUUID()],
  consentPolicyVersion: 'face-matching-v1' as const,
};
let id: string | undefined;
async function cleanup() {
  if (!id) return;
  const row = await store.get(id);
  if (row?.ownerId !== input.ownerId)
    throw new Error('Synthetic cleanup ownership check failed.');
  await db.deleteRow({
    databaseId: 'picfind-library',
    tableId: 'processing-jobs',
    rowId: id,
  });
  console.info('Removed the isolated synthetic job row.');
}
try {
  const queue = new JobQueue(store);
  const job = await queue.enqueue(input);
  id = job.id;
  assert.equal((await queue.list(input.ownerId, input.eventId)).length, 1);
  assert.equal(
    (await queue.list('unrelated-synthetic-owner', input.eventId)).length,
    0,
  );
  assert.equal((await queue.enqueue(input)).id, job.id);
  // Never claim another account's queued work during this smoke test.
  const isolated = new Proxy(store, {
    get(target, property) {
      if (property === 'candidates')
        return async () => {
          const current = await target.get(job.id);
          return current ? [current] : [];
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const workers = [new JobQueue(isolated), new JobQueue(isolated)];
  const claims = await Promise.all(
    workers.map((worker, index) => worker.claim(`synthetic-${index}`)),
  );
  const claimed = claims.filter((value) => value !== undefined);
  assert.equal(claimed.length, 1);
  await queue.beginItem(job.id, claimed[0]!.leaseToken!);
  await queue.finishItem(job.id, claimed[0]!.leaseToken!, 'empty');
  assert.equal((await queue.owned(job.id, input.ownerId)).status, 'complete');
  console.info(
    'PASS: real private Appwrite job deduplication, concurrent claims, fenced progress and completion. No photos or AWS calls.',
  );
} finally {
  await cleanup();
}
