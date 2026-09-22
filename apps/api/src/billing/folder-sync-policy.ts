import { ApiError } from '../auth.js';
import { eventAccess } from '../event-membership-access.js';
import type { FolderSync } from '../folder-sync.js';
import type { BillingTransaction } from './model.js';
import {
  organizerEventPolicy,
  type EventBillingTransaction,
} from './event-entitlements.js';

/** Paid organizer authority, not personal packs or the guest's billing account. */
export async function authorizeFolderSync(
  tx: BillingTransaction,
  namespace: string,
  sync: FolderSync,
) {
  const events = (tx as BillingTransaction & Partial<EventBillingTransaction>)
    .events;
  if (!events)
    throw new ApiError(
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Event accounting is unavailable.',
    );
  const event = await events.get(sync.eventId);
  if (!event || event.ownerId !== sync.ownerId || event.kind !== 'event')
    throw new ApiError(
      409,
      'EVENT_UNAVAILABLE',
      'This event is no longer available.',
    );
  if (
    !event.expiresAt ||
    !Number.isFinite(Date.parse(event.expiresAt)) ||
    Date.parse(event.expiresAt) <= Date.now()
  )
    throw new ApiError(
      409,
      'SYNC_EXPIRED',
      'Choose a valid event expiry before enabling automatic imports.',
    );
  const access = eventAccess(event, sync.actorId, true);
  if (
    access.role === 'moderator'
      ? access.grantId !== sync.membershipGrantId
      : sync.membershipGrantId !== undefined
  )
    throw new ApiError(
      409,
      'MEMBERSHIP_CHANGED',
      'This event membership has changed.',
    );
  const policy = await organizerEventPolicy(tx, namespace, sync.ownerId, true);
  if (!policy.entitlement)
    throw new ApiError(
      402,
      'ORGANIZER_REQUIRED',
      'An active organizer plan is required for automatic event imports.',
    );
  return { expiresAt: event.expiresAt };
}
