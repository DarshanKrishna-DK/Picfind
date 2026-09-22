import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reservePlanSubmission } from '../../apps/api/src/billing/plan-submission.js';
import { beginSubscriptionCancellation } from '../../apps/api/src/billing/cancellation-guard.js';
import type {
  BillingAccount,
  BillingStore,
} from '../../apps/api/src/billing/model.js';
import type { PlanQuote } from '../../apps/api/src/billing/plan-quotes.js';

function fixture() {
  const rows = new Map<string, unknown>();
  let tail = Promise.resolve();
  const store: BillingStore = {
    transaction(work) {
      const task = tail.then(async () => {
        const draft = structuredClone(rows);
        const result = await work({
          get: async <T>(key: string) => (draft.get(key) as T) ?? null,
          list: async () => [],
          put: async (key, _owner, _kind, value) => {
            draft.set(key, value);
          },
        });
        rows.clear();
        draft.forEach((value, key) => rows.set(key, value));
        return result;
      });
      tail = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
  };
  const billing = {
    store,
    key: (kind: string, id: string) => `${kind}:${id}`,
    namespace: 'test_mode' as const,
    products: { 'organizer-pro-monthly:INR': 'pdt_pro' },
    roleCatalogEnabled: true,
  };
  const quote: PlanQuote = {
    version: 1,
    id: randomUUID(),
    ownerId: 'owner',
    subscriptionId: 'sub',
    orderId: 'order',
    customerId: 'customer',
    sourceProductId: 'pdt_starter',
    targetProductId: 'pdt_pro',
    targetPlan: 'organizer-pro-monthly',
    currency: 'INR',
    recurringBeforeTax: 199900,
    effectiveAt: new Date(Date.now() + 86400000).toISOString(),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    status: 'approved',
  };
  const account: BillingAccount = {
    ownerId: 'owner',
    customerId: 'customer',
    revision: 1,
    createdAt: new Date().toISOString(),
    subscriptions: {
      sub: {
        id: 'sub',
        orderId: 'order',
        customerId: 'customer',
        productId: 'pdt_starter',
        status: 'active',
        cancelAtPeriodEnd: false,
        nextBillingAt: quote.effectiveAt,
        observedAt: new Date().toISOString(),
      },
    },
  };
  rows.set('account:owner', account);
  rows.set('plan-quote:owner:sub', quote);
  rows.set('order', {
    id: 'order',
    ownerId: 'owner',
    customerId: 'customer',
    currency: 'INR',
  });
  rows.set(`quote-approval:owner:${quote.id}`, {
    version: 1,
    id: randomUUID(),
    quote: { ...quote, status: 'quoted' },
    approvedAt: new Date().toISOString(),
  });
  return {
    rows,
    quote,
    account,
    billing,
    reserve: () => reservePlanSubmission(billing, 'owner', 'sub', quote.id),
  };
}

describe('approved plan submission reservation, metadata only', () => {
  it('grants only one submission under simultaneous confirmations', async () => {
    const f = fixture();
    const before = f.rows.size;
    const results = await Promise.all([f.reserve(), f.reserve(), f.reserve()]);
    expect(results.map((result) => result.shouldSubmit)).toEqual([
      true,
      false,
      false,
    ]);
    expect(
      new Set(results.map((result) => result.request.requestId)).size,
    ).toBe(1);
    expect(f.rows.size).toBe(before + 1);
    expect(f.rows.get('plan-quote:owner:sub')).toMatchObject({
      status: 'submitting',
    });
    expect(f.rows.get('account:owner')).toMatchObject({ revision: 2 });
  });
  it.each(['cancellation-first', 'submission-first'])(
    'coordinates atomically with %s',
    async (order) => {
      const f = fixture();
      const cancel = () =>
        beginSubscriptionCancellation(f.billing, 'owner', 'sub');
      const results = await Promise.allSettled(
        order === 'cancellation-first'
          ? [cancel(), f.reserve()]
          : [f.reserve(), cancel()],
      );
      expect(results[0]?.status).toBe('fulfilled');
      expect(results[1]?.status).toBe('rejected');
    },
  );
  it.each(['expired', 'price', 'deletion', 'catalog', 'product', 'unapproved'])(
    'rejects changed %s state without a submission',
    async (kind) => {
      const f = fixture();
      if (kind === 'expired') f.quote.expiresAt = new Date(0).toISOString();
      if (kind === 'price') f.quote.recurringBeforeTax++;
      if (kind === 'deletion')
        f.account.deletionPendingAt = new Date().toISOString();
      if (kind === 'catalog') f.billing.roleCatalogEnabled = false;
      if (kind === 'product')
        f.billing.products['organizer-pro-monthly:INR'] = 'changed';
      if (kind === 'unapproved') f.quote.status = 'quoted';
      const before = structuredClone(f.rows);
      await expect(f.reserve()).rejects.toMatchObject({
        code: 'PLAN_CHANGE_CONFLICT',
      });
      expect(f.rows).toEqual(before);
    },
  );
  it('never issues new submission permission after a reservation, even after a renewal observation', async () => {
    const f = fixture();
    const first = await f.reserve();
    const account = f.rows.get('account:owner') as BillingAccount;
    account.subscriptions.sub!.productId = 'pdt_pro';
    const recovered = await f.reserve();
    expect(recovered.shouldSubmit).toBe(false);
    expect(recovered.request).toEqual(first.request);
  });
});
