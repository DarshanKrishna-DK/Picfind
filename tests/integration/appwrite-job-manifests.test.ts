import { randomUUID } from 'node:crypto';
import { billingId } from '../../apps/api/src/billing/model.js';
import { describe, expect, it } from 'vitest';
import { AppwriteException, type TablesDB } from 'node-appwrite';
import type { FolderSync } from '../../apps/api/src/folder-sync.js';
import { stableScanId } from '../../apps/api/src/scan-photo-preparation.js';
import { AppwriteJobStore } from '../../apps/api/src/adapters/appwrite-jobs.js';
import { JobQueue, publicJob } from '../../apps/api/src/jobs.js';

type Row = { $id: string; [key: string]: unknown };
type Args = {
  tableId: string;
  rowId: string;
  transactionId?: string;
  data?: Record<string, unknown>;
  permissions?: string[];
};
function fakeTables() {
  let rows = new Map<string, Row>(),
    version = 0,
    sequence = 0,
    writes = 0;
  const transactions = new Map<
    string,
    { rows: Map<string, Row>; version: number }
  >();
  const state = {
    failWrite: 0,
    loseCommitReply: false,
    manifestReads: 0,
    beforeCommit: null as (() => void) | null,
  };
  const failure = (code: number) =>
    new AppwriteException('Synthetic table failure', code);
  const current = (transactionId?: string) =>
    transactionId ? transactions.get(transactionId)!.rows : rows;
  const beforeWrite = () => {
    writes++;
    if (state.failWrite === writes) throw failure(503);
  };
  const tables = {
    createTransaction: async () => {
      const id = String(++sequence);
      transactions.set(id, { rows: structuredClone(rows), version });
      return { $id: id };
    },
    updateTransaction: async ({
      transactionId,
      commit,
    }: {
      transactionId: string;
      commit?: boolean;
      rollback?: boolean;
    }) => {
      const transaction = transactions.get(transactionId);
      if (!transaction) return {};
      if (commit) {
        if (state.beforeCommit) {
          const before = state.beforeCommit;
          state.beforeCommit = null;
          before();
        }
        if (transaction.version !== version) throw failure(409);
        rows = transaction.rows;
        version++;
      }
      transactions.delete(transactionId);
      if (commit && state.loseCommitReply) {
        state.loseCommitReply = false;
        throw failure(503);
      }
      return {};
    },
    getRow: async (args: Args) => {
      const row = current(args.transactionId).get(
        args.tableId + '/' + args.rowId,
      );
      if (!row) throw failure(404);
      return structuredClone(row);
    },
    createRow: async (args: Args) => {
      beforeWrite();
      expect(args.permissions).toEqual([]);
      const map = current(args.transactionId),
        key = args.tableId + '/' + args.rowId;
      if (map.has(key)) throw failure(409);
      const row = { $id: args.rowId, ...args.data };
      map.set(key, row);
      return structuredClone(row);
    },
    updateRow: async (args: Args) => {
      beforeWrite();
      const map = current(args.transactionId),
        key = args.tableId + '/' + args.rowId;
      const row = map.get(key);
      if (!row) throw failure(404);
      const changed = { ...row, ...args.data };
      map.set(key, changed);
      return structuredClone(changed);
    },
    deleteRow: async (args: Args) => {
      beforeWrite();
      if (!current(args.transactionId).delete(args.tableId + '/' + args.rowId))
        throw failure(404);
      return {};
    },
    listRows: async ({
      tableId,
      queries,
      transactionId,
    }: {
      tableId: string;
      queries: string[];
      transactionId?: string;
    }) => {
      if (tableId === 'processing-manifests') state.manifestReads++;
      let result = [...current(transactionId)]
        .filter(([key]) => key.startsWith(tableId + '/'))
        .map(([, row]) => row);
      for (const encoded of queries) {
        const q = JSON.parse(encoded) as {
          method: string;
          attribute: string;
          values: unknown[];
        };
        if (q.method === 'equal')
          result = result.filter((row) => q.values.includes(row[q.attribute]));
        if (q.method === 'lessThanEqual')
          result = result.filter(
            (row) => String(row[q.attribute]) <= String(q.values[0]),
          );
        if (q.method === 'orderAsc')
          result.sort((a, b) =>
            String(a[q.attribute]).localeCompare(
              String(b[q.attribute]),
              undefined,
              { numeric: true },
            ),
          );
        if (q.method === 'cursorAfter')
          result = result.slice(
            result.findIndex((row) => row.$id === q.values[0]) + 1,
          );
        if (q.method === 'limit') result = result.slice(0, Number(q.values[0]));
      }
      return { rows: structuredClone(result) };
    },
  };
  return {
    tables: tables as unknown as TablesDB,
    state,
    rows: () => rows,
    outsideWrite: (key: string, row: Row) => {
      rows.set(key, row);
      version++;
    },
    failNextWrite: (offset = 1) => {
      state.failWrite = writes + offset;
    },
  };
}
function fixture(billingNamespace?: 'test_mode' | 'live_mode') {
  const db = fakeTables();
  const store = new AppwriteJobStore(
    {
      endpoint: 'https://synthetic.example/v1',
      projectId: 'synthetic',
      apiKey: 'synthetic',
      ...(billingNamespace ? { billingNamespace } : {}),
    },
    db.tables,
  );
  const queue = new JobQueue(store);
  const input = {
    ownerId: randomUUID(),
    eventId: randomUUID(),
    requestId: randomUUID(),
    photoIds: Array.from({ length: 7500 }, () => randomUUID()),
    consentPolicyVersion: 'face-matching-v1' as const,
  };
  return { db, store, queue, input };
}
function syncFixture() {
  const f = fixture();
  const now = new Date().toISOString();
  const sync: FolderSync = {
    id: randomUUID(),
    ownerId: f.input.ownerId,
    actorId: f.input.ownerId,
    eventId: randomUUID(),
    provider: 'drive',
    generation: randomUUID(),
    folderId: 'folder',
    status: 'active',
    createdAt: now,
    nextRunAt: now,
    consentPolicyVersion: 'folder-sync-v1',
    cursor: null,
    imported: 0,
    pages: 0,
    pending: {
      requestId: f.input.requestId,
      fileIds: ['file-a'],
      nextCursor: null,
    },
  };
  const saveSource = (status: FolderSync['status']) => {
    const record = { ...sync, status };
    f.db.outsideWrite('folder-syncs/' + sync.id, {
      $id: sync.id,
      ownerId: sync.ownerId,
      actorId: sync.actorId,
      eventId: sync.eventId,
      status,
      nextRunAt: now,
      payload: JSON.stringify(record),
    });
  };
  saveSource('active');
  const input = {
    ...f.input,
    eventId: stableScanId(
      'folder-sync-import',
      sync.id + ':' + f.input.requestId,
    ),
    type: 'cloud-import' as const,
    photoIds: ['file-a'],
    consentPolicyVersion: 'cloud-import-v1' as const,
    importSource: {
      provider: 'drive' as const,
      generation: sync.generation,
      destinationEventId: sync.eventId,
      folderSyncId: sync.id,
    },
  };
  return { ...f, input, sync, saveSource };
}

