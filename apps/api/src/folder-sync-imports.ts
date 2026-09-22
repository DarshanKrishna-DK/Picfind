import { createHash } from 'node:crypto';
import { ApiError } from './auth.js';
import { libraryCapacity } from './capacity.js';
import { cloudPhotoId } from './cloud-photo-import.js';
import { assertImportActor } from './cloud-import-access.js';
import { assertEventImportOpen } from './event-import-policy.js';
import type {
  FolderSync,
  FolderSyncPorts,
  FolderSyncStore,
} from './folder-sync.js';
import { SYNC_PAGE_SIZE } from './folder-sync.js';
import { validImportFileId, type ImportSource } from './import-policy.js';
import type { JobQueue, JobRecord } from './jobs.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { photoAvailable } from './retention.js';
import { stableScanId } from './scan-photo-preparation.js';

export interface FolderSyncImportAuthority {
  suppressed(
    owner: string,
    root: LibraryRecord,
    source: ImportSource,
    fileId: string,
  ): Promise<boolean>;
  assert(
    owner: string,
    root: LibraryRecord,
    source: ImportSource,
    fileId?: string,
  ): Promise<void>;
  /** Must atomically read/touch sync, event and billing authority with photo publication. */
  commit(
    owner: string,
    root: LibraryRecord,
    source: ImportSource,
    photo: LibraryRecord,
  ): Promise<LibraryRecord>;
}
const unavailable = () =>
  new ApiError(
    409,
    'IMPORT_UNAVAILABLE',
    'This automatic folder import is no longer authorized.',
  );
const importId = (sync: FolderSync, requestId: string) =>
  stableScanId('folder-sync-import', sync.id + ':' + requestId);
const sourceFor = (sync: FolderSync): ImportSource => ({
  provider: sync.provider,
  generation: sync.generation,
  destinationEventId: sync.eventId,
  folderSyncId: sync.id,
  ...(sync.actorId !== sync.ownerId
    ? { actorId: sync.actorId, membershipGrantId: sync.membershipGrantId! }
    : {}),
});
const sameIds = (left: string[], right: string[]) =>
  left.length === right.length &&
  [...left].sort().every((id, i) => id === [...right].sort()[i]);

