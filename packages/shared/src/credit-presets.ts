import { z } from 'zod';
import {
  attributionFields,
  storedAttributionSchema,
} from './photo-attribution.js';

export const CREDIT_PRESET_LIMIT = 20;
export const CREDIT_BATCH_LIMIT = 100;
export const CREDIT_PHOTO_PAGE_SIZE = 100;
export const CREDIT_ACTOR_HEADER = 'X-PicFind-Credit-Actor';
const version = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
export const creditPresetFields = z
  .object({
    label: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(100),
    website: z.string().max(512),
  })
  .strict()
  .refine(
    (value) =>
      attributionFields.safeParse({
        name: value.name,
        website: value.website,
        published: false,
      }).success,
  );
export type CreditPresetFields = z.infer<typeof creditPresetFields>;
export const creditPresetWrite = creditPresetFields
  .safeExtend({
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 2),
  })
  .strict();
export const savedCreditPreset = creditPresetFields
  .safeExtend({
    id: z.uuid(),
    version,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    (value) => Date.parse(value.updatedAt) >= Date.parse(value.createdAt),
  );
export type SavedCreditPreset = z.infer<typeof savedCreditPreset>;
export const creditPresetDirectory = z
  .object({
    accountId: z.string().min(1).max(128),
    limit: z.literal(CREDIT_PRESET_LIMIT),
    presets: z.array(savedCreditPreset).max(100),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.presets.map((row) => row.id)).size === value.presets.length,
  );
export type CreditPresetDirectory = z.infer<typeof creditPresetDirectory>;
export const photoCredit = z.union([
  storedAttributionSchema,
  z
    .object({
      name: z.literal(''),
      website: z.literal(''),
      published: z.literal(false),
      version: z.literal(0),
      updatedAt: z.null(),
    })
    .strict(),
]);
export const creditPreviewWrite = z
  .object({
    photoIds: z.array(z.uuid()).min(1).max(CREDIT_BATCH_LIMIT),
    fields: attributionFields,
  })
  .strict()
  .refine((value) => new Set(value.photoIds).size === value.photoIds.length);
export const creditPreview = z
  .object({
    accountId: z.string().min(1).max(128),
    fields: attributionFields,
    photos: z
      .array(
        z
          .object({
            id: z.uuid(),
            filename: z.string().min(1).max(1024),
            current: photoCredit,
          })
          .strict(),
      )
      .min(1)
      .max(CREDIT_BATCH_LIMIT),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.photos.map((row) => row.id)).size === value.photos.length,
  );
export type CreditPreview = z.infer<typeof creditPreview>;
export const creditPhotoPage = z
  .object({
    accountId: z.string().min(1).max(128),
    offset: z.number().int().min(0),
    pageSize: z.literal(CREDIT_PHOTO_PAGE_SIZE),
    totalCount: z.number().int().min(0),
    events: z.array(
      z.object({ id: z.uuid(), title: z.string().max(200) }).strict(),
    ),
    photos: z
      .array(
        z
          .object({
            id: z.uuid(),
            filename: z.string().min(1).max(1024),
            eventId: z.uuid().nullable(),
          })
          .strict(),
      )
      .max(CREDIT_PHOTO_PAGE_SIZE),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.photos.map((row) => row.id)).size === value.photos.length &&
      new Set(value.events.map((row) => row.id)).size === value.events.length &&
      value.photos.length <= value.totalCount,
  );
export type CreditPhotoPage = z.infer<typeof creditPhotoPage>;
export function creditChange(
  current: z.infer<typeof photoCredit>,
  proposed: z.infer<typeof attributionFields>,
  replace: boolean,
) {
  if (
    current.name === proposed.name &&
    current.website === proposed.website &&
    current.published === proposed.published
  )
    return 'unchanged' as const;
  if (!replace && (current.name || current.website || current.published))
    return 'preserved' as const;
  return 'update' as const;
}
