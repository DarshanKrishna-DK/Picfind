import { ApiError } from './auth.js';
import type { LibraryRecord } from './library.js';

function incompatible() {
  return new ApiError(
    409,
    'FACE_INDEX_INCOMPATIBLE',
    'Saved face data does not match this processing provider or model. The organizer must repair or reindex the collection before face matching can continue.',
  );
}

/** Preserve old erasure references instead of silently changing their provider. */
export function assertIndexProvider(photo: LibraryRecord, provider: string) {
  const hasIndex = Boolean(
    photo.provider ||
    photo.modelVersion ||
    photo.externalImageId ||
    photo.faceIds?.length ||
    (photo.indexState && photo.indexState !== 'none'),
  );
  if (hasIndex && photo.provider !== provider) throw incompatible();
  if (
    ['ready', 'empty'].includes(photo.indexState ?? '') &&
    (typeof photo.modelVersion !== 'string' || !photo.modelVersion.trim())
  )
    throw incompatible();
  if (
    (photo.indexState === 'ready' && !photo.externalImageId) ||
    (photo.indexState === 'empty' && Boolean(photo.faceIds?.length))
  )
    throw incompatible();
}

/** Ready photos must use one format before any reference is sent for search. */
export function searchIndexVersion(photos: LibraryRecord[], provider: string) {
  if (!photos.length) throw incompatible();
  const versions = new Set<string>();
  for (const photo of photos) {
    assertIndexProvider(photo, provider);
    if (
      photo.indexState !== 'ready' ||
      !photo.externalImageId ||
      typeof photo.modelVersion !== 'string' ||
      !photo.modelVersion.trim()
    )
      throw incompatible();
    versions.add(photo.modelVersion);
  }
  if (versions.size !== 1) throw incompatible();
  return [...versions][0]!;
}

export function assertSearchModel(expected: string, actual: string) {
  if (!actual || actual !== expected) throw incompatible();
}
