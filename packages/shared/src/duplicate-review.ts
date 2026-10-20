import { z } from 'zod';
import {
  UPLOAD_FILE_LIMIT,
  UPLOAD_QUEUE_LIMIT,
  UPLOAD_TYPES,
} from './upload-queue.js';

export const DUPLICATE_FILE_LIMIT = UPLOAD_FILE_LIMIT;
export const DUPLICATE_BATCH_LIMIT = 256 * 1024 * 1024;
export const DUPLICATE_COUNT_LIMIT = UPLOAD_QUEUE_LIMIT;
const fileMetadata = z
  .object({
    name: z.string().min(1).max(255),
    size: z.number().int().min(1).max(DUPLICATE_FILE_LIMIT),
    type: z.enum(UPLOAD_TYPES),
    modifiedAt: z.number().int().min(0).max(8_640_000_000_000_000),
  })
  .strict();
const reviewRow = fileMetadata
  .extend({
    row: z.number().int().min(1).max(DUPLICATE_COUNT_LIMIT),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    keep: z.boolean(),
  })
  .strict();
export type DuplicateRow = z.infer<typeof reviewRow>;

export function duplicateGroups(rows: readonly DuplicateRow[]) {
  const groups = new Map<string, DuplicateRow[]>();
  for (const row of rows) {
    const key = `${row.size}:${row.digest}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}
export const duplicateReview = z
  .array(reviewRow)
  .min(1)
  .max(DUPLICATE_COUNT_LIMIT)
  .refine(
    (rows) =>
      rows.every((row, index) => row.row === index + 1) &&
      rows.reduce((total, row) => total + row.size, 0) <=
        DUPLICATE_BATCH_LIMIT &&
      duplicateGroups(rows).every((group) => group.some((row) => row.keep)),
    'Every file group must retain a copy and input row numbers must remain unchanged.',
  );
export function setDuplicateKeep(
  rows: readonly DuplicateRow[],
  rowNumber: number,
  keep: boolean,
): DuplicateRow[] {
  const current = duplicateReview.parse(rows);
  if (!current.some((row) => row.row === rowNumber))
    throw new Error('This file is not in the current review.');
  const next = current.map((row) =>
    row.row === rowNumber ? { ...row, keep } : row,
  );
  if (!duplicateReview.safeParse(next).success)
    throw new Error('Keep at least one copy of each file.');
  return next;
}
export function keepOneDuplicateCopy(
  rows: readonly DuplicateRow[],
): DuplicateRow[] {
  const current = duplicateReview.parse(rows);
  const chosen = new Set(
    duplicateGroups(current).map((group) => group.find((row) => row.keep)!.row),
  );
  return current.map((row) => ({ ...row, keep: chosen.has(row.row) }));
}
export function duplicateSummary(rows: readonly DuplicateRow[]) {
  const groups = duplicateGroups(rows);
  return {
    groups: groups.filter((group) => group.length > 1).length,
    extraCopies: rows.length - groups.length,
    kept: rows.filter((row) => row.keep).length,
    excluded: rows.filter((row) => !row.keep).length,
    excludedBytes: rows.reduce(
      (total, row) => total + (row.keep ? 0 : row.size),
      0,
    ),
  };
}
export interface DuplicateInput {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export async function scanDuplicateFiles(
  files: readonly DuplicateInput[],
  signal: AbortSignal,
  progress: (completed: number) => void,
  digest: (bytes: ArrayBuffer) => Promise<ArrayBuffer>,
): Promise<DuplicateRow[]> {
  signal.throwIfAborted();
  if (!files.length || files.length > DUPLICATE_COUNT_LIMIT)
    throw new Error('Choose between 1 and 100 files.');
  const metadata = files.map((file) => {
    const parsed = fileMetadata.safeParse({
      name: file.name,
      size: file.size,
      type: file.type,
      modifiedAt: file.lastModified,
    });
    if (!parsed.success)
      throw new Error(
        'Choose JPEG, PNG or WebP files with valid names, each between 1 byte and 8 MiB.',
      );
    return parsed.data;
  });
  if (
    metadata.reduce((total, file) => total + file.size, 0) >
    DUPLICATE_BATCH_LIMIT
  )
    throw new Error('Choose no more than 256 MiB per review.');
  const rows: DuplicateRow[] = [];
  for (let index = 0; index < files.length; index++) {
    signal.throwIfAborted();
    const bytes = await files[index]!.arrayBuffer();
    signal.throwIfAborted();
    if (bytes.byteLength !== metadata[index]!.size)
      throw new Error(
        'A selected file changed while it was being read. Select the files again.',
      );
    const hash = await digest(bytes);
    signal.throwIfAborted();
    if (hash.byteLength !== 32)
      throw new Error('SHA-256 is unavailable. No review was created.');
    rows.push({
      ...metadata[index]!,
      row: index + 1,
      digest: [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
      keep: true,
    });
    progress(index + 1);
  }
  signal.throwIfAborted();
  return duplicateReview.parse(rows);
}
function csvCell(value: string) {
  const safe =
    /^\s*[=+\-@]/u.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function exportDuplicateReview(
  rows: readonly DuplicateRow[],
  format: 'csv' | 'json',
) {
  const checked = duplicateReview.parse(rows);
  const items = checked.map(({ keep, ...row }) => ({
    ...row,
    decision: keep ? 'keep' : 'exclude-from-selection',
  }));
  if (format === 'json')
    return JSON.stringify(
      {
        schema: 1,
        algorithm: 'SHA-256',
        scope: 'exact-file-bytes',
        originalsChanged: false,
        items,
      },
      null,
      2,
    );
  return (
    [
      [
        'Input row',
        'Filename',
        'Bytes',
        'MIME metadata',
        'Modified timestamp (ms)',
        'SHA-256',
        'Decision',
      ],
      ...items.map((row) => [
        String(row.row),
        row.name,
        String(row.size),
        row.type,
        String(row.modifiedAt),
        row.digest,
        row.decision,
      ]),
    ]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n') + '\r\n'
  );
}
