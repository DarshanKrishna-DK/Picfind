import {
  AppwriteException,
  Client,
  Query,
  TablesDB,
  type Models,
} from 'node-appwrite';
import { ApiError } from '../auth.js';
import { folderSyncTransaction } from './appwrite-folder-sync.js';
import type { LibraryRecord } from '../library.js';
import type { EventBillingTransaction } from '../billing/event-entitlements.js';
import type {
  BillingKind,
  BillingStore,
  BillingTransaction,
} from '../billing/model.js';

type Row = Models.Row & { ownerId: string; kind: BillingKind; payload: string };
export class AppwriteBillingStore implements BillingStore {
  private readonly db: TablesDB;
  constructor(config: { endpoint: string; projectId: string; apiKey: string }) {
    this.db = new TablesDB(
      new Client()
        .setEndpoint(config.endpoint)
        .setProject(config.projectId)
        .setKey(config.apiKey),
    );
  }
  async accountPage(after?: string) {
    if (after && !/^[a-f0-9]{36}$/.test(after))
      throw new ApiError(
        503,
        'BILLING_CURSOR_INVALID',
        'Billing recovery requires maintenance.',
      );
    try {
      const result = await this.db.listRows<Row>({
        databaseId: 'picfind-library',
        tableId: 'billing',
        queries: [
          Query.equal('kind', 'account'),
          Query.orderAsc('$id'),
          Query.limit(25),
          ...(after ? [Query.greaterThan('$id', after)] : []),
        ],
      });
      let previous = after ?? '';
      if (result.rows.length > 25) throw new Error('Oversized page');
      const items = result.rows.map((row) => {
        if (
          row.kind !== 'account' ||
          !/^[a-f0-9]{36}$/.test(row.$id) ||
          row.$id <= previous ||
          typeof row.ownerId !== 'string'
        )
          throw new Error('Invalid account page');
        previous = row.$id;
        return { id: row.$id, ownerKey: row.ownerId };
      });
      return { items, end: result.rows.length < 25 };
    } catch {
      throw new ApiError(
        503,
        'BILLING_DISCOVERY_UNAVAILABLE',
        'Billing account discovery is unavailable.',
      );
    }
  }
  async transaction<T>(
    work: (tx: BillingTransaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      let transactionId: string | undefined;
      try {
        transactionId = (await this.db.createTransaction({ ttl: 60 })).$id;
        const params = {
          databaseId: 'picfind-library',
          tableId: 'billing',
          transactionId,
        };
        const seen = new Map<string, boolean>();
        // TablesDB list queries may omit staged creates. Overlay our own writes.
        const pending = new Map<
          string,
          { ownerId: string; kind: BillingKind; payload: string }
        >();
        const get = async <V>(id: string): Promise<V | null> => {
          if (pending.has(id)) return JSON.parse(pending.get(id)!.payload) as V;
          try {
            const row = await this.db.getRow<Row>({ ...params, rowId: id });
            seen.set(id, true);
            return JSON.parse(row.payload) as V;
          } catch (error) {
            if (error instanceof AppwriteException && error.code === 404) {
              seen.set(id, false);
              return null;
            }
            throw error;
          }
        };
        const eventSeen = new Map<string, boolean>();
        const eventPending = new Map<string, LibraryRecord>();
        const eventParams = { ...params, tableId: 'records' };
        const getEvent = async (id: string): Promise<LibraryRecord | null> => {
          if (eventPending.has(id))
            return structuredClone(eventPending.get(id)!);
          try {
            const row = await this.db.getRow<Models.Row & { payload: string }>({
              ...eventParams,
              rowId: id,
            });
            eventSeen.set(id, true);
            return JSON.parse(row.payload) as LibraryRecord;
          } catch (error) {
            if (error instanceof AppwriteException && error.code === 404) {
              eventSeen.set(id, false);
              return null;
            }
            throw error;
          }
        };
        const putRecord = async (record: LibraryRecord) => {
          if (!eventSeen.has(record.id)) await getEvent(record.id);
          const data = {
            ownerId: record.ownerId,
            kind: record.kind,
            payload: JSON.stringify(record),
            purgeAt:
              record.kind === 'photo' ? (record.expiresAt ?? null) : null,
          };
          if (data.payload.length > 15000)
            throw new ApiError(
              503,
              'EVENT_ACCOUNTING_UNAVAILABLE',
              'Event metadata exceeds its safety boundary.',
            );
          if (eventSeen.get(record.id))
            await this.db.updateRow({
              ...eventParams,
              rowId: record.id,
              data,
              permissions: [],
            });
          else
            await this.db.createRow({
              ...eventParams,
              rowId: record.id,
              data,
              permissions: [],
            });
          eventSeen.set(record.id, true);
          eventPending.set(record.id, structuredClone(record));
        };
        const tx: BillingTransaction & EventBillingTransaction = {
          folderSyncs: folderSyncTransaction(this.db, transactionId),
          events: {
            putImport: async (record) => {
              if (
                record.kind !== 'job' ||
                record.purpose !== 'import' ||
                record.processingSource !== 'cloud' ||
                !record.eventId
              )
                throw new Error('Invalid event import');
              await putRecord(record);
            },
            get: getEvent,
            putMembership: async (record) => {
              if (
                record.kind !== 'job' ||
                record.purpose !== 'event-membership' ||
                !record.eventId
              )
                throw new Error('Invalid membership record');
              await putRecord(record);
            },
            putPhoto: async (record) => {
              if (record.kind !== 'photo' || !record.eventId || record.scanId)
                throw new Error('Invalid event photograph');
              await putRecord(record);
            },
            list: async (ownerId) => {
              const values = new Map<string, LibraryRecord>();
              let cursor: string | undefined;
              for (let page = 0; page < 100; page++) {
                const result = await this.db.listRows<
                  Models.Row & {
                    ownerId: string;
                    kind: string;
                    payload: string;
                  }
                >({
                  ...eventParams,
                  queries: [
                    Query.equal('ownerId', ownerId),
                    Query.equal('kind', 'event'),
                    Query.orderAsc('$id'),
                    Query.limit(100),
                    ...(cursor ? [Query.cursorAfter(cursor)] : []),
                  ],
                });
                for (const row of result.rows) {
                  if (row.ownerId !== ownerId || row.kind !== 'event') continue;
                  const event = JSON.parse(row.payload) as LibraryRecord;
                  if (
                    event.id !== row.$id ||
                    event.ownerId !== ownerId ||
                    event.kind !== 'event'
                  )
                    throw new ApiError(
                      503,
                      'EVENT_ACCOUNTING_UNAVAILABLE',
                      'Event metadata needs maintenance.',
                    );
                  eventSeen.set(row.$id, true);
                  values.set(row.$id, event);
                }
                if (result.rows.length < 100) {
                  for (const [id, event] of eventPending)
                    if (event.ownerId === ownerId && event.kind === 'event')
                      values.set(id, event);
                  return [...values.values()];
                }
                const next = result.rows.at(-1)!.$id;
                if (next === cursor)
                  throw new Error('Event pagination did not advance');
                cursor = next;
              }
              throw new ApiError(
                503,
                'EVENT_ACCOUNTING_UNAVAILABLE',
                'Event history exceeds the accounting safety boundary.',
              );
            },
            put: async (event) => {
              if (event.kind !== 'event')
                throw new Error(
                  'Only event records may be written by event accounting',
                );
              if (!eventSeen.has(event.id)) await getEvent(event.id);
              const data = {
                ownerId: event.ownerId,
                kind: 'event',
                payload: JSON.stringify(event),
                purgeAt: null,
              };
              if (data.payload.length > 15000)
                throw new ApiError(
                  503,
                  'EVENT_ACCOUNTING_UNAVAILABLE',
                  'Event metadata exceeds its safety boundary.',
                );
              if (eventSeen.get(event.id))
                await this.db.updateRow({
                  ...eventParams,
                  rowId: event.id,
                  data,
                });
              else
                await this.db.createRow({
                  ...eventParams,
                  rowId: event.id,
                  data,
                  permissions: [],
                });
              eventSeen.set(event.id, true);
              eventPending.set(event.id, structuredClone(event));
            },
          },
          get,
          list: async <V>(ownerId: string, kind: BillingKind) => {
            const values = new Map<string, V>();
            let cursor: string | undefined;
            for (let page = 0; page < 100; page++) {
              const result = await this.db.listRows<Row>({
                ...params,
                queries: [
                  Query.equal('ownerId', ownerId),
                  Query.equal('kind', kind),
                  Query.orderAsc('$id'),
                  Query.limit(100),
                  ...(cursor ? [Query.cursorAfter(cursor)] : []),
                ],
              });
              // Staged rows can be returned without the requested query filters.
              // Recheck both boundaries before parsing a row as the requested kind.
              for (const row of result.rows) {
                if (row.ownerId !== ownerId || row.kind !== kind) continue;
                seen.set(row.$id, true);
                values.set(row.$id, JSON.parse(row.payload) as V);
              }
              if (result.rows.length < 100) {
                for (const [id, row] of pending)
                  if (row.ownerId === ownerId && row.kind === kind)
                    values.set(id, JSON.parse(row.payload) as V);
                return [...values.values()];
              }
              cursor = result.rows.at(-1)!.$id;
            }
            throw new ApiError(
              503,
              'BILLING_CAPACITY',
              'Billing history requires maintenance before further processing.',
            );
          },
          put: async (id, ownerId, kind, value) => {
            if (!seen.has(id)) await get(id);
            const data = { ownerId, kind, payload: JSON.stringify(value) };
            if (data.payload.length > 15000)
              throw new ApiError(
                503,
                'BILLING_CAPACITY',
                'The billing record requires maintenance.',
              );
            if (seen.get(id))
              await this.db.updateRow({ ...params, rowId: id, data });
            else
              await this.db.createRow({
                ...params,
                rowId: id,
                data,
                permissions: [],
              });
            seen.set(id, true);
            pending.set(id, data);
          },
        };
        const result = await work(tx);
        await this.db.updateTransaction({ transactionId, commit: true });
        return result;
      } catch (error) {
        if (transactionId)
          await this.db
            .updateTransaction({ transactionId, rollback: true })
            .catch(() => {});
        if (
          error instanceof AppwriteException &&
          error.code === 409 &&
          attempt < 3
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, 30 * 2 ** attempt + Math.random() * 30),
          );
          continue;
        }
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          503,
          'BILLING_STORAGE_UNAVAILABLE',
          'Billing storage is unavailable. No unverified credits were granted. Please retry.',
        );
      }
    }
    throw new ApiError(503, 'BILLING_BUSY', 'Billing is busy. Please retry.');
  }
}
