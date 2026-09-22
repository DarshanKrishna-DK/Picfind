import { randomUUID } from 'node:crypto';
import { ApiError } from './auth.js';
import { validImportFileId } from './import-policy.js';
import type { SourceProvider } from './source-connections.js';

export const SYNC_PAGE_SIZE = 50;
export const SYNC_INTERVAL_MS = 15 * 60_000;
export const SYNC_LEASE_MS = 60_000;
export const SYNC_MAX_PAGES = 2000;
export type SyncStatus = 'active' | 'paused' | 'expired' | 'attention';
export interface FolderSync {
  cleanupRequestedAt?: string;
  cleanupAccountId?: string;
  cleanupRedactedAt?: string;
  resumeRequestId?: string;
  consentPolicyVersion?: 'folder-sync-v1';
  id: string;
  ownerId: string;
  actorId: string;
  eventId: string;
  provider: SourceProvider;
  generation: string;
  membershipGrantId?: string;
  folderId: string;
  status: SyncStatus;
  createdAt: string;
  nextRunAt: string;
  cursor: string | null;
  pages: number;
  imported: number;
  leaseToken?: string;
  leaseUntil?: string;
  error?:
    | 'source-changed'
    | 'access-changed'
    | 'import-attention'
    | 'folder-limit'
    | 'invalid-page'
    | 'temporary';
  pending?: {
    attemptId?: string;
    preservedFileIndexes?: number[];
    requestId: string;
    fileIds: string[];
    nextCursor: string | null;
    batchId?: string;
  };
}
export interface FolderSyncStore {
  candidates(now: string, limit: number): Promise<FolderSync[]>;
  get(id: string): Promise<FolderSync | undefined>;
  knownFiles(sync: FolderSync, fileIds: string[]): Promise<Set<string>>;
  /** Atomic compare/update; callback may run again on a conflict. Receipts and cursor commit together. */
  mutate<T>(
    id: string,
    operation: (record: FolderSync | undefined) => {
      record?: FolderSync;
      remember?: string[];
      result: T;
    },
  ): Promise<T>;
}
export interface FolderSyncDirectory extends FolderSyncStore {
  isSuppressed(sync: FolderSync, fileId: string): Promise<boolean>;
  listEvent(ownerId: string, eventId: string): Promise<FolderSync[]>;
}
export interface FolderSyncPorts {
  /** Recheck event ownership, membership generation, account deletion and source generation. No owner impersonation. */
  authorize(sync: FolderSync): Promise<{ expiresAt: string }>;
  /** Direct children only; provider page size must not exceed limit. Never silently truncate a page. */
  list(
    sync: FolderSync,
    limit: number,
    guard: () => Promise<void>,
  ): Promise<{ fileIds: string[]; nextCursor: string | null }>;
  /** Persist/enqueue the SAME requestId after ambiguous failures. Imports must carry sync authority into their worker. */
  enqueue(
    sync: FolderSync,
    pending: NonNullable<FolderSync['pending']>,
    guard: () => Promise<void>,
  ): Promise<string>;
  inspect(
    sync: FolderSync,
    batchId: string,
  ): Promise<'running' | 'complete' | 'attention'>;
}
const unavailable = () =>
  new ApiError(
    409,
    'SYNC_LEASE_LOST',
    'This folder sync no longer owns the work.',
  );
