import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { photoAvailable } from './retention.js';
import {
  PROOFING_COMMENT_LENGTH,
  PROOFING_COMMENT_LIMIT,
  type ProofingDiscussion,
} from '../../../packages/shared/src/proofing-comments.js';

type Grant = {
  invitation: LibraryRecord;
  event: LibraryRecord;
  collection: LibraryRecord;
};
const textSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROOFING_COMMENT_LENGTH)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127) || '\t\n\r'.includes(character);
    }),
  );
const missing = () =>
  new ApiError(
    404,
    'DISCUSSION_UNAVAILABLE',
    'This photo discussion is unavailable for this account.',
  );
function uuid(value: unknown) {
  const result = z.uuid().safeParse(value);
  if (!result.success) throw missing();
  return result.data;
}
function active(grant: Grant) {
  return (
    !grant.invitation.invitationRevokedAt &&
    Date.parse(grant.invitation.expiresAt ?? '') > Date.now() &&
    !grant.event.archived &&
    (!grant.event.expiresAt || Date.parse(grant.event.expiresAt) > Date.now())
  );
}
function available(photo: LibraryRecord, grant: Grant) {
  return (
    photo.kind === 'photo' &&
    photo.ownerId === grant.event.ownerId &&
    photo.eventId === grant.event.id &&
    !photo.scanId &&
    !photo.deletionStartedAt &&
    photoAvailable(photo) &&
    Boolean(grant.collection.selectedIds?.includes(photo.id))
  );
}
function belongs(row: LibraryRecord, grant: Grant) {
  return (
    row.kind === 'job' &&
    row.purpose === 'proofing-comment' &&
    row.ownerId === grant.event.ownerId &&
    row.eventId === grant.event.id &&
    row.commentInvitationId === grant.invitation.id &&
    !row.deletionStartedAt
  );
}

