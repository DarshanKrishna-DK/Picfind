import { describe, expect, it, vi } from 'vitest';
import { BillingService } from '../../apps/api/src/billing/service.js';
import { createPlanQuote } from '../../apps/api/src/billing/plan-quotes.js';
import { approvePlanQuote } from '../../apps/api/src/billing/plan-quote-approval.js';
import { executePlanChange } from '../../apps/api/src/billing/plan-change-workflow.js';
import { executePlanCancellation } from '../../apps/api/src/billing/plan-cancellation-workflow.js';
import { recordCancelledPlanChange } from '../../apps/api/src/billing/plan-transitions.js';
import { beginSubscriptionCancellation } from '../../apps/api/src/billing/cancellation-guard.js';
import type { BillingAccount } from '../../apps/api/src/billing/model.js';
import type {
  BillingStore,
  BillingTransaction,
  BillingKind,
  BillingProvider,
  ApprovedPlanChangeRequest,
  ConfirmedPlanChangeSchedule,
} from '../../apps/api/src/billing/model.js';

class Store implements BillingStore {
  rows = new Map<
    string,
    { owner: string; kind: BillingKind; value: unknown }
  >();
  failNextPut: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  transaction<T>(work: (tx: BillingTransaction) => Promise<T>) {
    const task = this.tail.then(async () => {
      const draft = structuredClone(this.rows);
      const result = await work({
        get: async <V>(id: string) => (draft.get(id)?.value as V) ?? null,
        list: async <V>(owner: string, kind: BillingKind) =>
          [...draft.values()]
            .filter((row) => row.owner === owner && row.kind === kind)
            .map((row) => row.value as V),
        put: async (id, owner, kind, value) => {
          if (this.failNextPut === id) {
            this.failNextPut = undefined;
            throw new Error('Synthetic storage interruption');
          }
          draft.set(id, { owner, kind, value });
        },
      });
      this.rows = draft;
      return result;
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
}

async function fixture() {
  const store = new Store();
  const now = new Date().toISOString();
  const subscription = {
    id: 'sub',
    orderId: 'order',
    customerId: 'customer',
    productId: 'pdt_starter',
    status: 'active',
    cancelAtPeriodEnd: false,
    observedAt: now,
    nextBillingAt: new Date(Date.now() + 86400000).toISOString(),
  };
  let remote: ConfirmedPlanChangeSchedule | undefined;
  const receipt = (
    request: ApprovedPlanChangeRequest,
  ): ConfirmedPlanChangeSchedule => ({
    id: 'schedule',
    subscriptionId: 'sub',
    orderId: 'order',
    customerId: 'customer',
    productId: request.productId,
    currency: request.currency,
    quantity: 1,
    effectiveAt: request.subscription.nextBillingAt,
  });
  const provider: BillingProvider = {
    checkout: vi.fn(),
    portal: vi.fn(),
    verify: vi.fn(),
    readSubscription: vi.fn(async () => structuredClone(subscription)),
    previewPlanChange: vi.fn(async () => ({
      currency: 'INR' as const,
      chargeNow: 0,
      recurringBeforeTax: 199900,
      effectiveAt: subscription.nextBillingAt,
    })),
    schedulePlanChange: vi.fn(async (request) => {
      remote = receipt(request);
      return remote;
    }),
    inspectPlanChange: vi.fn(async () => {
      if (!remote) throw new Error('No schedule');
      return remote;
    }),
  };
  const billing = new BillingService(
    store,
    provider,
    {
      'organizer-starter-monthly:INR': 'pdt_starter',
      'organizer-pro-monthly:INR': 'pdt_pro',
    },
    'test_mode',
    false,
    true,
  );
  store.rows.set(billing.key('account', 'owner'), {
    owner: 'test_mode:owner',
    kind: 'account',
    value: {
      ownerId: 'owner',
      customerId: 'customer',
      revision: 1,
      createdAt: now,
      subscriptions: { sub: subscription },
    },
  });
  store.rows.set('order', {
    owner: 'test_mode:owner',
    kind: 'order',
    value: {
      id: 'order',
      ownerId: 'owner',
      customerId: 'customer',
      plan: 'organizer-starter-monthly',
      productId: 'pdt_starter',
      currency: 'INR',
      createdAt: now,
      fulfilled: true,
    },
  });
  const quote = await createPlanQuote(
    billing,
    'owner',
    'sub',
    'organizer-pro-monthly',
  );
  await approvePlanQuote(billing, 'owner', 'sub', quote.quoteId);
  const run = () =>
    executePlanChange(billing, 'owner', 'sub', quote.quoteId, true);
  return {
    store,
    provider,
    billing,
    quote,
    run,
    receipt,
    setRemote: (value: ConfirmedPlanChangeSchedule) => {
      remote = value;
    },
  };
}

describe('approved plan-change workflow with synthetic Dodo only', () => {
  it('withdraws a scheduled change once without cancelling the subscription or granting credits', async () => {
    const f = await fixture();
    await f.run();
    f.provider.cancelScheduledPlanChange = vi.fn(async (request) => ({
      subscriptionId: 'sub',
      scheduleId: request.scheduleId,
      cancelled: true as const,
    }));
    f.provider.inspectScheduledPlanCancellation = vi.fn();
    await expect(
      executePlanCancellation(f.billing, 'owner', 'sub', f.quote.quoteId, true),
    ).resolves.toMatchObject({ status: 'cancelled' });
    await expect(
      executePlanCancellation(
        f.billing,
        'owner',
        'sub',
        f.quote.quoteId,
        false,
      ),
    ).resolves.toMatchObject({ status: 'cancelled' });
    expect(f.provider.cancelScheduledPlanChange).toHaveBeenCalledTimes(1);
    expect(f.provider.inspectScheduledPlanCancellation).not.toHaveBeenCalled();
    const account = f.store.rows.get(f.billing.key('account', 'owner'))!
      .value as BillingAccount;
    expect(account.subscriptions.sub?.status).toBe('active');
    expect(
      [...f.store.rows.values()].filter((row) => row.kind === 'grant'),
    ).toHaveLength(0);
  });
  it('only inspects a withdrawal after an uncertain response', async () => {
    const f = await fixture();
    await f.run();
    f.provider.cancelScheduledPlanChange = vi.fn(async () => {
      throw new Error('Synthetic lost response');
    });
    f.provider.inspectScheduledPlanCancellation = vi.fn(async (request) => ({
      subscriptionId: 'sub',
      scheduleId: request.scheduleId,
      cancelled: true as const,
    }));
    await expect(
      executePlanCancellation(f.billing, 'owner', 'sub', f.quote.quoteId, true),
    ).rejects.toMatchObject({ code: 'PLAN_CANCELLATION_PENDING' });
    await expect(
      executePlanCancellation(
        f.billing,
        'owner',
        'sub',
        f.quote.quoteId,
        false,
      ),
    ).resolves.toMatchObject({ status: 'cancelled' });
    expect(f.provider.cancelScheduledPlanChange).toHaveBeenCalledTimes(1);
    expect(f.provider.inspectScheduledPlanCancellation).toHaveBeenCalledTimes(
      1,
    );
  });
  it('retains withdrawal confirmation across a failed history write', async () => {
    const f = await fixture();
    await f.run();
    f.provider.cancelScheduledPlanChange = vi.fn(async (request) => ({
      subscriptionId: 'sub',
      scheduleId: request.scheduleId,
      cancelled: true as const,
    }));
    f.provider.inspectScheduledPlanCancellation = vi.fn();
    f.store.failNextPut = f.billing.key('plan-history', 'sub');
    await expect(
      executePlanCancellation(f.billing, 'owner', 'sub', f.quote.quoteId, true),
    ).rejects.toThrow('Synthetic storage interruption');
    delete f.provider.cancelScheduledPlanChange;
    delete f.provider.inspectScheduledPlanCancellation;
    await expect(
      executePlanCancellation(
        f.billing,
        'owner',
        'sub',
        f.quote.quoteId,
        false,
      ),
    ).resolves.toMatchObject({ status: 'cancelled' });
  });
  it('does not reserve a withdrawal without explicit enablement', async () => {
    const f = await fixture();
    await f.run();
    f.provider.cancelScheduledPlanChange = vi.fn();
    f.provider.inspectScheduledPlanCancellation = vi.fn();
    const before = structuredClone(f.store.rows);
    await expect(
      executePlanCancellation(f.billing, 'owner', 'sub', f.quote.quoteId),
    ).rejects.toMatchObject({ code: 'PLAN_CANCELLATION_UNAVAILABLE' });
    expect(f.store.rows).toEqual(before);
    expect(f.provider.cancelScheduledPlanChange).not.toHaveBeenCalled();
  });
  it('retires an applied quote and permits the next plan quote', async () => {
    const f = await fixture();
    await f.run();
    const account = f.store.rows.get(f.billing.key('account', 'owner'))!
      .value as BillingAccount;
    const next = {
      ...account.subscriptions.sub!,
      productId: 'pdt_pro',
      observedAt: new Date(
        Date.parse(f.quote.effectiveAt) + 1000,
      ).toISOString(),
      nextBillingAt: new Date(
        Date.parse(f.quote.effectiveAt) + 30 * 86400000,
      ).toISOString(),
    };
    await f.billing.apply({
      id: 'synthetic-plan-applied',
      type: 'subscription.updated',
      subscription: next,
    });
    await expect(
      executePlanChange(f.billing, 'owner', 'sub', f.quote.quoteId, false),
    ).resolves.toMatchObject({ status: 'applied' });
    f.provider.readSubscription = vi.fn(async () => next);
    f.provider.previewPlanChange = vi.fn(async () => ({
      currency: 'INR' as const,
      chargeNow: 0,
      recurringBeforeTax: 69900,
      effectiveAt: next.nextBillingAt,
    }));
    const quote = await createPlanQuote(
      f.billing,
      'owner',
      'sub',
      'organizer-starter-monthly',
    );
    expect(quote.quoteId).not.toBe(f.quote.quoteId);
    expect(f.provider.schedulePlanChange).toHaveBeenCalledTimes(1);
  });
  it('retires a cancelled schedule quote and unblocks subscription cancellation', async () => {
    const f = await fixture();
    await f.run();
    const attempt = f.store.rows.get(
      f.billing.key('plan-submission', `owner:${f.quote.quoteId}`),
    )!.value as { request: ApprovedPlanChangeRequest };
    await recordCancelledPlanChange(
      f.billing,
      'owner',
      'sub',
      attempt.request.requestId,
      'schedule',
    );
    await expect(
      executePlanChange(f.billing, 'owner', 'sub', f.quote.quoteId, false),
    ).resolves.toMatchObject({ status: 'cancelled' });
    await expect(
      beginSubscriptionCancellation(f.billing, 'owner', 'sub'),
    ).resolves.toEqual(expect.any(String));
    expect(f.provider.schedulePlanChange).toHaveBeenCalledTimes(1);
  });
  it('recovers a started change while new submissions are disabled', async () => {
    const f = await fixture();
    f.provider.schedulePlanChange = vi.fn(async (request) => {
      f.setRemote(f.receipt(request));
      throw new Error('Synthetic lost acknowledgement');
    });
    await expect(f.run()).rejects.toMatchObject({
      code: 'PLAN_CHANGE_RECONCILIATION_PENDING',
    });
    await expect(
      executePlanChange(f.billing, 'owner', 'sub', f.quote.quoteId, false),
    ).resolves.toMatchObject({ status: 'scheduled' });
    expect(f.provider.schedulePlanChange).toHaveBeenCalledTimes(1);
    expect(f.provider.inspectPlanChange).toHaveBeenCalledTimes(1);
  });
  it('finishes from a saved receipt with provider capabilities unavailable', async () => {
    const f = await fixture();
    f.store.failNextPut = f.billing.key('plan-history', 'sub');
    await expect(f.run()).rejects.toThrow('Synthetic storage interruption');
    const submit = f.provider.schedulePlanChange;
    const inspect = f.provider.inspectPlanChange;
    delete f.provider.schedulePlanChange;
    delete f.provider.inspectPlanChange;
    await expect(
      executePlanChange(f.billing, 'owner', 'sub', f.quote.quoteId, false),
    ).resolves.toMatchObject({ status: 'scheduled' });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(inspect).not.toHaveBeenCalled();
  });
  it('schedules once, persists its receipt and history, and never grants usage on scheduling', async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result).toMatchObject({
      status: 'scheduled',
      plan: 'organizer-pro-monthly',
    });
    expect(await f.run()).toEqual(result);
    expect(f.provider.schedulePlanChange).toHaveBeenCalledTimes(1);
    expect(f.provider.inspectPlanChange).not.toHaveBeenCalled();
    expect(
      [...f.store.rows.values()].filter((row) => row.kind === 'grant'),
    ).toHaveLength(0);
    expect(
      f.store.rows.get(f.billing.key('plan-history', 'sub'))?.value,
    ).toMatchObject({ pendingId: expect.any(String) });
    expect(JSON.stringify(result)).not.toMatch(/customer|pdt_|requestId/);
  });
  it('recovers a timeout through inspection without resubmission', async () => {
    const f = await fixture();
    f.provider.schedulePlanChange = vi.fn(async (request) => {
      f.setRemote(f.receipt(request));
      throw new Error('Private timeout');
    });
    await expect(f.run()).rejects.toMatchObject({
      code: 'PLAN_CHANGE_RECONCILIATION_PENDING',
    });
    await expect(f.run()).resolves.toMatchObject({ status: 'scheduled' });
    expect(f.provider.schedulePlanChange).toHaveBeenCalledTimes(1);
    expect(f.provider.inspectPlanChange).toHaveBeenCalledTimes(1);
  });
  it('keeps an absent schedule unresolved instead of retrying the mutation', async () => {
    const f = await fixture();
    f.provider.schedulePlanChange = vi.fn(async () => {
      throw new Error('Unknown outcome');
    });
    for (let i = 0; i < 3; i++)
      await expect(f.run()).rejects.toMatchObject({
        code: 'PLAN_CHANGE_RECONCILIATION_PENDING',
      });
    expect(f.provider.schedulePlanChange).toHaveBeenCalledTimes(1);
    expect(f.provider.inspectPlanChange).toHaveBeenCalledTimes(2);
  });
  it('uses the durable receipt after an interrupted history write', async () => {
    const f = await fixture();
    f.store.failNextPut = f.billing.key('plan-history', 'sub');
    await expect(f.run()).rejects.toThrow('Synthetic storage interruption');
    await expect(f.run()).resolves.toMatchObject({ status: 'scheduled' });
    expect(f.provider.schedulePlanChange).toHaveBeenCalledTimes(1);
    expect(f.provider.inspectPlanChange).not.toHaveBeenCalled();
  });
  it('is disabled by default before any submission or provider call', async () => {
    const f = await fixture();
    const before = structuredClone(f.store.rows);
    await expect(
      executePlanChange(f.billing, 'owner', 'sub', f.quote.quoteId),
    ).rejects.toMatchObject({ code: 'PLAN_CHANGE_UNAVAILABLE' });
    expect(f.store.rows).toEqual(before);
    expect(f.provider.schedulePlanChange).not.toHaveBeenCalled();
  });
});

describe('quote discard versus submission transaction isolation', () => {
  it('allows only discard or submission to win an overlapping request', async () => {
    const { discardPlanQuote } =
      await import('../../apps/api/src/billing/plan-discard.js');
    const f = await fixture();
    const [submission, discard] = await Promise.allSettled([
      f.run(),
      discardPlanQuote(f.billing, 'owner', 'sub', f.quote.quoteId),
    ]);
    if (discard.status === 'fulfilled') {
      expect(discard.value.status).toBe('discarded');
      expect(submission.status).toBe('rejected');
      expect(f.provider.schedulePlanChange).not.toHaveBeenCalled();
    } else {
      expect(submission.status).toBe('fulfilled');
      expect(f.provider.schedulePlanChange).toHaveBeenCalledTimes(1);
    }
  });
  it('cannot discard a completed reservation after a lost provider response', async () => {
    const { discardPlanQuote } =
      await import('../../apps/api/src/billing/plan-discard.js');
    const f = await fixture();
    f.provider.schedulePlanChange = vi.fn(async () => {
      throw new Error('Synthetic unknown outcome');
    });
    await expect(f.run()).rejects.toMatchObject({
      code: 'PLAN_CHANGE_RECONCILIATION_PENDING',
    });
    await expect(
      discardPlanQuote(f.billing, 'owner', 'sub', f.quote.quoteId),
    ).rejects.toMatchObject({ code: 'PLAN_QUOTE_NOT_DISCARDABLE' });
    expect(f.provider.schedulePlanChange).toHaveBeenCalledTimes(1);
  });
});
