import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DodoBillingProvider } from '../../apps/api/src/adapters/dodo-billing.js';
import type {
  SubscriptionPaymentContext,
  ProductPaymentQuery,
} from '../../apps/api/src/billing/payment-attribution.js';
const sdk = vi.hoisted(() => ({
  payment: vi.fn(),
  subscription: vi.fn(),
  list: vi.fn(),
}));
vi.mock('dodopayments', () => ({
  default: class {
    payments = { retrieve: sdk.payment, list: sdk.list };
    subscriptions = { retrieve: sdk.subscription };
  },
}));
const config = {
  apiKey: 'synthetic',
  webhookSecret: 'synthetic',
  environment: 'test_mode' as const,
  webOrigin: 'http://localhost:5173',
};
function payment() {
  return {
    payment_id: 'pay_old',
    customer: { customer_id: 'cus_owned' },
    metadata: {
      picfind_order: 'a'.repeat(36),
      picfind_environment: 'test_mode',
    },
    subscription_id: 'sub_owned',
    product_cart: null,
    currency: 'INR',
    total_amount: 99900,
    status: 'succeeded',
    created_at: '2026-09-01T12:00:00Z',
    refunds: [],
    disputes: [],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  sdk.payment.mockResolvedValue(payment());
  sdk.subscription.mockResolvedValue({
    subscription_id: 'sub_owned',
    customer: { customer_id: 'cus_owned' },
    metadata: {
      picfind_order: 'a'.repeat(36),
      picfind_environment: 'test_mode',
    },
    product_id: 'pdt_current',
    quantity: 1,
    status: 'active',
    next_billing_date: '2026-10-21T12:00:00Z',
    cancel_at_next_billing_date: false,
  });
});
describe('Dodo historical attribution wiring', () => {
  it('does not use the current product when no attribution resolver is configured', async () => {
    await expect(
      new DodoBillingProvider(config).readPayment('pay_old'),
    ).rejects.toMatchObject({ code: 'BILLING_RECONCILIATION_PENDING' });
  });
  it('passes payment identity to the resolver and uses bounded SDK filter arguments', async () => {
    sdk.list.mockResolvedValue({ items: [{ payment_id: 'pay_old' }] });
    const resolver = vi.fn(
      async (
        context: SubscriptionPaymentContext,
        lookup: (query: ProductPaymentQuery) => Promise<unknown>,
      ) => {
        expect(context).toMatchObject({
          paymentId: 'pay_old',
          customerId: 'cus_owned',
          subscriptionId: 'sub_owned',
          total: 99900,
        });
        await lookup({
          productId: 'pdt_original',
          customerId: context.customerId,
          subscriptionId: context.subscriptionId,
          currency: 'INR',
          from: '2026-09-01T11:59:59Z',
          through: '2026-09-01T12:00:01Z',
          page: 0,
          pageSize: 25,
        });
        return 'pdt_original';
      },
    );
    const result = await new DodoBillingProvider({
      ...config,
      resolveSubscriptionProduct: resolver,
    }).readPayment('pay_old');
    expect(result.productId).toBe('pdt_original');
    expect(result.subscription?.productId).toBe('pdt_current');
    expect(sdk.list).toHaveBeenCalledWith({
      product_id: 'pdt_original',
      customer_id: 'cus_owned',
      subscription_id: 'sub_owned',
      currency: 'INR',
      created_at_gte: '2026-09-01T11:59:59Z',
      created_at_lte: '2026-09-01T12:00:01Z',
      page_number: 0,
      page_size: 25,
    });
  });
  it('retains immutable payment carts without extra membership reads', async () => {
    sdk.payment.mockResolvedValue({
      ...payment(),
      product_cart: [{ product_id: 'pdt_old', quantity: 1 }],
    });
    const resolver = vi.fn();
    const result = await new DodoBillingProvider({
      ...config,
      resolveSubscriptionProduct: resolver,
    }).readPayment('pay_old');
    expect(result.productId).toBe('pdt_old');
    expect(resolver).not.toHaveBeenCalled();
  });
  it('sanitizes attribution failures rather than falling back to the current product', async () => {
    const resolver = vi.fn(async () => {
      throw new Error('secret private ledger information');
    });
    await expect(
      new DodoBillingProvider({
        ...config,
        resolveSubscriptionProduct: resolver,
      }).readPayment('pay_old'),
    ).rejects.toThrow('A historical payment could not be verified.');
  });
  it('rejects unsupported subscription quantity before trying membership attribution', async () => {
    const original = await sdk.subscription();
    sdk.subscription.mockResolvedValue({ ...original, quantity: 2 });
    const resolver = vi.fn();
    await expect(
      new DodoBillingProvider({
        ...config,
        resolveSubscriptionProduct: resolver,
      }).readPayment('pay_old'),
    ).rejects.toMatchObject({ code: 'BILLING_RECONCILIATION_PENDING' });
    expect(resolver).not.toHaveBeenCalled();
  });
});
