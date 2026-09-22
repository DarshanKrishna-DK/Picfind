import { randomUUID } from 'node:crypto';
import type { FaceMatchingProvider } from '../../../packages/shared/src/ports.js';
import { ApiError } from './auth.js';
import type { PhotoIndexer } from './face-indexing.js';
import type { ItemOutcome, JobQueue } from './jobs.js';
import type { LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { startAdaptivePoller } from './processing-poller.js';
import type { ScanPhotoPreparer } from './scan-photo-preparation.js';

export class EventIndexWorker {
  private readonly id = randomUUID();
  private active = false;
  private stopping = false;
  constructor(
    private readonly queue: JobQueue,
    private readonly store: LibraryStore,
    private readonly matcher: FaceMatchingProvider,
    private readonly indexPhoto: PhotoIndexer,
    private readonly prepareScanPhoto?: ScanPhotoPreparer,
  ) {}
  stop() {
    this.stopping = true;
  }
  async processNext(): Promise<boolean> {
    if (this.active || this.stopping) return false;
    this.active = true;
    try {
      const job = await this.queue.claim(this.id, [
        'event-index',
        'discover-library',
      ]);
      if (!job) return false;
      const token = job.leaseToken!;
      let leaseLost = false,
        beating = false;
      let heartbeat: Promise<void> | undefined;
      const assertLease = async () => {
        if (leaseLost)
          throw new ApiError(
            409,
            'JOB_LEASE_LOST',
            'This worker no longer owns the processing job.',
          );
        try {
          await this.queue.heartbeat(job.id, token);
        } catch {
          leaseLost = true;
          throw new ApiError(
            409,
            'JOB_LEASE_LOST',
            'The processing claim could not be confirmed. No new provider request will be started.',
          );
        }
      };
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
          const keepGoing = await withAccountLock(job.ownerId, async () => {
            const current = await this.queue.owned(job.id, job.ownerId);
            if (current.status !== 'running' || current.cancelRequestedAt)
              return false;
            try {
              const event = await this.store.get(job.eventId);
              if (
                (job.type === 'discover-library'
                  ? event.kind !== 'job' ||
                    event.purpose !== 'discover-scan' ||
                    event.processingSource !== 'library' ||
                    event.consentPolicyVersion !== 'face-matching-v1'
                  : event.kind !== 'event') ||
                event.ownerId !== job.ownerId ||
                event.deletionStartedAt ||
                event.archived
              )
                throw new Error('Event unavailable');
            } catch {
              await this.queue.fail(job.id, token, 'EVENT_UNAVAILABLE');
              return false;
            }
            const photoId = await this.queue.beginItem(job.id, token);
            let outcome: ItemOutcome;
            try {
              const discover = job.type === 'discover-library';
              if (discover && !this.prepareScanPhoto)
                throw new ApiError(
                  503,
                  'SOURCE_UNAVAILABLE',
                  'Discover preparation is unavailable.',
                );
              const photo = discover
                ? await this.prepareScanPhoto!(
                    job.ownerId,
                    job.eventId,
                    photoId,
                  )
                : await this.store.get(photoId);
              if (
                photo.kind !== 'photo' ||
                photo.ownerId !== job.ownerId ||
                (discover
                  ? photo.scanId !== job.eventId
                  : photo.eventId !== job.eventId || Boolean(photo.scanId))
              )
                throw new ApiError(
                  404,
                  'NOT_FOUND',
                  'This photo is no longer in the event.',
                );
              await assertLease();
              const indexed = await this.indexPhoto(
                this.matcher,
                this.store,
                photo,
                discover
                  ? { kind: 'scan', id: job.eventId.replaceAll('-', '') }
                  : { kind: 'event', id: job.eventId },
                job.id,
                {
                  assertLease,
                  retryUncertain:
                    job.retryUncertain === true &&
                    job.retryUncertainPhotoIds?.includes(photoId) === true,
                },
              );
              outcome = indexed.indexState === 'ready' ? 'indexed' : 'empty';
            } catch (error) {
              if (leaseLost) return false;
              if (
                error instanceof ApiError &&
                (error.status === 402 || error.code === 'PROCESSING_BUDGET')
              ) {
                await this.queue.fail(job.id, token, 'QUOTA_EXHAUSTED');
                return false;
              }
              if (error instanceof ApiError && error.code === 'JOB_LEASE_LOST')
                return false;
              if (
                error instanceof ApiError &&
                error.code === 'RETRY_UNCERTAIN_REQUIRED'
              ) {
                await this.queue.fail(
                  job.id,
                  token,
                  'RETRY_UNCERTAIN_REQUIRED',
                );
                return false;
              }
              outcome = 'failed';
            }
            // Retry only the checkpoint, with an idempotent receipt and the
            // original outcome. A storage error must never re-enter indexing.
            for (let attempt = 0; attempt < 3; attempt++) {
              if (leaseLost) return false;
              try {
                const completed = await this.queue.finishItem(
                  job.id,
                  token,
                  outcome,
                  current.cursor,
                );
                return completed.status === 'running';
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
          if (!keepGoing) break;
        }
      } catch (error) {
        // An expired/cancelled/deleted claim is fenced. Do not restart paid work.
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
}

export function startProcessingWorker(
  worker?: { processNext(): Promise<boolean>; stop(): void },
  intervalMs = 2000,
) {
  const state = {
    enabled: Boolean(worker),
    running: false,
    lastSuccessAt: null as string | null,
    error: null as string | null,
  };
  // Without an enqueue wake signal, new jobs wait at most 30 seconds at idle
  // with the default interval. Successful work returns to the minimum delay.
  const poller = worker
    ? startAdaptivePoller(
        async () => {
          state.running = true;
          try {
            const worked = await worker.processNext();
            state.lastSuccessAt = new Date().toISOString();
            state.error = null;
            return worked;
          } catch (error) {
            state.error = 'PROCESSING_WORKER_UNAVAILABLE';
            throw error;
          } finally {
            state.running = false;
          }
        },
        { minimumMs: intervalMs, maximumMs: Math.max(intervalMs, 30_000) },
      )
    : undefined;
  return {
    status: () => ({ ...state }),
    stop: async () => {
      worker?.stop();
      await poller?.stop();
    },
  };
}
