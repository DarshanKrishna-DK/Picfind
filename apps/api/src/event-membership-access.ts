import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './auth.js';
import type { LibraryRecord, LibraryStore } from './library.js';
import { MAX_EVENT_MODERATORS } from '../../../packages/shared/src/event-membership.js';
import { assertEventImportOpen } from './event-import-policy.js';

const claims = z
  .array(
    z
      .object({
        userId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/),
        role: z.literal('moderator'),
        grantId: z.uuid(),
        addedAt: z.iso.datetime(),
      })
      .strict(),
  )
  .max(MAX_EVENT_MODERATORS);
export function eventMembers(event: LibraryRecord) {
  const parsed = claims.safeParse(event.members ?? []);
  if (
    !parsed.success ||
    new Set(parsed.data.map((row) => row.userId)).size !== parsed.data.length ||
    parsed.data.some((row) => row.userId === event.ownerId)
  )
    throw new ApiError(
      503,
      'MEMBERSHIP_INVALID',
      'This event membership needs maintenance.',
    );
  return parsed.data;
}
export function membershipInboxId(eventId: string, userId: string) {
  return createHash('sha256')
    .update('event-member:' + eventId + ':' + userId)
    .digest('hex')
    .slice(0, 36);
}
export function eventAccess(
  event: LibraryRecord,
  actor: string,
  importing = false,
) {
  if (event.kind !== 'event' || event.deletionStartedAt)
    throw new ApiError(404, 'NOT_FOUND', 'This event is not available.');
  if (event.ownerId === actor) {
    if (importing) assertEventImportOpen(event);
    return { event, role: 'owner' as const, grantId: 'owner' };
  }
  const member = eventMembers(event).find((row) => row.userId === actor);
  if (
    !member ||
    event.archived ||
    (event.expiresAt &&
      (!Number.isFinite(Date.parse(event.expiresAt)) ||
        Date.parse(event.expiresAt) <= Date.now()))
  )
    throw new ApiError(404, 'NOT_FOUND', 'This event is not available.');
  if (importing) assertEventImportOpen(event);
  return { event, role: 'moderator' as const, grantId: member.grantId };
}
export async function requireEventAccess(
  store: LibraryStore,
  eventId: string,
  actor: string,
  importing = false,
) {
  return eventAccess(await store.get(eventId), actor, importing);
}
export async function memberEvents(
  store: LibraryStore,
  user: string,
  jobs: LibraryRecord[],
) {
  const found: (LibraryRecord & { accessRole: 'moderator' })[] = [];
  const seen = new Set<string>();
  for (const inbox of jobs) {
    if (
      inbox.ownerId !== user ||
      inbox.purpose !== 'event-membership' ||
      !inbox.eventId ||
      inbox.membershipRevokedAt ||
      seen.has(inbox.eventId)
    )
      continue;
    if (inbox.id !== membershipInboxId(inbox.eventId, user)) continue;
    try {
      const access = await requireEventAccess(store, inbox.eventId, user);
      if (
        access.role !== 'moderator' ||
        access.grantId !== inbox.membershipGrantId ||
        access.event.ownerId !== inbox.membershipEventOwnerId
      )
        continue;
      seen.add(inbox.eventId);
      const { members, passcodeHash, folder, ...event } = access.event;
      void members;
      void passcodeHash;
      void folder;
      found.push({ ...event, accessRole: 'moderator' });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
  return found;
}