export function createProofingComments(dependencies: {
  store: () => LibraryStore;
  actorOf: (req: Request) => Promise<string>;
  access: (invitationId: string, actor: string) => Promise<Grant>;
  ownerCollection: (
    req: Request,
    actor: string,
  ) => Promise<{ event: LibraryRecord; collection: LibraryRecord }>;
}) {
  const { store, actorOf, access, ownerCollection } = dependencies;
  const router = Router();
  async function authorize(
    req: Request,
    actor: string,
    owner: boolean,
  ): Promise<Grant> {
    const id = uuid(req.params.invitationId);
    if (!owner) return access(id, actor);
    const { event, collection } = await ownerCollection(req, actor);
    const invitation = await store().get(id);
    if (
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
  async function optional(id: string) {
    try {
      return await store().get(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return undefined;
      throw error;
    }
  }
  async function rows(grant: Grant) {
    return (await store().list(grant.event.ownerId, 'job')).filter((row) =>
      belongs(row, grant),
    );
  }
  async function presentation(
    req: Request,
    actor: string,
    owner: boolean,
  ): Promise<ProofingDiscussion> {
    const initial = await authorize(req, actor, owner);
    const saved = await rows(initial);
    const photos = await store().list(initial.event.ownerId, 'photo');
    const grant = await authorize(req, actor, owner);
    const current = photos.filter((photo) => available(photo, grant));
    const ids = new Set(current.map((photo) => photo.id));
    const visible = saved.filter((row) => ids.has(row.commentPhotoId ?? ''));
    return {
      canPost: active(grant) && saved.length < PROOFING_COMMENT_LIMIT,
      remaining: Math.max(0, PROOFING_COMMENT_LIMIT - saved.length),
      unavailableCount: saved.length - visible.length,
      photos: current.map((photo) => ({
        id: photo.id,
        filename: photo.filename ?? 'photo.jpg',
      })),
      comments: visible
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        )
        .map((row) => {
          if (
            !row.commentAuthorId ||
            !['client', 'photographer'].includes(row.commentAuthorRole ?? '') ||
            !Number.isFinite(Date.parse(row.createdAt)) ||
            (row.commentRemovedAt
              ? !Number.isFinite(Date.parse(row.commentRemovedAt))
              : !textSchema.safeParse(row.commentText).success)
          ) {
            throw new ApiError(
              503,
              'DISCUSSION_METADATA_INVALID',
              'This discussion needs metadata repair.',
            );
          }
          return {
            id: row.id,
            photoId: row.commentPhotoId!,
            author: row.commentAuthorRole!,
            text: row.commentRemovedAt ? null : row.commentText!,
            createdAt: row.createdAt,
            removedAt: row.commentRemovedAt ?? null,
            canRemove:
              !row.commentRemovedAt && (owner || row.commentAuthorId === actor),
          };
        }),
    };
  }
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  for (const [root, owner] of [
    ['/proofing-invitations/:invitationId/comments', false],
    [
      '/events/:id/proofing-collections/:collectionId/invitations/:invitationId/comments',
      true,
    ],
  ] as const) {
    router.get(root, async (req, res) => {
      const actor = await actorOf(req);
      res.json(await presentation(req, actor, owner));
    });
    router.post(root, limiter, async (req, res) => {
      const actor = await actorOf(req);
      const initial = await authorize(req, actor, owner);
      const input = z
        .object({ id: z.uuid(), photoId: z.uuid(), text: textSchema })
        .strict()
        .safeParse(req.body);
      if (!input.success)
        throw new ApiError(
          400,
          'INVALID_COMMENT',
          'Choose a photo and enter 1 to 1,000 plain-text characters.',
        );
      const commentId = await withAccountLock(
        initial.event.ownerId,
        async () => {
          const grant = await authorize(req, actor, owner);
          if (!active(grant))
            throw new ApiError(
              409,
              'DISCUSSION_CLOSED',
              'This invitation is closed for new messages.',
            );
          if (!available(await store().get(input.data.photoId), grant))
            throw missing();
          const existing = await optional(input.data.id);
          if (existing) {
            if (
              !belongs(existing, grant) ||
              existing.commentPhotoId !== input.data.photoId ||
              existing.commentAuthorId !== actor ||
              existing.commentRemovedAt ||
              existing.commentText !== input.data.text
            ) {
              throw new ApiError(
                409,
                'COMMENT_ID_CONFLICT',
                'This message identifier has already been used. Refresh before sending a new message.',
              );
            }
            return existing.id;
          }
          if ((await rows(grant)).length >= PROOFING_COMMENT_LIMIT)
            throw new ApiError(
              409,
              'COMMENT_LIMIT',
              'This invitation has reached its 100-message limit.',
            );
          const latest = await authorize(req, actor, owner);
          if (
            !active(latest) ||
            !available(await store().get(input.data.photoId), latest)
          )
            throw missing();
          const row: LibraryRecord = {
            id: input.data.id,
            kind: 'job',
            purpose: 'proofing-comment',
            ownerId: latest.event.ownerId,
            eventId: latest.event.id,
            commentInvitationId: latest.invitation.id,
            commentPhotoId: input.data.photoId,
            commentAuthorId: actor,
            commentAuthorRole: owner ? 'photographer' : 'client',
            commentText: input.data.text,
            createdAt: new Date().toISOString(),
          };
          await store().put(row, true);
          return row.id;
        },
      );
      res.status(201).json({ id: commentId });
    });
    router.delete(`${root}/:commentId`, async (req, res) => {
      const actor = await actorOf(req);
      const initial = await authorize(req, actor, owner);
      await withAccountLock(initial.event.ownerId, async () => {
        const grant = await authorize(req, actor, owner);
        const row = await store().get(uuid(req.params.commentId));
        if (
          !belongs(row, grant) ||
          (!owner && row.commentAuthorId !== actor) ||
          !available(await store().get(row.commentPhotoId ?? ''), grant)
        )
          throw missing();
        if (!row.commentRemovedAt) {
          const updated = {
            ...row,
            commentRemovedAt: new Date().toISOString(),
          };
          delete updated.commentText;
          await store().put(updated);
        }
      });
      res.status(204).end();
    });
  }
  return router;
}
