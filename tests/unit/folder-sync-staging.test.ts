import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stageFolderSyncImport } from '../../apps/api/src/billing/folder-sync-staging.js';
import type { BillingTransaction } from '../../apps/api/src/billing/model.js';
import type { FolderSync } from '../../apps/api/src/folder-sync.js';
import type { LibraryRecord } from '../../apps/api/src/library.js';
import { stableScanId } from '../../apps/api/src/scan-photo-preparation.js';

const policy = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('../../apps/api/src/billing/folder-sync-policy.js', () => ({
  authorizeFolderSync: policy.authorize,
}));
beforeEach(() => policy.authorize.mockReset().mockResolvedValue({}));

function fixture() {
  const now = new Date().toISOString();
  const sync: FolderSync = {
    id: randomUUID(),
    ownerId: 'owner',
    actorId: 'owner',
    eventId: randomUUID(),
    provider: 'drive',
    generation: randomUUID(),
    folderId: 'folder',
    consentPolicyVersion: 'folder-sync-v1',
    status: 'active',
    createdAt: now,
    nextRunAt: now,
    cursor: null,
    pages: 0,
    imported: 0,
    pending: { requestId: randomUUID(), fileIds: ['photo'], nextCursor: null },
  };
  const source = {
    provider: sync.provider,
    generation: sync.generation,
    destinationEventId: sync.eventId,
    folderSyncId: sync.id,
  };
  const root: LibraryRecord = {
    id: stableScanId(
      'folder-sync-import',
      sync.id + ':' + sync.pending!.requestId,
    ),
    ownerId: sync.ownerId,
    uploadedBy: sync.actorId,
    kind: 'job',
    purpose: 'import',
    processingSource: 'cloud',
    source: sync.provider,
    eventId: sync.eventId,
    folderSyncId: sync.id,
    processingRequestId: sync.pending!.requestId,
    sourceFingerprint: createHash('sha256')
      .update(JSON.stringify([source, ['photo']]))
      .digest('hex'),
    createdAt: now,
    state: 'running',
    imported: 0,
    errors: [],
  };
  const rows = new Map<string, LibraryRecord>([
    [
      sync.eventId,
      {
        id: sync.eventId,
        ownerId: sync.ownerId,
        kind: 'event',
        createdAt: now,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    ],
  ]);
  const putImport = vi.fn(async (record: LibraryRecord) => {
    rows.set(record.id, record);
  });
  const touch = vi.fn(async () => {}),
    putEvent = vi.fn(async () => {});
  const tx = {
    events: {
      get: async (id: string) => rows.get(id) ?? null,
      put: putEvent,
      putImport,
    },
    folderSyncs: { get: async () => sync, touch },
  };
  const snapshot = structuredClone(sync);
  const stage = () =>
    stageFolderSyncImport(
      tx as unknown as BillingTransaction,
      'test',
      snapshot,
      root,
    );
  return { sync, root, rows, tx, stage, putImport, touch, putEvent };
}

describe('automatic import staging with synthetic transaction ports', () => {
  it('touches authority and stages only canonical metadata', async () => {
    const f = fixture();
    f.root.imported = 99;
    const root = await f.stage();
    expect(root.imported).toBe(0);
    expect(f.touch).toHaveBeenCalledWith(f.sync);
    expect(f.putEvent).toHaveBeenCalledOnce();
    expect(f.putImport).toHaveBeenCalledOnce();
  });
  it('preserves committed progress on an ambiguous-commit retry', async () => {
    const f = fixture();
    f.rows.set(f.root.id, { ...f.root, imported: 1, state: 'complete' });
    expect(await f.stage()).toMatchObject({ imported: 1, state: 'complete' });
    expect(f.putImport).not.toHaveBeenCalled();
  });
  it.each(['paused', 'expired', 'attention'] as const)(
    'rejects a %s source',
    async (status) => {
      const f = fixture();
      f.sync.status = status;
      await expect(f.stage()).rejects.toMatchObject({
        code: 'IMPORT_UNAVAILABLE',
      });
      expect(f.putImport).not.toHaveBeenCalled();
    },
  );
  it('rejects a source marked for cleanup before it can recreate a root', async () => {
    const f = fixture();
    f.sync.cleanupRequestedAt = new Date().toISOString();
    await expect(f.stage()).rejects.toMatchObject({
      code: 'IMPORT_UNAVAILABLE',
    });
  });
  it('rejects changed source authority and cross-event candidates', async () => {
    const f = fixture();
    f.sync.generation = randomUUID();
    await expect(f.stage()).rejects.toMatchObject({
      code: 'IMPORT_UNAVAILABLE',
    });
    const other = fixture();
    other.root.eventId = randomUUID();
    await expect(other.stage()).rejects.toMatchObject({
      code: 'IMPORT_UNAVAILABLE',
    });
  });
  it('does not stage when the current organizer policy denies access', async () => {
    const f = fixture();
    policy.authorize.mockRejectedValueOnce(new Error('Membership revoked'));
    await expect(f.stage()).rejects.toThrow('Membership revoked');
    expect(f.putImport).not.toHaveBeenCalled();
    expect(f.touch).not.toHaveBeenCalled();
  });
  it('refuses an existing root with another source fingerprint', async () => {
    const f = fixture();
    f.rows.set(f.root.id, { ...f.root, sourceFingerprint: 'another-source' });
    await expect(f.stage()).rejects.toMatchObject({
      code: 'IMPORT_UNAVAILABLE',
    });
    expect(f.putImport).not.toHaveBeenCalled();
  });
});
