import { Router, type Request } from 'express';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord } from './library.js';
import { withAccountLock } from './locks.js';
import { photoAvailable } from './retention.js';
import { submissionArchiveId } from './proofing-archive.js';
import {
  readProofingPolicy,
  requireProofingSubmission,
} from './proofing-policy.js';
import { selectionWindow } from '../../../packages/shared/src/selection-window.js';
import {
  readProofingDecisions,
  type ProofingAccessDependencies,
} from './proofing-decisions.js';
import {
  checkSubmissionPayload,
  proofingText,
  proofingVersion,
  readSubmission,
  readSubmissionHistory,
  submissionMetadataInvalid,
  submissionState,
} from './proofing-submission-state.js';
import type {
  StoredProofingSubmission,
  ProofingSubmission,
  ProofingSubmissionState,
} from '../../../packages/shared/src/proofing-submission.js';

const missing = () =>
  new ApiError(
    404,
    'INVITATION_UNAVAILABLE',
    'This collection invitation is unavailable for this account.',
  );
const conflict = () =>
  new ApiError(
    409,
    'SUBMISSION_CHANGED',
    'Refresh the saved decisions and submission before trying again.',
  );
function invitationId(req: Request) {
  const parsed = z.uuid().safeParse(req.params.invitationId);
  if (!parsed.success) throw missing();
  return parsed.data;
}
function active(row: LibraryRecord, event: LibraryRecord) {
  return (
    !row.invitationRevokedAt &&
    !event.archived &&
    !event.deletionStartedAt &&
    !row.deletionStartedAt &&
    Date.parse(row.expiresAt ?? '') > Date.now() &&
    (!event.expiresAt || Date.parse(event.expiresAt) > Date.now())
  );
}
function collectionVersion(row: LibraryRecord) {
  const result = proofingVersion.min(1).safeParse(row.collectionVersion);
  if (!result.success) return submissionMetadataInvalid();
  return result.data;
}

