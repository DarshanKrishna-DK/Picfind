import { ApiError } from './auth.js';
import type { BillingService } from './billing/service.js';
import { requireEventAccess } from './event-membership-access.js';
import type { FolderSync, FolderSyncDirectory } from './folder-sync.js';
import type { JobQueue } from './jobs.js';
import type { LibraryStore } from './library.js';
import type { SourceConnections } from './source-connections.js';
import {
  folderSyncId,
  type CreateFolderSyncInput,
} from './billing/folder-sync-creation.js';
import { validateSyncFolder } from './folder-sync-reader.js';
import { prepareFolderSyncResume } from './folder-sync-recovery.js';

const missing = () =>
  new ApiError(404, 'NOT_FOUND', 'This event source is not available.');
export class FolderSyncControls {
  constructor(
    private readonly syncs: FolderSyncDirectory,
    private readonly library: LibraryStore,
    private readonly billing: Pick<BillingService, 'authorizeFolderSync'> &
      Partial<Pick<BillingService, 'createFolderSync' | 'resumeFolderSync'>>,
    private readonly connections: Pick<SourceConnections, 'access'>,
    private readonly queue: Pick<JobQueue, 'owned' | 'cancel'>,
  ) {}
  /** Used by both the scheduler and each import guard. Never exposes the token. */
  async authorize(sync: FolderSync) {
    if (sync.consentPolicyVersion !== 'folder-sync-v1')
      throw new ApiError(
        409,
        'SYNC_CONSENT_REQUIRED',
        'Confirm automatic folder imports before enabling this source.',
      );
    const event = await this.billing.authorizeFolderSync(sync);
    await this.connections.access(sync.actorId, sync.provider, sync.generation);
    return event;
  }
  private view(sync: FolderSync, actor: string, expiresAt?: string) {
    const expired =
      !expiresAt ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.now();
    const sourceOwner = sync.actorId === actor;
    return {
      id: sync.id,
      eventId: sync.eventId,
      provider: sync.provider,
      status: expired ? 'expired' : sync.status,
      imported: sync.imported,
      createdAt: sync.createdAt,
      nextCheckAt: !expired && sync.status === 'active' ? sync.nextRunAt : null,
      expiresAt: expiresAt ?? null,
      sourceOwner,
      canResume:
        sourceOwner &&
        !expired &&
        sync.status === 'paused' &&
        Boolean(this.billing.resumeFolderSync),
      canStop:
        !expired && sync.status !== 'paused' && sync.status !== 'expired',
      // Other moderators' personal folder names/paths are not disclosed.
      folder: sourceOwner ? sync.folderId : null,
      error: sync.error ?? null,
    };
  }
  async create(actor: string, eventId: string, input: CreateFolderSyncInput) {
    if (!this.billing.createFolderSync)
      throw new ApiError(
        503,
        'FOLDER_SYNC_UNAVAILABLE',
        'Automatic source creation is not configured.',
      );
    const access = await requireEventAccess(this.library, eventId, actor, true);
    const now = new Date().toISOString();
    const candidate: FolderSync = {
      id: folderSyncId(actor, eventId, input.requestId),
      ownerId: access.event.ownerId,
      actorId: actor,
      eventId,
      provider: input.provider,
      generation: input.generation,
      folderId: validateSyncFolder(input),
      ...(access.role === 'moderator'
        ? { membershipGrantId: access.grantId }
        : {}),
      consentPolicyVersion: 'folder-sync-v1',
      status: 'active',
      createdAt: now,
      nextRunAt: now,
      cursor: null,
      pages: 0,
      imported: 0,
    };
    await this.authorize(candidate);
    const saved = await this.billing.createFolderSync(
      actor,
      eventId,
      input,
      access.grantId,
    );
    return this.view(saved, actor, access.event.expiresAt);
  }
  async list(actor: string, eventId: string) {
    const access = await requireEventAccess(this.library, eventId, actor);
    const rows = await this.syncs.listEvent(access.event.ownerId, eventId);
    return rows
      .filter(
        (row) =>
          access.role === 'owner' ||
          (row.actorId === actor && row.membershipGrantId === access.grantId),
      )
      .map((row) => this.view(row, actor, access.event.expiresAt));
  }
  async resume(
    actor: string,
    eventId: string,
    syncId: string,
    requestId: string,
    generation: string,
  ) {
    if (!this.billing.resumeFolderSync)
      throw new ApiError(
        503,
        'FOLDER_SYNC_UNAVAILABLE',
        'Automatic source recovery is not configured.',
      );
    const access = await requireEventAccess(this.library, eventId, actor, true);
    const sync = await this.syncs.get(syncId);
    if (
      !sync ||
      sync.ownerId !== access.event.ownerId ||
      sync.eventId !== eventId ||
      sync.actorId !== actor ||
      (access.role === 'moderator' && sync.membershipGrantId !== access.grantId)
    )
      throw missing();
    if (generation !== sync.generation)
      throw new ApiError(
        409,
        'SOURCE_CONNECTION_CHANGED',
        'Confirm a replacement source instead of resuming against a different connection.',
      );
    await this.authorize(sync);
    if (sync.resumeRequestId === requestId)
      return this.view(sync, actor, access.event.expiresAt);
    if (sync.status !== 'paused')
      throw new ApiError(
        409,
        'SYNC_STOP_REQUIRED',
        'Stop this source before resuming its saved batch.',
      );
    const recovery = await prepareFolderSyncResume(
      sync,
      requestId,
      this.library,
      this.queue,
      (source, fileId) => this.syncs.isSuppressed(source, fileId),
    );
    const saved = await this.billing.resumeFolderSync(
      actor,
      eventId,
      sync,
      requestId,
      recovery,
    );
    return this.view(saved, actor, access.event.expiresAt);
  }
  async stop(actor: string, eventId: string, syncId: string) {
    const access = await requireEventAccess(this.library, eventId, actor);
    const stopped = await this.syncs.mutate(syncId, (row) => {
      if (
        !row ||
        row.ownerId !== access.event.ownerId ||
        row.eventId !== eventId ||
        (access.role !== 'owner' &&
          (row.actorId !== actor || row.membershipGrantId !== access.grantId))
      )
        throw missing();
      const record: FolderSync = {
        ...row,
        status: row.status === 'expired' ? 'expired' : 'paused',
      };
      delete record.leaseToken;
      delete record.leaseUntil;
      delete record.error;
      return { record, result: record };
    });
    // Persist the authorization fence first. A failed cancellation cannot enable
    // more publication; transaction guards reject the paused source independently.
    if (stopped.pending?.batchId) {
      const job = await this.queue.owned(
        stopped.pending.batchId,
        stopped.ownerId,
      );
      if (
        job.type !== 'cloud-import' ||
        job.importSource?.folderSyncId !== stopped.id ||
        job.requestId !==
          (stopped.pending.attemptId ?? stopped.pending.requestId)
      )
        throw new ApiError(
          503,
          'SYNC_STORAGE_INVALID',
          'This source is paused, but its queued batch needs maintenance.',
        );
      if (job.status === 'queued' || job.status === 'running')
        await this.queue.cancel(job.id, stopped.ownerId);
    }
    return this.view(stopped, actor, access.event.expiresAt);
  }
}
