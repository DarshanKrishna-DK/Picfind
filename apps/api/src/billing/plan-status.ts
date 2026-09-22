import { ApiError } from '../auth.js';
import type { BillingAccount } from './model.js';
import type { PlanQuote } from './plan-quotes.js';
import type { BillingService } from './service.js';

/** Reads local state only. Status retrieval must never retry a financial mutation. */
export async function readPlanStatus(
  billing: BillingService,
  owner: string,
  subscriptionId: string,
) {
  return billing.store.transaction(async (tx) => {
    const account = await tx.get<BillingAccount>(billing.key('account', owner));
    const sub = account?.subscriptions[subscriptionId];
    const unavailable = () =>
      new ApiError(404, 'NOT_FOUND', 'This subscription is not available.');
    if (
      !account ||
      account.ownerId !== owner ||
      !sub ||
      sub.id !== subscriptionId
    )
      throw unavailable();
    const quote = await tx.get<PlanQuote>(
      billing.key('plan-quote', `${owner}:${subscriptionId}`),
    );
    if (!quote) return { change: null };
    if (
      quote.version !== 1 ||
      quote.ownerId !== owner ||
      quote.subscriptionId !== subscriptionId ||
      quote.customerId !== account.customerId ||
      quote.orderId !== sub.orderId
    )
      throw unavailable();
    return {
      change: {
        quoteId: quote.id,
        plan: quote.targetPlan,
        status: quote.status,
        currency: quote.currency,
        recurringBeforeTax: quote.recurringBeforeTax,
        effectiveAt: quote.effectiveAt,
        expiresAt: quote.expiresAt,
        expired:
          quote.status === 'quoted' &&
          Date.parse(quote.expiresAt) <= Date.now(),
      },
    };
  });
}
