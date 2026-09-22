import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from './auth.js';
import {
  validImportFileId,
  validImportSource,
  type ImportSource,
} from './import-policy.js';
import { MAX_JOB_PHOTOS, FAILED_PHOTO_SAMPLE_LIMIT } from './job-manifest.js';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'complete'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type ItemOutcome = 'indexed' | 'empty' | 'imported' | 'failed';
export interface JobRecord {
  id: string;
  ownerId: string;
  eventId: string;
  type: 'event-index' | 'discover-library' | 'cloud-import';
  importSource?: ImportSource;
  imported?: number;
  requestId: string;
  fingerprint: string;
  photoIds: string[];
  retryUncertain?: boolean;
  retryUncertainPhotoIds?: string[];
  lastCheckpoint?: {
    cursor: number;
    outcome: ItemOutcome;
    leaseToken: string;
  };
  consentPolicyVersion: 'face-matching-v1' | 'cloud-import-v1';
  consentAt: string;
  createdAt: string;
  updatedAt: string;
  availableAt: string;
  status: JobStatus;
  cursor: number;
  indexed: number;
  empty: number;
  failed: number;
  failedPhotoIds: string[];
  failedPhotoIdsTruncated?: boolean;
  photoCount?: number;
  activePhotoId?: string;
  workerId?: string;
  leaseToken?: string;
  leaseUntil?: string;
  cancelRequestedAt?: string;
  failureCode?:
    | 'INTERRUPTED'
    | 'QUOTA_EXHAUSTED'
    | 'SOURCE_UNAVAILABLE'
    | 'EVENT_UNAVAILABLE'
    | 'RETRY_UNCERTAIN_REQUIRED'
    | 'PROCESSING_FAILED';
}
export type JobListEntry = Omit<
  JobRecord,
  'photoIds' | 'retryUncertainPhotoIds'
> & {
  photoIds?: string[];
};
export interface JobStore {
  list(ownerId: string, eventId?: string): Promise<JobListEntry[]>;
  remove(id: string): Promise<void>;
  get(id: string): Promise<JobRecord | undefined>;
  candidates(
    before: string,
    limit: number,
    types?: readonly JobRecord['type'][],
  ): Promise<JobListEntry[]>;
  /** The callback is pure and may run again following a transaction conflict. */
  mutate<T>(
    id: string,
    operation: (job: JobRecord | undefined) => { job?: JobRecord; result: T },
  ): Promise<T>;
}
export interface EnqueueIndex {
  importSource?: ImportSource;
  type?: JobRecord['type'];
  ownerId: string;
  eventId: string;
  requestId: string;
  photoIds: string[];
  retryUncertain?: boolean;
  retryUncertainPhotoIds?: string[];
  consentPolicyVersion: 'face-matching-v1' | 'cloud-import-v1';
}
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const conflict = () =>
  new ApiError(
    409,
    'JOB_LEASE_LOST',
    'This worker no longer owns the processing job.',
  );
