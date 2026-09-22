import type { TablesDB } from 'node-appwrite';
import { ApiError } from '../auth.js';
import { billingId, type BillingAccount } from '../billing/model.js';
import type { JobRecord } from '../jobs.js';

/** Event import staging has already established both account rows. */
export async function guardImportAccounts(
  db: TablesDB,
  databaseId: string,
  transactionId: string,
  job: JobRecord,
  namespace?: 'test_mode' | 'live_mode',
) {
  if (
    !namespace ||
    job.type !== 'cloud-import' ||
    !job.importSource?.destinationEventId
  )
    return;
  for (const owner of new Set([
    job.ownerId,
    job.importSource.actorId ?? job.ownerId,
  ])) {
    const params = {
      databaseId,
      tableId: 'billing',
      transactionId,
      rowId: billingId(namespace, 'account', owner),
    };
    let row;
    try {
      row = await db.getRow(params);
    } catch (error) {
      if ((error as { code?: number }).code === 404)
        throw new ApiError(
          409,
          'IMPORT_ACCOUNT_UNAVAILABLE',
          'Refresh this account before importing photos.',
        );
      throw error;
    }
    let account: BillingAccount;
    try {
      account = JSON.parse(row.payload as string) as BillingAccount;
    } catch {
      throw new ApiError(
        503,
        'IMPORT_ACCOUNT_UNAVAILABLE',
        'Import account storage needs maintenance.',
      );
    }
    if (
      !account ||
      account.ownerId !== owner ||
      row.ownerId !== `${namespace}:${owner}` ||
      row.kind !== 'account'
    )
      throw new ApiError(
        503,
        'IMPORT_ACCOUNT_UNAVAILABLE',
        'Import account storage needs maintenance.',
      );
    if (account.deletionPendingAt)
      throw new ApiError(
        409,
        'ACCOUNT_DELETION_PENDING',
        'Account deletion has started. New imports are disabled.',
      );
    // Include a write so a concurrent deletion fence conflicts at commit.
    await db.updateRow({ ...params, data: { payload: row.payload } });
  }
}
