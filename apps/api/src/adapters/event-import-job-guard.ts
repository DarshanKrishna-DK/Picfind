import type { TablesDB } from 'node-appwrite';
import { ApiError } from '../auth.js';
import { eventAccess } from '../event-membership-access.js';
import type { JobRecord } from '../jobs.js';
import type { LibraryRecord } from '../library.js';

// Fence manual enqueue against event deletion, membership revocation and a
// superseding import attempt. Sync imports use their own source authority guard.
export async function guardEventImportJob(
  db: TablesDB,
  databaseId: string,
  transactionId: string,
  job: JobRecord,
) {
  const source = job.importSource;
  if (!source?.destinationEventId || source.folderSyncId) return;
  const unavailable = () =>
    new ApiError(
      409,
      'EVENT_IMPORT_UNAVAILABLE',
      'Refresh this event before importing photos.',
    );
  const read = async (id: string) => {
    const args = { databaseId, tableId: 'records', rowId: id, transactionId };
    let row;
    try {
      row = await db.getRow(args);
    } catch (error) {
      if ((error as { code?: number }).code === 404) throw unavailable();
      throw error;
    }
    let record: LibraryRecord;
    try {
      record = JSON.parse(row.payload as string) as LibraryRecord;
    } catch {
      throw unavailable();
    }
    if (
      !record ||
      record.id !== id ||
      record.ownerId !== job.ownerId ||
      row.ownerId !== record.ownerId ||
      row.kind !== record.kind
    )
      throw unavailable();
    return { record, args, payload: row.payload as string };
  };
  const event = await read(source.destinationEventId);
  const actor = source.actorId ?? job.ownerId;
  const access = eventAccess(event.record, actor, true);
  if (actor !== job.ownerId && access.grantId !== source.membershipGrantId)
    throw unavailable();
  const root = await read(job.eventId);
  const record = root.record;
  if (
    record.kind !== 'job' ||
    record.purpose !== 'import' ||
    record.processingSource !== 'cloud' ||
    record.source !== source.provider ||
    record.eventId !== event.record.id ||
    record.deletionStartedAt ||
    record.folderSyncId ||
    record.processingRequestId !== job.requestId ||
    (record.uploadedBy ?? record.ownerId) !== actor ||
    record.membershipGrantId !== source.membershipGrantId
  )
    throw unavailable();
  // Writes are intentional: a concurrent authority change must conflict at
  // commit, not merely pass a stale transactional read.
  for (const entry of [event, root])
    await db.updateRow({ ...entry.args, data: { payload: entry.payload } });
}
