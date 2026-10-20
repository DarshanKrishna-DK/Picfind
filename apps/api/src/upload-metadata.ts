import type { LibraryRecord } from './library.js';

/** Device upload acknowledgements never return private processing or proofing data. */
export function uploadMetadata(photo: LibraryRecord) {
  return {
    id: photo.id,
    ownerId: photo.ownerId,
    kind: photo.kind,
    createdAt: photo.createdAt,
    filename: photo.filename ?? 'photo.jpg',
    bytes: photo.bytes,
    width: photo.width,
    height: photo.height,
    expiresAt: photo.expiresAt,
    eventId: photo.eventId,
    uploadedBy: photo.uploadedBy,
  };
}
