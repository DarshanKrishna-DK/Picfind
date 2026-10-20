import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { photoAvailable } from './retention.js';
import {
  attributionFields,
  storedAttributionSchema,
  type PhotoAttribution,
} from '../../../packages/shared/src/photo-attribution.js';

function readCredit(photo: LibraryRecord): PhotoAttribution {
  if (photo.attribution === undefined)
    return {
      name: '',
      website: '',
      published: false,
      version: 0,
      updatedAt: null,
    };
  const parsed = storedAttributionSchema.safeParse(photo.attribution);
  if (!parsed.success)
    throw new ApiError(
      503,
      'ATTRIBUTION_INVALID',
      'This photo needs attribution metadata repair before editing.',
    );
  return parsed.data;
}
export function createPhotoAttribution(
  getStore: () => LibraryStore,
  actorOf: (req: Request) => Promise<string>,
) {
  const router = Router();
  async function ownedPhoto(id: unknown, actor: string, publishing = false) {
    const missing = () =>
      new ApiError(404, 'NOT_FOUND', 'This photo is not available.');
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw missing();
    const photo = await getStore().get(parsed.data);
    if (
      photo.id !== parsed.data ||
      photo.kind !== 'photo' ||
      photo.ownerId !== actor ||
      photo.deletionStartedAt ||
      photo.deletionCompletedAt ||
      !photoAvailable(photo)
    )
      throw missing();
    if (photo.eventId) {
      const event = await getStore().get(photo.eventId);
      if (
        event.id !== photo.eventId ||
        event.kind !== 'event' ||
        event.ownerId !== actor ||
        event.deletionStartedAt
      )
        throw missing();
      if (
        publishing &&
        (event.archived ||
          (event.expiresAt && !(Date.parse(event.expiresAt) > Date.now())))
      )
        throw new ApiError(
          409,
          'EVENT_CLOSED',
          'Restore an open event before publishing photographer credit.',
        );
    }
    return photo;
  }
  router.get('/photos/:id/attribution', async (req, res) => {
    res.json({
      attribution: readCredit(
        await ownedPhoto(req.params.id, await actorOf(req)),
      ),
    });
  });
  router.patch('/photos/:id/attribution', async (req, res) => {
    const actor = await actorOf(req);
    const input = z
      .object({
        name: z.unknown(),
        website: z.unknown(),
        published: z.unknown(),
        version: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER - 2),
      })
      .strict()
      .safeParse(req.body);
    const fields = input.success
      ? attributionFields.safeParse({
          name: input.data.name,
          website: input.data.website,
          published: input.data.published,
        })
      : null;
    if (!input.success || !fields?.success)
      throw new ApiError(
        400,
        'INVALID_ATTRIBUTION',
        'Use a credit name up to 100 characters, an optional HTTPS website without credentials, and the current version. Publishing requires a name.',
      );
    const result = await withAccountLock(actor, async () => {
      const photo = await ownedPhoto(
        req.params.id,
        actor,
        fields.data.published,
      );
      const current = readCredit(photo);
      const same =
        current.name === fields.data.name &&
        current.website === fields.data.website &&
        current.published === fields.data.published;
      if (
        same &&
        (current.version === input.data.version ||
          current.version === input.data.version + 1)
      )
        return current;
      if (current.version !== input.data.version)
        throw new ApiError(
          409,
          'ATTRIBUTION_CHANGED',
          'Another edit changed this photographer credit. Load the latest version before saving.',
        );
      const attribution = {
        ...fields.data,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      const fresh = await ownedPhoto(
        req.params.id,
        actor,
        fields.data.published,
      );
      const latest = readCredit(fresh);
      if (JSON.stringify(latest) !== JSON.stringify(current))
        throw new ApiError(
          409,
          'ATTRIBUTION_CHANGED',
          'Photographer credit changed while saving. Load the latest version.',
        );
      await getStore().put({ ...fresh, attribution });
      return attribution;
    });
    res.json({ attribution: result });
  });
  return router;
}
