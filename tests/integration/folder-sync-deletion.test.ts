import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/api/src/auth.js';
import { BillingService } from '../../apps/api/src/billing/service.js';
import type { BillingProvider } from '../../apps/api/src/billing/model.js';
import {
  cloudPhotoId,
  createCloudPhotoImporter,
} from '../../apps/api/src/cloud-photo-import.js';
import type { FolderSync } from '../../apps/api/src/folder-sync.js';
import {
  syncPhotoProvenance,
  syncSuppressionId,
  suppressSyncPhotoBeforeErase,
} from '../../apps/api/src/folder-sync-suppression.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import { deletePhotoSafely } from '../../apps/api/src/photo-deletion.js';
import { purgeExpiredPhotos } from '../../apps/api/src/retention.js';
import { stableScanId } from '../../apps/api/src/scan-photo-preparation.js';
import { ImportTestBillingStore } from '../helpers/cloud-import-billing-store.js';
import { prepareFolderSyncResume } from '../../apps/api/src/folder-sync-recovery.js';

function fixture() {
  const persistence = new ImportTestBillingStore();
  const provider: BillingProvider = {
    checkout: vi.fn(),
    portal: vi.fn(),
    verify: vi.fn(),
  };
  const billing = new BillingService(
    persistence,
    provider,
    {},
    'test_mode',
    true,
    true,
  );
  const now = new Date().toISOString(),
    expiresAt = new Date(Date.now() + 86400000).toISOString();
  const sync: FolderSync = {
    id: randomUUID(),
    ownerId: 'owner',
    actorId: 'owner',
    eventId: randomUUID(),
    provider: 'drive',
    generation: randomUUID(),
    folderId: 'folder',
    status: 'active',
    createdAt: now,
    nextRunAt: now,
    cursor: null,
    pages: 0,
    imported: 0,
    pending: { requestId: randomUUID(), fileIds: ['file-a'], nextCursor: null },
    consentPolicyVersion: 'folder-sync-v1',
  };
  const root: LibraryRecord = {
    id: stableScanId(
      'folder-sync-import',
      sync.id + ':' + sync.pending!.requestId,
    ),
    ownerId: 'owner',
    kind: 'job',
    purpose: 'import',
    processingSource: 'cloud',
    source: 'drive',
    folderSyncId: sync.id,
    eventId: sync.eventId,
    uploadedBy: 'owner',
    processingRequestId: sync.pending!.requestId,
    createdAt: now,
  };
  const photo: LibraryRecord = {
    id: cloudPhotoId(root.id, 'file-a'),
    ownerId: 'owner',
    kind: 'photo',
    source: 'drive',
    folderSyncId: sync.id,
    eventId: sync.eventId,
    importId: root.id,
    uploadedBy: 'owner',
    sourcePhotoId: syncPhotoProvenance('drive', 'file-a'),
    createdAt: now,
    expiresAt,
  };
  persistence.syncs.set(sync.id, sync);
  persistence.events.set(photo.id, photo);
  persistence.events.set(root.id, root);
  persistence.events.set(sync.eventId, {
    id: sync.eventId,
    ownerId: 'owner',
    kind: 'event',
    createdAt: now,
    expiresAt,
  });
  const rows = persistence.events;
  const store: LibraryStore = {
    get: async (id) => {
      const row = rows.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable');
      return structuredClone(row);
    },
    list: async (owner, kind) =>
      [...rows.values()]
        .filter((row) => row.ownerId === owner && row.kind === kind)
        .map((row) => structuredClone(row)),
    put: async (row) => {
      rows.set(row.id, structuredClone(row));
    },
    remove: vi.fn(async (id) => {
      rows.delete(id);
    }),
    expired: async (before) =>
      [...rows.values()]
        .filter(
          (row) =>
            row.expiresAt && Date.parse(row.expiresAt) <= Date.parse(before),
        )
        .map((row) => structuredClone(row)),
    upload: vi.fn(),
    file: vi.fn(),
    removeFile: vi.fn(async () => {}),
    suppressSyncPhoto: vi.fn((photo) => billing.suppressFolderSyncPhoto(photo)),
  };
  return {
    billing,
    persistence,
    rows,
    store,
    sync,
    root,
    photo,
    receipt: syncSuppressionId(sync.id, photo.sourcePhotoId!),
  };
}

