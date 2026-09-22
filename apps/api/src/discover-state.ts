import { publicJob, type JobListEntry } from './jobs.js';
import type { LibraryRecord } from './library.js';
import { photoAvailable } from './retention.js';

export function discoverState(
  scan: LibraryRecord,
  photos: LibraryRecord[],
  jobs: JobListEntry[],
): LibraryRecord {
  if (scan.processingSource !== 'library') return scan;
  const job = jobs
    .filter(
      (row) =>
        row.ownerId === scan.ownerId &&
        row.eventId === scan.id &&
        row.type === 'discover-library',
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const prepared = photos.filter(
    (photo) => photo.scanId === scan.id && photoAvailable(photo),
  );
  const ready = prepared.filter((photo) => photo.indexState === 'ready');
  const active = job && ['queued', 'running'].includes(job.status);
  const errors = !job
    ? [
        'This request was not accepted by the processing queue. Retry the original selection, or delete this incomplete search and start again.',
      ]
    : job.failureCode
      ? [
          job.failureCode === 'QUOTA_EXHAUSTED'
            ? 'Processing paused at your allowance or storage limit. Resolve the limit, then resume.'
            : job.failureCode === 'RETRY_UNCERTAIN_REQUIRED' ||
                job.failureCode === 'INTERRUPTED'
              ? 'Processing stopped with an uncertain outcome. Review and explicitly approve any new paid attempt before resuming.'
              : 'Processing stopped. Check the source photos, then resume remaining work.',
        ]
      : [];
  return {
    ...scan,
    imported: prepared.length,
    indexed: ready.length,
    state: active
      ? 'running'
      : ready.length
        ? job?.status === 'complete'
          ? 'complete'
          : 'partial'
        : 'failed',
    errors,
    matches: [],
    ...(job ? { processing: publicJob(job) } : {}),
  };
}
export function publicScan(scan: LibraryRecord, visible?: Set<string>) {
  return {
    id: scan.id,
    state: scan.state,
    imported: scan.imported ?? 0,
    indexed: scan.indexed ?? 0,
    errors: scan.errors ?? [],
    createdAt: scan.createdAt,
    provider: scan.provider,
    modelVersion: scan.modelVersion,
    consentPolicyVersion: scan.consentPolicyVersion,
    matches: (scan.matches ?? []).filter(
      (match) => !visible || visible.has(match.photoId),
    ),
    ...(scan.processingSource
      ? {
          requestId: scan.processingRequestId,
          resultsRetained: false,
          deleting: Boolean(scan.deletionStartedAt),
          processing: scan.processing,
        }
      : {}),
  };
}
