import { ApiError } from '../auth.js';
import { assertCancellationResolved } from './cancellation-guard.js';
import type { BillingAccount, ConfirmedPlanChangeSchedule } from './model.js';
import type { QuoteApproval } from './plan-quote-approval.js';
import type { PlanQuote } from './plan-quotes.js';
import { reservePlanSubmission, type Submission } from './plan-submission.js';
import {
  recordScheduledPlanChange,
  scheduleSchema,
} from './plan-transitions.js';
import type { BillingService } from './service.js';

const pending = () =>
  new ApiError(
    503,
    'PLAN_CHANGE_RECONCILIATION_PENDING',
    'The plan change is not confirmed yet. Check its status before requesting another change.',
  );

/** Trusted internal workflow. Never enable from a request body or a checkout-return URL. */
export async function executePlanChange(
  billing: BillingService,
  owner: string,
  subscriptionId: string,
  quoteId: string,
  enabled = false,
) {
  const quoteKey = billing.key('plan-quote', `${owner}:${subscriptionId}`);
  const attemptKey = billing.key('plan-submission', `${owner}:${quoteId}`);
  const approvalKey = billing.key('quote-approval', `${owner}:${quoteId}`);
  const accountKey = billing.key('account', owner);
  const state = () =>
    billing.store.transaction(async (tx) => {
      const account = await tx.get<BillingAccount>(accountKey);
      const quote = await tx.get<PlanQuote>(quoteKey);
      const approval = await tx.get<QuoteApproval>(approvalKey);
      const attempt = await tx.get<Submission>(attemptKey);
      if (
        !account ||
        account.ownerId !== owner ||
        account.deletionPendingAt ||
        !quote ||
        quote.id !== quoteId ||
        quote.ownerId !== owner ||
        quote.subscriptionId !== subscriptionId ||
        !approval ||
        approval.version !== 1 ||
        quote.version !== 1 ||
        JSON.stringify({ ...quote, status: 'quoted' }) !==
          JSON.stringify(approval.quote)
      )
        throw pending();
      assertCancellationResolved(account, subscriptionId);
      if (
        attempt &&
        (attempt.version !== 1 ||
          attempt.ownerId !== owner ||
          attempt.subscriptionId !== subscriptionId ||
          attempt.quoteId !== quoteId ||
          attempt.request.requestId !== approval.id)
      )
        throw pending();
      return { quote, approval, attempt };
    });
  const validate = (
    value: unknown,
    quote: PlanQuote,
  ): ConfirmedPlanChangeSchedule => {
    const parsed = scheduleSchema.safeParse(value);
    if (!parsed.success) throw pending();
    const receipt = parsed.data;
    if (
      receipt.subscriptionId !== subscriptionId ||
      receipt.orderId !== quote.orderId ||
      receipt.customerId !== quote.customerId ||
      receipt.productId !== quote.targetProductId ||
      receipt.currency !== quote.currency ||
      Date.parse(receipt.effectiveAt) !== Date.parse(quote.effectiveAt)
    )
      throw pending();
    return receipt;
  };
  const result = (quote: PlanQuote) => ({
    quoteId,
    status:
      quote.status === 'completed'
        ? ('applied' as const)
        : quote.status === 'cancelled'
          ? ('cancelled' as const)
          : ('scheduled' as const),
    plan: quote.targetPlan,
    effectiveAt: quote.effectiveAt,
  });
  const initial = await state();
  if (['scheduled', 'completed', 'cancelled'].includes(initial.quote.status)) {
    validate(initial.attempt?.confirmedSchedule, initial.quote);
    return result(initial.quote);
  }
  if (
    initial.quote.status !== 'submitting' &&
    (!enabled ||
      !billing.provider?.schedulePlanChange ||
      !billing.provider.inspectPlanChange)
  )
    throw new ApiError(
      503,
      'PLAN_CHANGE_UNAVAILABLE',
      'Plan changes are not enabled. Your subscription is unchanged.',
    );
  const reservation = await reservePlanSubmission(
    billing,
    owner,
    subscriptionId,
    quoteId,
  );
  let current = await state();
  let receipt: ConfirmedPlanChangeSchedule;
  const submit = async () => {
    if (!enabled || !billing.provider?.schedulePlanChange) throw pending();
    return billing.provider.schedulePlanChange(reservation.request);
  };
  const inspect = async () => {
    if (!billing.provider?.inspectPlanChange) throw pending();
    return billing.provider.inspectPlanChange(reservation.request);
  };
  try {
    receipt = validate(
      current.attempt?.confirmedSchedule ??
        (await (reservation.shouldSubmit ? submit() : inspect())),
      current.quote,
    );
  } catch {
    // The durable reservation remains. A retry may inspect, but may not POST again.
    throw pending();
  }
  // Save the receipt before history processing: recovery then works without another provider read.
  await billing.store.transaction(async (tx) => {
    const quote = await tx.get<PlanQuote>(quoteKey);
    const attempt = await tx.get<Submission>(attemptKey);
    if (
      !quote ||
      quote.id !== quoteId ||
      quote.ownerId !== owner ||
      !['submitting', 'scheduled'].includes(quote.status) ||
      !attempt ||
      attempt.ownerId !== owner ||
      attempt.quoteId !== quoteId ||
      attempt.request.requestId !== reservation.request.requestId
    )
      throw pending();
    if (
      attempt.confirmedSchedule &&
      JSON.stringify(validate(attempt.confirmedSchedule, quote)) !==
        JSON.stringify(receipt)
    )
      throw pending();
    await tx.put(attemptKey, `${billing.namespace}:${owner}`, 'event', {
      ...attempt,
      confirmedSchedule: receipt,
    });
  });
  current = await state();
  await recordScheduledPlanChange(
    billing,
    owner,
    {
      id: current.approval.id,
      quoteId,
      subscriptionId,
      sourceProductId: current.quote.sourceProductId,
      targetPlan: current.quote.targetPlan,
      effectiveAt: current.quote.effectiveAt,
      approvedAt: current.approval.approvedAt,
    },
    receipt,
  );
  const finalQuote = await billing.store.transaction(async (tx) => {
    const quote = await tx.get<PlanQuote>(quoteKey);
    if (
      !quote ||
      quote.id !== quoteId ||
      quote.ownerId !== owner ||
      !['submitting', 'scheduled', 'completed', 'cancelled'].includes(
        quote.status,
      )
    )
      throw pending();
    if (quote.status === 'completed' || quote.status === 'cancelled')
      return quote;
    const next: PlanQuote = { ...quote, status: 'scheduled' };
    await tx.put(quoteKey, `${billing.namespace}:${owner}`, 'event', next);
    return next;
  });
  return result(finalQuote);
}
