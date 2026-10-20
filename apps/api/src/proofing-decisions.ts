import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { photoAvailable } from './retention.js';
import { submissionState } from './proofing-submission-state.js';
import {
  PROOFING_DECISIONS,
  type ProofingDecisions,
} from '../../../packages/shared/src/proofing-decisions.js';

const entry = z
  .object({ photoId: z.uuid(), status: z.enum(PROOFING_DECISIONS) })
  .strict();
const versionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const storedSchema = z
  .array(entry)
  .max(100)
  .refine(
    (rows) => new Set(rows.map((row) => row.photoId)).size === rows.length,
  );
const missing = () =>
  new ApiError(
    404,
    'INVITATION_UNAVAILABLE',
    'This collection invitation is unavailable for this account.',
  );
function invitationId(req: Request) {
  const parsed = z.uuid().safeParse(req.params.invitationId);
  if (!parsed.success) throw missing();
  return parsed.data;
}
export function readProofingDecisions(row: LibraryRecord) {
  const entries = storedSchema.safeParse(row.proofingDecisions ?? []);
  const version = versionSchema.safeParse(row.proofingDecisionVersion ?? 0);
  const untouched =
    row.proofingDecisions === undefined &&
    row.proofingDecisionVersion === undefined &&
    row.proofingDecisionUpdatedAt === undefined;
  if (
    !entries.success ||
    !version.success ||
    (!untouched &&
      (row.proofingDecisions === undefined ||
        !row.proofingDecisionVersion ||
        !row.proofingDecisionUpdatedAt ||
        !Number.isFinite(Date.parse(row.proofingDecisionUpdatedAt))))
  )
    throw new ApiError(
      503,
      'DECISIONS_METADATA_INVALID',
      'These decisions need metadata repair before they can be changed.',
    );
  return {
    entries: entries.data,
    version: version.data,
    updatedAt: row.proofingDecisionUpdatedAt ?? null,
  };
}

export interface ProofingAccessDependencies {
  store: () => LibraryStore;
  actorOf: (req: Request) => Promise<string>;
  access: (
    invitationId: string,
    actor: string,
  ) => Promise<{
    invitation: LibraryRecord;
    event: LibraryRecord;
    collection: LibraryRecord;
  }>;
  ownerCollection: (
    req: Request,
    actor: string,
  ) => Promise<{ event: LibraryRecord; collection: LibraryRecord }>;
}
export function createProofingDecisions(
  dependencies: ProofingAccessDependencies,
) {
  const { store, actorOf, access, ownerCollection } = dependencies;
  const router = Router();
  async function photosOf(collection: LibraryRecord) {
    return (await store().list(collection.ownerId, 'photo')).filter(
      (photo) =>
        photo.ownerId === collection.ownerId &&
        photo.eventId === collection.eventId &&
        !photo.scanId &&
        !photo.deletionStartedAt &&
        photoAvailable(photo) &&
        collection.selectedIds?.includes(photo.id),
    );
  }
  function present(
    row: LibraryRecord,
    photos: LibraryRecord[],
  ): ProofingDecisions {
    const saved = readProofingDecisions(row);
    const { current } = submissionState(row);
    const byId = new Map(
      photos
        .filter((photo) => photoAvailable(photo))
        .map((photo) => [photo.id, photo]),
    );
    const decisions = saved.entries.flatMap((item) => {
      const photo = byId.get(item.photoId);
      return photo
        ? [{ ...item, filename: photo.filename ?? 'photo.jpg' }]
        : [];
    });
    return {
      version: saved.version,
      updatedAt: saved.updatedAt,
      decisions,
      unavailableCount: saved.entries.length - decisions.length,
      ...(current
        ? {
            submitted: {
              id: current.id,
              round: current.round,
              submittedAt: current.submittedAt,
            },
          }
        : {}),
    };
  }
  const clientRoot = '/proofing-invitations/:invitationId/decisions';
  router.get(clientRoot, async (req, res) => {
    const actor = await actorOf(req),
      id = invitationId(req);
    const grant = await access(id, actor);
    const photos = await photosOf(grant.collection);
    const latest = await access(id, actor);
    res.json(
      present(
        latest.invitation,
        photos.filter((photo) =>
          latest.collection.selectedIds?.includes(photo.id),
        ),
      ),
    );
  });
  router.patch(clientRoot, async (req, res) => {
    const actor = await actorOf(req),
      id = invitationId(req);
    const initial = await access(id, actor);
    const input = z
      .object({
        photoId: z.uuid(),
        status: z.enum(PROOFING_DECISIONS).nullable(),
        version: versionSchema.max(Number.MAX_SAFE_INTEGER - 1),
      })
      .strict()
      .safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_DECISION',
        'Choose a current photo, a valid decision and the latest version.',
      );
    const result = await withAccountLock(
      initial.invitation.ownerId,
      async () => {
        const grant = await access(id, actor);
        const saved = readProofingDecisions(grant.invitation);
        if (submissionState(grant.invitation).current)
          throw new ApiError(
            409,
            'PROOFING_SUBMITTED',
            'These choices are submitted. Ask your photographer to reopen this round.',
          );
        if (saved.version !== input.data.version)
          throw new ApiError(
            409,
            'DECISIONS_CHANGED',
            'These choices changed in another tab. Refresh saved decisions before trying again.',
          );
        const photos = await photosOf(grant.collection);
        const latest = await access(id, actor);
        const available = photos.filter(
          (photo) =>
            photoAvailable(photo) &&
            latest.collection.selectedIds?.includes(photo.id),
        );
        const ids = new Set(available.map((photo) => photo.id));
        const target = await store().get(input.data.photoId);
        if (
          !ids.has(target.id) ||
          target.ownerId !== latest.collection.ownerId ||
          target.eventId !== latest.event.id ||
          target.scanId ||
          target.deletionStartedAt ||
          !photoAvailable(target)
        )
          throw new ApiError(
            409,
            'DECISION_PHOTO_UNAVAILABLE',
            'This photo is no longer available in the collection. Refresh the collection.',
          );
        const entries = saved.entries.filter(
          (item) =>
            ids.has(item.photoId) && item.photoId !== input.data.photoId,
        );
        if (input.data.status !== null)
          entries.push({
            photoId: input.data.photoId,
            status: input.data.status,
          });
        const row: LibraryRecord = {
          ...latest.invitation,
          proofingDecisions: entries,
          proofingDecisionVersion: saved.version + 1,
          proofingDecisionUpdatedAt: new Date().toISOString(),
        };
        await store().put(row);
        return present(row, available);
      },
    );
    res.json(result);
  });
  router.get(
    '/events/:id/proofing-collections/:collectionId/invitations/:invitationId/decisions',
    async (req, res) => {
      const actor = await actorOf(req);
      const { collection } = await ownerCollection(req, actor);
      const row = await store()
        .get(invitationId(req))
        .catch((error) => {
          if (error instanceof ApiError && error.status === 404)
            throw missing();
          throw error;
        });
      if (
        row.kind !== 'job' ||
        row.purpose !== 'collection-invitation' ||
        row.ownerId !== actor ||
        row.eventId !== collection.eventId ||
        row.invitationCollectionId !== collection.id ||
        row.deletionStartedAt
      )
        throw missing();
      res.json(present(row, await photosOf(collection)));
    },
  );
  return router;
}
