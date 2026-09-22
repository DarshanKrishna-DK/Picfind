import { createHash } from 'node:crypto';
import { ApiError } from './auth.js';
import { cloudPhotoId } from './cloud-photo-import.js';
import type { FolderSync } from './folder-sync.js';
import type { JobQueue, JobRecord } from './jobs.js';
import type { LibraryStore } from './library.js';
import { photoAvailable } from './retention.js';
import { stableScanId } from './scan-photo-preparation.js';

const invalid = () =>
  new ApiError(
    409,
    'SYNC_RECOVERY_REQUIRED',
    'This saved batch needs recovery before it can resume. No photos were copied.',
  );
const jobId = (owner: string, root: string, request: string) =>
  createHash('sha256')
    .update(`${owner}:${root}:${request}`)
    .digest('hex')
    .slice(0, 36);
export interface FolderSyncRecovery {
  preservedFileIndexes: number[];
  rootRequired: boolean;
}
export async function prepareFolderSyncResume(
  sync: FolderSync,
  requestId: string,
  store: LibraryStore,
  queue: Pick<JobQueue, 'owned' | 'cancel'>,
  isSuppressed: (sync: FolderSync, fileId: string) => Promise<boolean>,
) {
  const pending = sync.pending;
  if (!pending) return { preservedFileIndexes: [], rootRequired: false };
  const rootId = stableScanId(
    'folder-sync-import',
    sync.id + ':' + pending.requestId,
  );
  const attempt = pending.attemptId ?? pending.requestId;
  if (attempt === requestId)
    throw new ApiError(
      409,
      'SYNC_REQUEST_REUSED',
      'Use a new resume request identifier.',
    );
  try {
    await queue.owned(jobId(sync.ownerId, rootId, requestId), sync.ownerId);
    throw new ApiError(
      409,
      'SYNC_REQUEST_REUSED',
      'This resume request was already used for an earlier attempt.',
    );
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
  let job: JobRecord | undefined;
  try {
    job = await queue.owned(
      pending.batchId ?? jobId(sync.ownerId, rootId, attempt),
      sync.ownerId,
    );
  } catch (error) {
    if (!(
      error instanceof ApiError &&
      error.status === 404 &&
      !pending.batchId
    ))
      throw error;
  }
  const completed = new Set(pending.preservedFileIndexes ?? []);
  if (job) {
    const source = job.importSource;
    if (
      job.type !== 'cloud-import' ||
      job.eventId !== rootId ||
      job.requestId !== attempt ||
      source?.folderSyncId !== sync.id ||
      source.provider !== sync.provider ||
      source.generation !== sync.generation ||
      source.destinationEventId !== sync.eventId ||
      (source.actorId ?? sync.ownerId) !== sync.actorId ||
      source.membershipGrantId !== sync.membershipGrantId ||
      JSON.stringify(job.photoIds) !== JSON.stringify(pending.fileIds)
    )
      throw invalid();
    if (job.status === 'queued' || job.status === 'running')
      job = await queue.cancel(job.id, sync.ownerId);
    if (job.status === 'queued' || job.status === 'running')
      throw new ApiError(
        409,
        'SYNC_IMPORT_ACTIVE',
        'Wait for the paused import worker to finish stopping, then resume.',
      );
    const failed = new Set(job.failedPhotoIds);
    const processedIds = new Set(job.photoIds.slice(0, job.cursor));
    if (
      job.failedPhotoIdsTruncated ||
      failed.size !== job.failed ||
      job.cursor < 0 ||
      job.cursor > pending.fileIds.length ||
      job.imported !== job.cursor - job.failed ||
      [...failed].some((id) => !processedIds.has(id))
    )
      throw invalid();
    for (let index = 0; index < job.cursor; index++)
      if (!failed.has(pending.fileIds[index]!)) completed.add(index);
  }
  for (let index = 0; index < pending.fileIds.length; index++) {
    const fileId = pending.fileIds[index]!;
    if (await isSuppressed(sync, fileId)) {
      completed.delete(index);
      continue;
    }
    let photo;
    try {
      photo = await store.get(cloudPhotoId(rootId, fileId));
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    if (!photo) {
      if (completed.has(index)) throw invalid();
      continue;
    }
    if (
      photo.kind !== 'photo' ||
      photo.ownerId !== sync.ownerId ||
      photo.eventId !== sync.eventId ||
      photo.importId !== rootId ||
      photo.folderSyncId !== sync.id ||
      photo.uploadedBy !== sync.actorId ||
      photo.scanId ||
      !photoAvailable(photo) ||
      photo.sourcePhotoId !==
        stableScanId('cloud-import-source', sync.provider + ':' + fileId)
    )
      throw invalid();
    completed.add(index);
  }
  let root;
  try {
    root = await store.get(rootId);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
  if (!root && (job || completed.size)) throw invalid();
  return {
    preservedFileIndexes: [...completed].sort((a, b) => a - b),
    rootRequired: Boolean(root),
  };
}
