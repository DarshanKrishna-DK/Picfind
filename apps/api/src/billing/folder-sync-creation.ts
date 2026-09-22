import { ApiError } from '../auth.js';
import { eventAccess } from '../event-membership-access.js';
import type { FolderSync } from '../folder-sync.js';
import { validateSyncFolder } from '../folder-sync-reader.js';
import { stableScanId } from '../scan-photo-preparation.js';
import type { SourceProvider } from '../source-connections.js';
import type { BillingAccount, BillingTransaction } from './model.js';
import type { EventBillingTransaction } from './event-entitlements.js';
import { authorizeFolderSync } from './folder-sync-policy.js';

export const MAX_ACTIVE_EVENT_SYNCS = 8;
export const MAX_STORED_EVENT_SYNCS = 32;
export interface CreateFolderSyncInput {
  requestId: string;
  provider: SourceProvider;
  generation: string;
  folderId: string;
  replacesSyncId?: string | undefined;
  acceptConnectionChange?: boolean | undefined;
}
export const folderSyncId = (
  actor: string,
  eventId: string,
  requestId: string,
) => stableScanId('event-folder-sync', actor + ':' + eventId + ':' + requestId);

export async function createFolderSync(
  tx: BillingTransaction,
  namespace: string,
  actor: string,
  eventId: string,
  input: CreateFolderSyncInput,
  expectedGrant: string,
  account: (owner: string) => Promise<BillingAccount>,
) {
  const records = tx as BillingTransaction & Partial<EventBillingTransaction>;
  if (!records.events || !records.folderSyncs)
    throw new ApiError(
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Transactional event sources are unavailable.',
    );
  const event = await records.events.get(eventId);
  if (!event)
    throw new ApiError(404, 'NOT_FOUND', 'This event is not available.');
  const access = eventAccess(event, actor, true);
  if (access.grantId !== expectedGrant)
    throw new ApiError(
      409,
      'MEMBERSHIP_CHANGED',
      'Your event access changed. Reopen the source before enabling sync.',
    );
  const ownerAccount = await account(event.ownerId);
  if (
    ownerAccount.deletionPendingAt ||
    (actor !== event.ownerId && (await account(actor)).deletionPendingAt)
  )
    throw new ApiError(
      409,
      'ACCOUNT_DELETION_PENDING',
      'This account is being deleted.',
    );
  const now = new Date().toISOString();
  const record: FolderSync = {
    id: folderSyncId(actor, eventId, input.requestId),
    ownerId: event.ownerId,
    actorId: actor,
    eventId,
    provider: input.provider,
    generation: input.generation,
    folderId: validateSyncFolder(input),
    ...(access.role === 'moderator'
      ? { membershipGrantId: access.grantId }
      : {}),
    consentPolicyVersion: 'folder-sync-v1',
    status: 'active',
    createdAt: now,
    nextRunAt: now,
    cursor: null,
    pages: 0,
    imported: 0,
  };
  await authorizeFolderSync(tx, namespace, record);
  const existing = await records.folderSyncs.get(record.id);
  if (existing) {
    if (
      existing.ownerId !== record.ownerId ||
      existing.actorId !== actor ||
      existing.eventId !== eventId ||
      existing.provider !== record.provider ||
      existing.generation !== record.generation ||
      existing.folderId !== record.folderId ||
      existing.membershipGrantId !== record.membershipGrantId ||
      existing.consentPolicyVersion !== 'folder-sync-v1'
    )
      throw new ApiError(
        409,
        'SYNC_REQUEST_REUSED',
        'This request already belongs to a different event source.',
      );
    return existing;
  }
  const sources = await records.folderSyncs.listEvent(event.ownerId, eventId);
  if (
    sources.length >= MAX_STORED_EVENT_SYNCS ||
    sources.filter(
      (row) => row.status === 'active' || row.status === 'attention',
    ).length >= MAX_ACTIVE_EVENT_SYNCS
  )
    throw new ApiError(
      409,
      'SYNC_SOURCE_LIMIT',
      `An event supports ${MAX_ACTIVE_EVENT_SYNCS} active sources and ${MAX_STORED_EVENT_SYNCS} saved source definitions.`,
    );
  const sameFolder = sources.filter(
    (row) =>
      row.actorId === actor &&
      row.provider === record.provider &&
      row.folderId === record.folderId,
  );
  if (sameFolder.some((row) => row.generation === record.generation))
    throw new ApiError(
      409,
      'SYNC_ALREADY_CONFIGURED',
      'This folder already has a saved source. Use its status and recovery controls rather than creating a duplicate.',
    );
  if (
    sameFolder.some(
      (row) => row.status === 'active' || row.status === 'attention',
    )
  )
    throw new ApiError(
      409,
      'SYNC_STOP_REQUIRED',
      'Stop the previous source before reconnecting this folder.',
    );
  if (
    sameFolder.length ||
    input.replacesSyncId ||
    input.acceptConnectionChange
  ) {
    const replaced = sameFolder.find((row) => row.id === input.replacesSyncId);
    if (
      !replaced ||
      !input.acceptConnectionChange ||
      !['paused', 'expired'].includes(replaced.status)
    )
      throw new ApiError(
        409,
        'SYNC_RECONNECT_CONFIRMATION_REQUIRED',
        'Confirm the stopped source and the newly connected account. Its files will be treated as a new collection source.',
      );
  }
  // Concurrent source creation must conflict on the event row, not just distinct
  // source IDs, so retrying rechecks the event-wide limits and duplicates.
  await records.events.put(event);
  await records.folderSyncs.create(record);
  return record;
}