describe('sync queue creation and private manifest erasure, synthetic transactions', () => {
  it('creates the job and manifest alongside a source authority write', async () => {
    const f = syncFixture();
    const job = await f.queue.enqueue(f.input);
    expect(f.db.rows().size).toBe(3);
    expect(
      (await f.queue.owned(job.id, f.input.ownerId)).importSource?.folderSyncId,
    ).toBe(f.sync.id);
    expect(f.db.rows().has('folder-syncs/' + f.sync.id)).toBe(true);
  });
  it.each(['paused', 'expired', 'attention'] as const)(
    'does not create a manifest for a %s source',
    async (status) => {
      const f = syncFixture();
      f.saveSource(status);
      await expect(f.queue.enqueue(f.input)).rejects.toMatchObject({
        code: 'SYNC_JOB_UNAVAILABLE',
      });
      expect(f.db.rows().size).toBe(1);
    },
  );
  it('does not recreate a manifest after source removal', async () => {
    const f = syncFixture();
    f.db.rows().clear();
    await expect(f.queue.enqueue(f.input)).rejects.toMatchObject({
      code: 'SYNC_JOB_UNAVAILABLE',
    });
    expect(f.db.rows().size).toBe(0);
  });
  it('rolls back a racing enqueue when source deletion wins the transaction', async () => {
    const f = syncFixture();
    f.db.state.beforeCommit = () => f.saveSource('expired');
    await expect(f.queue.enqueue(f.input)).rejects.toMatchObject({
      code: 'SYNC_JOB_UNAVAILABLE',
    });
    expect(f.db.rows().size).toBe(1);
    expect(await f.queue.list(f.input.ownerId)).toEqual([]);
  });
  it('rejects another account, generation, event or file list', async () => {
    const f = syncFixture();
    for (const input of [
      { ...f.input, ownerId: randomUUID() },
      {
        ...f.input,
        importSource: { ...f.input.importSource, generation: randomUUID() },
      },
      {
        ...f.input,
        importSource: {
          ...f.input.importSource,
          destinationEventId: randomUUID(),
        },
      },
      { ...f.input, photoIds: ['other-file'] },
    ])
      await expect(f.queue.enqueue(input)).rejects.toMatchObject({
        code: 'SYNC_JOB_UNAVAILABLE',
      });
    expect(f.db.rows().size).toBe(1);
  });
  it('erases only this source and its manifests, and rejects an old enqueue retry', async () => {
    const f = syncFixture();
    const job = await f.queue.enqueue(f.input);
    const unrelated = await f.queue.enqueue({
      ownerId: f.input.ownerId,
      eventId: randomUUID(),
      requestId: randomUUID(),
      photoIds: ['manual-photo'],
      consentPolicyVersion: 'face-matching-v1',
    });
    f.saveSource('expired');
    await f.queue.eraseSource(f.input.ownerId, f.sync.id);
    expect(await f.store.get(job.id)).toBeUndefined();
    expect(await f.store.get(unrelated.id)).toBeDefined();
    expect(
      [...f.db.rows().values()].filter((row) => row.jobId === job.id),
    ).toEqual([]);
    await expect(f.queue.enqueue(f.input)).rejects.toMatchObject({
      code: 'SYNC_JOB_UNAVAILABLE',
    });
    await f.queue.eraseSource(f.input.ownerId, f.sync.id);
  });
  it('retains a running import manifest until the active item finishes', async () => {
    const f = syncFixture();
    const job = await f.queue.enqueue(f.input);
    const claim = (await f.queue.claim('synthetic-worker'))!;
    await f.queue.beginItem(job.id, claim.leaseToken!);
    f.saveSource('expired');
    await expect(
      f.queue.eraseSource(f.input.ownerId, f.sync.id),
    ).rejects.toMatchObject({ code: 'SYNC_CLEANUP_PENDING' });
    expect(await f.store.get(job.id)).toBeDefined();
    await f.queue.finishItem(job.id, claim.leaseToken!, 'imported', 0);
    await f.queue.eraseSource(f.input.ownerId, f.sync.id);
    expect(await f.store.get(job.id)).toBeUndefined();
  });
});

