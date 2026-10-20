import { z } from 'zod';

export const ATTRIBUTION_HEADER = 'X-PicFind-Attribution';
const website = z
  .string()
  .max(512)
  .refine((value) => {
    if (!value) return true;
    try {
      encodeURIComponent(value);
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  });
export const attributionFields = z
  .object({
    name: z
      .string()
      .trim()
      .max(100)
      .refine((value) => {
        try {
          encodeURIComponent(value);
        } catch {
          return false;
        }
        return ![...value].some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        );
      }),
    website,
    published: z.boolean(),
  })
  .strict()
  .refine((value) => !value.published || value.name.length > 0);
export const storedAttributionSchema = z
  .object({
    name: z.string(),
    website: z.string(),
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
    (value) =>
      attributionFields.safeParse({
        name: value.name,
        website: value.website,
        published: value.published,
      }).success,
  );
export type StoredAttribution = z.infer<typeof storedAttributionSchema>;
export type PhotoAttribution = Omit<StoredAttribution, 'updatedAt'> & {
  updatedAt: string | null;
};
export type PublishedAttribution = { name: string; website: string };
export function publishedAttribution(
  value: unknown,
): PublishedAttribution | undefined {
  const parsed = storedAttributionSchema.safeParse(value);
  if (!parsed.success || !parsed.data.published) return undefined;
  return { name: parsed.data.name, website: parsed.data.website };
}
export function decodeAttributionHeader(
  value: string | null,
): PublishedAttribution | undefined {
  if (value === null) return undefined;
  if (value.length > 6000)
    throw new Error('Photo attribution metadata is too large.');
  try {
    const parsed = z
      .object({ name: z.string().min(1), website: z.string() })
      .strict()
      .parse(JSON.parse(decodeURIComponent(value)));
    if (!attributionFields.safeParse({ ...parsed, published: true }).success)
      throw new Error('Invalid credit');
    return parsed;
  } catch {
    throw new Error(
      'Photo attribution metadata is invalid. Refresh before downloading again.',
    );
  }
}
export function attributionCsv(
  rows: {
    archiveName: string;
    photoId: string;
    filename: string;
    credit: PublishedAttribution;
  }[],
) {
  function cell(value: string) {
    const safe =
      /^\s*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value)
        ? `'${value}`
        : value;
    return `"${safe.replaceAll('"', '""')}"`;
  }
  return (
    [
      [
        'Archive filename',
        'Photo ID',
        'Original filename',
        'Photographer credit',
        'Website',
      ],
      ...rows.map((row) => [
        row.archiveName,
        row.photoId,
        row.filename,
        row.credit.name,
        row.credit.website,
      ]),
    ]
      .map((row) => row.map(cell).join(','))
      .join('\r\n') + '\r\n'
  );
}
