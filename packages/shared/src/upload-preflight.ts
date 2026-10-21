import { z } from 'zod';
import { UPLOAD_FILE_LIMIT, UPLOAD_QUEUE_LIMIT } from './upload-queue.js';

export const PREFLIGHT_ACTOR = 'X-PicFind-Preflight-Actor';
export const preflightItem = z
  .object({
    id: z.uuid(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().min(1).max(UPLOAD_FILE_LIMIT),
  })
  .strict();
export const preflightCommand = z
  .object({
    requestId: z.uuid(),
    eventId: z.string().min(1).max(128).nullable(),
    items: z.array(preflightItem).min(1).max(UPLOAD_QUEUE_LIMIT),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.items.map((item) => item.id)).size === value.items.length &&
      new Set(value.items.map((item) => item.digest)).size ===
        value.items.length,
  );
export type PreflightCommand = z.infer<typeof preflightCommand>;
const count = z.number().int().nonnegative();
export const preflightReport = z
  .object({
    requestId: z.uuid(),
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
    accountId: z.string().min(1).max(128),
    eventId: z.string().min(1).max(128).nullable(),
    checkedAt: z.iso.datetime(),
    items: z
      .array(
        z
          .object({
            id: z.uuid(),
            status: z.enum(['reusable', 'new-candidate']),
            inputBytes: z.number().int().min(1).max(UPLOAD_FILE_LIMIT),
          })
          .strict(),
      )
      .min(1)
      .max(UPLOAD_QUEUE_LIMIT),
    reusable: count.max(UPLOAD_QUEUE_LIMIT),
    newCandidates: count.max(UPLOAD_QUEUE_LIMIT),
    inputBytes: count.max(UPLOAD_QUEUE_LIMIT * UPLOAD_FILE_LIMIT),
    newInputBytes: count.max(UPLOAD_QUEUE_LIMIT * UPLOAD_FILE_LIMIT),
    librarySlotsRemaining: count.max(25_000),
    eventSlotsRemaining: count.nullable(),
    photoSlotsFit: z.boolean(),
    outputStorageVerified: z.literal(false),
    reservationCreated: z.literal(false),
  })
  .strict();
export type PreflightReport = z.infer<typeof preflightReport>;
