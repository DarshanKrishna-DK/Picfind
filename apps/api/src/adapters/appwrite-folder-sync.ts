import { createHash } from 'node:crypto';
import {
  AppwriteException,
  Client,
  Query,
  TablesDB,
  type Models,
} from 'node-appwrite';
import { z } from 'zod';
import { ApiError } from '../auth.js';
import {
  SYNC_PAGE_SIZE,
  type FolderSync,
  type FolderSyncStore,
} from '../folder-sync.js';
import { validImportFileId } from '../import-policy.js';
import {
  syncPhotoProvenance,
  syncSuppressionId,
} from '../folder-sync-suppression.js';
import type { LibraryRecord } from '../library.js';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/);
const schema = z
  .object({
    consentPolicyVersion: z.literal('folder-sync-v1').optional(),
    resumeRequestId: z.uuid().optional(),
    cleanupRequestedAt: z.iso.datetime().optional(),
    cleanupAccountId: id.optional(),
    cleanupRedactedAt: z.iso.datetime().optional(),
    id,
    ownerId: id,
    actorId: id,
    eventId: z.uuid(),
    provider: z.enum(['drive', 'dropbox', 'onedrive', 'box']),
    generation: z.uuid(),
    membershipGrantId: z.uuid().optional(),
    folderId: z.string().min(1).max(2048),
    status: z.enum(['active', 'paused', 'expired', 'attention']),
    createdAt: z.iso.datetime(),
    nextRunAt: z.iso.datetime(),
    cursor: z.string().min(1).max(8192).nullable(),
    pages: z.number().int().min(0).max(2000),
    imported: z.number().int().nonnegative(),
    leaseToken: z.uuid().optional(),
    leaseUntil: z.iso.datetime().optional(),
    error: z
      .enum([
        'source-changed',
        'access-changed',
        'import-attention',
        'folder-limit',
        'invalid-page',
        'temporary',
      ])
      .optional(),
    pending: z
      .object({
        requestId: z.uuid(),
        attemptId: z.uuid().optional(),
        preservedFileIndexes: z
          .array(
            z
              .number()
              .int()
              .min(0)
              .max(SYNC_PAGE_SIZE - 1),
          )
          .max(SYNC_PAGE_SIZE)
          .optional(),
        fileIds: z
          .array(z.string().refine(validImportFileId))
          .min(1)
          .max(SYNC_PAGE_SIZE),
        nextCursor: z.string().min(1).max(8192).nullable(),
        batchId: id.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const invalid = () =>
  new ApiError(
    503,
    'SYNC_STORAGE_INVALID',
    'Folder sync storage needs maintenance.',
  );
export function validateFolderSync(value: unknown): FolderSync {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid();
  const row = parsed.data;
  if (
    row.cleanupAccountId &&
    (!row.cleanupRequestedAt ||
      ![row.ownerId, row.actorId].includes(row.cleanupAccountId))
  )
    throw invalid();
  if (
    Boolean(row.leaseToken) !== Boolean(row.leaseUntil) ||
    (row.actorId === row.ownerId
      ? Boolean(row.membershipGrantId)
      : !row.membershipGrantId) ||
    (row.pending &&
      new Set(row.pending.fileIds).size !== row.pending.fileIds.length)
  )
    throw invalid();
  if (
    row.pending?.preservedFileIndexes &&
    (new Set(row.pending.preservedFileIndexes).size !==
      row.pending.preservedFileIndexes.length ||
      row.pending.preservedFileIndexes.some(
        (index) => index >= row.pending!.fileIds.length,
      ))
  )
    throw invalid();
  // Stored JSON omits optional undefined fields, including nested batchId.
  return JSON.parse(JSON.stringify(row)) as FolderSync;
}
const receiptId = (syncId: string, fileId: string) =>
  createHash('sha256')
    .update(JSON.stringify([syncId, fileId]))
    .digest('hex')
    .slice(0, 36);
const identity = (row: FolderSync) =>
  JSON.stringify([
    row.id,
    row.ownerId,
    row.actorId,
    row.eventId,
    row.provider,
    row.generation,
    row.membershipGrantId,
    row.folderId,
    row.createdAt,
    row.consentPolicyVersion,
  ]);
type Row = Models.Row & {
  ownerId: string;
  actorId: string;
  eventId: string;
  status: string;
  nextRunAt: string;
  payload: string;
};
function decode(row: Row): FolderSync {
  let value: FolderSync;
  try {
    value = validateFolderSync(JSON.parse(row.payload));
  } catch {
    throw invalid();
  }
  if (
    value.id !== row.$id ||
    value.ownerId !== row.ownerId ||
    value.actorId !== row.actorId ||
    value.eventId !== row.eventId ||
    value.status !== row.status ||
    Date.parse(value.nextRunAt) !== Date.parse(row.nextRunAt)
  )
    throw invalid();
  return value;
}
/** Shares the billing transaction: publication must conflict with pause/delete. */
export function folderSyncTransaction(db: TablesDB, transactionId: string) {
  const base = {
    databaseId: 'picfind-library',
    tableId: 'folder-syncs',
    transactionId,
  };
  const loaded = new Map<string, FolderSync>();
  async function suppressed(photo: LibraryRecord) {
    if (!photo.folderSyncId || !photo.sourcePhotoId) throw invalid();
    try {
      const row = await db.getRow<
        Models.Row & { ownerId: string; syncId: string }
      >({
        ...base,
        tableId: 'folder-sync-files',
        rowId: syncSuppressionId(photo.folderSyncId, photo.sourcePhotoId),
      });
      if (row.ownerId !== photo.ownerId || row.syncId !== photo.folderSyncId)
        throw invalid();
      return true;
    } catch (error) {
      if (error instanceof AppwriteException && error.code === 404)
        return false;
      throw error;
    }
  }
  return {
    suppressed,
    async suppress(photo: LibraryRecord) {
      if (await suppressed(photo)) return;
      await db.createRow({
        ...base,
        tableId: 'folder-sync-files',
        rowId: syncSuppressionId(photo.folderSyncId!, photo.sourcePhotoId!),
        permissions: [],
        data: { ownerId: photo.ownerId, syncId: photo.folderSyncId! },
      });
    },
    async update(input: FolderSync) {
      const record = validateFolderSync(input),
        original = loaded.get(record.id);
      if (!original || identity(original) !== identity(record)) throw invalid();
      const payload = JSON.stringify(record);
      if (Buffer.byteLength(payload) > 60_000) throw invalid();
      await db.updateRow({
        ...base,
        rowId: record.id,
        permissions: [],
        data: {
          ownerId: record.ownerId,
          actorId: record.actorId,
          eventId: record.eventId,
          status: record.status,
          nextRunAt: record.nextRunAt,
          payload,
        },
      });
    },
    async listEvent(ownerId: string, eventId: string) {
      const result = await db.listRows<Row>({
        ...base,
        queries: [
          Query.equal('ownerId', ownerId),
          Query.equal('eventId', eventId),
          Query.limit(33),
        ],
      });
      return result.rows.map((raw) => {
        const record = decode(raw);
        if (record.ownerId !== ownerId || record.eventId !== eventId)
          throw invalid();
        return record;
      });
    },
    async create(input: FolderSync) {
      const record = validateFolderSync(input);
      await db.createRow({
        ...base,
        rowId: record.id,
        permissions: [],
        data: {
          ownerId: record.ownerId,
          actorId: record.actorId,
          eventId: record.eventId,
          status: record.status,
          nextRunAt: record.nextRunAt,
          payload: JSON.stringify(record),
        },
      });
    },
    async get(id: string): Promise<FolderSync | null> {
      try {
        const record = decode(await db.getRow<Row>({ ...base, rowId: id }));
        loaded.set(id, structuredClone(record));
        return record;
      } catch (error) {
        if (error instanceof AppwriteException && error.code === 404)
          return null;
        throw error;
      }
    },
    async touch(record: FolderSync) {
      const original = loaded.get(record.id);
      if (!original || JSON.stringify(original) !== JSON.stringify(record))
        throw invalid();
      const payload = JSON.stringify(validateFolderSync(record));
      if (Buffer.byteLength(payload) > 60_000) throw invalid();
      await db.updateRow({
        ...base,
        rowId: record.id,
        permissions: [],
        data: {
          ownerId: record.ownerId,
          actorId: record.actorId,
          eventId: record.eventId,
          status: record.status,
          nextRunAt: record.nextRunAt,
          payload,
        },
      });
    },
  };
}
export class AppwriteFolderSyncStore implements FolderSyncStore {
  private readonly db: TablesDB;
  private readonly base = {
    databaseId: 'picfind-library',
    tableId: 'folder-syncs',
  };
  constructor(
    config: { endpoint: string; projectId: string; apiKey: string },
    db?: TablesDB,
  ) {
    this.db =
      db ??
      new TablesDB(
        new Client()
          .setEndpoint(config.endpoint)
          .setProject(config.projectId)
          .setKey(config.apiKey),
      );
  }
  private async read(id: string, transactionId?: string) {
    try {
      return decode(
        await this.db.getRow<Row>({
          ...this.base,
          rowId: id,
          ...(transactionId ? { transactionId } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof AppwriteException && error.code === 404)
        return undefined;
      throw error;
    }
  }
  get(id: string) {
    return this.read(id);
  }
  async cleanupCandidates(now: string, limit: number) {
    if (
      !Number.isFinite(Date.parse(now)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 8
    )
      throw invalid();
    const result = await this.db.listRows<Row>({
      ...this.base,
      queries: [
        Query.equal('status', 'expired'),
        Query.lessThanEqual('nextRunAt', now),
        Query.orderAsc('nextRunAt'),
        Query.limit(limit),
      ],
    });
    if (result.rows.length > limit) throw invalid();
    return result.rows.map((raw) => {
      const row = decode(raw);
      if (
        row.status !== 'expired' ||
        Date.parse(row.nextRunAt) > Date.parse(now)
      )
        throw invalid();
      return row;
    });
  }
  private async listIdentity(attribute: 'ownerId' | 'actorId', value: string) {
    const rows: FolderSync[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const result = await this.db.listRows<Row>({
        ...this.base,
        queries: [
          Query.equal(attribute, value),
          Query.orderAsc('$id'),
          Query.limit(100),
          ...(cursor ? [Query.cursorAfter(cursor)] : []),
        ],
      });
      for (const raw of result.rows) {
        const row = decode(raw);
        if (row[attribute] !== value) throw invalid();
        rows.push(row);
      }
      if (result.rows.length < 100) return rows;
      const next = result.rows.at(-1)!.$id;
      if (next === cursor) throw invalid();
      cursor = next;
    }
    throw invalid();
  }
  listOwner(owner: string) {
    return this.listIdentity('ownerId', owner);
  }
  listActor(actor: string) {
    return this.listIdentity('actorId', actor);
  }
  async purgePage(snapshot: FolderSync) {
    const transactionId = (await this.db.createTransaction({ ttl: 60 })).$id;
    try {
      const row = await this.read(snapshot.id, transactionId);
      if (!row) {
        await this.db.updateTransaction({ transactionId, commit: true });
        return true;
      }
      if (
        row.ownerId !== snapshot.ownerId ||
        row.eventId !== snapshot.eventId ||
        row.status !== 'expired' ||
        !row.cleanupRequestedAt
      )
        throw invalid();
      const receipts = await this.db.listRows<
        Models.Row & { ownerId: string; syncId: string }
      >({
        ...this.base,
        tableId: 'folder-sync-files',
        transactionId,
        queries: [
          Query.equal('ownerId', row.ownerId),
          Query.equal('syncId', row.id),
          Query.limit(25),
        ],
      });
      for (const receipt of receipts.rows) {
        if (receipt.ownerId !== row.ownerId || receipt.syncId !== row.id)
          throw invalid();
        await this.db.deleteRow({
          ...this.base,
          tableId: 'folder-sync-files',
          rowId: receipt.$id,
          transactionId,
        });
      }
      const complete = receipts.rows.length < 25;
      if (complete)
        await this.db.deleteRow({ ...this.base, rowId: row.id, transactionId });
      else
        await this.db.updateRow({
          ...this.base,
          rowId: row.id,
          transactionId,
          permissions: [],
          data: { payload: JSON.stringify(row) },
        });
      await this.db.updateTransaction({ transactionId, commit: true });
      return complete;
    } catch (error) {
      await this.db
        .updateTransaction({ transactionId, rollback: true })
        .catch(() => {});
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        503,
        'SYNC_CLEANUP_PENDING',
        'Private source cleanup will need another pass.',
      );
    }
  }
  async redactActor(snapshot: FolderSync) {
    const transactionId = (await this.db.createTransaction({ ttl: 60 })).$id;
    try {
      const row = await this.read(snapshot.id, transactionId);
      if (
        !row ||
        row.ownerId !== snapshot.ownerId ||
        row.actorId !== snapshot.actorId ||
        row.status !== 'expired' ||
        !row.cleanupRequestedAt
      )
        throw invalid();
      const record = {
        ...row,
        folderId: 'removed',
        cursor: null,
        cleanupRedactedAt: row.cleanupRedactedAt ?? new Date().toISOString(),
      };
      delete record.pending;
      delete record.leaseToken;
      delete record.leaseUntil;
      delete record.error;
      await this.db.updateRow({
        ...this.base,
        rowId: row.id,
        transactionId,
        permissions: [],
        data: { payload: JSON.stringify(validateFolderSync(record)) },
      });
      await this.db.updateTransaction({ transactionId, commit: true });
    } catch (error) {
      await this.db
        .updateTransaction({ transactionId, rollback: true })
        .catch(() => {});
      throw error;
    }
  }
  async isSuppressed(sync: FolderSync, fileId: string) {
    if (!validImportFileId(fileId)) throw invalid();
    try {
      const row = await this.db.getRow<
        Models.Row & { ownerId: string; syncId: string }
      >({
        ...this.base,
        tableId: 'folder-sync-files',
        rowId: syncSuppressionId(
          sync.id,
          syncPhotoProvenance(sync.provider, fileId),
        ),
      });
      if (row.ownerId !== sync.ownerId || row.syncId !== sync.id)
        throw invalid();
      return true;
    } catch (error) {
      if (error instanceof AppwriteException && error.code === 404)
        return false;
      throw error;
    }
  }
  async listEvent(ownerId: string, eventId: string) {
    const rows: FolderSync[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.db.listRows<Row>({
        ...this.base,
        queries: [
          Query.equal('ownerId', ownerId),
          Query.equal('eventId', eventId),
          Query.orderAsc('$id'),
          Query.limit(100),
          ...(cursor ? [Query.cursorAfter(cursor)] : []),
        ],
      });
      for (const raw of result.rows) {
        const record = decode(raw);
        if (record.ownerId !== ownerId || record.eventId !== eventId)
          throw invalid();
        rows.push(record);
      }
      if (result.rows.length < 100) return rows;
      const next = result.rows.at(-1)!.$id;
      if (next === cursor) throw invalid();
      cursor = next;
    }
    throw invalid();
  }
  async candidates(now: string, limit: number) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 8 ||
      !Number.isFinite(Date.parse(now))
    )
      throw invalid();
    const result = await this.db.listRows<Row>({
      ...this.base,
      queries: [
        Query.equal('status', 'active'),
        Query.lessThanEqual('nextRunAt', now),
        Query.orderAsc('nextRunAt'),
        Query.limit(limit),
      ],
    });
    if (result.rows.length > limit) throw invalid();
    return result.rows.map(decode);
  }
  async knownFiles(sync: FolderSync, files: string[]) {
    if (
      files.length > SYNC_PAGE_SIZE ||
      files.some((file) => !validImportFileId(file))
    )
      throw invalid();
    if (!files.length) return new Set<string>();
    const keys = new Map(
      files.flatMap((file) => [
        [receiptId(sync.id, file), file] as const,
        [
          syncSuppressionId(sync.id, syncPhotoProvenance(sync.provider, file)),
          file,
        ] as const,
      ]),
    );
    const result = await this.db.listRows<
      Models.Row & { ownerId: string; syncId: string }
    >({
      ...this.base,
      tableId: 'folder-sync-files',
      queries: [
        Query.equal('$id', [...keys.keys()]),
        Query.equal('ownerId', sync.ownerId),
        Query.equal('syncId', sync.id),
        Query.limit(SYNC_PAGE_SIZE * 2),
      ],
    });
    const known = new Set<string>();
    for (const row of result.rows) {
      const file = keys.get(row.$id);
      if (!file || row.ownerId !== sync.ownerId || row.syncId !== sync.id)
        throw invalid();
      known.add(file);
    }
    return known;
  }
  async mutate<T>(
    syncId: string,
    operation: Parameters<FolderSyncStore['mutate']>[1] &
      ((record: FolderSync | undefined) => {
        record?: FolderSync;
        remember?: string[];
        result: T;
      }),
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const transactionId = (await this.db.createTransaction({ ttl: 60 })).$id;
      try {
        const previous = await this.read(syncId, transactionId);
        const change = operation(
          previous ? structuredClone(previous) : undefined,
        );
        if (change.record) {
          const record = validateFolderSync(change.record);
          if (
            record.id !== syncId ||
            (previous && identity(record) !== identity(previous))
          )
            throw invalid();
          const files = change.remember ?? [];
          if (
            files.length > SYNC_PAGE_SIZE ||
            new Set(files).size !== files.length ||
            files.some((file) => !previous?.pending?.fileIds.includes(file))
          )
            throw invalid();
          for (const file of files) {
            const rowId = receiptId(syncId, file);
            let exists = false;
            try {
              const receipt = await this.db.getRow<
                Models.Row & { syncId: string; ownerId: string }
              >({
                ...this.base,
                tableId: 'folder-sync-files',
                rowId,
                transactionId,
              });
              if (
                receipt.syncId !== syncId ||
                receipt.ownerId !== record.ownerId
              )
                throw invalid();
              exists = true;
            } catch (error) {
              if (!(error instanceof AppwriteException && error.code === 404))
                throw error;
            }
            if (!exists)
              await this.db.createRow({
                ...this.base,
                tableId: 'folder-sync-files',
                rowId,
                transactionId,
                data: { syncId, ownerId: record.ownerId },
                permissions: [],
              });
          }
          const payload = JSON.stringify(record);
          if (Buffer.byteLength(payload) > 60000) throw invalid();
          const params = {
            ...this.base,
            rowId: syncId,
            transactionId,
            data: {
              ownerId: record.ownerId,
              actorId: record.actorId,
              eventId: record.eventId,
              status: record.status,
              nextRunAt: record.nextRunAt,
              payload,
            },
            permissions: [],
          };
          if (previous) await this.db.updateRow(params);
          else await this.db.createRow(params);
        } else if (change.remember?.length) throw invalid();
        await this.db.updateTransaction({ transactionId, commit: true });
        return change.result as T;
      } catch (error) {
        await this.db
          .updateTransaction({ transactionId, rollback: true })
          .catch(() => {});
        if (
          error instanceof AppwriteException &&
          error.code === 409 &&
          attempt < 3
        )
          continue;
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          503,
          'SYNC_STORAGE_UNAVAILABLE',
          'Folder sync storage is unavailable. Retry without starting a new import.',
        );
      }
    }
    throw invalid();
  }
}
