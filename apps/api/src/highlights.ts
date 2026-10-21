import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { photoAvailable } from './retention.js';
import { withAccountLock } from './locks.js';
import { publishedAttribution } from '../../../packages/shared/src/photo-attribution.js';
import { publishedSponsors } from './event-sponsors.js';
import {
  emptyHighlights,
  highlightFields,
  highlightVersion,
  storedHighlights,
  type HighlightDraft,
} from '../../../packages/shared/src/highlights.js';

const missing = () =>
  new ApiError(
    404,
    'HIGHLIGHTS_UNAVAILABLE',
    'These highlights are not available.',
  );
function id(value: unknown) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw missing();
  return parsed.data;
}
export function highlightRecordId(eventId: string) {
  const hex = createHash('sha256')
    .update(`picfind:highlights:${eventId}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function open(event: LibraryRecord) {
  return (
    !event.archived &&
    (!event.expiresAt || Date.parse(event.expiresAt) > Date.now())
  );
}
function sameFields(a: HighlightDraft, b: z.infer<typeof highlightFields>) {
  return (
    a.title === b.title &&
    a.published === b.published &&
    JSON.stringify(a.photoIds) === JSON.stringify(b.photoIds)
  );
}
export function createHighlights(
  getStore: () => LibraryStore,
  actorOf: (req: Request) => Promise<string>,
  sendPhoto: (
    photo: LibraryRecord,
    req: Request,
    res: Response,
    authorize: () => Promise<void>,
  ) => Promise<void>,
) {
  const router = Router();
  const root = '/events/:id/highlights';
  async function eventOf(eventId: string, actor?: string) {
    const event = await getStore().get(eventId);
    if (
      event.id !== eventId ||
      event.kind !== 'event' ||
      event.deletionStartedAt ||
      event.deletionCompletedAt ||
      (actor !== undefined && event.ownerId !== actor)
    )
      throw missing();
    return event;
  }
  async function load(event: LibraryRecord): Promise<{
    highlights: HighlightDraft;
    createdAt: string | null;
  }> {
    const key = highlightRecordId(event.id);
    let row: LibraryRecord;
    try {
      row = await getStore().get(key);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        return { highlights: emptyHighlights(), createdAt: null };
      throw error;
    }
    if (
      row.id !== key ||
      row.kind !== 'job' ||
      row.purpose !== 'event-highlights' ||
      row.eventId !== event.id ||
      row.ownerId !== event.ownerId ||
      row.deletionStartedAt ||
      row.deletionCompletedAt
    )
      throw missing();
    const parsed = storedHighlights.safeParse(row.highlights);
    if (!parsed.success)
      throw new ApiError(
        503,
        'HIGHLIGHTS_INVALID',
        'These highlights need metadata repair.',
      );
    return { highlights: parsed.data, createdAt: row.createdAt };
  }
  async function read(event: LibraryRecord) {
    return (await load(event)).highlights;
  }
  function allowed(photo: LibraryRecord, event: LibraryRecord) {
    return (
      photo.ownerId === event.ownerId &&
      photo.eventId === event.id &&
      !photo.scanId &&
      !photo.deletionStartedAt &&
      !photo.deletionCompletedAt &&
      photoAvailable(photo)
    );
  }
  async function photosOf(event: LibraryRecord, selected: string[]) {
    const photos: LibraryRecord[] = [];
    for (let start = 0; start < selected.length; start += 8) {
      const batch = await Promise.all(
        selected.slice(start, start + 8).map(async (key) => {
          try {
            const photo = await getStore().get(key);
            return photo.id === key && allowed(photo, event) ? photo : null;
          } catch (error) {
            if (error instanceof ApiError && error.status === 404) return null;
            throw error;
          }
        }),
      );
      photos.push(...batch.filter((photo) => photo !== null));
    }
    return photos;
  }
  async function published(eventId: string, expectedOwner?: string) {
    const event = await eventOf(eventId);
    if (
      !open(event) ||
      (expectedOwner !== undefined && event.ownerId !== expectedOwner)
    )
      throw missing();
    const highlights = await read(event);
    if (!highlights.published) throw missing();
    return { event, highlights };
  }
  router.get(root, async (req, res) => {
    const actor = await actorOf(req),
      event = await eventOf(id(req.params.id), actor);
    const highlights = await read(event);
    const photos = await photosOf(event, highlights.photoIds);
    await eventOf(event.id, actor);
    const available = new Set(photos.map((photo) => photo.id));
    res.json({
      highlights,
      unavailableIds: highlights.photoIds.filter((key) => !available.has(key)),
    });
  });
  router.patch(root, async (req, res) => {
    const actor = await actorOf(req),
      eventId = id(req.params.id);
    const input = z
      .object({
        title: z.unknown(),
        photoIds: z.unknown(),
        published: z.unknown(),
        version: highlightVersion,
      })
      .strict()
      .safeParse(req.body);
    const fields = input.success
      ? highlightFields.safeParse({
          title: input.data.title,
          photoIds: input.data.photoIds,
          published: input.data.published,
        })
      : null;
    if (!input.success || !fields?.success)
      throw new ApiError(
        400,
        'INVALID_HIGHLIGHTS',
        'Use a title up to 100 characters, up to 100 unique event photos and the current version. Publishing requires a photo.',
      );
    const highlights = await withAccountLock(actor, async () => {
      let event = await eventOf(eventId, actor);
      const initial = await load(event);
      const current = initial.highlights;
      if (fields.data.published && !open(event))
        throw new ApiError(
          409,
          'EVENT_CLOSED',
          'Restore an open event before publishing highlights.',
        );
      if (
        sameFields(current, fields.data) &&
        (current.version === input.data.version ||
          current.version === input.data.version + 1)
      )
        return current;
      const changed = () =>
        new ApiError(
          409,
          'HIGHLIGHTS_CHANGED',
          'Highlights changed. Reload the latest set before saving.',
        );
      if (current.version !== input.data.version) throw changed();
      const withdrawal =
        current.published &&
        !fields.data.published &&
        JSON.stringify(current.photoIds) ===
          JSON.stringify(fields.data.photoIds);
      const validate = async () => {
        if (
          !withdrawal &&
          (await photosOf(event, fields.data.photoIds)).length !==
            fields.data.photoIds.length
        )
          throw new ApiError(
            400,
            'HIGHLIGHT_PHOTOS_UNAVAILABLE',
            'Remove unavailable photos and choose only photos from this event.',
          );
      };
      await validate();
      event = await eventOf(eventId, actor);
      if (fields.data.published && !open(event))
        throw new ApiError(
          409,
          'EVENT_CLOSED',
          'Restore an open event before publishing highlights.',
        );
      await validate();
      if (JSON.stringify(await read(event)) !== JSON.stringify(current))
        throw changed();
      event = await eventOf(eventId, actor);
      if (fields.data.published && !open(event))
        throw new ApiError(
          409,
          'EVENT_CLOSED',
          'Restore an open event before publishing highlights.',
        );
      const next = {
        ...fields.data,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      await getStore().put(
        {
          id: highlightRecordId(eventId),
          ownerId: actor,
          kind: 'job',
          purpose: 'event-highlights',
          eventId,
          createdAt: initial.createdAt ?? next.updatedAt,
          highlights: next,
        },
        current.version === 0,
      );
      return next;
    });
    res.json({ highlights });
  });
  router.get('/public/highlights/:id', async (req, res) => {
    await actorOf(req);
    const eventId = id(req.params.id);
    const initial = await published(eventId);
    const sponsorSnapshot = await publishedSponsors(getStore(), initial.event);
    const photos = await photosOf(initial.event, initial.highlights.photoIds);
    const sponsors = await publishedSponsors(getStore(), initial.event);
    if (JSON.stringify(sponsors) !== JSON.stringify(sponsorSnapshot))
      throw missing();
    const latest = await published(eventId, initial.event.ownerId);
    if (latest.highlights.version !== initial.highlights.version)
      throw missing();
    res.json({
      title: latest.highlights.title,
      coverId: photos[0]?.id ?? null,
      ...(sponsors ? { sponsors } : {}),
      photos: photos.map((photo) => {
        const credit = publishedAttribution(photo.attribution);
        return {
          id: photo.id,
          filename: photo.filename ?? 'photo.jpg',
          createdAt: photo.createdAt,
          width: photo.width ?? 0,
          height: photo.height ?? 0,
          bytes: photo.bytes ?? 0,
          ...(credit ? { credit } : {}),
        };
      }),
    });
  });
  router.get('/public/highlights/:id/photos/:photoId', async (req, res) => {
    await actorOf(req);
    const eventId = id(req.params.id),
      photoId = id(req.params.photoId);
    const initial = await published(eventId);
    async function authorize() {
      const { event, highlights } = await published(
        eventId,
        initial.event.ownerId,
      );
      if (!highlights.photoIds.includes(photoId)) throw missing();
      const photo = await getStore().get(photoId);
      if (photo.id !== photoId || !allowed(photo, event)) throw missing();
      return photo;
    }
    const photo = await authorize();
    await sendPhoto(photo, req, res, async () => {
      await authorize();
    });
  });
  return router;
}
