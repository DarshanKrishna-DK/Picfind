import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord } from './library.js';
import type { ProofingAccessDependencies } from './proofing-decisions.js';
import { readProofingDecisions } from './proofing-decisions.js';
import {
  proofingVersion,
  readSubmission,
  readSubmissionHistory,
  submissionMetadataInvalid,
} from './proofing-submission-state.js';
import { withAccountLock } from './locks.js';
import { photoAvailable } from './retention.js';
import { compareSelections } from '../../../packages/shared/src/selection-comparison.js';
import type { StoredProofingSubmission } from '../../../packages/shared/src/proofing-submission.js';
import type {
  ComparedRound,
  SubmissionComparison,
} from '../../../packages/shared/src/submission-comparison.js';

const unavailable = () =>
  new ApiError(
    404,
    'COMPARISON_UNAVAILABLE',
    'These submitted rounds are not available in this collection.',
  );
const changed = () =>
  new ApiError(
    409,
    'COMPARISON_CHANGED',
    'The collection or a submitted round changed. Load the comparison again.',
  );
const query = z
  .object({
    firstInvitationId: z.uuid(),
    firstSubmissionId: z.uuid(),
    secondInvitationId: z.uuid(),
    secondSubmissionId: z.uuid(),
  })
  .strict()
  .refine((value) => value.firstSubmissionId !== value.secondSubmissionId);

export function createSubmissionComparison({
  store,
  actorOf,
  ownerCollection,
}: ProofingAccessDependencies) {
  const router = Router();
  router.get(
    '/events/:id/proofing-collections/:collectionId/submission-comparison',
    async (req, res) => {
      const actor = await actorOf(req);
      await ownerCollection(req, actor);
      const parsed = query.safeParse(req.query);
      if (!parsed.success)
        throw new ApiError(
          400,
          'INVALID_COMPARISON',
          'Choose two different submitted rounds in this collection.',
        );
      const choice = parsed.data;
      const result = await withAccountLock(
        actor,
        async (): Promise<SubmissionComparison> => {
          const { collection } = await ownerCollection(req, actor);
          const version = proofingVersion
            .min(1)
            .safeParse(collection.collectionVersion);
          if (!version.success) return submissionMetadataInvalid();
          async function invitation(id: string) {
            const row = await store().get(id);
            if (
              row.kind !== 'job' ||
              row.purpose !== 'collection-invitation' ||
              row.ownerId !== actor ||
              row.eventId !== collection.eventId ||
              row.invitationCollectionId !== collection.id ||
              row.deletionStartedAt
            )
              throw unavailable();
            readProofingDecisions(row);
            return row;
          }
          const firstInvitation = await invitation(choice.firstInvitationId);
          const secondInvitation =
            choice.secondInvitationId === firstInvitation.id
              ? firstInvitation
              : await invitation(choice.secondInvitationId);
          const jobs = await store().list(actor, 'job');
          function selected(row: LibraryRecord, submissionId: string) {
            const state = readSubmissionHistory(row, jobs);
            const item = [state.current, ...state.history].find(
              (candidate) => candidate?.id === submissionId,
            );
            if (!item) throw unavailable();
            return item;
          }
          const first = selected(firstInvitation, choice.firstSubmissionId);
          const second = selected(secondInvitation, choice.secondSubmissionId);
          const inventory = await store().list(actor, 'photo');
          for (const initial of new Map(
            [firstInvitation, secondInvitation].map((row) => [row.id, row]),
          ).values()) {
            const current = await invitation(initial.id);
            if (JSON.stringify(current) !== JSON.stringify(initial))
              throw changed();
          }
          // Selected archives are immutable; detect an external replacement before projection.
          for (const [item, invite] of [
            [first, firstInvitation],
            [second, secondInvitation],
          ] as const) {
            if (invite.proofingSubmission?.id === item.id) continue;
            const archive = await store().get(item.id);
            if (
              archive.kind !== 'job' ||
              archive.purpose !== 'proofing-submission' ||
              archive.ownerId !== actor ||
              archive.eventId !== collection.eventId ||
              archive.submissionInvitationId !== invite.id ||
              archive.deletionStartedAt ||
              JSON.stringify(readSubmission(archive.proofingSubmission)) !==
                JSON.stringify(item)
            )
              throw changed();
          }
          const latest = await ownerCollection(req, actor);
          if (
            latest.collection.collectionVersion !== version.data ||
            JSON.stringify(latest.collection.selectedIds) !==
              JSON.stringify(collection.selectedIds)
          )
            throw changed();
          const now = Date.now();
          const photos = inventory
            .filter(
              (photo) =>
                photo.ownerId === actor &&
                photo.eventId === collection.eventId &&
                !photo.scanId &&
                !photo.deletionStartedAt &&
                photoAvailable(photo, now) &&
                latest.collection.selectedIds?.includes(photo.id),
            )
            .map((photo) => ({
              id: photo.id,
              filename: photo.filename ?? 'photo.jpg',
            }));
          const comparison = compareSelections(
            { id: first.id, photoIds: first.favoriteIds, photos },
            { id: second.id, photoIds: second.favoriteIds, photos },
          );
          const ids = new Set(photos.map((photo) => photo.id));
          function round(
            item: StoredProofingSubmission,
            invitationId: string,
          ): ComparedRound {
            return {
              invitationId,
              submissionId: item.id,
              round: item.round,
              submittedAt: item.submittedAt,
              favoriteCount: item.favoriteIds.length,
              unavailableCount: item.favoriteIds.filter((id) => !ids.has(id))
                .length,
            };
          }
          return {
            collectionVersion: version.data,
            checkedAt: new Date(now).toISOString(),
            first: round(first, firstInvitation.id),
            second: round(second, secondInvitation.id),
            photos: comparison.photos,
            shared: comparison.shared,
          };
        },
      );
      res.json(result);
    },
  );
  return router;
}