describe('transactional private job manifests with a synthetic database', () => {
  it('commits a Studio event atomically and lists its history without reading photo snapshots', async () => {
    const f = fixture();
    const job = await f.queue.enqueue(f.input);
    expect(f.db.rows().size).toBe(20);
    const history = await f.queue.list(f.input.ownerId, f.input.eventId);
    expect(history).toHaveLength(1);
    expect(publicJob(history[0]!).total).toBe(7500);
    expect(history[0]!.photoIds).toBeUndefined();
    expect(f.db.state.manifestReads).toBe(0);
    expect((await f.queue.owned(job.id, f.input.ownerId)).photoIds).toEqual(
      f.input.photoIds,
    );
    expect((await f.queue.owned(job.id, f.input.ownerId)).photoIds).toEqual(
      f.input.photoIds,
    );
    expect(f.db.state.manifestReads).toBe(1);
  });
  it('rolls back every chunk when a creation write fails', async () => {
    const f = fixture();
    f.db.failNextWrite(3);
    await expect(f.queue.enqueue(f.input)).rejects.toThrow('Synthetic');
    expect(f.db.rows().size).toBe(0);
    expect((await f.queue.enqueue(f.input)).photoIds).toHaveLength(7500);
  });
  it('reconciles a lost commit reply with the same owned request and no duplicate manifest', async () => {
    const f = fixture();
    f.db.state.loseCommitReply = true;
    await expect(f.queue.enqueue(f.input)).rejects.toThrow('Synthetic');
    expect(f.db.rows().size).toBe(20);
    const job = await f.queue.enqueue(f.input);
    expect(job.photoIds).toHaveLength(7500);
    expect(f.db.rows().size).toBe(20);
    await expect(
      f.queue.enqueue({ ...f.input, photoIds: [randomUUID()] }),
    ).rejects.toMatchObject({ code: 'JOB_REQUEST_REUSED' });
  });
  it('keeps progress writes small and rolls back a partial deletion before retrying', async () => {
    const f = fixture();
    const job = await f.queue.enqueue(f.input);
    const claim = (await f.queue.claim('synthetic-worker'))!;
    await f.queue.beginItem(job.id, claim.leaseToken!);
    await f.queue.finishItem(job.id, claim.leaseToken!, 'indexed', 0);
    const row = f.db.rows().get('processing-jobs/' + job.id)!;
    expect(Buffer.byteLength(String(row.payload))).toBeLessThan(64000);
    expect(JSON.parse(String(row.payload))).not.toHaveProperty('photoIds');
    f.db.failNextWrite(2);
    await expect(f.store.remove(job.id)).rejects.toThrow('Synthetic');
    expect(f.db.rows().size).toBe(20);
    await f.store.remove(job.id);
    expect(f.db.rows().size).toBe(0);
    expect(await f.store.get(job.id)).toBeUndefined();
  });
});

