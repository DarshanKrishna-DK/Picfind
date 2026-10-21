import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { withAccountLock } from './locks.js';
import {
  SPONSOR_ACTOR,
  SPONSOR_PERMISSION,
  blankSponsors,
  sponsorCommand,
  sponsorState,
  storedSponsors,
  type StoredSponsors,
} from '../../../packages/shared/src/event-sponsors.js';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const missing = () =>
  new ApiError(
    404,
    'SPONSORS_UNAVAILABLE',
    'These event sponsor settings are not available.',
  );
export function sponsorRecordId(eventId: string) {
  const hex = digest(['picfind:event-sponsors:v1', eventId]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function eventOpen(event: LibraryRecord) {
  return (
    !event.archived &&
    !event.deletionStartedAt &&
    !event.deletionCompletedAt &&
    (!event.expiresAt || Date.parse(event.expiresAt) > Date.now())
  );
}
async function load(
  store: LibraryStore,
  event: LibraryRecord,
): Promise<{
  row: LibraryRecord | null;
  state: StoredSponsors | null;
}> {
  const key = sponsorRecordId(event.id);
  let row: LibraryRecord;
  try {
    row = await store.get(key);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404)
      return { row: null, state: null };
    throw error;
  }
  if (
    row.id !== key ||
    row.kind !== 'job' ||
    row.purpose !== 'event-sponsors' ||
    row.ownerId !== event.ownerId ||
    row.eventId !== event.id ||
    row.scanId ||
    row.deletionStartedAt ||
    row.deletionCompletedAt
  )
    throw missing();
  const result = storedSponsors.safeParse(row.eventSponsors);
  if (!result.success)
    throw new ApiError(
      503,
      'SPONSORS_INVALID',
      'Sponsor settings need metadata repair.',
    );
  return { row, state: result.data };
}
export async function publishedSponsors(
  store: LibraryStore,
  event: LibraryRecord,
) {
  if (!eventOpen(event)) return null;
  const { state } = await load(store, event);
  return state?.published?.fields ?? null;
}
export function createEventSponsors(
  store: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router(),
    root = '/events/:id/sponsors';
  async function eventOf(value: unknown, actor: string) {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw missing();
    const event = await store().get(parsed.data);
    if (
      event.id !== parsed.data ||
      event.ownerId !== actor ||
      event.kind !== 'event' ||
      event.deletionStartedAt ||
      event.deletionCompletedAt
    )
      throw missing();
    return event;
  }
  function response(event: LibraryRecord, state: StoredSponsors | null) {
    return sponsorState.parse({
      accountId: event.ownerId,
      eventId: event.id,
      version: state?.version ?? 0,
      draft: state?.draft ?? blankSponsors(),
      published: state?.published ?? null,
      eventOpen: eventOpen(event),
    });
  }
  router.get(root, async (req, res) => {
    const actor = await owner(req);
    const result = await withAccountLock(actor, async () => {
      const initial = await eventOf(req.params.id, actor);
      const { state } = await load(store(), initial);
      return response(await eventOf(initial.id, actor), state);
    });
    res.json(result);
  });
  router.put(root, async (req, res) => {
    const actor = await owner(req);
    if (req.get(SPONSOR_ACTOR) !== actor)
      throw new ApiError(
        409,
        'SPONSOR_ACCOUNT_CHANGED',
        'The signed-in account changed. Refresh these sponsor settings.',
      );
    const parsed = sponsorCommand.safeParse(req.body);
    if (!parsed.success)
      throw new ApiError(
        400,
        'SPONSORS_INVALID',
        'Review the sponsor fields, display choices and publication permission.',
      );
    const command = parsed.data,
      commandDigest = digest(command);
    const result = await withAccountLock(actor, async () => {
      const event = await eventOf(req.params.id, actor);
      const initial = await load(store(), event);
      const current = initial.state;
      if (
        current?.commandDigest === commandDigest &&
        current.version === command.version + 1
      )
        return response(await eventOf(event.id, actor), current);
      if ((current?.version ?? 0) !== command.version)
        throw new ApiError(
          409,
          'SPONSORS_CHANGED',
          'Sponsor settings changed. Load the latest version before saving.',
        );
      const nextVersion = command.version + 1;
      const now = new Date(
        Math.max(Date.now(), Date.parse(current?.updatedAt ?? '') || 0),
      ).toISOString();
      const fields =
        command.action === 'withdraw'
          ? (current?.draft ?? blankSponsors())
          : command.fields;
      const state = storedSponsors.parse({
        version: nextVersion,
        updatedAt: now,
        commandDigest,
        draft: fields,
        published:
          command.action === 'withdraw'
            ? null
            : command.action === 'publish'
              ? {
                  fields,
                  revision: nextVersion,
                  publishedAt: now,
                  permission: SPONSOR_PERMISSION,
                }
              : (current?.published ?? null),
      });
      const latest = await eventOf(event.id, actor);
      const fresh = await load(store(), latest);
      if (digest(fresh.row) !== digest(initial.row))
        throw new ApiError(
          409,
          'SPONSORS_CHANGED',
          'Sponsor settings changed. Load the latest version before saving.',
        );
      const row: LibraryRecord = {
        id: sponsorRecordId(event.id),
        ownerId: actor,
        eventId: event.id,
        kind: 'job',
        purpose: 'event-sponsors',
        createdAt: initial.row?.createdAt ?? now,
        eventSponsors: state,
      };
      if (Buffer.byteLength(JSON.stringify(row), 'utf8') > 12000)
        throw new ApiError(
          400,
          'SPONSORS_TOO_LARGE',
          'Shorten the sponsor details before saving.',
        );
      const finalEvent = await eventOf(event.id, actor);
      if (command.action === 'publish' && !eventOpen(finalEvent))
        throw new ApiError(
          409,
          'EVENT_UNAVAILABLE',
          'Restore or extend this event before publishing sponsor credits.',
        );
      await store().put(row, initial.row === null);
      return response(finalEvent, state);
    });
    res.json(result);
  });
  return router;
}
