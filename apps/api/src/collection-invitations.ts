import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ApiError, type AuthOptions } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import { photoAvailable } from './retention.js';
import { createProofingDecisions } from './proofing-decisions.js';
import { createProofingComments } from './proofing-comments.js';
import { createProofingSubmissions } from './proofing-submissions.js';
import {
  COLLECTION_INVITATION_LIMIT,
  type CollectionInvitation,
  type InvitedCollection,
} from '../../../packages/shared/src/collection-invitation.js';

const missing = () =>
  new ApiError(
    404,
    'INVITATION_UNAVAILABLE',
    'This collection invitation is unavailable for this account.',
  );
function id(value: unknown) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw missing();
  return parsed.data;
}
function liveEvent(event: LibraryRecord) {
  return (
    event.kind === 'event' &&
    !event.archived &&
    !event.deletionStartedAt &&
    (!event.expiresAt || Date.parse(event.expiresAt) > Date.now())
  );
}
function availablePhoto(photo: LibraryRecord, collection: LibraryRecord) {
  return (
    photo.ownerId === collection.ownerId &&
    photo.eventId === collection.eventId &&
    !photo.scanId &&
    !photo.deletionStartedAt &&
    photoAvailable(photo) &&
    Boolean(collection.selectedIds?.includes(photo.id))
  );
}
function present(row: LibraryRecord): CollectionInvitation {
  return {
    id: row.id,
    email: row.invitationEmail ?? '',
    createdAt: row.createdAt,
    expiresAt: row.expiresAt ?? '',
    revokedAt: row.invitationRevokedAt ?? null,
  };
}

