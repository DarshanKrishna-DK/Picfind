import { z } from 'zod';

export const RAW_PAIR_LIMIT = 100;
export const RAW_SELECTION_LIMIT = 500;
export const RAW_MANIFEST_LIMIT = 512_000;
const rawExtension =
  /\.(arw|cr2|cr3|nef|nrw|raf|rw2|orf|pef|dng|srw|3fr|fff|iiq|rwl|x3f)$/i;
const pathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    const parts = value.split('/');
    return (
      !/[\\:]/.test(value) &&
      ![...value].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) &&
      parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
    );
  });
const choiceSchema = z.union([
  z.literal('skip'),
  z
    .object({
      photoId: z.string().min(1).max(128),
      filename: z.string().min(1).max(512),
    })
    .strict(),
  z.null(),
]);
export const rawPairSchema = z
  .object({
    path: pathSchema.refine((value) => rawExtension.test(value)),
    size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    modifiedAt: z.number().int().min(0).max(8_640_000_000_000_000),
    choice: choiceSchema,
  })
  .strict();
export type RawPair = z.infer<typeof rawPairSchema>;
export type PairPhoto = { id: string; filename: string };
const manifestSchema = z
  .object({
    schema: z.literal(1),
    accountId: z.string().min(1).max(128),
    eventId: z.string().min(1).max(128),
    entries: z.array(rawPairSchema).min(1).max(RAW_PAIR_LIMIT),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.entries.map((item) => item.path)).size ===
      value.entries.length,
  );

export function rawBasename(path: string) {
  return path
    .split('/')
    .at(-1)!
    .replace(/\.[^.]+$/, '')
    .normalize('NFC')
    .toLocaleLowerCase('en-US');
}
export function eventJpegs(photos: readonly PairPhoto[]) {
  const ids = new Set<string>();
  for (const photo of photos) {
    if (!photo.id || ids.has(photo.id) || typeof photo.filename !== 'string')
      throw new Error(
        'The event photo list is inconsistent. Refresh before pairing.',
      );
    ids.add(photo.id);
  }
  return photos.filter((photo) => /\.jpe?g$/i.test(photo.filename));
}

export function prepareRawPairs(
  files: readonly {
    name: string;
    webkitRelativePath?: string;
    size: number;
    lastModified: number;
  }[],
) {
  if (!files.length || files.length > RAW_SELECTION_LIMIT)
    throw new Error(
      `Choose between 1 and ${RAW_SELECTION_LIMIT} files at a time.`,
    );
  const entries: RawPair[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    if (!pathSchema.safeParse(path).success) {
      skipped.push({
        path: file.name.slice(0, 255),
        reason: 'Invalid relative path.',
      });
      continue;
    }
    if (!rawExtension.test(path)) {
      skipped.push({ path, reason: 'Not a supported RAW filename.' });
      continue;
    }
    const parsed = rawPairSchema.safeParse({
      path,
      size: file.size,
      modifiedAt: file.lastModified,
      choice: null,
    });
    if (!parsed.success) {
      skipped.push({ path, reason: 'Empty file or invalid file metadata.' });
      continue;
    }
    if (seen.has(path))
      throw new Error(
        'Two selected RAW files have the same relative path. Select their parent folder to distinguish them.',
      );
    seen.add(path);
    entries.push(parsed.data);
  }
  if (!entries.length)
    throw new Error('No supported, nonempty RAW files were selected.');
  if (entries.length > RAW_PAIR_LIMIT)
    throw new Error(
      `Choose at most ${RAW_PAIR_LIMIT} supported RAW files for one mapping.`,
    );
  return { entries, skipped };
}