describe('sync photo deletion and permanent suppression, no cloud calls', () => {
  it('recovers a deleted photo even when its queue checkpoint was never saved', async () => {
    const f = fixture();
    await deletePhotoSafely(f.store, f.photo);
    const recovery = await prepareFolderSyncResume(
      f.sync,
      randomUUID(),
      f.store,
      {
        owned: async () => {
          throw new ApiError(404, 'JOB_NOT_FOUND', 'Missing');
        },
        cancel: vi.fn(),
      },
      async () => f.persistence.suppressions.has(f.receipt),
    );
    expect(recovery).toEqual({ preservedFileIndexes: [], rootRequired: true });
    expect(f.rows.has(f.photo.id)).toBe(false);
  });
  it('commits suppression before erasing a photo from an unacknowledged batch', async () => {
    const f = fixture();
    f.store.removeFile = vi.fn(async () => {
      expect(f.persistence.suppressions.has(f.receipt)).toBe(true);
    });
    expect(await deletePhotoSafely(f.store, f.photo)).toBe('deleted');
    expect(f.rows.has(f.photo.id)).toBe(false);
    expect(f.persistence.suppressions.has(f.receipt)).toBe(true);
    expect(f.persistence.syncs.get(f.sync.id)?.pending?.fileIds).toEqual([
      'file-a',
    ]);
  });
  it('keeps a hidden erasure reference if suppression is not configured', async () => {
    const f = fixture();
    delete f.store.suppressSyncPhoto;
    expect(await deletePhotoSafely(f.store, f.photo)).toBe('pending');
    expect(f.store.removeFile).not.toHaveBeenCalled();
    expect(f.rows.get(f.photo.id)?.cleanupAfter).toBeDefined();
    expect(Date.parse(f.rows.get(f.photo.id)!.expiresAt!)).toBeLessThanOrEqual(
      Date.now(),
    );
  });
  it('retries suppression through retention before removing hidden metadata', async () => {
    const f = fixture();
    vi.mocked(f.store.suppressSyncPhoto!).mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    expect(await deletePhotoSafely(f.store, f.photo)).toBe('pending');
    expect(f.persistence.suppressions.size).toBe(0);
    expect(await purgeExpiredPhotos(f.store)).toMatchObject({
      deleted: 1,
      deferred: 0,
    });
    expect(f.rows.has(f.photo.id)).toBe(false);
    expect(f.persistence.suppressions.has(f.receipt)).toBe(true);
  });
  it('does not suppress a failed upload-cleanup intent that should be retryable', async () => {
    const f = fixture();
    await suppressSyncPhotoBeforeErase(f.store, {
      ...f.photo,
      kind: 'job',
      purpose: 'upload-cleanup',
    });
    expect(f.store.suppressSyncPhoto).not.toHaveBeenCalled();
  });
  it('rejects suppression under a different event owner', async () => {
    const f = fixture();
    await expect(
      f.billing.suppressFolderSyncPhoto({ ...f.photo, ownerId: 'other' }),
    ).rejects.toMatchObject({ code: 'SYNC_CLEANUP_PENDING' });
    expect(f.persistence.suppressions.size).toBe(0);
  });
  it('requires source authority to remain until photo cleanup is complete', async () => {
    const f = fixture();
    f.persistence.syncs.delete(f.sync.id);
    expect(await deletePhotoSafely(f.store, f.photo)).toBe('pending');
    expect(f.store.remove).not.toHaveBeenCalled();
  });
  it('acknowledges a suppressed source file without bytes, storage reservation or photo creation', async () => {
    const f = fixture();
    await deletePhotoSafely(f.store, f.photo);
    const access = vi.fn(),
      read = vi.fn(),
      commit = vi.fn(),
      reserve = vi.spyOn(f.billing, 'reserveStorage');
    const importer = createCloudPhotoImporter(
      f.store,
      { access },
      f.billing,
      {
        production: false,
        libraryPhotos: 20,
        eventPhotos: 20,
        events: 20,
        discoverPhotos: 20,
      },
      read,
      {
        assert: async () => {},
        suppressed: async () => f.persistence.suppressions.has(f.receipt),
        commit,
      },
    );
    const result = await importer(
      'owner',
      f.root.id,
      {
        provider: 'drive',
        generation: f.sync.generation,
        destinationEventId: f.sync.eventId,
        folderSyncId: f.sync.id,
      },
      'file-a',
      async () => {},
    );
    expect(result.id).toBe(f.root.id);
    expect(access).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(f.rows.has(f.photo.id)).toBe(false);
  });
});
