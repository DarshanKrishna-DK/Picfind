import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord } from './library.js';

export const proofingText = z
  .string()
  .trim()
  .max(200)
  .refine((text) =>
    [...text].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 || code === 9 || code === 10 || code === 13;
    }),
  );
export const proofingVersion = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const snapshot = z
  .object({
    id: z.uuid(),
    round: z.number().int().min(1).max(20),
    submittedAt: z.iso.datetime(),
    decisionVersion: proofingVersion,
    collectionVersion: proofingVersion.min(1),
    favoriteIds: z
      .array(z.uuid())
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
    note: proofingText,
  })
  .strict();
export function submissionMetadataInvalid(): never {
  throw new ApiError(
    503,
    'SUBMISSION_METADATA_INVALID',
    'This submission needs metadata repair before it can be changed.',
  );
}
export function readSubmission(value: unknown) {
  const parsed = snapshot.safeParse(value);
  if (!parsed.success) return submissionMetadataInvalid();
  return parsed.data;
}
export function submissionState(row: LibraryRecord) {
  const round = row.proofingRound === undefined ? 1 : row.proofingRound;
  if (!Number.isInteger(round) || round < 1 || round > 20)
    return submissionMetadataInvalid();
  const current =
    row.proofingSubmission === undefined
      ? null
      : readSubmission(row.proofingSubmission);
  if (
    current &&
    (current.round !== round ||
      current.decisionVersion !== (row.proofingDecisionVersion ?? 0))
  )
    return submissionMetadataInvalid();
  if (
    (row.proofingReopenedFrom === undefined) !==
      (row.proofingReopenReason === undefined) ||
    (row.proofingReopenedFrom !== undefined &&
      (!z.uuid().safeParse(row.proofingReopenedFrom).success ||
        !proofingText.min(1).safeParse(row.proofingReopenReason).success))
  )
    return submissionMetadataInvalid();
  return { round, current };
}
export function checkSubmissionPayload(row: LibraryRecord) {
  if (JSON.stringify(row).length > 16_000)
    throw new ApiError(
      409,
      'SUBMISSION_CAPACITY',
      'This invitation has reached its metadata capacity. Ask the photographer for a new invitation.',
    );
}

/** Validate retained rounds before projecting history or comparing snapshots. */
export function readSubmissionHistory(
  invitation: LibraryRecord,
  jobs: LibraryRecord[],
) {
  const state = submissionState(invitation);
  const rows = jobs.filter(
    (row) =>
      row.ownerId === invitation.ownerId &&
      row.eventId === invitation.eventId &&
      row.purpose === 'proofing-submission' &&
      row.submissionInvitationId === invitation.id,
  );
  if (rows.length > 20 || rows.some((row) => row.deletionStartedAt))
    return submissionMetadataInvalid();
  const archives = rows.map((row) => {
    const item = readSubmission(row.proofingSubmission);
    if (row.kind !== 'job' || item.id !== row.id || item.round > state.round)
      return submissionMetadataInvalid();
    return item;
  });
  const rounds = new Set<number>();
  for (const item of archives) {
    if (rounds.has(item.round)) return submissionMetadataInvalid();
    rounds.add(item.round);
    if (
      item.round === state.round &&
      (!state.current || JSON.stringify(item) !== JSON.stringify(state.current))
    )
      return submissionMetadataInvalid();
  }
  return {
    ...state,
    history: archives
      .filter((item) => item.id !== state.current?.id)
      .sort((a, b) => b.round - a.round),
  };
}
