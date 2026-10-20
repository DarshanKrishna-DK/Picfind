import { Router, type Request } from 'express';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord } from './library.js';
import type { ProofingAccessDependencies } from './proofing-decisions.js';
import { withAccountLock } from './locks.js';
import { photoAvailable } from './retention.js';
import {
  checkSubmissionPayload,
  readSubmissionHistory,
} from './proofing-submission-state.js';
import {
  invalidRetouching,
  readRetouching,
  retouchingInput,
  retouchingKey,
} from './retouching-state.js';
import {
  RETOUCHING_CHANGE_LIMIT,
  retouchingTransition,
  type RetouchingChecklist,
} from '../../../packages/shared/src/retouching.js';

const missing = () =>
  new ApiError(
    404,
    'RETOUCHING_UNAVAILABLE',
    'This retouching checklist is unavailable.',
  );
const changed = () =>
  new ApiError(
    409,
    'RETOUCHING_CHANGED',
    'The checklist changed. Refresh it before saving again.',
  );
function uuid(value: unknown) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw missing();
  return parsed.data;
}
function readOnly(event: LibraryRecord) {
  return Boolean(
    event.archived ||
    (event.expiresAt && !(Date.parse(event.expiresAt) > Date.now())),
  );
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

export function createRetouchingChecklist({
  store,
  actorOf,
  ownerCollection,
}: ProofingAccessDependencies) {
  const router = Router();
  const root =
    '/events/:id/proofing-collections/:collectionId/invitations/:invitationId/submission/:submissionId/retouching';
  async function optional(id: string) {
    return store()
      .get(id)
      .catch((error) => {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      });
  }
  async function accessGrant(req: Request, actor: string) {
    const { event, collection } = await ownerCollection(req, actor);
    const invitation = await optional(uuid(req.params.invitationId));
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
    return { event, collection, invitation };
  }
  async function grant(req: Request, actor: string) {
    const access = await accessGrant(req, actor);
    const submissionId = uuid(req.params.submissionId);
    const jobs = await store().list(actor, 'job');
    const state = readSubmissionHistory(access.invitation, jobs);
    const submission = [state.current, ...state.history].find(
      (item) => item?.id === submissionId,
    );
    if (!submission) throw missing();
    return { ...access, submission, jobs };
  }
  type Grant = Awaited<ReturnType<typeof grant>>;
  function scope(g: Grant, photoId: string) {
    return {
      ownerId: g.event.ownerId,
      eventId: g.event.id,
      collectionId: g.collection.id,
      invitationId: g.invitation.id,
      submissionId: g.submission.id,
      photoId,
    };
  }
  function unchanged(
    a: Awaited<ReturnType<typeof accessGrant>>,
    b: Awaited<ReturnType<typeof accessGrant>>,
  ) {
    if (
      !isDeepStrictEqual(
        [a.event, a.collection, a.invitation],
        [b.event, b.collection, b.invitation],
      )
    )
      throw changed();
  }
  function checkedKey(g: Grant, photoId: string) {
    const key = retouchingKey(g.invitation.id, g.submission.id, photoId);
    if (
      g.jobs.some(
        (row) =>
          row.purpose === 'retouching-task' &&
          row.retouchingTask?.invitationId === g.invitation.id &&
          row.retouchingTask.submissionId === g.submission.id &&
          row.retouchingTask.photoId === photoId &&
          row.id !== key,
      )
    )
      return invalidRetouching();
    return key;
  }
  router.get(root, async (req, res) => {
    const actor = await actorOf(req);
    await ownerCollection(req, actor);
    const result = await withAccountLock(
      actor,
      async (): Promise<RetouchingChecklist> => {
        const initial = await accessGrant(req, actor);
        const photos = await store().list(actor, 'photo');
        const latest = await grant(req, actor);
        unchanged(initial, latest);
        const byId = new Map(
          photos
            .filter((photo) => available(photo, latest.collection))
            .map((photo) => [photo.id, photo]),
        );
        const tasks = new Map(latest.jobs.map((row) => [row.id, row]));
        const items = latest.submission.favoriteIds.flatMap((photoId) => {
          const photo = byId.get(photoId);
          if (!photo || !available(photo, latest.collection)) return [];
          // A record claiming this scope under a different key is corruption, not an empty task.
          const key = checkedKey(latest, photoId);
          return [
            {
              photoId,
              filename: photo.filename ?? 'photo.jpg',
              ...readRetouching(tasks.get(key) ?? null, scope(latest, photoId)),
            },
          ];
        });
        return {
          submissionId: latest.submission.id,
          round: latest.submission.round,
          readOnly: readOnly(latest.event),
          unavailableCount: latest.submission.favoriteIds.length - items.length,
          items,
        };
      },
    );
    res.json(result);
  });
  router.patch(`${root}/:photoId`, async (req, res) => {
    const actor = await actorOf(req);
    await ownerCollection(req, actor);
    const parsed = retouchingInput.safeParse(req.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'RETOUCHING_INPUT_INVALID',
        'Choose a valid work status and a note of up to 200 characters.',
      );
    const input = parsed.data,
      photoId = uuid(req.params.photoId);
    await withAccountLock(actor, async () => {
      const initial = await grant(req, actor);
      if (readOnly(initial.event))
        throw new ApiError(
          409,
          'RETOUCHING_READ_ONLY',
          'This event is read-only.',
        );
      if (!initial.submission.favoriteIds.includes(photoId)) throw missing();
      const photo = await optional(photoId);
      if (!photo || !available(photo, initial.collection)) throw missing();
      const key = checkedKey(initial, photoId);
      const existing = await optional(key);
      const saved = readRetouching(existing, scope(initial, photoId));
      const latest = await grant(req, actor);
      unchanged(initial, latest);
      if (!isDeepStrictEqual(initial.submission, latest.submission))
        throw changed();
      checkedKey(latest, photoId);
      const latestPhoto = await optional(photoId);
      const latestTask = await optional(key);
      if (!latestPhoto || !available(latestPhoto, latest.collection))
        throw missing();
      if (readOnly(latest.event))
        throw new ApiError(
          409,
          'RETOUCHING_READ_ONLY',
          'This event is read-only.',
        );
      if (!isDeepStrictEqual(existing, latestTask)) throw changed();
      const same = input.status === saved.status && input.note === saved.note;
      if (
        same &&
        (input.version === saved.version || input.version + 1 === saved.version)
      )
        return;
      if (input.version !== saved.version) throw changed();
      if (saved.version >= RETOUCHING_CHANGE_LIMIT)
        throw new ApiError(
          409,
          'RETOUCHING_CAPACITY',
          'This photo has reached 30 recorded changes for this round. Its history is retained.',
        );
      if (!retouchingTransition(saved.status, input.status, input.note))
        throw new ApiError(
          409,
          'RETOUCHING_TRANSITION',
          'Move queued work to editing before marking it ready. Explain a return to an earlier status.',
        );
      const at = new Date().toISOString();
      const row: LibraryRecord = {
        id: key,
        kind: 'job',
        purpose: 'retouching-task',
        ownerId: actor,
        eventId: latest.event.id,
        createdAt: existing?.createdAt ?? at,
        retouchingTask: {
          collectionId: latest.collection.id,
          invitationId: latest.invitation.id,
          submissionId: latest.submission.id,
          photoId,
          history: [
            ...saved.history,
            {
              version: saved.version + 1,
              status: input.status,
              note: input.note,
              at,
            },
          ],
        },
      };
      checkSubmissionPayload(row);
      await store().put(row, !existing);
    });
    res.json({ saved: true });
  });
  return router;
}