export function createProofingSubmissions(
  dependencies: ProofingAccessDependencies,
) {
  const { store, actorOf, access, ownerCollection } = dependencies;
  const router = Router();
  const clientRoot = '/proofing-invitations/:invitationId/submission';
  const ownerRoot =
    '/events/:id/proofing-collections/:collectionId/invitations/:invitationId/submission';
  async function optionalRecord(id: string) {
    return store()
      .get(id)
      .catch((error) => {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      });
  }
  async function ownerGrant(req: Request, actor: string) {
    const { event, collection } = await ownerCollection(req, actor);
    const invitation = await optionalRecord(invitationId(req));
    if (
      !invitation ||
      invitation.kind !== 'job' ||
      invitation.purpose !== 'collection-invitation' ||
      invitation.ownerId !== actor ||
      invitation.eventId !== event.id ||
      invitation.invitationCollectionId !== collection.id ||
      invitation.deletionStartedAt
    )
      throw missing();
    return { invitation, event, collection };
  }
  function available(photo: LibraryRecord, collection: LibraryRecord) {
    return (
      photo.kind === 'photo' &&
      photo.ownerId === collection.ownerId &&
      photo.eventId === collection.eventId &&
      !photo.scanId &&
      !photo.deletionStartedAt &&
      photoAvailable(photo) &&
      Boolean(collection.selectedIds?.includes(photo.id))
    );
  }
  function requireUnchanged(
    initial: Awaited<ReturnType<typeof ownerGrant>>,
    latest: Awaited<ReturnType<typeof ownerGrant>>,
  ) {
    if (
      collectionVersion(initial.collection) !==
        collectionVersion(latest.collection) ||
      readProofingDecisions(initial.invitation).version !==
        readProofingDecisions(latest.invitation).version ||
      JSON.stringify(submissionState(initial.invitation)) !==
        JSON.stringify(submissionState(latest.invitation)) ||
      initial.invitation.proofingReopenReason !==
        latest.invitation.proofingReopenReason
    )
      throw conflict();
  }
  async function present(
    grant: Awaited<ReturnType<typeof ownerGrant>>,
  ): Promise<ProofingSubmissionState> {
    const { invitation, collection, event } = grant;
    const state = readSubmissionHistory(
      invitation,
      await store().list(invitation.ownerId, 'job'),
    );
    const saved = readProofingDecisions(invitation);
    const policy = readProofingPolicy(collection);
    const photos = await store().list(invitation.ownerId, 'photo');
    const byId = new Map(
      photos
        .filter((photo) => available(photo, collection))
        .map((photo) => [photo.id, photo]),
    );
    function project(item: StoredProofingSubmission): ProofingSubmission {
      const visible = item.favoriteIds.flatMap((photoId) => {
        const photo = byId.get(photoId);
        return photo && photoAvailable(photo)
          ? [{ photoId, filename: photo.filename ?? 'photo.jpg' }]
          : [];
      });
      return {
        id: item.id,
        round: item.round,
        submittedAt: item.submittedAt,
        decisionVersion: item.decisionVersion,
        collectionVersion: item.collectionVersion,
        note: item.note,
        favoriteCount: item.favoriteIds.length,
        unavailableCount: item.favoriteIds.length - visible.length,
        photos: visible,
      };
    }
    return {
      round: state.round,
      decisionVersion: saved.version,
      collectionVersion: collectionVersion(collection),
      current: state.current ? project(state.current) : null,
      history: state.history.map(project),
      reopenReason: invitation.proofingReopenReason ?? null,
      canReopen: Boolean(
        state.current && state.round < 20 && active(invitation, event),
      ),
      requirements: {
        policy,
        window: selectionWindow(policy.closesAt ?? undefined),
        favoriteCount: saved.entries.filter(
          (entry) => entry.status === 'favorite',
        ).length,
        unavailableCount: saved.entries.filter(
          (entry) => entry.status === 'favorite' && !byId.has(entry.photoId),
        ).length,
      },
    };
  }
  router.get(clientRoot, async (req, res) => {
    const actor = await actorOf(req),
      id = invitationId(req);
    const initial = await access(id, actor);
    const result = await withAccountLock(
      initial.invitation.ownerId,
      async () => {
        const grant = await access(id, actor);
        const result = await present(grant);
        requireUnchanged(grant, await access(id, actor));
        return { ...result, canReopen: false };
      },
    );
    res.json(result);
  });
  router.get(ownerRoot, async (req, res) => {
    const actor = await actorOf(req);
    const result = await withAccountLock(actor, async () => {
      const grant = await ownerGrant(req, actor);
      const result = await present(grant);
      requireUnchanged(grant, await ownerGrant(req, actor));
      return result;
    });
    res.json(result);
  });
  router.post(clientRoot, async (req, res) => {
    const actor = await actorOf(req),
      id = invitationId(req);
    const initial = await access(id, actor);
    const parsed = z
      .object({
        id: z.uuid(),
        decisionVersion: proofingVersion,
        collectionVersion: proofingVersion.min(1),
        note: proofingText,
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_SUBMISSION',
        'Use the current versions and a note of at most 200 characters.',
      );
    const input = parsed.data;
    await withAccountLock(initial.invitation.ownerId, async () => {
      const grant = await access(id, actor);
      const { current, round } = submissionState(grant.invitation);
      const saved = readProofingDecisions(grant.invitation);
      if (current) {
        if (
          current.id === input.id &&
          current.decisionVersion === input.decisionVersion &&
          current.collectionVersion === input.collectionVersion &&
          current.note === input.note
        )
          return;
        throw conflict();
      }
      if (
        saved.version !== input.decisionVersion ||
        collectionVersion(grant.collection) !== input.collectionVersion
      )
        throw conflict();
      if (await optionalRecord(input.id)) throw conflict();
      if (
        await optionalRecord(submissionArchiveId(grant.invitation.id, input.id))
      )
        throw conflict();
      const favoriteIds = saved.entries
        .filter((item) => item.status === 'favorite')
        .map((item) => item.photoId);
      for (const photoId of favoriteIds) {
        const photo = await optionalRecord(photoId);
        if (!photo || !available(photo, grant.collection))
          throw new ApiError(
            409,
            'SUBMISSION_PHOTO_UNAVAILABLE',
            'A favorite is no longer available. Review and save the current choices before submitting.',
          );
      }
      const latest = await access(id, actor);
      if (
        readProofingDecisions(latest.invitation).version !==
          input.decisionVersion ||
        collectionVersion(latest.collection) !== input.collectionVersion ||
        submissionState(latest.invitation).current
      )
        throw conflict();
      const submittedAt = Date.now();
      requireProofingSubmission(
        latest.collection,
        favoriteIds.length,
        submittedAt,
      );
      const row: LibraryRecord = {
        ...latest.invitation,
        proofingRound: round,
        proofingSubmission: {
          id: input.id,
          round,
          submittedAt: new Date(submittedAt).toISOString(),
          decisionVersion: input.decisionVersion,
          collectionVersion: input.collectionVersion,
          favoriteIds,
          note: input.note,
        },
      };
      checkSubmissionPayload(row);
      await store().put(row);
    });
    res.json({ submitted: true, id: input.id });
  });
  router.post(ownerRoot, async (req, res) => {
    const actor = await actorOf(req);
    await ownerGrant(req, actor);
    const parsed = z
      .object({ submissionId: z.uuid(), reason: proofingText.min(1) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'INVALID_REOPEN',
        'Choose the current submission and give a reason of at most 200 characters.',
      );
    const input = parsed.data;
    await withAccountLock(actor, async () => {
      const grant = await ownerGrant(req, actor);
      if (!active(grant.invitation, grant.event)) throw missing();
      const { current, round } = submissionState(grant.invitation);
      const saved = readProofingDecisions(grant.invitation);
      if (!current) {
        if (
          grant.invitation.proofingReopenedFrom === input.submissionId &&
          grant.invitation.proofingReopenReason === input.reason
        )
          return;
        throw conflict();
      }
      if (current.id !== input.submissionId) throw conflict();
      if (round >= 20)
        throw new ApiError(
          409,
          'SUBMISSION_ROUND_LIMIT',
          'This invitation has reached 20 rounds. Create a new invitation to continue.',
        );
      if (saved.version >= Number.MAX_SAFE_INTEGER - 1)
        return submissionMetadataInvalid();
      const archive: LibraryRecord = {
        id: submissionArchiveId(grant.invitation.id, current.id),
        kind: 'job',
        purpose: 'proofing-submission',
        ownerId: actor,
        eventId: grant.event.id,
        createdAt: current.submittedAt,
        submissionInvitationId: grant.invitation.id,
        proofingSubmission: current,
      };
      const scoped = await optionalRecord(archive.id);
      const legacy = await optionalRecord(current.id);
      const legacyForInvitation =
        legacy?.purpose === 'proofing-submission' &&
        legacy.submissionInvitationId === grant.invitation.id
          ? legacy
          : null;
      if (scoped && legacyForInvitation) throw conflict();
      const existing = scoped ?? legacyForInvitation;
      if (existing) {
        if (
          existing.kind !== 'job' ||
          existing.purpose !== archive.purpose ||
          existing.ownerId !== actor ||
          existing.eventId !== archive.eventId ||
          existing.submissionInvitationId !== archive.submissionInvitationId ||
          existing.deletionStartedAt ||
          !isDeepStrictEqual(
            readSubmission(existing.proofingSubmission),
            current,
          )
        )
          throw conflict();
      } else await store().put(archive, true);
      const latest = await ownerGrant(req, actor);
      if (!active(latest.invitation, latest.event)) throw missing();
      if (
        !isDeepStrictEqual(submissionState(latest.invitation).current, current)
      )
        throw conflict();
      const row: LibraryRecord = {
        ...latest.invitation,
        proofingRound: round + 1,
        proofingDecisionVersion: saved.version + 1,
        proofingDecisions: saved.entries,
        proofingDecisionUpdatedAt: new Date().toISOString(),
        proofingReopenedFrom: current.id,
        proofingReopenReason: input.reason,
      };
      delete row.proofingSubmission;
      checkSubmissionPayload(row);
      await store().put(row);
    });
    res.json({ reopened: true });
  });
  return router;
}
