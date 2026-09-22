import { randomUUID } from 'node:crypto';
import { ApiError } from '../auth.js';
import type { BillingAccount, PlanCancellationRequest } from './model.js';
import type { PlanQuote } from './plan-quotes.js';
import type { Submission } from './plan-submission.js';
import {
  recordCancelledPlanChange,
  scheduleSchema,
} from './plan-transitions.js';
import type { BillingService } from './service.js';

const pending = () =>
  new ApiError(
    503,
    'PLAN_CANCELLATION_PENDING',
    'The scheduled change cancellation is not confirmed. Check its status before trying another change.',
  );

/** Trusted internal entry point. Only the first explicitly enabled attempt may delete a provider schedule. */
export async function executePlanCancellation(
  billing: BillingService,
  owner: string,
  subscriptionId: string,
  quoteId: string,
  enabled = false,
) {
  const quoteKey = billing.key('plan-quote', `${owner}:${subscriptionId}`);
  const attemptKey = billing.key('plan-submission', `${owner}:${quoteId}`);
  const accountKey = billing.key('account', owner);
  const reservation = await billing.store.transaction(async (tx) => {
    const account = await tx.get<BillingAccount>(accountKey);
    const quote = await tx.get<PlanQuote>(quoteKey);
    const attempt = await tx.get<Submission>(attemptKey);
    if (
      !account ||
      account.ownerId !== owner ||
      !quote ||
      quote.ownerId !== owner ||
      quote.id !== quoteId ||
      quote.subscriptionId !== subscriptionId ||
      !attempt ||
      attempt.ownerId !== owner ||
      attempt.quoteId !== quoteId ||
      attempt.subscriptionId !== subscriptionId ||
      attempt.request.subscription.customerId !== account.customerId
    )
      throw pending();
    const parsed = scheduleSchema.safeParse(attempt.confirmedSchedule);
    if (
      !parsed.success ||
      parsed.data.subscriptionId !== subscriptionId ||
      parsed.data.customerId !== account.customerId ||
      parsed.data.orderId !== quote.orderId ||
      parsed.data.productId !== quote.targetProductId ||
      parsed.data.currency !== quote.currency ||
      Date.parse(parsed.data.effectiveAt) !== Date.parse(quote.effectiveAt)
    )
      throw pending();
    if (quote.status === 'completed' || quote.status === 'cancelled')
      return { quote, attempt, shouldSubmit: false };
    if (quote.status === 'cancelling') {
      if (!attempt.cancellation) throw pending();
      return { quote, attempt, shouldSubmit: false };
    }
    if (
      quote.status !== 'scheduled' ||
      attempt.cancellation ||
      account.deletionPendingAt ||
      !enabled ||
      !billing.provider?.cancelScheduledPlanChange ||
      !billing.provider.inspectScheduledPlanCancellation
    )
      throw new ApiError(
        409,
        'PLAN_CANCELLATION_UNAVAILABLE',
        'This scheduled change cannot be cancelled right now. No cancellation was submitted.',
      );
    const next: Submission = {
      ...attempt,
      cancellation: {
        id: randomUUID(),
        requestedAt: new Date().toISOString(),
        confirmed: false,
      },
    };
    const nextQuote: PlanQuote = { ...quote, status: 'cancelling' };
    account.revision++;
    const ownerKey = `${billing.namespace}:${owner}`;
    await tx.put(accountKey, ownerKey, 'account', account);
    await tx.put(attemptKey, ownerKey, 'event', next);
    await tx.put(quoteKey, ownerKey, 'event', nextQuote);
    return { quote: nextQuote, attempt: next, shouldSubmit: true };
  });
  const result = (status: 'cancelled' | 'applied') => ({ quoteId, status });
  if (reservation.quote.status === 'completed') return result('applied');
  if (reservation.quote.status === 'cancelled') return result('cancelled');
  const attempt = reservation.attempt;
  const cancellation = attempt.cancellation!;
  const request: PlanCancellationRequest = {
    requestId: cancellation.id,
    scheduleId: attempt.confirmedSchedule!.id,
    change: attempt.request,
  };
  if (!cancellation.confirmed) {
    try {
      const provider = billing.provider;
      let response;
      if (reservation.shouldSubmit) {
        if (!enabled || !provider?.cancelScheduledPlanChange) throw pending();
        response = await provider.cancelScheduledPlanChange(request);
      } else {
        if (!provider?.inspectScheduledPlanCancellation) throw pending();
        response = await provider.inspectScheduledPlanCancellation(request);
      }
      if (
        response.cancelled !== true ||
        response.subscriptionId !== subscriptionId ||
        response.scheduleId !== request.scheduleId
      )
        throw pending();
    } catch {
      throw pending();
    }
    await billing.store.transaction(async (tx) => {
      const saved = await tx.get<Submission>(attemptKey);
      if (
        !saved ||
        saved.ownerId !== owner ||
        saved.quoteId !== quoteId ||
        saved.cancellation?.id !== cancellation.id
      )
        throw pending();
      await tx.put(attemptKey, `${billing.namespace}:${owner}`, 'event', {
        ...saved,
        cancellation: { ...saved.cancellation, confirmed: true },
      });
    });
  }
  const quote = await billing.store.transaction((tx) =>
    tx.get<PlanQuote>(quoteKey),
  );
  if (!quote || quote.ownerId !== owner || quote.id !== quoteId)
    throw pending();
  if (quote.status === 'completed') return result('applied');
  await recordCancelledPlanChange(
    billing,
    owner,
    subscriptionId,
    attempt.request.requestId,
    request.scheduleId,
  );
  return result('cancelled');
}
