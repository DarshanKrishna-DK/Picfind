import type {
  FolderSyncCleanup,
  FolderSyncCleanupStore,
} from './folder-sync-cleanup.js';
import type { FolderSync } from './folder-sync.js';
import { withAccountLock } from './locks.js';

export const SYNC_CLEANUP_RETRY_MS = 15 * 60_000;
export interface SyncCleanupCandidates extends Pick<
  FolderSyncCleanupStore,
  'get' | 'mutate'
> {
  cleanupCandidates(now: string, limit: number): Promise<FolderSync[]>;
}

/** Reuses the processing poller. Bounded database work only; no photo/provider calls. */
export class FolderSyncCleanupWorker {
  private active = false;
  private stopping = false;
  private outcome: 'idle' | 'complete' | 'progress' | 'redacted' | 'deferred' =
    'idle';
  constructor(
    private readonly sources: SyncCleanupCandidates,
    private readonly cleanup: Pick<FolderSyncCleanup, 'continueSource'>,
    private readonly now = Date.now,
  ) {}
  stop() {
    this.stopping = true;
  }
  status() {
    return { outcome: this.outcome };
  }
  async processNext() {
    if (this.active || this.stopping) return false;
    this.active = true;
    try {
      for (const candidate of await this.sources.cleanupCandidates(
        new Date(this.now()).toISOString(),
        8,
      )) {
        if (this.stopping) return false;
        const worked = await withAccountLock(candidate.ownerId, async () => {
          const current = await this.sources.get(candidate.id);
          if (
            !current ||
            current.ownerId !== candidate.ownerId ||
            current.status !== 'expired' ||
            Date.parse(current.nextRunAt) > this.now()
          )
            return false;
          let delay = SYNC_CLEANUP_RETRY_MS;
          try {
            this.outcome = await this.cleanup.continueSource(current.id);
            delay =
              this.outcome === 'progress'
                ? 1000
                : this.outcome === 'idle' || this.outcome === 'redacted'
                  ? 86400000
                  : SYNC_CLEANUP_RETRY_MS;
          } catch {
            // Keep the authority and receipts on failure; do not starve other sources.
            this.outcome = 'deferred';
          }
          await this.sources.mutate(current.id, (row) => {
            if (
              !row ||
              row.ownerId !== current.ownerId ||
              row.status !== 'expired' ||
              row.cleanupRequestedAt !== current.cleanupRequestedAt ||
              row.cleanupAccountId !== current.cleanupAccountId ||
              row.nextRunAt !== current.nextRunAt
            )
              return { result: undefined };
            return {
              record: {
                ...row,
                nextRunAt: new Date(this.now() + delay).toISOString(),
              },
              result: undefined,
            };
          });
          return true;
        });
        if (worked) return true;
      }
      return false;
    } finally {
      this.active = false;
    }
  }
}
