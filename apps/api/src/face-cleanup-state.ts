import type { LibraryRecord } from './library.js';

/** Unknown provider outcomes require scope erasure, not an empty DeleteFaces call. */
export function uncertainFaceIndex(photo: LibraryRecord): boolean {
  return (
    photo.kind === 'photo' &&
    (photo.indexState === 'queued' ||
      photo.indexState === 'failed' ||
      (photo.indexState === 'ready' && !photo.faceIds?.length) ||
      Boolean(photo.provider && !photo.indexState && !photo.faceIds?.length))
  );
}