export function createCollectionInvitations(
  auth: AuthOptions,
  store: () => LibraryStore,
  actorOf: (req: Request) => Promise<string>,
  sendPhoto: (
    photo: LibraryRecord,
    req: Request,
    res: Response,
    authorize: () => Promise<void>,
  ) => Promise<void>,
) {
  const router = Router();
  const root = '/events/:id/proofing-collections/:collectionId/invitations';
  async function ownerCollection(
    req: Request,
    actor: string,
    requireLive = false,
  ) {
    const event = await store().get(id(req.params.id));
    const collection = await store().get(id(req.params.collectionId));
    if (
      event.kind !== 'event' ||
      event.ownerId !== actor ||
      event.deletionStartedAt ||
      (requireLive && !liveEvent(event)) ||
      collection.kind !== 'job' ||
      collection.purpose !== 'proofing-collection' ||
      collection.ownerId !== actor ||
      collection.eventId !== event.id ||
      collection.deletionStartedAt
    )
      throw missing();
    return { event, collection };
  }
  async function access(invitationId: string, actor: string) {
    const invitation = await store().get(invitationId);
    if (
      invitation.kind !== 'job' ||
      invitation.purpose !== 'collection-invitation' ||
      invitation.invitationRecipientId !== actor ||
      invitation.invitationRevokedAt ||
      invitation.deletionStartedAt ||
      !(Date.parse(invitation.expiresAt ?? '') > Date.now()) ||
      !invitation.eventId ||
      !invitation.invitationCollectionId
    )
      throw missing();
    const event = await store().get(invitation.eventId);
    const collection = await store().get(invitation.invitationCollectionId);
    if (
      !liveEvent(event) ||
      event.ownerId !== invitation.ownerId ||
      collection.kind !== 'job' ||
      collection.purpose !== 'proofing-collection' ||
      collection.ownerId !== invitation.ownerId ||
      collection.eventId !== event.id ||
      collection.deletionStartedAt
    )
      throw missing();
    return { invitation, event, collection };
  }
  router.get(root, async (req, res) => {
    const actor = await actorOf(req);
    const { collection } = await ownerCollection(req, actor);
    const rows = (await store().list(actor, 'job')).filter(
      (row) =>
        row.ownerId === actor &&
        row.purpose === 'collection-invitation' &&
        row.eventId === collection.eventId &&
        row.invitationCollectionId === collection.id,
    );
    res.json({
      invitations: rows
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(present),
    });
  });
  router.post(
    root,
    rateLimit({
      windowMs: 60_000,
      limit: 15,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    async (req, res) => {
      const actor = await actorOf(req);
      await ownerCollection(req, actor, true);
      const input = z
        .object({
          email: z.email().max(254),
          days: z.number().int().min(1).max(30),
        })
        .strict()
        .safeParse(req.body);
      if (!input.success)
        throw new ApiError(
          400,
          'INVALID_INVITATION',
          'Enter a verified account email and an expiry between 1 and 30 days.',
        );
      if (!auth.provider?.resolveEventMember)
        throw new ApiError(
          503,
          'INVITATIONS_UNAVAILABLE',
          'Account lookup is not configured.',
        );
      const recipient = await auth.provider.resolveEventMember(
        input.data.email,
      );
      if (!recipient?.emailVerified || !recipient.id || recipient.id === actor)
        throw new ApiError(
          400,
          'RECIPIENT_UNAVAILABLE',
          'Ask your client to create and verify their PicFind account first. Choose an account other than your own.',
        );
      const invitation = await withAccountLock(actor, async () => {
        const { event, collection } = await ownerCollection(req, actor, true);
        const rows = (await store().list(actor, 'job')).filter(
          (row) =>
            row.ownerId === actor &&
            row.eventId === event.id &&
            row.purpose === 'collection-invitation',
        );
        if (rows.length >= COLLECTION_INVITATION_LIMIT)
          throw new ApiError(
            409,
            'INVITATION_LIMIT',
            'This event has reached its 100-invitation limit.',
          );
        const duplicate = rows.find(
          (row) =>
            row.invitationCollectionId === collection.id &&
            row.invitationRecipientId === recipient.id &&
            !row.invitationRevokedAt &&
            Date.parse(row.expiresAt ?? '') > Date.now(),
        );
        if (duplicate)
          throw new ApiError(
            409,
            'INVITATION_EXISTS',
            'This client already has an active invitation. Copy its link or revoke it first.',
          );
        const now = Date.now();
        const row: LibraryRecord = {
          id: randomUUID(),
          kind: 'job',
          purpose: 'collection-invitation',
          ownerId: actor,
          eventId: event.id,
          invitationCollectionId: collection.id,
          invitationRecipientId: recipient.id,
          invitationEmail: recipient.email,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(
            Math.min(
              now + input.data.days * 86_400_000,
              event.expiresAt ? Date.parse(event.expiresAt) : Infinity,
            ),
          ).toISOString(),
        };
        await store().put(row, true);
        return present(row);
      });
      res.status(201).json({ invitation });
    },
  );
  router.delete(`${root}/:invitationId`, async (req, res) => {
    const actor = await actorOf(req);
    await withAccountLock(actor, async () => {
      const { collection } = await ownerCollection(req, actor);
      const row = await store().get(id(req.params.invitationId));
      if (
        row.kind !== 'job' ||
        row.purpose !== 'collection-invitation' ||
        row.ownerId !== actor ||
        row.eventId !== collection.eventId ||
        row.invitationCollectionId !== collection.id
      )
        throw missing();
      if (!row.invitationRevokedAt)
        await store().put({
          ...row,
          invitationRevokedAt: new Date().toISOString(),
        });
    });
    res.status(204).end();
  });
  router.get('/proofing-invitations/:invitationId', async (req, res) => {
    const actor = await actorOf(req),
      invitationId = id(req.params.invitationId);
    const { collection } = await access(invitationId, actor);
    const photos = await store().list(collection.ownerId, 'photo');
    const latest = await access(invitationId, actor);
    const byId = new Map(
      photos
        .filter((photo) => availablePhoto(photo, latest.collection))
        .map((photo) => [photo.id, photo]),
    );
    const result: InvitedCollection = {
      title: latest.collection.title ?? '',
      eventTitle: latest.event.title ?? '',
      expiresAt: latest.invitation.expiresAt!,
      photos: [...new Set(latest.collection.selectedIds ?? [])].flatMap(
        (photoId) => {
          const photo = byId.get(photoId);
          return photo
            ? [
                {
                  id: photo.id,
                  filename: photo.filename ?? 'photo.jpg',
                  ...(photo.width !== undefined ? { width: photo.width } : {}),
                  ...(photo.height !== undefined
                    ? { height: photo.height }
                    : {}),
                },
              ]
            : [];
        },
      ),
    };
    res.json(result);
  });
  router.get(
    '/proofing-invitations/:invitationId/photos/:photoId',
    async (req, res) => {
      const actor = await actorOf(req),
        invitationId = id(req.params.invitationId),
        photoId = id(req.params.photoId);
      async function authorizedPhoto() {
        const { collection } = await access(invitationId, actor);
        const photo = await store().get(photoId);
        if (!availablePhoto(photo, collection)) throw missing();
        return photo;
      }
      const photo = await authorizedPhoto();
      await sendPhoto(photo, req, res, async () => {
        await authorizedPhoto();
      });
    },
  );
  router.use(
    createProofingDecisions({ store, actorOf, access, ownerCollection }),
  );
  router.use(
    createProofingComments({ store, actorOf, access, ownerCollection }),
  );
  router.use(
    createProofingSubmissions({ store, actorOf, access, ownerCollection }),
  );
  return router;
}
