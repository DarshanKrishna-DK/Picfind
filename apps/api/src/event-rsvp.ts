import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ApiError, readSession } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { invitationPageAccess } from './event-invitation-page.js';
import { withAccountLock } from './locks.js';
import {
  RSVP_LIMIT,
  emptyRsvpSettings,
  publicRsvp,
  rsvpRemoval,
  rsvpSettingsWrite,
  rsvpWrite,
  storedRsvp,
  storedRsvpSettings,
  type StoredRsvpSettings,
} from '../../../packages/shared/src/event-rsvp.js';

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function uuid(value: string) {
  const hex = hash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export const rsvpSettingsId = (eventId: string) =>
  uuid(`picfind:rsvp-settings:${eventId}`);
export const rsvpResponseId = (eventId: string, receiptHash: string) =>
  uuid(`picfind:rsvp:${eventId}:${receiptHash}`);
export const rsvpCookieName = (eventId: string, secure: boolean) =>
  `${secure ? '__Host-' : ''}picfind_rsvp_${eventId}`;
const unavailable = () =>
  new ApiError(404, 'RSVP_UNAVAILABLE', 'This response is unavailable.');
const changed = () =>
  new ApiError(
    409,
    'RSVP_CHANGED',
    'Response details changed. Reload before submitting again.',
  );
const invalid = () =>
  new ApiError(
    503,
    'RSVP_INVALID',
    'Response metadata needs repair before it can be used.',
  );
function active(event: LibraryRecord) {
  return (
    !event.archived &&
    (!event.expiresAt || Date.parse(event.expiresAt) > Date.now())
  );
}
export function createEventRsvp(
  getStore: () => LibraryStore,
  actorOf: (req: Request) => Promise<string>,
  secureCookies: boolean,
) {
  const router = Router(),
    access = invitationPageAccess(getStore),
    root = '/events/:id/rsvp',
    guest = '/public/invitations/:id/rsvp';
  const cookie = {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 30 * 86_400_000,
  };
  const mutationLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  function id(req: Request) {
    const value = z.uuid().safeParse(req.params.id);
    if (!value.success) throw unavailable();
    return value.data;
  }
  async function actor(req: Request) {
    const value = await actorOf(req),
      expected = req.get('X-PicFind-Rsvp-Actor');
    if (expected && expected !== value)
      throw new ApiError(
        403,
        'RSVP_ACCOUNT_CHANGED',
        'Your signed-in account changed. Reload the event.',
      );
    return value;
  }
  function receipt(req: Request, eventId: string) {
    const secret = readSession(req, rsvpCookieName(eventId, secureCookies));
    if (!secret) return null;
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret))
      throw new ApiError(
        400,
        'RSVP_RECEIPT_INVALID',
        'This browser response receipt is invalid.',
      );
    const digest = hash(secret);
    return { secret, digest, id: rsvpResponseId(eventId, digest) };
  }
  function scoped(
    row: LibraryRecord,
    event: LibraryRecord,
    purpose: LibraryRecord['purpose'],
  ) {
    return (
      row.kind === 'job' &&
      row.ownerId === event.ownerId &&
      row.eventId === event.id &&
      row.purpose === purpose &&
      !row.deletionStartedAt &&
      !row.deletionCompletedAt
    );
  }
  async function get(key: string) {
    try {
      return await getStore().get(key);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) return null;
      throw failure;
    }
  }
  async function settings(event: LibraryRecord) {
    const row = await get(rsvpSettingsId(event.id));
    if (!row)
      return {
        value: emptyRsvpSettings(),
        stored: null as StoredRsvpSettings | null,
        createdAt: null as string | null,
      };
    if (
      row.id !== rsvpSettingsId(event.id) ||
      !scoped(row, event, 'event-rsvp-settings')
    )
      throw unavailable();
    const parsed = storedRsvpSettings.safeParse(row.rsvpSettings);
    if (
      !parsed.success ||
      !z.iso.datetime().safeParse(row.createdAt).success ||
      Date.parse(row.createdAt) > Date.parse(parsed.data.updatedAt)
    )
      throw invalid();
    const { enabled, closesAt, maxPartySize, version, updatedAt } = parsed.data;
    return {
      value: { enabled, closesAt, maxPartySize, version, updatedAt },
      stored: parsed.data,
      createdAt: row.createdAt,
    };
  }
  function response(row: LibraryRecord, event: LibraryRecord) {
    if (!scoped(row, event, 'event-rsvp-response')) throw unavailable();
    const parsed = storedRsvp.safeParse(row.rsvpResponse);
    if (
      !parsed.success ||
      row.id !== parsed.data.id ||
      row.id !== rsvpResponseId(event.id, parsed.data.receiptHash) ||
      row.createdAt !== parsed.data.createdAt
    )
      throw invalid();
    return parsed.data;
  }
  async function ownedResponse(event: LibraryRecord, key: string) {
    const row = await get(key);
    if (!row) return null;
    if (row.id !== key) throw unavailable();
    return response(row, event);
  }
  async function publication(event: LibraryRecord) {
    try {
      return (await access.published(event.id, event.ownerId)).publication;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) return null;
      throw failure;
    }
  }
  function accepting(
    policy: { enabled: boolean; closesAt: string | null; maxPartySize: number },
    published: unknown,
    event: LibraryRecord,
  ) {
    return (
      !!published &&
      active(event) &&
      policy.enabled &&
      (!policy.closesAt || Date.parse(policy.closesAt) > Date.now())
    );
  }
  async function all(event: LibraryRecord) {
    const rows = (await getStore().list(event.ownerId, 'job')).filter(
      (row) =>
        row.eventId === event.id && row.purpose === 'event-rsvp-response',
    );
    if (rows.length > RSVP_LIMIT)
      throw new ApiError(
        503,
        'RSVP_CAPACITY_INVALID',
        'Response storage exceeds its supported limit.',
      );
    const values = rows.map((row) => response(row, event));
    if (new Set(values.map((value) => value.id)).size !== values.length)
      throw invalid();
    return values.sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
  }
  async function hostSnapshot(eventId: string, accountId: string) {
    const event = await access.eventOf(eventId, accountId),
      policy = await settings(event),
      responses = await all(event),
      published = await publication(event);
    const fresh = await access.eventOf(eventId, accountId);
    return {
      accountId,
      eventId,
      editable: active(fresh),
      accepting: accepting(policy.value, published, fresh),
      settings: policy.value,
      responses: responses.map(publicRsvp),
      limit: RSVP_LIMIT,
    };
  }
  async function guestSnapshot(req: Request, eventId: string) {
    const event = await access.eventOf(eventId),
      token = receipt(req, eventId),
      policy = await settings(event);
    const saved = token ? await ownedResponse(event, token.id) : null;
    if (saved && saved.receiptHash !== token!.digest) throw unavailable();
    const published = await publication(event);
    if (!saved && !published) throw unavailable();
    const fresh = await access.eventOf(eventId, event.ownerId);
    return {
      eventId,
      receiptId: token?.id ?? null,
      invitationRevision: published?.revision ?? 0,
      accepting: accepting(policy.value, published, fresh),
      policy: {
        enabled: policy.value.enabled,
        closesAt: policy.value.closesAt,
        maxPartySize: policy.value.maxPartySize,
      },
      response: saved ? publicRsvp(saved) : null,
    };
  }
  router.get(root, async (req, res) => {
    const accountId = await actor(req);
    res.json(await hostSnapshot(id(req), accountId));
  });
  router.put(root, async (req, res) => {
    const accountId = await actor(req),
      eventId = id(req),
      input = rsvpSettingsWrite.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_RSVP_SETTINGS',
        'Use a valid closing instant, party size from one to ten and the current version.',
      );
    const digest = hash(JSON.stringify(input.data));
    await withAccountLock(accountId, async () => {
      let event = await access.eventOf(eventId, accountId);
      const current = await settings(event);
      if (input.data.enabled && !active(event))
        throw new ApiError(
          409,
          'RSVP_EVENT_CLOSED',
          'Restore an active event before opening responses.',
        );
      if (
        current.value.version === input.data.version + 1 &&
        current.stored?.commandDigest === digest
      )
        return;
      if (current.value.version !== input.data.version) throw changed();
      const next = storedRsvpSettings.parse({
        ...input.data,
        version: current.value.version + 1,
        updatedAt: new Date(
          Math.max(
            Date.now(),
            current.value.updatedAt ? Date.parse(current.value.updatedAt) : 0,
          ),
        ).toISOString(),
        commandDigest: digest,
      });
      event = await access.eventOf(eventId, accountId);
      if (
        JSON.stringify((await settings(event)).stored) !==
        JSON.stringify(current.stored)
      )
        throw changed();
      event = await access.eventOf(eventId, accountId);
      if (next.enabled && !active(event))
        throw new ApiError(
          409,
          'RSVP_EVENT_CLOSED',
          'Restore an active event before opening responses.',
        );
      await getStore().put(
        {
          id: rsvpSettingsId(eventId),
          ownerId: accountId,
          kind: 'job',
          purpose: 'event-rsvp-settings',
          eventId,
          createdAt: current.createdAt ?? next.updatedAt,
          rsvpSettings: next,
        },
        current.value.version === 0,
      );
    });
    res.json(await hostSnapshot(eventId, accountId));
  });
  router.get(guest, async (req, res) => {
    res.json(await guestSnapshot(req, id(req)));
  });
  router.post(`${guest}/session`, mutationLimit, async (req, res) => {
    const eventId = id(req),
      published = await access.published(eventId),
      policy = await settings(published.event);
    if (!accepting(policy.value, published.publication, published.event))
      throw new ApiError(
        409,
        'RSVP_CLOSED',
        'This event is not accepting responses.',
      );
    const token = receipt(req, eventId),
      secret = token?.secret ?? randomBytes(32).toString('base64url');
    const name = rsvpCookieName(eventId, secureCookies);
    res.cookie(name, secret, cookie);
    // Use the same receipt for the returned projection without exposing its secret.
    req.headers.cookie = (req.headers.cookie ?? '')
      .split(';')
      .filter((part) => !part.trim().startsWith(`${name}=`))
      .concat(`${name}=${secret}`)
      .join(';');
    res.json(await guestSnapshot(req, eventId));
  });
  router.put(guest, mutationLimit, async (req, res) => {
    const eventId = id(req),
      token = receipt(req, eventId),
      input = rsvpWrite.safeParse(req.body);
    if (!token)
      throw new ApiError(
        401,
        'RSVP_RECEIPT_REQUIRED',
        'Start your response on this browser first.',
      );
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_RSVP',
        'Provide a name, valid response and party size, short message and the host-sharing acknowledgment.',
      );
    if (input.data.receiptId !== token.id)
      throw new ApiError(
        403,
        'RSVP_RECEIPT_CHANGED',
        'Your browser response receipt changed. Reload your response.',
      );
    const first = await access.eventOf(eventId),
      digest = hash(JSON.stringify(input.data));
    await withAccountLock(first.ownerId, async () => {
      let event = await access.eventOf(eventId, first.ownerId);
      const current = await ownedResponse(event, token.id),
        policy = await settings(event);
      if (current && current.receiptHash !== token.digest) throw unavailable();
      const check = async () => {
        const published = await access.published(eventId, first.ownerId),
          latest = await settings(published.event);
        if (!accepting(latest.value, published.publication, published.event))
          throw new ApiError(
            409,
            'RSVP_CLOSED',
            'This event is not accepting responses.',
          );
        if (published.publication.revision !== input.data.invitationRevision)
          throw new ApiError(
            409,
            'RSVP_INVITATION_CHANGED',
            'The invitation changed. Reload its details before submitting.',
          );
        if (input.data.partySize > latest.value.maxPartySize)
          throw new ApiError(
            400,
            'RSVP_PARTY_LIMIT',
            'Your reported party exceeds the current event limit.',
          );
        if (JSON.stringify(latest.stored) !== JSON.stringify(policy.stored))
          throw changed();
      };
      await check();
      if (
        current?.version === input.data.version + 1 &&
        current.commandDigest === digest
      )
        return;
      if ((current?.version ?? 0) !== input.data.version) throw changed();
      if (!current && (await all(event)).length >= RSVP_LIMIT)
        throw new ApiError(
          409,
          'RSVP_FULL',
          'This event has reached its response limit.',
        );
      const updatedAt = new Date(
        Math.max(Date.now(), current ? Date.parse(current.updatedAt) : 0),
      ).toISOString();
      const next = storedRsvp.parse({
        id: token.id,
        displayName: input.data.displayName,
        response: input.data.response,
        partySize: input.data.partySize,
        message: input.data.message,
        version: (current?.version ?? 0) + 1,
        invitationRevision: input.data.invitationRevision,
        createdAt: current?.createdAt ?? updatedAt,
        updatedAt,
        receiptHash: token.digest,
        consent: input.data.consent,
        commandDigest: digest,
      });
      event = await access.eventOf(eventId, first.ownerId);
      if (
        JSON.stringify(await ownedResponse(event, token.id)) !==
        JSON.stringify(current)
      )
        throw changed();
      await check();
      await getStore().put(
        {
          id: token.id,
          ownerId: first.ownerId,
          kind: 'job',
          purpose: 'event-rsvp-response',
          eventId,
          createdAt: next.createdAt,
          rsvpResponse: next,
        },
        !current,
      );
    });
    res.json(await guestSnapshot(req, eventId));
  });
  async function remove(
    eventId: string,
    ownerId: string,
    key: string,
    version: number,
    receiptHash?: string,
  ) {
    await withAccountLock(ownerId, async () => {
      let event = await access.eventOf(eventId, ownerId);
      const current = await ownedResponse(event, key);
      if (!current) return;
      if (receiptHash && current.receiptHash !== receiptHash)
        throw unavailable();
      if (current.version !== version) throw changed();
      event = await access.eventOf(eventId, ownerId);
      if (
        JSON.stringify(await ownedResponse(event, key)) !==
        JSON.stringify(current)
      )
        throw changed();
      await access.eventOf(eventId, ownerId);
      await getStore().remove(key);
    });
  }
  function clear(res: Response, eventId: string) {
    res.clearCookie(rsvpCookieName(eventId, secureCookies), {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'lax',
      path: '/',
    });
  }
  router.delete(guest, mutationLimit, async (req, res) => {
    const eventId = id(req),
      token = receipt(req, eventId);
    if (!token) {
      clear(res, eventId);
      res.status(204).end();
      return;
    }
    const input = rsvpRemoval.safeParse(req.body);
    if (!input.success)
      throw new ApiError(
        400,
        'INVALID_RSVP_REMOVAL',
        'Reload your saved response before withdrawing.',
      );
    if (input.data.receiptId !== token.id)
      throw new ApiError(
        403,
        'RSVP_RECEIPT_CHANGED',
        'Your browser response receipt changed. Reload your response.',
      );
    const event = await get(eventId);
    if (event) {
      await access.eventOf(eventId, event.ownerId);
      await remove(
        eventId,
        event.ownerId,
        token.id,
        input.data.version,
        token.digest,
      );
    }
    clear(res, eventId);
    res.status(204).end();
  });
  router.delete(`${root}/:responseId`, async (req, res) => {
    const accountId = await actor(req),
      eventId = id(req),
      key = z.uuid().safeParse(req.params.responseId);
    const input = z
      .object({
        version: z
          .number()
          .int()
          .min(1)
          .max(Number.MAX_SAFE_INTEGER - 1),
      })
      .strict()
      .safeParse(req.body);
    if (!key.success || !input.success)
      throw new ApiError(
        400,
        'INVALID_RSVP_REMOVAL',
        'Choose a saved response and its current version.',
      );
    await access.eventOf(eventId, accountId);
    await remove(eventId, accountId, key.data, input.data.version);
    res.status(204).end();
  });
  return router;
}