export class JobQueue {
  /** Persist the event deletion/expiry fence before calling this method. */
  async eraseEvent(ownerId: string, eventId: string): Promise<void> {
    const belongs = (job: JobListEntry) =>
      job.ownerId === ownerId &&
      ((job.type === 'event-index' && job.eventId === eventId) ||
        (job.type === 'cloud-import' &&
          job.importSource?.destinationEventId === eventId));
    const settled: JobRecord[] = [];
    for (const entry of (await this.list(ownerId)).filter(belongs)) {
      const current = await this.store.get(entry.id);
      if (!current) continue;
      if (!belongs(current))
        throw new ApiError(
          503,
          'EVENT_CLEANUP_PENDING',
          'Processing cleanup scope changed. Retry after reconciliation.',
        );
      settled.push(await this.cancel(current.id, ownerId));
    }
    if (settled.some((job) => job.status === 'running'))
      throw new ApiError(
        409,
        'PROCESSING_ACTIVE',
        'The event is hidden. Retry deletion after the current photo finishes.',
      );
    for (const job of settled) await this.store.remove(job.id);
  }
  /** Source lifecycle caller must persist its stop/deletion fence before invoking this. */
  async eraseSource(ownerId: string, syncId: string): Promise<void> {
    for (const entry of await this.list(ownerId)) {
      if (
        entry.type !== 'cloud-import' ||
        entry.importSource?.folderSyncId !== syncId
      )
        continue;
      let current = await this.store.get(entry.id);
      if (!current) continue;
      if (
        current.ownerId !== ownerId ||
        current.type !== 'cloud-import' ||
        current.importSource?.folderSyncId !== syncId
      )
        throw new ApiError(
          503,
          'SYNC_CLEANUP_PENDING',
          'Import cleanup scope changed. Retry after reconciliation.',
        );
      if (['queued', 'running', 'interrupted'].includes(current.status))
        current = await this.cancel(current.id, ownerId);
      if (current.status === 'running' || current.status === 'queued')
        throw new ApiError(
          503,
          'SYNC_CLEANUP_PENDING',
          'An import is still finishing. Its private file list is retained until it stops.',
        );
      await this.store.remove(current.id);
    }
  }
  async list(ownerId: string, eventId?: string): Promise<JobListEntry[]> {
    return (await this.store.list(ownerId, eventId)).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
  async cancelOwner(ownerId: string, eventId?: string): Promise<void> {
    for (const job of await this.list(ownerId, eventId))
      await this.cancel(job.id, ownerId);
  }
  async eraseOwner(ownerId: string, eventId?: string): Promise<void> {
    for (const job of await this.list(ownerId, eventId)) {
      if (job.status === 'running')
        throw new ApiError(
          409,
          'PROCESSING_ACTIVE',
          'Wait for the current photo to finish before deleting this account.',
        );
      await this.store.remove(job.id);
    }
  }
  private readonly now: () => number;
  readonly leaseMs: number;
  constructor(
    private readonly store: JobStore,
    options: { now?: () => number; leaseMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 120_000;
    if (
      !Number.isInteger(this.leaseMs) ||
      this.leaseMs < 10_000 ||
      this.leaseMs > 600_000
    )
      throw new Error('Job lease must be 10 to 600 seconds.');
  }
  async enqueue(input: EnqueueIndex): Promise<JobRecord> {
    const isImport = input.type === 'cloud-import';
    const ids = [...new Set(input.photoIds)];
    const idSet = new Set(ids);
    const retryUncertain = input.retryUncertain === true;
    const retryUncertainPhotoIds = [
      ...new Set(input.retryUncertainPhotoIds ?? []),
    ].sort();
    if (
      !input.ownerId ||
      (input.type !== undefined &&
        !['event-index', 'discover-library', 'cloud-import'].includes(
          input.type,
        )) ||
      input.ownerId.length > 64 ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(input.eventId) ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(input.requestId) ||
      (isImport
        ? input.consentPolicyVersion !== 'cloud-import-v1' ||
          !validImportSource(input.importSource) ||
          retryUncertain ||
          retryUncertainPhotoIds.length > 0
        : input.consentPolicyVersion !== 'face-matching-v1' ||
          input.importSource !== undefined) ||
      (input.retryUncertain !== undefined &&
        typeof input.retryUncertain !== 'boolean') ||
      (!retryUncertain && retryUncertainPhotoIds.length > 0) ||
      retryUncertainPhotoIds.some((photoId) => !idSet.has(photoId)) ||
      !ids.length ||
      ids.length > MAX_JOB_PHOTOS ||
      ids.some((id) =>
        isImport ? !validImportFileId(id) : !/^[a-zA-Z0-9-]{1,64}$/.test(id),
      )
    ) {
      throw new ApiError(
        400,
        'INVALID_JOB',
        isImport
          ? `Choose 1 to ${MAX_JOB_PHOTOS} source files with a current cloud connection and import authorization.`
          : `Choose 1 to ${MAX_JOB_PHOTOS} photos and confirm the face-processing notice.`,
      );
    }
    const id = hash(
      `${input.ownerId}:${input.eventId}:${input.requestId}`,
    ).slice(0, 36);
    const fingerprint = hash(
      JSON.stringify({
        ...(input.type && input.type !== 'event-index'
          ? { type: input.type }
          : {}),
        ...(isImport
          ? {
              importSource: {
                provider: input.importSource!.provider,
                generation: input.importSource!.generation,
                ...(input.importSource!.folderSyncId
                  ? { folderSyncId: input.importSource!.folderSyncId }
                  : {}),
                ...(input.importSource!.actorId
                  ? {
                      actorId: input.importSource!.actorId,
                      membershipGrantId: input.importSource!.membershipGrantId,
                    }
                  : {}),
                ...(input.importSource!.destinationEventId
                  ? {
                      destinationEventId:
                        input.importSource!.destinationEventId,
                    }
                  : {}),
              },
            }
          : {}),
        eventId: input.eventId,
        photoIds: [...ids].sort(),
        policy: input.consentPolicyVersion,
        // Omitted/false keeps existing non-retry request fingerprints compatible.
        ...(retryUncertain ? { retryUncertain, retryUncertainPhotoIds } : {}),
      }),
    );
    return this.store.mutate(id, (existing) => {
      if (existing) {
        if (
          existing.ownerId !== input.ownerId ||
          existing.fingerprint !== fingerprint
        )
          throw new ApiError(
            409,
            'JOB_REQUEST_REUSED',
            'This request was already used for a different photo batch.',
          );
        return { result: existing };
      }
      const now = new Date(this.now()).toISOString();
      const job: JobRecord = {
        ...input,
        id,
        fingerprint,
        photoIds: ids,
        retryUncertain,
        retryUncertainPhotoIds,
        type: input.type ?? 'event-index',
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        availableAt: now,
        consentAt: now,
        cursor: 0,
        indexed: 0,
        ...(isImport ? { imported: 0 } : {}),
        empty: 0,
        failed: 0,
        failedPhotoIds: [],
      };
      return { job, result: job };
    });
  }
  async owned(id: string, ownerId: string): Promise<JobRecord> {
    const job = await this.store.get(id);
    if (!job || job.ownerId !== ownerId)
      throw new ApiError(
        404,
        'JOB_NOT_FOUND',
        'This processing job is not available.',
      );
    return job;
  }
  async authorizedImport(
    id: string,
    authorize: (job: JobRecord) => Promise<void>,
  ): Promise<JobRecord> {
    const job = await this.store.get(id);
    if (!job || job.type !== 'cloud-import' || !job.importSource)
      throw new ApiError(
        404,
        'IMPORT_NOT_FOUND',
        'This import is not available.',
      );
    await authorize(job);
    return job;
  }
  async claim(
    workerId: string,
    types?: readonly JobRecord['type'][],
  ): Promise<JobRecord | undefined> {
    if (!workerId || workerId.length > 128)
      throw new Error('A bounded worker identifier is required.');
    const now = new Date(this.now()).toISOString();
    for (const candidate of await this.store.candidates(now, 20, types)) {
      if (types && !types.includes(candidate.type)) continue;
      const claimed = await this.store.mutate<JobRecord | undefined>(
        candidate.id,
        (job) => {
          if (
            !job ||
            !['queued', 'running'].includes(job.status) ||
            (types !== undefined && !types.includes(job.type)) ||
            job.availableAt > now
          )
            return { result: undefined };
          if (job.status === 'running' && job.activePhotoId) {
            // A crashed worker may already have incurred a paid request. Require owner review.
            job.status = job.cancelRequestedAt ? 'cancelled' : 'interrupted';
            job.failureCode = 'INTERRUPTED';
            job.updatedAt = now;
            delete job.leaseToken;
            delete job.leaseUntil;
            delete job.workerId;
            return { job, result: undefined };
          }
          if (job.cancelRequestedAt) {
            job.status = 'cancelled';
            job.updatedAt = now;
            return { job, result: undefined };
          }
          job.status = 'running';
          job.workerId = workerId;
          job.leaseToken = randomUUID();
          job.leaseUntil = new Date(this.now() + this.leaseMs).toISOString();
          job.availableAt = job.leaseUntil;
          job.updatedAt = now;
          return { job, result: job };
        },
      );
      if (claimed) return claimed;
    }
    return undefined;
  }
  private leased(job: JobRecord | undefined, token: string): JobRecord {
    if (
      !job ||
      job.status !== 'running' ||
      !token ||
      job.leaseToken !== token ||
      !job.leaseUntil ||
      Date.parse(job.leaseUntil) <= this.now()
    )
      throw conflict();
    return job;
  }
  async heartbeat(id: string, token: string): Promise<void> {
    await this.store.mutate(id, (record) => {
      const job = this.leased(record, token);
      job.leaseUntil = new Date(this.now() + this.leaseMs).toISOString();
      job.availableAt = job.leaseUntil;
      job.updatedAt = new Date(this.now()).toISOString();
      return { job, result: undefined };
    });
  }
  async beginItem(id: string, token: string): Promise<string> {
    return this.store.mutate(id, (record) => {
      const job = this.leased(record, token);
      const photoId = job.photoIds[job.cursor];
      if (job.cancelRequestedAt || job.activePhotoId || !photoId)
        throw conflict();
      job.activePhotoId = photoId;
      job.updatedAt = new Date(this.now()).toISOString();
      return { job, result: photoId };
    });
  }
  async finishItem(
    id: string,
    token: string,
    outcome: ItemOutcome,
    expectedCursor?: number,
  ): Promise<JobRecord> {
    return this.store.mutate(id, (record) => {
      // A committed checkpoint may have lost its reply, including the final one.
      if (
        record &&
        expectedCursor !== undefined &&
        record.cursor === expectedCursor + 1 &&
        record.lastCheckpoint?.cursor === expectedCursor &&
        record.lastCheckpoint.outcome === outcome &&
        record.lastCheckpoint.leaseToken === token
      )
        return { result: record };
      const job = this.leased(record, token);
      if (
        (expectedCursor !== undefined && job.cursor !== expectedCursor) ||
        !job.activePhotoId ||
        job.activePhotoId !== job.photoIds[job.cursor] ||
        !(
          job.type === 'cloud-import'
            ? ['imported', 'failed']
            : ['indexed', 'empty', 'failed']
        ).includes(outcome)
      )
        throw conflict();
      job[outcome] = (job[outcome] ?? 0) + 1;
      if (outcome === 'failed') {
        if (job.failedPhotoIds.length < FAILED_PHOTO_SAMPLE_LIMIT)
          job.failedPhotoIds.push(job.activePhotoId);
        else job.failedPhotoIdsTruncated = true;
      }
      job.lastCheckpoint = { cursor: job.cursor, outcome, leaseToken: token };
      delete job.activePhotoId;
      job.cursor += 1;
      job.updatedAt = new Date(this.now()).toISOString();
      if (job.cancelRequestedAt) job.status = 'cancelled';
      else if (job.cursor === job.photoIds.length)
        job.status = job.failed
          ? job.failed === job.cursor
            ? 'failed'
            : 'partial'
          : 'complete';
      if (job.status !== 'running') {
        delete job.leaseToken;
        delete job.leaseUntil;
        delete job.workerId;
      }
      return { job, result: job };
    });
  }
  async reconcileCompleted(
    id: string,
    ownerId: string,
    outcomes: ReadonlyMap<string, 'indexed' | 'empty'>,
  ): Promise<JobRecord> {
    return this.store.mutate(id, (job) => {
      if (!job || job.ownerId !== ownerId || job.type !== 'discover-library')
        throw new ApiError(
          404,
          'JOB_NOT_FOUND',
          'This processing job is not available.',
        );
      if (['queued', 'running'].includes(job.status)) throw conflict();
      if (
        job.photoIds.some(
          (id) => !['indexed', 'empty'].includes(outcomes.get(id) ?? ''),
        )
      )
        throw new ApiError(
          409,
          'JOB_NOT_COMPLETE',
          'Some photos still require processing.',
        );
      job.cursor = job.photoIds.length;
      job.indexed = job.photoIds.filter(
        (id) => outcomes.get(id) === 'indexed',
      ).length;
      job.empty = job.cursor - job.indexed;
      job.failed = 0;
      job.failedPhotoIds = [];
      job.status = 'complete';
      job.updatedAt = new Date(this.now()).toISOString();
      delete job.failedPhotoIdsTruncated;
      delete job.failureCode;
      delete job.activePhotoId;
      delete job.cancelRequestedAt;
      delete job.leaseToken;
      delete job.leaseUntil;
      delete job.workerId;
      delete job.lastCheckpoint;
      return { job, result: job };
    });
  }
  async fail(
    id: string,
    token: string,
    failureCode: NonNullable<JobRecord['failureCode']>,
  ): Promise<void> {
    await this.store.mutate(id, (record) => {
      const job = this.leased(record, token);
      job.status = job.cancelRequestedAt ? 'cancelled' : 'failed';
      job.failureCode = failureCode;
      job.updatedAt = new Date(this.now()).toISOString();
      delete job.leaseToken;
      delete job.leaseUntil;
      delete job.workerId;
      return { job, result: undefined };
    });
  }
  async cancel(id: string, ownerId: string): Promise<JobRecord> {
    return this.store.mutate(id, (job) => {
      if (!job || job.ownerId !== ownerId)
        throw new ApiError(
          404,
          'JOB_NOT_FOUND',
          'This processing job is not available.',
        );
      if (!['queued', 'running', 'interrupted'].includes(job.status))
        return { result: job };
      job.cancelRequestedAt = new Date(this.now()).toISOString();
      job.updatedAt = job.cancelRequestedAt;
      if (job.status !== 'running' || !job.activePhotoId) {
        job.status = 'cancelled';
        delete job.leaseToken;
        delete job.leaseUntil;
        delete job.workerId;
      }
      return { job, result: job };
    });
  }
}

export function publicJob(job: JobListEntry) {
  return {
    type: job.type,
    id: job.id,
    requestId: job.requestId,
    eventId: job.eventId,
    status: job.status,
    total: job.photoCount ?? job.photoIds?.length ?? 0,
    processed: job.cursor,
    indexed: job.indexed,
    ...(job.type === 'cloud-import'
      ? { imported: job.imported ?? 0, source: job.importSource?.provider }
      : {}),
    empty: job.empty,
    failed: job.failed,
    cancelRequested: Boolean(job.cancelRequestedAt),
    retryUncertain: job.retryUncertain === true,
    failureCode: job.failureCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
