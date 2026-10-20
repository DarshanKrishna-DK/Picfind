import {
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ApiError, readSession, type AuthOptions } from './auth.js';
import { withAccountLock } from './locks.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { photoAvailable } from './retention.js';
import type { EventPatch } from './billing/event-entitlements.js';
import {
  SELECTION_STATUSES,
  type EventSelection,
  type SelectionReview,
} from '../../../packages/shared/src/proofing.js';
import {
  DEFAULT_SELECTION_RULES,
  validSelectionRules,
  type SelectionCountRules,
} from '../../../packages/shared/src/selection-rules.js';

function selectionRules(
  event: LibraryRecord,
  allowRepair = false,
): SelectionCountRules {
  const rules = {
    minimum: event.selectionMinimum ?? DEFAULT_SELECTION_RULES.minimum,
    maximum: event.selectionMaximum ?? DEFAULT_SELECTION_RULES.maximum,
  };
  if (!validSelectionRules(rules) && !allowRepair)
    throw new ApiError(
      409,
      'SELECTION_RULES_INVALID',
      'The organizer must update this event selection policy before submissions can continue.',
    );
  return rules;
}

function reviewOf(row: LibraryRecord): SelectionReview {
  return {
    reviewStatus: row.reviewStatus ?? 'new',
    reviewNote: row.reviewNote ?? '',
    reviewVersion: row.reviewVersion ?? 0,
    reviewedAt: row.reviewedAt ?? null,
  };
}

