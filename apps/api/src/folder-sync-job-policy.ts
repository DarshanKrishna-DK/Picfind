import { ApiError } from './auth.js';
import type { FolderSync } from './folder-sync.js';
import type { JobRecord } from './jobs.js';
import { stableScanId } from './scan-photo-preparation.js';

/** Invoked inside the same database transaction that creates the job and manifest. */
export function assertSyncJobCreation(sync: FolderSync | null, job: JobRecord) {
  const source = job.importSource,
    pending = sync?.pending;
  const actual = [...job.photoIds].sort(),
    expected = [...(pending?.fileIds ?? [])].sort();
  if (
    !sync ||
    !source ||
    !pending ||
    sync.status !== 'active' ||
    sync.cleanupRequestedAt ||
    sync.consentPolicyVersion !== 'folder-sync-v1' ||
    job.type !== 'cloud-import' ||
    job.status !== 'queued' ||
    job.consentPolicyVersion !== 'cloud-import-v1' ||
    source.folderSyncId !== sync.id ||
    job.ownerId !== sync.ownerId ||
    source.destinationEventId !== sync.eventId ||
    source.provider !== sync.provider ||
    source.generation !== sync.generation ||
    (source.actorId ?? job.ownerId) !== sync.actorId ||
    source.membershipGrantId !== sync.membershipGrantId ||
    job.requestId !== (pending.attemptId ?? pending.requestId) ||
    job.eventId !==
      stableScanId('folder-sync-import', sync.id + ':' + pending.requestId) ||
    !expected.length ||
    expected.length > 50 ||
    actual.length !== expected.length ||
    actual.some((id, index) => id !== expected[index])
  ) {
    throw new ApiError(
      409,
      'SYNC_JOB_UNAVAILABLE',
      'This source changed or stopped before its import could be queued.',
    );
  }
}
