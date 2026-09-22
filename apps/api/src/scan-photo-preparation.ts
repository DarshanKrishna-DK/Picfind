import { createHash } from 'node:crypto';
import { ApiError } from './auth.js';
import type { BillingService } from './billing/service.js';
import { productBillingScope } from './billing/product-scope.js';
import { libraryCapacity } from './capacity.js';
import { MAX_INPUT_BYTES, processPhotoBytes, safeFilename } from './images.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { assertPhotoAvailable, photoExpiry } from './retention.js';

export function stableScanId(namespace: string, value: string) {
  const hex = createHash('sha256')
    .update(namespace + ':' + value)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export const scanPhotoId = (scanId: string, sourceId: string) =>
  stableScanId('scan-photo', scanId + ':' + sourceId);
export function createScanPhotoPreparer(
  store: LibraryStore,
  billing?: BillingService,
  limits = libraryCapacity(),
) {
  return async (
    ownerId: string,
    scanId: string,
    sourceId: string,
  ): Promise<LibraryRecord> => {
    if (limits.production && !billing)
      throw new ApiError(
        503,
        'USAGE_ACCOUNTING_UNAVAILABLE',
        'Photo preparation requires storage accounting.',
      );
    const id = scanPhotoId(scanId, sourceId);
    let existing: LibraryRecord | undefined;
    try {
      existing = await store.get(id);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    if (existing) {
      if (
        existing.ownerId !== ownerId ||
        existing.scanId !== scanId ||
        existing.eventId
      )
        throw new ApiError(
          404,
          'NOT_FOUND',
          'This prepared photo is not available.',
        );
      if (existing.kind !== 'photo')
        throw new ApiError(
          503,
          'UPLOAD_RECOVERY_REQUIRED',
          'An interrupted photo upload is awaiting cleanup. Retry preparation after cleanup completes.',
        );
      assertPhotoAvailable(existing);
      return existing;
    }
    const source = await store.get(sourceId);
    if (
      source.ownerId !== ownerId ||
      source.kind !== 'photo' ||
      source.scanId ||
      source.eventId
    )
      throw new ApiError(
        404,
        'NOT_FOUND',
        'The selected library photo is no longer available.',
      );
    assertPhotoAvailable(source);
    const photos = await store.list(ownerId, 'photo');
    if (
      (limits.production && photos.length >= limits.libraryPhotos) ||
      photos.filter((photo) => photo.scanId === scanId).length >=
        limits.eventPhotos
    )
      throw new ApiError(
        402,
        'PHOTO_LIMIT',
        'The photo capacity for this collection or account has been reached.',
      );
    if ((source.bytes ?? 0) > MAX_INPUT_BYTES)
      throw new ApiError(
        413,
        'PHOTO_TOO_LARGE',
        'This source photo exceeds the processing size limit.',
      );
    const response = await store.file(sourceId);
    if (!response.ok)
      throw new ApiError(
        503,
        'SOURCE_UNAVAILABLE',
        'The source photo could not be downloaded.',
      );
    const bytes = Buffer.from(await response.arrayBuffer());
    try {
      if (!bytes.length || bytes.length > MAX_INPUT_BYTES)
        throw new ApiError(
          413,
          'PHOTO_TOO_LARGE',
          'The source photo has an unsupported size.',
        );
      const output = await processPhotoBytes(bytes);
      try {
        const photo: LibraryRecord = {
          id,
          ownerId,
          scanId,
          sourcePhotoId: sourceId,
          kind: 'photo',
          createdAt: new Date().toISOString(),
          filename: safeFilename(source.filename ?? 'photo.jpg'),
          expiresAt: photoExpiry(
            billing
              ? await billing.retentionDays(
                  ownerId,
                  productBillingScope(billing, 'personal'),
                )
              : 7,
          ),
          bytes: output.data.length,
          width: output.info.width,
          height: output.info.height,
          digest: output.digest,
          indexState: 'none',
        };
        const storedBytes = async () =>
          (await store.list(ownerId, 'photo')).reduce(
            (sum, row) => sum + (row.bytes ?? 0),
            0,
          );
        await store.put(
          {
            ...photo,
            kind: 'job',
            purpose: 'upload-cleanup',
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          },
          true,
        );
        try {
          await billing?.reserveStorage(
            ownerId,
            id,
            output.data.length,
            storedBytes,
            productBillingScope(billing, 'personal'),
          );
          await store.upload(id, output.data);
          await store.put(photo);
          return photo;
        } catch (error) {
          try {
            const saved = await store.get(id);
            if (saved.ownerId !== ownerId || saved.scanId !== scanId)
              throw new Error('Preparation owner mismatch');
            if (saved.kind === 'photo' && saved.digest === photo.digest)
              return saved;
            if (saved.kind !== 'job' || saved.purpose !== 'upload-cleanup')
              throw new Error('Preparation needs repair');
            await store.removeFile(id);
            await billing?.releaseStorage(
              ownerId,
              id,
              output.data.length,
              storedBytes,
              true,
            );
            await store.remove(id);
          } catch {
            /* Preserve the durable cleanup intent when commit outcome is unknown. */
          }
          throw error;
        }
      } finally {
        output.data.fill(0);
      }
    } finally {
      bytes.fill(0);
    }
  };
}
export type ScanPhotoPreparer = ReturnType<typeof createScanPhotoPreparer>;
