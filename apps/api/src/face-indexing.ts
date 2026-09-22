import type {
  FaceMatchingProvider,
  Scope,
} from '../../../packages/shared/src/ports.js';
import { ApiError } from './auth.js';
import { mapFaceError } from './face-errors.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { assertPhotoAvailable, photoAvailable } from './retention.js';
import type { ProductScope } from './billing/product-scope.js';

export interface IndexingDependencies {
  providerName: string;
  reserveUsage(
    ownerId: string,
    operation: 'index',
    context: ProductScope,
  ): Promise<void>;
}
export function requiresUncertainRetry(photo: LibraryRecord): boolean {
  return Boolean(
    photo.provider &&
    (photo.indexState === 'queued' || photo.indexState === 'failed'),
  );
}
export function createPhotoIndexer(dependencies: IndexingDependencies) {
  async function indexPhotoRecord(
    matcher: FaceMatchingProvider,
    library: LibraryStore,
    photo: LibraryRecord,
    scope: Scope,
    consentRecordId: string,
    authorization: {
      retryUncertain?: boolean;
      assertLease?: () => Promise<void>;
    } = {},
  ) {
    if (
      photo.kind !== 'photo' ||
      (scope.kind === 'event'
        ? photo.eventId !== scope.id || Boolean(photo.scanId)
        : Boolean(photo.eventId) ||
          !photo.scanId ||
          photo.scanId.replaceAll('-', '') !== scope.id)
    )
      throw new ApiError(
        409,
        'COLLECTION_MISMATCH',
        'This photo does not belong to the requested collection.',
      );
    assertPhotoAvailable(photo);
    if (requiresUncertainRetry(photo) && !authorization.retryUncertain)
      throw new ApiError(
        409,
        'RETRY_UNCERTAIN_REQUIRED',
        'A previous provider request may have completed. Explicitly authorize a new processing attempt before retrying this photo.',
      );
    if (
      photo.indexState === 'empty' ||
      (photo.indexState === 'ready' && photo.externalImageId)
    )
      return photo;
    const file = await library.file(photo.id);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let indexedRecord: LibraryRecord | undefined;
    let markerWriteStarted = false;
    let providerContacted = false;
    try {
      await authorization.assertLease?.();
      await dependencies.reserveUsage(
        photo.ownerId,
        'index',
        scope.kind === 'event' ? 'organizer' : 'personal',
      );
      // Persist uncertainty before contacting the provider, including crash recovery.
      markerWriteStarted = true;
      await library.put({
        ...photo,
        provider: dependencies.providerName ?? 'aws-rekognition',
        indexState: 'queued',
      });
      await authorization.assertLease?.();
      providerContacted = true;
      await matcher.ensureScope(scope);
      await authorization.assertLease?.();
      const result = await matcher.indexPhoto({
        scope,
        photoId: photo.id.replaceAll('-', ''),
        bytes,
        consentRecordId,
      });
      if (!photoAvailable(photo)) {
        await matcher.deleteFaces(scope, result.faceIds);
        throw new ApiError(
          410,
          'PHOTO_EXPIRED',
          'This photo expired while indexing and its new face references were removed.',
        );
      }
      const updated: LibraryRecord = {
        ...photo,
        provider: dependencies.providerName ?? 'aws-rekognition',
        modelVersion: result.modelVersion,
        faceIds: result.faceIds,
        externalImageId: result.externalImageId,
        indexState: result.faceIds.length ? 'ready' : 'empty',
      };
      if (result.unindexedReasons.length && !result.faceIds.length)
        updated.indexState = 'empty';
      indexedRecord = updated;
      await library.put(updated);
      return updated;
    } catch (error) {
      if (!providerContacted) {
        // A lost marker acknowledgement cannot imply a provider request was sent.
        if (markerWriteStarted) await library.put(photo).catch(() => {});
        mapFaceError(error);
      }
      if (indexedRecord) {
        // Reconcile a lost metadata acknowledgement without repeating a paid index call.
        try {
          await library.put(indexedRecord);
          return indexedRecord;
        } catch {
          /* Preserve the queued cleanup marker if storage is unavailable. */
        }
      }
      await library
        .put({
          ...(indexedRecord ?? photo),
          provider: dependencies.providerName ?? 'aws-rekognition',
          indexState: 'failed',
        })
        .catch(() => {});
      mapFaceError(error);
    } finally {
      bytes.fill(0);
    }
  }
  return indexPhotoRecord;
}
export type PhotoIndexer = ReturnType<typeof createPhotoIndexer>;
