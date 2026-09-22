import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingService } from '../../apps/api/src/billing/service.js';
import {
  addMonths,
  newGrant,
  planById,
  remaining,
  isSubscriptionPlan,
  PAID_PLAN_IDS,
  type BillingOrder,
  type BillingProvider,
  type Grant,
  type PaymentSnapshot,
  type PlanId,
  type ProductMap,
} from '../../apps/api/src/billing/model.js';
import { currentAllowanceWindow } from '../../apps/api/src/billing/allowance-windows.js';
import { ImportTestBillingStore } from '../helpers/cloud-import-billing-store.js';

afterEach(() => vi.useRealTimers());
const anchor = '2026-01-31T12:00:00.000Z';
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
  const store = new ImportTestBillingStore(),
    owner = randomUUID();
  const products = Object.fromEntries(
    PAID_PLAN_IDS.map((plan) => [
      plan + ':INR',
      'pdt_' + plan.replace(/-/g, ''),
    ]),
  ) as ProductMap;
  const provider: BillingProvider = {
    checkout: vi.fn(async (order) => ({
      sessionId: 'session_' + order.id,
      url: 'https://checkout.example.test/' + order.id,
    })),
    portal: vi.fn(),
    verify: vi.fn(),
  };
  // Only this synthetic service opts in. Environment bootstrap remains closed.
  const billing = new BillingService(
    store,
    provider,
    products,
    'test_mode',
    true,
    true,
  );
  const user = {
    id: owner,
    email: 'synthetic@example.test',
    name: 'Synthetic',
    emailVerified: true,
  };
  await billing.summary(owner);
  vi.setSystemTime(new Date(anchor));
  async function pay(plan: PlanId) {
    const requestId = randomUUID();
    await billing.checkout(user, requestId, plan, 'INR');
    const order = (await store.transaction((tx) =>
      tx.get<BillingOrder>(billing.key('order', owner + ':' + requestId)),
    ))!;
    const createdAt = new Date().toISOString();
    const payment: PaymentSnapshot = {
      id: 'pay_' + randomUUID(),
      orderId: order.id,
      customerId: 'customer_synthetic',
      productId: order.productId,
      quantity: 1,
      currency: 'INR',
      status: 'succeeded',
      total: planById(plan).inr * 100,
      refunded: 0,
      held: false,
      createdAt,
      observedAt: createdAt,
      setupOnly: false,
      sessionId: order.sessionId!,
      ...(isSubscriptionPlan(plan)
        ? {
            subscription: {
              id: 'sub_' + randomUUID(),
              orderId: order.id,
              customerId: 'customer_synthetic',
              productId: order.productId,
              status: 'active',
              nextBillingAt: addMonths(
                createdAt,
                planById(plan).cadence === 'year' ? 12 : 1,
              ),
              cancelAtPeriodEnd: false,
              observedAt: createdAt,
            },
          }
        : {}),
    };
    await billing.apply({
      id: randomUUID(),
      type: 'payment.succeeded',
      payment,
    });
    return { payment, order };
  }
  return { store, owner, provider, products, billing, user, pay };
}