describe('manifest transaction recovery boundaries', () => {
  it('deduplicates concurrent transaction conflicts into one job and one snapshot', async () => {
    const f = fixture();
    const [first, second] = await Promise.all([
      f.queue.enqueue(f.input),
      f.queue.enqueue(f.input),
    ]);
    expect(first.id).toBe(second.id);
    expect(f.db.rows().size).toBe(20);
    expect((await f.queue.list(f.input.ownerId)).length).toBe(1);
  });
  it('migrates an inline legacy record atomically on its next progress write', async () => {
    const f = fixture();
    const legacy = await f.queue.enqueue({
      ...f.input,
      photoIds: f.input.photoIds.slice(0, 20),
    });
    // Convert only this synthetic fixture to the pre-manifest persisted format.
    f.db.rows().clear();
    f.db.rows().set('processing-jobs/' + legacy.id, {
      $id: legacy.id,
      ownerId: legacy.ownerId,
      eventId: legacy.eventId,
      status: legacy.status,
      availableAt: legacy.availableAt,
      payload: JSON.stringify(legacy),
    });
    await f.store.mutate(legacy.id, (job) => ({
      job: job!,
      result: undefined,
    }));
    expect(f.db.rows().size).toBe(2);
    expect(
      JSON.parse(
        String(f.db.rows().get('processing-jobs/' + legacy.id)!.payload),
      ),
    ).not.toHaveProperty('photoIds');
    expect((await f.store.get(legacy.id))?.photoIds).toEqual(legacy.photoIds);
  });
  it('reconciles a lost checkpoint reply without advancing or counting twice', async () => {
    const f = fixture();
    const job = await f.queue.enqueue(f.input);
    const claimed = (await f.queue.claim('synthetic-checkpoint-worker'))!;
    await f.queue.beginItem(job.id, claimed.leaseToken!);
    f.db.state.loseCommitReply = true;
    await expect(
      f.queue.finishItem(job.id, claimed.leaseToken!, 'indexed', 0),
    ).rejects.toThrow('Synthetic');
    const reconciled = await f.queue.finishItem(
      job.id,
      claimed.leaseToken!,
      'indexed',
      0,
    );
    expect(reconciled.cursor).toBe(1);
    expect(reconciled.indexed).toBe(1);
    expect(f.db.rows().size).toBe(20);
  });
  it('makes deletion retry safe after the deletion commit reply is lost', async () => {
    const f = fixture();
    const job = await f.queue.enqueue(f.input);
    f.db.state.loseCommitReply = true;
    await expect(f.store.remove(job.id)).rejects.toThrow('Synthetic');
    expect(f.db.rows().size).toBe(0);
    await f.store.remove(job.id);
    expect(await f.store.get(job.id)).toBeUndefined();
  });
  it('evicts immutable snapshots from the bounded cache and reloads safely', async () => {
    const f = fixture();
    let first = '';
    for (let index = 0; index < 17; index++) {
      const job = await f.queue.enqueue({
        ...f.input,
        requestId: randomUUID(),
        photoIds: [randomUUID()],
      });
      if (!first) first = job.id;
      await f.store.get(job.id);
    }
    const reads = f.db.state.manifestReads;
    expect((await f.store.get(first))?.photoIds).toHaveLength(1);
    expect(f.db.state.manifestReads).toBe(reads + 1);
  });
});

