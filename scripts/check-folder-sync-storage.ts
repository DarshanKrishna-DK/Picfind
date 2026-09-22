import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { AppwriteException, Client, Query, TablesDB } from 'node-appwrite';
import { developmentStorageConfig } from './storage-test-config.js';
import { ApiError } from '../apps/api/src/auth.js';
import {
  AppwriteFolderSyncStore,
  folderSyncTransaction,
} from '../apps/api/src/adapters/appwrite-folder-sync.js';
import { AppwriteJobStore } from '../apps/api/src/adapters/appwrite-jobs.js';
import type { FolderSync } from '../apps/api/src/folder-sync.js';
import { JobQueue } from '../apps/api/src/jobs.js';
import { stableScanId } from '../apps/api/src/scan-photo-preparation.js';

async function run() {
  if (process.env.PICFIND_SYNC_STORAGE_TEST !== '1')
    throw new Error(
      'Set PICFIND_SYNC_STORAGE_TEST=1 for disposable metadata-only storage checks.',
    );
  loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
  const config = developmentStorageConfig(process.env);
  const { endpoint, projectId, apiKey } = config;
  const db = new TablesDB(
    new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey),
  );
  const syncs = new AppwriteFolderSyncStore(config, db);
  const jobs = new AppwriteJobStore(config, db);
  const future = Date.now() + 7 * 86400000;
  // Even if paused-source rejection regresses, this job cannot be picked up now.
  const queue = new JobQueue(jobs, { now: () => future });
  const owner = `sync-check-${randomUUID().slice(0, 25)}`;
  const sync: FolderSync = {
    id: randomUUID(),
    ownerId: owner,
    actorId: owner,
    eventId: randomUUID(),
    provider: 'drive',
    generation: randomUUID(),
    folderId: 'synthetic-no-cloud-folder',
    consentPolicyVersion: 'folder-sync-v1',
    status: 'paused',
    createdAt: new Date().toISOString(),
    nextRunAt: new Date(future).toISOString(),
    cursor: null,
    pages: 0,
    imported: 0,
    pending: {
      requestId: randomUUID(),
      fileIds: ['synthetic-no-photo'],
      nextCursor: null,
    },
  };
  const root = stableScanId(
    'folder-sync-import',
    sync.id + ':' + sync.pending!.requestId,
  );
  const jobId = createHash('sha256')
    .update(`${owner}:${root}:${sync.pending!.requestId}`)
    .digest('hex')
    .slice(0, 36);
  const receipts = () =>
    db.listRows({
      databaseId: 'picfind-library',
      tableId: 'folder-sync-files',
      queries: [
        Query.equal('ownerId', owner),
        Query.equal('syncId', sync.id),
        Query.limit(2),
      ],
    });
  let transactionId: string | undefined;
  console.info(
    `Disposable metadata check: source=${sync.id}, owner=${owner}. No photos or provider calls.`,
  );
  try {
    await syncs.mutate(sync.id, (existing) => {
      assert.equal(existing, undefined, 'Synthetic ID collision');
      return { record: sync, result: undefined };
    });
    const raw = await db.getRow({
      databaseId: 'picfind-library',
      tableId: 'folder-syncs',
      rowId: sync.id,
    });
    assert.deepEqual(raw.$permissions, []);
    await Promise.all(
      [0, 1].map(() =>
        syncs.mutate(sync.id, (row) => {
          assert.ok(row && row.ownerId === owner);
          return {
            record: { ...row, imported: row.imported + 1 },
            result: undefined,
          };
        }),
      ),
    );
    assert.equal((await syncs.get(sync.id))?.imported, 2);

    transactionId = (await db.createTransaction({ ttl: 60 })).$id;
    const transaction = folderSyncTransaction(db, transactionId);
    const stale = await transaction.get(sync.id);
    assert.ok(stale);
    await transaction.touch(stale);
    await syncs.mutate(sync.id, (row) => {
      assert.ok(row && row.ownerId === owner);
      return {
        record: { ...row, imported: row.imported + 1 },
        result: undefined,
      };
    });
    await assert.rejects(
      db.updateTransaction({ transactionId, commit: true }),
      (error: unknown) =>
        error instanceof AppwriteException && error.code === 409,
    );
    await db
      .updateTransaction({ transactionId, rollback: true })
      .catch(() => {});
    transactionId = undefined;
    assert.equal((await syncs.get(sync.id))?.imported, 3);

    await assert.rejects(
      queue.enqueue({
        ownerId: owner,
        eventId: root,
        requestId: sync.pending!.requestId,
        type: 'cloud-import',
        photoIds: sync.pending!.fileIds,
        consentPolicyVersion: 'cloud-import-v1',
        importSource: {
          provider: sync.provider,
          generation: sync.generation,
          destinationEventId: sync.eventId,
          folderSyncId: sync.id,
        },
      }),
      (error: unknown) =>
        error instanceof ApiError && error.code === 'SYNC_JOB_UNAVAILABLE',
    );
    assert.equal(await jobs.get(jobId), undefined);
    for (let attempt = 0; attempt < 2; attempt++)
      await syncs.mutate(sync.id, (row) => {
        assert.ok(row && row.ownerId === owner);
        return {
          record: row,
          remember: ['synthetic-no-photo'],
          result: undefined,
        };
      });
    const remembered = await receipts();
    assert.equal(remembered.rows.length, 1);
    assert.deepEqual(remembered.rows[0]!.$permissions, []);
  } finally {
    if (transactionId)
      await db
        .updateTransaction({ transactionId, rollback: true })
        .catch(() => {});
    const job = await jobs.get(jobId);
    if (job) {
      assert.equal(job.ownerId, owner, 'Refusing cleanup of unrelated job');
      assert.equal(job.importSource?.folderSyncId, sync.id);
      await jobs.remove(jobId);
    }
    const current = await syncs.get(sync.id);
    if (current) {
      assert.equal(
        current.ownerId,
        owner,
        'Refusing cleanup of unrelated source',
      );
      assert.equal(current.eventId, sync.eventId);
      const expired = await syncs.mutate(sync.id, (row) => {
        assert.ok(row && row.ownerId === owner && row.eventId === sync.eventId);
        const record: FolderSync = {
          ...row,
          status: 'expired',
          cleanupRequestedAt: new Date().toISOString(),
        };
        return { record, result: record };
      });
      assert.equal(await syncs.purgePage(expired), true);
    }
    assert.equal(await syncs.get(sync.id), undefined);
    assert.equal(await jobs.get(jobId), undefined);
    assert.equal((await receipts()).rows.length, 0);
    console.info(
      'Cleanup verified: disposable source, job and receipt metadata absent.',
    );
  }
  console.info(
    'PASS: real Appwrite private rows, concurrent updates, stale transaction rejection, paused-source enqueue rejection, receipt deduplication and cleanup. No AWS calls.',
  );
}
run().catch((error: unknown) => {
  const reason =
    error instanceof AppwriteException
      ? `HTTP ${error.code} (${error.type})`
      : error instanceof ApiError
        ? error.code
        : error instanceof Error
          ? error.message
          : 'Unknown failure';
  console.error(`Folder-sync storage diagnostic failed: ${reason}`);
  process.exitCode = 1;
});
