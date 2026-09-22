import { z } from 'zod';
import { ApiError } from '../auth.js';
import {
  billingId,
  ORGANIZER_PLAN_IDS,
  isSubscriptionPlan,
  type SubscriptionPlanId,
  type BillingAccount,
  type BillingOrder,
  type BillingTransaction,
  type SubscriptionSnapshot,
} from './model.js';
import type { BillingService } from './service.js';
import type { PlanQuote } from './plan-quotes.js';

type Namespace = 'test_mode' | 'live_mode';
type MonthlyPlan = SubscriptionPlanId;
interface Binding {
  version: 1;
  ownerId: string;
  orderId: string;
  customerId: string;
  subscriptionId: string;
}
interface Period {
  plan: MonthlyPlan;
  productId: string;
  effectiveAt: string;
}
interface History extends Binding {
  page: number;
  pendingId?: string;
}
interface PeriodPage extends Binding {
  page: number;
  periods: Period[];
}
interface Approval extends Binding, Period {
  id: string;
  quoteId: string;
  sourceProductId: string;
  approvedAt: string;
  providerScheduleId: string;
  status: 'scheduled' | 'applied' | 'cancelled';
}
const identifier = z.string().min(1).max(100);
const date = z.iso.datetime({ offset: true });
const approvalSchema = z
  .object({
    id: z.uuid(),
    quoteId: z.uuid(),
    subscriptionId: identifier,
    sourceProductId: identifier,
    targetPlan: z.enum(['creator', 'studio', ...ORGANIZER_PLAN_IDS]),
    effectiveAt: date,
    approvedAt: date,
  })
  .strict();
export const scheduleSchema = z
  .object({
    id: identifier,
    subscriptionId: identifier,
    orderId: identifier,
    customerId: identifier,
    productId: identifier,
    currency: z.enum(['INR', 'USD']),
    quantity: z.literal(1),
    effectiveAt: date,
  })
  .strict();
export type PlanApprovalInput = z.infer<typeof approvalSchema>;
export type ConfirmedPlanSchedule = z.infer<typeof scheduleSchema>;

function mismatch(): never {
  throw new ApiError(
    400,
    'BILLING_MISMATCH',
    'The billing product does not match an approved subscription period.',
  );
}
function conflict(): never {
  throw new ApiError(
    409,
    'PLAN_CHANGE_CONFLICT',
    'This plan change needs reconciliation before another change can be accepted.',
  );
}
function timestamp(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) mismatch();
  return parsed;
}
function binding(order: BillingOrder, sub: SubscriptionSnapshot): Binding {
  if (
    !isSubscriptionPlan(order.plan) ||
    sub.orderId !== order.id ||
    (order.customerId && order.customerId !== sub.customerId)
  )
    mismatch();
  return {
    version: 1,
    ownerId: order.ownerId,
    orderId: order.id,
    customerId: sub.customerId,
    subscriptionId: sub.id,
  };
}
function assertBinding(actual: Binding, expected: Binding) {
  if (
    actual.version !== 1 ||
    actual.ownerId !== expected.ownerId ||
    actual.orderId !== expected.orderId ||
    actual.customerId !== expected.customerId ||
    actual.subscriptionId !== expected.subscriptionId
  )
    mismatch();
}
function historyKey(namespace: Namespace, subscriptionId: string) {
  return billingId(namespace, 'plan-history', subscriptionId);
}
function pageKey(namespace: Namespace, subscriptionId: string, page: number) {
  return billingId(namespace, 'plan-periods', `${subscriptionId}:${page}`);
}
function approvalKey(namespace: Namespace, owner: string, id: string) {
  return billingId(namespace, 'plan-approval', `${owner}:${id}`);
}
async function history(
  tx: BillingTransaction,
  namespace: Namespace,
  expected: Binding,
) {
  const saved = await tx.get<History>(
    historyKey(namespace, expected.subscriptionId),
  );
  if (saved) {
    assertBinding(saved, expected);
    if (!Number.isSafeInteger(saved.page) || saved.page < 0) mismatch();
  }
  return saved;
}
async function readPage(
  tx: BillingTransaction,
  namespace: Namespace,
  expected: Binding,
  page: number,
) {
  const saved = await tx.get<PeriodPage>(
    pageKey(namespace, expected.subscriptionId, page),
  );
  if (!saved) mismatch();
  assertBinding(saved, expected);
  if (
    saved.page !== page ||
    !Array.isArray(saved.periods) ||
    !saved.periods.length ||
    saved.periods.length > 32
  )
    mismatch();
  let previous = -Infinity;
  for (const period of saved.periods) {
    if (
      !isSubscriptionPlan(period.plan) ||
      !period.productId ||
      timestamp(period.effectiveAt) <= previous
    )
      mismatch();
    previous = timestamp(period.effectiveAt);
  }
  return saved;
}

