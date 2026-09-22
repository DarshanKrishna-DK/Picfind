import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/api/src/auth.js';
import { BillingService } from '../../apps/api/src/billing/service.js';
import {
  addMonths,
  planById,
  type BillingAccount,
  type BillingHistoryPage,
  type BillingKind,
  type BillingProvider,
  type BillingStore,
  type BillingTransaction,
  type PaymentSnapshot,
} from '../../apps/api/src/billing/model.js';

class Store implements BillingStore {
  rows = new Map<
    string,
    { owner: string; kind: BillingKind; value: unknown }
  >();
  failCheckpoint = false;
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
      if (
        this.failCheckpoint &&
        [...draft.values()].some(
          (row) =>
            row.kind === 'account' &&
            ((row.value as BillingAccount).paymentHistory?.page ?? 0) > 0,
        )
      ) {
        this.failCheckpoint = false;
        throw new ApiError(
          503,
          'BILLING_STORAGE_UNAVAILABLE',
          'Synthetic checkpoint failure.',
        );
      }
      this.rows = draft;
      return result;
    });
    this.tail = next.catch(() => {});
    return next;
  }
}
async function fixture(
  plan: 'creator' | 'photo-pack' = 'creator',
  createdAt = new Date().toISOString(),
) {
  const store = new Store();
  const user = {
    id: randomUUID(),
    email: 'synthetic@example.test',
    name: 'Synthetic',
    emailVerified: true,
  };
  const payments = new Map<string, PaymentSnapshot>();
  const entries: BillingHistoryPage['items'] = [];
  const provider: BillingProvider = {
    checkout: vi.fn(async (order) => ({
      sessionId: `cks_${order.id}`,
      url: `https://test.checkout.dodopayments.com/${order.id}`,
    })),
    portal: vi.fn(),
    verify: vi.fn(),
    inspectCheckout: vi.fn(async () => null),
    readSubscription: vi.fn(async (id) => {
      const sub = [...payments.values()].find(
        (payment) => payment.subscription?.id === id,
      )?.subscription;
      if (!sub) throw new Error('Missing synthetic subscription.');
      return { ...sub, observedAt: new Date().toISOString() };
    }),
    listPayments: vi.fn(async (_customer, page) => ({
      items: structuredClone(entries.slice(page * 5, page * 5 + 5)),
      hasMore: entries.length >= page * 5 + 5,
    })),
    readPayment: vi.fn(async (id) => {
      const payment = payments.get(id);
      if (!payment) throw new Error('Missing synthetic payment.');
      return structuredClone({
        ...payment,
        observedAt: new Date().toISOString(),
        ...(payment.subscription
          ? {
              subscription: {
                ...payment.subscription,
                observedAt: new Date().toISOString(),
              },
            }
          : {}),
      });
    }),
  };
  const products = {
    'creator:INR': 'pdt_creator',
    'photo-pack:INR': 'pdt_pack',
  };
  const service = new BillingService(
    store,
    provider,
    products,
    'test_mode',
    true,
  );
  const requestId = randomUUID();
  await service.checkout(user, requestId, plan, 'INR');
  const orderId = service.key('order', `${user.id}:${requestId}`);
  const now = new Date().toISOString();
  const payment: PaymentSnapshot = {
    id: 'pay_initial',
    orderId,
    customerId: 'cus_owned',
    productId: plan === 'creator' ? 'pdt_creator' : 'pdt_pack',
    quantity: 1,
    currency: 'INR',
    status: 'succeeded',
    total: 69900,
    refunded: 0,
    held: false,
    createdAt,
    observedAt: now,
    setupOnly: false,
    sessionId: `cks_${orderId}`,
    ...(plan === 'creator'
      ? {
          subscription: {
            id: 'sub_owned',
            orderId,
            customerId: 'cus_owned',
            productId: 'pdt_creator',
            status: 'active',
            nextBillingAt: addMonths(now, 1),
            cancelAtPeriodEnd: false,
            observedAt: now,
          },
        }
      : {}),
  };
  payments.set(payment.id, payment);
  entries.push({
    id: payment.id,
    orderId,
    environment: 'test_mode',
    ...(payment.subscription
      ? { subscriptionId: payment.subscription.id }
      : {}),
  });
  await service.apply({ id: randomUUID(), type: 'payment.succeeded', payment });
  const account = () =>
    store.rows.get(service.key('account', user.id))?.value as BillingAccount;
  return {
    store,
    service,
    provider,
    user,
    payments,
    entries,
    payment,
    orderId,
    products,
    account,
  };
}

