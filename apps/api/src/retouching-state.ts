import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord } from './library.js';
import { proofingText } from './proofing-submission-state.js';
import {
  RETOUCHING_CHANGE_LIMIT,
  RETOUCHING_STATUSES,
  retouchingTransition,
  type RetouchingStatus,
} from '../../../packages/shared/src/retouching.js';

export const retouchingInput = z
  .object({
    version: z.number().int().min(0).max(RETOUCHING_CHANGE_LIMIT),
    status: z.enum(RETOUCHING_STATUSES),
    note: proofingText,
  })
  .strict();
const stored = z
  .object({
    collectionId: z.uuid(),
    invitationId: z.uuid(),
    submissionId: z.uuid(),
    photoId: z.uuid(),
    history: z
      .array(
        z
          .object({
            version: z.number().int().min(1).max(RETOUCHING_CHANGE_LIMIT),
            status: z.enum(RETOUCHING_STATUSES),
            note: proofingText,
            at: z.iso.datetime(),
          })
          .strict(),
      )
      .min(1)
      .max(RETOUCHING_CHANGE_LIMIT),
  })
  .strict();

export function retouchingKey(
  invitationId: string,
  submissionId: string,
  photoId: string,
) {
  return createHash('sha256')
    .update('picfind:retouching-task:v1\0')
    .update(invitationId)
    .update('\0')
    .update(submissionId)
    .update('\0')
    .update(photoId)
    .digest('hex')
    .slice(0, 32);
}
export function invalidRetouching(): never {
  throw new ApiError(
    503,
    'RETOUCHING_METADATA_INVALID',
    'This checklist needs metadata repair before it can be used.',
  );
}
export function readRetouching(
  row: LibraryRecord | null,
  scope: {
    ownerId: string;
    eventId: string;
    collectionId: string;
    invitationId: string;
    submissionId: string;
    photoId: string;
  },
) {
  if (!row)
    return { version: 0, status: 'queued' as const, note: '', history: [] };
  const parsed = stored.safeParse(row.retouchingTask);
  if (
    !parsed.success ||
    row.kind !== 'job' ||
    row.purpose !== 'retouching-task' ||
    row.ownerId !== scope.ownerId ||
    row.eventId !== scope.eventId ||
    row.deletionStartedAt ||
    row.id !==
      retouchingKey(scope.invitationId, scope.submissionId, scope.photoId)
  )
    return invalidRetouching();
  const task = parsed.data;
  if (
    task.collectionId !== scope.collectionId ||
    task.invitationId !== scope.invitationId ||
    task.submissionId !== scope.submissionId ||
    task.photoId !== scope.photoId
  )
    return invalidRetouching();
  let prior: RetouchingStatus = 'queued';
  for (let index = 0; index < task.history.length; index++) {
    const change = task.history[index]!;
    if (
      change.version !== index + 1 ||
      !retouchingTransition(prior, change.status, change.note)
    )
      return invalidRetouching();
    prior = change.status;
  }
  const current = task.history.at(-1)!;
  return {
    version: current.version,
    status: current.status,
    note: current.note,
    history: task.history,
  };
}
