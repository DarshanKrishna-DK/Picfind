import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppwriteException, TablesDB } from 'node-appwrite';
import { AppwriteBillingStore } from '../../apps/api/src/adapters/appwrite-billing.js';
import type { EventBillingTransaction } from '../../apps/api/src/billing/event-entitlements.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  let sequence = 0;
  vi.spyOn(TablesDB.prototype, 'createTransaction').mockImplementation(
    async () => ({ $id: 'tx-' + ++sequence }) as never,
  );
  const commit = vi
    .spyOn(TablesDB.prototype, 'updateTransaction')
    .mockResolvedValue({} as never);
  const get = vi
    .spyOn(TablesDB.prototype, 'getRow')
    .mockRejectedValue(new AppwriteException('Synthetic missing row', 404));
  vi.spyOn(TablesDB.prototype, 'listRows').mockResolvedValue({
    rows: [],
    total: 0,
  } as never);
  const create = vi
    .spyOn(TablesDB.prototype, 'createRow')
    .mockResolvedValue({} as never);
  const update = vi
    .spyOn(TablesDB.prototype, 'updateRow')
    .mockResolvedValue({} as never);
  const store = new AppwriteBillingStore({
    endpoint: 'https://synthetic.example.test/v1',
    projectId: 'synthetic',
    apiKey: 'synthetic-not-a-real-key',
  });
  return { store, commit, create, update, get };
}
describe('cross-table event accounting adapter without external requests', () => {
  it('stages the account conflict row and private event in the same Appwrite transaction', async () => {
    const f = fixture();
    await f.store.transaction(async (base) => {
      const tx = base as typeof base & EventBillingTransaction;
      await tx.put('account', 'test_mode:owner', 'account', {
        eventRevision: 1,
      });
      await tx.events.put({
        id: 'event',
        ownerId: 'owner',
        kind: 'event',
        createdAt: '2026-09-21T10:00:00.000Z',
        expiresAt: '2026-09-22T10:00:00.000Z',
      });
      expect((await tx.events.list('owner')).map((row) => row.id)).toEqual([
        'event',
      ]);
      expect(await tx.events.get('event')).toMatchObject({ ownerId: 'owner' });
    });
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: 'picfind-library',
        tableId: 'billing',
        transactionId: 'tx-1',
        rowId: 'account',
        permissions: [],
      }),
    );
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseId: 'picfind-library',
        tableId: 'records',
        transactionId: 'tx-1',
        rowId: 'event',
        permissions: [],
      }),
    );
    expect(f.commit).toHaveBeenLastCalledWith({
      transactionId: 'tx-1',
      commit: true,
    });
  });
  it('re-executes the entire capacity callback after an account-row conflict', async () => {
    const f = fixture();
    f.commit.mockRejectedValueOnce(
      new AppwriteException('Synthetic conflict', 409),
    );
    const work = vi.fn(
      async (
        base: Parameters<Parameters<typeof f.store.transaction>[0]>[0],
      ) => {
        const tx = base as typeof base & EventBillingTransaction;
        await tx.events.list('owner');
        await tx.put('account', 'test_mode:owner', 'account', {
          eventRevision: 1,
        });
        await tx.events.put({
          id: 'event',
          ownerId: 'owner',
          kind: 'event',
          createdAt: '2026-09-21T10:00:00.000Z',
        });
      },
    );
    await f.store.transaction(work);
    expect(work).toHaveBeenCalledTimes(2);
    expect(f.commit).toHaveBeenCalledWith({
      transactionId: 'tx-1',
      rollback: true,
    });
    expect(f.commit).toHaveBeenLastCalledWith({
      transactionId: 'tx-2',
      commit: true,
    });
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({ tableId: 'records', transactionId: 'tx-2' }),
    );
  });
});
