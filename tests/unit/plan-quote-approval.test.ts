import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { approvePlanQuote } from '../../apps/api/src/billing/plan-quote-approval.js';
import type { BillingStore } from '../../apps/api/src/billing/model.js';
import type { PlanQuote } from '../../apps/api/src/billing/plan-quotes.js';

function fixture() {
  const rows = new Map<string, unknown>();
  let tail = Promise.resolve();
  const store: BillingStore = {
    transaction(work) {
      const run = tail.then(async () => {
        const draft = structuredClone(rows);
        const result = await work({
          get: async <T>(id: string) => (draft.get(id) as T) ?? null,
          list: async () => [],
          put: async (id, _owner, _kind, value) => {
            draft.set(id, value);
          },
        });
        rows.clear();
        draft.forEach((value, id) => rows.set(id, value));
        return result;
      });
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
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
    subscriptionId: 'sub_owned',
    orderId: 'order_owned',
    customerId: 'cus_owned',
    sourceProductId: 'pdt_starter',
    targetProductId: 'pdt_pro',
    targetPlan: 'organizer-pro-monthly',
    currency: 'INR',
    recurringBeforeTax: 199900,
    effectiveAt: new Date(Date.now() + 86400000).toISOString(),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    status: 'quoted',
  };
  const account = {
    ownerId: 'owner',
    customerId: 'cus_owned',
    revision: 1,
    subscriptions: {
      sub_owned: {
        id: 'sub_owned',
        orderId: quote.orderId,
        customerId: quote.customerId,
        productId: quote.sourceProductId,
        status: 'active',
        cancelAtPeriodEnd: false,
        nextBillingAt: quote.effectiveAt,
      },
    },
  };
  rows.set('account:owner', account);
  rows.set('plan-quote:owner:sub_owned', quote);
  rows.set('order_owned', {
    id: 'order_owned',
    ownerId: 'owner',
    customerId: 'cus_owned',
    currency: 'INR',
  });
  return {
    rows,
    billing,
    quote,
    account,
    run: (id = quote.id, owner = 'owner') =>
      approvePlanQuote(billing, owner, 'sub_owned', id),
  };
}

describe('persisted quote approval (no provider operations)', () => {
  it('records one approval under concurrent identical confirmations', async () => {
    const f = fixture();
    const [first, second] = await Promise.all([f.run(), f.run()]);
    expect(first).toEqual(second);
    expect(first.status).toBe('approved');
    expect(f.rows.size).toBe(4);
    expect(f.rows.get('account:owner')).toMatchObject({ revision: 2 });
    expect(JSON.stringify(first)).not.toMatch(/cus_|pdt_|order_owned/);
  });

  it.each(['wrong nonce', 'foreign owner'])(
    'rejects %s without writes',
    async (kind) => {
      const f = fixture();
      const before = structuredClone(f.rows);
      await expect(
        f.run(
          kind === 'wrong nonce' ? randomUUID() : f.quote.id,
          kind === 'foreign owner' ? 'other' : 'owner',
        ),
      ).rejects.toMatchObject({ code: 'PLAN_QUOTE_CHANGED' });
      expect(f.rows).toEqual(before);
    },
  );

  it.each([
    'expired',
    'invalid date',
    'cancelled',
    'deleting',
    'mapping',
    'catalog',
    'renewal',
    'customer',
    'submitting',
  ])('rejects changed %s state atomically', async (kind) => {
    const f = fixture();
    if (kind === 'expired') f.quote.expiresAt = new Date(0).toISOString();
    if (kind === 'invalid date') f.quote.expiresAt = 'invalid';
    if (kind === 'cancelled')
      f.account.subscriptions.sub_owned.cancelAtPeriodEnd = true;
    if (kind === 'deleting')
      Object.assign(f.account, { deletionPendingAt: new Date().toISOString() });
    if (kind === 'mapping')
      f.billing.products['organizer-pro-monthly:INR'] = 'pdt_changed';
    if (kind === 'catalog') f.billing.roleCatalogEnabled = false;
    if (kind === 'renewal')
      f.account.subscriptions.sub_owned.nextBillingAt =
        new Date().toISOString();
    if (kind === 'customer') f.account.customerId = 'cus_other';
    if (kind === 'submitting') f.quote.status = 'submitting';
    const before = structuredClone(f.rows);
    await expect(f.run()).rejects.toMatchObject({ code: 'PLAN_QUOTE_CHANGED' });
    expect(f.rows).toEqual(before);
  });

  it('does not silently approve a quote edited after approval', async () => {
    const f = fixture();
    await f.run();
    const saved = f.rows.get('plan-quote:owner:sub_owned') as PlanQuote;
    saved.recurringBeforeTax++;
    await expect(f.run()).rejects.toMatchObject({ code: 'PLAN_QUOTE_CHANGED' });
  });
});
