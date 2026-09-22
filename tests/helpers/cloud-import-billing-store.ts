import type {
  BillingKind,
  BillingStore,
  BillingTransaction,
} from '../../apps/api/src/billing/model.js';
import type { EventBillingTransaction } from '../../apps/api/src/billing/event-entitlements.js';
import type { LibraryRecord } from '../../apps/api/src/library.js';
import { syncSuppressionId } from '../../apps/api/src/folder-sync-suppression.js';
export class ImportTestBillingStore implements BillingStore {
  suppressions = new Set<string>();
  syncs = new Map<
    string,
    import('../../apps/api/src/folder-sync.js').FolderSync
  >();
  events = new Map<string, LibraryRecord>();
  rows = new Map<
    string,
    { owner: string; kind: BillingKind; value: unknown }
  >();
  private tail: Promise<unknown> = Promise.resolve();
  transaction<T>(work: (tx: BillingTransaction) => Promise<T>): Promise<T> {
    const task = this.tail.then(async () => {
      const draft = structuredClone(this.rows);
      const eventDraft = structuredClone(this.events);
      const syncDraft = structuredClone(this.syncs);
      const suppressionDraft = new Set(this.suppressions);
      const tx: BillingTransaction & EventBillingTransaction = {
        folderSyncs: {
          suppressed: async (photo) =>
            suppressionDraft.has(
              syncSuppressionId(photo.folderSyncId!, photo.sourcePhotoId!),
            ),
          suppress: async (photo) => {
            suppressionDraft.add(
              syncSuppressionId(photo.folderSyncId!, photo.sourcePhotoId!),
            );
          },
          update: async (record) => {
            syncDraft.set(record.id, structuredClone(record));
          },
          listEvent: async (owner, eventId) =>
            [...syncDraft.values()]
              .filter((row) => row.ownerId === owner && row.eventId === eventId)
              .map((row) => structuredClone(row)),
          create: async (record) => {
            if (syncDraft.has(record.id)) throw new Error('Duplicate sync');
            syncDraft.set(record.id, structuredClone(record));
          },
          get: async (id) => structuredClone(syncDraft.get(id) ?? null),
          touch: async (record) => {
            syncDraft.set(record.id, structuredClone(record));
          },
        },
        events: {
          putImport: async (record) => {
            eventDraft.set(record.id, structuredClone(record));
          },
          get: async (id) => structuredClone(eventDraft.get(id) ?? null),
          putMembership: async (record) => {
            eventDraft.set(record.id, structuredClone(record));
          },
          putPhoto: async (record) => {
            eventDraft.set(record.id, structuredClone(record));
          },
          list: async (owner) =>
            [...eventDraft.values()]
              .filter((row) => row.ownerId === owner && row.kind === 'event')
              .map((row) => structuredClone(row)),
          put: async (event) => {
            eventDraft.set(event.id, structuredClone(event));
          },
        },
        get: async <V>(id: string) =>
          structuredClone(draft.get(id)?.value ?? null) as V | null,
        list: async <V>(owner: string, kind: BillingKind) =>
          [...draft.values()]
            .filter((row) => row.owner === owner && row.kind === kind)
            .map((row) => structuredClone(row.value) as V),
        put: async (id, owner, kind, value) => {
          draft.set(id, { owner, kind, value: structuredClone(value) });
        },
      };
      const result = await work(tx);
      this.rows = draft;
      this.suppressions = suppressionDraft;
      this.syncs.clear();
      for (const [id, sync] of syncDraft) this.syncs.set(id, sync);
      this.events.clear();
      for (const [id, event] of eventDraft) this.events.set(id, event);
      return result;
    });
    this.tail = task.catch(() => {});
    return task;
  }
}