/** Adapter to the existing queue; it does not start a scheduler or enable sync. */
export function createFolderSyncImportBridge(options: {
  queue: JobQueue;
  store: LibraryStore;
  syncs: Pick<FolderSyncStore, 'get'> & {
    isSuppressed(sync: FolderSync, fileId: string): Promise<boolean>;
  };
  authorize: FolderSyncPorts['authorize'];
  stage(sync: FolderSync, root: LibraryRecord): Promise<LibraryRecord>;
  /** Required transaction implementation; no ordinary store.put fallback is allowed. */
  publish: (
    sync: FolderSync,
    root: LibraryRecord,
    photo: LibraryRecord,
  ) => Promise<LibraryRecord>;
  limits?: ReturnType<typeof libraryCapacity>;
}): Pick<FolderSyncPorts, 'enqueue' | 'inspect'> & FolderSyncImportAuthority {
  const limits = options.limits ?? libraryCapacity();
  async function current(id: string) {
    const sync = await options.syncs.get(id);
    if (!sync || sync.status !== 'active' || !sync.pending) throw unavailable();
    const allowed = await options.authorize(sync);
    if (
      !Number.isFinite(Date.parse(allowed.expiresAt)) ||
      Date.parse(allowed.expiresAt) <= Date.now()
    )
      throw unavailable();
    const event = await options.store.get(sync.eventId);
    if (event.ownerId !== sync.ownerId) throw unavailable();
    assertEventImportOpen(event);
    return { sync, event };
  }
  async function bound(
    owner: string,
    root: LibraryRecord,
    source: ImportSource,
    fileId?: string,
  ) {
    if (!source.folderSyncId) throw unavailable();
    const { sync, event } = await current(source.folderSyncId);
    if (
      sync.ownerId !== owner ||
      root.ownerId !== owner ||
      root.kind !== 'job' ||
      root.purpose !== 'import' ||
      root.processingSource !== 'cloud' ||
      root.deletionStartedAt ||
      root.folderSyncId !== sync.id ||
      root.id !== importId(sync, sync.pending!.requestId) ||
      root.processingRequestId !==
        (sync.pending!.attemptId ?? sync.pending!.requestId) ||
      root.eventId !== sync.eventId ||
      root.source !== sync.provider ||
      source.provider !== sync.provider ||
      source.generation !== sync.generation ||
      source.destinationEventId !== sync.eventId ||
      (source.actorId ?? owner) !== sync.actorId ||
      source.membershipGrantId !== sync.membershipGrantId ||
      (fileId !== undefined && !sync.pending!.fileIds.includes(fileId))
    )
      throw unavailable();
    assertImportActor(source, root, event);
    if (
      fileId !== undefined &&
      (await options.syncs.isSuppressed(sync, fileId))
    )
      return sync;
    if (
      fileId !== undefined &&
      sync.pending!.preservedFileIndexes?.includes(
        sync.pending!.fileIds.indexOf(fileId),
      )
    ) {
      let preserved;
      try {
        preserved = await options.store.get(cloudPhotoId(root.id, fileId));
      } catch {
        throw new ApiError(
          409,
          'IMPORT_STORAGE_INVALID',
          'A previously imported photo is unavailable. It will not be copied again automatically.',
        );
      }
      if (
        preserved.kind !== 'photo' ||
        preserved.ownerId !== owner ||
        preserved.eventId !== sync.eventId ||
        preserved.importId !== root.id ||
        preserved.folderSyncId !== sync.id ||
        !photoAvailable(preserved)
      )
        throw new ApiError(
          409,
          'IMPORT_STORAGE_INVALID',
          'A previously imported photo is unavailable. It will not be copied again automatically.',
        );
    }
    return sync;
  }
  async function checkedJob(
    sync: FolderSync,
    batchId: string,
  ): Promise<JobRecord> {
    const job = await options.queue.owned(batchId, sync.ownerId);
    if (
      job.type !== 'cloud-import' ||
      !job.importSource ||
      !sync.pending ||
      (sync.pending.batchId && sync.pending.batchId !== batchId) ||
      job.requestId !== (sync.pending.attemptId ?? sync.pending.requestId) ||
      !sameIds(job.photoIds, sync.pending.fileIds)
    )
      throw unavailable();
    const root = await options.store.get(job.eventId);
    await bound(sync.ownerId, root, job.importSource);
    return job;
  }
  return {
    async suppressed(owner, root, source, fileId) {
      const sync = await bound(owner, root, source, fileId);
      return options.syncs.isSuppressed(sync, fileId);
    },
    async assert(owner, root, source, fileId) {
      await bound(owner, root, source, fileId);
    },
    async commit(owner, root, source, photo) {
      const sync = await bound(owner, root, source);
      if (
        photo.ownerId !== owner ||
        photo.importId !== root.id ||
        photo.eventId !== sync.eventId ||
        photo.folderSyncId !== sync.id ||
        photo.uploadedBy !== sync.actorId ||
        photo.kind !== 'photo' ||
        photo.scanId ||
        !sync.pending!.fileIds.some(
          (id) => cloudPhotoId(root.id, id) === photo.id,
        )
      )
        throw unavailable();
      return options.publish(sync, root, photo);
    },
    async enqueue(snapshot, pending, guard) {
      return withAccountLock(snapshot.ownerId, async () => {
        await guard();
        const { sync } = await current(snapshot.id);
        if (
          sync.ownerId !== snapshot.ownerId ||
          sync.pending!.requestId !== pending.requestId ||
          sync.pending!.attemptId !== pending.attemptId ||
          !sameIds(sync.pending!.fileIds, pending.fileIds) ||
          !pending.fileIds.length ||
          pending.fileIds.length > SYNC_PAGE_SIZE ||
          new Set(pending.fileIds).size !== pending.fileIds.length ||
          pending.fileIds.some((id) => !validImportFileId(id))
        )
          throw unavailable();
        const id = importId(sync, pending.requestId),
          source = sourceFor(sync);
        const fingerprint = createHash('sha256')
          .update(JSON.stringify([source, [...pending.fileIds].sort()]))
          .digest('hex');
        let root: LibraryRecord | undefined;
        try {
          root = await options.store.get(id);
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
        if (root) {
          await bound(sync.ownerId, root, source);
          if (root.sourceFingerprint !== fingerprint) throw unavailable();
        } else {
          const photos = await options.store.list(sync.ownerId, 'photo');
          const room = Math.min(
            limits.libraryPhotos - photos.length,
            limits.eventPhotos -
              photos.filter(
                (row) => row.eventId === sync.eventId && !row.scanId,
              ).length,
          );
          if (pending.fileIds.length > room)
            throw new ApiError(
              402,
              'PHOTO_LIMIT',
              'This event or account has reached its photo allowance.',
            );
          root = {
            id,
            ownerId: sync.ownerId,
            uploadedBy: sync.actorId,
            kind: 'job',
            purpose: 'import',
            processingSource: 'cloud',
            source: sync.provider,
            folderSyncId: sync.id,
            eventId: sync.eventId,
            ...(sync.membershipGrantId
              ? { membershipGrantId: sync.membershipGrantId }
              : {}),
            processingRequestId: pending.attemptId ?? pending.requestId,
            sourceFingerprint: fingerprint,
            createdAt: new Date().toISOString(),
            state: 'running',
            imported: 0,
            errors: [],
          };
          await guard();
          root = await options.stage(sync, root);
        }
        await guard();
        await bound(sync.ownerId, root, source);
        const job = await options.queue.enqueue({
          ownerId: sync.ownerId,
          eventId: id,
          requestId: pending.attemptId ?? pending.requestId,
          type: 'cloud-import',
          importSource: source,
          photoIds: pending.fileIds,
          consentPolicyVersion: 'cloud-import-v1',
        });
        return job.id;
      });
    },
    async inspect(snapshot, batchId) {
      const { sync } = await current(snapshot.id);
      if (sync.ownerId !== snapshot.ownerId) throw unavailable();
      const job = await checkedJob(sync, batchId);
      if (job.cancelRequestedAt) return 'attention';
      if (job.status === 'queued' || job.status === 'running') return 'running';
      if (
        job.status !== 'complete' ||
        job.failed ||
        job.cursor !== sync.pending!.fileIds.length ||
        job.imported !== sync.pending!.fileIds.length
      )
        return 'attention';
      for (const id of sync.pending!.fileIds) {
        if (await options.syncs.isSuppressed(sync, id)) continue;
        let photo: LibraryRecord;
        try {
          photo = await options.store.get(cloudPhotoId(job.eventId, id));
        } catch (error) {
          if (error instanceof ApiError && error.status === 404)
            return 'attention';
          throw error;
        }
        if (
          photo.kind !== 'photo' ||
          photo.ownerId !== sync.ownerId ||
          photo.eventId !== sync.eventId ||
          photo.importId !== job.eventId ||
          photo.folderSyncId !== sync.id ||
          photo.uploadedBy !== sync.actorId ||
          photo.scanId ||
          !photoAvailable(photo)
        )
          return 'attention';
      }
      return 'complete';
    },
  };
}