const derive = promisify(scrypt);
export async function hashPasscode(passcode: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(passcode, salt, 32)) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPasscode(passcode: string, saved: string) {
  const [salt, expected] = saved.split(':');
  if (!salt || !expected) return false;
  const actual = (await derive(passcode, salt, 32)) as Buffer;
  const bytes = Buffer.from(expected, 'hex');
  return bytes.length === actual.length && timingSafeEqual(bytes, actual);
}
function token(event: LibraryRecord, expiry: string) {
  return createHmac('sha256', event.passcodeHash!)
    .update(`${event.id}:${expiry}`)
    .digest('hex');
}
export function safeCsv(value: unknown) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function createEventTools(
  auth: AuthOptions,
  getStore: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
  saveEvent?: (
    user: string,
    id: string,
    patch: EventPatch,
  ) => Promise<LibraryRecord>,
) {
  const router = Router();
  const cookie = {
    httpOnly: true,
    secure: auth.secureCookies,
    sameSite: 'lax' as const,
    path: '/',
  };
  const name = (id: string) =>
    `${auth.secureCookies ? '__Host-' : ''}picfind_gallery_${id}`;
  async function eventOf(id: unknown, user?: string) {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success)
      throw new ApiError(404, 'NOT_FOUND', 'This gallery is not available.');
    const event = await getStore().get(parsed.data);
    if (
      event.kind !== 'event' ||
      event.deletionStartedAt ||
      (user
        ? event.ownerId !== user
        : event.visibility !== 'link' ||
          event.archived ||
          Boolean(event.expiresAt && Date.parse(event.expiresAt) <= Date.now()))
    )
      throw new ApiError(404, 'NOT_FOUND', 'This gallery is not available.');
    return event;
  }
  function unlocked(req: Request, event: LibraryRecord) {
    if (!event.passcodeHash) return true;
    const [expiry, signature] = (readSession(req, name(event.id)) ?? '').split(
      '.',
    );
    if (!expiry || !signature || Number(expiry) < Date.now()) return false;
    const expected = Buffer.from(token(event, expiry));
    const actual = Buffer.from(signature);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }
  // Validate the secret event first so unknown/expired IDs remain generic 404s.
  // Session access protects the whole subtree: gallery, bytes, search and proofing.
  router.use('/public/events/:id', async (req, _res, next) => {
    await eventOf(req.params.id);
    await owner(req);
    next();
  });
  router.post(
    '/public/events/:id/unlock',
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 10,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    async (req, res) => {
      const event = await eventOf(req.params.id);
      const parsed = z
        .object({ passcode: z.string().min(1).max(64) })
        .strict()
        .safeParse(req.body);
      if (
        !parsed.success ||
        !event.passcodeHash ||
        !(await verifyPasscode(parsed.data.passcode, event.passcodeHash))
      )
        throw new ApiError(
          403,
          'WRONG_PASSCODE',
          'That passcode did not unlock this gallery.',
        );
      const expires = String(Date.now() + 24 * 60 * 60_000);
      res.cookie(name(event.id), `${expires}.${token(event, expires)}`, {
        ...cookie,
        maxAge: 24 * 60 * 60_000,
      });
      res.status(204).end();
    },
  );
  // This gate protects bytes, matching and proofing too, not just the gallery UI.
  router.use('/public/events/:id', async (req, _res, next) => {
    const event = await eventOf(req.params.id);
    if (!unlocked(req, event))
      throw new ApiError(
        401,
        'GALLERY_LOCKED',
        'Enter the organizer passcode to view this gallery.',
      );
    next();
  });
  router.get('/public/events/:id/access', async (req, res) => {
    const event = await eventOf(req.params.id);
    const rules = selectionRules(event, true);
    res.json({
      brandingName: event.brandingName ?? '',
      accentColor: event.accentColor ?? '#173f37',
      selectionRules: validSelectionRules(rules) ? rules : null,
    });
  });
  router.patch('/events/:id/selection-rules', async (req, res) => {
    const user = await owner(req);
    const parsed = z
      .object({
        minimum: z.number().int().min(1).max(100),
        maximum: z.number().int().min(1).max(100),
      })
      .strict()
      .refine(validSelectionRules)
      .safeParse(req.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_SELECTION_RULES',
        'Choose a minimum and maximum from 1 to 100, with the minimum no greater than the maximum.',
      );
    await withAccountLock(user, async () => {
      const event = await eventOf(req.params.id, user);
      const patch = {
        selectionMinimum: parsed.data.minimum,
        selectionMaximum: parsed.data.maximum,
      };
      if (saveEvent) await saveEvent(user, event.id, patch);
      else await getStore().put({ ...event, ...patch });
    });
    res.json({ selectionRules: parsed.data });
  });
  router.patch('/events/:id/presentation', async (req, res) => {
    const user = await owner(req);
    const data = z
      .object({
        brandingName: z.string().trim().max(100),
        accentColor: z.string().regex(/^#[\da-f]{6}$/i),
        passcode: z
          .union([z.literal(''), z.string().min(6).max(64)])
          .optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!data.success)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Use a six-character or longer passcode and a valid hex color.',
      );
    await withAccountLock(user, async () => {
      const event = await eventOf(req.params.id, user);
      const updated = {
        ...event,
        brandingName: data.data.brandingName,
        accentColor: data.data.accentColor,
      };
      if (data.data.passcode !== undefined) {
        if (data.data.passcode)
          updated.passcodeHash = await hashPasscode(data.data.passcode);
        else delete updated.passcodeHash;
      }
      if (saveEvent)
        await saveEvent(user, event.id, {
          brandingName: updated.brandingName,
          accentColor: updated.accentColor,
          ...(data.data.passcode !== undefined
            ? { passcodeHash: updated.passcodeHash ?? '' }
            : {}),
        });
      else await getStore().put(updated);
    });
    res.status(204).end();
  });
  router.get('/events/:id/insights', async (req, res) => {
    const user = await owner(req);
    const event = await eventOf(req.params.id, user);
    const photos = (await getStore().list(user, 'photo')).filter(
      (photo) =>
        photo.eventId === event.id &&
        !photo.deletionStartedAt &&
        photoAvailable(photo),
    );
    const photoMap = new Map(photos.map((photo) => [photo.id, photo]));
    const selections = (await getStore().list(user, 'job')).filter(
      (row) => row.purpose === 'selection' && row.eventId === event.id,
    );
    const result = {
      photos: photos.length,
      indexed: photos.filter((photo) => photo.indexState === 'ready').length,
      storageBytes: photos.reduce((sum, photo) => sum + (photo.bytes ?? 0), 0),
      submissions: selections.length,
      hasPasscode: Boolean(event.passcodeHash),
      brandingName: event.brandingName ?? '',
      accentColor: event.accentColor ?? '#173f37',
      selectionRules: selectionRules(event, true),
      selections: selections.map((row): EventSelection => ({
        id: row.id,
        name: row.visitorName ?? '',
        note: row.note ?? '',
        photoIds: row.selectedIds ?? [],
        photos: (row.selectedIds ?? []).flatMap((id) => {
          const photo = photoMap.get(id);
          return photo ? [{ id, filename: photo.filename ?? 'photo.jpg' }] : [];
        }),
        createdAt: row.createdAt,
        ...reviewOf(row),
      })),
    };
    if (req.query.format === 'csv') {
      const rows = [
        [
          'Submitted',
          'Name',
          'Guest note',
          'Photo IDs',
          'Status',
          'Private review note',
          'Reviewed at',
          'Available photos',
        ],
        ...result.selections.map((row) => [
          row.createdAt,
          row.name,
          row.note,
          row.photoIds?.join(' '),
          row.reviewStatus,
          row.reviewNote,
          row.reviewedAt,
          row.photos.length,
        ]),
      ];
      res
        .type('text/csv')
        .setHeader(
          'Content-Disposition',
          'attachment; filename="photo-selections.csv"',
        );
      res.send(rows.map((row) => row.map(safeCsv).join(',')).join('\r\n'));
    } else res.json(result);
  });
  router.patch('/events/:id/selections/:selectionId', async (req, res) => {
    const user = await owner(req);
    const selectionId = z.uuid().safeParse(req.params.selectionId);
    if (!selectionId.success)
      throw new ApiError(404, 'NOT_FOUND', 'This selection is not available.');
    const parsed = z
      .object({
        reviewStatus: z.enum(SELECTION_STATUSES),
        reviewNote: z.string().trim().max(2000),
        version: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER - 1),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_INPUT',
        'Choose a review status and keep private notes under 2,000 characters.',
      );
    const review = await withAccountLock(user, async () => {
      const event = await eventOf(req.params.id, user);
      const row = await getStore().get(selectionId.data);
      if (
        row.ownerId !== user ||
        row.kind !== 'job' ||
        row.purpose !== 'selection' ||
        row.eventId !== event.id
      )
        throw new ApiError(
          404,
          'NOT_FOUND',
          'This selection is not available.',
        );
      if ((row.reviewVersion ?? 0) !== parsed.data.version)
        throw new ApiError(
          409,
          'REVIEW_CHANGED',
          'Another tab changed this review. Load the latest review before saving again.',
        );
      const updated: LibraryRecord = {
        ...row,
        reviewStatus: parsed.data.reviewStatus,
        reviewNote: parsed.data.reviewNote,
        reviewVersion: parsed.data.version + 1,
        reviewedAt: new Date().toISOString(),
      };
      await getStore().put(updated);
      return reviewOf(updated);
    });
    res.json({ review });
  });
  router.post(
    '/public/events/:id/selections',
    rateLimit({
      windowMs: 60 * 60_000,
      limit: 20,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    async (req, res) => {
      const event = await eventOf(req.params.id);
      const data = z
        .object({
          name: z.string().trim().min(1).max(100),
          note: z.string().trim().max(500).default(''),
          photoIds: z.array(z.uuid()).min(1).max(100),
        })
        .strict()
        .safeParse(req.body);
      if (!data.success)
        throw new ApiError(
          400,
          'INVALID_INPUT',
          'Add your name and choose photos to send to the organizer.',
        );
      const ids = [...new Set(data.data.photoIds)];
      await withAccountLock(event.ownerId, async () => {
        const current = await eventOf(event.id);
        if (!unlocked(req, current))
          throw new ApiError(
            401,
            'GALLERY_LOCKED',
            'Unlock this gallery again.',
          );
        const rules = selectionRules(current);
        if (ids.length < rules.minimum || ids.length > rules.maximum)
          throw new ApiError(
            400,
            'SELECTION_COUNT_REQUIRED',
            rules.minimum === rules.maximum
              ? `Choose exactly ${rules.minimum} different photos for this request.`
              : `Choose between ${rules.minimum} and ${rules.maximum} different photos for this request.`,
          );
        const photos = await getStore().list(event.ownerId, 'photo');
        if (
          !ids.every((id) =>
            photos.some(
              (photo) =>
                photo.id === id &&
                photo.eventId === event.id &&
                !photo.deletionStartedAt &&
                photoAvailable(photo),
            ),
          )
        )
          throw new ApiError(
            400,
            'INVALID_SELECTION',
            'Select only photos in this event.',
          );
        const selections = (await getStore().list(event.ownerId, 'job')).filter(
          (row) => row.purpose === 'selection' && row.eventId === event.id,
        );
        if (selections.length >= 1000)
          throw new ApiError(
            429,
            'SELECTION_LIMIT',
            'This event has reached its selection submission limit.',
          );
        await getStore().put(
          {
            id: randomUUID(),
            ownerId: event.ownerId,
            kind: 'job',
            purpose: 'selection',
            eventId: event.id,
            selectedIds: ids,
            visitorName: data.data.name,
            note: data.data.note,
            createdAt: new Date().toISOString(),
          },
          true,
        );
      });
      res
        .status(201)
        .json({ message: 'Your selection was sent to the organizer.' });
    },
  );
  return router;
}