function manualEventFixture(billingNamespace?: 'test_mode' | 'live_mode') {
  const f = fixture(billingNamespace);
  const eventId = randomUUID();
  const actorId = randomUUID();
  const grantId = randomUUID();
  const event = {
    id: eventId,
    ownerId: f.input.ownerId,
    kind: 'event',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    members: [
      {
        userId: actorId,
        role: 'moderator',
        grantId,
        addedAt: new Date().toISOString(),
      },
    ],
  };
  const root = {
    id: f.input.eventId,
    ownerId: f.input.ownerId,
    kind: 'job',
    purpose: 'import',
    processingSource: 'cloud',
    source: 'drive',
    eventId,
    uploadedBy: actorId,
    membershipGrantId: grantId,
    processingRequestId: f.input.requestId,
  };
  const save = (record: typeof event | typeof root) =>
    f.db.outsideWrite('records/' + record.id, {
      $id: record.id,
      ownerId: record.ownerId,
      kind: record.kind,
      payload: JSON.stringify(record),
    });
  save(event);
  save(root);
  const input = {
    ...f.input,
    photoIds: ['cloud-file'],
    type: 'cloud-import' as const,
    consentPolicyVersion: 'cloud-import-v1' as const,
    importSource: {
      provider: 'drive' as const,
      generation: randomUUID(),
      destinationEventId: eventId,
      actorId,
      membershipGrantId: grantId,
    },
  };
  return { ...f, input, event, root, save };
}

