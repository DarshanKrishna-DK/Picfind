import { Client, TablesDB } from 'node-appwrite';
import { ApiError } from '../auth.js';
import {
  SOURCE_PROVIDERS,
  sourceConnectionId,
  type SourceConnectionRecord,
  type SourceConnectionStore,
} from '../source-connections.js';

type Config = {
  endpoint: string;
  projectId: string;
  apiKey: string;
  databaseId?: string;
  tableId?: string;
};
const invalid = () =>
  new ApiError(
    503,
    'SOURCE_STORAGE_INVALID',
    'Cloud connection metadata needs repair.',
  );
export function decodeSourceConnection(row: {
  $id: string;
  [key: string]: unknown;
}): SourceConnectionRecord {
  try {
    if (typeof row.payload !== 'string' || row.payload.length > 64000)
      throw invalid();
    const value = JSON.parse(row.payload) as SourceConnectionRecord;
    if (
      !value ||
      typeof value.ownerId !== 'string' ||
      !value.ownerId ||
      value.ownerId.length > 64 ||
      !SOURCE_PROVIDERS.includes(value.provider) ||
      value.id !== row.$id ||
      value.id !== sourceConnectionId(value.ownerId, value.provider) ||
      row.ownerId !== value.ownerId ||
      row.provider !== value.provider ||
      typeof value.generation !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(value.generation) ||
      !['connected', 'refreshing', 'reconnect', 'disconnected'].includes(
        value.state,
      ) ||
      typeof value.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.updatedAt)) ||
      (value.authorizationAttempt !== undefined &&
        (typeof value.authorizationAttempt !== 'string' ||
          !/^[a-f0-9-]{36}$/i.test(value.authorizationAttempt))) ||
      (value.encryptedGrant !== undefined &&
        (typeof value.encryptedGrant !== 'string' ||
          value.encryptedGrant.length > 48000)) ||
      (['connected', 'refreshing'].includes(value.state) &&
        !value.encryptedGrant) ||
      (['disconnected', 'reconnect'].includes(value.state) &&
        value.encryptedGrant !== undefined) ||
      (value.refreshAttempt !== undefined &&
        (typeof value.refreshAttempt !== 'string' ||
          value.refreshAttempt.length > 64)) ||
      (value.lastRefreshAttempt !== undefined &&
        (typeof value.lastRefreshAttempt !== 'string' ||
          value.lastRefreshAttempt.length > 64)) ||
      (value.refreshStartedAt !== undefined &&
        (!Number.isFinite(value.refreshStartedAt) ||
          value.refreshStartedAt < 0)) ||
      (value.state === 'refreshing' &&
        (!value.refreshAttempt || value.refreshStartedAt === undefined))
    )
      throw invalid();
    return value;
  } catch {
    throw invalid();
  }
}
export class AppwriteSourceConnectionStore implements SourceConnectionStore {
  private readonly db: TablesDB;
  private readonly databaseId: string;
  private readonly tableId: string;
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
    this.tableId = config.tableId ?? 'source-connections';
  }
  private async read(id: string, transactionId?: string) {
    try {
      const row = await this.db.getRow({
        databaseId: this.databaseId,
        tableId: this.tableId,
        rowId: id,
        ...(transactionId ? { transactionId } : {}),
      });
      return decodeSourceConnection(row);
    } catch (error) {
      if ((error as { code?: number }).code === 404) return undefined;
      throw error;
    }
  }
  async get(id: string) {
    return this.read(id);
  }
  async mutate<T>(
    id: string,
    operation: (record: SourceConnectionRecord | undefined) => {
      record?: SourceConnectionRecord;
      result: T;
    },
  ): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const transaction = await this.db.createTransaction({ ttl: 60 });
      try {
        const current = await this.read(id, transaction.$id);
        const change = operation(current);
        if (change.record) {
          const record = change.record;
          if (
            record.id !== id ||
            (current &&
              (current.ownerId !== record.ownerId ||
                current.provider !== record.provider))
          )
            throw invalid();
          const data = {
            ownerId: record.ownerId,
            provider: record.provider,
            payload: JSON.stringify(record),
          };
          decodeSourceConnection({ $id: id, ...data });
          const args = {
            databaseId: this.databaseId,
            tableId: this.tableId,
            rowId: id,
            transactionId: transaction.$id,
            data,
          };
          if (current) await this.db.updateRow(args);
          else await this.db.createRow({ ...args, permissions: [] });
        }
        await this.db.updateTransaction({
          transactionId: transaction.$id,
          ...(change.record ? { commit: true } : { rollback: true }),
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
      'SOURCE_STORAGE_BUSY',
      'Cloud connections are busy. Retry shortly.',
    );
  }
  async remove(id: string) {
    try {
      await this.db.deleteRow({
        databaseId: this.databaseId,
        tableId: this.tableId,
        rowId: id,
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 404) throw error;
    }
  }
}