describe('personal and organizer grant isolation with synthetic verified payments', () => {
  it('does not let organizer processing spend personal packs or vice versa', async () => {
    const f = await fixture();
    await f.pay('personal-250');
    await f.pay('organizer-pro-yearly');
    await f.billing.reserve(f.owner, 'index', 2501, undefined, 'organizer');
    await f.billing.reserve(f.owner, 'search', 40, undefined, 'organizer');
    const summary = await f.billing.summary(f.owner);
    expect(summary.balances.personal).toMatchObject({
      photosRemaining: 250,
      searchesRemaining: 250,
    });
    expect(summary.balances.organizer).toMatchObject({
      photosRemaining: 7499,
      searchesRemaining: 1460,
    });
    await expect(
      f.billing.reserve(f.owner, 'index', 251, undefined, 'personal'),
    ).rejects.toMatchObject({ code: 'ALLOWANCE_EXHAUSTED' });
    await expect(f.billing.reserve(f.owner, 'index')).rejects.toMatchObject({
      code: 'ALLOWANCE_EXHAUSTED',
    });
    expect(
      (await f.billing.summary(f.owner)).balances.organizer!.photosRemaining,
    ).toBe(7499);
  });
  it('allows a personal pack purchase while the same account has an organizer subscription', async () => {
    const f = await fixture();
    await f.pay('organizer-starter-monthly');
    await f.pay('personal-500');
    expect(
      (await f.billing.summary(f.owner)).balances.personal!.photosRemaining,
    ).toBe(500);
    await expect(f.pay('organizer-pro-monthly')).rejects.toMatchObject({
      code: 'SUBSCRIPTION_EXISTS',
    });
  });
  it('does not let a personal payment create an organizer entitlement', async () => {
    const f = await fixture();
    await f.pay('personal-1000');
    expect(await f.billing.organizerEntitlement(f.owner)).toBeNull();
    await expect(
      f.billing.retentionDays(f.owner, 'organizer'),
    ).rejects.toMatchObject({ code: 'ORGANIZER_PLAN_REQUIRED' });
    expect(await f.billing.retentionDays(f.owner, 'personal')).toBe(30);
  });
  it.each([
    ['organizer-starter-monthly', 30, 2],
    ['organizer-pro-yearly', 90, 10],
    ['organizer-scale-yearly', 365, 50],
  ] as const)(
    'resolves the paid retention and live-event caps for %s',
    async (plan, retentionDays, liveEvents) => {
      const f = await fixture();
      await f.pay(plan);
      expect(await f.billing.organizerEntitlement(f.owner)).toMatchObject({
        plan,
        retentionDays,
        liveEvents,
      });
    },
  );
  it('keeps newly configured products unavailable until the role rollout is activated', async () => {
    const f = await fixture();
    const closed = new BillingService(
      f.store,
      f.provider,
      f.products,
      'test_mode',
      true,
    );
    await expect(
      closed.checkout(f.user, randomUUID(), 'personal-250', 'INR'),
    ).rejects.toMatchObject({ code: 'BILLING_DISABLED' });
    expect((await closed.summary(f.owner)).products).not.toContain(
      'personal-250:INR',
    );
    expect(f.provider.checkout).not.toHaveBeenCalled();
  });
  it('does not let old storage callers implicitly spend a new role plan', async () => {
    const f = await fixture();
    await f.pay('personal-1000');
    await expect(
      f.billing.reserveStorage(f.owner, randomUUID(), 100, async () => 0),
    ).rejects.toMatchObject({ code: 'STORAGE_ALLOWANCE_EXHAUSTED' });
  });
});

