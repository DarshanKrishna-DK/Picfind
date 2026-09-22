import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BillingService } from '../../apps/api/src/billing/service.js';
import type {
  BillingAccount,
  BillingStore,
  BillingTransaction,
} from '../../apps/api/src/billing/model.js';
import type { EventBillingTransaction } from '../../apps/api/src/billing/event-entitlements.js';
import type { LibraryRecord } from '../../apps/api/src/library.js';
import { stableScanId } from '../../apps/api/src/scan-photo-preparation.js';

function fixture(moderator = true) {
  const owner = randomUUID(),
    actor = moderator ? randomUUID() : owner;
  const event: LibraryRecord = {
    id: randomUUID(),
    ownerId: owner,
    kind: 'event',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    members: moderator
      ? [
          {
            userId: actor,
            role: 'moderator',
            grantId: randomUUID(),
            addedAt: new Date().toISOString(),
          },
        ]
      : [],
  };
  const requestId = randomUUID();
  const root: LibraryRecord = {
    id: stableScanId('cloud-import', actor + ':' + requestId),
    ownerId: owner,
    uploadedBy: actor,
    kind: 'job',
    purpose: 'import',
    processingSource: 'cloud',
    source: 'dropbox',
    eventId: event.id,
    sourceFingerprint: 'a'.repeat(64),
    processingRequestId: requestId,
    ...(moderator
      ? {
          membershipGrantId: (event.members as { grantId: string }[])[0]!
            .grantId,
        }
      : {}),
    createdAt: new Date().toISOString(),
    state: 'running',
    imported: 0,
    errors: [],
  };
  const records = new Map<string, LibraryRecord>([[event.id, event]]);
  const accounts = new Map<string, unknown>();
  const state = { beforeCommit: null as null | (() => void), failRoot: false };
  let version = 0;
  const mutate = (work: () => void) => {
    work();
    version++;
  };
  const store: BillingStore = {
    async transaction<T>(
      work: (tx: BillingTransaction) => Promise<T>,
    ): Promise<T> {
      for (let attempt = 0; attempt < 3; attempt++) {
        const start = version,
          draft = structuredClone(records),
          ledger = structuredClone(accounts);
        const tx: BillingTransaction & EventBillingTransaction = {
          get: async <V>(id: string) =>
            structuredClone(ledger.get(id) ?? null) as V | null,
          list: async () => [],
          put: async (id, _owner, _kind, value) => {
            ledger.set(id, structuredClone(value));
          },
          events: {
            get: async (id) => draft.get(id) ?? null,
            list: async () =>
              [...draft.values()].filter((row) => row.kind === 'event'),
            put: async (row) => {
              draft.set(row.id, structuredClone(row));
            },
            putImport: async (row) => {
              if (state.failRoot)
                throw new Error('Synthetic staging write failure');
              draft.set(row.id, structuredClone(row));
            },
          },
        };
        const result = await work(tx);
        const callback = state.beforeCommit;
        state.beforeCommit = null;
        callback?.();
        if (start !== version) continue;
        records.clear();
        for (const [id, row] of draft) records.set(id, row);
        accounts.clear();
        for (const [id, row] of ledger) accounts.set(id, row);
        version++;
        return result;
      }
      throw new Error('Synthetic transaction retry limit');
    },
  };
  const service = new BillingService(
    store,
    undefined,
    {},
    'test_mode',
    false,
    true,
  );
  for (const id of new Set([owner, actor]))
    accounts.set(service.key('account', id), {
      ownerId: id,
      revision: 1,
      createdAt: new Date().toISOString(),
      subscriptions: {},
    } satisfies BillingAccount);
  const stage = (candidate = root, previous?: string) =>
    service.stageEventImport(actor, candidate, previous);
  return {
    owner,
    actor,
    event,
    root,
    records,
    accounts,
    state,
    mutate,
    service,
    stage,
  };
}

