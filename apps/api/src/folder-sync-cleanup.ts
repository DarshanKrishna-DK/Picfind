import { ApiError } from './auth.js';
import type { FolderSync, FolderSyncDirectory } from './folder-sync.js';
import type { JobQueue } from './jobs.js';
import type { LibraryStore } from './library.js';

export interface FolderSyncCleanupStore extends FolderSyncDirectory {
  listOwner(owner: string): Promise<FolderSync[]>;
  listActor(actor: string): Promise<FolderSync[]>;
  purgePage(sync: FolderSync): Promise<boolean>;
  redactActor(sync: FolderSync): Promise<void>;
}
const pending = () =>
  new ApiError(
    503,
    'SYNC_CLEANUP_PENDING',
    'Sources are stopped, but background import cleanup is not finished. Retry deletion after cleanup completes.',
  );
export class FolderSyncCleanup {
  constructor(
    private readonly sources: FolderSyncCleanupStore,
    private readonly library: LibraryStore,
    private readonly queue: Pick<JobQueue, 'list' | 'cancel' | 'eraseSource'>,
    private readonly assertAccountDeleting: (owner: string) => Promise<void>,
  ) {}
  private async closedEvent(owner: string, eventId: string) {
    let event;
    try {
      event = await this.library.get(eventId);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    if (
      event &&
      (event.kind !== 'event' ||
        event.ownerId !== owner ||
        !(
          event.deletionStartedAt ||
          event.archived ||
          (event.expiresAt && Date.parse(event.expiresAt) <= Date.now())
        ))
    )
      throw pending();
  }
  private async settle(rows: FolderSync[], stop: boolean, account?: string) {
    const ids = new Set(rows.map((row) => row.id));
    if (stop)
      for (const previous of rows)
        await this.sources.mutate(previous.id, (current) => {
          if (!current) return { result: undefined };
          if (
            current.ownerId !== previous.ownerId ||
            current.actorId !== previous.actorId ||
            current.eventId !== previous.eventId
          )
            throw pending();
          const record: FolderSync = {
            ...current,
            status: 'expired',
            cleanupRequestedAt:
              current.cleanupRequestedAt ?? new Date().toISOString(),
          };
          delete record.leaseToken;
          delete record.leaseUntil;
          record.nextRunAt = new Date().toISOString();
          // Event/owner erasure wins over a moderator's connection-only cleanup.
          if (!account) delete record.cleanupAccountId;
          else if (
            (!current.cleanupRequestedAt || current.cleanupAccountId) &&
            current.cleanupAccountId !== current.ownerId
          )
            record.cleanupAccountId = account;
          return { record, result: undefined };
        });
    let active = false;
    for (const owner of new Set(rows.map((row) => row.ownerId))) {
      for (const job of await this.queue.list(owner)) {
        if (
          job.ownerId !== owner ||
          job.type !== 'cloud-import' ||
          !job.importSource?.folderSyncId ||
          !ids.has(job.importSource.folderSyncId)
        )
          continue;
        if (job.status === 'queued' || job.status === 'running') {
          const saved = await this.queue.cancel(job.id, owner);
          if (saved.status === 'queued' || saved.status === 'running')
            active = true;
        }
      }
    }
    if (active) throw pending();
  }
  async stopEvent(owner: string, eventId: string) {
    await this.closedEvent(owner, eventId);
    await this.settle(await this.sources.listEvent(owner, eventId), true);
  }
  async stopAccount(owner: string) {
    await this.assertAccountDeleting(owner);
    const rows = new Map<string, FolderSync>();
    for (const row of [
      ...(await this.sources.listOwner(owner)),
      ...(await this.sources.listActor(owner)),
    ]) {
      if (row.ownerId !== owner && row.actorId !== owner) throw pending();
      rows.set(row.id, row);
    }
    await this.settle([...rows.values()], true, owner);
  }
  private async erase(rows: FolderSync[], allowPartial = false) {
    await this.settle(rows, false);
    let complete = true;
    for (const owner of new Set(rows.map((row) => row.ownerId))) {
      const photos = await this.library.list(owner, 'photo'),
        jobs = await this.library.list(owner, 'job');
      for (const row of rows.filter((source) => source.ownerId === owner)) {
        const current = await this.sources.get(row.id);
        if (!current) continue;
        if (
          current.status !== 'expired' ||
          !current.cleanupRequestedAt ||
          photos.some((photo) => photo.folderSyncId === row.id) ||
          jobs.some(
            (job) =>
              job.folderSyncId === row.id && job.purpose === 'upload-cleanup',
          )
        )
          throw pending();
        await this.queue.eraseSource(owner, row.id);
        if (!(await this.sources.purgePage(current))) complete = false;
      }
    }
    if (!complete && !allowPartial) throw pending();
    return complete;
  }
  /** Background continuation never erases gallery photos or an authentication account. */
  async continueSource(
    id: string,
  ): Promise<'complete' | 'progress' | 'redacted' | 'idle'> {
    let row = await this.sources.get(id);
    if (!row) return 'complete';
    if (row.status !== 'expired') return 'idle';
    if (row.cleanupAccountId) {
      if (
        ![row.ownerId, row.actorId].includes(row.cleanupAccountId) ||
        !row.cleanupRequestedAt
      )
        throw pending();
      await this.assertAccountDeleting(row.cleanupAccountId);
      if (row.cleanupAccountId !== row.ownerId) {
        if (row.cleanupRedactedAt) return 'idle';
        await this.settle([row], false);
        await this.queue.eraseSource(row.ownerId, row.id);
        await this.sources.redactActor(row);
        return 'redacted';
      }
    } else {
      await this.closedEvent(row.ownerId, row.eventId);
      if (!row.cleanupRequestedAt) {
        await this.settle([row], true);
        row = await this.sources.get(id);
        if (!row) return 'complete';
      }
    }
    return (await this.erase([row], true)) ? 'complete' : 'progress';
  }
  async finishEvent(owner: string, eventId: string) {
    await this.closedEvent(owner, eventId);
    await this.erase(await this.sources.listEvent(owner, eventId));
  }
  async finishAccount(owner: string) {
    await this.assertAccountDeleting(owner);
    await this.erase(await this.sources.listOwner(owner));
    const foreign = (await this.sources.listActor(owner)).filter(
      (row) => row.ownerId !== owner,
    );
    await this.settle(foreign, false);
    for (const row of foreign) {
      if (row.status !== 'expired' || !row.cleanupRequestedAt) throw pending();
      await this.queue.eraseSource(row.ownerId, row.id);
      await this.sources.redactActor(row);
    }
  }
}
