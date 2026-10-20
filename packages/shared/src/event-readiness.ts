import { z } from 'zod';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const eventReadiness = z
  .object({
    accountId: z.string().min(1),
    eventId: z.uuid(),
    checkedAt: z.iso.datetime(),
    gallery: z
      .object({
        state: z.enum(['private', 'shared', 'archived', 'expired', 'deleting']),
        hasPasscode: z.boolean(),
        expiresAt: z.iso.datetime().nullable(),
      })
      .strict(),
    photos: z
      .object({
        available: count,
        expired: count,
        deleting: count,
        knownBytes: count,
        unknownBytes: count,
      })
      .strict(),
    worker: z.enum(['available', 'not-configured', 'unavailable']),
    imports: z
      .object({
        total: count,
        running: count,
        complete: count,
        partial: count,
        failed: count,
        unknown: count,
      })
      .strict()
      .refine(
        (value) =>
          value.total ===
          value.running +
            value.complete +
            value.partial +
            value.failed +
            value.unknown,
      ),
    matching: z
      .object({
        status: z.enum([
          'empty',
          'unavailable',
          'processing',
          'not-prepared',
          'partial',
          'ready',
          'no-faces',
          'needs-attention',
          'archived',
          'expired',
          'deleting',
        ]),
        searchAvailable: z.boolean(),
        processingAvailable: z.boolean(),
        provider: z.literal('aws-rekognition').nullable(),
        counts: z
          .object({
            total: count,
            prepared: count,
            noFaces: count,
            waiting: count,
            failed: count,
            needsReview: count,
          })
          .strict(),
        uncertain: count,
      })
      .strict()
      .nullable(),
    highlights: z
      .object({
        state: z.enum([
          'none',
          'draft',
          'published',
          'partial',
          'unavailable',
          'invalid',
        ]),
        selected: count,
        available: count,
      })
      .strict()
      .refine((value) => value.available <= value.selected),
  })
  .strict();
export type EventReadiness = z.infer<typeof eventReadiness>;
