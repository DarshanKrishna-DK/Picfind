import { ApiError } from '../auth.js';
import { assertCancellationResolved } from './cancellation-guard.js';
import { withAccountLock } from '../locks.js';
import type {
  BillingAccount,
  BillingOrder,
  SubscriptionSnapshot,
} from './model.js';
import type { BillingService } from './service.js';
import { ORGANIZER_PLAN_IDS, type SubscriptionPlanId } from './model.js';
import { subscriptionPeriod } from './plan-transitions.js';

function sameSubscription(a: SubscriptionSnapshot, b: SubscriptionSnapshot) {
  return (
    a.id === b.id &&
    a.orderId === b.orderId &&
    a.customerId === b.customerId &&
    a.productId === b.productId &&
    a.status === b.status &&
    a.cancelAtPeriodEnd === b.cancelAtPeriodEnd &&
    a.nextBillingAt === b.nextBillingAt
  );
}
function changed(): never {
  throw new ApiError(
    409,
    'PLAN_PREVIEW_CHANGED',
    'Your subscription changed. Refresh billing and request a new preview.',
  );
}

/** Read-only pricing: does not authorize, schedule or fulfill a plan change. */
export async function previewPlanChange(
  billing: BillingService,
  owner: string,
  subscriptionId: string,
  targetPlan: SubscriptionPlanId,
) {
  return withAccountLock(owner, async () => {
    const organizerTarget = ORGANIZER_PLAN_IDS.some((id) => id === targetPlan);
    if (organizerTarget && !billing.roleCatalogEnabled)
      throw new ApiError(
        503,
        'PLAN_PREVIEW_UNAVAILABLE',
        'Organizer plan previews are not available yet.',
      );
    const provider = billing.provider;
    if (!provider?.readSubscription || !provider.previewPlanChange)
      throw new ApiError(
        503,
        'PLAN_PREVIEW_UNAVAILABLE',
        'Plan previews are not available yet. Your subscription has not changed.',
      );
    const snapshot = () =>
      billing.store.transaction(async (tx) => {
        const account = await tx.get<BillingAccount>(
          billing.key('account', owner),
        );
        const subscription = account?.subscriptions[subscriptionId];
        if (
          !account ||
          account.ownerId !== owner ||
          !subscription ||
          subscription.id !== subscriptionId
        )
          throw new ApiError(
            404,
            'NOT_FOUND',
            'This subscription is not available.',
          );
        if (account.deletionPendingAt)
          throw new ApiError(
            409,
            'ACCOUNT_DELETION_PENDING',
            'Finish account deletion rather than changing your plan.',
          );
        assertCancellationResolved(account, subscriptionId);
        const orders = await tx.list<BillingOrder>(
          `${billing.namespace}:${owner}`,
          'order',
        );
        const order = orders.find(
          (value) =>
            value.id === subscription.orderId && value.ownerId === owner,
        );
        if (
          !order ||
          !account.customerId ||
          account.customerId !== subscription.customerId ||
          order.customerId !== account.customerId ||
          !['creator', 'studio', ...ORGANIZER_PLAN_IDS].includes(order.plan)
        )
          throw new ApiError(
            503,
            'PLAN_PREVIEW_UNAVAILABLE',
            'Saved billing details need reconciliation before a preview.',
          );
        const period = await subscriptionPeriod(
          tx,
          billing.namespace,
          order,
          subscription,
          subscription.observedAt,
        );
        if (period.productId !== subscription.productId)
          throw new ApiError(
            503,
            'PLAN_PREVIEW_UNAVAILABLE',
            'Saved billing details need reconciliation before a preview.',
          );
        const organizerSource = ORGANIZER_PLAN_IDS.some(
          (id) => id === period.plan,
        );
        if (
          organizerSource !== organizerTarget ||
          (organizerSource && !billing.roleCatalogEnabled)
        )
          throw new ApiError(
            409,
            'PLAN_NOT_CHANGEABLE',
            'Preview a plan from your existing subscription catalog. Legacy migration is not enabled.',
          );
        if (period.plan === targetPlan)
          throw new ApiError(
            409,
            'PLAN_ALREADY_SELECTED',
            'You already have this plan.',
          );
        if (subscription.status !== 'active' || subscription.cancelAtPeriodEnd)
          throw new ApiError(
            409,
            'PLAN_NOT_CHANGEABLE',
            'Only an active subscription with renewal enabled can be previewed.',
          );
        const next = Date.parse(subscription.nextBillingAt);
        if (!Number.isFinite(next) || next <= Date.now() + 60_000)
          throw new ApiError(
            409,
            'PLAN_RENEWAL_NEAR',
            'A renewal is due or in progress. Check payment status before requesting a preview.',
          );
        const productId = billing.products[`${targetPlan}:${order.currency}`];
        if (!productId || productId === period.productId)
          throw new ApiError(
            503,
            'PLAN_PREVIEW_UNAVAILABLE',
            'That plan is not configured in your subscription currency.',
          );
        return { subscription, order, productId };
      });
    const saved = await snapshot();
    const current = await provider.readSubscription(subscriptionId);
    if (!sameSubscription(saved.subscription, current)) changed();
    const price = await provider.previewPlanChange(
      current,
      saved.productId,
      saved.order.currency,
      targetPlan.endsWith('-yearly') ? 'Year' : 'Month',
    );
    if (
      price.currency !== saved.order.currency ||
      price.chargeNow !== 0 ||
      !Number.isSafeInteger(price.recurringBeforeTax) ||
      price.recurringBeforeTax < 0 ||
      Date.parse(price.effectiveAt) !== Date.parse(current.nextBillingAt)
    )
      throw new ApiError(
        503,
        'PLAN_PREVIEW_UNAVAILABLE',
        'The provider could not confirm a no-charge renewal preview. Your subscription has not changed.',
      );
    const final = await snapshot();
    if (
      !sameSubscription(final.subscription, saved.subscription) ||
      final.productId !== saved.productId ||
      final.order.currency !== saved.order.currency
    )
      changed();
    return {
      subscriptionId,
      targetPlan,
      ...price,
      expiresAt: new Date(
        Math.min(Date.now() + 5 * 60_000, Date.parse(price.effectiveAt)),
      ).toISOString(),
      previewOnly: true as const,
    };
  });
}
