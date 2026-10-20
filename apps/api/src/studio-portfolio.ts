import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { photoAvailable } from './retention.js';
import {
  PORTFOLIO_ACTOR,
  PORTFOLIO_CONSENT,
  PORTFOLIO_PAGE_SIZE,
  blankPortfolio,
  portfolioCommand,
  publicPortfolio,
  storedPortfolio,
  type StoredPortfolio,
} from '../../../packages/shared/src/studio-portfolio.js';

export function portfolioRecordId(owner: string) {
  const hex = createHash('sha256')
    .update(`picfind:studio-portfolio:${owner}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const missing = () =>
  new ApiError(
    404,
    'PORTFOLIO_UNAVAILABLE',
    'This portfolio or photograph is unavailable.',
  );
const changed = () =>
  new ApiError(
    409,
    'PORTFOLIO_CHANGED',
    'The portfolio changed. Reload and review the latest version.',
  );
const active = (row: LibraryRecord) =>
  !row.deletionStartedAt &&
  !row.deletionCompletedAt &&
  !row.archived &&
  (!row.expiresAt || Date.parse(row.expiresAt) > Date.now());
const eligible = (photo: LibraryRecord, event: LibraryRecord, owner: string) =>
  photo.ownerId === owner &&
  photo.kind === 'photo' &&
  !photo.scanId &&
  photo.eventId === event.id &&
  event.kind === 'event' &&
  event.ownerId === owner &&
  active(photo) &&
  active(event) &&
  photoAvailable(photo);
const positiveDimension = (value: number | undefined) =>
  Number.isSafeInteger(value) && value! > 0 ? value! : null;

export function createStudioPortfolio(
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
  async function actor(req: Request) {
    const owner = await actorOf(req);
    const expected = req.get(PORTFOLIO_ACTOR);
    if (expected && expected !== owner)
      throw new ApiError(
        403,
        'PORTFOLIO_ACCOUNT_CHANGED',
        'Your signed-in account changed. Reload the portfolio.',
      );
    return owner;
  }
  async function optional(id: string) {
    try {
      return await getStore().get(id);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) return null;
      throw failure;
    }
  }
  async function load(
    owner: string,
  ): Promise<{ row: LibraryRecord; value: StoredPortfolio } | null> {
    const id = portfolioRecordId(owner),
      row = await optional(id);
    if (!row) return null;
    if (
      row.id !== id ||
      row.ownerId !== owner ||
      row.kind !== 'job' ||
      row.purpose !== 'studio-portfolio' ||
      row.deletionStartedAt ||
      row.deletionCompletedAt
    )
      throw missing();
    const parsed = storedPortfolio.safeParse(row.studioPortfolio);
    if (
      !parsed.success ||
      !z.iso.datetime().safeParse(row.createdAt).success ||
      Date.parse(row.createdAt) > Date.parse(parsed.data.updatedAt)
    )
      throw new ApiError(
        503,
        'PORTFOLIO_INVALID',
        'Portfolio metadata needs repair before it can be used.',
      );
    return { row, value: parsed.data };
  }
  async function available(id: string, owner: string) {
    const photo = await optional(id);
    if (!photo || photo.id !== id || !photo.eventId) return null;
    const event = await optional(photo.eventId);
    if (!event || event.id !== photo.eventId || !eligible(photo, event, owner))
      return null;
    return photo;
  }
  async function availableSelection(ids: string[], owner: string) {
    const values: Array<LibraryRecord | null> = [];
    for (let offset = 0; offset < ids.length; offset += 8)
      values.push(
        ...(await Promise.all(
          ids.slice(offset, offset + 8).map((id) => available(id, owner)),
        )),
      );
    return values;
  }
  async function snapshot(owner: string) {
    const loaded = await load(owner);
    const value = loaded?.value;
    const unavailableIds: string[] = [];
    const selection = value?.draft.photos ?? [];
    const availablePhotos = await availableSelection(
      selection.map((photo) => photo.id),
      owner,
    );
    for (let index = 0; index < selection.length; index++)
      if (!availablePhotos[index]) unavailableIds.push(selection[index]!.id);
    return {
      accountId: owner,
      id: portfolioRecordId(owner),
      portfolio: value
        ? {
            draft: value.draft,
            published: value.published,
            version: value.version,
            updatedAt: value.updatedAt,
          }
        : {
            draft: blankPortfolio(),
            published: null,
            version: 0,
            updatedAt: null,
          },
      unavailableIds,
    };
  }
  router.get('/studio/portfolio', async (req, res) => {
    const owner = await actor(req);
    res.json(await withAccountLock(owner, () => snapshot(owner)));
  });
  router.get('/studio/portfolio/photos', async (req, res) => {
    const owner = await actor(req);
    const input = z
      .object({
        offset: z.coerce
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER - PORTFOLIO_PAGE_SIZE)
          .default(0),
        search: z.string().trim().max(200).default(''),
      })
      .strict()
      .safeParse(req.query);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_PORTFOLIO_FILTER',
        'Use a valid photo search and page.',
      );
    res.json(
      await withAccountLock(owner, async () => {
        const [events, photos] = await Promise.all([
          getStore().list(owner, 'event'),
          getStore().list(owner, 'photo'),
        ]);
        const byId = new Map(events.map((event) => [event.id, event]));
        const search = input.data.search.toLocaleLowerCase();
        const all = photos
          .filter((photo) => {
            const event = photo.eventId ? byId.get(photo.eventId) : undefined;
            return (
              event &&
              eligible(photo, event, owner) &&
              `${photo.filename ?? ''} ${event.title ?? ''}`
                .toLocaleLowerCase()
                .includes(search)
            );
          })
          .sort(
            (a, b) =>
              b.createdAt.localeCompare(a.createdAt) ||
              a.id.localeCompare(b.id),
          );
        return {
          accountId: owner,
          total: all.length,
          offset: input.data.offset,
          pageSize: PORTFOLIO_PAGE_SIZE,
          photos: all
            .slice(input.data.offset, input.data.offset + PORTFOLIO_PAGE_SIZE)
            .map((photo) => ({
              id: photo.id,
              filename: photo.filename ?? 'Photograph',
              eventTitle: byId.get(photo.eventId!)!.title ?? 'Event',
            })),
        };
      }),
    );
  });
  router.put('/studio/portfolio', async (req, res) => {
    const owner = await actor(req),
      input = portfolioCommand.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_PORTFOLIO',
        'Use bounded portfolio details, an HTTPS website and explicit permission before publishing selected photos.',
      );
    const digest = createHash('sha256')
      .update(JSON.stringify(input.data))
      .digest('hex');
    res.json(
      await withAccountLock(owner, async () => {
        const original = await load(owner),
          current = original?.value;
        if (
          current?.version === input.data.version + 1 &&
          current.commandDigest === digest
        )
          return snapshot(owner);
        if ((current?.version ?? 0) !== input.data.version) throw changed();
        const { action, fields } = input.data;
        // Saving a draft permits unavailable selections so the owner can repair them.
        // Publishing requires a current, owned event photo for every selected ID.
        const assertPhotos = async () => {
          if (action !== 'publish') return;
          const photos = await availableSelection(
            fields.photos.map((photo) => photo.id),
            owner,
          );
          if (photos.some((photo) => !photo))
            throw new ApiError(
              409,
              'PORTFOLIO_PHOTO_UNAVAILABLE',
              'Remove unavailable photographs before publishing.',
            );
        };
        // A private draft must not become a way to probe or retain foreign IDs.
        if (action === 'save') {
          const existing = new Set(
            current?.draft.photos.map((photo) => photo.id),
          );
          const added = fields.photos.filter(
            (photo) => !existing.has(photo.id),
          );
          if (
            (
              await availableSelection(
                added.map((photo) => photo.id),
                owner,
              )
            ).some((photo) => !photo)
          )
            throw missing();
        }
        await assertPhotos();
        const now = new Date(
          Math.max(Date.now(), current ? Date.parse(current.updatedAt) : 0),
        ).toISOString();
        const next = storedPortfolio.parse({
          draft:
            action === 'withdraw'
              ? (current?.draft ?? blankPortfolio())
              : fields,
          published:
            action === 'publish'
              ? {
                  fields,
                  revision: input.data.version + 1,
                  publishedAt: now,
                  permission: PORTFOLIO_CONSENT,
                }
              : action === 'withdraw'
                ? null
                : (current?.published ?? null),
          version: input.data.version + 1,
          updatedAt: now,
          commandDigest: digest,
        });
        if (
          JSON.stringify((await load(owner))?.value ?? null) !==
          JSON.stringify(current ?? null)
        )
          throw changed();
        await assertPhotos();
        await getStore().put(
          {
            id: portfolioRecordId(owner),
            ownerId: owner,
            kind: 'job',
            purpose: 'studio-portfolio',
            createdAt: original?.row.createdAt ?? now,
            studioPortfolio: next,
          },
          !original,
        );
        return snapshot(owner);
      }),
    );
  });
  async function ownerOf(id: string) {
    let row: LibraryRecord | null;
    try {
      row = await optional(id);
    } catch (failure) {
      if (failure instanceof ApiError && [401, 403].includes(failure.status))
        throw missing();
      throw failure;
    }
    if (
      !row ||
      row.id !== id ||
      row.kind !== 'job' ||
      row.purpose !== 'studio-portfolio' ||
      portfolioRecordId(row.ownerId) !== id
    )
      throw missing();
    return row.ownerId;
  }
  async function published(owner: string) {
    const value = (await load(owner))?.value;
    if (!value?.published) throw missing();
    return value.published;
  }
  function publicId(value: unknown) {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw missing();
    return parsed.data;
  }
  async function publicLock<T>(owner: string, work: () => Promise<T>) {
    try {
      return await withAccountLock(owner, work);
    } catch (failure) {
      if (failure instanceof ApiError && [401, 403].includes(failure.status))
        throw missing();
      throw failure;
    }
  }
  router.get('/public/portfolios/:id', async (req, res) => {
    const id = publicId(req.params.id),
      owner = await ownerOf(id);
    res.json(
      await publicLock(owner, async () => {
        const publication = await published(owner);
        const photos = [];
        const availablePhotos = await availableSelection(
          publication.fields.photos.map((photo) => photo.id),
          owner,
        );
        for (const [index, selection] of publication.fields.photos.entries()) {
          const photo = availablePhotos[index];
          if (photo)
            photos.push({
              id: photo.id,
              caption: selection.caption,
              width: positiveDimension(photo.width),
              height: positiveDimension(photo.height),
            });
        }
        if (
          JSON.stringify(await published(owner)) !== JSON.stringify(publication)
        )
          throw missing();
        const { name, tagline, biography, location, website, theme } =
          publication.fields;
        return publicPortfolio.parse({
          name,
          tagline,
          biography,
          location,
          website,
          theme,
          id,
          revision: publication.revision,
          publishedAt: publication.publishedAt,
          photos,
        });
      }),
    );
  });
  router.get('/public/portfolios/:id/photos/:photoId', async (req, res) => {
    const id = publicId(req.params.id),
      photoId = publicId(req.params.photoId);
    // The shared download helper uses private filenames for attachments.
    // Portfolio media exposes inline processed images only.
    if (Object.keys(req.query).length) throw missing();
    const owner = await ownerOf(id);
    const authorize = async () =>
      publicLock(owner, async () => {
        const publication = await published(owner);
        if (
          !publication.fields.photos.some((photo) => photo.id === photoId) ||
          !(await available(photoId, owner))
        )
          throw missing();
        if (
          JSON.stringify(await published(owner)) !== JSON.stringify(publication)
        )
          throw missing();
      });
    await authorize();
    const photo = await available(photoId, owner);
    if (!photo) throw missing();
    await sendPhoto(photo, req, res, authorize);
  });
  return router;
}
