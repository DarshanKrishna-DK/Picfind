import { z } from 'zod';

export const UPLOAD_QUEUE_LIMIT = 100;
export const UPLOAD_FILE_LIMIT = 8 * 1024 * 1024;
export const UPLOAD_QUEUE_STORAGE_LIMIT = 128_000;
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const item = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(255),
    size: z.number().int().min(1).max(UPLOAD_FILE_LIMIT),
    type: z.enum(UPLOAD_TYPES),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    status: z.enum(['pending', 'uploading', 'complete', 'failed', 'cancelled']),
    photoId: z.string().min(1).max(128).optional(),
    error: z.string().min(1).max(240).optional(),
  })
  .strict()
  .refine(
    (row) =>
      (row.status === 'complete') === (row.photoId !== undefined) &&
      (row.status === 'failed') === (row.error !== undefined),
  );
export const uploadQueueSchema = z
  .object({
    schema: z.literal(1),
    id: z.uuid(),
    accountId: z.string().min(1).max(128),
    eventId: z.string().min(1).max(128).nullable(),
    revision: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    mode: z.enum(['paused', 'running', 'cancelled', 'complete']),
    items: z.array(item).min(1).max(UPLOAD_QUEUE_LIMIT),
  })
  .strict()
  .refine(
    (queue) =>
      new Set(queue.items.map((row) => row.id)).size === queue.items.length &&
      new Set(queue.items.map((row) => row.digest)).size ===
        queue.items.length &&
      queue.items.filter((row) => row.status === 'uploading').length <= 1 &&
      (queue.mode === 'running' ||
        queue.items.every((row) => row.status !== 'uploading')) &&
      (queue.mode !== 'complete' ||
        queue.items.every((row) => row.status === 'complete')) &&
      (queue.mode !== 'cancelled' ||
        queue.items.every((row) =>
          ['complete', 'cancelled'].includes(row.status),
        )),
  );
export type UploadQueue = z.infer<typeof uploadQueueSchema>;
export type UploadQueueItem = UploadQueue['items'][number];

export function uploadQueueKey(accountId: string, eventId: string | null) {
  return `picfind.upload-queue.v1:${encodeURIComponent(JSON.stringify([accountId, eventId]))}`;
}
export function parseUploadQueue(
  text: string | null,
  accountId: string,
  eventId: string | null,
): UploadQueue | null {
  if (text === null) return null;
  if (text.length > UPLOAD_QUEUE_STORAGE_LIMIT)
    throw new Error('The saved upload queue is too large to read safely.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      'The saved upload queue is damaged. Its contents were not changed.',
    );
  }
  const result = uploadQueueSchema.safeParse(value);
  if (
    !result.success ||
    result.data.accountId !== accountId ||
    result.data.eventId !== eventId
  )
    throw new Error(
      'The saved upload queue is damaged or belongs to another destination. Its contents were not changed.',
    );
  return result.data;
}
