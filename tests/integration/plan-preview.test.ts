import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';
import type { AuthOptions } from '../../apps/api/src/auth.js';
import { BillingService } from '../../apps/api/src/billing/service.js';
import { previewPlanChange } from '../../apps/api/src/billing/plan-preview.js';
import { billingId } from '../../apps/api/src/billing/model.js';
import type {
  BillingAccount,
  BillingOrder,
  BillingProvider,
  BillingStore,
  BillingTransaction,
  SubscriptionSnapshot,
} from '../../apps/api/src/billing/model.js';

function fixture(roleCatalogEnabled = false) {
  const owner = randomUUID();
  const next = new Date(Date.now() + 20 * 86400_000).toISOString();
  const subscription: SubscriptionSnapshot = {
    id: 'sub_owned',
    orderId: 'order_owned',
    customerId: 'cus_owned',
    productId: 'pdt_creator',
    status: 'active',
    nextBillingAt: next,
    cancelAtPeriodEnd: false,
    observedAt: new Date().toISOString(),
  };
  const order: BillingOrder = {
    id: 'order_owned',
    ownerId: owner,
    plan: 'creator',
    currency: 'INR',
    productId: 'pdt_creator',
    customerId: 'cus_owned',
    createdAt: new Date().toISOString(),
    fulfilled: true,
  };
  const account: BillingAccount = {
    ownerId: owner,
    customerId: 'cus_owned',
    revision: 1,
    createdAt: new Date().toISOString(),
    subscriptions: { sub_owned: subscription },
  };
  const writes = vi.fn();
  const tx: BillingTransaction = {
    get: async <T>(id: string) =>
      id === billingId('test_mode', 'account', owner)
        ? (structuredClone(account) as T)
        : null,
    list: async <T>() => [structuredClone(order) as T],
    put: writes,
  };
  const store: BillingStore = { transaction: async (work) => work(tx) };
  const provider: BillingProvider = {
    checkout: vi.fn(),
    verify: vi.fn(),
    portal: vi.fn(),
    readSubscription: vi.fn(async () => structuredClone(subscription)),
    previewPlanChange: vi.fn(async () => ({
      currency: 'INR' as const,
      chargeNow: 0,
      recurringBeforeTax: 249900,
      effectiveAt: next,
    })),
  };
  const service = new BillingService(
    store,
    provider,
    { 'creator:INR': 'pdt_creator', 'studio:INR': 'pdt_studio' },
    'test_mode',
    false,
    roleCatalogEnabled,
  );
  const run = () => previewPlanChange(service, owner, 'sub_owned', 'studio');
  const auth: AuthOptions = {
    webOrigin: 'http://localhost:5173',
    secureCookies: false,
    provider: {
      register: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getUser: async () => ({
        id: owner,
        email: 'synthetic@example.test',
        name: 'Synthetic',
        emailVerified: true,
      }),
    } as NonNullable<AuthOptions['provider']>,
  };
  return {
    owner,
    next,
    subscription,
    order,
    account,
    writes,
    tx,
    store,
    provider,
    service,
    run,
    auth,
  };
}
describe('read-only renewal plan previews', () => {
  it('uses the saved currency/product and does not write or start checkout', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result).toMatchObject({
      targetPlan: 'studio',
      currency: 'INR',
      chargeNow: 0,
      previewOnly: true,
    });
    expect(Date.parse(result.expiresAt) - Date.now()).toBeLessThanOrEqual(
      5 * 60_000,
    );
    expect(f.provider.previewPlanChange).toHaveBeenCalledWith(
      f.subscription,
      'pdt_studio',
      'INR',
      'Month',
    );
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.provider.checkout).not.toHaveBeenCalled();
  });
  it('rejects a foreign subscription before any provider read', async () => {
    const f = fixture();
    await expect(
      previewPlanChange(f.service, f.owner, 'sub_foreign', 'studio'),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.provider.readSubscription).not.toHaveBeenCalled();
  });
  it('rejects a foreign owner even if a faulty store returns another account', async () => {
    const f = fixture();
    await expect(
      previewPlanChange(f.service, 'foreign', 'sub_owned', 'studio'),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.provider.previewPlanChange).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'on_hold', 'pending', 'expired', 'failed'])(
    'rejects the %s lifecycle state',
    async (status) => {
      const f = fixture();
      f.subscription.status = status;
      await expect(f.run()).rejects.toMatchObject({
        code: 'PLAN_NOT_CHANGEABLE',
      });
    },
  );
  it('rejects scheduled cancellation, deletion and an already-selected plan', async () => {
    const f = fixture();
    f.subscription.cancelAtPeriodEnd = true;
    await expect(f.run()).rejects.toMatchObject({
      code: 'PLAN_NOT_CHANGEABLE',
    });
    f.subscription.cancelAtPeriodEnd = false;
    f.account.deletionPendingAt = new Date().toISOString();
    await expect(f.run()).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_PENDING',
    });
    delete f.account.deletionPendingAt;
    await expect(
      previewPlanChange(f.service, f.owner, 'sub_owned', 'creator'),
    ).rejects.toMatchObject({ code: 'PLAN_ALREADY_SELECTED' });
  });
  it.each([
    'customer',
    'order-owner',
    'order-product',
    'missing-product',
    'same-product',
  ])('rejects inconsistent %s binding', async (kind) => {
    const f = fixture();
    if (kind === 'customer') f.account.customerId = 'foreign';
    if (kind === 'order-owner') f.order.ownerId = 'foreign';
    if (kind === 'order-product') f.order.productId = 'foreign';
    if (kind === 'missing-product') delete f.service.products['studio:INR'];
    if (kind === 'same-product')
      f.service.products['studio:INR'] = 'pdt_creator';
    await expect(f.run()).rejects.toMatchObject({
      code: 'PLAN_PREVIEW_UNAVAILABLE',
    });
    expect(f.provider.previewPlanChange).not.toHaveBeenCalled();
  });
  it.each(['invalid', new Date(0).toISOString()])(
    'rejects invalid or overdue billing dates: %s',
    async (date) => {
      const f = fixture();
      f.subscription.nextBillingAt = date;
      await expect(f.run()).rejects.toMatchObject({
        code: 'PLAN_RENEWAL_NEAR',
      });
    },
  );
  it.each(['id', 'orderId', 'customerId', 'productId', 'nextBillingAt'])(
    'rejects changed provider %s',
    async (field) => {
      const f = fixture();
      vi.mocked(f.provider.readSubscription!).mockResolvedValueOnce({
        ...f.subscription,
        [field]: 'unexpected',
      });
      await expect(f.run()).rejects.toMatchObject({
        code: 'PLAN_PREVIEW_CHANGED',
      });
      expect(f.provider.previewPlanChange).not.toHaveBeenCalled();
    },
  );
  it.each([
    { currency: 'USD' },
    { chargeNow: 1 },
    { recurringBeforeTax: -1 },
    { recurringBeforeTax: 1.5 },
    { effectiveAt: 'invalid' },
  ])('rejects unsafe pricing %#', async (overrides) => {
    const f = fixture();
    vi.mocked(f.provider.previewPlanChange!).mockResolvedValueOnce({
      currency: 'INR',
      chargeNow: 0,
      recurringBeforeTax: 123,
      effectiveAt: f.next,
      ...overrides,
    } as Awaited<
      ReturnType<NonNullable<BillingProvider['previewPlanChange']>>
    >);
    await expect(f.run()).rejects.toMatchObject({
      code: 'PLAN_PREVIEW_UNAVAILABLE',
    });
    expect(f.writes).not.toHaveBeenCalled();
  });
  it('rejects a concurrent local subscription update after the provider preview', async () => {
    const f = fixture();
    vi.mocked(f.provider.previewPlanChange!).mockImplementationOnce(
      async () => {
        f.subscription.nextBillingAt = new Date(
          Date.now() + 30 * 86400_000,
        ).toISOString();
        return {
          currency: 'INR',
          chargeNow: 0,
          recurringBeforeTax: 123,
          effectiveAt: f.next,
        };
      },
    );
    await expect(f.run()).rejects.toMatchObject({
      code: 'PLAN_PREVIEW_CHANGED',
    });
  });
  it('propagates a provider outage without any mutation', async () => {
    const f = fixture();
    vi.mocked(f.provider.previewPlanChange!).mockRejectedValueOnce(
      new Error('synthetic outage'),
    );
    await expect(f.run()).rejects.toThrow('synthetic outage');
    expect(f.writes).not.toHaveBeenCalled();
  });
  it('enforces session, origin and strict input at the actual endpoint', async () => {
    const f = fixture();
    const app = createApp(f.auth, {}, f.service);
    const path = '/api/billing/subscriptions/sub_owned/plan-preview';
    await request(app)
      .post(path)
      .set('Origin', f.auth.webOrigin)
      .send({ plan: 'studio' })
      .expect(401);
    await request(app)
      .post(path)
      .set('Cookie', 'picfind_session=synthetic')
      .set('Origin', 'https://foreign.test')
      .send({ plan: 'studio' })
      .expect(403);
    for (const body of [
      { plan: 'studio', currency: 'USD' },
      { plan: 'studio', productId: 'foreign' },
      { plan: 'photo-pack' },
      { plan: 'studio', confirmed: true },
    ])
      await request(app)
        .post(path)
        .set('Cookie', 'picfind_session=synthetic')
        .set('Origin', f.auth.webOrigin)
        .send(body)
        .expect(400);
    const result = await request(app)
      .post(path)
      .set('Cookie', 'picfind_session=synthetic')
      .set('Origin', f.auth.webOrigin)
      .send({ plan: 'studio' })
      .expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.previewOnly).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain('cus_owned');
    expect(JSON.stringify(result.body)).not.toContain('pdt_studio');
  });
});