/** Resolve historical periods, not today's product map. Pages keep rows bounded. */
export async function subscriptionPeriod(
  tx: BillingTransaction,
  namespace: Namespace,
  order: BillingOrder,
  sub: SubscriptionSnapshot,
  at: string,
): Promise<Period> {
  const expected = binding(order, sub);
  const saved = await history(tx, namespace, expected);
  const time = timestamp(at);
  if (saved) {
    let newerStart = Infinity;
    // Bound a corrupt or pathological history without scanning all account events.
    for (let page = saved.page, reads = 0; page >= 0; page--, reads++) {
      if (reads >= 128) mismatch();
      const current = await readPage(tx, namespace, expected, page);
      if (timestamp(current.periods.at(-1)!.effectiveAt) >= newerStart)
        mismatch();
      const found = [...current.periods]
        .reverse()
        .find((period) => timestamp(period.effectiveAt) <= time);
      if (found) return found;
      newerStart = timestamp(current.periods[0]!.effectiveAt);
    }
  }
  return {
    plan: order.plan as MonthlyPlan,
    productId: order.productId,
    effectiveAt: order.createdAt,
  };
}

/**
 * Internal scheduling boundary, NOT an HTTP endpoint. The future confirmation
 * workflow must supply a persisted owner-approved quote and an authoritative
 * provider schedule. This does not call Dodo, change a subscription or grant usage.
 */
