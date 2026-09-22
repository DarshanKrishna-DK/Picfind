import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/api/src/auth.js';
import {
  FolderSyncCleanup,
  type FolderSyncCleanupStore,
} from '../../apps/api/src/folder-sync-cleanup.js';
import type { FolderSync } from '../../apps/api/src/folder-sync.js';
import type { JobQueue } from '../../apps/api/src/jobs.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';

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
    status: 'active',
    createdAt: now,
    nextRunAt: now,
    cursor: null,
    pages: 0,
    imported: 0,
  };
  const sources = new Map([[sync.id, sync]]);
  const records = new Map<string, LibraryRecord>([
    [
      sync.eventId,
      {
        id: sync.eventId,
        ownerId: 'owner',
        kind: 'event',
        createdAt: now,
        archived: true,
      },
    ],
  ]);
  const purgePage = vi.fn(async (row: FolderSync) => {
    sources.delete(row.id);
    return true;
  });
  const redactActor = vi
    .fn<(row: FolderSync) => Promise<void>>()
    .mockResolvedValue(undefined);
  const directory: FolderSyncCleanupStore = {
    candidates: vi.fn(),
    knownFiles: vi.fn(),
    isSuppressed: vi.fn(),
    get: async (id) => sources.get(id),
    listEvent: async (owner, eventId) =>
      [...sources.values()].filter(
        (row) => row.ownerId === owner && row.eventId === eventId,
      ),
    listOwner: async (owner) =>
      [...sources.values()].filter((row) => row.ownerId === owner),
    listActor: async (actor) =>
      [...sources.values()].filter((row) => row.actorId === actor),
    async mutate(id, update) {
      const changed = update(sources.get(id));
      if (changed.record) sources.set(id, changed.record);
      return changed.result;
    },
    purgePage,
    redactActor,
  };
  const library: LibraryStore = {
    get: async (id) => {
      const row = records.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Missing');
      return row;
    },
    list: async (owner, kind) =>
      [...records.values()].filter(
        (row) => row.ownerId === owner && row.kind === kind,
      ),
    put: vi.fn(),
    remove: vi.fn(),
    expired: vi.fn(),
    upload: vi.fn(),
    file: vi.fn(),
    removeFile: vi.fn(),
  };
  const list = vi.fn<JobQueue['list']>().mockResolvedValue([]);
  const cancel = vi.fn<JobQueue['cancel']>();
  const assertDeleting = vi
    .fn<(owner: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const eraseSource = vi.fn(async () => {});
  const cleanup = new FolderSyncCleanup(
    directory,
    library,
    { list, cancel, eraseSource },
    assertDeleting,
  );
  return {
    cleanup,
    sync,
    sources,
    records,
    purgePage,
    redactActor,
    list,
    eraseSource,
    cancel,
    assertDeleting,
  };
}

