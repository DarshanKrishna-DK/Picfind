import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import type { libraryCapacity } from './capacity.js';
import { assertEventImportOpen } from './event-import-policy.js';
import { photoAvailable } from './retention.js';
import { withAccountLock } from './locks.js';
import {
  PREFLIGHT_ACTOR,
  preflightCommand,
  preflightReport,
} from '../../../packages/shared/src/upload-preflight.js';

export function createUploadPreflight(
  store: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
  limits: ReturnType<typeof libraryCapacity>,
  requireAccounting: () => void,
) {
  const router = Router();
  router.post('/photos/preflight', async (req, res) => {
    const actor = await owner(req);
    if (req.get(PREFLIGHT_ACTOR) !== actor)
      throw new ApiError(
        409,
        'PREFLIGHT_ACCOUNT_CHANGED',
        'The signed-in account changed. Refresh before checking this batch.',
      );
    const parsed = preflightCommand.safeParse(req.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'PREFLIGHT_INVALID',
        'Check up to 100 unique supported file fingerprints.',
      );
    const command = parsed.data;
    const report = await withAccountLock(actor, async () => {
      requireAccounting();
      async function destination() {
        if (!command.eventId) return;
        const event = await store().get(command.eventId);
        if (
          event.id !== command.eventId ||
          event.kind !== 'event' ||
          event.ownerId !== actor
        )
          throw new ApiError(
            404,
            'PREFLIGHT_OWNER_REQUIRED',
            'This capacity check is available to the event owner. Existing upload permissions still apply.',
          );
        assertEventImportOpen(event);
        if (event.deletionCompletedAt)
          throw new ApiError(
            409,
            'EVENT_UNAVAILABLE',
            'This event is no longer available.',
          );
      }
      await destination();
      const photos = (await store().list(actor, 'photo')).filter(
        (row) => row.ownerId === actor && row.kind === 'photo',
      );
      function reusable(photo: LibraryRecord, digest: string) {
        return (
          photo.ownerId === actor &&
          photo.kind === 'photo' &&
          photo.eventId === (command.eventId ?? undefined) &&
          photo.scanId === undefined &&
          !photo.deletionStartedAt &&
          !photo.deletionCompletedAt &&
          photoAvailable(photo) &&
          photo.uploadInputDigest === digest
        );
      }
      const candidates = new Map<string, LibraryRecord>();
      for (const photo of photos)
        if (
          photo.uploadInputDigest &&
          reusable(photo, photo.uploadInputDigest) &&
          !candidates.has(photo.uploadInputDigest)
        )
          candidates.set(photo.uploadInputDigest, photo);
      const items: {
        id: string;
        status: 'reusable' | 'new-candidate';
        inputBytes: number;
      }[] = [];
      // Bounded concurrent reads, preserving the original queue order.
      for (let offset = 0; offset < command.items.length; offset += 8) {
        items.push(
          ...(await Promise.all(
            command.items.slice(offset, offset + 8).map(async (item) => {
              const candidate = candidates.get(item.digest);
              let confirmed = false;
              if (candidate) {
                try {
                  const current = await store().get(candidate.id);
                  confirmed =
                    current.id === candidate.id &&
                    reusable(current, item.digest);
                } catch (error) {
                  if (!(error instanceof ApiError && error.status === 404))
                    throw error;
                }
              }
              return {
                id: item.id,
                status: confirmed
                  ? ('reusable' as const)
                  : ('new-candidate' as const),
                inputBytes: item.size,
              };
            }),
          )),
        );
      }
      await destination();
      // Counts include retained metadata just as the actual upload safety check does.
      const libraryCount = limits.production
        ? photos.length
        : photos.filter((row) => !row.scanId).length;
      const librarySlotsRemaining = Math.max(
        0,
        limits.libraryPhotos - libraryCount,
      );
      const eventSlotsRemaining =
        command.eventId === null
          ? null
          : Math.max(
              0,
              limits.eventPhotos -
                photos.filter(
                  (row) =>
                    row.eventId === command.eventId &&
                    !row.scanId &&
                    photoAvailable(row),
                ).length,
            );
      const newItems = items.filter((item) => item.status === 'new-candidate');
      return preflightReport.parse({
        requestId: command.requestId,
        requestDigest: createHash('sha256')
          .update(JSON.stringify(command))
          .digest('hex'),
        accountId: actor,
        eventId: command.eventId,
        checkedAt: new Date().toISOString(),
        items,
        reusable: items.length - newItems.length,
        newCandidates: newItems.length,
        inputBytes: items.reduce((total, item) => total + item.inputBytes, 0),
        newInputBytes: newItems.reduce(
          (total, item) => total + item.inputBytes,
          0,
        ),
        librarySlotsRemaining,
        eventSlotsRemaining,
        photoSlotsFit:
          newItems.length <= librarySlotsRemaining &&
          (eventSlotsRemaining === null ||
            newItems.length <= eventSlotsRemaining),
        outputStorageVerified: false,
        reservationCreated: false,
      });
    });
    res.json(report);
  });
  return router;
}
