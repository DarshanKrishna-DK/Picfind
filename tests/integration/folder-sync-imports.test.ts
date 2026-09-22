import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/api/src/auth.js';
import { CloudImportWorker } from '../../apps/api/src/cloud-import-worker.js';
import {
  cloudPhotoId,
  type ImportPhoto,
} from '../../apps/api/src/cloud-photo-import.js';
import { createFolderSyncImportBridge } from '../../apps/api/src/folder-sync-imports.js';
import type { FolderSync } from '../../apps/api/src/folder-sync.js';
import { validImportSource } from '../../apps/api/src/import-policy.js';
import { JobQueue } from '../../apps/api/src/jobs.js';
import type {
  LibraryRecord,
  LibraryStore,
} from '../../apps/api/src/library.js';
import { TestJobStore } from '../helpers/job-store.js';

function fixture(moderator = false) {
  const isSuppressed = vi.fn(async () => false);
  const now = new Date().toISOString(),
    expiry = new Date(Date.now() + 86400000).toISOString();
  const sync: FolderSync = {
    id: randomUUID(),
    ownerId: 'owner',
    actorId: moderator ? 'moderator' : 'owner',
    eventId: randomUUID(),
    provider: 'drive',
    generation: randomUUID(),
    ...(moderator ? { membershipGrantId: randomUUID() } : {}),
    folderId: 'specific-folder',
    status: 'active',
    createdAt: now,
    nextRunAt: now,
    cursor: null,
    pages: 0,
    imported: 0,
    pending: {
      requestId: randomUUID(),
      fileIds: ['photo-a', 'photo-b'],
      nextCursor: null,
    },
  };
  const event: LibraryRecord = {
    id: sync.eventId,
    ownerId: sync.ownerId,
    kind: 'event',
    createdAt: now,
    expiresAt: expiry,
    members: moderator
      ? [
          {
            userId: sync.actorId,
            role: 'moderator',
            grantId: sync.membershipGrantId!,
            addedAt: now,
          },
        ]
      : [],
  };
  const rows = new Map<string, LibraryRecord>([[event.id, event]]);
  const store: LibraryStore = {
    get: async (id) => {
      const value = rows.get(id);
      if (!value) throw new ApiError(404, 'NOT_FOUND', 'Unavailable');
      return structuredClone(value);
    },
    list: async (owner, kind) =>
      [...rows.values()]
        .filter((row) => row.ownerId === owner && row.kind === kind)
        .map((row) => structuredClone(row)),
    put: vi.fn(async (row, create) => {
      if (create && rows.has(row.id))
        throw new ApiError(409, 'CONFLICT', 'Exists');
      rows.set(row.id, structuredClone(row));
    }),
    remove: async (id) => {
      rows.delete(id);
    },
    upload: vi.fn(async () => {}),
    removeFile: vi.fn(async () => {}),
    file: async () => new Response(),
  };
  const jobs = new TestJobStore(),
    queue = new JobQueue(jobs);
  const authorize = vi.fn(async () => ({ expiresAt: expiry }));
  // Synthetic transaction boundary. Live Appwrite publication is a separate gate.
  const publish = vi.fn(
    async (_sync: FolderSync, _root: LibraryRecord, photo: LibraryRecord) => {
      await store.put(photo);
      return photo;
    },
  );
  const bridge = createFolderSyncImportBridge({
    queue,
    store,
    syncs: {
      isSuppressed,
      get: async (id) => (id === sync.id ? structuredClone(sync) : undefined),
    },
    authorize,
    stage: async (_sync, root) => {
      await store.put(root, true);
      return root;
    },
    publish,
    limits: {
      production: false,
      libraryPhotos: 20,
      eventPhotos: 20,
      discoverPhotos: 20,
      events: 20,
    },
  });
  const guard = vi.fn(async () => {});
  const enqueue = () =>
    bridge.enqueue(
      structuredClone(sync),
      structuredClone(sync.pending!),
      guard,
    );
  const importPhoto = vi.fn<ImportPhoto>(
    async (owner, rootId, source, fileId, assertLease) => {
      await assertLease();
      const root = await store.get(rootId);
      await bridge.assert(owner, root, source, fileId);
      if (await bridge.suppressed(owner, root, source, fileId)) return root;
      return bridge.commit(owner, root, source, {
        id: cloudPhotoId(rootId, fileId),
        ownerId: owner,
        eventId: sync.eventId,
        importId: rootId,
        folderSyncId: sync.id,
        uploadedBy: sync.actorId,
        kind: 'photo',
        createdAt: now,
        expiresAt: expiry,
      });
    },
  );
  const worker = new CloudImportWorker(queue, store, importPhoto, bridge);
  return {
    isSuppressed,
    sync,
    event,
    rows,
    store,
    jobs,
    queue,
    bridge,
    authorize,
    publish,
    guard,
    enqueue,
    importPhoto,
    worker,
  };
}

