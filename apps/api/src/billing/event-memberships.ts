import { randomUUID } from 'node:crypto';
import { ApiError, type AuthUser } from '../auth.js';
import type { LibraryRecord } from '../library.js';
import {
  eventAccess,
  eventMembers,
  membershipInboxId,
} from '../event-membership-access.js';
import { assertEventImportOpen } from '../event-import-policy.js';
import {
  MAX_EVENT_MODERATORS,
  type EventMemberView,
} from '../../../../packages/shared/src/event-membership.js';
import {
  billingId,
  type BillingAccount,
  type BillingTransaction,
} from './model.js';
import {
  saveOrganizerEvent,
  type EventBillingTransaction,
} from './event-entitlements.js';

function records(tx: BillingTransaction) {
  const events = (tx as BillingTransaction & Partial<EventBillingTransaction>)
    .events;
  if (!events?.putMembership || !events.putPhoto)
    throw new ApiError(
      503,
      'MEMBERSHIPS_UNAVAILABLE',
      'Event collaboration accounting is unavailable.',
    );
  return events;
}
async function owned(tx: BillingTransaction, owner: string, id: string) {
  const event = await records(tx).get(id);
  if (
    !event ||
    event.kind !== 'event' ||
    event.ownerId !== owner ||
    event.deletionStartedAt
  )
    throw new ApiError(404, 'NOT_FOUND', 'This event is not available.');
  return event;
}
export async function listEventMembers(
  tx: BillingTransaction,
  owner: string,
  eventId: string,
): Promise<EventMemberView[]> {
  const event = await owned(tx, owner, eventId),
    result: EventMemberView[] = [];
  for (const member of eventMembers(event)) {
    const inbox = await records(tx).get(
      membershipInboxId(eventId, member.userId),
    );
    const valid =
      inbox?.purpose === 'event-membership' &&
      inbox.ownerId === member.userId &&
      inbox.eventId === eventId &&
      inbox.membershipEventOwnerId === owner &&
      inbox.membershipGrantId === member.grantId &&
      !inbox.membershipRevokedAt;
    result.push({
      ...member,
      name: valid ? (inbox.memberName ?? '') : 'Unavailable account',
      email: valid ? (inbox.memberEmail ?? '') : '',
    });
  }
  return result;
}
export async function inviteEventMember(
  tx: BillingTransaction,
  namespace: string,
  owner: string,
  account: BillingAccount,
  eventId: string,
  target: AuthUser,
) {
  const event = await owned(tx, owner, eventId);
  assertEventImportOpen(event);
  if (target.id === owner)
    throw new ApiError(
      400,
      'OWNER_ROLE_PROTECTED',
      'The creator already owns this event.',
    );
  if (
    !target.emailVerified ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(target.id)
  )
    throw new ApiError(
      400,
      'MEMBER_UNAVAILABLE',
      'Ask this person to sign in and verify their PicFind email first.',
    );
  const members = eventMembers(event),
    previous = members.find((row) => row.userId === target.id);
  if (!previous && members.length >= MAX_EVENT_MODERATORS)
    throw new ApiError(
      409,
      'MEMBER_LIMIT',
      `This event supports up to ${MAX_EVENT_MODERATORS} moderators.`,
    );
  const member = previous ?? {
    userId: target.id,
    role: 'moderator' as const,
    grantId: randomUUID(),
    addedAt: new Date().toISOString(),
  };
  await saveOrganizerEvent(
    tx,
    namespace,
    owner,
    account,
    eventId,
    { members: previous ? members : [...members, member] },
    false,
    1000,
  );
  await records(tx).putMembership!({
    id: membershipInboxId(eventId, target.id),
    kind: 'job',
    purpose: 'event-membership',
    ownerId: target.id,
    eventId,
    createdAt: member.addedAt,
    membershipGrantId: member.grantId,
    membershipEventOwnerId: owner,
    memberEmail: target.email,
    memberName: target.name,
  });
  return { ...member, name: target.name, email: target.email };
}
export async function revokeEventMember(
  tx: BillingTransaction,
  namespace: string,
  owner: string,
  account: BillingAccount,
  eventId: string,
  userId: string,
) {
  const event = await owned(tx, owner, eventId);
  if (userId === owner)
    throw new ApiError(
      400,
      'OWNER_ROLE_PROTECTED',
      'The event creator cannot be removed.',
    );
  const members = eventMembers(event);
  await saveOrganizerEvent(
    tx,
    namespace,
    owner,
    account,
    eventId,
    { members: members.filter((row) => row.userId !== userId) },
    false,
    1000,
  );
  const inbox = await records(tx).get(membershipInboxId(eventId, userId));
  if (inbox) {
    if (
      inbox.kind !== 'job' ||
      inbox.purpose !== 'event-membership' ||
      inbox.ownerId !== userId ||
      inbox.eventId !== eventId ||
      inbox.membershipEventOwnerId !== owner
    )
      throw new ApiError(
        503,
        'MEMBERSHIP_INVALID',
        'This membership needs maintenance.',
      );
    await records(tx).putMembership!({
      ...inbox,
      membershipRevokedAt: new Date().toISOString(),
      memberEmail: '',
      memberName: '',
    });
  }
}
export async function commitMemberPhoto(
  tx: BillingTransaction,
  namespace: string,
  owner: string,
  account: BillingAccount,
  actor: string,
  grantId: string,
  photo: LibraryRecord,
) {
  if (account.deletionPendingAt)
    throw new ApiError(
      409,
      'ACCOUNT_DELETION_PENDING',
      'This account is being deleted.',
    );
  const event = await records(tx).get(photo.eventId ?? '');
  if (
    !event ||
    event.ownerId !== owner ||
    photo.ownerId !== owner ||
    photo.kind !== 'photo' ||
    photo.scanId
  )
    throw new ApiError(404, 'NOT_FOUND', 'This event is not available.');
  const access = eventAccess(event, actor, true);
  if (access.grantId !== grantId)
    throw new ApiError(
      409,
      'MEMBERSHIP_CHANGED',
      'Your event access changed. Ask the organizer before uploading again.',
    );
  const intent = await records(tx).get(photo.id);
  if (
    !intent ||
    intent.ownerId !== owner ||
    intent.eventId !== photo.eventId ||
    intent.digest !== photo.digest ||
    intent.bytes !== photo.bytes ||
    intent.uploadedBy !== actor ||
    !(
      (intent.kind === 'job' && intent.purpose === 'upload-cleanup') ||
      intent.kind === 'photo'
    )
  )
    throw new ApiError(
      503,
      'UPLOAD_RECOVERY_REQUIRED',
      'This upload needs recovery before it can be published.',
    );
  if (
    event.expiresAt &&
    Date.parse(event.expiresAt) < Date.parse(photo.expiresAt!)
  )
    photo = { ...photo, expiresAt: event.expiresAt };
  // Touch both authority rows: revocation, expiry and account deletion must
  // conflict/retry atomically with publishing the uploaded photo metadata.
  await tx.put(
    billingId(namespace, 'account', owner),
    `${namespace}:${owner}`,
    'account',
    account,
  );
  await records(tx).put(event);
  await records(tx).putPhoto!(photo);
  return photo;
}
