import { ApiError } from '../auth.js';
import { eventAccess } from '../event-membership-access.js';
import type { FolderSync } from '../folder-sync.js';
import { stableScanId } from '../scan-photo-preparation.js';
import type { BillingAccount, BillingTransaction } from './model.js';
import type { EventBillingTransaction } from './event-entitlements.js';
import { authorizeFolderSync } from './folder-sync-policy.js';
import { MAX_ACTIVE_EVENT_SYNCS } from './folder-sync-creation.js';

export async function resumeFolderSync(
  tx: BillingTransaction,
  namespace: string,
  actor: string,
  eventId: string,
  snapshot: FolderSync,
  requestId: string,
  recovery: import('../folder-sync-recovery.js').FolderSyncRecovery,
  account: (owner: string) => Promise<BillingAccount>,
) {
  const records = tx as BillingTransaction & Partial<EventBillingTransaction>;
  const preserved = recovery.preservedFileIndexes;
  if (!records.events?.putImport || !records.folderSyncs)
    throw new ApiError(
      503,
      'USAGE_ACCOUNTING_UNAVAILABLE',
      'Transactional source recovery is unavailable.',
    );
  const sync = await records.folderSyncs.get(snapshot.id),
    event = await records.events.get(eventId);
  if (
    !sync ||
    !event ||
    sync.eventId !== eventId ||
    sync.ownerId !== event.ownerId ||
    sync.actorId !== actor
  )
    throw new ApiError(404, 'NOT_FOUND', 'This source is not available.');
  const access = eventAccess(event, actor, true);
  if (access.role === 'moderator' && access.grantId !== sync.membershipGrantId)
    throw new ApiError(
      409,
      'MEMBERSHIP_CHANGED',
      'This event membership changed.',
    );
  if (
    (await account(sync.ownerId)).deletionPendingAt ||
    (actor !== sync.ownerId && (await account(actor)).deletionPendingAt)
  )
    throw new ApiError(
      409,
      'ACCOUNT_DELETION_PENDING',
      'This account is being deleted.',
    );
  await authorizeFolderSync(tx, namespace, sync);
  if (sync.resumeRequestId === requestId) return sync;
  if (
    sync.status !== 'paused' ||
    sync.consentPolicyVersion !== 'folder-sync-v1' ||
    JSON.stringify(sync) !== JSON.stringify(snapshot)
  )
    throw new ApiError(
      409,
      'SYNC_CHANGED',
      'The source changed. Refresh its status before resuming.',
    );
  const sources = await records.folderSyncs.listEvent(sync.ownerId, eventId);
  if (
    sources.filter(
      (row) => row.status === 'active' || row.status === 'attention',
    ).length >= MAX_ACTIVE_EVENT_SYNCS
  )
    throw new ApiError(
      409,
      'SYNC_SOURCE_LIMIT',
      'Stop another source before resuming this one.',
    );
  if (
    new Set(preserved).size !== preserved.length ||
    preserved.some(
      (index) =>
        !Number.isInteger(index) ||
        index < 0 ||
        index >= (sync.pending?.fileIds.length ?? 0),
    )
  )
    throw new ApiError(
      409,
      'SYNC_RECOVERY_REQUIRED',
      'This recovery snapshot is not valid.',
    );
  if (sync.pending) {
    const attempt = sync.pending.attemptId ?? sync.pending.requestId;
    if (requestId === attempt)
      throw new ApiError(
        409,
        'SYNC_REQUEST_REUSED',
        'Use a new resume request identifier.',
      );
    const root = await records.events.get(
      stableScanId(
        'folder-sync-import',
        sync.id + ':' + sync.pending.requestId,
      ),
    );
    if (!root && recovery.rootRequired)
      throw new ApiError(
        409,
        'SYNC_RECOVERY_REQUIRED',
        'This import was removed. Recovery will not recreate it.',
      );
    if (root) {
      if (
        root.kind !== 'job' ||
        root.purpose !== 'import' ||
        root.processingSource !== 'cloud' ||
        root.ownerId !== sync.ownerId ||
        root.eventId !== sync.eventId ||
        root.folderSyncId !== sync.id ||
        root.source !== sync.provider ||
        root.uploadedBy !== actor ||
        root.membershipGrantId !== sync.membershipGrantId ||
        root.processingRequestId !== attempt ||
        root.deletionStartedAt
      )
        throw new ApiError(
          409,
          'SYNC_RECOVERY_REQUIRED',
          'This import needs maintenance before it can resume.',
        );
      await records.events.putImport({
        ...root,
        processingRequestId: requestId,
        state: 'running',
        errors: [],
      });
    }
    sync.pending = {
      ...sync.pending,
      attemptId: requestId,
      preservedFileIndexes: preserved,
    };
    delete sync.pending.batchId;
  } else {
    sync.cursor = null;
    sync.pages = 0;
  }
  sync.status = 'active';
  sync.resumeRequestId = requestId;
  sync.nextRunAt = new Date().toISOString();
  delete sync.leaseToken;
  delete sync.leaseUntil;
  delete sync.error;
  await records.events.put(event);
  await records.folderSyncs.update(sync);
  return sync;
}
