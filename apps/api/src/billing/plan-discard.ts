import { ApiError } from '../auth.js';
import type { BillingAccount } from './model.js';
import type { PlanQuote } from './plan-quotes.js';
import type { BillingService } from './service.js';

/** Local metadata only. Shares account/quote transaction fences with submission. */
export async function discardPlanQuote(
  billing: BillingService,
  owner: string,
  subscriptionId: string,
  quoteId: string,
) {
  return billing.store.transaction(async (tx) => {
    const accountKey = billing.key('account', owner);
    const quoteKey = billing.key('plan-quote', `${owner}:${subscriptionId}`);
    const account = await tx.get<BillingAccount>(accountKey);
    const quote = await tx.get<PlanQuote>(quoteKey);
    const attempt = await tx.get(
      billing.key('plan-submission', `${owner}:${quoteId}`),
    );
    const sub = account?.subscriptions[subscriptionId];
    if (
      !account ||
      account.ownerId !== owner ||
      account.deletionPendingAt ||
      !sub ||
      sub.id !== subscriptionId ||
      !quote ||
      quote.version !== 1 ||
      quote.id !== quoteId ||
      quote.ownerId !== owner ||
      quote.subscriptionId !== subscriptionId ||
      quote.customerId !== account.customerId ||
      quote.orderId !== sub.orderId ||
      attempt ||
      !['quoted', 'approved', 'discarded'].includes(quote.status)
    )
      throw new ApiError(
        409,
        'PLAN_QUOTE_NOT_DISCARDABLE',
        'This quote cannot be discarded. Refresh its status; submitted changes require recovery or cancellation.',
      );
    if (quote.status !== 'discarded') {
      account.revision++;
      await tx.put(
        accountKey,
        `${billing.namespace}:${owner}`,
        'account',
        account,
      );
      await tx.put(quoteKey, `${billing.namespace}:${owner}`, 'event', {
        ...quote,
        status: 'discarded',
      });
    }
    return { quoteId, status: 'discarded' as const };
  });
}
