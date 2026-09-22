import { createHash } from 'node:crypto';
import { ApiError } from '../auth.js';
import type { LibraryRecord } from '../library.js';
import type { OrganizerEventPolicy } from '../../../../packages/shared/src/event-policy.js';
import {
  billingId,
  grantScope,
  type BillingAccount,
  type BillingTransaction,
  type Grant,
} from './model.js';

export interface EventTransaction {
  get(id: string): Promise<LibraryRecord | null>;
  list(owner: string): Promise<LibraryRecord[]>;
  put(event: LibraryRecord): Promise<void>;
  putMembership?(record: LibraryRecord): Promise<void>;
  putPhoto?(record: LibraryRecord): Promise<void>;
  putImport?(record: LibraryRecord): Promise<void>;
}
export interface EventBillingTransaction {
  events: EventTransaction;
  folderSyncs?: {
    suppressed(photo: LibraryRecord): Promise<boolean>;
    suppress(photo: LibraryRecord): Promise<void>;
    update(record: import('../folder-sync.js').FolderSync): Promise<void>;
    listEvent(
      ownerId: string,
      eventId: string,
    ): Promise<import('../folder-sync.js').FolderSync[]>;
    create(record: import('../folder-sync.js').FolderSync): Promise<void>;
    get(id: string): Promise<import('../folder-sync.js').FolderSync | null>;
    touch(record: import('../folder-sync.js').FolderSync): Promise<void>;
  };
}
export type EventPatch = Partial<
  Pick<
    LibraryRecord,
    | 'title'
    | 'folder'
    | 'description'
    | 'date'
    | 'expiresAt'
    | 'visibility'
    | 'archived'
    | 'deletionStartedAt'
    | 'passcodeHash'
    | 'brandingName'
    | 'accentColor'
    | 'members'
  >
