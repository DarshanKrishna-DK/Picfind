import { ApiError } from '../auth.js';
import { cloudPhotoId } from '../cloud-photo-import.js';
import { assertImportActor } from '../cloud-import-access.js';
import type { ImportSource } from '../import-policy.js';
import type { LibraryRecord } from '../library.js';
import { stableScanId } from '../scan-photo-preparation.js';
import {
  billingId,
  type BillingAccount,
  type BillingTransaction,
  type StorageReservation,
} from './model.js';
import type { EventBillingTransaction } from './event-entitlements.js';
import { commitMemberPhoto } from './event-memberships.js';

/** Both account fences are checked/touched by the caller in this transaction. */
export async function commitEventImportPhoto(
  tx: BillingTransaction,
  namespace: string,
  account: BillingAccount,
  scope: 'legacy' | 'organizer',
  snapshot: LibraryRecord,
  source: ImportSource,
  fileId: string,
  photo: LibraryRecord,
) {
  const events = (tx as BillingTransaction & Partial<EventBillingTransaction>)
    .events;
  if (!events?.putPhoto || !events.putImport)
    throw new ApiError(
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Transactional event publication is unavailable.',
    );
  const unavailable = () =>
    new ApiError(
      409,
      'IMPORT_UNAVAILABLE',
      'This event import is no longer authorized.',
    );
  const root = await events.get(snapshot.id);
  if (
    !root ||
    !source.destinationEventId ||
    source.folderSyncId ||
    root.ownerId !== account.ownerId ||
    account.deletionPendingAt ||
    root.kind !== 'job' ||
    root.purpose !== 'import' ||
    root.processingSource !== 'cloud' ||
    root.eventId !== source.destinationEventId ||
    root.source !== source.provider ||
    root.folderSyncId ||
    root.deletionStartedAt ||
    !root.processingRequestId ||
    root.processingRequestId !== snapshot.processingRequestId ||
    root.sourceFingerprint !== snapshot.sourceFingerprint
  )
    throw unavailable();
  const event = await events.get(source.destinationEventId);
  if (!event || event.ownerId !== root.ownerId) throw unavailable();
  const actor = assertImportActor(source, root, event);
  if (
    photo.id !== cloudPhotoId(root.id, fileId) ||
    photo.kind !== 'photo' ||
    photo.scanId ||
    photo.ownerId !== root.ownerId ||
    photo.importId !== root.id ||
    photo.eventId !== event.id ||
    photo.folderSyncId ||
    photo.uploadedBy !== actor ||
    photo.source !== source.provider ||
    photo.sourcePhotoId !==
      stableScanId('cloud-import-source', source.provider + ':' + fileId) ||
    !photo.storageReservationId ||
    !photo.digest ||
    !Number.isSafeInteger(photo.bytes) ||
    photo.bytes! <= 0 ||
    !photo.expiresAt ||
    !Number.isFinite(Date.parse(photo.expiresAt)) ||
    Date.parse(photo.expiresAt) <= Date.now()
  )
    throw unavailable();
  const intent = await events.get(photo.id);
  if (
    !intent ||
    intent.storageReservationId !== photo.storageReservationId ||
    intent.importId !== root.id ||
    intent.sourcePhotoId !== photo.sourcePhotoId ||
    intent.folderSyncId
  )
    throw unavailable();
  const key = billingId(namespace, 'storage', photo.storageReservationId);
  const reservation = await tx.get<StorageReservation>(key);
  if (
    !reservation ||
    reservation.ownerId !== root.ownerId ||
    reservation.photoId !== photo.storageReservationId ||
    reservation.status !== 'reserved' ||
    reservation.bytes !== photo.bytes ||
    reservation.scope !== scope
  )
    throw unavailable();
  // Prevent cleanup/resume from winning between the final authority read and publish.
  await events.putImport(root);
  await tx.put(key, `${namespace}:${root.ownerId}`, 'event', reservation);
  return commitMemberPhoto(
    tx,
    namespace,
    root.ownerId,
    account,
    actor,
    source.membershipGrantId ?? 'owner',
    photo,
  );
}