describe('manual event import authority at enqueue commit', () => {
  it('allows an authorized moderator and preserves idempotent retries', async () => {
    const f = manualEventFixture();
    const job = await f.queue.enqueue(f.input);
    expect((await f.queue.enqueue(f.input)).id).toBe(job.id);
    expect(f.db.rows().size).toBe(4);
  });
  it.each([
    'deletion',
    'expiry',
    'revocation',
    'grant-replacement',
    'superseded-root',
  ])('rolls back manifests when %s wins the commit race', async (change) => {
    const f = manualEventFixture();
    f.db.state.beforeCommit = () => {
      if (change === 'deletion')
        f.save({
          ...f.event,
          deletionStartedAt: new Date().toISOString(),
        } as typeof f.event);
      if (change === 'expiry')
        f.save({ ...f.event, expiresAt: new Date(0).toISOString() });
      if (change === 'revocation') f.save({ ...f.event, members: [] });
      if (change === 'grant-replacement')
        f.save({
          ...f.event,
          members: [{ ...f.event.members[0]!, grantId: randomUUID() }],
        });
      if (change === 'superseded-root')
        f.save({ ...f.root, processingRequestId: randomUUID() });
    };
    await expect(f.queue.enqueue(f.input)).rejects.toBeDefined();
    expect(f.db.rows().size).toBe(2);
    expect(await f.queue.list(f.input.ownerId)).toEqual([]);
  });
  it('rejects an absent event rather than recreating a removed job', async () => {
    const f = manualEventFixture();
    f.db.rows().delete('records/' + f.event.id);
    await expect(f.queue.enqueue(f.input)).rejects.toMatchObject({
      code: 'EVENT_IMPORT_UNAVAILABLE',
    });
    expect(f.db.rows().size).toBe(1);
  });
  it('rejects an import root bound to another event', async () => {
    const f = manualEventFixture();
    f.save({ ...f.root, eventId: randomUUID() });
    await expect(f.queue.enqueue(f.input)).rejects.toMatchObject({
      code: 'EVENT_IMPORT_UNAVAILABLE',
    });
    expect(f.db.rows().size).toBe(2);
  });
});

function accountGuardFixture() {
  const f = manualEventFixture('test_mode');
  const accountIds = [f.input.ownerId, f.input.importSource.actorId];
  const saveAccount = (
    owner: string,
    deleting = false,
    namespace = 'test_mode',
  ) => {
    const id = billingId(namespace, 'account', owner);
    f.db.outsideWrite('billing/' + id, {
      $id: id,
      ownerId: `${namespace}:${owner}`,
      kind: 'account',
      payload: JSON.stringify({
        ownerId: owner,
        revision: 1,
        createdAt: new Date().toISOString(),
        subscriptions: {},
        ...(deleting ? { deletionPendingAt: new Date().toISOString() } : {}),
      }),
    });
  };
  for (const owner of accountIds) saveAccount(owner);
  return { ...f, accountIds, saveAccount };
}

describe('account deletion fencing for private event import queue creation', () => {
  it('creates a job only alongside open owner and source actor accounts', async () => {
    const f = accountGuardFixture();
    const job = await f.queue.enqueue(f.input);
    expect((await f.store.get(job.id))?.ownerId).toBe(f.input.ownerId);
  });
  it.each([0, 1])(
    'rejects account %s deletion at commit without leaving a manifest',
    async (index) => {
      const f = accountGuardFixture();
      f.db.state.beforeCommit = () => f.saveAccount(f.accountIds[index]!, true);
      await expect(f.queue.enqueue(f.input)).rejects.toMatchObject({
        code: 'ACCOUNT_DELETION_PENDING',
      });
      expect(await f.queue.list(f.input.ownerId)).toEqual([]);
      expect(
        [...f.db.rows().keys()].some((key) => key.startsWith('processing-')),
      ).toBe(false);
    },
  );
  it('does not accept a live namespace account in place of a test account', async () => {
    const f = accountGuardFixture();
    f.db
      .rows()
      .delete('billing/' + billingId('test_mode', 'account', f.input.ownerId));
    f.saveAccount(f.input.ownerId, false, 'live_mode');
    await expect(f.queue.enqueue(f.input)).rejects.toMatchObject({
      code: 'IMPORT_ACCOUNT_UNAVAILABLE',
    });
  });
  it('still permits cancellation and manifest cleanup after deletion begins', async () => {
    const f = accountGuardFixture();
    const job = await f.queue.enqueue(f.input);
    f.saveAccount(f.input.ownerId, true);
    await f.queue.cancel(job.id, f.input.ownerId);
    await f.queue.eraseEvent(
      f.input.ownerId,
      f.input.importSource.destinationEventId,
    );
    expect(await f.store.get(job.id)).toBeUndefined();
    await expect(f.queue.enqueue(f.input)).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_PENDING',
    });
  });
});