describe('folder sync bridge to existing imports, synthetic persistence only', () => {
  it('acknowledges deleted source files without publishing photos or blocking the batch', async () => {
    const f = fixture();
    f.isSuppressed.mockResolvedValue(true);
    const batch = await f.enqueue();
    await f.worker.processNext();
    expect(await f.bridge.inspect(f.sync, batch)).toBe('complete');
    expect(f.publish).not.toHaveBeenCalled();
    expect(await f.store.list('owner', 'photo')).toHaveLength(0);
  });
  it.each([false, true])(
    'keeps event ownership and source actor separate (moderator=%s)',
    async (moderator) => {
      const f = fixture(moderator),
        batch = await f.enqueue();
      const job = await f.queue.owned(batch, 'owner'),
        root = await f.store.get(job.eventId);
      expect(job.importSource).toMatchObject({
        folderSyncId: f.sync.id,
        destinationEventId: f.event.id,
        generation: f.sync.generation,
      });
      expect(root).toMatchObject({
        ownerId: 'owner',
        uploadedBy: f.sync.actorId,
        eventId: f.event.id,
        folderSyncId: f.sync.id,
      });
      expect(await f.bridge.inspect(f.sync, batch)).toBe('running');
      await f.worker.processNext();
      expect(await f.bridge.inspect(f.sync, batch)).toBe('complete');
      expect(f.publish).toHaveBeenCalledTimes(2);
      expect(await f.store.list('owner', 'photo')).toHaveLength(2);
      expect(await f.store.list('moderator', 'photo')).toHaveLength(0);
    },
  );

  it('replays an ambiguous enqueue using the same manifest and root', async () => {
    const f = fixture();
    const original = f.queue.enqueue.bind(f.queue);
    vi.spyOn(f.queue, 'enqueue').mockImplementationOnce(async (input) => {
      await original(input);
      throw new Error('reply lost');
    });
    await expect(f.enqueue()).rejects.toThrow('reply lost');
    const batch = await f.enqueue();
    expect(f.jobs.rows.size).toBe(1);
    expect(await f.store.list('owner', 'job')).toHaveLength(1);
    expect(await f.bridge.inspect(f.sync, batch)).toBe('running');
  });

  it('binds the sync ID into the queue request fingerprint', async () => {
    const f = fixture(),
      batch = await f.enqueue(),
      job = await f.queue.owned(batch, 'owner');
    await expect(
      f.queue.enqueue({
        ownerId: job.ownerId,
        eventId: job.eventId,
        requestId: job.requestId,
        type: 'cloud-import',
        photoIds: job.photoIds,
        consentPolicyVersion: 'cloud-import-v1',
        importSource: { ...job.importSource!, folderSyncId: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'JOB_REQUEST_REUSED' });
  });

  it('does not allow sync identity on a personal import', () => {
    expect(
      validImportSource({
        provider: 'drive',
        generation: randomUUID(),
        folderSyncId: randomUUID(),
      }),
    ).toBe(false);
    expect(
      validImportSource({
        provider: 'drive',
        generation: randomUUID(),
        folderSyncId: 'invalid',
        destinationEventId: randomUUID(),
      }),
    ).toBe(false);
  });

  it('fails closed in a worker without sync authority', async () => {
    const f = fixture(),
      batch = await f.enqueue();
    await new CloudImportWorker(f.queue, f.store, f.importPhoto).processNext();
    expect(f.importPhoto).not.toHaveBeenCalled();
    expect(await f.queue.owned(batch, 'owner')).toMatchObject({
      status: 'failed',
      failureCode: 'EVENT_UNAVAILABLE',
    });
  });

  it.each(['paused', 'expired', 'attention'] as const)(
    'stops queued downloads when sync is %s',
    async (status) => {
      const f = fixture(),
        batch = await f.enqueue();
      f.sync.status = status;
      await f.worker.processNext();
      expect(f.importPhoto).not.toHaveBeenCalled();
      expect(await f.queue.owned(batch, 'owner')).toMatchObject({
        status: 'failed',
      });
    },
  );

  it('stops a queued moderator import after revocation', async () => {
    const f = fixture(true),
      batch = await f.enqueue();
    f.event.members = [];
    await f.worker.processNext();
    expect(f.importPhoto).not.toHaveBeenCalled();
    expect(await f.queue.owned(batch, 'owner')).toMatchObject({
      status: 'failed',
    });
  });

  it('does not publish after sync is disabled during an item', async () => {
    const f = fixture(),
      batch = await f.enqueue();
    f.importPhoto.mockImplementationOnce(async (owner, rootId, source) => {
      f.sync.status = 'paused';
      return f.bridge.commit(owner, await f.store.get(rootId), source, {
        id: cloudPhotoId(rootId, 'photo-a'),
        ownerId: owner,
        eventId: f.event.id,
        folderSyncId: f.sync.id,
        importId: rootId,
        uploadedBy: f.sync.actorId,
        kind: 'photo',
        createdAt: new Date().toISOString(),
      });
    });
    await f.worker.processNext();
    expect(f.publish).not.toHaveBeenCalled();
    expect(await f.queue.owned(batch, 'owner')).toMatchObject({
      status: 'failed',
    });
  });

  it('requires organizer/source authorization before enqueuing', async () => {
    const f = fixture();
    f.authorize.mockRejectedValueOnce(
      new ApiError(402, 'ORGANIZER_REQUIRED', 'Upgrade'),
    );
    await expect(f.enqueue()).rejects.toMatchObject({
      code: 'ORGANIZER_REQUIRED',
    });
    expect(f.jobs.rows.size).toBe(0);
    expect(await f.store.list('owner', 'job')).toHaveLength(0);
  });

  it('preserves the development photo cap without truncating a page', async () => {
    const f = fixture();
    f.sync.pending!.fileIds = Array.from(
      { length: 21 },
      (_, i) => `photo-${i}`,
    );
    await expect(f.enqueue()).rejects.toMatchObject({ code: 'PHOTO_LIMIT' });
    expect(f.jobs.rows.size).toBe(0);
  });

  it('rejects a file outside the persisted manifest', async () => {
    const f = fixture(),
      batch = await f.enqueue(),
      job = await f.queue.owned(batch, 'owner');
    await expect(
      f.bridge.assert(
        'owner',
        await f.store.get(job.eventId),
        job.importSource!,
        'another-file',
      ),
    ).rejects.toMatchObject({ code: 'IMPORT_UNAVAILABLE' });
  });

  it('rejects cross-event source reuse', async () => {
    const f = fixture(),
      batch = await f.enqueue(),
      job = await f.queue.owned(batch, 'owner');
    await expect(
      f.bridge.assert('owner', await f.store.get(job.eventId), {
        ...job.importSource!,
        destinationEventId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_UNAVAILABLE' });
  });

  it('does not acknowledge a completed job whose photos are missing', async () => {
    const f = fixture(),
      batch = await f.enqueue();
    await f.worker.processNext();
    const job = await f.queue.owned(batch, 'owner');
    f.rows.delete(cloudPhotoId(job.eventId, 'photo-a'));
    expect(await f.bridge.inspect(f.sync, batch)).toBe('attention');
  });

  it('does not acknowledge partial imports', async () => {
    const f = fixture(),
      batch = await f.enqueue();
    f.importPhoto.mockRejectedValueOnce(
      new ApiError(415, 'INVALID_IMAGE', 'Unsupported'),
    );
    await f.worker.processNext();
    expect(await f.bridge.inspect(f.sync, batch)).toBe('attention');
  });

  it('rejects completed photos from a different event', async () => {
    const f = fixture(),
      batch = await f.enqueue();
    await f.worker.processNext();
    const photo = (await f.store.list('owner', 'photo'))[0]!;
    f.rows.set(photo.id, { ...photo, eventId: randomUUID() });
    expect(await f.bridge.inspect(f.sync, batch)).toBe('attention');
  });
});
