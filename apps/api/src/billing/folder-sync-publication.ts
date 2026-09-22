import { ApiError } from '../auth.js';
import { cloudPhotoId } from '../cloud-photo-import.js';
import type { FolderSync } from '../folder-sync.js';
import type { LibraryRecord } from '../library.js';
import { stableScanId } from '../scan-photo-preparation.js';
import {
  billingId,
  type BillingAccount,
  type BillingTransaction,
  type StorageReservation,
} from './model.js';
import {
  organizerEventPolicy,
  type EventBillingTransaction,
} from './event-entitlements.js';
import { commitMemberPhoto } from './event-memberships.js';

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
    sync.membershipGrantId ?? null,
    sync.folderId,
    sync.createdAt,
    sync.pending?.requestId,
    sync.pending?.attemptId,
    sync.pending?.preservedFileIndexes,
    [...(sync.pending?.fileIds ?? [])].sort(),
  ]);

/** Called inside the SAME transaction as the sync/event/account authority writes. */
export async function commitFolderSyncPhoto(
  tx: BillingTransaction,
  namespace: string,
  account: BillingAccount,
  snapshot: FolderSync,
  rootSnapshot: LibraryRecord,
  photo: LibraryRecord,
) {
  const records = tx as BillingTransaction & Partial<EventBillingTransaction>;
  if (!records.folderSyncs || !records.events?.putPhoto)
    throw new ApiError(
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Transactional folder imports are not configured.',
    );
  const sync = await records.folderSyncs.get(snapshot.id);
  if (
    !sync ||
    sync.status !== 'active' ||
    !sync.pending ||
    identity(sync) !== identity(snapshot) ||
    account.ownerId !== sync.ownerId ||
    account.deletionPendingAt
  )
    throw unavailable();
  const root = await records.events.get(rootSnapshot.id);
  const expectedRootId = stableScanId(
    'folder-sync-import',
    sync.id + ':' + sync.pending.requestId,
  );
  if (
    !root ||
    root.id !== expectedRootId ||
    root.ownerId !== sync.ownerId ||
    root.kind !== 'job' ||
    root.purpose !== 'import' ||
    root.processingSource !== 'cloud' ||
    root.source !== sync.provider ||
    root.eventId !== sync.eventId ||
    root.folderSyncId !== sync.id ||
    root.processingRequestId !==
      (sync.pending.attemptId ?? sync.pending.requestId) ||
    root.uploadedBy !== sync.actorId ||
    root.membershipGrantId !== sync.membershipGrantId ||
    root.deletionStartedAt
  )
    throw unavailable();
  const fileId = sync.pending.fileIds.find(
    (id) => cloudPhotoId(root.id, id) === photo.id,
  );
  if (
    !fileId ||
    photo.kind !== 'photo' ||
    photo.scanId ||
    photo.ownerId !== sync.ownerId ||
    photo.eventId !== sync.eventId ||
    photo.importId !== root.id ||
    photo.folderSyncId !== sync.id ||
    photo.uploadedBy !== sync.actorId ||
    photo.source !== sync.provider ||
    photo.sourcePhotoId !==
      stableScanId('cloud-import-source', sync.provider + ':' + fileId) ||
    !photo.storageReservationId ||
    !photo.digest ||
    !Number.isSafeInteger(photo.bytes) ||
    photo.bytes! <= 0 ||
    !photo.expiresAt ||
    !Number.isFinite(Date.parse(photo.expiresAt)) ||
    Date.parse(photo.expiresAt) <= Date.now()
  )
    throw unavailable();
  const intent = await records.events.get(photo.id);
  if (await records.folderSyncs.suppressed(photo)) throw unavailable();
  if (
    !intent ||
    intent.storageReservationId !== photo.storageReservationId ||
    intent.folderSyncId !== sync.id ||
    intent.importId !== root.id
  )
    throw unavailable();
  if (
    sync.pending.preservedFileIndexes?.includes(
      sync.pending.fileIds.indexOf(fileId),
    ) &&
    intent.kind !== 'photo'
  )
    throw unavailable();
  const reservation = await tx.get<StorageReservation>(
    // The original reservation remains the only charge for a reused photo.
    billingId(namespace, 'storage', photo.storageReservationId),
  );
  if (
    !reservation ||
    reservation.ownerId !== sync.ownerId ||
    reservation.photoId !== photo.storageReservationId ||
    reservation.scope !== 'organizer' ||
    reservation.status !== 'reserved' ||
    reservation.bytes !== photo.bytes
  )
    throw unavailable();
  const policy = await organizerEventPolicy(tx, namespace, sync.ownerId, true);
  if (!policy.entitlement)
    throw new ApiError(
      402,
      'ORGANIZER_REQUIRED',
      'An active organizer plan is required for automatic imports.',
    );
  if (sync.actorId !== sync.ownerId) {
    const id = billingId(namespace, 'account', sync.actorId);
    const actor = (await tx.get<BillingAccount>(id)) ?? {
      ownerId: sync.actorId,
      revision: 0,
      createdAt: new Date().toISOString(),
      subscriptions: {},
    };
    if (actor.ownerId !== sync.actorId || actor.deletionPendingAt)
      throw unavailable();
    await tx.put(id, `${namespace}:${sync.actorId}`, 'account', {
      ...actor,
      revision: actor.revision + 1,
    });
  }
  await records.folderSyncs.touch(sync);
  // This checks current membership, upload intent and event expiry, clips retention,
  // and touches event/account rows before publishing the photo in this transaction.
  return commitMemberPhoto(
    tx,
    namespace,
    sync.ownerId,
    account,
    sync.actorId,
    sync.membershipGrantId ?? 'owner',
    photo,
  );
}
