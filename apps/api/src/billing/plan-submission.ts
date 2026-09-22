import { ApiError } from '../auth.js';
import type { ApprovedPlanChangeRequest } from './model.js';
import { assertCancellationResolved } from './cancellation-guard.js';
import type { BillingAccount, BillingOrder } from './model.js';
import type { QuoteApproval } from './plan-quote-approval.js';
import type { PlanQuote } from './plan-quotes.js';
import type { BillingService } from './service.js';

type Billing = Pick<
  BillingService,
  'store' | 'key' | 'namespace' | 'products' | 'roleCatalogEnabled'
>;
export interface Submission {
  version: 1;
  ownerId: string;
  subscriptionId: string;
  quoteId: string;
  createdAt: string;
  request: ApprovedPlanChangeRequest;
  confirmedSchedule?: import('./model.js').ConfirmedPlanChangeSchedule;
  cancellation?: { id: string; requestedAt: string; confirmed: boolean };
}
const conflict = () =>
  new ApiError(
    409,
    'PLAN_CHANGE_CONFLICT',
    'The plan change needs a fresh quote or reconciliation before it can continue.',
  );

/** Internal only. A repeated reservation is recovery-only, never permission to POST again. */
export async function reservePlanSubmission(
  billing: Billing,
  owner: string,
  subscriptionId: string,
  quoteId: string,
) {
  return billing.store.transaction(async (tx) => {
    const accountKey = billing.key('account', owner);
    const quoteKey = billing.key('plan-quote', `${owner}:${subscriptionId}`);
    const approvalKey = billing.key('quote-approval', `${owner}:${quoteId}`);
    const attemptKey = billing.key('plan-submission', `${owner}:${quoteId}`);
    const account = await tx.get<BillingAccount>(accountKey);
    const quote = await tx.get<PlanQuote>(quoteKey);
    const approval = await tx.get<QuoteApproval>(approvalKey);
    if (
      !account ||
      account.ownerId !== owner ||
      account.deletionPendingAt ||
      !quote ||
      quote.version !== 1 ||
      quote.id !== quoteId ||
      quote.ownerId !== owner ||
      quote.subscriptionId !== subscriptionId ||
      !approval ||
      approval.version !== 1 ||
      JSON.stringify({ ...quote, status: 'quoted' }) !==
        JSON.stringify(approval.quote)
    )
      throw conflict();
    assertCancellationResolved(account, subscriptionId);
    const previous = await tx.get<Submission>(attemptKey);
    if (previous) {
      if (
        quote.status !== 'submitting' ||
        previous.version !== 1 ||
        previous.ownerId !== owner ||
        previous.subscriptionId !== subscriptionId ||
        previous.quoteId !== quoteId ||
        previous.request.requestId !== approval.id ||
        previous.request.subscription.id !== subscriptionId ||
        previous.request.subscription.orderId !== quote.orderId ||
        previous.request.subscription.customerId !== quote.customerId ||
        previous.request.subscription.productId !== quote.sourceProductId ||
        previous.request.subscription.nextBillingAt !== quote.effectiveAt ||
        previous.request.productId !== quote.targetProductId ||
        previous.request.currency !== quote.currency ||
        previous.request.recurringBeforeTax !== quote.recurringBeforeTax ||
        previous.request.interval !==
          (quote.targetPlan.endsWith('-yearly') ? 'Year' : 'Month')
      )
        throw conflict();
      return { shouldSubmit: false as const, request: previous.request };
    }
    const subscription = account.subscriptions[subscriptionId];
    const order = await tx.get<BillingOrder>(quote.orderId);
    const expires = Date.parse(quote.expiresAt),
      effective = Date.parse(quote.effectiveAt);
    if (
      quote.status !== 'approved' ||
      !subscription ||
      subscription.id !== subscriptionId ||
      subscription.status !== 'active' ||
      subscription.cancelAtPeriodEnd ||
      subscription.productId !== quote.sourceProductId ||
      subscription.orderId !== quote.orderId ||
      subscription.customerId !== quote.customerId ||
      subscription.nextBillingAt !== quote.effectiveAt ||
      account.customerId !== quote.customerId ||
      !order ||
      order.id !== quote.orderId ||
      order.ownerId !== owner ||
      order.customerId !== quote.customerId ||
      order.currency !== quote.currency ||
      !Number.isFinite(expires) ||
      expires <= Date.now() ||
      !Number.isFinite(effective) ||
      effective <= Date.now() + 60_000 ||
      !Number.isSafeInteger(quote.recurringBeforeTax) ||
      quote.recurringBeforeTax < 0 ||
      !quote.targetProductId ||
      quote.targetProductId === quote.sourceProductId ||
      billing.products[`${quote.targetPlan}:${quote.currency}`] !==
        quote.targetProductId ||
      (quote.targetPlan.startsWith('organizer-') && !billing.roleCatalogEnabled)
    )
      throw conflict();
    const request: ApprovedPlanChangeRequest = {
      requestId: approval.id,
      subscription: structuredClone(subscription),
      productId: quote.targetProductId,
      currency: quote.currency,
      interval: quote.targetPlan.endsWith('-yearly') ? 'Year' : 'Month',
      recurringBeforeTax: quote.recurringBeforeTax,
    };
    const submission: Submission = {
      version: 1,
      ownerId: owner,
      subscriptionId,
      quoteId,
      createdAt: new Date().toISOString(),
      request,
    };
    account.revision++;
    const ownerKey = `${billing.namespace}:${owner}`;
    await tx.put(accountKey, ownerKey, 'account', account);
    await tx.put(attemptKey, ownerKey, 'event', submission);
    await tx.put(quoteKey, ownerKey, 'event', {
      ...quote,
      status: 'submitting',
    });
    return { shouldSubmit: true as const, request };
  });
}
