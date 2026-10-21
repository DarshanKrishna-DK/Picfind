import { z } from 'zod';

export const SPONSOR_ACTOR = 'X-PicFind-Sponsor-Actor';
export const SPONSOR_PERMISSION = 'event-sponsor-publication-v1';
export const SPONSOR_LIMIT = 6;
const budget = (bytes: number) => (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length <= bytes;
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);
const version = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const website = line(300).refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
});
export const sponsorFields = z
  .object({
    gallery: z.boolean(),
    wall: z.boolean(),
    placements: z
      .array(
        z
          .object({
            id: z.uuid(),
            name: line(80).min(1),
            caption: line(120),
            website,
          })
          .strict(),
      )
      .max(SPONSOR_LIMIT),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.placements.map((row) => row.id)).size ===
      value.placements.length,
  )
  .refine(budget(4200));
export type SponsorFields = z.infer<typeof sponsorFields>;
export const blankSponsors = (): SponsorFields => ({
  gallery: false,
  wall: false,
  placements: [],
});
const publication = z
  .object({
    fields: sponsorFields.refine(
      (value) => value.placements.length > 0 && (value.gallery || value.wall),
    ),
    revision: version,
    publishedAt: z.iso.datetime(),
    permission: z.literal(SPONSOR_PERMISSION),
  })
  .strict();
const commandVersion = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 2);
export const sponsorCommand = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('save'),
      version: commandVersion,
      fields: sponsorFields,
    })
    .strict(),
  z
    .object({
      action: z.literal('publish'),
      version: commandVersion,
      fields: sponsorFields,
      permission: z.literal(SPONSOR_PERMISSION),
    })
    .strict()
    .refine(
      (value) =>
        value.fields.placements.length > 0 &&
        (value.fields.gallery || value.fields.wall),
    ),
  z.object({ action: z.literal('withdraw'), version: commandVersion }).strict(),
]);
export const storedSponsors = z
  .object({
    version,
    draft: sponsorFields,
    published: publication.nullable(),
    updatedAt: z.iso.datetime(),
    commandDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine(budget(10000))
  .refine(
    (value) =>
      !value.published ||
      (value.published.revision <= value.version &&
        value.published.publishedAt <= value.updatedAt),
  );
export type StoredSponsors = z.infer<typeof storedSponsors>;
export const sponsorState = z
  .object({
    accountId: z.string().min(1).max(128),
    eventId: z.uuid(),
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    draft: sponsorFields,
    published: publication.nullable(),
    eventOpen: z.boolean(),
  })
  .strict();
export type SponsorState = z.infer<typeof sponsorState>;
export type PublishedSponsors = SponsorFields;
