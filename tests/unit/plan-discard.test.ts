import { describe, expect, it, vi } from 'vitest';
import { discardPlanQuote } from '../../apps/api/src/billing/plan-discard.js';
import type { BillingTransaction } from '../../apps/api/src/billing/model.js';
import type { BillingService } from '../../apps/api/src/billing/service.js';

function fixture(status = 'approved') {
  const rows = new Map<string, unknown>([
    [
      'account:owner',
      {
        ownerId: 'owner',
        customerId: 'customer',
        revision: 0,
        subscriptions: { sub: { id: 'sub', orderId: 'order' } },
      },
    ],
    [
      'plan-quote:owner:sub',
      {
        version: 1,
        id: 'quote',
        ownerId: 'owner',
        subscriptionId: 'sub',
        orderId: 'order',
        customerId: 'customer',
        status,
      },
    ],
  ]);
  const put = vi.fn(
    async (id: string, _owner: string, _kind: string, value: unknown) => {
      rows.set(id, value);
    },
  );
  const tx: BillingTransaction = {
    get: async <T>(id: string) =>
      structuredClone(rows.get(id) ?? null) as T | null,
    list: async () => [],
    put,
  };
  const billing = {
    key: (kind: string, id: string) => `${kind}:${id}`,
    namespace: 'test_mode',
    store: {
      transaction: async (work: (tx: BillingTransaction) => unknown) =>
        work(tx),
    },
  } as unknown as BillingService;
  return { rows, put, billing };
}
describe('unsubmitted quote discard, no provider access', () => {
  it.each(['quoted', 'approved'])(
    'retires %s quotes idempotently',
    async (status) => {
      const f = fixture(status);
      const result = await discardPlanQuote(f.billing, 'owner', 'sub', 'quote');
      expect(result.status).toBe('discarded');
      expect(
        await discardPlanQuote(f.billing, 'owner', 'sub', 'quote'),
      ).toEqual(result);
      expect(f.put).toHaveBeenCalledTimes(2);
    },
  );
  it.each(['submitting', 'scheduled', 'cancelling', 'completed', 'cancelled'])(
    'refuses %s states without writes',
    async (status) => {
      const f = fixture(status);
      await expect(
        discardPlanQuote(f.billing, 'owner', 'sub', 'quote'),
      ).rejects.toMatchObject({ code: 'PLAN_QUOTE_NOT_DISCARDABLE' });
      expect(f.put).not.toHaveBeenCalled();
    },
  );
  it('refuses any recorded attempt even if the quote state is stale', async () => {
    const f = fixture();
    f.rows.set('plan-submission:owner:quote', {});
    await expect(
      discardPlanQuote(f.billing, 'owner', 'sub', 'quote'),
    ).rejects.toMatchObject({ code: 'PLAN_QUOTE_NOT_DISCARDABLE' });
    expect(f.put).not.toHaveBeenCalled();
  });
  it('refuses another owner or a replaced quote', async () => {
    const f = fixture();
    await expect(
      discardPlanQuote(f.billing, 'other', 'sub', 'quote'),
    ).rejects.toMatchObject({ code: 'PLAN_QUOTE_NOT_DISCARDABLE' });
    await expect(
      discardPlanQuote(f.billing, 'owner', 'sub', 'old-quote'),
    ).rejects.toMatchObject({ code: 'PLAN_QUOTE_NOT_DISCARDABLE' });
    expect(f.put).not.toHaveBeenCalled();
  });
});