export async function recordScheduledPlanChange(
  billing: BillingService,
  owner: string,
  input: PlanApprovalInput,
  confirmation: ConfirmedPlanSchedule,
) {
  const parsed = approvalSchema.safeParse(input);
  const verified = scheduleSchema.safeParse(confirmation);
  if (!parsed.success || !verified.success) conflict();
  const approval = parsed.data;
  const schedule = verified.data;
  return billing.store.transaction(async (tx) => {
    const accountKey = billing.key('account', owner);
    const account = await tx.get<BillingAccount>(accountKey);
    const sub = account?.subscriptions[approval.subscriptionId];
    const order = (
      await tx.list<BillingOrder>(`${billing.namespace}:${owner}`, 'order')
    ).find((value) => value.ownerId === owner && value.id === sub?.orderId);
    if (
      !account ||
      account.ownerId !== owner ||
      !sub ||
      !order ||
      !isSubscriptionPlan(order.plan) ||
      !account.customerId
    )
      conflict();
    const organizerSource = ORGANIZER_PLAN_IDS.some((id) => id === order.plan);
    const organizerTarget = ORGANIZER_PLAN_IDS.some(
      (id) => id === approval.targetPlan,
    );
    if (
      organizerSource !== organizerTarget ||
      (organizerSource && !billing.roleCatalogEnabled)
    )
      conflict();
    if (account.deletionPendingAt)
      throw new ApiError(
        409,
        'ACCOUNT_DELETION_PENDING',
        'Plan changes are disabled while account deletion is pending.',
      );
    const expected = binding(order, sub);
    const productId =
      billing.products[`${approval.targetPlan}:${order.currency}`];
    if (
      schedule.subscriptionId !== sub.id ||
      schedule.orderId !== order.id ||
      schedule.customerId !== account.customerId ||
      sub.customerId !== account.customerId ||
      schedule.currency !== order.currency ||
      schedule.productId !== productId ||
      timestamp(schedule.effectiveAt) !== timestamp(approval.effectiveAt) ||
      timestamp(approval.approvedAt) > Date.now() ||
      timestamp(approval.approvedAt) >= timestamp(approval.effectiveAt) ||
      !productId ||
      productId === approval.sourceProductId
    )
      conflict();
    const key = approvalKey(billing.namespace, owner, approval.id);
    const record: Approval = {
      ...expected,
      id: approval.id,
      quoteId: approval.quoteId,
      sourceProductId: approval.sourceProductId,
      productId,
      plan: approval.targetPlan,
      effectiveAt: new Date(approval.effectiveAt).toISOString(),
      approvedAt: new Date(approval.approvedAt).toISOString(),
      providerScheduleId: schedule.id,
      status: 'scheduled',
    };
    const existing = await tx.get<Approval>(key);
    if (existing) {
      if (
        JSON.stringify({ ...existing, status: 'scheduled' }) !==
        JSON.stringify(record)
      )
        conflict();
      return { status: existing.status };
    }
    if (
      sub.status !== 'active' ||
      sub.cancelAtPeriodEnd ||
      sub.productId !== approval.sourceProductId ||
      timestamp(sub.nextBillingAt) !== timestamp(approval.effectiveAt)
    )
      conflict();
    const current = await subscriptionPeriod(
      tx,
      billing.namespace,
      order,
      sub,
      sub.observedAt,
    );
    if (
      current.productId !== approval.sourceProductId ||
      current.plan === approval.targetPlan
    )
      conflict();
    const saved = await history(tx, billing.namespace, expected);
    if (saved?.pendingId) conflict();
    // Start with an empty history page only when the first change actually applies.
    const next = {
      ...expected,
      page: saved?.page ?? 0,
      pendingId: approval.id,
    };
    // A separate head distinguishes pending-only history from applied periods.
    if (!saved)
      await tx.put(
        pageKey(billing.namespace, sub.id, 0),
        `${billing.namespace}:${owner}`,
        'event',
        {
          ...expected,
          page: 0,
          periods: [
            {
              plan: order.plan as MonthlyPlan,
              productId: order.productId,
              effectiveAt: order.createdAt,
            },
          ],
        } satisfies PeriodPage,
      );
    account.revision++;
    await tx.put(
      accountKey,
      `${billing.namespace}:${owner}`,
      'account',
      account,
    );
    await tx.put(key, `${billing.namespace}:${owner}`, 'event', record);
    await tx.put(
      historyKey(billing.namespace, sub.id),
      `${billing.namespace}:${owner}`,
      'event',
      next,
    );
    return { status: record.status };
  });
}

async function settleQuote(
  tx: BillingTransaction,
  namespace: Namespace,
  approval: Approval,
  status: 'completed' | 'cancelled',
) {
  const key = billingId(
    namespace,
    'plan-quote',
    `${approval.ownerId}:${approval.subscriptionId}`,
  );
  const quote = await tx.get<PlanQuote>(key);
  // Historical schedules may predate quotes; never overwrite a newer quote slot.
  if (!quote || quote.id !== approval.quoteId) return;
  if (
    quote.version !== 1 ||
    quote.ownerId !== approval.ownerId ||
    quote.subscriptionId !== approval.subscriptionId ||
    quote.orderId !== approval.orderId ||
    quote.customerId !== approval.customerId ||
    quote.targetProductId !== approval.productId ||
    quote.targetPlan !== approval.plan
  )
    mismatch();
  if (!['submitting', 'scheduled', 'cancelling'].includes(quote.status)) return;
  await tx.put(key, `${namespace}:${approval.ownerId}`, 'event', {
    ...quote,
    status,
  });
}

