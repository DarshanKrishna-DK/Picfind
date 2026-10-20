import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ApiError, type AuthOptions } from './auth.js';
import type { BillingService } from './billing/service.js';
import type { LibraryStore } from './library.js';
import { requireEventAccess } from './event-membership-access.js';
import { photoAvailable } from './retention.js';
import { publishedAttribution } from '../../../packages/shared/src/photo-attribution.js';

export function createEventMembershipRouter(
  auth: AuthOptions,
  store: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
  billing: BillingService | undefined,
  limits: { libraryPhotos: number; eventPhotos: number },
) {
  const router = Router();
  const id = (req: Request) => {
    const result = z.uuid().safeParse(req.params.id);
    if (!result.success)
      throw new ApiError(404, 'NOT_FOUND', 'This event is not available.');
    return result.data;
  };
  const service = () => {
    if (!billing)
      throw new ApiError(
        503,
        'MEMBERSHIPS_UNAVAILABLE',
        'Event collaboration is not configured.',
      );
    return billing;
  };
  async function creator(req: Request) {
    const user = await owner(req),
      eventId = id(req);
    const access = await requireEventAccess(store(), eventId, user);
    if (access.role !== 'owner')
      throw new ApiError(404, 'NOT_FOUND', 'This event is not available.');
    return { user, eventId };
  }
  router.get('/events/:id/members', async (req, res) => {
    const { user, eventId } = await creator(req);
    res.json({ members: await service().eventMembers(user, eventId) });
  });
  router.post(
    '/events/:id/members',
    rateLimit({
      windowMs: 60_000,
      limit: 15,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    async (req, res) => {
      const { user, eventId } = await creator(req);
      const input = z
        .object({ email: z.email().max(254), role: z.literal('moderator') })
        .strict()
        .safeParse(req.body);
      if (!input.success)
        throw new ApiError(
          400,
          'INVALID_INPUT',
          'Enter a valid email and moderator role.',
        );
      const accounting = service();
      if (!auth.provider?.resolveEventMember)
        throw new ApiError(
          503,
          'MEMBERSHIPS_UNAVAILABLE',
          'Account lookup is not configured.',
        );
      const target = await auth.provider.resolveEventMember(input.data.email);
      if (!target)
        throw new ApiError(
          400,
          'MEMBER_UNAVAILABLE',
          'Ask this person to sign in and verify their PicFind email first.',
        );
      res.status(201).json({
        member: await accounting.inviteEventMember(user, eventId, target),
      });
    },
  );
  router.delete('/events/:id/members/:userId', async (req, res) => {
    const { user, eventId } = await creator(req);
    const target = z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/)
      .safeParse(req.params.userId);
    if (!target.success)
      throw new ApiError(404, 'NOT_FOUND', 'This member is not available.');
    await service().revokeEventMember(user, eventId, target.data);
    res.status(204).end();
  });
  router.get('/events/:id/gallery', async (req, res) => {
    const access = await requireEventAccess(
      store(),
      id(req),
      await owner(req),
      true,
    );
    const all = await store().list(access.event.ownerId, 'photo');
    const photos = all.filter(
      (photo) =>
        photo.ownerId === access.event.ownerId &&
        photo.eventId === access.event.id &&
        !photo.scanId &&
        !photo.deletionStartedAt &&
        photoAvailable(photo),
    );
    const { members, passcodeHash, folder, ...event } = access.event;
    void members;
    void passcodeHash;
    void folder;
    res.json({
      event: { ...event, accessRole: access.role },
      photos: photos.map(
        ({
          id,
          eventId,
          filename,
          width,
          height,
          bytes,
          createdAt,
          expiresAt,
          attribution,
        }) => {
          const credit = publishedAttribution(attribution);
          return {
            id,
            eventId,
            filename,
            width,
            height,
            bytes: bytes ?? 0,
            createdAt,
            ...(expiresAt ? { expiresAt } : {}),
            ...(credit ? { credit } : {}),
          };
        },
      ),
      remainingUploads: Math.max(
        0,
        Math.min(
          limits.libraryPhotos - all.length,
          limits.eventPhotos - photos.length,
        ),
      ),
    });
  });
  return router;
}
