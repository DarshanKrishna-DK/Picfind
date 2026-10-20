import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { withAccountLock } from './locks.js';
import { photoAvailable } from './retention.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import {
  ownedCreditPhoto,
  readPhotoCredit,
} from './photo-attribution-access.js';
import {
  CREDIT_ACTOR_HEADER,
  CREDIT_PHOTO_PAGE_SIZE,
  CREDIT_PRESET_LIMIT,
  creditPresetDirectory,
  creditPresetWrite,
  creditPhotoPage,
  creditPreview,
  creditPreviewWrite,
  savedCreditPreset,
} from '../../../packages/shared/src/credit-presets.js';

const missing = () =>
  new ApiError(
    404,
    'CREDIT_PRESET_UNAVAILABLE',
    'This photographer credit preset is unavailable.',
  );
const changed = () =>
  new ApiError(
    409,
    'CREDIT_PRESET_CHANGED',
    'The credit preset changed. Reload before saving again.',
  );
export function createCreditPresets(
  getStore: () => LibraryStore,
  actorOf: (req: Request) => Promise<string>,
) {
  const router = Router();
  async function actor(req: Request) {
    const id = await actorOf(req);
    if (req.get(CREDIT_ACTOR_HEADER) && req.get(CREDIT_ACTOR_HEADER) !== id)
      throw new ApiError(
        403,
        'ACCOUNT_CHANGED',
        'Your signed-in account changed. Reload photographer credits.',
      );
    return id;
  }
  function idOf(value: unknown) {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw missing();
    return parsed.data;
  }
  function read(row: LibraryRecord, accountId: string, id = row.id) {
    if (
      row.id !== id ||
      row.ownerId !== accountId ||
      row.kind !== 'job' ||
      row.purpose !== 'photographer-credit-preset' ||
      row.eventId ||
      row.deletionStartedAt ||
      row.deletionCompletedAt
    )
      throw missing();
    const parsed = savedCreditPreset.safeParse(row.creditPreset);
    if (
      !parsed.success ||
      parsed.data.id !== id ||
      parsed.data.createdAt !== row.createdAt ||
      !/^[a-f0-9]{64}$/.test(row.creditPresetCommandDigest ?? '')
    )
      throw new ApiError(
        503,
        'CREDIT_PRESET_INVALID',
        'A photographer credit preset needs metadata repair.',
      );
    return { row, preset: parsed.data };
  }
  async function find(id: string, accountId: string) {
    let row: LibraryRecord;
    try {
      row = await getStore().get(id);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) return null;
      throw failure;
    }
    return read(row, accountId, id);
  }
  const list = async (accountId: string) =>
    (await getStore().list(accountId, 'job')).filter(
      (row) =>
        row.ownerId === accountId &&
        row.purpose === 'photographer-credit-preset',
    );
  router.get('/studio/credit-presets', async (req, res) => {
    const accountId = await actor(req);
    res.json(
      creditPresetDirectory.parse({
        accountId,
        limit: CREDIT_PRESET_LIMIT,
        presets: (await list(accountId))
          .map((row) => read(row, accountId).preset)
          .sort(
            (a, b) =>
              a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
          ),
      }),
    );
  });
  router.get('/studio/credit-photos', async (req, res) => {
    const accountId = await actor(req),
      input = z
        .object({
          eventId: z.union([z.uuid(), z.literal('library')]).optional(),
          search: z.string().trim().max(200).default(''),
          offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
        })
        .strict()
        .safeParse(req.query);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_CREDIT_FILTER',
        'Choose an event, search text and valid page.',
      );
    const [allEvents, allPhotos] = await Promise.all([
      getStore().list(accountId, 'event'),
      getStore().list(accountId, 'photo'),
    ]);
    const events = allEvents
      .filter(
        (row) =>
          row.ownerId === accountId &&
          row.kind === 'event' &&
          !row.deletionStartedAt &&
          !row.deletionCompletedAt,
      )
      .map((row) => ({
        id: row.id,
        title: (row.title ?? 'Untitled event').slice(0, 200),
      }));
    const eventIds = new Set(events.map((row) => row.id));
    const photos = allPhotos
      .filter(
        (row) =>
          row.ownerId === accountId &&
          row.kind === 'photo' &&
          !row.scanId &&
          !row.deletionStartedAt &&
          !row.deletionCompletedAt &&
          photoAvailable(row) &&
          (!row.eventId || eventIds.has(row.eventId)) &&
          (!input.data.eventId ||
            (input.data.eventId === 'library'
              ? !row.eventId
              : row.eventId === input.data.eventId)) &&
          (row.filename ?? 'Untitled photo')
            .toLowerCase()
            .includes(input.data.search.toLowerCase()),
      )
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      );
    res.json(
      creditPhotoPage.parse({
        accountId,
        events,
        offset: input.data.offset,
        pageSize: CREDIT_PHOTO_PAGE_SIZE,
        totalCount: photos.length,
        photos: photos
          .slice(input.data.offset, input.data.offset + CREDIT_PHOTO_PAGE_SIZE)
          .map((row) => ({
            id: row.id,
            filename: row.filename || 'Untitled photo',
            eventId: row.eventId ?? null,
          })),
      }),
    );
  });
  router.put('/studio/credit-presets/:id', async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id),
      input = creditPresetWrite.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_CREDIT_PRESET',
        'Enter a preset label, credit name, optional HTTPS website and current version.',
      );
    const { version, ...fields } = input.data,
      commandDigest = createHash('sha256')
        .update(JSON.stringify({ accountId, id, ...input.data }))
        .digest('hex');
    const preset = await withAccountLock(accountId, async () => {
      const current = await find(id, accountId);
      if (
        current?.preset.version === version + 1 &&
        current.row.creditPresetCommandDigest === commandDigest
      )
        return current.preset;
      if ((current?.preset.version ?? 0) !== version) throw changed();
      if (!current && (await list(accountId)).length >= CREDIT_PRESET_LIMIT)
        throw new ApiError(
          409,
          'CREDIT_PRESET_LIMIT',
          'Remove an unused preset before creating another one.',
        );
      const now = new Date(
        Math.max(
          Date.now(),
          Date.parse(current?.preset.updatedAt ?? '1970-01-01T00:00:00.000Z'),
        ),
      ).toISOString();
      const next = savedCreditPreset.parse({
        ...fields,
        id,
        version: version + 1,
        createdAt: current?.preset.createdAt ?? now,
        updatedAt: now,
      });
      const fresh = await find(id, accountId);
      if (JSON.stringify(fresh) !== JSON.stringify(current)) throw changed();
      await getStore().put(
        {
          id,
          ownerId: accountId,
          kind: 'job',
          purpose: 'photographer-credit-preset',
          createdAt: next.createdAt,
          creditPreset: next,
          creditPresetCommandDigest: commandDigest,
        },
        !current,
      );
      return next;
    });
    res.json({ accountId, preset });
  });
  router.delete('/studio/credit-presets/:id', async (req, res) => {
    const accountId = await actor(req),
      id = idOf(req.params.id),
      input = z
        .object({
          version: z
            .number()
            .int()
            .min(1)
            .max(Number.MAX_SAFE_INTEGER - 1),
        })
        .strict()
        .safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_CREDIT_PRESET',
        'Load the current preset before removing it.',
      );
    await withAccountLock(accountId, async () => {
      const current = await find(id, accountId);
      if (!current) return;
      if (current.preset.version !== input.data.version) throw changed();
      const fresh = await find(id, accountId);
      if (!fresh) return;
      if (JSON.stringify(fresh) !== JSON.stringify(current)) throw changed();
      try {
        await getStore().remove(id);
      } catch (failure) {
        if (!(failure instanceof ApiError && failure.status === 404))
          throw failure;
      }
    });
    res.status(204).end();
  });
  router.post(
    '/photos/attribution-preview',
    rateLimit({
      windowMs: 60_000,
      limit: 15,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    async (req, res) => {
      const accountId = await actor(req),
        input = creditPreviewWrite.safeParse(req.body);
      if (!input.success)
        throw new ApiError(
          400,
          'INVALID_CREDIT_PREVIEW',
          'Choose 1 to 100 distinct photos and valid credit fields.',
        );
      const photos = [];
      const { photoIds, fields } = input.data;
      async function load(id: string) {
        const before = await ownedCreditPhoto(
          getStore(),
          id,
          accountId,
          fields.published,
        );
        const current = readPhotoCredit(before);
        const fresh = await ownedCreditPhoto(
          getStore(),
          id,
          accountId,
          fields.published,
        );
        if (
          JSON.stringify(readPhotoCredit(fresh)) !== JSON.stringify(current) ||
          fresh.filename !== before.filename ||
          fresh.eventId !== before.eventId
        )
          throw new ApiError(
            409,
            'ATTRIBUTION_CHANGED',
            'A selected photo changed. Reload before preparing this credit batch.',
          );
        return { id, filename: fresh.filename ?? 'Untitled photo', current };
      }
      for (let offset = 0; offset < photoIds.length; offset += 4)
        photos.push(
          ...(await Promise.all(photoIds.slice(offset, offset + 4).map(load))),
        );
      res.json(creditPreview.parse({ accountId, fields, photos }));
    },
  );
  return router;
}