/** Authoritative subscription observations can apply only a saved approved schedule. */
export async function observeSubscriptionPlan(
  tx: BillingTransaction,
  namespace: Namespace,
  order: BillingOrder,
  sub: SubscriptionSnapshot,
) {
  const expected = binding(order, sub);
  const period = await subscriptionPeriod(
    tx,
    namespace,
    order,
    sub,
    sub.observedAt,
  );
  if (period.productId === sub.productId) return period;
  const saved = await history(tx, namespace, expected);
  if (!saved?.pendingId) mismatch();
  const key = approvalKey(namespace, order.ownerId, saved.pendingId);
  const approval = await tx.get<Approval>(key);
  if (!approval) mismatch();
  assertBinding(approval, expected);
  if (
    approval.status !== 'scheduled' ||
    approval.id !== saved.pendingId ||
    approval.sourceProductId !== period.productId ||
    approval.productId !== sub.productId ||
    timestamp(approval.effectiveAt) > timestamp(sub.observedAt)
  )
    mismatch();
  const current = await readPage(tx, namespace, expected, saved.page);
  const latest = current.periods.at(-1)!;
  if (
    latest.productId !== approval.sourceProductId ||
    timestamp(approval.effectiveAt) <= timestamp(latest.effectiveAt)
  )
    mismatch();
  const nextPeriod: Period = {
    plan: approval.plan,
    productId: approval.productId,
    effectiveAt: approval.effectiveAt,
  };
  const nextPage = current.periods.length === 32 ? saved.page + 1 : saved.page;
  const periods =
    nextPage === saved.page ? [...current.periods, nextPeriod] : [nextPeriod];
  const ownerKey = `${namespace}:${order.ownerId}`;
  await tx.put(pageKey(namespace, sub.id, nextPage), ownerKey, 'event', {
    ...expected,
    page: nextPage,
    periods,
  } satisfies PeriodPage);
  await tx.put(historyKey(namespace, sub.id), ownerKey, 'event', {
    ...expected,
    page: nextPage,
  } satisfies History);
  await tx.put(key, ownerKey, 'event', {
    ...approval,
    status: 'applied',
  } satisfies Approval);
  await settleQuote(tx, namespace, approval, 'completed');
  return nextPeriod;
}

/** Only call after the provider has confirmed this specific schedule was cancelled. */
export async function recordCancelledPlanChange(
  billing: BillingService,
  owner: string,
  subscriptionId: string,
  approvalId: string,
  providerScheduleId: string,
) {
  return billing.store.transaction(async (tx) => {
    const account = await tx.get<BillingAccount>(billing.key('account', owner));
    const sub = account?.subscriptions[subscriptionId];
    if (!account || account.ownerId !== owner || !sub) conflict();
    const key = approvalKey(billing.namespace, owner, approvalId);
    const approval = await tx.get<Approval>(key);
    if (
      !approval ||
      approval.ownerId !== owner ||
      approval.subscriptionId !== subscriptionId ||
      approval.orderId !== sub.orderId ||
      approval.customerId !== account.customerId ||
      approval.providerScheduleId !== providerScheduleId ||
      approval.status === 'applied'
    )
      conflict();
    if (approval.status === 'cancelled') return;
    const saved = await history(tx, billing.namespace, approval);
    if (!saved || saved.pendingId !== approvalId) conflict();
    const next = { ...saved };
    delete next.pendingId;
    account.revision++;
    await tx.put(
      billing.key('account', owner),
      `${billing.namespace}:${owner}`,
      'account',
      account,
    );
    await tx.put(
      historyKey(billing.namespace, subscriptionId),
      `${billing.namespace}:${owner}`,
      'event',
      next,
    );
    await tx.put(key, `${billing.namespace}:${owner}`, 'event', {
      ...approval,
      status: 'cancelled',
    } satisfies Approval);
    await settleQuote(tx, billing.namespace, approval, 'cancelled');
  });
}
