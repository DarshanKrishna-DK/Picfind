import { randomUUID } from 'node:crypto';
import { assertCancellationResolved } from './cancellation-guard.js';
import { ApiError } from '../auth.js';
import { previewPlanChange } from './plan-preview.js';
import type { BillingAccount, SubscriptionPlanId } from './model.js';
import type { BillingService } from './service.js';

export interface PlanQuote {
  version: 1;
  id: string;
  ownerId: string;
  subscriptionId: string;
  orderId: string;
  customerId: string;
  sourceProductId: string;
  targetProductId: string;
  targetPlan: SubscriptionPlanId;
  currency: 'INR' | 'USD';
  recurringBeforeTax: number;
  effectiveAt: string;
  expiresAt: string;
  status:
    | 'quoted'
    | 'approved'
    | 'submitting'
    | 'scheduled'
    | 'cancelling'
    | 'completed'
    | 'cancelled'
    | 'discarded';
}
const changed = () =>
  new ApiError(
    409,
    'PLAN_QUOTE_CHANGED',
    'Billing changed while preparing this quote. Refresh billing and try again.',
  );

/** One replaceable quote slot per owned subscription; this is not purchase authorization. */
export async function createPlanQuote(
  billing: BillingService,
  owner: string,
  subscriptionId: string,
  targetPlan: SubscriptionPlanId,
) {
  const accountKey = billing.key('account', owner);
  const before = await billing.store.transaction(async (tx) => {
    const account = await tx.get<BillingAccount>(accountKey);
    const sub = account?.subscriptions[subscriptionId];
    if (
      !account ||
      account.ownerId !== owner ||
      !sub ||
      sub.id !== subscriptionId
    )
      throw new ApiError(
        404,
        'NOT_FOUND',
        'This subscription is not available.',
      );
    if (account.deletionPendingAt) throw changed();
    assertCancellationResolved(account, subscriptionId);
    return structuredClone(sub);
  });
  const products = { ...billing.products };
  const price = await previewPlanChange(
    billing,
    owner,
    subscriptionId,
    targetPlan,
  );
  const productId = products[`${targetPlan}:${price.currency}`];
  return billing.store.transaction(async (tx) => {
    const account = await tx.get<BillingAccount>(accountKey);
    const current = account?.subscriptions[subscriptionId];
    if (
      !account ||
      account.ownerId !== owner ||
      account.deletionPendingAt ||
      !current ||
      JSON.stringify(current) !== JSON.stringify(before) ||
      account.customerId !== before.customerId ||
      !productId ||
      billing.products[`${targetPlan}:${price.currency}`] !== productId ||
      Date.parse(price.expiresAt) <= Date.now() ||
      Date.parse(price.effectiveAt) <= Date.now() + 60_000
    )
      throw changed();
    assertCancellationResolved(account, subscriptionId);
    const key = billing.key('plan-quote', `${owner}:${subscriptionId}`);
    const previous = await tx.get<PlanQuote>(key);
    if (
      previous &&
      (previous.version !== 1 ||
        previous.ownerId !== owner ||
        previous.subscriptionId !== subscriptionId ||
        !['quoted', 'completed', 'cancelled', 'discarded'].includes(
          previous.status,
        ))
    )
      throw changed();
    const quote: PlanQuote = {
      version: 1,
      id: randomUUID(),
      ownerId: owner,
      subscriptionId,
      orderId: before.orderId,
      customerId: before.customerId,
      sourceProductId: before.productId,
      targetProductId: productId,
      targetPlan,
      currency: price.currency,
      recurringBeforeTax: price.recurringBeforeTax,
      effectiveAt: price.effectiveAt,
      expiresAt: price.expiresAt,
      status: 'quoted',
    };
    account.revision++;
    await tx.put(
      accountKey,
      `${billing.namespace}:${owner}`,
      'account',
      account,
    );
    await tx.put(key, `${billing.namespace}:${owner}`, 'event', quote);
    return { ...price, quoteId: quote.id };
  });
}
