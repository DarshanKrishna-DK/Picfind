import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BillingService } from '../../apps/api/src/billing/service.js';
import {
  ORGANIZER_PLAN_IDS,
  type SubscriptionPlanId,
} from '../../apps/api/src/billing/model.js';
import { PHOTO_PLANS } from '../../packages/shared/src/plans.js';
import { previewPlanChange } from '../../apps/api/src/billing/plan-preview.js';
import {
  createPlanQuote,
  type PlanQuote,
} from '../../apps/api/src/billing/plan-quotes.js';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app.js';
import type { AuthenticationProvider } from '../../apps/api/src/auth.js';
import {
  recordScheduledPlanChange,
  recordCancelledPlanChange,
} from '../../apps/api/src/billing/plan-transitions.js';
import type {
  BillingAccount,
  BillingKind,
  BillingOrder,
  BillingStore,
  BillingTransaction,
  Grant,
  PaymentSnapshot,
  SubscriptionSnapshot,
} from '../../apps/api/src/billing/model.js';

class Store implements BillingStore {
  rows = new Map<
    string,
    { owner: string; kind: BillingKind; value: unknown }
  >();
  private tail: Promise<unknown> = Promise.resolve();
  transaction<T>(work: (tx: BillingTransaction) => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
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
    this.tail = next.catch(() => {});
    return next;
  }
}
async function fixture(
  source: SubscriptionPlanId = 'creator',
  target: SubscriptionPlanId = 'studio',
) {
  const store = new Store();
  const owner = randomUUID();
  const at = (days: number) =>
    new Date(Date.now() + days * 86400000).toISOString();
  const billing = new BillingService(
    store,
    { checkout: vi.fn(), verify: vi.fn(), portal: vi.fn() },
    Object.fromEntries(
      ['creator', 'studio', ...ORGANIZER_PLAN_IDS].map((id) => [
        `${id}:INR`,
        `pdt_${id}`,
      ]),
    ),
    'test_mode',
    false,
    true,
  );
  const order: BillingOrder = {
    id: billing.key('order', owner),
    ownerId: owner,
    plan: source,
    currency: 'INR',
    productId: `pdt_${source}`,
    createdAt: at(-10),
    customerId: 'cus_owned',
    fulfilled: true,
  };
  const sub: SubscriptionSnapshot = {
    id: 'sub_owned',
    orderId: order.id,
    customerId: 'cus_owned',
    productId: `pdt_${source}`,
    status: 'active',
    cancelAtPeriodEnd: false,
    observedAt: at(-4),
    nextBillingAt: at(-2),
  };
  const account: BillingAccount = {
    ownerId: owner,
    customerId: 'cus_owned',
    revision: 1,
    createdAt: at(-10),
    subscriptions: { [sub.id]: sub },
  };
  store.rows.set(order.id, {
    owner: `test_mode:${owner}`,
    kind: 'order',
    value: order,
  });
  store.rows.set(billing.key('account', owner), {
    owner: `test_mode:${owner}`,
    kind: 'account',
    value: account,
  });
  const initial: PaymentSnapshot = {
    id: 'pay_initial',
    orderId: order.id,
    customerId: 'cus_owned',
    productId: `pdt_${source}`,
    quantity: 1,
    currency: 'INR',
    status: 'succeeded',
    total: 69900,
    refunded: 0,
    held: false,
    createdAt: at(-5),
    observedAt: at(-4),
    setupOnly: false,
    subscription: sub,
  };
  await billing.apply({
    id: randomUUID(),
    type: 'payment.succeeded',
    payment: initial,
  });
  const approval = {
    id: randomUUID(),
    quoteId: randomUUID(),
    subscriptionId: sub.id,
    sourceProductId: sub.productId,
    targetPlan: target,
    effectiveAt: sub.nextBillingAt,
    approvedAt: at(-3),
  };
  const schedule = {
    id: 'sch_owned',
    subscriptionId: sub.id,
    orderId: order.id,
    customerId: sub.customerId,
    productId: `pdt_${target}`,
    currency: 'INR' as const,
    quantity: 1 as const,
    effectiveAt: approval.effectiveAt,
  };
  const current: SubscriptionSnapshot = {
    ...sub,
    productId: `pdt_${target}`,
    observedAt: at(0),
    nextBillingAt: at(28),
  };
  const renewal: PaymentSnapshot = {
    ...initial,
    id: 'pay_new',
    productId: `pdt_${target}`,
    total: 199900,
    createdAt: at(-1),
    observedAt: at(0),
    subscription: current,
  };
  const approve = () =>
    recordScheduledPlanChange(billing, owner, approval, schedule);
  const apply = (payment = renewal) =>
    billing.apply({ id: randomUUID(), type: 'payment.reconciled', payment });
  const grants = () =>
    [...store.rows.values()]
      .filter((row) => row.kind === 'grant')
      .map((row) => row.value as Grant);
  return {
    store,
    owner,
    billing,
    order,
    sub,
    account,
    initial,
    approval,
    schedule,
    current,
    renewal,
    approve,
    apply,
    grants,
  };
}
describe('approved historical subscription fulfillment, synthetic provider evidence', () => {
  for (const source of ORGANIZER_PLAN_IDS) {
    for (const target of ORGANIZER_PLAN_IDS.filter((id) => id !== source)) {
      it(`fulfills only a paid approved ${source} to ${target} renewal`, async () => {
        const f = await fixture(source, target);
        const before = structuredClone(f.grants());
        await f.approve();
        expect(f.grants()).toEqual(before);
        await Promise.all([f.apply(), f.apply()]);
        const renewed = f
          .grants()
          .filter((grant) => grant.paymentId === f.renewal.id);
        expect(renewed.length).toBeGreaterThan(0);
        expect(
          renewed.every(
            (grant) => grant.plan === target && grant.scope === 'organizer',
          ),
        ).toBe(true);
        expect(renewed.reduce((sum, grant) => sum + grant.photos, 0)).toBe(
          PHOTO_PLANS.find((plan) => plan.id === target)!.photos,
        );
        expect(
          f.grants().filter((grant) => grant.paymentId === f.initial.id),
        ).toEqual(before);
        f.billing.provider!.readSubscription = vi.fn(async () => f.current);
        f.billing.provider!.previewPlanChange = vi.fn(async () => ({
          currency: 'INR' as const,
          chargeNow: 0,
          recurringBeforeTax: 69900,
          effectiveAt: f.current.nextBillingAt,
        }));
        const preview = await previewPlanChange(
          f.billing,
          f.owner,
          f.sub.id,
          source,
        );
        expect(preview).toMatchObject({
          targetPlan: source,
          previewOnly: true,
        });
        await expect(
          previewPlanChange(f.billing, f.owner, f.sub.id, target),
        ).rejects.toMatchObject({ code: 'PLAN_ALREADY_SELECTED' });
      });
    }
  }
  it('rejects legacy-to-organizer migration and disabled organizer changes without writes', async () => {
    const mixed = await fixture('creator', 'organizer-pro-monthly');
    const beforeMixed = structuredClone(mixed.store.rows);
    await expect(mixed.approve()).rejects.toMatchObject({
      code: 'PLAN_CHANGE_CONFLICT',
    });
    expect(mixed.store.rows).toEqual(beforeMixed);
    const f = await fixture(
      'organizer-starter-monthly',
      'organizer-pro-monthly',
    );
    const disabled = new BillingService(
      f.store,
      f.billing.provider,
      f.billing.products,
      'test_mode',
      false,
      false,
    );
    const before = structuredClone(f.store.rows);
    await expect(
      recordScheduledPlanChange(disabled, f.owner, f.approval, f.schedule),
    ).rejects.toMatchObject({ code: 'PLAN_CHANGE_CONFLICT' });
    expect(f.store.rows).toEqual(before);
  });
  it('does not grant for a saved schedule or an active-subscription observation', async () => {
    const f = await fixture();
    await f.approve();
    expect(f.grants()).toHaveLength(1);
    await f.billing.apply({
      id: randomUUID(),
      type: 'subscription.reconciled',
      subscription: f.current,
    });
    expect(f.grants()).toHaveLength(1);
  });
  it('grants the paid new plan once and preserves the old grant usage/expiry', async () => {
    const f = await fixture();
    await f.billing.reserve(f.owner, 'index', 17);
    const original = structuredClone(f.grants()[0]!);
    await f.approve();
    await Promise.all([f.apply(), f.apply()]);
    expect(f.grants()).toHaveLength(2);
    expect(
      f.grants().find((grant) => grant.paymentId === 'pay_initial'),
    ).toEqual(original);
    expect(
      f.grants().find((grant) => grant.paymentId === 'pay_new'),
    ).toMatchObject({ plan: 'studio', photos: 7500, usedPhotos: 0 });
  });
  it('attributes a delayed old payment to the old product despite the current new subscription', async () => {
    const f = await fixture();
    await f.approve();
    await f.apply();
    await f.apply({
      ...f.initial,
      id: 'pay_delayed',
      subscription: f.current,
      observedAt: f.current.observedAt,
    });
    expect(
      f.grants().find((grant) => grant.paymentId === 'pay_delayed'),
    ).toMatchObject({ plan: 'creator', photos: 2500 });
  });
  it('refunds and holds the old payment without rewriting it as the current plan', async () => {
    const f = await fixture();
    await f.billing.reserve(f.owner, 'index', 12);
    const expiry = f.grants()[0]!.expiresAt;
    await f.approve();
    await f.apply();
    await f.apply({
      ...f.initial,
      subscription: f.current,
      observedAt: f.current.observedAt,
      refunded: 34950,
      held: true,
    });
    expect(
      f.grants().find((grant) => grant.paymentId === 'pay_initial'),
    ).toMatchObject({
      plan: 'creator',
      usedPhotos: 12,
      refundFraction: 0.5,
      held: true,
      expiresAt: expiry,
    });
  });
  it('rejects configured but unapproved products without changing any ledger state', async () => {
    const f = await fixture();
    const before = structuredClone(f.store.rows);
    await expect(f.apply()).rejects.toMatchObject({ code: 'BILLING_MISMATCH' });
    expect(f.store.rows).toEqual(before);
  });
  it('rejects a target payment created before the approved effective date', async () => {
    const f = await fixture();
    await f.approve();
    await expect(
      f.apply({ ...f.renewal, createdAt: f.initial.createdAt }),
    ).rejects.toMatchObject({ code: 'BILLING_MISMATCH' });
    expect(f.grants()).toHaveLength(1);
  });
  it('does not apply a cancelled schedule and does not revive it on idempotent retry', async () => {
    const f = await fixture();
    await f.approve();
    await recordCancelledPlanChange(
      f.billing,
      f.owner,
      f.sub.id,
      f.approval.id,
      f.schedule.id,
    );
    expect(await f.approve()).toEqual({ status: 'cancelled' });
    await expect(f.apply()).rejects.toMatchObject({ code: 'BILLING_MISMATCH' });
  });
  it('rejects another owner or conflicting approval reuse', async () => {
    const f = await fixture();
    await expect(
      recordScheduledPlanChange(f.billing, 'foreign', f.approval, f.schedule),
    ).rejects.toMatchObject({ code: 'PLAN_CHANGE_CONFLICT' });
    await f.approve();
    await expect(
      recordScheduledPlanChange(
        f.billing,
        f.owner,
        { ...f.approval, quoteId: randomUUID() },
        f.schedule,
      ),
    ).rejects.toMatchObject({ code: 'PLAN_CHANGE_CONFLICT' });
  });
  it('does not grant a failed new-plan payment', async () => {
    const f = await fixture();
    await f.approve();
    await f.apply({ ...f.renewal, status: 'failed' });
    expect(f.grants()).toHaveLength(1);
  });
  it('rejects changing an already granted payment amount on refund replay', async () => {
    const f = await fixture();
    await expect(
      f.apply({ ...f.initial, total: f.initial.total + 1 }),
    ).rejects.toMatchObject({ code: 'BILLING_MISMATCH' });
  });
  it('does not accept test orders in the live namespace', async () => {
    const f = await fixture();
    const live = new BillingService(
      f.store,
      undefined,
      f.billing.products,
      'live_mode',
      false,
    );
    await expect(
      live.apply({
        id: randomUUID(),
        type: 'payment.succeeded',
        payment: f.initial,
      }),
    ).rejects.toMatchObject({ code: 'BILLING_MISMATCH' });
  });
});

