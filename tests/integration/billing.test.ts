import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import {
  ApiError,
  type AuthUser,
  type AuthenticationProvider,
} from '../../apps/api/src/auth.js';
import { BillingService } from '../../apps/api/src/billing/service.js';
import {
  addMonths,
  newGrant,
  remaining,
  type BillingKind,
  type BillingAccount,
  type BillingProvider,
  type BillingStore,
  type BillingTransaction,
  type PaymentSnapshot,
  type VerifiedBillingEvent,
} from '../../apps/api/src/billing/model.js';
import { DodoBillingProvider } from '../../apps/api/src/adapters/dodo-billing.js';

// Synthetic transactional adapter. Production transactions are tested separately against Appwrite.
class MemoryBilling implements BillingStore {
  rows = new Map<
    string,
    { owner: string; kind: BillingKind; value: unknown }
  >();
  private tail: Promise<unknown> = Promise.resolve();
  transaction<T>(work: (tx: BillingTransaction) => Promise<T>): Promise<T> {
    const task = this.tail.then(async () => {
      const draft = structuredClone(this.rows);
      const result = await work({
        get: async <V>(id: string) =>
          structuredClone(draft.get(id)?.value ?? null) as V | null,
        list: async <V>(owner: string, kind: BillingKind) =>
          [...draft.values()]
            .filter((row) => row.owner === owner && row.kind === kind)
            .map((row) => structuredClone(row.value) as V),
        put: async (id, owner, kind, value) => {
          draft.set(id, { owner, kind, value: structuredClone(value) });
        },
      });
      this.rows = draft;
      return result;
    });
    this.tail = task.catch(() => {});
    return task;
  }
}
const user: AuthUser = {
  id: 'test-user',
  email: 'billing@example.test',
  name: 'Synthetic account',
  emailVerified: true,
};
function fixture(enabled = true) {
  const store = new MemoryBilling();
  const provider: BillingProvider = {
    checkout: vi.fn(async (order) => ({
      sessionId: `cks_${order.id}`,
      url: `https://test.checkout.dodopayments.com/${order.id}`,
    })),
    portal: vi.fn(async () => 'https://customerportal.dodopayments.com/test'),
    verify: vi.fn(async () => {
      throw new ApiError(400, 'INVALID_WEBHOOK', 'Invalid signature.');
    }),
  };
  const service = new BillingService(
    store,
    provider,
    { 'photo-pack:INR': 'pdt_pack', 'creator:INR': 'pdt_creator' },
    'test_mode',
    enabled,
  );
  async function purchase(plan: 'photo-pack' | 'creator' = 'photo-pack') {
    const requestId = randomUUID();
    await service.checkout(user, requestId, plan, 'INR');
    const orderId = service.key('order', `${user.id}:${requestId}`);
    const now = new Date().toISOString();
    const payment: PaymentSnapshot = {
      id: `pay_${randomUUID()}`,
      orderId,
      customerId: 'cus_owner',
      productId: plan === 'photo-pack' ? 'pdt_pack' : 'pdt_creator',
      quantity: 1,
      currency: 'INR',
      status: 'succeeded',
      total: plan === 'photo-pack' ? 29900 : 69900,
      refunded: 0,
      held: false,
      createdAt: now,
      observedAt: now,
      setupOnly: false,
      sessionId: `cks_${orderId}`,
      ...(plan === 'creator'
        ? {
            subscription: {
              id: 'sub_owner',
              orderId,
              customerId: 'cus_owner',
              productId: 'pdt_creator',
              status: 'active',
              nextBillingAt: addMonths(now, 1),
              cancelAtPeriodEnd: false,
              observedAt: now,
            },
          }
        : {}),
    };
    return payment;
  }
  return { store, provider, service, purchase };
}
const event = (
  payment: PaymentSnapshot,
  id = randomUUID(),
): VerifiedBillingEvent => ({ id, type: 'payment.succeeded', payment });