describe('resumable billing history with synthetic provider reads only', () => {
  it('replays a partially applied page without duplicating its newly recovered payment', async () => {
    const f = await fixture();
    const renewal = { ...f.payment, id: 'pay_partial' };
    f.payments.set(renewal.id, renewal);
    f.entries.unshift({ id: renewal.id, orderId: f.orderId });
    vi.mocked(f.provider.readPayment!)
      .mockResolvedValueOnce(renewal)
      .mockRejectedValueOnce(
        new ApiError(
          503,
          'BILLING_RECONCILIATION_PENDING',
          'Synthetic second-read outage.',
        ),
      );
    await expect(f.service.reconcile(f.user.id)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.account().paymentHistory?.page).toBe(0);
    const before = (await f.service.summary(f.user.id)).photosRemaining;
    expect((await f.service.reconcile(f.user.id)).photosRemaining).toBe(before);
    expect(
      [...f.store.rows.values()].filter((row) => row.kind === 'grant'),
    ).toHaveLength(3);
  });
  it('does not overwrite a checkpoint advanced by another process', async () => {
    const f = await fixture();
    const read = vi.mocked(f.provider.readPayment!).getMockImplementation()!;
    vi.mocked(f.provider.readPayment!).mockImplementationOnce(async (id) => {
      const result = await read(id);
      // A synthetic independent instance commits progress while this instance reads Dodo.
      f.account().paymentHistory!.page = 1;
      return result;
    });
    await expect(f.service.reconcile(f.user.id)).rejects.toMatchObject({
      code: 'BILLING_HISTORY_CHANGED',
    });
    expect(f.account().paymentHistory?.page).toBe(1);
  });
  it('serializes concurrent owner requests into consecutive pages', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) f.entries.push({ id: `unrelated_${i}` });
    await Promise.all([
      f.service.reconcile(f.user.id),
      f.service.reconcile(f.user.id),
    ]);
    expect(f.account().paymentHistory).toMatchObject({
      page: 2,
      status: 'complete',
    });
    expect(
      vi.mocked(f.provider.listPayments!).mock.calls.map((call) => call[1]),
    ).toEqual([0, 1]);
  });
  it('recovers a missed renewal using its original payment date and never grants it twice', async () => {
    const f = await fixture('creator', '2020-01-01T00:00:00.000Z');
    const renewal = {
      ...f.payment,
      id: 'pay_renewal',
      createdAt: new Date().toISOString(),
    };
    f.payments.set(renewal.id, renewal);
    f.entries.push({ id: renewal.id, subscriptionId: 'sub_owned' });
    const result = await f.service.reconcile(f.user.id);
    expect(result.photosRemaining).toBe(20 + planById('creator').photos);
    expect(result.paymentHistory).toMatchObject({
      status: 'complete',
      checkedPayments: 2,
    });
    const grant = result.grants.find(
      (g) => g.id === f.service.key('payment', renewal.id),
    )!;
    expect(grant.expiresAt).toBe(addMonths(renewal.createdAt, 1));
    await f.service.reserve(f.user.id, 'index', 30);
    expect((await f.service.reconcile(f.user.id)).photosRemaining).toBe(
      result.photosRemaining - 30,
    );
    expect(
      [...f.store.rows.values()].filter((row) => row.kind === 'grant'),
    ).toHaveLength(3);
  });
  it('reconciles historical partial refunds and disputes without restoring used credits', async () => {
    const f = await fixture('photo-pack');
    await f.service.reserve(f.user.id, 'index', 30);
    f.payments.set(f.payment.id, {
      ...f.payment,
      refunded: f.payment.total / 2,
    });
    const refunded = await f.service.reconcile(f.user.id);
    expect(refunded.photosRemaining).toBe(
      planById('photo-pack').photos / 2 - 10,
    );
    f.payments.set(f.payment.id, {
      ...f.payment,
      refunded: f.payment.total / 2,
      held: true,
    });
    expect((await f.service.reconcile(f.user.id)).photosRemaining).toBe(0);
    f.payments.set(f.payment.id, {
      ...f.payment,
      refunded: f.payment.total / 2,
      held: false,
    });
    expect((await f.service.reconcile(f.user.id)).photosRemaining).toBe(
      refunded.photosRemaining,
    );
  });
  it('never renews an expired historical pack during reconciliation', async () => {
    const f = await fixture('photo-pack', '2020-01-01T00:00:00.000Z');
    const result = await f.service.reconcile(f.user.id);
    expect(result.photosRemaining).toBe(20);
    expect(result.grants.find((g) => g.plan === 'photo-pack')?.expiresAt).toBe(
      '2021-01-01T00:00:00.000Z',
    );
  });
  it('persists page progress across service instances with a fixed cutoff', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) f.entries.push({ id: `other_${i}` });
    const first = await f.service.reconcile(f.user.id);
    expect(first.paymentHistory?.status).toBe('running');
    const fresh = new BillingService(
      f.store,
      f.provider,
      f.products,
      'test_mode',
      true,
    );
    const second = await fresh.reconcile(f.user.id);
    expect(second.paymentHistory).toMatchObject({
      status: 'complete',
      checkedPayments: 1,
      through: first.paymentHistory!.through,
    });
    const calls = vi.mocked(f.provider.listPayments!).mock.calls;
    expect(calls.map((call) => call[1])).toEqual([0, 1]);
    expect(calls[0]![2]).toBe(calls[1]![2]);
    expect(f.provider.readPayment).toHaveBeenCalledTimes(1);
  });
  it('retains the cursor after a detail-read outage and safely replays verified earlier entries', async () => {
    const f = await fixture();
    const renewal = { ...f.payment, id: 'pay_next' };
    f.payments.set(renewal.id, renewal);
    f.entries.push({ id: renewal.id, orderId: f.orderId });
    vi.mocked(f.provider.readPayment!).mockRejectedValueOnce(
      new ApiError(503, 'BILLING_RECONCILIATION_PENDING', 'Synthetic outage.'),
    );
    await expect(f.service.reconcile(f.user.id)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.account().paymentHistory?.page).toBe(0);
    const result = await f.service.reconcile(f.user.id);
    expect(result.paymentHistory?.status).toBe('complete');
    expect(result.grants.filter((g) => g.plan === 'creator')).toHaveLength(2);
  });
  it('a failed checkpoint does not duplicate grants or reset usage on retry', async () => {
    const f = await fixture();
    f.store.failCheckpoint = true;
    await expect(f.service.reconcile(f.user.id)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.account().paymentHistory?.page).toBe(0);
    await f.service.reserve(f.user.id, 'index', 30);
    const before = (await f.service.summary(f.user.id)).photosRemaining;
    expect((await f.service.reconcile(f.user.id)).photosRemaining).toBe(before);
    expect(f.account().paymentHistory?.status).toBe('complete');
  });
  it('skips foreign orders, unknown products and another environment before detail reads', async () => {
    const f = await fixture();
    f.entries.push(
      { id: 'foreign', orderId: 'other-owned-order' },
      { id: 'live', orderId: f.orderId, environment: 'live_mode' },
      { id: 'unrelated' },
    );
    await f.service.reconcile(f.user.id);
    expect(f.provider.readPayment).toHaveBeenCalledTimes(1);
    expect((await f.service.summary('another-user')).paymentHistory).toBeNull();
  });
  it.each(['id', 'order', 'customer', 'subscription'])(
    'fails closed for a mismatched authoritative %s',
    async (kind) => {
      const f = await fixture();
      const value = structuredClone(f.payment);
      if (kind === 'id') value.id = 'foreign';
      if (kind === 'order') value.orderId = 'foreign';
      if (kind === 'customer') value.customerId = 'foreign';
      if (kind === 'subscription') value.subscription!.id = 'foreign';
      vi.mocked(f.provider.readPayment!).mockResolvedValueOnce(value);
      await expect(f.service.reconcile(f.user.id)).rejects.toMatchObject({
        status: 503,
      });
      expect(f.account().paymentHistory?.page).toBe(0);
    },
  );
  it('rejects repeated pages instead of advancing forever', async () => {
    const f = await fixture();
    const page = {
      items: [{ id: f.payment.id, orderId: f.orderId }],
      hasMore: true,
    };
    vi.mocked(f.provider.listPayments!).mockResolvedValue(page);
    await f.service.reconcile(f.user.id);
    await expect(f.service.reconcile(f.user.id)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.account().paymentHistory?.page).toBe(1);
  });
  it.each(['empty-more', 'duplicate', 'oversize'])(
    'rejects a malformed %s page without advancing',
    async (kind) => {
      const f = await fixture();
      const items =
        kind === 'empty-more'
          ? []
          : Array.from({ length: kind === 'duplicate' ? 2 : 6 }, () => ({
              id: f.payment.id,
              orderId: f.orderId,
            }));
      vi.mocked(f.provider.listPayments!).mockResolvedValue({
        items,
        hasMore: true,
      });
      await expect(f.service.reconcile(f.user.id)).rejects.toMatchObject({
        status: 503,
      });
      expect(f.account().paymentHistory?.page).toBe(0);
    },
  );
  it('blocks account deletion for incomplete history and reuses a recently completed check', async () => {
    const f = await fixture('photo-pack');
    for (let i = 0; i < 5; i++) f.entries.push({ id: `other_${i}` });
    await expect(f.service.prepareDeletion(f.user.id)).rejects.toMatchObject({
      code: 'BILLING_HISTORY_PENDING',
    });
    expect(f.account().deletionPendingAt).toBeUndefined();
    await f.service.reconcile(f.user.id);
    const calls = vi.mocked(f.provider.listPayments!).mock.calls.length;
    await f.service.prepareDeletion(f.user.id);
    expect(f.account().deletionPendingAt).toBeTruthy();
    expect(f.provider.listPayments).toHaveBeenCalledTimes(calls);
  });
  it('never exposes the internal cursor, run identifier or customer in progress', async () => {
    const f = await fixture();
    const result = await f.service.reconcile(f.user.id);
    expect(result.paymentHistory).not.toHaveProperty('page');
    expect(result.paymentHistory).not.toHaveProperty('runId');
    expect(result.paymentHistory).not.toHaveProperty('customerId');
  });
  it('applies no unverified allowance if the provider is unavailable', async () => {
    const f = await fixture();
    const before = await f.service.summary(f.user.id);
    vi.mocked(f.provider.listPayments!).mockRejectedValueOnce(
      new ApiError(503, 'BILLING_RECONCILIATION_PENDING', 'Synthetic outage.'),
    );
    await expect(f.service.reconcile(f.user.id)).rejects.toMatchObject({
      status: 503,
    });
    expect((await f.service.summary(f.user.id)).photosRemaining).toBe(
      before.photosRemaining,
    );
    expect(f.account().paymentHistory?.status).toBe('running');
    expect(f.provider.checkout).toHaveBeenCalledTimes(1);
  });
});
