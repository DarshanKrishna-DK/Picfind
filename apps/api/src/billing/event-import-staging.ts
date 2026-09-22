import { ApiError } from '../auth.js';
import { eventAccess } from '../event-membership-access.js';
import type { LibraryRecord } from '../library.js';
import { stableScanId } from '../scan-photo-preparation.js';
import type { BillingTransaction } from './model.js';
import type { EventBillingTransaction } from './event-entitlements.js';

/** Caller must touch/check the owner and actor billing accounts in this transaction. */
export async function stageEventImport(
  tx: BillingTransaction,
  actor: string,
  candidate: LibraryRecord,
  previousRequestId?: string,
): Promise<LibraryRecord> {
  const events = (tx as BillingTransaction & Partial<EventBillingTransaction>)
    .events;
  if (!events?.putImport)
    throw new ApiError(
      503,
      'EVENT_ACCOUNTING_UNAVAILABLE',
      'Transactional import staging is unavailable.',
    );
  const unavailable = () =>
    new ApiError(
      409,
      'IMPORT_UNAVAILABLE',
      'This event import changed. Refresh before trying again.',
    );
  if (
    !candidate.eventId ||
    !candidate.processingRequestId ||
    candidate.folderSyncId ||
    candidate.kind !== 'job' ||
    candidate.purpose !== 'import' ||
    candidate.processingSource !== 'cloud' ||
    candidate.deletionStartedAt ||
    !['drive', 'dropbox', 'onedrive', 'box'].includes(candidate.source ?? '') ||
    !/^[a-f0-9]{64}$/.test(candidate.sourceFingerprint ?? '') ||
    (candidate.uploadedBy ?? candidate.ownerId) !== actor
  )
    throw unavailable();
  const event = await events.get(candidate.eventId);
  if (!event || event.ownerId !== candidate.ownerId) throw unavailable();
  const access = eventAccess(event, actor, true);
  if (
    candidate.membershipGrantId !==
    (actor === event.ownerId ? undefined : access.grantId)
  )
    throw unavailable();
  const existing = await events.get(candidate.id);
  if (
    existing &&
    (!existing.processingRequestId ||
      existing.ownerId !== candidate.ownerId ||
      existing.kind !== 'job' ||
      existing.purpose !== 'import' ||
      existing.processingSource !== 'cloud' ||
      existing.source !== candidate.source ||
      existing.eventId !== candidate.eventId ||
      existing.folderSyncId ||
      existing.deletionStartedAt ||
      (existing.uploadedBy ?? existing.ownerId) !== actor ||
      existing.membershipGrantId !== candidate.membershipGrantId ||
      existing.sourceFingerprint !== candidate.sourceFingerprint ||
      (existing.processingRequestId !== candidate.processingRequestId &&
        existing.processingRequestId !== previousRequestId))
  )
    throw unavailable();
  if (
    !existing &&
    (previousRequestId !== undefined ||
      candidate.id !==
        stableScanId(
          'cloud-import',
          actor + ':' + candidate.processingRequestId,
        ))
  )
    throw unavailable();
  const root: LibraryRecord = existing
    ? existing.processingRequestId === candidate.processingRequestId
      ? existing
      : {
          ...existing,
          processingRequestId: candidate.processingRequestId,
          state: 'running',
          errors: [],
        }
    : {
        id: candidate.id,
        ownerId: event.ownerId,
        uploadedBy: actor,
        kind: 'job',
        purpose: 'import',
        processingSource: 'cloud',
        source: candidate.source!,
        eventId: event.id,
        ...(candidate.membershipGrantId
          ? { membershipGrantId: candidate.membershipGrantId }
          : {}),
        processingRequestId: candidate.processingRequestId,
        sourceFingerprint: candidate.sourceFingerprint!,
        createdAt: new Date().toISOString(),
        state: 'running',
        imported: 0,
        errors: [],
      };
  // Authority and root writes participate in commit conflict detection.
  await events.put(event);
  await events.putImport(root);
  return root;
}
