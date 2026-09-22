import { randomUUID } from 'node:crypto';
import { AppwriteException, type TablesDB } from 'node-appwrite';
import { describe, expect, it, vi } from 'vitest';
import {
  AppwriteFolderSyncStore,
  validateFolderSync,
  folderSyncTransaction,
} from '../../apps/api/src/adapters/appwrite-folder-sync.js';
import type { FolderSync } from '../../apps/api/src/folder-sync.js';
import {
  syncSuppressionId,
  syncPhotoProvenance,
} from '../../apps/api/src/folder-sync-suppression.js';
function fixture() {
  const record: FolderSync = {
    id: randomUUID(),
    ownerId: 'owner',
    actorId: 'owner',
    eventId: randomUUID(),
    provider: 'drive',
    generation: randomUUID(),
    folderId: 'folder',
    status: 'active',
    createdAt: '2026-09-21T00:00:00.000Z',
    nextRunAt: '2026-09-21T00:00:00.000Z',
    cursor: null,
    pages: 0,
    imported: 0,
    pending: {
      requestId: randomUUID(),
      fileIds: ['file-a'],
      nextCursor: null,
      batchId: 'batch',
    },
  };
  const row = {
    $id: record.id,
    ownerId: record.ownerId,
    actorId: record.actorId,
    eventId: record.eventId,
    status: record.status,
    nextRunAt: record.nextRunAt,
    payload: JSON.stringify(record),
  };
  const db = {
    createTransaction: vi.fn(async () => ({ $id: 'tx' })),
    updateTransaction: vi.fn(async () => ({})),
    getRow: vi.fn(async (args: { tableId: string }) => {
      if (args.tableId === 'folder-sync-files')
        throw new AppwriteException('Missing', 404);
      return row;
    }),
    createRow: vi.fn(async () => ({})),
    deleteRow: vi.fn(async () => ({})),
    updateRow: vi.fn(async () => ({})),
    listRows: vi.fn(
      async (): Promise<{ rows: Array<typeof row & { syncId?: string }> }> => ({
        rows: [row],
      }),
    ),
  };
  const store = new AppwriteFolderSyncStore(
    {
      endpoint: 'https://example.test/v1',
      projectId: 'synthetic',
      apiKey: 'synthetic',
    },
    db as unknown as TablesDB,
  );
  return { record, row, db, store };
}
describe('private transactional sync storage', () => {
  it('uses bounded terminal-source due queries for background cleanup', async () => {
    const f = stopped();
    expect(
      await f.store.cleanupCandidates('2026-09-22T00:00:00.000Z', 8),
    ).toEqual([f.record]);
    await expect(f.store.cleanupCandidates('invalid', 8)).rejects.toMatchObject(
      { code: 'SYNC_STORAGE_INVALID' },
    );
    await expect(
      f.store.cleanupCandidates('2026-09-22T00:00:00.000Z', 9),
    ).rejects.toMatchObject({ code: 'SYNC_STORAGE_INVALID' });
  });
  it('rejects a cleanup account unrelated to the source owner and actor', () => {
    const f = stopped();
    expect(() =>
      validateFolderSync({ ...f.record, cleanupAccountId: 'unrelated' }),
    ).toThrow();
    expect(
      validateFolderSync({ ...f.record, cleanupAccountId: 'owner' })
        .cleanupAccountId,
    ).toBe('owner');
  });
  function stopped() {
    const f = fixture();
    f.record.status = 'expired';
    f.record.cleanupRequestedAt = new Date().toISOString();
    f.row.status = 'expired';
    f.row.payload = JSON.stringify(f.record);
    return f;
  }
  it('checks owner and actor scope when listing account connections', async () => {
    const f = fixture();
    expect(await f.store.listOwner('owner')).toEqual([f.record]);
    expect(await f.store.listActor('owner')).toEqual([f.record]);
    await expect(f.store.listOwner('other')).rejects.toMatchObject({
      code: 'SYNC_STORAGE_INVALID',
    });
    await expect(f.store.listActor('other')).rejects.toMatchObject({
      code: 'SYNC_STORAGE_INVALID',
    });
  });
  it('deletes the last receipts and source within one transaction', async () => {
    const f = stopped();
    f.db.listRows.mockResolvedValueOnce({
      rows: [{ ...f.row, $id: 'receipt', syncId: f.record.id }],
    });
    expect(await f.store.purgePage(f.record)).toBe(true);
    expect(f.db.deleteRow).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: 'folder-sync-files',
        rowId: 'receipt',
        transactionId: 'tx',
      }),
    );
    expect(f.db.deleteRow).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: 'folder-syncs',
        rowId: f.record.id,
        transactionId: 'tx',
      }),
    );
    expect(f.db.updateTransaction).toHaveBeenLastCalledWith({
      transactionId: 'tx',
      commit: true,
    });
  });
  it('retains source authority when a full cleanup page may have more receipts', async () => {
    const f = stopped();
    f.db.listRows.mockResolvedValueOnce({
      rows: Array.from({ length: 25 }, (_, i) => ({
        ...f.row,
        $id: 'receipt-' + i,
        syncId: f.record.id,
      })),
    });
    expect(await f.store.purgePage(f.record)).toBe(false);
    expect(f.db.deleteRow).toHaveBeenCalledTimes(25);
    expect(f.db.deleteRow).not.toHaveBeenCalledWith(
      expect.objectContaining({ tableId: 'folder-syncs' }),
    );
    expect(f.db.updateRow).toHaveBeenCalledWith(
      expect.objectContaining({
        rowId: f.record.id,
        transactionId: 'tx',
        permissions: [],
      }),
    );
  });
  it('refuses to purge an active source', async () => {
    const f = fixture();
    await expect(f.store.purgePage(f.record)).rejects.toMatchObject({
      code: 'SYNC_STORAGE_INVALID',
    });
    expect(f.db.deleteRow).not.toHaveBeenCalled();
    expect(f.db.updateTransaction).toHaveBeenLastCalledWith({
      transactionId: 'tx',
      rollback: true,
    });
  });
  it('rolls back if a receipt belongs to a different source', async () => {
    const f = stopped();
    f.db.listRows.mockResolvedValueOnce({
      rows: [{ ...f.row, syncId: randomUUID() }],
    });
    await expect(f.store.purgePage(f.record)).rejects.toMatchObject({
      code: 'SYNC_STORAGE_INVALID',
    });
    expect(f.db.deleteRow).not.toHaveBeenCalled();
    expect(f.db.updateTransaction).toHaveBeenLastCalledWith({
      transactionId: 'tx',
      rollback: true,
    });
  });
  it('rolls back receipt erasure when the database rejects a deletion', async () => {
    const f = stopped();
    f.db.listRows.mockResolvedValueOnce({
      rows: [{ ...f.row, syncId: f.record.id }],
    });
    f.db.deleteRow.mockRejectedValueOnce(new Error('Unavailable'));
    await expect(f.store.purgePage(f.record)).rejects.toMatchObject({
      code: 'SYNC_CLEANUP_PENDING',
    });
    expect(f.db.updateTransaction).toHaveBeenLastCalledWith({
      transactionId: 'tx',
      rollback: true,
    });
  });
  it('redacts source location and pending file manifest without removing suppression authority', async () => {
    const f = stopped();
    await f.store.redactActor(f.record);
    expect(f.db.updateRow).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: 'tx',
        permissions: [],
        data: { payload: expect.any(String) },
      }),
    );
    const call = f.db.updateRow.mock.calls[0] as unknown as [
      { data: { payload: string } },
    ];
    const saved = JSON.parse(call[0].data.payload);
    expect(saved).toMatchObject({
      id: f.record.id,
      ownerId: 'owner',
      actorId: 'owner',
      status: 'expired',
      folderId: 'removed',
      cursor: null,
    });
    expect(saved.cleanupRedactedAt).toBeDefined();
    expect(saved.pending).toBeUndefined();
    expect(f.db.deleteRow).not.toHaveBeenCalled();
    expect(f.db.updateTransaction).toHaveBeenLastCalledWith({
      transactionId: 'tx',
      commit: true,
    });
  });
  it('includes suppression receipts when excluding already handled folder files', async () => {
    const f = fixture(),
      receipt = {
        ...f.row,
        $id: syncSuppressionId(
          f.record.id,
          syncPhotoProvenance('drive', 'file-a'),
        ),
        syncId: f.record.id,
      };
    f.db.listRows.mockResolvedValueOnce({ rows: [receipt] });
    expect(await f.store.knownFiles(f.record, ['file-a', 'file-b'])).toEqual(
      new Set(['file-a']),
    );
  });
  it('stores suppression in the private receipt table using the caller transaction', async () => {
    const f = fixture(),
      tx = folderSyncTransaction(f.db as unknown as TablesDB, 'billing-tx');
    await tx.suppress({
      id: randomUUID(),
      ownerId: 'owner',
      kind: 'photo',
      createdAt: f.record.createdAt,
      folderSyncId: f.record.id,
      sourcePhotoId: syncPhotoProvenance('drive', 'file-a'),
    });
    expect(f.db.createRow).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: 'folder-sync-files',
        transactionId: 'billing-tx',
        permissions: [],
        data: { ownerId: 'owner', syncId: f.record.id },
      }),
    );
  });
  it('updates recovery state in the caller transaction without changing source identity', async () => {
    const f = fixture(),
      tx = folderSyncTransaction(f.db as unknown as TablesDB, 'billing-tx');
    const record = await tx.get(f.record.id);
    await tx.update({
      ...record!,
      resumeRequestId: randomUUID(),
      pending: {
        ...record!.pending!,
        attemptId: randomUUID(),
        preservedFileIndexes: [0],
      },
    });
    expect(f.db.updateRow).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'billing-tx', permissions: [] }),
    );
    await expect(
      tx.update({ ...record!, generation: randomUUID() }),
    ).rejects.toMatchObject({ code: 'SYNC_STORAGE_INVALID' });
  });
  it('rejects preservation indexes outside the saved manifest', () => {
    const f = fixture();
    expect(() =>
      validateFolderSync({
        ...f.record,
        pending: { ...f.record.pending!, preservedFileIndexes: [1] },
      }),
    ).toThrow();
    expect(() =>
      validateFolderSync({
        ...f.record,
        pending: { ...f.record.pending!, preservedFileIndexes: [0, 0] },
      }),
    ).toThrow();
  });
  it('creates consented private sources using the caller transaction', async () => {
    const f = fixture();
    const tx = folderSyncTransaction(f.db as unknown as TablesDB, 'billing-tx');
    await tx.create({ ...f.record, consentPolicyVersion: 'folder-sync-v1' });
    expect(f.db.createRow).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: 'folder-syncs',
        transactionId: 'billing-tx',
        permissions: [],
        data: expect.objectContaining({
          ownerId: f.record.ownerId,
          eventId: f.record.eventId,
        }),
      }),
    );
    expect(f.db.createTransaction).not.toHaveBeenCalled();
  });
  it('checks event ownership on transactional source listings', async () => {
    const f = fixture();
    const tx = folderSyncTransaction(f.db as unknown as TablesDB, 'billing-tx');
    expect(await tx.listEvent(f.record.ownerId, f.record.eventId)).toEqual([
      f.record,
    ]);
    await expect(
      tx.listEvent('another-owner', f.record.eventId),
    ).rejects.toMatchObject({ code: 'SYNC_STORAGE_INVALID' });
    expect(f.db.listRows).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'billing-tx' }),
    );
  });
  it('lists only the requested owner and event', async () => {
    const f = fixture();
    expect(await f.store.listEvent(f.record.ownerId, f.record.eventId)).toEqual(
      [f.record],
    );
    await expect(
      f.store.listEvent('different-owner', f.record.eventId),
    ).rejects.toMatchObject({ code: 'SYNC_STORAGE_INVALID' });
  });
  it('continues event source listing past the first database page', async () => {
    const f = fixture();
    const rows = Array.from({ length: 100 }, () => {
      const record = { ...f.record, id: randomUUID() };
      return { ...f.row, $id: record.id, payload: JSON.stringify(record) };
    });
    f.db.listRows
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [] });
    expect(
      await f.store.listEvent(f.record.ownerId, f.record.eventId),
    ).toHaveLength(100);
    expect(f.db.listRows).toHaveBeenCalledTimes(2);
  });
  it('reads and touches sync authority in the caller billing transaction, without creating another transaction', async () => {
    const f = fixture();
    const tx = folderSyncTransaction(f.db as unknown as TablesDB, 'billing-tx');
    const record = await tx.get(f.record.id);
    await tx.touch(record!);
    expect(f.db.createTransaction).not.toHaveBeenCalled();
    expect(f.db.getRow).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: 'folder-syncs',
        transactionId: 'billing-tx',
      }),
    );
    expect(f.db.updateRow).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: 'folder-syncs',
        transactionId: 'billing-tx',
        permissions: [],
      }),
    );
  });
  it('does not let publication change sync settings through its touch capability', async () => {
    const f = fixture();
    const tx = folderSyncTransaction(f.db as unknown as TablesDB, 'billing-tx');
    const record = await tx.get(f.record.id);
    await expect(
      tx.touch({ ...record!, status: 'paused' }),
    ).rejects.toMatchObject({ code: 'SYNC_STORAGE_INVALID' });
    expect(f.db.updateRow).not.toHaveBeenCalled();
  });
  it('commits file receipts and cursor metadata in one transaction with private permissions', async () => {
    const f = fixture();
    await f.store.mutate(f.record.id, (previous) => {
      const record = { ...previous!, imported: 1 };
      delete record.pending;
      return { record, remember: ['file-a'], result: true };
    });
    expect(f.db.createRow).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: 'folder-sync-files',
        transactionId: 'tx',
        permissions: [],
      }),
    );
    expect(f.db.updateRow).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: 'folder-syncs',
        transactionId: 'tx',
        permissions: [],
      }),
    );
    expect(f.db.updateTransaction).toHaveBeenLastCalledWith({
      transactionId: 'tx',
      commit: true,
    });
  });
  it('rolls back instead of advancing when a receipt cannot be stored', async () => {
    const f = fixture();
    f.db.createRow.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(
      f.store.mutate(f.record.id, (row) => ({
        record: { ...row!, imported: 1 },
        remember: ['file-a'],
        result: true,
      })),
    ).rejects.toMatchObject({ code: 'SYNC_STORAGE_UNAVAILABLE' });
    expect(f.db.updateRow).not.toHaveBeenCalled();
    expect(f.db.updateTransaction).toHaveBeenCalledWith({
      transactionId: 'tx',
      rollback: true,
    });
  });
  it('rejects owner or source generation changes on an existing sync identity', async () => {
    const f = fixture();
    await expect(
      f.store.mutate(f.record.id, (row) => ({
        record: { ...row!, generation: randomUUID() },
        result: true,
      })),
    ).rejects.toMatchObject({ code: 'SYNC_STORAGE_INVALID' });
    expect(f.db.updateRow).not.toHaveBeenCalled();
  });
  it('accepts equivalent ISO datetime serialization from the database', async () => {
    const f = fixture();
    f.row.nextRunAt = '2026-09-21T00:00:00.000+00:00';
    expect(await f.store.get(f.record.id)).toEqual(f.record);
  });
  it('requires a membership grant for a moderator-owned connection', () => {
    const f = fixture();
    expect(() =>
      validateFolderSync({ ...f.record, actorId: 'moderator' }),
    ).toThrow();
    expect(
      validateFolderSync({
        ...f.record,
        actorId: 'moderator',
        membershipGrantId: randomUUID(),
      }).actorId,
    ).toBe('moderator');
  });
});
