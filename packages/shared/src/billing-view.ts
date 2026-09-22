import { PHOTO_PLANS, LEGACY_PHOTO_PLANS, type PlanScope } from './plans.js';

export interface UsageGrant {
  id?: string;
  plan: string;
  scope?: string;
  parentGrantId?: string | null;
  entitlementMonths?: number | null;
  createdAt?: string;
  expiresAt: string;
  held: boolean;
  refundFraction: number;
  usedPhotos: number;
  photosRemaining: number;
}
interface Balance {
  photosRemaining: number;
  searchesRemaining: number;
  deliveryBytesRemaining?: number;
  storageBytesLimit?: number;
}
export interface BillingUsageSummary {
  roleCatalogAvailable?: boolean;
  photosRemaining?: number;
  searchesRemaining?: number;
  deliveryBytesRemaining?: number;
  storageBytesUsed?: number | null;
  storageBytesLimit?: number;
  storageBytesUsedByScope?: Partial<
    Record<PlanScope | 'legacy', number>
  > | null;
  balances?: Partial<Record<PlanScope | 'legacy', Balance>>;
  grants?: UsageGrant[];
}
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const scopeOf = (grant: UsageGrant) =>
  grant.scope ??
  (grant.plan.startsWith('organizer-')
    ? 'organizer'
    : grant.plan.startsWith('personal-') || grant.plan === 'preview'
      ? 'personal'
      : 'legacy');
export function billingUsage(
  summary: BillingUsageSummary | undefined,
  scope: PlanScope,
  now = Date.now(),
) {
  const scoped = summary?.roleCatalogAvailable === true;
  const balance = scoped ? summary.balances?.[scope] : summary;
  const grants = (summary?.grants ?? []).filter(
    (grant) =>
      !grant.held &&
      count(grant.refundFraction) &&
      grant.refundFraction < 1 &&
      Date.parse(grant.expiresAt) > now &&
      (!grant.createdAt || Date.parse(grant.createdAt) <= now),
  );
  const relevant = grants.filter(
    (grant) =>
      !scoped || scopeOf(grant) === scope || scopeOf(grant) === 'legacy',
  );
  const spendable = relevant.filter((grant) => !grant.entitlementMonths);
  const names = [
    ...new Set(
      relevant
        .map(
          (grant) =>
            [...PHOTO_PLANS, ...LEGACY_PHOTO_PLANS].find(
              (plan) => plan.id === grant.plan,
            )?.name,
        )
        .filter((name): name is string => !!name),
    ),
  ];
  const roots = relevant.filter(
    (grant) =>
      scopeOf(grant) === scope &&
      grant.entitlementMonths &&
      !grant.parentGrantId,
  );
  const windows = spendable.filter(
    (grant) => scopeOf(grant) === scope && grant.parentGrantId,
  );
  const stored = scoped
    ? summary.storageBytesUsedByScope?.[scope]
    : summary?.storageBytesUsed;
  return {
    available:
      count(balance?.photosRemaining) && count(balance?.searchesRemaining),
    scoped,
    label:
      names.join(' + ') ||
      (scoped
        ? scope === 'organizer'
          ? 'Organizer allowance'
          : 'Personal allowance'
        : 'Account usage'),
    hasPlan: grants.some(
      (grant) => scopeOf(grant) === scope && grant.plan !== 'preview',
    ),
    photosRemaining: count(balance?.photosRemaining)
      ? balance.photosRemaining
      : 0,
    searchesRemaining: count(balance?.searchesRemaining)
      ? balance.searchesRemaining
      : 0,
    deliveryBytesRemaining: count(balance?.deliveryBytesRemaining)
      ? balance.deliveryBytesRemaining
      : null,
    storageBytesLimit: count(balance?.storageBytesLimit)
      ? balance.storageBytesLimit
      : null,
    storageBytesUsed: count(stored) ? stored : null,
    processed: spendable.reduce(
      (sum, grant) => sum + (count(grant.usedPhotos) ? grant.usedPhotos : 0),
      0,
    ),
    sharedLegacy: scoped && grants.some((grant) => scopeOf(grant) === 'legacy'),
    sharedStorageUsed:
      scoped && count(summary.storageBytesUsedByScope?.legacy)
        ? summary.storageBytesUsedByScope.legacy
        : null,
    windowEndsAt:
      windows
        .map((grant) => grant.expiresAt)
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null,
    paidThrough:
      roots
        .map((grant) => grant.expiresAt)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
  };
}