export type PairResolution = {
  entry: RawPair;
  status:
    'unresolved' | 'skipped' | 'ready' | 'unavailable' | 'renamed' | 'conflict';
  suggestion: PairPhoto | null;
  photo: PairPhoto | null;
};
export function resolveRawPairs(
  entries: readonly RawPair[],
  photos: readonly PairPhoto[],
): PairResolution[] {
  const jpegs = eventJpegs(photos);
  const byId = new Map(jpegs.map((photo) => [photo.id, photo]));
  const rawNames = new Map<string, number>();
  const targets = new Map<string, number>();
  for (const entry of entries) {
    const name = rawBasename(entry.path);
    rawNames.set(name, (rawNames.get(name) ?? 0) + 1);
    if (entry.choice && entry.choice !== 'skip')
      targets.set(
        entry.choice.photoId,
        (targets.get(entry.choice.photoId) ?? 0) + 1,
      );
  }
  return entries.map((entry) => {
    const candidates = jpegs.filter(
      (photo) => rawBasename(photo.filename) === rawBasename(entry.path),
    );
    const suggestion =
      rawNames.get(rawBasename(entry.path)) === 1 && candidates.length === 1
        ? candidates[0]!
        : null;
    const choice = entry.choice;
    if (choice === 'skip')
      return { entry, status: 'skipped', suggestion, photo: null };
    if (!choice)
      return { entry, status: 'unresolved', suggestion, photo: null };
    const photo = byId.get(choice.photoId) ?? null;
    return {
      entry,
      suggestion,
      photo,
      status: !photo
        ? 'unavailable'
        : photo.filename !== choice.filename
          ? 'renamed'
          : targets.get(photo.id)! > 1
            ? 'conflict'
            : 'ready',
    };
  });
}

export function applyRawSuggestions(
  entries: readonly RawPair[],
  photos: readonly PairPhoto[],
) {
  const resolved = resolveRawPairs(entries, photos);
  const used = new Set(
    entries.flatMap((entry) =>
      entry.choice && entry.choice !== 'skip' ? [entry.choice.photoId] : [],
    ),
  );
  return resolved.map(({ entry, suggestion }) => {
    if (entry.choice || !suggestion || used.has(suggestion.id)) return entry;
    used.add(suggestion.id);
    return {
      ...entry,
      choice: { photoId: suggestion.id, filename: suggestion.filename },
    };
  });
}

export function encodeRawMapping(
  accountId: string,
  eventId: string,
  entries: readonly RawPair[],
) {
  const value = manifestSchema.safeParse({
    schema: 1,
    accountId,
    eventId,
    entries,
  });
  if (!value.success) throw new Error('This RAW mapping has invalid metadata.');
  const text = JSON.stringify(value.data, null, 2);
  if (new TextEncoder().encode(text).byteLength > RAW_MANIFEST_LIMIT)
    throw new Error('This RAW mapping is too large.');
  return text;
}
export function decodeRawMapping(
  text: string,
  accountId: string,
  eventId: string,
): RawPair[] {
  if (
    text.length > RAW_MANIFEST_LIMIT ||
    new TextEncoder().encode(text).byteLength > RAW_MANIFEST_LIMIT
  )
    throw new Error('This RAW mapping is too large.');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('This file is not a valid RAW mapping.');
  }
  const value = manifestSchema.safeParse(json);
  if (!value.success) throw new Error('This file is not a valid RAW mapping.');
  if (value.data.accountId !== accountId || value.data.eventId !== eventId)
    throw new Error('This mapping belongs to another account or event.');
  return value.data.entries;
}
function csvCell(value: string) {
  const safe =
    /^\s*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function exportRawPairs(
  entries: readonly RawPair[],
  photos: readonly PairPhoto[],
) {
  const resolved = resolveRawPairs(entries, photos);
  const invalid = resolved.filter(
    (row) => !['ready', 'skipped'].includes(row.status),
  );
  if (invalid.length)
    throw new Error(
      `Review ${invalid.length} unresolved or changed mappings before exporting.`,
    );
  const ready = resolved.filter((row) => row.status === 'ready');
  if (!ready.length)
    throw new Error(
      'Choose at least one RAW to JPEG mapping before exporting.',
    );
  const rows = [
    [
      'RAW relative path',
      'RAW bytes',
      'RAW modified time (UTC)',
      'Photo ID',
      'JPEG filename',
    ],
    ...ready.map(({ entry, photo }) => [
      entry.path,
      String(entry.size),
      entry.modifiedAt ? new Date(entry.modifiedAt).toISOString() : '',
      photo!.id,
      photo!.filename,
    ]),
  ];
  return {
    content:
      rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n',
    count: ready.length,
    skipped: resolved.length - ready.length,
  };
}