describe('current organizer subscription previews', () => {
  const plans = [
    'organizer-starter-monthly',
    'organizer-starter-yearly',
    'organizer-pro-monthly',
    'organizer-pro-yearly',
    'organizer-scale-monthly',
    'organizer-scale-yearly',
  ] as const;
  for (const source of plans) {
    it(
      'previews every other organizer target from ' +
        source +
        ' without writes',
      async () => {
        const f = fixture(true);
        f.order.plan = source;
        f.order.productId = 'pdt_' + source.replaceAll('-', '');
        f.subscription.productId = f.order.productId;
        for (const target of plans)
          f.service.products[`${target}:INR`] =
            'pdt_' + target.replaceAll('-', '');
        for (const target of plans.filter((id) => id !== source)) {
          const result = await previewPlanChange(
            f.service,
            f.owner,
            'sub_owned',
            target,
          );
          expect(result.targetPlan).toBe(target);
          expect(f.provider.previewPlanChange).toHaveBeenLastCalledWith(
            f.subscription,
            f.service.products[`${target}:INR`],
            'INR',
            target.endsWith('-yearly') ? 'Year' : 'Month',
          );
        }
        expect(f.writes).not.toHaveBeenCalled();
        expect(f.provider.checkout).not.toHaveBeenCalled();
      },
    );
  }
  it('does not expose organizer previews before the role rollout', async () => {
    const f = fixture();
    await expect(
      previewPlanChange(
        f.service,
        f.owner,
        'sub_owned',
        'organizer-pro-yearly',
      ),
    ).rejects.toMatchObject({ code: 'PLAN_PREVIEW_UNAVAILABLE' });
    expect(f.provider.readSubscription).not.toHaveBeenCalled();
  });
  it('rejects both directions of legacy migration', async () => {
    const f = fixture(true);
    await expect(
      previewPlanChange(
        f.service,
        f.owner,
        'sub_owned',
        'organizer-pro-yearly',
      ),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_CHANGEABLE' });
    f.order.plan = 'organizer-pro-yearly';
    await expect(f.run()).rejects.toMatchObject({
      code: 'PLAN_NOT_CHANGEABLE',
    });
    expect(f.provider.previewPlanChange).not.toHaveBeenCalled();
  });
  it('accepts a yearly organizer target at the API but not personal packs or client-supplied cadence', async () => {
    const f = fixture(true);
    f.order.plan = 'organizer-starter-monthly';
    f.service.products['organizer-pro-yearly:INR'] = 'pdt_proyearly';
    const app = createApp(f.auth, {}, f.service);
    const path = '/api/billing/subscriptions/sub_owned/plan-preview';
    const call = (body: unknown) =>
      request(app)
        .post(path)
        .set('Cookie', 'picfind_session=synthetic')
        .set('Origin', f.auth.webOrigin)
        .send(body as object);
    const result = await call({ plan: 'organizer-pro-yearly' }).expect(200);
    expect(result.body.targetPlan).toBe('organizer-pro-yearly');
    await call({ plan: 'personal-1000' }).expect(400);
    await call({ plan: 'organizer-pro-yearly', interval: 'Month' }).expect(400);
    expect(f.writes).not.toHaveBeenCalled();
  });
});
