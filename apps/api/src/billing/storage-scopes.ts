import { ApiError } from '../auth.js';
import {
  grantScope,
  type BillingAccount,
  type BillingScope,
  type Grant,
} from './model.js';

export function storageUsage(account: BillingAccount) {
  // Before role accounting, all receipts were part of the original mixed contract.
  account.storedBytesByScope ??= {
    legacy: account.storedBytes ?? 0,
    personal: 0,
    organizer: 0,
  };
  const usage = account.storedBytesByScope;
  if (
    Object.keys(usage).length !== 3 ||
    ['legacy', 'personal', 'organizer'].some(
      (scope) =>
        !Number.isSafeInteger(usage[scope as BillingScope]) ||
        usage[scope as BillingScope] < 0,
    ) ||
    usage.legacy + usage.personal + usage.organizer !== account.storedBytes
  )
    throw new ApiError(
      503,
      'STORAGE_ACCOUNTING',
      'Stored photo usage needs reconciliation.',
    );
  return usage;
}

export function reserveScopedStorage(
  usage: Record<BillingScope, number>,
  grants: Grant[],
  scope: BillingScope,
  bytes: number,
  now = Date.now(),
) {
  if (!['legacy', 'personal', 'organizer'].includes(scope))
    throw new Error('Unknown billing scope.');
  const caps = { legacy: 0, personal: 0, organizer: 0, preview: 0 };
  for (const grant of grants) {
    if (
      grant.held ||
      !(Date.parse(grant.createdAt) <= now && Date.parse(grant.expiresAt) > now)
    )
      continue;
    if (
      !Number.isSafeInteger(grant.storageBytes) ||
      grant.storageBytes < 0 ||
      !Number.isFinite(grant.refundFraction) ||
      grant.refundFraction < 0 ||
      grant.refundFraction > 1
    )
      throw new ApiError(
        503,
        'STORAGE_ACCOUNTING',
        'Storage allowances need reconciliation.',
      );
    const bucket = grant.plan === 'preview' ? 'preview' : grantScope(grant);
    caps[bucket] += Math.floor(grant.storageBytes * (1 - grant.refundFraction));
  }
  // Legacy paid storage is one shared pool, never counted once per role. The
  // personal trial may cover old/personal uploads, but can never fund an event.
  const sharedDemand = (value: Record<BillingScope, number>) =>
    Math.max(
      0,
      value.legacy + Math.max(0, value.personal - caps.personal) - caps.preview,
    ) + Math.max(0, value.organizer - caps.organizer);
  const next = { ...usage, [scope]: usage[scope] + bytes };
  if (
    !Number.isSafeInteger(next[scope]) ||
    sharedDemand(next) > Math.max(caps.legacy, sharedDemand(usage))
  )
    throw new ApiError(
      402,
      'STORAGE_ALLOWANCE_EXHAUSTED',
      'This storage allowance is full. Delete unneeded photos or choose an allowance in Billing. No extra charge was made.',
    );
  return next;
}
