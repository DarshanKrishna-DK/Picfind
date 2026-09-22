import { ApiError } from '../auth.js';
import {
  addMonths,
  billingId,
  grantScope,
  type BillingTransaction,
  type Grant,
} from './model.js';

export function currentAllowanceWindow(root: Grant, now = Date.now()) {
  if (
    ![1, 12].includes(root.entitlementMonths ?? 0) ||
    !Number.isFinite(Date.parse(root.createdAt)) ||
    !Number.isFinite(Date.parse(root.expiresAt)) ||
    now < Date.parse(root.createdAt) ||
    now >= Date.parse(root.expiresAt)
  )
    return null;
  for (let index = 0; index < root.entitlementMonths!; index++) {
    const createdAt = addMonths(root.createdAt, index);
    const expiresAt = new Date(
      Math.min(
        Date.parse(addMonths(root.createdAt, index + 1)),
        Date.parse(root.expiresAt),
      ),
    ).toISOString();
    if (now >= Date.parse(createdAt) && now < Date.parse(expiresAt))
      return { index, createdAt, expiresAt };
  }
  return null;
}
function invalid(): never {
  throw new ApiError(
    503,
    'BILLING_ACCOUNTING',
    'Subscription allowances need reconciliation. No usage was charged.',
  );
}

/** Run inside the same account transaction as reservation. Never roll unused credits forward. */
export async function materializeAllowanceWindows(
  tx: BillingTransaction,
  namespace: string,
  owner: string,
  now = Date.now(),
) {
  const ownerKey = `${namespace}:${owner}`;
  const rows = await tx.list<Grant>(ownerKey, 'grant');
  const grants = new Map(rows.map((grant) => [grant.id, grant]));
  for (const root of rows) {
    if (root.ownerId !== owner) invalid();
    if (!root.entitlementMonths) continue;
    if (
      root.parentGrantId ||
      grantScope(root) !== 'organizer' ||
      !root.paymentId ||
      !root.subscriptionId ||
      !root.paymentBasis
    )
      invalid();
    const window = currentAllowanceWindow(root, now);
    if (!window || root.held || root.refundFraction >= 1) continue;
    const id = billingId(
      namespace,
      'grant-window',
      root.id + ':' + window.index,
    );
    if (grants.has(id)) continue;
    const child: Grant = {
      ...root,
      id,
      parentGrantId: root.id,
      windowIndex: window.index,
      createdAt: window.createdAt,
      expiresAt: window.expiresAt,
      storageBytes: 0,
      usedPhotos: 0,
      usedSearches: 0,
      usedDeliveryBytes: 0,
    };
    delete child.entitlementMonths;
    await tx.put(id, ownerKey, 'grant', child);
    grants.set(id, child);
  }
  for (const child of grants.values()) {
    if (!child.parentGrantId) continue;
    const root = grants.get(child.parentGrantId);
    if (
      !root?.entitlementMonths ||
      root.ownerId !== child.ownerId ||
      root.plan !== child.plan ||
      grantScope(root) !== 'organizer' ||
      grantScope(child) !== 'organizer' ||
      child.entitlementMonths ||
      !Number.isInteger(child.windowIndex) ||
      child.windowIndex! < 0 ||
      child.windowIndex! >= root.entitlementMonths ||
      child.id !==
        billingId(
          namespace,
          'grant-window',
          root.id + ':' + child.windowIndex,
        ) ||
      child.createdAt !== addMonths(root.createdAt, child.windowIndex!) ||
      Date.parse(child.expiresAt) !==
        Math.min(
          Date.parse(root.expiresAt),
          Date.parse(addMonths(root.createdAt, child.windowIndex! + 1)),
        ) ||
      child.photos !== root.photos ||
      child.searches !== root.searches ||
      child.deliveryBytes !== root.deliveryBytes ||
      child.storageBytes !== 0
    )
      invalid();
    const refundFraction = Math.max(root.refundFraction, child.refundFraction);
    if (child.held !== root.held || child.refundFraction !== refundFraction) {
      child.held = root.held;
      child.refundFraction = refundFraction;
      child.observedAt = root.observedAt;
      await tx.put(child.id, ownerKey, 'grant', child);
    }
  }
  return [...grants.values()];
}
