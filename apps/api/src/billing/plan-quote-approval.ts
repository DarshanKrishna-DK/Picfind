import { randomUUID } from 'node:crypto';
import { assertCancellationResolved } from './cancellation-guard.js';
import { ApiError } from '../auth.js';
import type { BillingAccount, BillingOrder } from './model.js';
import type { PlanQuote } from './plan-quotes.js';
import type { BillingService } from './service.js';

type ApprovalBilling = Pick<
  BillingService,
  'store' | 'key' | 'namespace' | 'products' | 'roleCatalogEnabled'
>;

export interface QuoteApproval {
  version: 1;
  id: string;
  quote: PlanQuote;
  approvedAt: string;
}

const unavailable = () =>
  new ApiError(
    409,
    'PLAN_QUOTE_CHANGED',
    'This quote is no longer available. Refresh billing before confirming.',
  );

/** Internal only: records consent, not a provider attempt or an entitlement. */
export async function approvePlanQuote(
  billing: ApprovalBilling,
  owner: string,
  subscriptionId: string,
  quoteId: string,
) {
  return billing.store.transaction(async (tx) => {
    const accountKey = billing.key('account', owner);
    const quoteKey = billing.key('plan-quote', `${owner}:${subscriptionId}`);
    const approvalKey = billing.key('quote-approval', `${owner}:${quoteId}`);
    const account = await tx.get<BillingAccount>(accountKey);
    const quote = await tx.get<PlanQuote>(quoteKey);
    if (
      !account ||
      account.ownerId !== owner ||
      !quote ||
      quote.version !== 1 ||
      quote.ownerId !== owner ||
      quote.subscriptionId !== subscriptionId ||
      quote.id !== quoteId ||
      account.deletionPendingAt
    )
      throw unavailable();

    assertCancellationResolved(account, subscriptionId);
    const previous = await tx.get<QuoteApproval>(approvalKey);
    if (previous) {
      if (
        previous.version !== 1 ||
        quote.status !== 'approved' ||
        JSON.stringify({ ...quote, status: 'quoted' }) !==
          JSON.stringify(previous.quote)
      )
        throw unavailable();
      return { approvalId: previous.id, quoteId, status: 'approved' as const };
    }

    const sub = account.subscriptions[subscriptionId];
    const order = await tx.get<BillingOrder>(quote.orderId);
    const expires = Date.parse(quote.expiresAt);
    const effective = Date.parse(quote.effectiveAt);
    if (
      quote.status !== 'quoted' ||
      !Number.isFinite(expires) ||
      expires <= Date.now() ||
      !Number.isFinite(effective) ||
      effective <= Date.now() + 60_000 ||
      !Number.isSafeInteger(quote.recurringBeforeTax) ||
      quote.recurringBeforeTax < 0 ||
      !sub ||
      sub.id !== subscriptionId ||
      sub.status !== 'active' ||
      sub.cancelAtPeriodEnd ||
      sub.orderId !== quote.orderId ||
      sub.customerId !== quote.customerId ||
      account.customerId !== quote.customerId ||
      sub.productId !== quote.sourceProductId ||
      sub.nextBillingAt !== quote.effectiveAt ||
      !order ||
      order.id !== quote.orderId ||
      order.ownerId !== owner ||
      order.customerId !== quote.customerId ||
      order.currency !== quote.currency ||
      !quote.targetProductId ||
      quote.targetProductId === quote.sourceProductId ||
      billing.products[`${quote.targetPlan}:${quote.currency}`] !==
        quote.targetProductId ||
      (quote.targetPlan.startsWith('organizer-') && !billing.roleCatalogEnabled)
    )
      throw unavailable();

    const approval: QuoteApproval = {
      version: 1,
      id: randomUUID(),
      quote: structuredClone(quote),
      approvedAt: new Date().toISOString(),
    };
    account.revision++;
    const ownerKey = `${billing.namespace}:${owner}`;
    await tx.put(accountKey, ownerKey, 'account', account);
    await tx.put(approvalKey, ownerKey, 'event', approval);
    await tx.put(quoteKey, ownerKey, 'event', { ...quote, status: 'approved' });
    return { approvalId: approval.id, quoteId, status: 'approved' as const };
  });
}
