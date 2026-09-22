import { Client, Query, TablesDB } from 'node-appwrite';
import { ApiError } from '../auth.js';
import { folderSyncTransaction } from './appwrite-folder-sync.js';
import { assertSyncJobCreation } from '../folder-sync-job-policy.js';
import { guardEventImportJob } from './event-import-job-guard.js';
import { guardImportAccounts } from './job-account-guard.js';
import type { JobListEntry, JobRecord, JobStore } from '../jobs.js';
import {
  decodeJobRow,
  decodeManifest,
  encodeManifestJob,
  hasManifest,
  makeManifest,
  manifestContents,
  manifestHash,
  summarizeJob,
  type JobEnvelope,
  type ManifestContents,
  type ManifestRow,
} from '../job-manifest.js';

interface Config {
  endpoint: string;
  projectId: string;
  apiKey: string;
  databaseId?: string;
  tableId?: string;
  manifestTableId?: string;
  billingNamespace?: 'test_mode' | 'live_mode';
}
export class AppwriteJobStore implements JobStore {
  private readonly db: TablesDB;
  private readonly databaseId: string;
  private readonly tableId: string;
  private readonly manifestTableId: string;
  private readonly billingNamespace: 'test_mode' | 'live_mode' | undefined;
  private readonly manifests = new Map<
    string,
    { ownerId: string; fingerprint: string; contents: ManifestContents }
  >();
  constructor(config: Config, tables?: TablesDB) {
    this.db =
      tables ??
      new TablesDB(
        new Client()
          .setEndpoint(config.endpoint)
          .setProject(config.projectId)
          .setKey(config.apiKey),
      );
    this.databaseId = config.databaseId ?? 'picfind-library';
    this.tableId = config.tableId ?? 'processing-jobs';
    this.manifestTableId = config.manifestTableId ?? 'processing-manifests';
    this.billingNamespace = config.billingNamespace;
  }
  private async envelope(
    id: string,
    transactionId?: string,
  ): Promise<JobEnvelope | undefined> {
    let row;
    try {
      row = await this.db.getRow({
        databaseId: this.databaseId,
        tableId: this.tableId,
        rowId: id,
        ...(transactionId ? { transactionId } : {}),
      });
    } catch (error) {
      if ((error as { code?: number }).code === 404) return undefined;
      throw error;
    }
    return decodeJobRow(row);
  }
  private async manifestRows(job: JobEnvelope, transactionId?: string) {
    const result = await this.db.listRows({
      databaseId: this.databaseId,
      tableId: this.manifestTableId,
      queries: [
        Query.equal('ownerId', job.ownerId),
        Query.equal('jobId', job.id),
        Query.orderAsc('partIndex'),
        Query.limit(100),
      ],
      ...(transactionId ? { transactionId } : {}),
    });
    return result.rows as unknown as ManifestRow[];
  }
  private async hydrate(
    job: JobEnvelope,
    transactionId?: string,
  ): Promise<JobRecord> {
    if (!hasManifest(job)) return job;
    const key = job.id + ':' + job.manifest.digest;
    let cached = this.manifests.get(key);
    if (
      cached &&
      (cached.ownerId !== job.ownerId || cached.fingerprint !== job.fingerprint)
    )
      throw new ApiError(
        503,
        'JOB_STORAGE_INVALID',
        'Processing metadata needs repair.',
      );
    if (!cached) {
      cached = {
        ownerId: job.ownerId,
        fingerprint: job.fingerprint,
        contents: decodeManifest(
          job,
          await this.manifestRows(job, transactionId),
        ),
      };
      if (this.manifests.size >= 16)
        this.manifests.delete(this.manifests.keys().next().value!);
      this.manifests.set(key, cached);
    }
    const { manifest: _manifest, ...metadata } = job;
    void _manifest;
    return {
      ...metadata,
      photoIds: [...cached.contents.photoIds],
      retryUncertainPhotoIds: [...cached.contents.retryUncertainPhotoIds],
    };
  }
  async list(ownerId: string, eventId?: string): Promise<JobListEntry[]> {
    const jobs: JobListEntry[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.db.listRows({
        databaseId: this.databaseId,
        tableId: this.tableId,
        queries: [
          Query.equal('ownerId', ownerId),
          ...(eventId ? [Query.equal('eventId', eventId)] : []),
          Query.orderAsc('$id'),
          Query.limit(100),
          ...(cursor ? [Query.cursorAfter(cursor)] : []),
        ],
      });
      for (const row of result.rows) {
        const job = decodeJobRow(row);
        if (job.ownerId !== ownerId || (eventId && job.eventId !== eventId))
          throw new ApiError(
            503,
            'JOB_STORAGE_INVALID',
            'Processing metadata needs repair.',
          );
        jobs.push(summarizeJob(job));
      }
      if (result.rows.length < 100) return jobs;
      const next = result.rows.at(-1)?.$id;
      if (!next || next === cursor)
        throw new Error('Job pagination did not advance.');
      cursor = next;
    }
    throw new ApiError(
      503,
      'JOB_HISTORY_LIMIT',
      'Processing history needs archival before this operation can finish.',
    );
  }
  async get(id: string): Promise<JobRecord | undefined> {
    const job = await this.envelope(id);
    return job ? this.hydrate(job) : undefined;
  }
  async candidates(
    before: string,
    limit: number,
    types?: readonly JobRecord['type'][],
  ): Promise<JobListEntry[]> {
    if (!types) return this.unfilteredCandidates(before, limit);
    if (!types.length) return [];
    const selected: JobListEntry[] = [];
    const maximum = Math.max(1, Math.min(100, limit));
    let cursor: string | undefined;
    // Types live in the versioned payload, so walk candidate pages rather than
    // starving imports behind the first page of paused face-processing jobs.
    for (let page = 0; page < 100; page++) {
      const result = await this.db.listRows({
        databaseId: this.databaseId,
        tableId: this.tableId,
        queries: [
          Query.equal('status', ['queued', 'running']),
          Query.lessThanEqual('availableAt', before),
          Query.orderAsc('availableAt'),
          Query.orderAsc('$id'),
          Query.limit(100),
          ...(cursor ? [Query.cursorAfter(cursor)] : []),
        ],
      });
      for (const row of result.rows) {
        const job = summarizeJob(decodeJobRow(row));
        if (types.includes(job.type)) selected.push(job);
        if (selected.length === maximum) return selected;
      }
      if (result.rows.length < 100) return selected;
      const next = result.rows.at(-1)?.$id;
      if (!next || next === cursor)
        throw new Error('Job candidate pagination did not advance.');
      cursor = next;
    }
    throw new ApiError(
      503,
      'JOB_CANDIDATE_LIMIT',
      'Processing backlog needs attention before this worker can continue.',
    );
  }
  private async unfilteredCandidates(
    before: string,
    limit: number,
  ): Promise<JobListEntry[]> {
    const result = await this.db.listRows({
      databaseId: this.databaseId,
      tableId: this.tableId,
      queries: [
        Query.equal('status', ['queued', 'running']),
        Query.lessThanEqual('availableAt', before),
        Query.orderAsc('availableAt'),
        Query.limit(Math.max(1, Math.min(100, limit))),
      ],
    });
    return result.rows.map((row) => summarizeJob(decodeJobRow(row)));
  }
  private async transaction<T>(
    operation: (id: string) => Promise<{ result: T; changed: boolean }>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const transaction = await this.db.createTransaction({ ttl: 60 });
      try {
        const change = await operation(transaction.$id);
        await this.db.updateTransaction({
          transactionId: transaction.$id,
          ...(change.changed ? { commit: true } : { rollback: true }),
        });
        return change.result;
      } catch (error) {
        await this.db
          .updateTransaction({ transactionId: transaction.$id, rollback: true })
          .catch(() => {});
        if ((error as { code?: number }).code === 409 && attempt < 4) {
          await new Promise((resolve) =>
            setTimeout(resolve, 20 * (attempt + 1)),
          );
          continue;
        }
        throw error;
      }
    }
    throw new ApiError(
      503,
      'JOB_STORAGE_BUSY',
      'Processing is busy. Retry shortly.',
    );
  }
  async mutate<T>(
    id: string,
    operation: (job: JobRecord | undefined) => { job?: JobRecord; result: T },
  ): Promise<T> {
    return this.transaction(async (transactionId) => {
      const envelope = await this.envelope(id, transactionId);
      const existing = envelope
        ? await this.hydrate(envelope, transactionId)
        : undefined;
      const change = operation(existing);
      if (!change.job) return { result: change.result, changed: false };
      const job = change.job;
      if (!envelope) {
        await guardImportAccounts(
          this.db,
          this.databaseId,
          transactionId,
          job,
          this.billingNamespace,
        );
        await guardEventImportJob(this.db, this.databaseId, transactionId, job);
      }
      if (!envelope && job.importSource?.folderSyncId) {
        if (this.databaseId !== 'picfind-library')
          throw new ApiError(
            503,
            'SYNC_JOB_UNAVAILABLE',
            'Sync jobs require the private PicFind library database.',
          );
        const sources = folderSyncTransaction(this.db, transactionId);
        const sync = await sources.get(job.importSource.folderSyncId);
        assertSyncJobCreation(sync, job);
        await sources.touch(sync!);
      }
      if (
        job.id !== id ||
        (envelope &&
          (envelope.ownerId !== job.ownerId ||
            envelope.eventId !== job.eventId ||
            envelope.fingerprint !== job.fingerprint))
      )
        throw new Error('Job identity cannot change.');
      let reference;
      if (envelope && hasManifest(envelope)) {
        reference = envelope.manifest;
        if (manifestHash(manifestContents(job)) !== reference.digest)
          throw new Error('A job photo snapshot cannot change.');
      } else {
        const manifest = makeManifest(job);
        reference = manifest.reference;
        for (const part of manifest.chunks)
          await this.db.createRow({
            databaseId: this.databaseId,
            tableId: this.manifestTableId,
            rowId: part.id,
            permissions: [],
            transactionId,
            data: {
              ownerId: job.ownerId,
              jobId: job.id,
              partIndex: part.index,
              payload: part.payload,
            },
          });
      }
      const data = {
        ownerId: job.ownerId,
        eventId: job.eventId,
        status: job.status,
        availableAt: job.availableAt,
        payload: JSON.stringify(encodeManifestJob(job, reference)),
      };
      if (envelope)
        await this.db.updateRow({
          databaseId: this.databaseId,
          tableId: this.tableId,
          rowId: id,
          data,
          transactionId,
        });
      else
        await this.db.createRow({
          databaseId: this.databaseId,
          tableId: this.tableId,
          rowId: id,
          data,
          permissions: [],
          transactionId,
        });
      return { result: change.result, changed: true };
    });
  }
  async remove(id: string): Promise<void> {
    await this.transaction(async (transactionId) => {
      const job = await this.envelope(id, transactionId);
      if (!job) return { result: undefined, changed: false };
      if (hasManifest(job)) {
        for (const part of await this.manifestRows(job, transactionId)) {
          if (part.ownerId !== job.ownerId || part.jobId !== job.id)
            throw new ApiError(
              503,
              'JOB_STORAGE_INVALID',
              'Processing metadata needs repair.',
            );
          await this.db.deleteRow({
            databaseId: this.databaseId,
            tableId: this.manifestTableId,
            rowId: part.$id,
            transactionId,
          });
        }
      }
      await this.db.deleteRow({
        databaseId: this.databaseId,
        tableId: this.tableId,
        rowId: id,
        transactionId,
      });
      return { result: undefined, changed: true };
    });
    for (const key of this.manifests.keys())
      if (key.startsWith(id + ':')) this.manifests.delete(key);
  }
}
