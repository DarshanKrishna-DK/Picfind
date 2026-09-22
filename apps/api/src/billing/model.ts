import { createHash } from 'node:crypto';
import {
  LEGACY_PHOTO_PLANS,
  PHOTO_PLANS,
} from '../../../../packages/shared/src/plans.js';

export const LEGACY_PLAN_IDS = ['photo-pack', 'creator', 'studio'] as const;
export const PERSONAL_PLAN_IDS = [
  'personal-250',
  'personal-500',
  'personal-1000',
] as const;
export const ORGANIZER_PLAN_IDS = [
  'organizer-starter-monthly',
  'organizer-starter-yearly',
  'organizer-pro-monthly',
  'organizer-pro-yearly',
  'organizer-scale-monthly',
  'organizer-scale-yearly',
] as const;
export const PAID_PLAN_IDS = [
  ...LEGACY_PLAN_IDS,
  ...PERSONAL_PLAN_IDS,
  ...ORGANIZER_PLAN_IDS,
] as const;
export type PlanId = (typeof PAID_PLAN_IDS)[number];
export type SubscriptionPlanId =
  'creator' | 'studio' | (typeof ORGANIZER_PLAN_IDS)[number];
export type BillingScope = 'legacy' | 'personal' | 'organizer';
export type Currency = 'INR' | 'USD';
export type BillingKind = 'account' | 'order' | 'grant' | 'event';
export interface BillingTransaction {
  get<T>(id: string): Promise<T | null>;
  list<T>(ownerId: string, kind: BillingKind): Promise<T[]>;
  put<T>(
    id: string,
    ownerId: string,
    kind: BillingKind,
    value: T,
  ): Promise<void>;
}
export interface BillingStore {
  transaction<T>(work: (tx: BillingTransaction) => Promise<T>): Promise<T>;
  accountPage?(after?: string): Promise<{
    items: { id: string; ownerKey: string }[];
    end: boolean;
  }>;
}
export interface BillingAccount {
  ownerId: string;
  pendingSubscriptionCancellations?: Record<string, string>;
  backgroundReconciliation?: {
    nextAttemptAt: string;
    failures: number;
    lastSuccessAt?: string;
    lastFailureAt?: string;
  };
  paymentHistory?: PaymentHistoryCursor;
  storedBytes?: number;
  storedBytesByScope?: Record<BillingScope, number>;
  deletionPendingAt?: string;
  revision: number;
  createdAt: string;
  customerId?: string;
  subscriptions: Record<string, SubscriptionSnapshot>;
}
export interface BillingOrder {
  id: string;
  ownerId: string;
  plan: PlanId;
  currency: Currency;
  productId: string;
  createdAt: string;
  customerId?: string;
  sessionId?: string;
  checkoutUrl?: string;
  fulfilled?: boolean;
  closedAt?: string;
  paymentStatus?: string;
  lastCheckedAt?: string;
}
export interface StorageReservation {
  scope?: BillingScope;
  ownerId: string;
  photoId: string;
  bytes: number;
  status: 'reserved' | 'released';
  createdAt: string;
}
export interface Grant {
  id: string;
  ownerId: string;
  plan: PlanId | 'preview';
  /** Absent on historical records, which retain the original mixed contract. */
  scope?: BillingScope;
  retentionDays?: number;
  liveEvents?: number;
  /** Paid entitlement roots do not themselves expose processing credits. */
  entitlementMonths?: 1 | 12;
  parentGrantId?: string;
  windowIndex?: number;
  paymentId?: string;
  subscriptionId?: string;
  paymentBasis?: {
    orderId: string;
    productId: string;
    customerId: string;
    currency: string;
    total: number;
  };
  createdAt: string;
  expiresAt: string;
  photos: number;
  searches: number;
  deliveryBytes: number;
  storageBytes: number;
  usedPhotos: number;
  usedSearches: number;
  usedDeliveryBytes: number;
  refundFraction: number;
  held: boolean;
  observedAt: string;
}
export interface SubscriptionSnapshot {
  id: string;
  orderId: string;
  customerId: string;
  productId: string;
  status: string;
  nextBillingAt: string;
  cancelAtPeriodEnd: boolean;
  observedAt: string;
}
export interface PaymentSnapshot {
  id: string;
  orderId: string;
  customerId: string;
  productId: string;
  quantity: number;
  currency: string;
  status: string;
  total: number;
  refunded: number;
  held: boolean;
  createdAt: string;
  observedAt: string;
  setupOnly: boolean;
  sessionId?: string;
  subscription?: SubscriptionSnapshot;
}
export interface VerifiedBillingEvent {
  id: string;
  type: string;
  payment?: PaymentSnapshot;
  subscription?: SubscriptionSnapshot;
}
export const BILLING_HISTORY_PAGE_SIZE = 5;
export interface PaymentHistoryCursor {
  runId: string;
  status: 'running' | 'complete';
  page: number;
  checkedPayments: number;
  startedAt: string;
  through: string;
  updatedAt: string;
  completedAt?: string;
  lastFingerprint?: string;
}
export interface BillingHistoryPage {
  items: {
    id: string;
    orderId?: string;
    subscriptionId?: string;
    environment?: string;
  }[];
  hasMore: boolean;
}
export interface BillingProvider {
  cancelScheduledPlanChange?(
    request: PlanCancellationRequest,
  ): Promise<ConfirmedPlanCancellation>;
  inspectScheduledPlanCancellation?(
    request: PlanCancellationRequest,
  ): Promise<ConfirmedPlanCancellation>;
  schedulePlanChange?(
    request: ApprovedPlanChangeRequest,
  ): Promise<ConfirmedPlanChangeSchedule>;
  inspectPlanChange?(
    request: ApprovedPlanChangeRequest,
  ): Promise<ConfirmedPlanChangeSchedule>;
  previewPlanChange?(
    subscription: SubscriptionSnapshot,
    productId: string,
    currency: Currency,
    interval?: 'Month' | 'Year',
  ): Promise<PlanChangePrice>;
  listPayments?(
    customerId: string,
    page: number,
    through: string,
  ): Promise<BillingHistoryPage>;
  readPayment?(id: string): Promise<PaymentSnapshot>;
  checkout(
    order: BillingOrder,
    customer: { email: string; name: string },
  ): Promise<{ sessionId: string; url: string }>;
  portal(customerId: string): Promise<string>;
  inspectCheckout?(order: BillingOrder): Promise<VerifiedBillingEvent | null>;
  readSubscription?(id: string): Promise<SubscriptionSnapshot>;
  cancelSubscription?(
    id: string,
    immediately: boolean,
  ): Promise<SubscriptionSnapshot>;
  verify(
    raw: string,
    headers: Record<string, string>,
  ): Promise<VerifiedBillingEvent>;
}
export type ProductMap = Partial<Record<`${PlanId}:${Currency}`, string>>;
export interface PlanChangePrice {
  currency: Currency;
  chargeNow: number;
  recurringBeforeTax: number;
  effectiveAt: string;
}
export interface ApprovedPlanChangeRequest {
  requestId: string;
  subscription: SubscriptionSnapshot;
  productId: string;
  currency: Currency;
  interval: 'Month' | 'Year';
  recurringBeforeTax: number;
}
export interface PlanCancellationRequest {
  requestId: string;
  scheduleId: string;
  change: ApprovedPlanChangeRequest;
}
export interface ConfirmedPlanCancellation {
  subscriptionId: string;
  scheduleId: string;
  cancelled: true;
}
export interface ConfirmedPlanChangeSchedule {
  id: string;
  subscriptionId: string;
  orderId: string;
  customerId: string;
  productId: string;
  currency: Currency;
  quantity: 1;
  effectiveAt: string;
}
export function billingId(namespace: string, kind: string, value: string) {
  return createHash('sha256')
    .update(`${namespace}:${kind}:${value}`)
    .digest('hex')
    .slice(0, 36);
}
export function planById(id: Grant['plan']) {
  const plan =
    LEGACY_PHOTO_PLANS.find((entry) => entry.id === id) ??
    PHOTO_PLANS.find((entry) => entry.id === id);
  if (!plan) throw new Error('Unknown billing plan.');
  return plan;
}
export function isLegacyPlan(id: Grant['plan']) {
  return LEGACY_PLAN_IDS.some((plan) => plan === id);
}
export function isSubscriptionPlan(id: PlanId): id is SubscriptionPlanId {
  return (
    id === 'creator' ||
    id === 'studio' ||
    ORGANIZER_PLAN_IDS.some((plan) => plan === id)
  );
}
export function grantScope(grant: Pick<Grant, 'plan' | 'scope'>): BillingScope {
  return (
    grant.scope ??
    (grant.plan === 'preview' ||
    PERSONAL_PLAN_IDS.some((id) => id === grant.plan)
      ? 'personal'
      : ORGANIZER_PLAN_IDS.some((id) => id === grant.plan)
        ? 'organizer'
        : 'legacy')
  );
}
export function scopeAllows(grant: Grant, scope: BillingScope) {
  if (!['legacy', 'personal', 'organizer'].includes(scope))
    throw new Error('Unknown billing scope.');
  const actual = grantScope(grant);
  return (
    actual === scope ||
    actual === 'legacy' ||
    (scope === 'legacy' && grant.plan === 'preview')
  );
}
export function addMonths(iso: string, count: number) {
  const date = new Date(iso);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + count);
  const last = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString();
}
export function newGrant(
  id: string,
  ownerId: string,
  planId: Grant['plan'],
  createdAt: string,
): Grant {
  const plan = planById(planId);
  return {
    id,
    ownerId,
    plan: planId,
    scope: grantScope({ plan: planId }),
    retentionDays: plan.retentionDays,
    ...('liveEvents' in plan ? { liveEvents: plan.liveEvents } : {}),
    ...(ORGANIZER_PLAN_IDS.some((id) => id === planId)
      ? { entitlementMonths: (plan.cadence === 'year' ? 12 : 1) as 1 | 12 }
      : {}),
    createdAt,
    expiresAt:
      planId === 'preview'
        ? new Date(Date.parse(createdAt) + 7 * 86400000).toISOString()
        : addMonths(createdAt, plan.cadence === 'month' ? 1 : 12),
    photos: plan.photos,
    searches: plan.searches,
    storageBytes: Math.round(plan.storageGb * 1e9),
    deliveryBytes: Math.round(plan.deliveryGb * 1e9),
    usedPhotos: 0,
    usedSearches: 0,
    usedDeliveryBytes: 0,
    refundFraction: 0,
    held: false,
    observedAt: createdAt,
  };
}
export function remaining(
  grant: Grant,
  kind: 'index' | 'search' | 'delivery',
  now = Date.now(),
) {
  if (
    grant.held ||
    grant.entitlementMonths ||
    !Number.isFinite(Date.parse(grant.createdAt)) ||
    !Number.isFinite(Date.parse(grant.expiresAt)) ||
    Date.parse(grant.createdAt) > now ||
    Date.parse(grant.expiresAt) <= now
  )
    return 0;
  const [total, used] =
    kind === 'index'
      ? [grant.photos, grant.usedPhotos]
      : kind === 'search'
        ? [grant.searches, grant.usedSearches]
        : [grant.deliveryBytes, grant.usedDeliveryBytes];
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(used) ||
    used < 0 ||
    !Number.isFinite(grant.refundFraction) ||
    grant.refundFraction < 0 ||
    grant.refundFraction > 1
  )
    return 0;
  return Math.max(0, Math.floor(total * (1 - grant.refundFraction)) - used);
}
