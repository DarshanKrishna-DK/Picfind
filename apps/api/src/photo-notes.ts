import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { photoAvailable } from './retention.js';
import type { PrivatePhotoNote } from '../../../packages/shared/src/photo-note.js';

function noteOf(photo: LibraryRecord): PrivatePhotoNote {
  return {
    text: photo.privatePhotoNote ?? '',
    version: photo.privatePhotoNoteVersion ?? 0,
    updatedAt: photo.privatePhotoNoteUpdatedAt ?? null,
  };
}

export function createPhotoNotes(
  getStore: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router();
  async function ownedPhoto(id: unknown, actor: string) {
    const parsed = z.uuid().safeParse(id);
    const missing = () =>
      new ApiError(404, 'NOT_FOUND', 'This photo is not available.');
    if (!parsed.success) throw missing();
    const photo = await getStore().get(parsed.data);
    if (
      photo.ownerId !== actor ||
      photo.deletionStartedAt ||
      !photoAvailable(photo)
    )
      throw missing();
    if (photo.eventId) {
      const event = await getStore().get(photo.eventId);
      if (
        event.kind !== 'event' ||
        event.ownerId !== actor ||
        event.deletionStartedAt
      )
        throw missing();
    }
    return photo;
  }
  router.get('/photos/:id/private-note', async (req, res) => {
    const photo = await ownedPhoto(req.params.id, await owner(req));
    res.json({ note: noteOf(photo) });
  });
  router.patch('/photos/:id/private-note', async (req, res) => {
    const actor = await owner(req);
    const data = z
      .object({
        text: z.string().trim().max(2000),
        version: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER - 1),
      })
      .strict()
      .safeParse(req.body);
    if (!data.success)
      throw new ApiError(
        400,
        'INVALID_PHOTO_NOTE',
        'Keep the note under 2,000 characters and load its current version.',
      );
    const note = await withAccountLock(actor, async () => {
      const photo = await ownedPhoto(req.params.id, actor);
      if ((photo.privatePhotoNoteVersion ?? 0) !== data.data.version)
        throw new ApiError(
          409,
          'PHOTO_NOTE_CHANGED',
          'Another tab changed this photo note. Your draft has not been saved. Load the latest note before saving again.',
        );
      const updated: LibraryRecord = {
        ...photo,
        privatePhotoNote: data.data.text,
        privatePhotoNoteVersion: data.data.version + 1,
        privatePhotoNoteUpdatedAt: new Date().toISOString(),
      };
      await getStore().put(updated);
      return noteOf(updated);
    });
    res.json({ note });
  });
  return router;
}