describe('cancellation provider boundary', () => {
  it('persists uncertainty before provider I/O and clears it after a confirmed retry', async () => {
    const { store, provider, service, purchase } = fixture();
    const payment = await purchase('creator');
    await service.apply(event(payment));
    const before = await service.summary(user.id);
    const account = () =>
      store.rows.get(service.key('account', user.id))!.value as BillingAccount;
    provider.readSubscription = vi.fn(async () => {
      expect(account().pendingSubscriptionCancellations?.sub_owner).toEqual(
        expect.any(String),
      );
      throw new Error('Synthetic provider timeout');
    });
    provider.cancelSubscription = vi.fn(async () => {
      expect(account().pendingSubscriptionCancellations?.sub_owner).toEqual(
        expect.any(String),
      );
      return {
        ...payment.subscription!,
        cancelAtPeriodEnd: true,
        observedAt: new Date(Date.now() + 10).toISOString(),
      };
    });
    await expect(
      service.cancelSubscription(user.id, 'sub_owner', false),
    ).rejects.toThrow('Synthetic provider timeout');
    const intent = account().pendingSubscriptionCancellations?.sub_owner;
    expect(intent).toEqual(expect.any(String));
    expect(
      (await service.summary(user.id)).subscriptions[0]?.cancellationPending,
    ).toBe(true);
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
    expect((await service.summary(user.id)).photosRemaining).toBe(
      before.photosRemaining,
    );
    provider.readSubscription = vi.fn(async () => {
      expect(account().pendingSubscriptionCancellations?.sub_owner).toBe(
        intent,
      );
      return payment.subscription!;
    });
    const result = await service.cancelSubscription(
      user.id,
      'sub_owner',
      false,
    );
    expect(provider.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(result.subscriptions[0]?.cancelAtPeriodEnd).toBe(true);
    expect(result.subscriptions[0]?.cancellationPending).toBe(false);
    expect(
      account().pendingSubscriptionCancellations?.sub_owner,
    ).toBeUndefined();
    expect(result.photosRemaining).toBe(before.photosRemaining);
  });

  it('does not contact the provider when a plan submission is already reserved', async () => {
    const { store, provider, service, purchase } = fixture();
    const payment = await purchase('creator');
    await service.apply(event(payment));
    store.rows.set(service.key('plan-quote', `${user.id}:sub_owner`), {
      owner: `test_mode:${user.id}`,
      kind: 'event',
      value: {
        version: 1,
        ownerId: user.id,
        subscriptionId: 'sub_owner',
        status: 'submitting',
      },
    });
    provider.readSubscription = vi.fn(async () => payment.subscription!);
    provider.cancelSubscription = vi.fn(async () => payment.subscription!);
    await expect(
      service.cancelSubscription(user.id, 'sub_owner', false),
    ).rejects.toMatchObject({ code: 'PLAN_CHANGE_CONFLICT' });
    expect(provider.readSubscription).not.toHaveBeenCalled();
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
  });
});

describe('transactional billing and explicit allowances', () => {
  it('grants the preview once and never renews it on refresh', async () => {
    const { service, store } = fixture();
    expect((await service.summary(user.id)).photosRemaining).toBe(20);
    await service.reserve(user.id, 'index', 2);
    expect((await service.summary(user.id)).photosRemaining).toBe(18);
    expect(
      [...store.rows.values()].filter((row) => row.kind === 'grant'),
    ).toHaveLength(1);
  });
  it('serializes concurrent requests without allowing negative credits', async () => {
    const { service } = fixture();
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, () => service.reserve(user.id, 'index')),
    );
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      20,
    );
    expect((await service.summary(user.id)).photosRemaining).toBe(0);
    await expect(service.reserve(user.id, 'index')).rejects.toMatchObject({
      status: 402,
    });
  });
  it('reuses an owned checkout attempt and does not grant on checkout return', async () => {
    const { service, provider } = fixture();
    const id = randomUUID();
    const first = await service.checkout(user, id, 'photo-pack', 'INR');
    expect(await service.checkout(user, id, 'photo-pack', 'INR')).toEqual(
      first,
    );
    expect(provider.checkout).toHaveBeenCalledTimes(1);
    expect((await service.summary(user.id)).photosRemaining).toBe(20);
    await expect(
      service.checkout(user, id, 'creator', 'INR'),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('deduplicates both webhook IDs and payments under different webhook IDs', async () => {
    const { service, purchase } = fixture();
    const payment = await purchase();
    const first = event(payment);
    await service.apply(first);
    await service.apply(first);
    await service.apply(event(payment));
    expect((await service.summary(user.id)).photosRemaining).toBe(1020);
  });
  it('preserves a refund received before the payment webhook', async () => {
    const { service, purchase } = fixture();
    const payment = await purchase();
    await service.apply(
      event({
        ...payment,
        refunded: payment.total,
        observedAt: new Date(Date.now() + 1000).toISOString(),
      }),
    );
    await service.apply(event(payment));
    expect((await service.summary(user.id)).photosRemaining).toBe(20);
  });
  it('partial refunds cannot restore already consumed credits', async () => {
    const { service, purchase } = fixture();
    const payment = await purchase();
    await service.apply(event(payment));
    await service.reserve(user.id, 'index', 30);
    await service.apply(
      event({
        ...payment,
        refunded: payment.total / 2,
        observedAt: new Date(Date.now() + 1000).toISOString(),
      }),
    );
    expect((await service.summary(user.id)).photosRemaining).toBe(490);
  });
  it('holds a disputed grant and releases it after a newer resolution', async () => {
    const { service, purchase } = fixture();
    const payment = await purchase();
    await service.apply(event({ ...payment, held: true }));
    expect((await service.summary(user.id)).photosRemaining).toBe(20);
    await service.apply(
      event({
        ...payment,
        observedAt: new Date(Date.now() + 1000).toISOString(),
      }),
    );
    expect((await service.summary(user.id)).photosRemaining).toBe(1020);
  });
  it('does not grant credits for subscription activation or failed payments', async () => {
    const { service, purchase } = fixture();
    const payment = await purchase('creator');
    await service.apply({
      id: randomUUID(),
      type: 'subscription.active',
      subscription: payment.subscription!,
    });
    await service.apply(event({ ...payment, status: 'failed' }));
    expect((await service.summary(user.id)).photosRemaining).toBe(20);
    await service.apply(event(payment));
    expect((await service.summary(user.id)).photosRemaining).toBe(2520);
  });
  it('does not mint paid credits for payment-method setup charges', async () => {
    const { service, purchase } = fixture();
    const payment = await purchase();
    await service.apply(event({ ...payment, setupOnly: true }));
    expect((await service.summary(user.id)).photosRemaining).toBe(20);
  });
  it('rejects mismatched products, currencies, quantities, customers and sessions', async () => {
    const { service, purchase } = fixture();
    const payment = await purchase();
    for (const delta of [
      { productId: 'pdt_other' },
      { currency: 'USD' },
      { quantity: 2 },
      { sessionId: 'cks_other' },
    ])
      await expect(
        service.apply(event({ ...payment, ...delta })),
      ).rejects.toMatchObject({ status: 400 });
    await service.apply(event(payment));
    await expect(
      service.apply(event({ ...payment, customerId: 'cus_other' })),
    ).rejects.toMatchObject({ status: 400 });
    expect((await service.summary(user.id)).photosRemaining).toBe(1020);
  });
  it('requires verified accounts and explicit activation to start checkout', async () => {
    const { service, provider } = fixture();
    await expect(
      service.checkout(
        { ...user, emailVerified: false },
        randomUUID(),
        'photo-pack',
        'INR',
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      fixture(false).service.checkout(user, randomUUID(), 'photo-pack', 'INR'),
    ).rejects.toMatchObject({ status: 503 });
    expect(provider.checkout).not.toHaveBeenCalled();
  });
  it('keeps balances isolated between accounts and test/live environments', async () => {
    const { service, store, purchase } = fixture();
    await service.apply(event(await purchase()));
    expect((await service.summary('another-user')).photosRemaining).toBe(20);
    const live = new BillingService(store, undefined, {}, 'live_mode', false);
    expect((await live.summary(user.id)).photosRemaining).toBe(20);
  });
  it('treats month-end expiry correctly and excludes expired/held grants', () => {
    expect(addMonths('2026-01-31T10:00:00.000Z', 1)).toBe(
      '2026-02-28T10:00:00.000Z',
    );
    const grant = newGrant(
      'a',
      user.id,
      'photo-pack',
      '2025-01-01T00:00:00.000Z',
    );
    expect(remaining(grant, 'index', Date.parse('2026-02-01'))).toBe(0);
    expect(
      remaining({ ...grant, held: true }, 'search', Date.parse('2025-01-02')),
    ).toBe(0);
  });
});

describe('billing lifecycle safety', () => {
  it('resumes the same pending selection after a reload without another order', async () => {
    const { service, provider, store } = fixture();
    const first = await service.checkout(user, randomUUID(), 'creator', 'INR');
    expect(
      await service.checkout(user, randomUUID(), 'creator', 'INR'),
    ).toEqual(first);
    expect(provider.checkout).toHaveBeenCalledTimes(1);
    expect(
      [...store.rows.values()].filter((row) => row.kind === 'order'),
    ).toHaveLength(1);
  });
  it('rejects a different pending selection instead of creating a second payable checkout', async () => {
    const { service, provider } = fixture();
    await service.checkout(user, randomUUID(), 'creator', 'INR');
    await expect(
      service.checkout(user, randomUUID(), 'photo-pack', 'INR'),
    ).rejects.toMatchObject({ code: 'CHECKOUT_PENDING' });
    expect(provider.checkout).toHaveBeenCalledTimes(1);
  });
  it('keeps an uncertain provider request recoverable instead of changing the order', async () => {
    const { service, provider } = fixture();
    vi.mocked(provider.checkout).mockRejectedValueOnce(
      new ApiError(503, 'CHECKOUT_UNAVAILABLE', 'Synthetic lost response.'),
    );
    await expect(
      service.checkout(user, randomUUID(), 'creator', 'INR'),
    ).rejects.toMatchObject({ status: 503 });
    await service.checkout(user, randomUUID(), 'creator', 'INR');
    expect(vi.mocked(provider.checkout).mock.calls[0]![0].id).toBe(
      vi.mocked(provider.checkout).mock.calls[1]![0].id,
    );
  });
});

describe('verified billing recovery and cancellation', () => {
  it('a stale saved-order resume never creates another payable checkout', async () => {
    const { service, provider, purchase } = fixture();
    const payment = await purchase();
    await service.apply(event(payment));
    await expect(
      service.resumeCheckout(user, payment.orderId),
    ).rejects.toMatchObject({ code: 'CHECKOUT_PAID' });
    expect(provider.checkout).toHaveBeenCalledTimes(1);
  });
  it('saved-order resume enforces ownership and never accepts a new order ID', async () => {
    const { service, provider, purchase } = fixture();
    const payment = await purchase();
    await expect(
      service.resumeCheckout({ ...user, id: 'another-user' }, payment.orderId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.resumeCheckout(user, 'missing-order'),
    ).rejects.toMatchObject({ status: 404 });
    expect(provider.checkout).toHaveBeenCalledTimes(1);
  });
  it('serializes concurrent checkout starts and exposes a resumable saved selection', async () => {
    const { service, provider } = fixture();
    const results = await Promise.all([
      service.checkout(user, randomUUID(), 'creator', 'INR'),
      service.checkout(user, randomUUID(), 'creator', 'INR'),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(provider.checkout).toHaveBeenCalledTimes(1);
    const summary = await service.summary(user.id);
    expect(summary.pendingCheckouts).toEqual([
      expect.objectContaining({
        plan: 'creator',
        currency: 'INR',
        canResume: true,
      }),
    ]);
    expect(JSON.stringify(summary.pendingCheckouts)).not.toContain('https:');
  });
  it('cannot reuse an old checkout after a subscription activation is confirmed', async () => {
    const { service, purchase } = fixture();
    const payment = await purchase('creator');
    await service.apply({
      id: randomUUID(),
      type: 'subscription.active',
      subscription: payment.subscription!,
    });
    await expect(
      service.checkout(user, randomUUID(), 'creator', 'INR'),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_EXISTS' });
    expect((await service.summary(user.id)).photosRemaining).toBe(20);
  });
  it('reconciles an owned successful checkout exactly once without trusting a redirect', async () => {
    const { service, provider, purchase } = fixture();
    const payment = await purchase();
    provider.inspectCheckout = vi.fn(async () => event(payment));
    provider.readSubscription = vi.fn();
    await service.reconcile(user.id);
    await service.reconcile(user.id);
    expect((await service.summary(user.id)).photosRemaining).toBe(1020);
    expect((await service.summary(user.id)).pendingCheckouts).toEqual([]);
    expect(provider.inspectCheckout).toHaveBeenCalledTimes(1);
  });
  it('only provider-confirmed failed or cancelled payments release the saved checkout', async () => {
    const { service, provider, purchase } = fixture();
    const payment = await purchase();
    provider.inspectCheckout = vi.fn(async () => null);
    await service.reconcile(user.id);
    await expect(
      service.checkout(user, randomUUID(), 'creator', 'INR'),
    ).rejects.toMatchObject({ code: 'CHECKOUT_PENDING' });
    provider.inspectCheckout = vi.fn(async () =>
      event({ ...payment, status: 'failed' }),
    );
    await service.reconcile(user.id);
    expect((await service.summary(user.id)).photosRemaining).toBe(20);
    await service.checkout(user, randomUUID(), 'creator', 'INR');
    expect(provider.checkout).toHaveBeenCalledTimes(2);
  });
  it('a forged reconciliation target cannot grant another purchase or erase the account', async () => {
    const { service, provider, purchase } = fixture();
    const payment = await purchase();
    provider.inspectCheckout = vi.fn(async () =>
      event({ ...payment, orderId: 'foreign-order' }),
    );
    await expect(service.reconcile(user.id)).rejects.toMatchObject({
      code: 'BILLING_RECONCILIATION_PENDING',
    });
    await expect(service.prepareDeletion(user.id)).rejects.toMatchObject({
      status: 503,
    });
    expect((await service.summary(user.id)).photosRemaining).toBe(20);
    expect((await service.summary(user.id)).deletionPending).toBe(false);
  });
  it('blocks deletion of renewing and scheduled-to-cancel subscriptions', async () => {
    const { service, provider, purchase } = fixture();
    const payment = await purchase('creator');
    await service.apply(event(payment));
    provider.readSubscription = vi.fn(async () => payment.subscription!);
    await expect(service.prepareDeletion(user.id)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_ACTIVE',
    });
    provider.readSubscription = vi.fn(async () => ({
      ...payment.subscription!,
      cancelAtPeriodEnd: true,
      observedAt: new Date(Date.now() + 1000).toISOString(),
    }));
    await expect(service.prepareDeletion(user.id)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_ACTIVE',
    });
  });
  it('requires ownership before any cancellation provider call', async () => {
    const { service, provider } = fixture();
    provider.readSubscription = vi.fn();
    provider.cancelSubscription = vi.fn();
    await expect(
      service.cancelSubscription(user.id, 'sub_other', true),
    ).rejects.toMatchObject({ status: 404 });
    expect(provider.readSubscription).not.toHaveBeenCalled();
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
  });
  it('cancellation is explicit, idempotent and never revokes or mints paid credits', async () => {
    const { service, provider, purchase } = fixture();
    const payment = await purchase('creator');
    await service.apply(event(payment));
    let current = payment.subscription!;
    provider.readSubscription = vi.fn(async () => current);
    provider.cancelSubscription = vi.fn(async (_id, immediately) => {
      current = {
        ...current,
        status: immediately ? 'cancelled' : 'active',
        cancelAtPeriodEnd: !immediately,
        observedAt: new Date().toISOString(),
      };
      return current;
    });
    await service.cancelSubscription(user.id, current.id, false);
    await service.cancelSubscription(user.id, current.id, false);
    expect(provider.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(
      (await service.summary(user.id)).subscriptions[0]!.cancelAtPeriodEnd,
    ).toBe(true);
    await service.cancelSubscription(user.id, current.id, true);
    expect(provider.cancelSubscription).toHaveBeenCalledTimes(2);
    expect((await service.summary(user.id)).photosRemaining).toBe(2520);
    await service.prepareDeletion(user.id);
    await service.prepareDeletion(user.id);
    await expect(
      service.checkout(user, randomUUID(), 'photo-pack', 'INR'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_PENDING' });
    expect((await service.summary(user.id)).checkoutAvailable).toBe(false);
  });
  it('a cancellation timeout remains unconfirmed until a later authoritative refresh', async () => {
    const { service, provider, purchase } = fixture();
    const payment = await purchase('creator');
    await service.apply(event(payment));
    provider.readSubscription = vi.fn(async () => payment.subscription!);
    provider.cancelSubscription = vi.fn(async () => {
      throw new ApiError(503, 'CANCELLATION_UNAVAILABLE', 'Synthetic timeout.');
    });
    await expect(
      service.cancelSubscription(user.id, 'sub_owner', true),
    ).rejects.toMatchObject({ status: 503 });
    expect((await service.summary(user.id)).subscriptions[0]!.status).toBe(
      'active',
    );
    provider.readSubscription = vi.fn(async () => ({
      ...payment.subscription!,
      status: 'cancelled',
      observedAt: new Date().toISOString(),
    }));
    await service.reconcile(user.id);
    expect((await service.summary(user.id)).subscriptions[0]!.status).toBe(
      'cancelled',
    );
  });
  it('an unexpected subscription response cannot cancel or bind a foreign customer', async () => {
    const { service, provider, purchase } = fixture();
    const payment = await purchase('creator');
    await service.apply(event(payment));
    provider.readSubscription = vi.fn(async () => ({
      ...payment.subscription!,
      customerId: 'cus_foreign',
    }));
    provider.cancelSubscription = vi.fn();
    await expect(
      service.cancelSubscription(user.id, 'sub_owner', true),
    ).rejects.toMatchObject({ status: 503 });
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
  });
  it('deletion and a new checkout cannot both win the durable account fence', async () => {
    const { service } = fixture();
    const result = await Promise.allSettled([
      service.prepareDeletion(user.id),
      service.checkout(user, randomUUID(), 'photo-pack', 'INR'),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('keeps account data intact when billing blocks the deletion API', async () => {
    const f = fixture();
    const payment = await f.purchase('creator');
    await f.service.apply(event(payment));
    f.provider.readSubscription = vi.fn(async () => payment.subscription!);
    const auth = {
      getUser: vi.fn(async () => user),
      login: vi.fn(async () => ({
        secret: 'temporary',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      })),
      logout: vi.fn(async () => {}),
      deleteUser: vi.fn(async () => {}),
      verifyActionCode: vi.fn(async () => {}),
    } as unknown as AuthenticationProvider;
    const list = vi.fn(async () => []);
    const app = createApp(
      {
        provider: auth,
        webOrigin: 'http://127.0.0.1:5173',
        secureCookies: false,
      },
      {
        store: {
          list,
        } as unknown as import('../../apps/api/src/library.js').LibraryStore,
      },
      f.service,
    );
    const result = await request(app)
      .delete('/api/account')
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Cookie', 'picfind_session=test')
      .send({
        password: 'test-password',
        confirmation: 'DELETE',
        emailCode: '123456',
      });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('SUBSCRIPTION_ACTIVE');
    expect(list).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });
});

describe('atomic storage allowances', () => {
  it('bootstraps existing bytes once and reserves each upload exactly once', async () => {
    const { service, store } = fixture();
    const baseline = vi.fn(async () => 3000);
    await service.reserveStorage(user.id, 'photo-a', 2000, baseline);
    await service.reserveStorage(user.id, 'photo-a', 2000, baseline);
    await service.reserveStorage(user.id, 'photo-b', 4000, baseline);
    const account = await store.transaction((tx) =>
      tx.get<{ storedBytes: number }>(service.key('account', user.id)),
    );
    expect(account?.storedBytes).toBe(9000);
    expect(baseline).toHaveBeenCalledTimes(1);
  });
  it('cannot overspend storage in concurrent uploads', async () => {
    const { service } = fixture();
    await service.reserveStorage(
      user.id,
      'large-photo',
      99999999,
      async () => 0,
    );
    const results = await Promise.allSettled(
      ['a', 'b'].map((id) =>
        service.reserveStorage(user.id, id, 1, async () => 0),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await service.summary(user.id)).storageBytesUsed).toBe(100000000);
  });
  it('repeated deletion cannot free another photo reservation', async () => {
    const { service } = fixture();
    await service.reserveStorage(user.id, 'a', 4000, async () => 0);
    await service.reserveStorage(user.id, 'b', 5000, async () => 0);
    await service.releaseStorage(user.id, 'a', 4000, async () => 0);
    await service.releaseStorage(user.id, 'a', 4000, async () => 0);
    expect((await service.summary(user.id)).storageBytesUsed).toBe(5000);
    await expect(
      service.reserveStorage(user.id, 'a', 4000, async () => 0),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('deletion bootstraps pre-existing files before subtracting their bytes', async () => {
    const { service } = fixture();
    await service.releaseStorage(
      user.id,
      'legacy-photo',
      1000,
      async () => 3000,
    );
    expect((await service.summary(user.id)).storageBytesUsed).toBe(2000);
  });
  it('refunds reduce capacity without silently deleting retained photos', async () => {
    const { service, purchase } = fixture();
    const payment = await purchase();
    await service.apply(event(payment));
    await service.reserveStorage(
      user.id,
      'large-paid-photo',
      200000000,
      async () => 0,
    );
    await service.apply(
      event({
        ...payment,
        refunded: payment.total,
        observedAt: new Date(Date.now() + 1000).toISOString(),
      }),
    );
    await expect(
      service.reserveStorage(user.id, 'next-photo', 1, async () => 0),
    ).rejects.toMatchObject({ status: 402 });
    expect((await service.summary(user.id)).storageBytesUsed).toBe(200000000);
  });
  it('one account cannot release another account storage reservation', async () => {
    const { service } = fixture();
    await service.reserveStorage(user.id, 'private-photo', 5000, async () => 0);
    await expect(
      service.releaseStorage(
        'another-user',
        'private-photo',
        5000,
        async () => 0,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect((await service.summary(user.id)).storageBytesUsed).toBe(5000);
  });
});

describe('billing API trust boundaries', () => {
  function app() {
    const f = fixture();
    const auth = {
      getUser: vi.fn(async () => user),
    } as unknown as AuthenticationProvider;
    return {
      ...f,
      app: createApp(
        {
          provider: auth,
          webOrigin: 'http://127.0.0.1:5173',
          secureCookies: false,
        },
        {},
        f.service,
      ),
    };
  }
  it('requires session and trusted Origin, rejects client-set prices', async () => {
    const f = app();
    expect((await request(f.app).get('/api/billing')).status).toBe(401);
    expect(
      (
        await request(f.app)
          .post('/api/billing/checkout')
          .set('Cookie', 'picfind_session=test')
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(f.app)
          .post('/api/billing/checkout')
          .set('Origin', 'http://127.0.0.1:5173')
          .set('Cookie', 'picfind_session=test')
          .send({
            requestId: randomUUID(),
            plan: 'photo-pack',
            currency: 'INR',
            acceptedTerms: true,
            price: 1,
          })
      ).status,
    ).toBe(400);
    expect(f.provider.checkout).not.toHaveBeenCalled();
  });
  it('passes raw bytes to verification without requiring a browser Origin', async () => {
    const f = app();
    vi.mocked(f.provider.verify).mockResolvedValue({
      id: 'signed-test',
      type: 'ignored',
    });
    const body = '{ "type": "ignored" }';
    expect(
      (
        await request(f.app)
          .post('/api/billing/webhook')
          .set('Content-Type', 'application/json')
          .set('webhook-id', 'signed-test')
          .send(body)
      ).status,
    ).toBe(200);
    expect(f.provider.verify).toHaveBeenCalledWith(
      body,
      expect.objectContaining({ 'webhook-id': 'signed-test' }),
    );
  });
  it('resume API is bound to the saved order and requires the session and Origin', async () => {
    const f = app();
    const payment = await f.purchase();
    const path = `/api/billing/checkout/${payment.orderId}/resume`;
    await request(f.app)
      .post(path)
      .set('Origin', 'http://127.0.0.1:5173')
      .send({})
      .expect(401);
    await request(f.app)
      .post(path)
      .set('Origin', 'https://foreign.test')
      .set('Cookie', 'picfind_session=test')
      .send({})
      .expect(403);
    await request(f.app)
      .post(path)
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Cookie', 'picfind_session=test')
      .send({ plan: 'creator' })
      .expect(400);
    await request(f.app)
      .post(path)
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Cookie', 'picfind_session=test')
      .send({})
      .expect(200);
    await f.service.apply(event(payment));
    await request(f.app)
      .post(path)
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Cookie', 'picfind_session=test')
      .send({})
      .expect(409);
    expect(f.provider.checkout).toHaveBeenCalledTimes(1);
  });
  it('cancellation API requires explicit confirmation and owned subscription', async () => {
    const f = app();
    const payment = await f.purchase('creator');
    await f.service.apply(event(payment));
    f.provider.readSubscription = vi.fn(async () => payment.subscription!);
    f.provider.cancelSubscription = vi.fn(async () => ({
      ...payment.subscription!,
      status: 'cancelled',
      observedAt: new Date().toISOString(),
    }));
    const path = '/api/billing/subscriptions/sub_owner/cancel';
    await request(f.app)
      .post(path)
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Cookie', 'picfind_session=test')
      .send({ mode: 'immediate' })
      .expect(400);
    await request(f.app)
      .post('/api/billing/subscriptions/sub_foreign/cancel')
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Cookie', 'picfind_session=test')
      .send({ mode: 'immediate', confirmed: true })
      .expect(404);
    expect(f.provider.cancelSubscription).not.toHaveBeenCalled();
    await request(f.app)
      .post(path)
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Cookie', 'picfind_session=test')
      .send({ mode: 'immediate', confirmed: true })
      .expect(200);
    expect(f.provider.cancelSubscription).toHaveBeenCalledWith(
      'sub_owner',
      true,
    );
  });
  it('verification does not accept client-supplied payment or owner IDs', async () => {
    const f = app();
    f.provider.inspectCheckout = vi.fn();
    await request(f.app)
      .post('/api/billing/reconcile')
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Cookie', 'picfind_session=test')
      .send({ ownerId: 'foreign', paymentId: 'pay_foreign' })
      .expect(400);
    expect(f.provider.inspectCheckout).not.toHaveBeenCalled();
  });
  it('retains the raw webhook contract after adding billing actions', async () => {
    const f = app();
    vi.mocked(f.provider.verify).mockResolvedValue({
      id: 'signed-test',
      type: 'ignored',
    });
    const body = '{ "type": "ignored" }';
    expect(
      (
        await request(f.app)
          .post('/api/billing/webhook')
          .set('Content-Type', 'application/json')
          .set('webhook-id', 'signed-test')
          .send(body)
      ).status,
    ).toBe(200);
    expect(f.provider.verify).toHaveBeenCalledWith(
      body,
      expect.objectContaining({ 'webhook-id': 'signed-test' }),
    );
  });
  it('rejects invalid webhook signatures and does not grant anything', async () => {
    const provider = new DodoBillingProvider({
      apiKey: 'synthetic-unused',
      webhookSecret: Buffer.alloc(32, 3).toString('base64'),
      environment: 'test_mode',
      webOrigin: 'http://127.0.0.1:5173',
    });
    await expect(
      provider.verify('{}', {
        'webhook-id': 'msg_fake',
        'webhook-signature': 'v1,bad',
        'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('accepts a correctly signed exact body and rejects tampering and stale delivery', async () => {
    const secret = Buffer.alloc(32, 3);
    const provider = new DodoBillingProvider({
      apiKey: 'synthetic-unused',
      webhookSecret: secret.toString('base64'),
      environment: 'test_mode',
      webOrigin: 'http://127.0.0.1:5173',
    });
    const raw = JSON.stringify({
      type: 'payout.created',
      timestamp: new Date().toISOString(),
      business_id: 'synthetic',
      data: {},
    });
    const id = 'msg_signed';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret)
      .update(`${id}.${timestamp}.${raw}`)
      .digest('base64');
    const headers = {
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    };
    expect(await provider.verify(raw, headers)).toEqual({
      id,
      type: 'payout.created',
    });
    await expect(provider.verify(raw + ' ', headers)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      provider.verify(raw, { ...headers, 'webhook-timestamp': '1' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
