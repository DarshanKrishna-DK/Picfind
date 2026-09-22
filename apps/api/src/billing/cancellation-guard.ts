import { randomUUID } from 'node:crypto';
import { ApiError } from '../auth.js';
import type { BillingAccount } from './model.js';
import type { PlanQuote } from './plan-quotes.js';
import type { BillingService } from './service.js';

type Billing = Pick<BillingService, 'store' | 'key' | 'namespace'>;

export function assertCancellationResolved(
  account: BillingAccount,
  subscriptionId?: string,
) {
  const pending = account.pendingSubscriptionCancellations ?? {};
  if (subscriptionId ? pending[subscriptionId] : Object.keys(pending).length)
    throw new ApiError(
      409,
      'SUBSCRIPTION_CANCELLATION_PENDING',
      'Cancellation is still unresolved. Retry cancellation in Billing before changing plans or deleting your account.',
    );
}

/** Persist before provider I/O. An uncertain provider response must not release this guard. */
export async function beginSubscriptionCancellation(
  billing: Billing,
  owner: string,
  subscriptionId: string,
) {
  return billing.store.transaction(async (tx) => {
    const key = billing.key('account', owner);
    const account = await tx.get<BillingAccount>(key);
    if (
      !account ||
      account.ownerId !== owner ||
      account.subscriptions[subscriptionId]?.id !== subscriptionId
    )
      throw new ApiError(
        404,
        'NOT_FOUND',
        'This subscription is not available.',
      );
    const quote = await tx.get<PlanQuote>(
      billing.key('plan-quote', `${owner}:${subscriptionId}`),
    );
    if (
      quote &&
      (quote.ownerId !== owner ||
        quote.subscriptionId !== subscriptionId ||
        !['quoted', 'approved', 'completed', 'cancelled', 'discarded'].includes(
          quote.status,
        ))
    )
      throw new ApiError(
        409,
        'PLAN_CHANGE_CONFLICT',
        'A plan change needs reconciliation before cancellation can start.',
      );
    const pending = (account.pendingSubscriptionCancellations ??= {});
    const intentId = (pending[subscriptionId] ??= randomUUID());
    account.revision++;
    await tx.put(key, `${billing.namespace}:${owner}`, 'account', account);
    return intentId;
  });
}

/** Call only after the provider-confirmed subscription has been durably applied. */
export async function finishSubscriptionCancellation(
  billing: Billing,
  owner: string,
  subscriptionId: string,
  intentId: string,
) {
  return billing.store.transaction(async (tx) => {
    const key = billing.key('account', owner);
    const account = await tx.get<BillingAccount>(key);
    const subscription = account?.subscriptions[subscriptionId];
    if (
      !account ||
      account.ownerId !== owner ||
      !subscription ||
      account.pendingSubscriptionCancellations?.[subscriptionId] !== intentId ||
      (!subscription.cancelAtPeriodEnd &&
        !['cancelled', 'expired', 'failed'].includes(subscription.status))
    )
      throw new ApiError(
        409,
        'SUBSCRIPTION_CANCELLATION_PENDING',
        'Refresh billing and retry cancellation to confirm its final state.',
      );
    delete account.pendingSubscriptionCancellations[subscriptionId];
    account.revision++;
    await tx.put(key, `${billing.namespace}:${owner}`, 'account', account);
  });
}
