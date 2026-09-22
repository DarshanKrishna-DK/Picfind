import { createHash } from 'node:crypto';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { stableScanId } from './scan-photo-preparation.js';

export const syncPhotoProvenance = (provider: string, fileId: string) =>
  stableScanId('cloud-import-source', provider + ':' + fileId);
export const syncSuppressionId = (syncId: string, sourcePhotoId: string) =>
  createHash('sha256')
    .update(JSON.stringify(['suppressed-photo', syncId, sourcePhotoId]))
    .digest('hex')
    .slice(0, 36);

/** Metadata must remain available until the permanent suppression is committed. */
export async function suppressSyncPhotoBeforeErase(
  store: LibraryStore,
  photo: LibraryRecord,
) {
  if (photo.kind !== 'photo' || !photo.folderSyncId) return;
  if (!store.suppressSyncPhoto)
    throw new ApiError(
      503,
      'SYNC_CLEANUP_PENDING',
      'This photo is hidden until its source deletion safeguard is available.',
    );
  await store.suppressSyncPhoto(photo);
}
