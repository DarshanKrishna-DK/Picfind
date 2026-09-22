import { randomUUID } from 'node:crypto';
import { ApiError } from './auth.js';
import type { ImportPhoto } from './cloud-photo-import.js';
import type { JobQueue, JobRecord } from './jobs.js';
import type { LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { assertEventImportOpen } from './event-import-policy.js';
import { assertImportActor } from './cloud-import-access.js';
import type { FolderSyncImportAuthority } from './folder-sync-imports.js';

export class CloudImportWorker {
  private readonly id = randomUUID();
  private active = false;
  private stopping = false;
  constructor(
    private readonly queue: JobQueue,
    private readonly store: LibraryStore,
    private readonly importPhoto: ImportPhoto,
    private readonly syncImports?: FolderSyncImportAuthority,
    private readonly assertAccounts?: (
      owner: string,
      actor: string,
    ) => Promise<void>,
  ) {}
  stop() {
    this.stopping = true;
  }
  async processNext(): Promise<boolean> {
    if (this.active || this.stopping) return false;
    this.active = true;
    try {
      const job = await this.queue.claim(this.id, ['cloud-import']);
      if (!job) return false;
      const token = job.leaseToken!;
      let leaseLost = false,
        beating = false;
      let heartbeat: Promise<void> | undefined;
      const timer = setInterval(
        () => {
          if (beating) return;
          beating = true;
          heartbeat = this.queue
            .heartbeat(job.id, token)
            .catch(() => {
              leaseLost = true;
            })
            .finally(() => {
              beating = false;
            });
        },
        Math.floor(this.queue.leaseMs / 3),
      );
      timer.unref();
      try {
        while (!this.stopping && !leaseLost) {
          const again = await withAccountLock(job.ownerId, async () => {
            const current = await this.queue.owned(job.id, job.ownerId);
            if (current.status !== 'running' || current.cancelRequestedAt)
              return false;
            const assertLease = async () => {
              const state = await this.queue.owned(job.id, job.ownerId);
              if (
                leaseLost ||
                state.status !== 'running' ||
                state.leaseToken !== token ||
                !state.leaseUntil ||
                Date.parse(state.leaseUntil) <= Date.now()
              )
                throw new ApiError(
                  409,
                  'JOB_LEASE_LOST',
                  'This import worker no longer owns the job.',
                );
              if (this.assertAccounts)
                await this.assertAccounts(
                  job.ownerId,
                  job.importSource?.actorId ?? job.ownerId,
                );
              let root;
              try {
                root = await this.store.get(job.eventId);
              } catch (error) {
                if (error instanceof ApiError && error.status === 404)
                  throw new ApiError(
                    409,
                    'IMPORT_UNAVAILABLE',
                    'This import is no longer available.',
                  );
                throw error;
              }
              if (
                root.ownerId !== job.ownerId ||
                root.kind !== 'job' ||
                root.purpose !== 'import' ||
                root.processingSource !== 'cloud' ||
                root.processingRequestId !== job.requestId ||
                !job.importSource ||
                root.eventId !== job.importSource.destinationEventId ||
                root.source !== job.importSource.provider ||
                root.deletionStartedAt
              )
                throw new ApiError(
                  409,
                  'IMPORT_UNAVAILABLE',
                  'This import is no longer available.',
                );
              if (job.importSource.destinationEventId) {
                let event;
                try {
                  event = await this.store.get(
                    job.importSource.destinationEventId,
                  );
                } catch (error) {
                  if (error instanceof ApiError && error.status === 404)
                    throw new ApiError(
                      409,
                      'EVENT_UNAVAILABLE',
                      'This event is no longer available.',
                    );
                  throw error;
                }
                if (event.ownerId !== job.ownerId)
                  throw new ApiError(
                    409,
                    'EVENT_UNAVAILABLE',
                    'This event is no longer available.',
                  );
                assertEventImportOpen(event);
                assertImportActor(job.importSource, root, event);
              } else {
                assertImportActor(job.importSource, root);
              }
              if (job.importSource.folderSyncId) {
                if (!this.syncImports)
                  throw new ApiError(
                    409,
                    'IMPORT_UNAVAILABLE',
                    'Automatic folder imports are not configured.',
                  );
                await this.syncImports.assert(
                  job.ownerId,
                  root,
                  job.importSource,
                );
              }
            };
            let outcome: 'imported' | 'failed' = 'imported';
            try {
              await assertLease();
              const fileId = await this.queue.beginItem(job.id, token);
              if (!job.importSource)
                throw new ApiError(
                  409,
                  'IMPORT_UNAVAILABLE',
                  'This import has no source connection.',
                );
              await this.importPhoto(
                job.ownerId,
                job.eventId,
                job.importSource,
                fileId,
                assertLease,
              );
            } catch (error) {
              if (
                leaseLost ||
                (error instanceof ApiError && error.code === 'JOB_LEASE_LOST')
              )
                return false;
              const code = this.failureCode(error);
              if (code) {
                await this.queue.fail(job.id, token, code);
                return false;
              }
              // Only bad/missing individual files are skipped. Infrastructure errors
              // pause the batch instead of rapidly burning through every source ID.
              if (!(
                error instanceof ApiError &&
                ([404, 413, 415, 422].includes(error.status) ||
                  error.code === 'INVALID_IMAGE')
              )) {
                await this.queue.fail(job.id, token, 'SOURCE_UNAVAILABLE');
                return false;
              }
              outcome = 'failed';
            }
            for (let attempt = 0; attempt < 3; attempt++) {
              if (leaseLost) return false;
              try {
                const saved = await this.queue.finishItem(
                  job.id,
                  token,
                  outcome,
                  current.cursor,
                );
                return saved.status === 'running';
              } catch (error) {
                if (
                  attempt === 2 ||
                  (error instanceof ApiError &&
                    [401, 404, 409].includes(error.status))
                )
                  throw error;
              }
            }
            return false;
          });
          if (!again) break;
        }
      } catch (error) {
        if (!(
          error instanceof ApiError && [401, 404, 409].includes(error.status)
        ))
          throw error;
      } finally {
        clearInterval(timer);
        await heartbeat;
      }
      return true;
    } finally {
      this.active = false;
    }
  }
  private failureCode(
    error: unknown,
  ): NonNullable<JobRecord['failureCode']> | undefined {
    if (!(error instanceof ApiError)) return 'SOURCE_UNAVAILABLE';
    if (error.status === 402 || error.code === 'PHOTO_LIMIT')
      return 'QUOTA_EXHAUSTED';
    if (
      [
        'SOURCE_RECONNECT_REQUIRED',
        'SOURCE_CONNECTION_CHANGED',
        'SOURCE_REFRESH_PENDING',
      ].includes(error.code)
    )
      return 'SOURCE_UNAVAILABLE';
    if (
      [
        'EVENT_UNAVAILABLE',
        'IMPORT_UNAVAILABLE',
        'IMPORT_STORAGE_INVALID',
        'ACCOUNT_DELETION_PENDING',
        'IMPORT_ACCOUNT_UNAVAILABLE',
      ].includes(error.code)
    )
      return 'EVENT_UNAVAILABLE';
    if (
      ['UPLOAD_RECOVERY_REQUIRED', 'USAGE_ACCOUNTING_UNAVAILABLE'].includes(
        error.code,
      )
    )
      return 'PROCESSING_FAILED';
    return undefined;
  }
}
