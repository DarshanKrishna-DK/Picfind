import { createHash } from 'node:crypto';
import { ApiError } from '../auth.js';
import { assertEventImportOpen } from '../event-import-policy.js';
import type { FolderSync } from '../folder-sync.js';
import type { LibraryRecord } from '../library.js';
import { stableScanId } from '../scan-photo-preparation.js';
import type { BillingTransaction } from './model.js';
import type { EventBillingTransaction } from './event-entitlements.js';
import { authorizeFolderSync } from './folder-sync-policy.js';

const unavailable = () =>
  new ApiError(
    409,
    'IMPORT_UNAVAILABLE',
    'This automatic import is no longer authorized.',
  );
const identity = (sync: FolderSync) =>
  JSON.stringify([
    sync.id,
    sync.ownerId,
    sync.actorId,
    sync.eventId,
    sync.provider,
    sync.generation,
    sync.membershipGrantId,
    sync.folderId,
    sync.createdAt,
    sync.pending?.requestId,
    sync.pending?.attemptId,
    sync.pending?.preservedFileIndexes,
    [...(sync.pending?.fileIds ?? [])].sort(),
  ]);

/** The caller touches both billing accounts in this same transaction. */
export async function stageFolderSyncImport(
  tx: BillingTransaction,
  namespace: string,
  snapshot: FolderSync,
  candidate: LibraryRecord,
): Promise<LibraryRecord> {
  const records = tx as BillingTransaction & Partial<EventBillingTransaction>;
  const events = records.events,
    sources = records.folderSyncs;
  if (!events?.putImport || !sources)
    throw new ApiError(
      503,
      'EVENT_ACCOUNTING_UNAVAILABLE',
      'Transactional import staging is unavailable.',
    );
  const sync = await sources.get(snapshot.id);
  if (
    !sync ||
    sync.status !== 'active' ||
    sync.cleanupRequestedAt ||
    sync.consentPolicyVersion !== 'folder-sync-v1' ||
    !sync.pending ||
    identity(sync) !== identity(snapshot)
  )
    throw unavailable();
  await authorizeFolderSync(tx, namespace, sync);
  const event = await events.get(sync.eventId);
  if (!event || event.ownerId !== sync.ownerId) throw unavailable();
  assertEventImportOpen(event);
  const source = {
    provider: sync.provider,
    generation: sync.generation,
    destinationEventId: sync.eventId,
    folderSyncId: sync.id,
    ...(sync.actorId !== sync.ownerId
      ? { actorId: sync.actorId, membershipGrantId: sync.membershipGrantId! }
      : {}),
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([source, [...sync.pending.fileIds].sort()]))
    .digest('hex');
  const id = stableScanId(
    'folder-sync-import',
    sync.id + ':' + sync.pending.requestId,
  );
  const valid = (root: LibraryRecord) =>
    root.id === id &&
    root.ownerId === sync.ownerId &&
    root.kind === 'job' &&
    root.purpose === 'import' &&
    root.processingSource === 'cloud' &&
    root.source === sync.provider &&
    root.eventId === sync.eventId &&
    root.folderSyncId === sync.id &&
    root.uploadedBy === sync.actorId &&
    root.membershipGrantId === sync.membershipGrantId &&
    root.processingRequestId ===
      (sync.pending!.attemptId ?? sync.pending!.requestId) &&
    root.sourceFingerprint === fingerprint &&
    !root.deletionStartedAt;
  if (!valid(candidate)) throw unavailable();
  const existing = await events.get(id);
  if (existing && !valid(existing)) throw unavailable();
  await events.put(event);
  await sources.touch(sync);
  if (existing) return existing;
  const root: LibraryRecord = {
    id,
    ownerId: sync.ownerId,
    uploadedBy: sync.actorId,
    kind: 'job',
    purpose: 'import',
    processingSource: 'cloud',
    source: sync.provider,
    folderSyncId: sync.id,
    eventId: sync.eventId,
    ...(sync.membershipGrantId
      ? { membershipGrantId: sync.membershipGrantId }
      : {}),
    processingRequestId: sync.pending.attemptId ?? sync.pending.requestId,
    sourceFingerprint: fingerprint,
    createdAt: new Date().toISOString(),
    state: 'running',
    imported: 0,
    errors: [],
  };
  await events.putImport(root);
  return root;
}
