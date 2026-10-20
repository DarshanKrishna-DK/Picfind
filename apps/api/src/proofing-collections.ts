import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { photoAvailable } from './retention.js';
import {
  PROOFING_COLLECTION_LIMIT,
  PROOFING_COLLECTION_PHOTO_LIMIT,
  type ProofingCollection,
} from '../../../packages/shared/src/proofing-collection.js';

const draft = z.object({
  title: z.string().trim().min(1).max(100),
  photoIds: z.array(z.uuid()).min(1).max(PROOFING_COLLECTION_PHOTO_LIMIT),
});
const version = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const missing = () =>
  new ApiError(404, 'NOT_FOUND', 'This collection is not available.');
function parseId(id: unknown) {
  const result = z.uuid().safeParse(id);
  if (!result.success) throw missing();
  return result.data;
}
function checkVersion(row: LibraryRecord, expected: number) {
  storedVersion(row);
  if (row.collectionVersion !== expected)
    throw new ApiError(
      409,
      'COLLECTION_CHANGED',
      'This collection changed in another tab. Load its latest version before changing it.',
    );
}
function storedVersion(row: LibraryRecord): number {
  if (
    !Number.isSafeInteger(row.collectionVersion) ||
    !row.collectionVersion ||
    row.collectionVersion < 1
  )
    throw new ApiError(
      503,
      'COLLECTION_METADATA_INVALID',
      'This collection needs metadata repair before it can be changed.',
    );
  return row.collectionVersion;
}

export function createProofingCollections(
  getStore: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router();
  const root = '/events/:id/proofing-collections';
  async function eventOf(req: Request, actor: string) {
    const event = await getStore().get(parseId(req.params.id));
    if (
      event.kind !== 'event' ||
      event.ownerId !== actor ||
      event.deletionStartedAt
    )
      throw missing();
    return event;
  }
  async function collectionOf(req: Request, actor: string, eventId: string) {
    const row = await getStore().get(parseId(req.params.collectionId));
    if (
      row.kind !== 'job' ||
      row.purpose !== 'proofing-collection' ||
      row.ownerId !== actor ||
      row.eventId !== eventId ||
      row.deletionStartedAt
    )
      throw missing();
    return row;
  }
  async function photosOf(actor: string, eventId: string) {
    return (await getStore().list(actor, 'photo')).filter(
      (photo) =>
        photo.ownerId === actor &&
        photo.eventId === eventId &&
        !photo.scanId &&
        !photo.deletionStartedAt &&
        photoAvailable(photo),
    );
  }
  function present(
    row: LibraryRecord,
    photos: LibraryRecord[],
  ): ProofingCollection {
    const photoIds = [...new Set(row.selectedIds ?? [])];
    const byId = new Map(photos.map((photo) => [photo.id, photo]));
    const available = photoIds.flatMap((id) => {
      const photo = byId.get(id);
      return photo ? [{ id, filename: photo.filename ?? 'photo.jpg' }] : [];
    });
    return {
      id: row.id,
      title: row.title ?? '',
      version: storedVersion(row),
      createdAt: row.createdAt,
      updatedAt: row.collectionUpdatedAt ?? row.createdAt,
      photoIds,
      photos: available,
      unavailableCount: photoIds.length - available.length,
    };
  }
  async function validatePhotos(actor: string, eventId: string, ids: string[]) {
    const photos = await photosOf(actor, eventId);
    const allowed = new Set(photos.map((photo) => photo.id));
    if (!ids.every((id) => allowed.has(id)))
      throw new ApiError(
        400,
        'COLLECTION_PHOTOS_UNAVAILABLE',
        'Remove unavailable photos and select only photos from this event.',
      );
    return photos;
  }
  router.get(root, async (req, res) => {
    const actor = await owner(req),
      event = await eventOf(req, actor);
    const rows = (await getStore().list(actor, 'job')).filter(
      (row) =>
        row.ownerId === actor &&
        row.eventId === event.id &&
        row.purpose === 'proofing-collection' &&
        !row.deletionStartedAt,
    );
    const photos = await photosOf(actor, event.id);
    res.json({
      collections: rows
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
        )
        .map((row) => present(row, photos)),
      limit: PROOFING_COLLECTION_LIMIT,
    });
  });
  router.get(`${root}/:collectionId`, async (req, res) => {
    const actor = await owner(req),
      event = await eventOf(req, actor);
    const row = await collectionOf(req, actor, event.id);
    res.json({ collection: present(row, await photosOf(actor, event.id)) });
  });
  router.post(root, async (req, res) => {
    const actor = await owner(req),
      data = draft.strict().safeParse(req.body);
    if (!data.success)
      throw new ApiError(
        400,
        'INVALID_COLLECTION',
        'Name this collection and select between 1 and 100 photos.',
      );
    const collection = await withAccountLock(actor, async () => {
      const event = await eventOf(req, actor);
      const rows = (await getStore().list(actor, 'job')).filter(
        (row) =>
          row.eventId === event.id && row.purpose === 'proofing-collection',
      );
      if (rows.length >= PROOFING_COLLECTION_LIMIT)
        throw new ApiError(
          409,
          'COLLECTION_LIMIT',
          'This event has reached its 50-collection limit.',
        );
      const ids = [...new Set(data.data.photoIds)];
      const photos = await validatePhotos(actor, event.id, ids);
      const now = new Date().toISOString();
      const row: LibraryRecord = {
        id: randomUUID(),
        ownerId: actor,
        kind: 'job',
        purpose: 'proofing-collection',
        eventId: event.id,
        title: data.data.title,
        selectedIds: ids,
        collectionVersion: 1,
        createdAt: now,
        collectionUpdatedAt: now,
      };
      await getStore().put(row, true);
      return present(row, photos);
    });
    res.status(201).json({ collection });
  });
  router.patch(`${root}/:collectionId`, async (req, res) => {
    const actor = await owner(req),
      data = draft.extend({ version }).strict().safeParse(req.body);
    if (!data.success)
      throw new ApiError(
        400,
        'INVALID_COLLECTION',
        'Name this collection, select between 1 and 100 photos and load its current version.',
      );
    const collection = await withAccountLock(actor, async () => {
      const event = await eventOf(req, actor),
        row = await collectionOf(req, actor, event.id);
      checkVersion(row, data.data.version);
      const ids = [...new Set(data.data.photoIds)];
      const photos = await validatePhotos(actor, event.id, ids);
      const updated: LibraryRecord = {
        ...row,
        title: data.data.title,
        selectedIds: ids,
        collectionVersion: data.data.version + 1,
        collectionUpdatedAt: new Date().toISOString(),
      };
      await getStore().put(updated);
      return present(updated, photos);
    });
    res.json({ collection });
  });
  router.delete(`${root}/:collectionId`, async (req, res) => {
    const actor = await owner(req),
      data = z.object({ version }).strict().safeParse(req.body);
    if (!data.success)
      throw new ApiError(
        400,
        'INVALID_COLLECTION',
        'Load the current collection version before deleting.',
      );
    await withAccountLock(actor, async () => {
      const event = await eventOf(req, actor),
        row = await collectionOf(req, actor, event.id);
      checkVersion(row, data.data.version);
      await getStore().remove(row.id);
    });
    res.status(204).end();
  });
  return router;
}