async function quoteFixture() {
  const f = await fixture('organizer-starter-monthly', 'organizer-pro-monthly');
  await f.approve();
  await f.apply();
  f.billing.provider!.readSubscription = vi.fn(async () => f.current);
  f.billing.provider!.previewPlanChange = vi.fn(async () => ({
    currency: 'INR' as const,
    chargeNow: 0,
    recurringBeforeTax: 999900,
    effectiveAt: f.current.nextBillingAt,
  }));
  const target = 'organizer-scale-monthly' as const;
  const run = () => createPlanQuote(f.billing, f.owner, f.sub.id, target);
  const key = f.billing.key('plan-quote', `${f.owner}:${f.sub.id}`);
  return { ...f, target, run, key };
}
describe('persisted plan quote metadata, no provider mutations', () => {
  it('stores the verified price privately and returns only the public quote', async () => {
    const f = await quoteFixture();
    const grants = structuredClone(f.grants());
    const result = await f.run();
    expect(result).toMatchObject({
      quoteId: expect.any(String),
      recurringBeforeTax: 999900,
      chargeNow: 0,
      previewOnly: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/cus_owned|pdt_|orderId/);
    expect(f.store.rows.get(f.key)?.value).toMatchObject({
      ownerId: f.owner,
      targetPlan: f.target,
      sourceProductId: 'pdt_organizer-pro-monthly',
      status: 'quoted',
      id: result.quoteId,
    });
    expect(Date.parse(result.expiresAt)).toBeLessThanOrEqual(
      Date.now() + 300000,
    );
    expect(f.grants()).toEqual(grants);
    expect(f.billing.provider!.checkout).not.toHaveBeenCalled();
  });
  it('replaces only the subscription quote slot, invalidating the earlier nonce', async () => {
    const f = await quoteFixture();
    const first = await f.run();
    const size = f.store.rows.size;
    const second = await f.run();
    expect(second.quoteId).not.toBe(first.quoteId);
    expect(f.store.rows.size).toBe(size);
    expect((f.store.rows.get(f.key)!.value as PlanQuote).id).toBe(
      second.quoteId,
    );
  });
  it('never overwrites an approved or submitted attempt', async () => {
    const f = await quoteFixture();
    await f.run();
    const row = f.store.rows.get(f.key)!;
    (row.value as PlanQuote).status = 'submitting';
    const before = structuredClone(f.store.rows);
    await expect(f.run()).rejects.toMatchObject({ code: 'PLAN_QUOTE_CHANGED' });
    expect(f.store.rows).toEqual(before);
  });
  it('rejects foreign ownership before a provider request', async () => {
    const f = await quoteFixture();
    await expect(
      createPlanQuote(f.billing, 'foreign', f.sub.id, f.target),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.billing.provider!.readSubscription).not.toHaveBeenCalled();
    expect(f.store.rows.has(f.key)).toBe(false);
  });
  it('does not save a quote when deletion starts during the provider preview', async () => {
    const f = await quoteFixture();
    f.billing.provider!.previewPlanChange = vi.fn(async () => {
      const row = f.store.rows.get(f.billing.key('account', f.owner))!;
      (row.value as BillingAccount).deletionPendingAt =
        new Date().toISOString();
      return {
        currency: 'INR' as const,
        chargeNow: 0,
        recurringBeforeTax: 999900,
        effectiveAt: f.current.nextBillingAt,
      };
    });
    await expect(f.run()).rejects.toMatchObject({ status: 409 });
    expect(f.store.rows.has(f.key)).toBe(false);
  });
  it('enforces session, verified email, origin and server-priced input at the endpoint', async () => {
    const f = await quoteFixture();
    let verified = false;
    const origin = 'http://localhost:5173';
    const provider = {
      register: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getUser: async () => ({
        id: f.owner,
        email: 'synthetic@example.test',
        name: 'Synthetic',
        emailVerified: verified,
      }),
    } as AuthenticationProvider;
    const app = createApp(
      { provider, webOrigin: origin, secureCookies: false },
      {},
      f.billing,
    );
    const path = `/api/billing/subscriptions/${f.sub.id}/plan-quote`;
    await request(app)
      .post(path)
      .set('Origin', origin)
      .send({ plan: f.target })
      .expect(401);
    await request(app)
      .post(path)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=synthetic')
      .send({ plan: f.target })
      .expect(403);
    verified = true;
    await request(app)
      .post(path)
      .set('Origin', 'https://foreign.test')
      .set('Cookie', 'picfind_session=synthetic')
      .send({ plan: f.target })
      .expect(403);
    for (const extra of [
      { amount: 1 },
      { currency: 'USD' },
      { quoteId: 'forged' },
      { approved: true },
    ])
      await request(app)
        .post(path)
        .set('Origin', origin)
        .set('Cookie', 'picfind_session=synthetic')
        .send({ plan: f.target, ...extra })
        .expect(400);
    const result = await request(app)
      .post(path)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=synthetic')
      .send({ plan: f.target })
      .expect(200);
    expect(result.body.quoteId).toBeTruthy();
    expect(result.headers['cache-control']).toBe('no-store');
  });
});
