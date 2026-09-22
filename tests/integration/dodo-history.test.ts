import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DodoBillingProvider } from '../../apps/api/src/adapters/dodo-billing.js';
const sdk = vi.hoisted(() => ({
  list: vi.fn(),
  payment: vi.fn(),
  subscription: vi.fn(),
}));
vi.mock('dodopayments', () => ({
  default: class {
    payments = { list: sdk.list, retrieve: sdk.payment };
    subscriptions = { retrieve: sdk.subscription };
  },
}));
const through = '2026-09-21T00:00:00.000Z';
const row = () => ({
  payment_id: 'pay_owned',
  customer: { customer_id: 'cus_owned' },
  created_at: through,
  metadata: {
    picfind_order: 'order-owned',
    picfind_environment: 'test_mode',
    unrelatedFlag: true,
  },
  subscription_id: 'sub_owned',
});
const pay = () => ({
  payment_id: 'pay_owned',
  customer: { customer_id: 'cus_owned' },
  created_at: through,
  metadata: { picfind_order: 'order-owned', picfind_environment: 'test_mode' },
  currency: 'INR',
  status: 'succeeded',
  total_amount: 29900,
  product_cart: [{ product_id: 'pdt_pack', quantity: 1 }],
  refunds: [],
  disputes: [],
  checkout_session_id: 'cks_owned',
});
const provider = () =>
  new DodoBillingProvider({
    apiKey: 'synthetic',
    webhookSecret: 'synthetic',
    environment: 'test_mode',
    webOrigin: 'http://localhost:5173',
  });
beforeEach(() => vi.resetAllMocks());
describe('Dodo history adapter with a synthetic SDK', () => {
  it('lists only one bounded customer page at a fixed cutoff and strips sensitive fields', async () => {
    sdk.list.mockResolvedValue({ items: [row()] });
    const result = await provider().listPayments('cus_owned', 3, through);
    expect(sdk.list).toHaveBeenCalledWith({
      customer_id: 'cus_owned',
      page_number: 3,
      page_size: 5,
      created_at_lte: through,
    });
    expect(result).toEqual({
      items: [
        {
          id: 'pay_owned',
          orderId: 'order-owned',
          environment: 'test_mode',
          subscriptionId: 'sub_owned',
        },
      ],
      hasMore: false,
    });
    expect(sdk.payment).not.toHaveBeenCalled();
  });
  it('requires another page when the current page is full', async () => {
    sdk.list.mockResolvedValue({
      items: Array.from({ length: 5 }, (_, i) => ({
        ...row(),
        payment_id: `pay_${i}`,
      })),
    });
    expect(
      (await provider().listPayments('cus_owned', 0, through)).hasMore,
    ).toBe(true);
  });
  it.each(['customer', 'cutoff', 'oversize', 'schema'])(
    'rejects invalid %s list results',
    async (kind) => {
      const value = row();
      if (kind === 'customer') value.customer.customer_id = 'other';
      if (kind === 'cutoff') value.created_at = '2027-01-01T00:00:00Z';
      if (kind === 'schema') value.payment_id = '';
      sdk.list.mockResolvedValue({
        items:
          kind === 'oversize'
            ? Array.from({ length: 6 }, () => value)
            : [value],
      });
      await expect(
        provider().listPayments('cus_owned', 0, through),
      ).rejects.toMatchObject({ status: 503 });
    },
  );
  it.each([-1, 0.5, 1000])(
    'rejects invalid page %s before provider access',
    async (page) => {
      await expect(
        provider().listPayments('cus_owned', page, through),
      ).rejects.toMatchObject({ status: 503 });
      expect(sdk.list).not.toHaveBeenCalled();
    },
  );
  it('uses authoritative detail refunds/disputes, not list summaries', async () => {
    sdk.payment.mockResolvedValue({
      ...pay(),
      refunds: [
        { status: 'succeeded', amount: 10000 },
        { status: 'pending', amount: 5000 },
      ],
      disputes: [{ dispute_status: 'dispute_opened' }],
    });
    expect(await provider().readPayment('pay_owned')).toMatchObject({
      id: 'pay_owned',
      refunded: 10000,
      held: true,
    });
  });
  it('rejects a mismatched detail payment ID', async () => {
    sdk.payment.mockResolvedValue({ ...pay(), payment_id: 'foreign' });
    await expect(provider().readPayment('pay_owned')).rejects.toMatchObject({
      status: 503,
    });
  });
  it.each(['id', 'customer'])(
    'rejects a mismatched subscription %s',
    async (kind) => {
      sdk.payment.mockResolvedValue({ ...pay(), subscription_id: 'sub_owned' });
      sdk.subscription.mockResolvedValue({
        subscription_id: kind === 'id' ? 'foreign' : 'sub_owned',
        customer: {
          customer_id: kind === 'customer' ? 'foreign' : 'cus_owned',
        },
        metadata: {
          picfind_order: 'order-owned',
          picfind_environment: 'test_mode',
        },
        product_id: 'pdt_creator',
        quantity: 1,
        status: 'active',
        next_billing_date: through,
        cancel_at_next_billing_date: false,
      });
      await expect(provider().readPayment('pay_owned')).rejects.toMatchObject({
        status: 503,
      });
    },
  );
});
