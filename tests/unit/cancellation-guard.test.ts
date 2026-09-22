import { describe, expect, it } from 'vitest';
import {
  assertCancellationResolved,
  beginSubscriptionCancellation,
  finishSubscriptionCancellation,
} from '../../apps/api/src/billing/cancellation-guard.js';
import type {
  BillingAccount,
  BillingStore,
} from '../../apps/api/src/billing/model.js';

function fixture() {
  const rows = new Map<string, unknown>();
  const account: BillingAccount = {
    ownerId: 'owner',
    revision: 1,
    createdAt: new Date().toISOString(),
    subscriptions: {
      sub: {
        id: 'sub',
        orderId: 'order',
        customerId: 'customer',
        productId: 'product',
        status: 'active',
        cancelAtPeriodEnd: false,
        observedAt: new Date().toISOString(),
        nextBillingAt: new Date(Date.now() + 86400000).toISOString(),
      },
    },
  };
  rows.set('account:owner', account);
  const store: BillingStore = {
    async transaction(work) {
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
    },
  };
  const billing = {
    store,
    key: (kind: string, id: string) => `${kind}:${id}`,
    namespace: 'test_mode' as const,
  };
  const saved = () => rows.get('account:owner') as BillingAccount;
  return {
    rows,
    billing,
    saved,
    begin: () => beginSubscriptionCancellation(billing, 'owner', 'sub'),
  };
}

describe('durable cancellation guard, no provider requests', () => {
  it('retains one intent across retries and blocks approval/deletion while unresolved', async () => {
    const f = fixture();
    const first = await f.begin();
    expect(await f.begin()).toBe(first);
    expect(() => assertCancellationResolved(f.saved(), 'sub')).toThrow(
      'Cancellation is still unresolved',
    );
    expect(() => assertCancellationResolved(f.saved())).toThrow();
    expect(() =>
      assertCancellationResolved(f.saved(), 'another-sub'),
    ).not.toThrow();
  });
  it.each(['submitting', 'scheduled'])(
    'rejects cancellation during a %s quote',
    async (status) => {
      const f = fixture();
      f.rows.set('plan-quote:owner:sub', {
        ownerId: 'owner',
        subscriptionId: 'sub',
        status,
      });
      await expect(f.begin()).rejects.toMatchObject({
        code: 'PLAN_CHANGE_CONFLICT',
      });
      expect(f.saved().pendingSubscriptionCancellations).toBeUndefined();
    },
  );
  it('rejects foreign ownership without adding an intent', async () => {
    const f = fixture();
    f.saved().ownerId = 'someone-else';
    await expect(f.begin()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.saved().pendingSubscriptionCancellations).toBeUndefined();
  });
  it('does not clear an uncertain or mismatched intent', async () => {
    const f = fixture();
    const id = await f.begin();
    await expect(
      finishSubscriptionCancellation(f.billing, 'owner', 'sub', id),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_CANCELLATION_PENDING' });
    f.saved().subscriptions.sub!.cancelAtPeriodEnd = true;
    await expect(
      finishSubscriptionCancellation(f.billing, 'owner', 'sub', 'wrong'),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_CANCELLATION_PENDING' });
    expect(f.saved().pendingSubscriptionCancellations?.sub).toBe(id);
  });
  it.each(['period-end', 'immediate'])(
    'clears only after %s cancellation is saved',
    async (mode) => {
      const f = fixture();
      const id = await f.begin();
      if (mode === 'period-end')
        f.saved().subscriptions.sub!.cancelAtPeriodEnd = true;
      else f.saved().subscriptions.sub!.status = 'cancelled';
      await finishSubscriptionCancellation(f.billing, 'owner', 'sub', id);
      expect(() => assertCancellationResolved(f.saved())).not.toThrow();
    },
  );
});
