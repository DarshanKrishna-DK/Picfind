import { z } from 'zod';

export const HIGHLIGHT_PHOTO_LIMIT = 100;
export const highlightFields = z
  .object({
    title: z.string().trim().min(1).max(100),
    photoIds: z.array(z.uuid()).max(HIGHLIGHT_PHOTO_LIMIT),
    published: z.boolean(),
  })
  .strict()
  .refine((value) => new Set(value.photoIds).size === value.photoIds.length)
  .refine((value) => !value.published || value.photoIds.length > 0);
export const highlightVersion = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 2);
export const storedHighlights = z
  .object({
    title: z.string(),
    photoIds: z.array(z.string()),
    published: z.boolean(),
    version: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    ({ title, photoIds, published }) =>
      highlightFields.safeParse({ title, photoIds, published }).success,
  );
export type HighlightSet = z.infer<typeof storedHighlights>;
export type HighlightDraft = Omit<HighlightSet, 'updatedAt'> & {
  updatedAt: string | null;
};
export const emptyHighlights = (): HighlightDraft => ({
  title: 'Event highlights',
  photoIds: [],
  published: false,
  version: 0,
  updatedAt: null,
});
