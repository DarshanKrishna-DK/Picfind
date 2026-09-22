import { randomUUID } from 'node:crypto';
import { ApiError } from './auth.js';
import type { BillingService } from './billing/service.js';
import { productBillingScope } from './billing/product-scope.js';
import { libraryCapacity } from './capacity.js';
import { assertEventImportOpen } from './event-import-policy.js';
import { assertImportActor } from './cloud-import-access.js';
import {
  createCloudFileReader,
  type CloudFileReader,
} from './cloud-file-reader.js';
import { MAX_INPUT_BYTES, processPhotoBytes, safeFilename } from './images.js';
import {
  validImportFileId,
  validImportSource,
  type ImportSource,
} from './import-policy.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { assertPhotoAvailable, photoExpiry } from './retention.js';
import { stableScanId } from './scan-photo-preparation.js';
import type { SourceConnections } from './source-connections.js';
import type { FolderSyncImportAuthority } from './folder-sync-imports.js';

export const cloudPhotoId = (importId: string, sourceId: string) =>
  stableScanId('cloud-import-photo', importId + ':' + sourceId);
export type ImportPhoto = (
  ownerId: string,
  importId: string,
  source: ImportSource,
  fileId: string,
  assertLease: () => Promise<void>,
) => Promise<LibraryRecord>;
export function createCloudPhotoImporter(
  store: LibraryStore,
  connections: Pick<SourceConnections, 'access'>,
  billing?: BillingService,
  limits = libraryCapacity(),
  read: CloudFileReader = createCloudFileReader(),
  syncImports?: FolderSyncImportAuthority,
): ImportPhoto {
  return async (ownerId, importId, source, fileId, assertLease) => {
    if (!validImportSource(source) || !validImportFileId(fileId))
      throw new ApiError(
        400,
        'INVALID_SOURCE',
        'This import selection is not valid.',
      );
    if (
      (limits.production || source.actorId || source.folderSyncId) &&
      !billing
    )
      throw new ApiError(
        503,
        'USAGE_ACCOUNTING_UNAVAILABLE',
        'Imports require storage accounting.',
      );
    if (source.folderSyncId && !syncImports)
      throw new ApiError(
        409,
        'IMPORT_UNAVAILABLE',
        'Automatic folder imports are not configured.',
      );
    const photoId = cloudPhotoId(importId, fileId);
    const provenance = stableScanId(
      'cloud-import-source',
      source.provider + ':' + fileId,
    );
    const destination = async () => {
      await assertLease();
      let root: LibraryRecord;
      try {
        root = await store.get(importId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404)
          throw new ApiError(
            409,
            'IMPORT_UNAVAILABLE',
            'This import is no longer available.',
          );
        throw error;
      }
      if (
        root.ownerId !== ownerId ||
        root.kind !== 'job' ||
        root.purpose !== 'import' ||
        root.processingSource !== 'cloud' ||
        root.source !== source.provider ||
        root.eventId !== source.destinationEventId ||
        root.deletionStartedAt
      )
        throw new ApiError(
          409,
          'IMPORT_UNAVAILABLE',
          'This import is no longer available.',
        );
      if (source.destinationEventId) {
        let event: LibraryRecord;
        try {
          event = await store.get(source.destinationEventId);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404)
            throw new ApiError(
              409,
              'EVENT_UNAVAILABLE',
              'The destination event is no longer available.',
            );
          throw error;
        }
        if (event.ownerId !== ownerId || event.kind !== 'event')
          throw new ApiError(
            409,
            'EVENT_UNAVAILABLE',
            'The destination event is no longer available.',
          );
        assertEventImportOpen(event);
        assertImportActor(source, root, event);
        if (source.folderSyncId)
          await syncImports!.assert(ownerId, root, source, fileId);
        return event;
      }
      assertImportActor(source, root);
    };
    await destination();
    const importSnapshot =
      source.destinationEventId && !source.folderSyncId
        ? await store.get(importId)
        : undefined;
    if (source.folderSyncId) {
      const root = await store.get(importId);
      // Acknowledge the previously imported, explicitly deleted file without
      // downloading it or creating any photo metadata or storage reservation.
      if (await syncImports!.suppressed(ownerId, root, source, fileId))
        return root;
    }
    let existing: LibraryRecord | undefined;
    try {
      existing = await store.get(photoId);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    if (existing) {
      if (
        existing.ownerId !== ownerId ||
        existing.importId !== importId ||
        existing.sourcePhotoId !== provenance ||
        existing.eventId !== source.destinationEventId ||
        existing.scanId
      )
        throw new ApiError(
          409,
          'IMPORT_STORAGE_INVALID',
          'This import needs storage repair.',
        );
      if (existing.kind !== 'photo')
        throw new ApiError(
          503,
          'UPLOAD_RECOVERY_REQUIRED',
          'An interrupted upload is awaiting cleanup. Resume after cleanup completes.',
        );
      assertPhotoAvailable(existing);
      return existing;
    }
    const rows = await store.list(ownerId, 'photo');
    if (
      rows.length >= limits.libraryPhotos ||
      (source.destinationEventId &&
        rows.filter(
          (row) => row.eventId === source.destinationEventId && !row.scanId,
        ).length >= limits.eventPhotos)
    )
      throw new ApiError(
        402,
        'PHOTO_LIMIT',
        'This library or event has reached its photo allowance.',
      );
    const access = await connections.access(
      source.actorId ?? ownerId,
      source.provider,
      source.generation,
    );
    const assertAccess = async () => {
      const event = await destination();
      await connections.access(
        source.actorId ?? ownerId,
        source.provider,
        source.generation,
      );
      return event;
    };
    const file = await read(
      source.provider,
      access.accessToken,
      fileId,
      async () => {
        await assertAccess();
      },
    );
    try {
      if (!file.bytes.length || file.bytes.length > MAX_INPUT_BYTES)
        throw new ApiError(
          413,
          'PHOTO_TOO_LARGE',
          'This source photo has an unsupported size.',
        );
      const output = await processPhotoBytes(file.bytes);
      try {
        const event = await assertAccess();
        const billingScope = productBillingScope(
          billing,
          event ? 'organizer' : 'personal',
        );
        const planExpiresAt = photoExpiry(
          billing ? await billing.retentionDays(ownerId, billingScope) : 7,
        );
        const eventExpiresAt = event?.expiresAt;
        const photo: LibraryRecord = {
          id: photoId,
          storageReservationId: randomUUID(),
          ownerId,
          importId,
          ...(source.folderSyncId ? { folderSyncId: source.folderSyncId } : {}),
          uploadedBy: source.actorId ?? ownerId,
          source: source.provider,
          sourcePhotoId: provenance,
          ...(source.destinationEventId
            ? { eventId: source.destinationEventId }
            : {}),
          kind: 'photo',
          createdAt: new Date().toISOString(),
          filename: safeFilename(file.name),
          indexState: 'none',
          expiresAt:
            eventExpiresAt &&
            Date.parse(eventExpiresAt) < Date.parse(planExpiresAt)
              ? eventExpiresAt
              : planExpiresAt,
          bytes: output.data.length,
          width: output.info.width,
          height: output.info.height,
          digest: output.digest,
        };
        const storedBytes = async () =>
          (await store.list(ownerId, 'photo')).reduce(
            (sum, row) => sum + (row.bytes ?? 0),
            0,
          );
        // An upload intent is durable before any storage reservation or file write.
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
            photo.storageReservationId!,
            output.data.length,
            storedBytes,
            billingScope,
          );
          await assertAccess();
          await store.upload(photoId, output.data);
          const currentEvent = await assertAccess();
          // The organizer can shorten retention while a source download is running.
          if (
            currentEvent?.expiresAt &&
            Date.parse(currentEvent.expiresAt) < Date.parse(photo.expiresAt!)
          )
            photo.expiresAt = currentEvent.expiresAt;
          if (source.folderSyncId) {
            const root = await store.get(importId);
            return await syncImports!.commit(ownerId, root, source, photo);
          }
          if (importSnapshot && billing)
            return await billing.commitEventImportPhoto(
              importSnapshot,
              source,
              fileId,
              photo,
            );
          await store.put(photo);
          return photo;
        } catch (error) {
          try {
            const saved = await store.get(photoId);
            if (
              saved.ownerId !== ownerId ||
              saved.importId !== importId ||
              saved.sourcePhotoId !== provenance ||
              saved.storageReservationId !== photo.storageReservationId
            )
              throw new Error('Import receipt mismatch');
            if (saved.kind === 'photo' && saved.digest === photo.digest)
              return saved;
            if (saved.kind !== 'job' || saved.purpose !== 'upload-cleanup')
              throw new Error('Import receipt needs repair');
            await store.removeFile(photoId);
            await billing?.releaseStorage(
              ownerId,
              photo.storageReservationId!,
              output.data.length,
              storedBytes,
              true,
            );
            await store.remove(photoId);
          } catch {
            /* Keep the cleanup intent when a storage commit cannot be established. */
          }
          throw error;
        }
      } finally {
        output.data.fill(0);
      }
    } finally {
      file.bytes.fill(0);
    }
  };
}
