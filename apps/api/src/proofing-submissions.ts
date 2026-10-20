import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord } from './library.js';
import { withAccountLock } from './locks.js';
import { photoAvailable } from './retention.js';
import {
  readProofingDecisions,
  type ProofingAccessDependencies,
} from './proofing-decisions.js';
import {
  checkSubmissionPayload,
  proofingText,
  proofingVersion,
  readSubmission,
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
  async function present(
    grant: Awaited<ReturnType<typeof ownerGrant>>,
  ): Promise<ProofingSubmissionState> {
    const { invitation, collection, event } = grant;
    const state = submissionState(invitation);
    const saved = readProofingDecisions(invitation);
    const rows = (await store().list(invitation.ownerId, 'job')).filter(
      (row) =>
        row.ownerId === invitation.ownerId &&
        row.eventId === invitation.eventId &&
        row.purpose === 'proofing-submission' &&
        row.submissionInvitationId === invitation.id,
    );
    if (rows.length > 20 || rows.some((row) => row.deletionStartedAt))
      return submissionMetadataInvalid();
    const archives = rows.map((row) => {
      const submission = readSubmission(row.proofingSubmission);
      if (submission.id !== row.id || submission.round > state.round)
        return submissionMetadataInvalid();
      return submission;
    });
    const rounds = new Set<number>();
    for (const item of archives) {
      if (rounds.has(item.round)) return submissionMetadataInvalid();
      rounds.add(item.round);
      if (
        item.round === state.round &&
        (!state.current ||
          JSON.stringify(item) !== JSON.stringify(state.current))
      )
        return submissionMetadataInvalid();
    }
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
      history: archives
        .filter((item) => item.id !== state.current?.id)
        .sort((a, b) => b.round - a.round)
        .map(project),
      reopenReason: invitation.proofingReopenReason ?? null,
      canReopen: Boolean(
        state.current && state.round < 20 && active(invitation, event),
      ),
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
        await access(id, actor);
        return { ...result, canReopen: false };
      },
    );
    res.json(result);
  });
  router.get(ownerRoot, async (req, res) => {
    const actor = await actorOf(req);
    const result = await withAccountLock(actor, async () => {
      const result = await present(await ownerGrant(req, actor));
      await ownerGrant(req, actor);
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
      const row: LibraryRecord = {
        ...latest.invitation,
        proofingRound: round,
        proofingSubmission: {
          id: input.id,
          round,
          submittedAt: new Date().toISOString(),
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
        id: current.id,
        kind: 'job',
        purpose: 'proofing-submission',
        ownerId: actor,
        eventId: grant.event.id,
        createdAt: current.submittedAt,
        submissionInvitationId: grant.invitation.id,
        proofingSubmission: current,
      };
      const existing = await optionalRecord(current.id);
      if (existing) {
        if (
          existing.kind !== 'job' ||
          existing.purpose !== archive.purpose ||
          existing.ownerId !== actor ||
          existing.eventId !== archive.eventId ||
          existing.submissionInvitationId !== archive.submissionInvitationId ||
          existing.deletionStartedAt ||
          JSON.stringify(readSubmission(existing.proofingSubmission)) !==
            JSON.stringify(current)
        )
          throw conflict();
      } else await store().put(archive, true);
      const latest = await ownerGrant(req, actor);
      if (!active(latest.invitation, latest.event)) throw missing();
      if (
        JSON.stringify(submissionState(latest.invitation).current) !==
        JSON.stringify(current)
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
