import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BillingService } from '../../apps/api/src/billing/service.js';
import {
  SubscriptionPaymentAttribution,
  type SubscriptionPaymentContext,
  type ProductPaymentQuery,
} from '../../apps/api/src/billing/payment-attribution.js';
import {
  billingId,
  type BillingAccount,
  type BillingOrder,
  type BillingKind,
  type BillingProvider,
  type BillingStore,
  type BillingTransaction,
} from '../../apps/api/src/billing/model.js';

class Store implements BillingStore {
  rows = new Map<
    string,
    { owner: string; kind: BillingKind; value: unknown }
  >();
  failCommit = false;
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
      if (this.failCommit) {
        this.failCommit = false;
        throw new Error('Synthetic storage outage');
      }
      this.rows = draft;
      return result;
    });
    this.tail = next.catch(() => {});
    return next;
  }
}
async function fixture() {
  const owner = randomUUID();
  const store = new Store();
  const products = {
    'creator:INR': 'pdt_original',
    'studio:INR': 'pdt_studio',
  } as const;
  const provider: BillingProvider = {
    checkout: vi.fn(async () => ({
      sessionId: 'cks_synthetic',
      url: 'https://test.checkout.dodopayments.com/synthetic',
    })),
    portal: vi.fn(),
    verify: vi.fn(),
  };
  const billing = new BillingService(
    store,
    provider,
    products,
    'test_mode',
    true,
  );
  await billing.checkout(
    {
      id: owner,
      name: 'Synthetic',
      email: 'synthetic@example.test',
      emailVerified: true,
    },
    randomUUID(),
    'creator',
    'INR',
  );
  const order = [...store.rows.values()].find((row) => row.kind === 'order')!
    .value as BillingOrder;
  const context: SubscriptionPaymentContext = {
    paymentId: 'pay_original',
    orderId: order.id,
    customerId: 'cus_owned',
    subscriptionId: 'sub_owned',
    currency: 'INR',
    createdAt: new Date().toISOString(),
    total: 99900,
    status: 'succeeded',
  };
  const row = (id = context.paymentId) => ({
    payment_id: id,
    customer: {
      customer_id: context.customerId,
      email: 'never-expose@example.test',
    },
    subscription_id: context.subscriptionId,
    currency: context.currency,
    created_at: context.createdAt,
    total_amount: context.total,
    metadata: {
      picfind_order: context.orderId,
      picfind_environment: 'test_mode',
      unrelated: true,
    },
  });
  const lookup = vi.fn(async (query: ProductPaymentQuery) => ({
    items: query.productId === 'pdt_original' ? [row()] : [],
  }));
  const resolver = () =>
    new SubscriptionPaymentAttribution(store, 'test_mode', products);
  const key = billingId('test_mode', 'payment-attribution', context.paymentId);
  return {
    owner,
    store,
    products,
    billing,
    context,
    row,
    lookup,
    resolver,
    key,
    order,
  };
}
describe('persistent subscription payment attribution', () => {
  it('uses real checkout order keys and records the original product without granting credits', async () => {
    const f = await fixture();
    const before = await f.billing.summary(f.owner);
    expect(await f.resolver().resolve(f.context, f.lookup)).toBe(
      'pdt_original',
    );
    expect(f.lookup).toHaveBeenCalledTimes(2);
    expect(f.lookup).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_owned',
        subscriptionId: 'sub_owned',
        currency: 'INR',
        page: 0,
        pageSize: 25,
      }),
    );
    expect(f.store.rows.get(f.key)).toMatchObject({
      owner: `test_mode:${f.owner}`,
      kind: 'event',
      value: { productId: 'pdt_original', evidence: 'provider-product-filter' },
    });
    const after = await f.billing.summary(f.owner);
    expect(after.photosRemaining).toBe(before.photosRemaining);
    expect(after.grants).toEqual(before.grants);
  });
  it('reuses immutable attribution after restart without repeating provider membership reads', async () => {
    const f = await fixture();
    await f.resolver().resolve(f.context, f.lookup);
    const other = vi.fn(async () => {
      throw new Error('Provider unavailable after product changed');
    });
    expect(await f.resolver().resolve(f.context, other)).toBe('pdt_original');
    expect(other).not.toHaveBeenCalled();
  });
  it('retains retired original products as candidates even after catalog changes', async () => {
    const f = await fixture();
    const resolver = new SubscriptionPaymentAttribution(f.store, 'test_mode', {
      'creator:INR': 'pdt_replacement',
      'studio:INR': 'pdt_studio',
    });
    expect(await resolver.resolve(f.context, f.lookup)).toBe('pdt_original');
    expect(f.lookup).toHaveBeenCalledTimes(3);
  });
  it('identifies a different configured product but does not authorize it or mint capacity', async () => {
    const f = await fixture();
    f.lookup.mockImplementation(async (q) => ({
      items: q.productId === 'pdt_studio' ? [f.row()] : [],
    }));
    expect(await f.resolver().resolve(f.context, f.lookup)).toBe('pdt_studio');
    expect((await f.billing.summary(f.owner)).grants).toHaveLength(1);
  });
  it.each(['zero', 'multiple'])(
    'rejects %s product memberships without caching a guess',
    async (kind) => {
      const f = await fixture();
      f.lookup.mockResolvedValue({ items: kind === 'zero' ? [] : [f.row()] });
      await expect(
        f.resolver().resolve(f.context, f.lookup),
      ).rejects.toMatchObject({ code: 'PAYMENT_ATTRIBUTION_PENDING' });
      expect(f.store.rows.has(f.key)).toBe(false);
    },
  );
  it.each([
    'customer',
    'subscription',
    'currency',
    'time',
    'total',
    'order',
    'environment',
  ])('rejects mismatched %s provider evidence', async (kind) => {
    const f = await fixture();
    const row = f.row();
    if (kind === 'customer') row.customer.customer_id = 'foreign';
    if (kind === 'subscription') row.subscription_id = 'foreign';
    if (kind === 'currency') row.currency = 'USD';
    if (kind === 'time')
      row.created_at = new Date(
        Date.parse(f.context.createdAt) + 1,
      ).toISOString();
    if (kind === 'total') row.total_amount++;
    if (kind === 'order') row.metadata.picfind_order = 'foreign';
    if (kind === 'environment') row.metadata.picfind_environment = 'live_mode';
    f.lookup.mockResolvedValue({ items: [row] });
    await expect(
      f.resolver().resolve(f.context, f.lookup),
    ).rejects.toMatchObject({ code: 'PAYMENT_ATTRIBUTION_PENDING' });
    expect(f.store.rows.has(f.key)).toBe(false);
  });
  it('rejects duplicate IDs, oversized pages and repeated pagination', async () => {
    const f = await fixture();
    for (const items of [
      [f.row(), f.row()],
      Array.from({ length: 26 }, (_, i) => f.row(`pay_${i}`)),
    ]) {
      f.lookup.mockResolvedValue({ items });
      await expect(
        f.resolver().resolve(f.context, f.lookup),
      ).rejects.toMatchObject({ code: 'PAYMENT_ATTRIBUTION_PENDING' });
    }
    f.lookup.mockResolvedValue({
      items: Array.from({ length: 25 }, (_, i) => f.row(`pay_${i}`)),
    });
    await expect(
      f.resolver().resolve(f.context, f.lookup),
    ).rejects.toMatchObject({ code: 'PAYMENT_ATTRIBUTION_PENDING' });
  });
  it('finds the payment on the second bounded page', async () => {
    const f = await fixture();
    f.lookup.mockImplementation(async (q) => ({
      items:
        q.productId !== 'pdt_original'
          ? []
          : q.page === 0
            ? Array.from({ length: 25 }, (_, i) => f.row(`pay_other_${i}`))
            : [f.row()],
    }));
    expect(await f.resolver().resolve(f.context, f.lookup)).toBe(
      'pdt_original',
    );
    expect(f.lookup).toHaveBeenCalledTimes(3);
  });
  it('stops after two full unmatched pages instead of scanning merchant history', async () => {
    const f = await fixture();
    f.lookup.mockImplementation(async (q) => ({
      items: Array.from({ length: 25 }, (_, i) => f.row(`pay_${q.page}_${i}`)),
    }));
    await expect(
      f.resolver().resolve(f.context, f.lookup),
    ).rejects.toMatchObject({ code: 'PAYMENT_ATTRIBUTION_PENDING' });
    expect(f.lookup).toHaveBeenCalledTimes(2);
  });
  it.each(['owner', 'currency', 'customer', 'plan'])(
    'rejects a mismatched saved order %s before querying provider',
    async (field) => {
      const f = await fixture();
      const order = f.store.rows.get(f.order.id)!.value as BillingOrder;
      if (field === 'owner') order.ownerId = 'foreign';
      if (field === 'currency') order.currency = 'USD';
      if (field === 'customer') order.customerId = 'foreign';
      if (field === 'plan') order.plan = 'photo-pack';
      await expect(
        f.resolver().resolve(f.context, f.lookup),
      ).rejects.toMatchObject({ code: 'PAYMENT_ATTRIBUTION_PENDING' });
      expect(f.lookup).not.toHaveBeenCalled();
    },
  );
  it('rejects an order stored under another billing environment even if the owner has both accounts', async () => {
    const f = await fixture();
    f.store.rows.get(f.order.id)!.owner = `live_mode:${f.owner}`;
    await expect(
      f.resolver().resolve(f.context, f.lookup),
    ).rejects.toMatchObject({ code: 'PAYMENT_ATTRIBUTION_PENDING' });
    expect(f.lookup).not.toHaveBeenCalled();
  });
  it('does not cache provisional attribution for a pending payment', async () => {
    const f = await fixture();
    const pending = { ...f.context, status: 'pending' };
    expect(await f.resolver().resolve(pending, f.lookup)).toBe('pdt_original');
    expect(f.store.rows.has(f.key)).toBe(false);
  });
  it('fails safely on lookup outage and leaves unrelated account fields intact', async () => {
    const f = await fixture();
    f.lookup.mockRejectedValue(new Error('secret provider payload'));
    await expect(f.resolver().resolve(f.context, f.lookup)).rejects.toThrow(
      'The original subscription product could not be verified.',
    );
    expect(f.store.rows.has(f.key)).toBe(false);
    expect(f.store.rows.get(f.billing.key('account', f.owner))).toBeDefined();
  });
  it('preserves concurrent account data when committing a receipt', async () => {
    const f = await fixture();
    f.lookup.mockImplementation(async (q) => {
      await f.store.transaction(async (tx) => {
        const key = f.billing.key('account', f.owner);
        const account = (await tx.get<BillingAccount>(key))!;
        account.storedBytes = 7788;
        await tx.put(key, `test_mode:${f.owner}`, 'account', account);
      });
      return { items: q.productId === 'pdt_original' ? [f.row()] : [] };
    });
    await f.resolver().resolve(f.context, f.lookup);
    expect(
      (
        f.store.rows.get(f.billing.key('account', f.owner))!
          .value as BillingAccount
      ).storedBytes,
    ).toBe(7788);
  });
  it('rejects changed customer binding after lookup without recording attribution', async () => {
    const f = await fixture();
    f.lookup.mockImplementation(async (q) => {
      (
        f.store.rows.get(f.billing.key('account', f.owner))!
          .value as BillingAccount
      ).customerId = 'foreign';
      return { items: q.productId === 'pdt_original' ? [f.row()] : [] };
    });
    await expect(
      f.resolver().resolve(f.context, f.lookup),
    ).rejects.toMatchObject({ code: 'PAYMENT_ATTRIBUTION_PENDING' });
    expect(f.store.rows.has(f.key)).toBe(false);
  });
  it('deduplicates concurrent identical receipts', async () => {
    const f = await fixture();
    const a = f.resolver().resolve(f.context, f.lookup);
    const b = f.resolver().resolve(f.context, f.lookup);
    expect(await a).toBe('pdt_original');
    expect(await b).toBe('pdt_original');
    expect([...f.store.rows.keys()].filter((id) => id === f.key)).toHaveLength(
      1,
    );
  });
  it('rejects a changed immutable payment field on cached replay', async () => {
    const f = await fixture();
    await f.resolver().resolve(f.context, f.lookup);
    await expect(
      f
        .resolver()
        .resolve({ ...f.context, total: f.context.total + 1 }, f.lookup),
    ).rejects.toMatchObject({ code: 'PAYMENT_ATTRIBUTION_PENDING' });
  });
  it('rolls back a failed receipt commit and safely retries', async () => {
    const f = await fixture();
    f.lookup.mockImplementation(async (q) => {
      if (q.productId === 'pdt_studio') f.store.failCommit = true;
      return { items: q.productId === 'pdt_original' ? [f.row()] : [] };
    });
    await expect(
      f.resolver().resolve(f.context, f.lookup),
    ).rejects.toMatchObject({ code: 'PAYMENT_ATTRIBUTION_PENDING' });
    expect(f.store.rows.has(f.key)).toBe(false);
    f.lookup.mockImplementation(async (q) => ({
      items: q.productId === 'pdt_original' ? [f.row()] : [],
    }));
    expect(await f.resolver().resolve(f.context, f.lookup)).toBe(
      'pdt_original',
    );
  });
});