>;
const DAY = 86400000;
function eventStore(tx: BillingTransaction) {
  const events = (tx as BillingTransaction & Partial<EventBillingTransaction>)
    .events;
  if (!events)
    throw new ApiError(
      503,
      'EVENT_ACCOUNTING_UNAVAILABLE',
      'Event capacity accounting is unavailable. No event changes were made.',
    );
  return events;
}
export function liveEvent(event: LibraryRecord, now = Date.now()) {
  // Old undated or malformed records count conservatively until the owner fixes
  // or archives them. Never silently free a slot for a still-accessible gallery.
  return (
    event.kind === 'event' &&
    !event.archived &&
    !event.deletionStartedAt &&
    (!event.expiresAt ||
      !Number.isFinite(Date.parse(event.expiresAt)) ||
      Date.parse(event.expiresAt) > now)
  );
}
async function activeGrant(
  tx: BillingTransaction,
  namespace: string,
  owner: string,
  now: number,
) {
  return (await tx.list<Grant>(`${namespace}:${owner}`, 'grant'))
    .filter(
      (grant) =>
        grantScope(grant) === 'organizer' &&
        !grant.parentGrantId &&
        (grant.entitlementMonths === 1 || grant.entitlementMonths === 12) &&
        Boolean(
          grant.paymentId && grant.subscriptionId && grant.paymentBasis,
        ) &&
        !grant.held &&
        Number.isFinite(grant.refundFraction) &&
        grant.refundFraction >= 0 &&
        grant.refundFraction < 1 &&
        Date.parse(grant.createdAt) <= now &&
        Date.parse(grant.expiresAt) > now &&
        Number.isSafeInteger(grant.retentionDays) &&
        grant.retentionDays! > 0 &&
        grant.retentionDays! <= 365 &&
        Number.isSafeInteger(grant.liveEvents) &&
        grant.liveEvents! > 0 &&
        grant.liveEvents! <= 1000,
    )
    .sort(
      (a, b) =>
        b.retentionDays! - a.retentionDays! || b.liveEvents! - a.liveEvents!,
    )[0];
}
export async function organizerEventPolicy(
  tx: BillingTransaction,
  namespace: string,
  owner: string,
  catalogAvailable: boolean,
): Promise<OrganizerEventPolicy> {
  const now = Date.now();
  const grant = await activeGrant(tx, namespace, owner, now);
  const activeEvents = (await eventStore(tx).list(owner)).filter((event) =>
    liveEvent(event, now),
  ).length;
  const remainingEvents = Math.max(0, (grant?.liveEvents ?? 0) - activeEvents);
  return {
    entitlement: grant
      ? {
          plan: grant.plan,
          retentionDays: grant.retentionDays!,
          liveEvents: grant.liveEvents!,
          paidThrough: grant.expiresAt,
        }
      : null,
    activeEvents,
    remainingEvents,
    maximumExpiresAt: grant
      ? new Date(now + grant.retentionDays! * DAY).toISOString()
      : null,
    serverNow: new Date(now).toISOString(),
    canCreate: Boolean(grant && remainingEvents),
    catalogAvailable,
  };
}
export function eventCreationId(owner: string, requestId: string) {
  const hex = createHash('sha256')
    .update('event-create:' + owner + ':' + requestId)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function saveOrganizerEvent(
  tx: BillingTransaction,
  namespace: string,
  owner: string,
  account: BillingAccount,
  id: string,
  patch: EventPatch,
  create: boolean,
  maxStoredEvents: number,
): Promise<LibraryRecord> {
  const events = eventStore(tx),
    now = Date.now();
  const previous = await events.get(id);
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        title: patch.title,
        folder: patch.folder ?? '',
        description: patch.description ?? '',
        date: patch.date ?? '',
        expiresAt: patch.expiresAt,
      }),
    )
    .digest('hex');
  if (previous && (previous.ownerId !== owner || previous.kind !== 'event'))
    throw new ApiError(404, 'NOT_FOUND', 'This event is not available.');
  if (create && previous) {
    if (previous.creationFingerprint !== fingerprint)
      throw new ApiError(
        409,
        'EVENT_REQUEST_REUSED',
        'This create request already belongs to another set of event details. Open the saved event before making changes.',
      );
    return previous;
  }
  if (!create && !previous)
    throw new ApiError(404, 'NOT_FOUND', 'This event is not available.');
  if (previous?.deletionStartedAt && !patch.deletionStartedAt)
    throw new ApiError(409, 'EVENT_DELETING', 'This event is being deleted.');
  if (account.deletionPendingAt && !patch.deletionStartedAt)
    throw new ApiError(
      409,
      'ACCOUNT_DELETION_PENDING',
      'Finish or cancel account deletion before changing events.',
    );
  const updated: LibraryRecord = create
    ? {
        ...patch,
        id,
        ownerId: owner,
        kind: 'event',
        createdAt: new Date(now).toISOString(),
        archived: false,
        visibility: 'private',
        creationFingerprint: fingerprint,
      }
    : { ...previous!, ...patch };
  if (updated.passcodeHash === '') delete updated.passcodeHash;
  const expiryChanged =
    Object.hasOwn(patch, 'expiresAt') &&
    patch.expiresAt !== previous?.expiresAt;
  const opening =
    !create &&
    ((!liveEvent(previous!, now) && liveEvent(updated, now)) ||
      (patch.visibility === 'link' && previous!.visibility !== 'link'));
  const addingMembers =
    (patch.members?.length ?? 0) > (previous?.members?.length ?? 0);
  const needsEntitlement = create || expiryChanged || opening || addingMembers;
  const grant = needsEntitlement
    ? await activeGrant(tx, namespace, owner, now)
    : undefined;
  if (needsEntitlement) {
    if (!grant)
      throw new ApiError(
        402,
        'ORGANIZER_PLAN_REQUIRED',
        'An active organizer plan is required. Personal photo packs do not include event hosting.',
      );
    const expiry = Date.parse(updated.expiresAt ?? '');
    if (!Number.isFinite(expiry) || expiry <= now)
      throw new ApiError(
        400,
        'EVENT_EXPIRY_REQUIRED',
        'Choose a future gallery/storage expiry date.',
      );
    if (expiry > now + grant.retentionDays! * DAY)
      throw new ApiError(
        400,
        'EVENT_RETENTION_LIMIT',
        `Your plan allows up to ${grant.retentionDays} days. Choose an earlier expiry date.`,
      );
    // Touch the entitlement in the same transaction so a concurrent refund or
    // hold conflicts rather than granting an event from an obsolete paid state.
    await tx.put(grant.id, `${namespace}:${owner}`, 'grant', grant);
  }
  const rows = await events.list(owner);
  if (create && rows.length >= maxStoredEvents)
    throw new ApiError(
      409,
      'EVENT_STORAGE_LIMIT',
      'Delete an unused event before creating another.',
    );
  if (
    grant &&
    liveEvent(updated, now) &&
    rows.filter((row) => row.id !== id && liveEvent(row, now)).length >=
      grant.liveEvents!
  )
    throw new ApiError(
      409,
      'EVENT_LIMIT',
      `Your organizer plan allows ${grant.liveEvents} live events. Archive an event or choose a larger plan.`,
    );
  const revision =
    (account as BillingAccount & { eventRevision?: number }).eventRevision ?? 0;
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision >= Number.MAX_SAFE_INTEGER
  )
    throw new ApiError(
      503,
      'EVENT_ACCOUNTING_UNAVAILABLE',
      'Event capacity needs maintenance.',
    );
  // All lifecycle mutations share this conflict row. The row and the event are
  // committed together; no process-local lock or separately committed slot exists.
  await tx.put(
    billingId(namespace, 'account', owner),
    `${namespace}:${owner}`,
    'account',
    { ...account, eventRevision: revision + 1 },
  );
  await events.put(updated);
  return updated;
}
