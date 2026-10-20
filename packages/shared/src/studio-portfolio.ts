import { z } from 'zod';

export const PORTFOLIO_ACTOR = 'X-PicFind-Portfolio-Actor';
export const PORTFOLIO_CONSENT = 'portfolio-publication-v1';
export const PORTFOLIO_PHOTO_LIMIT = 24;
export const PORTFOLIO_PAGE_SIZE = 40;
const budget = (limit: number) => (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length <= limit;
const version = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const website = z
  .string()
  .trim()
  .max(300)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  });
export const portfolioFields = z
  .object({
    name: z.string().trim().min(1).max(100),
    tagline: z.string().trim().max(160),
    biography: z.string().trim().max(1000),
    location: z.string().trim().max(120),
    website,
    theme: z.enum(['linen', 'forest', 'midnight']),
    photos: z
      .array(
        z
          .object({
            id: z.uuid(),
            caption: z.string().trim().max(200),
          })
          .strict(),
      )
      .max(PORTFOLIO_PHOTO_LIMIT),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.photos.map((row) => row.id)).size === value.photos.length,
  )
  .refine(budget(5000));
export type PortfolioFields = z.infer<typeof portfolioFields>;
export const blankPortfolio = (): PortfolioFields => ({
  name: 'Photography portfolio',
  tagline: '',
  biography: '',
  location: '',
  website: '',
  theme: 'linen',
  photos: [],
});
const publication = z
  .object({
    fields: portfolioFields.refine((value) => value.photos.length > 0),
    revision: version,
    publishedAt: z.iso.datetime(),
    permission: z.literal(PORTFOLIO_CONSENT),
  })
  .strict();
export const portfolioCommand = z
  .object({
    action: z.enum(['save', 'publish', 'withdraw']),
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 2),
    fields: portfolioFields,
    permission: z.literal(PORTFOLIO_CONSENT).nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.action !== 'publish' ||
      (value.permission === PORTFOLIO_CONSENT &&
        value.fields.photos.length > 0),
  );
export const storedPortfolio = z
  .object({
    draft: portfolioFields,
    published: publication.nullable(),
    version,
    updatedAt: z.iso.datetime(),
    commandDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine(budget(12000))
  .refine(
    (value) =>
      !value.published ||
      (value.published.revision <= value.version &&
        Date.parse(value.published.publishedAt) <= Date.parse(value.updatedAt)),
  );
export type StoredPortfolio = z.infer<typeof storedPortfolio>;
export const portfolioState = z
  .object({
    draft: portfolioFields,
    published: publication.nullable(),
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine((value) =>
    value.version === 0
      ? value.updatedAt === null &&
        value.published === null &&
        JSON.stringify(value.draft) === JSON.stringify(blankPortfolio())
      : value.updatedAt !== null &&
        (!value.published ||
          (value.published.revision <= value.version &&
            Date.parse(value.published.publishedAt) <=
              Date.parse(value.updatedAt))),
  );
export const portfolioSnapshot = z
  .object({
    accountId: z.string().min(1),
    id: z.uuid(),
    portfolio: portfolioState,
    unavailableIds: z.array(z.uuid()).max(PORTFOLIO_PHOTO_LIMIT),
  })
  .strict();
export type PortfolioSnapshot = z.infer<typeof portfolioSnapshot>;
export const portfolioChoices = z
  .object({
    accountId: z.string().min(1),
    offset: z.number().int().min(0),
    total: z.number().int().min(0),
    pageSize: z.literal(PORTFOLIO_PAGE_SIZE),
    photos: z
      .array(
        z
          .object({
            id: z.uuid(),
            filename: z.string(),
            eventTitle: z.string(),
          })
          .strict(),
      )
      .max(PORTFOLIO_PAGE_SIZE),
  })
  .strict();
export const publicPortfolio = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(100),
    tagline: z.string().max(160),
    biography: z.string().max(1000),
    location: z.string().max(120),
    website,
    theme: z.enum(['linen', 'forest', 'midnight']),
    revision: version,
    publishedAt: z.iso.datetime(),
    photos: z
      .array(
        z
          .object({
            id: z.uuid(),
            caption: z.string().max(200),
            width: z.number().int().positive().nullable(),
            height: z.number().int().positive().nullable(),
          })
          .strict(),
      )
      .max(PORTFOLIO_PHOTO_LIMIT),
  })
  .strict();
export type PublicPortfolio = z.infer<typeof publicPortfolio>;