describe('folder sync event/account cleanup, no cloud calls', () => {
  it('retains source receipts until queued-file metadata has been erased', async () => {
    const f = fixture();
    await f.cleanup.stopEvent('owner', f.sync.eventId);
    f.eraseSource.mockRejectedValueOnce(new Error('Queue unavailable'));
    await expect(
      f.cleanup.finishEvent('owner', f.sync.eventId),
    ).rejects.toThrow('Queue unavailable');
    expect(f.purgePage).not.toHaveBeenCalled();
    expect(f.sources.has(f.sync.id)).toBe(true);
    await f.cleanup.finishEvent('owner', f.sync.eventId);
    expect(f.eraseSource).toHaveBeenCalledWith('owner', f.sync.id);
    expect(f.sources.has(f.sync.id)).toBe(false);
  });
  it('does not redact a contributor source before its private queue manifests are erased', async () => {
    const f = fixture();
    f.sources.set(f.sync.id, { ...f.sync, actorId: 'moderator' });
    await f.cleanup.stopAccount('moderator');
    f.eraseSource.mockRejectedValueOnce(new Error('Queue unavailable'));
    await expect(f.cleanup.continueSource(f.sync.id)).rejects.toThrow(
      'Queue unavailable',
    );
    expect(f.redactActor).not.toHaveBeenCalled();
    expect(await f.cleanup.continueSource(f.sync.id)).toBe('redacted');
    expect(f.eraseSource).toHaveBeenCalledWith('owner', f.sync.id);
  });
  it('continues partial event receipt cleanup without another HTTP deletion request', async () => {
    const f = fixture();
    await f.cleanup.stopEvent('owner', f.sync.eventId);
    f.purgePage.mockResolvedValueOnce(false);
    expect(await f.cleanup.continueSource(f.sync.id)).toBe('progress');
    expect(await f.cleanup.continueSource(f.sync.id)).toBe('complete');
    expect(f.sources.has(f.sync.id)).toBe(false);
  });
  it('does not require an open event to close when continuing account-owner erasure', async () => {
    const f = fixture();
    f.records.get(f.sync.eventId)!.archived = false;
    await f.cleanup.stopAccount('owner');
    expect(f.sources.get(f.sync.id)?.cleanupAccountId).toBe('owner');
    expect(await f.cleanup.continueSource(f.sync.id)).toBe('complete');
    expect(f.assertDeleting).toHaveBeenCalledTimes(2);
  });
  it('continues moderator redaction without purging organizer photos', async () => {
    const f = fixture();
    f.sources.set(f.sync.id, { ...f.sync, actorId: 'moderator' });
    f.records.set('retained', {
      id: 'retained',
      ownerId: 'owner',
      kind: 'photo',
      createdAt: f.sync.createdAt,
      folderSyncId: f.sync.id,
    });
    await f.cleanup.stopAccount('moderator');
    expect(await f.cleanup.continueSource(f.sync.id)).toBe('redacted');
    expect(f.purgePage).not.toHaveBeenCalled();
    expect(f.records.has('retained')).toBe(true);
  });
  it('upgrades moderator cleanup to source erasure when the owner deletes the event', async () => {
    const f = fixture();
    f.sources.set(f.sync.id, { ...f.sync, actorId: 'moderator' });
    await f.cleanup.stopAccount('moderator');
    await f.cleanup.stopEvent('owner', f.sync.eventId);
    expect(f.sources.get(f.sync.id)?.cleanupAccountId).toBeUndefined();
    expect(await f.cleanup.continueSource(f.sync.id)).toBe('complete');
    expect(f.redactActor).not.toHaveBeenCalled();
  });
  it('requires an event deletion or expiry fence before stopping sources', async () => {
    const f = fixture();
    f.records.get(f.sync.eventId)!.archived = false;
    await expect(
      f.cleanup.stopEvent('owner', f.sync.eventId),
    ).rejects.toMatchObject({ code: 'SYNC_CLEANUP_PENDING' });
    expect(f.sources.get(f.sync.id)?.status).toBe('active');
    expect(f.list).not.toHaveBeenCalled();
  });
  it('stops every source before inspecting queued work', async () => {
    const f = fixture();
    const second = { ...f.sync, id: randomUUID() };
    f.sources.set(second.id, second);
    f.list.mockImplementation(async () => {
      expect(
        [...f.sources.values()].every(
          (row) => row.status === 'expired' && row.cleanupRequestedAt,
        ),
      ).toBe(true);
      return [];
    });
    await f.cleanup.stopEvent('owner', f.sync.eventId);
    expect(f.list).toHaveBeenCalledOnce();
    expect(f.purgePage).not.toHaveBeenCalled();
  });
  it.each(['photo', 'upload-cleanup'] as const)(
    'retains receipts while %s cleanup remains',
    async (kind) => {
      const f = fixture();
      await f.cleanup.stopEvent('owner', f.sync.eventId);
      f.records.set('remaining', {
        id: 'remaining',
        ownerId: 'owner',
        createdAt: f.sync.createdAt,
        kind: kind === 'photo' ? 'photo' : 'job',
        ...(kind === 'upload-cleanup'
          ? { purpose: 'upload-cleanup' as const }
          : {}),
        folderSyncId: f.sync.id,
      });
      await expect(
        f.cleanup.finishEvent('owner', f.sync.eventId),
      ).rejects.toMatchObject({ code: 'SYNC_CLEANUP_PENDING' });
      expect(f.purgePage).not.toHaveBeenCalled();
    },
  );
  it('allows another bounded cleanup attempt without deleting unrelated sources', async () => {
    const f = fixture();
    const other = { ...f.sync, id: randomUUID(), eventId: randomUUID() };
    f.sources.set(other.id, other);
    await f.cleanup.stopEvent('owner', f.sync.eventId);
    f.purgePage.mockResolvedValueOnce(false);
    await expect(
      f.cleanup.finishEvent('owner', f.sync.eventId),
    ).rejects.toMatchObject({ code: 'SYNC_CLEANUP_PENDING' });
    await f.cleanup.finishEvent('owner', f.sync.eventId);
    expect(f.sources.has(f.sync.id)).toBe(false);
    expect(f.sources.get(other.id)?.status).toBe('active');
  });
  it('requires account deletion authorization before touching either ownership path', async () => {
    const f = fixture();
    f.assertDeleting.mockRejectedValue(
      new ApiError(409, 'ACCOUNT_DELETION_REQUIRED', 'Not deleting'),
    );
    await expect(f.cleanup.stopAccount('owner')).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_REQUIRED',
    });
    await expect(f.cleanup.finishAccount('owner')).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_REQUIRED',
    });
    expect(f.sources.get(f.sync.id)?.status).toBe('active');
    expect(f.purgePage).not.toHaveBeenCalled();
  });
  it('redacts foreign event connections without erasing organizer photos or suppression records', async () => {
    const f = fixture();
    const foreign = {
      ...f.sync,
      id: randomUUID(),
      ownerId: 'organizer',
      eventId: randomUUID(),
    };
    f.sources.set(foreign.id, foreign);
    f.records.set('photo', {
      id: 'photo',
      ownerId: 'organizer',
      kind: 'photo',
      createdAt: f.sync.createdAt,
      folderSyncId: foreign.id,
    });
    await f.cleanup.stopAccount('owner');
    await f.cleanup.finishAccount('owner');
    expect(f.sources.has(f.sync.id)).toBe(false);
    expect(f.sources.get(foreign.id)?.status).toBe('expired');
    expect(f.redactActor).toHaveBeenCalledWith(
      expect.objectContaining({ id: foreign.id }),
    );
    expect(f.purgePage).toHaveBeenCalledTimes(1);
    expect(f.records.has('photo')).toBe(true);
  });
});
