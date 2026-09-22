import type {
  FaceMatchingProvider,
  Scope,
} from '../../../packages/shared/src/ports.js';
import { ApiError } from './auth.js';
import { uncertainFaceIndex } from './face-cleanup-state.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { photoAvailable } from './retention.js';
import { suppressSyncPhotoBeforeErase } from './folder-sync-suppression.js';

export async function tolerateMissingFaceOperation(
  operation: () => Promise<void>,
) {
  try {
    await operation();
  } catch (error) {
    if (
      !(error instanceof ApiError && error.status === 404) &&
      !(error instanceof Error && error.name === 'ResourceNotFoundException')
    )
      throw error;
  }
}

/** Caller holds the account lock. Access is revoked before any external erasure. */
export async function deletePhotoSafely(
  store: LibraryStore,
  photo: LibraryRecord,
  matcher?: FaceMatchingProvider,
): Promise<'deleted' | 'pending'> {
  const hidden: LibraryRecord = {
    ...photo,
    expiresAt: new Date().toISOString(),
  };
  delete hidden.cleanupAfter;
  await store.put(hidden);
  try {
    const uncertain = uncertainFaceIndex(photo);
    await suppressSyncPhotoBeforeErase(store, hidden);
    const cloud = Boolean(photo.provider || photo.faceIds?.length || uncertain);
    const scope: Scope | undefined = photo.scanId
      ? { kind: 'scan', id: photo.scanId.replaceAll('-', '') }
      : photo.eventId
        ? { kind: 'event', id: photo.eventId }
        : undefined;
    if (cloud && (!matcher || !scope))
      throw new Error('Cloud cleanup is not available.');
    if (matcher && scope && uncertain) {
      const siblings = (await store.list(photo.ownerId, 'photo')).filter(
        (row) =>
          row.id !== photo.id &&
          (photo.scanId
            ? row.scanId === photo.scanId
            : row.eventId === photo.eventId),
      );
      if (siblings.some((row) => photoAvailable(row)))
        throw new Error(
          'Collection has current photos; preserve the erasure reference.',
        );
      await tolerateMissingFaceOperation(() => matcher.deleteScope(scope));
    } else if (matcher && scope && photo.faceIds?.length) {
      await tolerateMissingFaceOperation(() =>
        matcher.deleteFaces(scope, photo.faceIds!),
      );
    }
    await store.removeFile(photo.id);
    await store.remove(photo.id);
    return 'deleted';
  } catch {
    // The normal retention worker discovers and retries this hidden record.
    await store.put({
      ...hidden,
      cleanupAfter: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    return 'pending';
  }
}