describe('monthly windows backed by one verified annual payment', () => {
  it('releases one month at a time, without multiplying storage or rolling unused credits forward', async () => {
    const f = await fixture();
    await f.pay('organizer-pro-yearly');
    await f.billing.reserve(f.owner, 'index', 100, undefined, 'organizer');
    expect((await f.billing.summary(f.owner)).balances.organizer).toMatchObject(
      { photosRemaining: 9900, storageBytesLimit: 50e9 },
    );
    vi.setSystemTime(new Date('2026-02-28T11:59:59.000Z'));
    expect(
      (await f.billing.summary(f.owner)).balances.organizer!.photosRemaining,
    ).toBe(9900);
    vi.setSystemTime(new Date('2026-02-28T12:00:00.000Z'));
    expect((await f.billing.summary(f.owner)).balances.organizer).toMatchObject(
      { photosRemaining: 10000, storageBytesLimit: 50e9 },
    );
    await f.billing.reserve(f.owner, 'index', 50, undefined, 'organizer');
    vi.setSystemTime(new Date('2026-03-30T12:00:00.000Z'));
    expect(
      (await f.billing.summary(f.owner)).balances.organizer!.photosRemaining,
    ).toBe(9950);
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    expect(
      (await f.billing.summary(f.owner)).balances.organizer!.photosRemaining,
    ).toBe(10000);
    const rows = await f.store.transaction((tx) =>
      tx.list<Grant>('test_mode:' + f.owner, 'grant'),
    );
    expect(rows.filter((grant) => grant.parentGrantId)).toHaveLength(3);
    expect(rows.find((grant) => grant.windowIndex === 0)?.usedPhotos).toBe(100);
    expect(rows.find((grant) => grant.windowIndex === 1)?.usedPhotos).toBe(50);
  });
  it('does not renew a monthly plan just because the provider still calls its subscription active', async () => {
    const f = await fixture();
    await f.pay('organizer-starter-monthly');
    vi.setSystemTime(new Date('2026-02-28T12:00:00.000Z'));
    expect(
      (await f.billing.summary(f.owner)).balances.organizer!.photosRemaining,
    ).toBe(0);
    expect(await f.billing.organizerEntitlement(f.owner)).toBeNull();
  });
  it('expires the annual entitlement at the paid year boundary', async () => {
    const f = await fixture();
    await f.pay('organizer-pro-yearly');
    vi.setSystemTime(new Date('2027-01-31T12:00:00.000Z'));
    expect(
      (await f.billing.summary(f.owner)).balances.organizer!.photosRemaining,
    ).toBe(0);
    expect(await f.billing.organizerEntitlement(f.owner)).toBeNull();
  });
  it('preserves leap-day anchors and never exposes future paid windows', () => {
    const root = newGrant(
      'synthetic',
      'owner',
      'organizer-pro-yearly',
      '2024-02-29T12:00:00.000Z',
    );
    expect(
      currentAllowanceWindow(root, Date.parse('2024-02-28T12:00:00.000Z')),
    ).toBeNull();
    expect(
      currentAllowanceWindow(root, Date.parse('2024-03-29T12:00:00.000Z')),
    ).toMatchObject({ index: 1, createdAt: '2024-03-29T12:00:00.000Z' });
    expect(
      currentAllowanceWindow(root, Date.parse('2025-02-28T12:00:00.000Z')),
    ).toBeNull();
    expect(
      remaining(root, 'index', Date.parse('2024-03-29T12:00:00.000Z')),
    ).toBe(0);
  });
  it('refunds failed delivery into its original window, never the next month', async () => {
    const f = await fixture();
    await f.pay('organizer-pro-yearly');
    await f.billing.reserveDelivery(f.owner, 'old-window', 1000, 'organizer');
    vi.setSystemTime(new Date('2026-02-28T12:00:00.000Z'));
    await f.billing.reserveDelivery(f.owner, 'new-window', 500, 'organizer');
    await f.billing.refundDelivery(
      f.owner,
      'old-window',
      'upstream-http-failure',
    );
    expect(
      (await f.billing.summary(f.owner)).balances.organizer!
        .deliveryBytesRemaining,
    ).toBe(25e9 - 500);
    await expect(
      f.billing.reserveDelivery(f.owner, 'new-window', 500, 'personal'),
    ).rejects.toMatchObject({ code: 'DELIVERY_RESERVATION_CONFLICT' });
  });
  it('propagates holds and partial refunds to future windows without resetting already-used credits', async () => {
    const f = await fixture(),
      { payment } = await f.pay('organizer-pro-yearly');
    await f.billing.reserve(f.owner, 'index', 100, undefined, 'organizer');
    vi.setSystemTime(new Date('2026-02-01T12:00:00.000Z'));
    await f.billing.apply({
      id: randomUUID(),
      type: 'payment.held',
      payment: { ...payment, held: true, observedAt: new Date().toISOString() },
    });
    await expect(
      f.billing.reserve(f.owner, 'index', 1, undefined, 'organizer'),
    ).rejects.toMatchObject({ code: 'ALLOWANCE_EXHAUSTED' });
    vi.setSystemTime(new Date('2026-02-28T12:00:00.000Z'));
    expect(
      (await f.billing.summary(f.owner)).balances.organizer!.photosRemaining,
    ).toBe(0);
    await f.billing.apply({
      id: randomUUID(),
      type: 'payment.refunded',
      payment: {
        ...payment,
        refunded: payment.total / 2,
        observedAt: new Date().toISOString(),
      },
    });
    expect(
      (await f.billing.summary(f.owner)).balances.organizer!.photosRemaining,
    ).toBe(5000);
    await f.billing.reserve(f.owner, 'index', 40, undefined, 'organizer');
    await f.billing.apply({
      id: randomUUID(),
      type: 'payment.replayed',
      payment: { ...payment, observedAt: new Date().toISOString() },
    });
    expect(
      (await f.billing.summary(f.owner)).balances.organizer!.photosRemaining,
    ).toBe(4960);
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    expect(
      (await f.billing.summary(f.owner)).balances.organizer!.photosRemaining,
    ).toBe(5000);
  });
  it('does not create duplicate windows under concurrent reservations', async () => {
    const f = await fixture();
    await f.pay('organizer-pro-yearly');
    await Promise.all(
      Array.from({ length: 5 }, () =>
        f.billing.reserve(f.owner, 'index', 1, undefined, 'organizer'),
      ),
    );
    const summary = await f.billing.summary(f.owner);
    expect(summary.balances.organizer!.photosRemaining).toBe(9995);
    expect(summary.grants.filter((grant) => grant.parentGrantId)).toHaveLength(
      1,
    );
  });
  it('rejects an orphaned window instead of spending an unbacked allowance', async () => {
    const f = await fixture();
    await f.pay('organizer-pro-yearly');
    await f.billing.summary(f.owner);
    const child = [...f.store.rows.values()].find(
      (row) => row.kind === 'grant' && (row.value as Grant).parentGrantId,
    )!;
    (child.value as Grant).parentGrantId = 'not-a-paid-entitlement';
    await expect(
      f.billing.reserve(f.owner, 'index', 1, undefined, 'organizer'),
    ).rejects.toMatchObject({ code: 'BILLING_ACCOUNTING' });
  });
  it('treats malformed numerical balances as unavailable, not free processing', () => {
    const grant = newGrant('synthetic', 'owner', 'personal-250', anchor);
    expect(
      remaining({ ...grant, photos: NaN }, 'index', Date.parse(anchor)),
    ).toBe(0);
    expect(
      remaining({ ...grant, usedPhotos: -1 }, 'index', Date.parse(anchor)),
    ).toBe(0);
    expect(
      remaining(
        { ...grant, refundFraction: Infinity },
        'index',
        Date.parse(anchor),
      ),
    ).toBe(0);
  });
});
describe('role-scoped storage reservations', () => {
  it('keeps personal and event storage separate, including deletion releases', async () => {
    const f = await fixture();
    await f.pay('personal-250');
    await f.pay('organizer-pro-yearly');
    await f.billing.reserveStorage(
      f.owner,
      'personal-photo',
      400e6,
      async () => 0,
      'personal',
    );
    await f.billing.reserveStorage(
      f.owner,
      'event-photo',
      12e9,
      async () => 0,
      'organizer',
    );
    await expect(
      f.billing.reserveStorage(
        f.owner,
        'too-much-personal',
        200e6,
        async () => 0,
        'personal',
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_ALLOWANCE_EXHAUSTED' });
    expect((await f.billing.summary(f.owner)).storageBytesUsedByScope).toEqual({
      personal: 400e6,
      organizer: 12e9,
      legacy: 0,
    });
    await f.billing.releaseStorage(
      f.owner,
      'personal-photo',
      400e6,
      async () => 0,
    );
    expect((await f.billing.summary(f.owner)).storageBytesUsedByScope).toEqual({
      personal: 0,
      organizer: 12e9,
      legacy: 0,
    });
    await f.billing.releaseStorage(
      f.owner,
      'personal-photo',
      400e6,
      async () => 0,
    );
    expect((await f.billing.summary(f.owner)).storageBytesUsed).toBe(12e9);
  });
  it('does not count legacy shared capacity twice across roles', async () => {
    const f = await fixture();
    await f.pay('photo-pack');
    await f.billing.reserveStorage(
      f.owner,
      'personal-photo',
      1.5e9,
      async () => 0,
      'personal',
    );
    await expect(
      f.billing.reserveStorage(
        f.owner,
        'event-photo',
        0.75e9,
        async () => 0,
        'organizer',
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_ALLOWANCE_EXHAUSTED' });
    await f.billing.reserveStorage(f.owner, 'old-photo', 0.4e9, async () => 0);
    expect((await f.billing.summary(f.owner)).storageBytesUsed).toBe(1.9e9);
  });
  it('binds retries to their original storage scope', async () => {
    const f = await fixture();
    await f.pay('personal-250');
    await f.pay('organizer-pro-yearly');
    await f.billing.reserveStorage(
      f.owner,
      'attempt',
      100,
      async () => 0,
      'personal',
    );
    await f.billing.reserveStorage(
      f.owner,
      'attempt',
      100,
      async () => 0,
      'personal',
    );
    await expect(
      f.billing.reserveStorage(
        f.owner,
        'attempt',
        100,
        async () => 0,
        'organizer',
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_RESERVATION_CONFLICT' });
    expect((await f.billing.summary(f.owner)).storageBytesUsed).toBe(100);
  });
  it('initializes historical bytes as legacy without blocking independently funded new storage', async () => {
    const f = await fixture();
    await f.pay('organizer-pro-yearly');
    await f.billing.reserveStorage(
      f.owner,
      'new-event-photo',
      100,
      async () => 200e6,
      'organizer',
    );
    expect((await f.billing.summary(f.owner)).storageBytesUsedByScope).toEqual({
      legacy: 200e6,
      personal: 0,
      organizer: 100,
    });
    await expect(
      f.billing.reserveStorage(f.owner, 'new-unscoped-photo', 1, async () => 0),
    ).rejects.toMatchObject({ code: 'STORAGE_ALLOWANCE_EXHAUSTED' });
  });
  it('shares the trial only with personal/legacy uploads, never with event storage', async () => {
    const f = await fixture();
    const owner = randomUUID();
    await f.billing.reserveStorage(owner, 'legacy-trial', 60e6, async () => 0);
    await expect(
      f.billing.reserveStorage(
        owner,
        'personal-trial-too-large',
        60e6,
        async () => 0,
        'personal',
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_ALLOWANCE_EXHAUSTED' });
    await expect(
      f.billing.reserveStorage(
        owner,
        'event-trial',
        1,
        async () => 0,
        'organizer',
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_ALLOWANCE_EXHAUSTED' });
    await f.billing.reserveStorage(
      owner,
      'personal-trial',
      40e6,
      async () => 0,
      'personal',
    );
    expect((await f.billing.summary(owner)).storageBytesUsed).toBe(100e6);
  });
});
