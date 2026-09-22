import { ApiError } from '../auth.js';
import type { LibraryRecord } from '../library.js';
import type { BillingTransaction } from './model.js';
import type { EventBillingTransaction } from './event-entitlements.js';

export async function suppressFolderSyncPhoto(
  tx: BillingTransaction,
  photo: LibraryRecord,
) {
  const records = tx as BillingTransaction & Partial<EventBillingTransaction>;
  if (!records.events?.putPhoto || !records.folderSyncs)
    throw new ApiError(
      503,
      'SYNC_CLEANUP_PENDING',
      'Transactional source deletion is unavailable.',
    );
  const current = await records.events.get(photo.id);
  if (
    !current ||
    current.kind !== 'photo' ||
    current.ownerId !== photo.ownerId ||
    !current.folderSyncId ||
    current.folderSyncId !== photo.folderSyncId ||
    !current.sourcePhotoId ||
    current.sourcePhotoId !== photo.sourcePhotoId ||
    current.eventId !== photo.eventId ||
    current.importId !== photo.importId ||
    current.scanId
  )
    throw new ApiError(
      409,
      'SYNC_CLEANUP_PENDING',
      'This source photo needs maintenance before erasure.',
    );
  const sync = await records.folderSyncs.get(current.folderSyncId);
  if (
    !sync ||
    sync.ownerId !== current.ownerId ||
    sync.eventId !== current.eventId ||
    sync.actorId !== current.uploadedBy ||
    sync.provider !== current.source
  )
    throw new ApiError(
      409,
      'SYNC_CLEANUP_PENDING',
      'The source authority must remain available until photo erasure finishes.',
    );
  await records.folderSyncs.suppress(current);
  await records.folderSyncs.touch(sync);
  const hidden = { ...current, expiresAt: new Date().toISOString() };
  delete hidden.cleanupAfter;
  await records.events.putPhoto(hidden);
}