export class FolderSyncWorker {
  private active = false;
  private stopping = false;
  stop() {
    this.stopping = true;
  }
  constructor(
    private readonly store: FolderSyncStore,
    private readonly ports: FolderSyncPorts,
    private readonly now = Date.now,
  ) {}
  private owned(row: FolderSync | undefined, token: string): FolderSync {
    if (
      !row ||
      row.status !== 'active' ||
      row.leaseToken !== token ||
      !row.leaseUntil ||
      Date.parse(row.leaseUntil) <= this.now()
    )
      throw unavailable();
    return row;
  }
  async processNext() {
    if (this.active || this.stopping) return false;
    this.active = true;
    try {
      for (const candidate of await this.store.candidates(
        new Date(this.now()).toISOString(),
        8,
      )) {
        if (this.stopping) return false;
        const token = randomUUID();
        const sync = await this.store.mutate(candidate.id, (row) => {
          if (
            !row ||
            row.status !== 'active' ||
            Date.parse(row.nextRunAt) > this.now() ||
            (row.leaseUntil && Date.parse(row.leaseUntil) > this.now())
          )
            return { result: null };
          const record = {
            ...row,
            leaseToken: token,
            leaseUntil: new Date(this.now() + SYNC_LEASE_MS).toISOString(),
          };
          return { record, result: record };
        });
        if (!sync) continue;
        await this.step(sync, token);
        return true;
      }
      return false;
    } finally {
      this.active = false;
    }
  }
  private async step(sync: FolderSync, token: string) {
    const guard = async () => {
      const current = this.owned(await this.store.get(sync.id), token);
      const access = await this.ports.authorize(current);
      const expiry = Date.parse(access.expiresAt);
      if (!Number.isFinite(expiry))
        throw new ApiError(
          409,
          'SYNC_ACCESS_CHANGED',
          'This event needs a valid expiry.',
        );
      if (expiry <= this.now())
        throw new ApiError(410, 'SYNC_EXPIRED', 'This event has expired.');
      this.owned(await this.store.get(sync.id), token);
    };
    const save = async (
      change: (row: FolderSync) => FolderSync,
      remember?: string[],
    ) =>
      this.store.mutate(sync.id, (row) => {
        const record = change(this.owned(row, token));
        return { record, ...(remember ? { remember } : {}), result: record };
      });
    const release = (row: FolderSync, delay: number): FolderSync => {
      const result = {
        ...row,
        nextRunAt: new Date(this.now() + delay).toISOString(),
      };
      delete result.leaseToken;
      delete result.leaseUntil;
      delete result.error;
      return result;
    };
    const advance = (row: FolderSync, cursor: string | null) => {
      const next = release(
        { ...row, cursor, pages: cursor ? row.pages + 1 : 0 },
        cursor ? 1000 : SYNC_INTERVAL_MS,
      );
      delete next.pending;
      return next;
    };
    try {
      await guard();
      if (sync.pending?.batchId) {
        const status = await this.ports.inspect(sync, sync.pending.batchId);
        await guard();
        if (status === 'running') {
          await save((row) => release(row, 15_000));
          return;
        }
        if (status === 'attention')
          throw new ApiError(
            409,
            'SYNC_IMPORT_ATTENTION',
            'Review this import before continuing sync.',
          );
        // One transaction remembers imported IDs and advances the provider cursor.
        await save(
          (row) => ({
            ...advance(row, row.pending!.nextCursor),
            imported: row.imported + row.pending!.fileIds.length,
          }),
          sync.pending.fileIds,
        );
        return;
      }
      if (!sync.pending) {
        if (sync.pages >= SYNC_MAX_PAGES)
          throw new ApiError(
            409,
            'SYNC_FOLDER_LIMIT',
            'Choose a smaller folder for automatic sync.',
          );
        const page = await this.ports.list(sync, SYNC_PAGE_SIZE, guard);
        await guard();
        if (
          !Array.isArray(page.fileIds) ||
          page.fileIds.length > SYNC_PAGE_SIZE ||
          page.fileIds.some((id) => !validImportFileId(id)) ||
          (page.nextCursor !== null &&
            (typeof page.nextCursor !== 'string' ||
              !page.nextCursor ||
              page.nextCursor.length > 8192 ||
              page.nextCursor === sync.cursor))
        )
          throw new ApiError(
            409,
            'SYNC_INVALID_PAGE',
            'This folder listing cannot safely advance.',
          );
        const ids = [...new Set(page.fileIds)];
        const known = await this.store.knownFiles(sync, ids);
        if ([...known].some((id) => !ids.includes(id)))
          throw new ApiError(
            409,
            'SYNC_INVALID_PAGE',
            'This import history needs reconciliation.',
          );
        const fileIds = ids.filter((id) => !known.has(id));
        await guard();
        if (!fileIds.length) {
          await save((row) => advance(row, page.nextCursor));
          return;
        }
        // Durable intent BEFORE enqueue. A lost reply never produces a new request ID.
        sync = await save((row) => ({
          ...row,
          pending: {
            requestId: randomUUID(),
            fileIds,
            nextCursor: page.nextCursor,
          },
        }));
      }
      await guard();
      const batchId = await this.ports.enqueue(sync, sync.pending!, guard);
      if (!batchId || batchId.length > 128)
        throw new Error('Invalid batch receipt');
      await guard();
      await save((row) =>
        release({ ...row, pending: { ...row.pending!, batchId } }, 15_000),
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === 'SYNC_LEASE_LOST') return;
      await this.store.mutate(sync.id, (row) => {
        if (!row || row.status !== 'active' || row.leaseToken !== token)
          return { result: undefined };
        const record = release(row, SYNC_INTERVAL_MS);
        const code = error instanceof ApiError ? error.code : '';
        if (code === 'SYNC_CURSOR_EXPIRED' && !row.pending) {
          record.cursor = null;
          record.pages = 0;
          record.error = 'temporary';
        } else if (code === 'SYNC_EXPIRED') record.status = 'expired';
        else if (
          [
            'SOURCE_CONNECTION_CHANGED',
            'SOURCE_RECONNECT_REQUIRED',
            'SOURCE_REFRESH_PENDING',
          ].includes(code)
        ) {
          record.status = 'attention';
          record.error = 'source-changed';
        } else if (code === 'SYNC_IMPORT_ATTENTION') {
          record.status = 'attention';
          record.error = 'import-attention';
        } else if (code === 'SYNC_FOLDER_LIMIT') {
          record.status = 'attention';
          record.error = 'folder-limit';
        } else if (code === 'SYNC_INVALID_PAGE') {
          record.status = 'attention';
          record.error = 'invalid-page';
        } else if (
          error instanceof ApiError &&
          [401, 403, 404, 409, 410].includes(error.status)
        ) {
          record.status = 'attention';
          record.error = 'access-changed';
        } else record.error = 'temporary';
        return { record, result: undefined };
      });
    }
  }
}
