import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { photoAvailable } from './retention.js';
import {
  storedAttributionSchema,
  type PhotoAttribution,
} from '../../../packages/shared/src/photo-attribution.js';

export function readPhotoCredit(photo: LibraryRecord): PhotoAttribution {
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
export async function ownedCreditPhoto(
  store: LibraryStore,
  id: unknown,
  actor: string,
  publishing = false,
) {
  const missing = () =>
    new ApiError(404, 'NOT_FOUND', 'This photo is not available.');
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw missing();
  const photo = await store.get(parsed.data);
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
    const event = await store.get(photo.eventId);
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
