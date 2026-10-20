import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import {
  blankInvitationPage,
  invitationPageCommand,
  storedInvitationPage,
  type StoredInvitationPage,
} from '../../../packages/shared/src/event-invitation-page.js';

export function invitationPageRecordId(eventId: string) {
  const hex = createHash('sha256')
    .update(`picfind:invitation-page:${eventId}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const missing = () =>
  new ApiError(
    404,
    'INVITATION_PAGE_UNAVAILABLE',
    'This invitation page is unavailable.',
  );
const changed = () =>
  new ApiError(
    409,
    'INVITATION_PAGE_CHANGED',
    'Invitation details changed. Reload before saving again.',
  );
function active(event: LibraryRecord) {
  return (
    !event.archived &&
    (!event.expiresAt || Date.parse(event.expiresAt) > Date.now())
  );
}
export function createEventInvitationPage(
  getStore: () => LibraryStore,
  actorOf: (req: Request) => Promise<string>,
) {
  const router = Router(),
    root = '/events/:id/invitation-page';
  function id(req: Request) {
    const parsed = z.uuid().safeParse(req.params.id);
    if (!parsed.success) throw missing();
    return parsed.data;
  }
  async function actor(req: Request) {
    const accountId = await actorOf(req),
      expected = req.get('X-PicFind-Invitation-Actor');
    if (expected && expected !== accountId)
      throw new ApiError(
        403,
        'INVITATION_ACCOUNT_CHANGED',
        'Your signed-in account changed. Reload the event.',
      );
    return accountId;
  }
  async function eventOf(eventId: string, accountId?: string) {
    const event = await getStore().get(eventId);
    if (
      event.id !== eventId ||
      event.kind !== 'event' ||
      event.deletionStartedAt ||
      event.deletionCompletedAt ||
      (accountId !== undefined && event.ownerId !== accountId)
    )
      throw missing();
    return event;
  }
  async function load(
    event: LibraryRecord,
  ): Promise<{ page: StoredInvitationPage | null; createdAt: string | null }> {
    const key = invitationPageRecordId(event.id);
    let row: LibraryRecord;
    try {
      row = await getStore().get(key);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404)
        return { page: null, createdAt: null };
      throw failure;
    }
    if (
      row.id !== key ||
      row.kind !== 'job' ||
      row.purpose !== 'event-invitation-page' ||
      row.ownerId !== event.ownerId ||
      row.eventId !== event.id ||
      row.deletionStartedAt ||
      row.deletionCompletedAt
    )
      throw missing();
    const parsed = storedInvitationPage.safeParse(row.invitationPage);
    if (
      !parsed.success ||
      !z.iso.datetime().safeParse(row.createdAt).success ||
      Date.parse(row.createdAt) > Date.parse(parsed.data.updatedAt)
    )
      throw new ApiError(
        503,
        'INVITATION_PAGE_INVALID',
        'Invitation metadata needs repair before it can be used.',
      );
    return { page: parsed.data, createdAt: row.createdAt };
  }
  async function snapshot(eventId: string, accountId: string) {
    const event = await eventOf(eventId, accountId),
      { page } = await load(event);
    const latest = await eventOf(eventId, accountId);
    return {
      accountId,
      eventId,
      editable: active(latest),
      page: page
        ? {
            draft: page.draft,
            published: page.published,
            version: page.version,
            updatedAt: page.updatedAt,
          }
        : {
            draft: blankInvitationPage(),
            published: null,
            version: 0,
            updatedAt: null,
          },
    };
  }
  router.get(root, async (req, res) => {
    const accountId = await actor(req);
    res.json(await snapshot(id(req), accountId));
  });
  router.put(root, async (req, res) => {
    const accountId = await actor(req),
      eventId = id(req);
    const input = invitationPageCommand.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_INVITATION_PAGE',
        'Use bounded invitation details, a valid date for publication and the current version.',
      );
    const digest = createHash('sha256')
      .update(JSON.stringify(input.data))
      .digest('hex');
    await withAccountLock(accountId, async () => {
      let event = await eventOf(eventId, accountId);
      const initial = await load(event),
        current = initial.page,
        version = current?.version ?? 0;
      const checkActive = () => {
        if (input.data.action !== 'withdraw' && !active(event))
          throw new ApiError(
            409,
            'INVITATION_EVENT_CLOSED',
            'Restore an active event before saving or publishing invitation details.',
          );
      };
      checkActive();
      if (
        version === input.data.version + 1 &&
        current?.commandDigest === digest
      )
        return;
      if (version !== input.data.version) throw changed();
      const updatedAt = new Date(
        Math.max(Date.now(), current ? Date.parse(current.updatedAt) : 0),
      ).toISOString();
      const next = storedInvitationPage.safeParse({
        draft:
          input.data.action === 'withdraw'
            ? (current?.draft ?? blankInvitationPage())
            : input.data.fields,
        published:
          input.data.action === 'publish'
            ? {
                fields: input.data.fields,
                revision: version + 1,
                publishedAt: updatedAt,
              }
            : input.data.action === 'withdraw'
              ? null
              : (current?.published ?? null),
        version: version + 1,
        updatedAt,
        commandDigest: digest,
      });
      if (!next.success)
        throw new ApiError(
          400,
          'INVITATION_PAGE_TOO_LARGE',
          'Shorten the draft or published invitation details before saving.',
        );
      event = await eventOf(eventId, accountId);
      if (JSON.stringify((await load(event)).page) !== JSON.stringify(current))
        throw changed();
      event = await eventOf(eventId, accountId);
      checkActive();
      await getStore().put(
        {
          id: invitationPageRecordId(eventId),
          ownerId: accountId,
          kind: 'job',
          purpose: 'event-invitation-page',
          eventId,
          createdAt: initial.createdAt ?? updatedAt,
          invitationPage: next.data,
        },
        version === 0,
      );
    });
    res.json(await snapshot(eventId, accountId));
  });
  router.get('/public/invitations/:id', async (req, res) => {
    const eventId = id(req),
      event = await eventOf(eventId);
    if (!active(event)) throw missing();
    const { page } = await load(event);
    if (!page?.published) throw missing();
    const fresh = await eventOf(eventId, event.ownerId);
    if (!active(fresh)) throw missing();
    const latest = await load(fresh);
    if (
      JSON.stringify(latest.page?.published) !== JSON.stringify(page.published)
    )
      throw missing();
    if (!active(await eventOf(eventId, event.ownerId))) throw missing();
    res.json({ eventId, ...page.published });
  });
  return router;
}
