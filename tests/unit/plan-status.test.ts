import { describe, expect, it, vi } from 'vitest';
import { readPlanStatus } from '../../apps/api/src/billing/plan-status.js';
import type { BillingService } from '../../apps/api/src/billing/service.js';

function fixture() {
  const account = {
    ownerId: 'owner',
    customerId: 'private-customer',
    subscriptions: { sub: { id: 'sub', orderId: 'private-order' } },
  };
  const quote = {
    version: 1,
    id: 'quote',
    ownerId: 'owner',
    subscriptionId: 'sub',
    customerId: 'private-customer',
    orderId: 'private-order',
    targetProductId: 'private-product',
    targetPlan: 'organizer-pro-monthly',
    status: 'scheduled',
    currency: 'INR',
    recurringBeforeTax: 199900,
    effectiveAt: '2099-01-01T00:00:00Z',
    expiresAt: '2000-01-01T00:00:00Z',
  };
  const rows = new Map<string, unknown>([
    ['account:owner', account],
    ['plan-quote:owner:sub', quote],
  ]);
  const put = vi.fn();
  const billing = {
    key: (kind: string, id: string) => `${kind}:${id}`,
    store: {
      transaction: async (fn: (tx: unknown) => unknown) =>
        fn({ get: async (id: string) => rows.get(id), put }),
    },
  } as unknown as BillingService;
  return { account, quote, rows, put, billing };
}

describe('saved plan status', () => {
  it('returns display fields without private provider identifiers or writes', async () => {
    const f = fixture();
    const result = await readPlanStatus(f.billing, 'owner', 'sub');
    expect(result.change).toMatchObject({
      status: 'scheduled',
      expired: false,
    });
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(f.put).not.toHaveBeenCalled();
  });
  it('returns no change for an owned subscription without a quote', async () => {
    const f = fixture();
    f.rows.delete('plan-quote:owner:sub');
    expect(await readPlanStatus(f.billing, 'owner', 'sub')).toEqual({
      change: null,
    });
  });
  it('marks an unapproved expired quote without mutating it', async () => {
    const f = fixture();
    f.quote.status = 'quoted';
    expect(
      (await readPlanStatus(f.billing, 'owner', 'sub')).change?.expired,
    ).toBe(true);
    expect(f.quote.status).toBe('quoted');
    expect(f.put).not.toHaveBeenCalled();
  });
  it.each(['ownerId', 'customerId', 'orderId', 'subscriptionId'] as const)(
    'rejects a mismatched quote %s',
    async (field) => {
      const f = fixture();
      f.quote[field] = 'other';
      await expect(
        readPlanStatus(f.billing, 'owner', 'sub'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    },
  );
  it('does not reveal another account subscription', async () => {
    const f = fixture();
    await expect(
      readPlanStatus(f.billing, 'other', 'sub'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