describe('manual event import staging with synthetic transactional storage', () => {
  it.each([false, true])(
    'stages owner/moderator metadata and touches accounts: moderator=%s',
    async (moderator) => {
      const f = fixture(moderator);
      const result = await f.stage({ ...f.root, imported: 100 });
      expect(result.imported).toBe(0);
      expect(result.uploadedBy).toBe(f.actor);
      for (const actor of new Set([f.actor, f.owner]))
        expect(
          (f.accounts.get(f.service.key('account', actor)) as BillingAccount)
            .revision,
        ).toBe(2);
    },
  );
  it('preserves completed progress on same-request retry', async () => {
    const f = fixture();
    f.records.set(f.root.id, { ...f.root, state: 'complete', imported: 2 });
    expect(await f.stage()).toMatchObject({ state: 'complete', imported: 2 });
  });
  it('resumes only the expected attempt and preserves completed photo count', async () => {
    const f = fixture();
    f.records.set(f.root.id, { ...f.root, state: 'partial', imported: 1 });
    const candidate = { ...f.root, processingRequestId: randomUUID() };
    expect(await f.stage(candidate, f.root.processingRequestId)).toMatchObject({
      state: 'running',
      imported: 1,
      processingRequestId: candidate.processingRequestId,
    });
    await expect(
      f.stage(
        { ...candidate, processingRequestId: randomUUID() },
        f.root.processingRequestId,
      ),
    ).rejects.toMatchObject({ code: 'IMPORT_UNAVAILABLE' });
  });
  it('cannot recreate a removed import through resume', async () => {
    const f = fixture();
    await expect(
      f.stage(
        { ...f.root, processingRequestId: randomUUID() },
        f.root.processingRequestId,
      ),
    ).rejects.toMatchObject({ code: 'IMPORT_UNAVAILABLE' });
    expect(f.records.has(f.root.id)).toBe(false);
  });
  it.each([
    'event-deleted',
    'event-expired',
    'moderator-revoked',
    'owner-deleting',
    'actor-deleting',
  ])(
    'rechecks authority when %s wins the staging commit race',
    async (change) => {
      const f = fixture();
      f.state.beforeCommit = () =>
        f.mutate(() => {
          if (change === 'event-deleted') f.records.delete(f.event.id);
          if (change === 'event-expired')
            f.records.set(f.event.id, {
              ...f.event,
              expiresAt: new Date(0).toISOString(),
            });
          if (change === 'moderator-revoked')
            f.records.set(f.event.id, { ...f.event, members: [] });
          if (change.endsWith('-deleting')) {
            const id = f.service.key(
              'account',
              change === 'owner-deleting' ? f.owner : f.actor,
            );
            f.accounts.set(id, {
              ...(f.accounts.get(id) as BillingAccount),
              deletionPendingAt: new Date().toISOString(),
            });
          }
        });
      await expect(f.stage()).rejects.toBeDefined();
      expect(f.records.has(f.root.id)).toBe(false);
    },
  );
  it('rolls back account revisions when the import write fails', async () => {
    const f = fixture();
    f.state.failRoot = true;
    await expect(f.stage()).rejects.toThrow('Synthetic staging write failure');
    expect(
      (f.accounts.get(f.service.key('account', f.owner)) as BillingAccount)
        .revision,
    ).toBe(1);
    expect(f.records.has(f.root.id)).toBe(false);
  });
  it('rejects conflicting source metadata without resetting progress', async () => {
    const f = fixture();
    f.records.set(f.root.id, {
      ...f.root,
      sourceFingerprint: 'b'.repeat(64),
      imported: 2,
    });
    await expect(f.stage()).rejects.toMatchObject({
      code: 'IMPORT_UNAVAILABLE',
    });
    expect(f.records.get(f.root.id)?.imported).toBe(2);
  });
});

describe('malformed saved manual import attempts', () => {
  it('rejects a saved root without a request ID rather than treating it as a retry', async () => {
    const f = fixture();
    const malformed = { ...f.root };
    delete malformed.processingRequestId;
    f.records.set(f.root.id, malformed);
    await expect(f.stage()).rejects.toMatchObject({
      code: 'IMPORT_UNAVAILABLE',
    });
  });
});
