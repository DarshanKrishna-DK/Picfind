import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord } from './library.js';
import { DEFAULT_PROOFING_POLICY } from '../../../packages/shared/src/proofing-policy.js';
import { selectionWindow } from '../../../packages/shared/src/selection-window.js';

export const proofingPolicy = z
  .object({
    minimum: z.number().int().min(0).max(100),
    maximum: z.number().int().min(1).max(100),
    closesAt: z
      .string()
      .refine((value) => {
        const time = Date.parse(value);
        return Number.isFinite(time) && new Date(time).toISOString() === value;
      })
      .nullable(),
  })
  .strict()
  .refine((value) => value.minimum <= value.maximum);

export function readProofingPolicy(collection: LibraryRecord) {
  const parsed = proofingPolicy.safeParse(
    collection.submissionPolicy === undefined
      ? DEFAULT_PROOFING_POLICY
      : collection.submissionPolicy,
  );
  if (!parsed.success)
    throw new ApiError(
      503,
      'COLLECTION_POLICY_INVALID',
      'This collection needs its submission policy repaired by the photographer.',
    );
  return parsed.data;
}

export function requireProofingSubmission(
  collection: LibraryRecord,
  favoriteCount: number,
  now: number,
) {
  const policy = readProofingPolicy(collection);
  if (selectionWindow(policy.closesAt ?? undefined, now).closed)
    throw new ApiError(
      409,
      'SUBMISSION_CLOSED',
      'The final submission deadline has passed. Ask your photographer to extend it.',
    );
  if (favoriteCount < policy.minimum || favoriteCount > policy.maximum)
    throw new ApiError(
      409,
      'SUBMISSION_COUNT',
      `Save between ${policy.minimum} and ${policy.maximum} favorites before submitting.`,
    );
}
