import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DodoBillingProvider } from '../../apps/api/src/adapters/dodo-billing.js';
import type { SubscriptionSnapshot } from '../../apps/api/src/billing/model.js';
const sdk = vi.hoisted(() => ({
  preview: vi.fn(),
  payment: vi.fn(),
  subscription: vi.fn(),
  change: vi.fn(),
}));
vi.mock('dodopayments', () => ({
  default: class {
    subscriptions = {
      previewChangePlan: sdk.preview,
      retrieve: sdk.subscription,
      changePlan: sdk.change,
    };
    payments = { retrieve: sdk.payment };
  },
}));
const expected: SubscriptionSnapshot = {
  id: 'sub_owned',
  orderId: 'order_owned',
  customerId: 'cus_owned',
  productId: 'pdt_creator',
  status: 'active',
  nextBillingAt: '2026-10-21T12:00:00Z',
  cancelAtPeriodEnd: false,
  observedAt: '2026-09-21T12:00:00Z',
};
function plan() {
  return {
    subscription_id: 'sub_owned',
    customer: { customer_id: 'cus_owned', email: 'private@example.test' },
    metadata: {
      picfind_order: 'order_owned',
      picfind_environment: 'test_mode',
    },
    product_id: 'pdt_studio',
    quantity: 1,
    currency: 'INR',
    status: 'active',
    next_billing_date: expected.nextBillingAt,
    cancel_at_next_billing_date: false,
    recurring_pre_tax_amount: 249900,
    payment_frequency_count: 1,
    payment_frequency_interval: 'Month',
    on_demand: false,
    addons: [],
  };
}
function response() {
  return {
    immediate_charge: { summary: { currency: 'INR', total_amount: 0 } },
    new_plan: plan(),
  };
}
const provider = () =>
  new DodoBillingProvider({
    apiKey: 'synthetic',
    webhookSecret: 'synthetic',
    environment: 'test_mode',
    webOrigin: 'http://localhost:5173',
  });
beforeEach(() => vi.resetAllMocks());
describe('Dodo plan preview adapter without provider network calls', () => {
  it('only calls the read-only preview with explicit no-charge next-renewal semantics', async () => {
    sdk.preview.mockResolvedValue(response());
    expect(
      await provider().previewPlanChange(expected, 'pdt_studio', 'INR'),
    ).toEqual({
      currency: 'INR',
      chargeNow: 0,
      recurringBeforeTax: 249900,
      effectiveAt: expected.nextBillingAt,
    });
    expect(sdk.preview).toHaveBeenCalledWith('sub_owned', {
      product_id: 'pdt_studio',
      quantity: 1,
      effective_at: 'next_billing_date',
      proration_billing_mode: 'full_immediately',
      on_payment_failure: 'prevent_change',
    });
    expect(sdk.change).not.toHaveBeenCalled();
  });
  it.each([
    { subscription_id: 'foreign' },
    { customer: { customer_id: 'foreign' } },
    { product_id: 'pdt_foreign' },
    { quantity: 2 },
    { currency: 'USD' },
    {
      metadata: { picfind_order: 'foreign', picfind_environment: 'test_mode' },
    },
    {
      metadata: {
        picfind_order: 'order_owned',
        picfind_environment: 'live_mode',
      },
    },
    { next_billing_date: '2026-11-21T12:00:00Z' },
    { cancel_at_next_billing_date: true },
    { recurring_pre_tax_amount: -1 },
    { recurring_pre_tax_amount: 1.5 },
    { on_demand: true },
    { payment_frequency_interval: 'Year' },
    { addons: [{}] },
  ])('rejects mismatched or unsupported preview details %#', async (change) => {
    sdk.preview.mockResolvedValue({
      ...response(),
      new_plan: { ...plan(), ...change },
    });
    await expect(
      provider().previewPlanChange(expected, 'pdt_studio', 'INR'),
    ).rejects.toMatchObject({ code: 'PLAN_PREVIEW_UNAVAILABLE' });
    expect(sdk.change).not.toHaveBeenCalled();
  });
  it('rejects an immediate charge and sanitizes provider exceptions', async () => {
    sdk.preview.mockResolvedValue({
      ...response(),
      immediate_charge: { summary: { currency: 'INR', total_amount: 100 } },
    });
    await expect(
      provider().previewPlanChange(expected, 'pdt_studio', 'INR'),
    ).rejects.toMatchObject({ code: 'PLAN_PREVIEW_UNAVAILABLE' });
    sdk.preview.mockRejectedValue(new Error('secret provider payload'));
    await expect(
      provider().previewPlanChange(expected, 'pdt_studio', 'INR'),
    ).rejects.toThrow('A renewal price preview could not be verified.');
  });
  it('preserves an old payment cart product and quantity after the subscription changes', async () => {
    sdk.subscription.mockResolvedValue(plan());
    sdk.payment.mockResolvedValue({
      payment_id: 'pay_old',
      metadata: {
        picfind_order: 'order_owned',
        picfind_environment: 'test_mode',
      },
      customer: { customer_id: 'cus_owned' },
      currency: 'INR',
      status: 'succeeded',
      total_amount: 99900,
      created_at: '2026-09-01T12:00:00Z',
      subscription_id: 'sub_owned',
      product_cart: [{ product_id: 'pdt_creator', quantity: 1 }],
      refunds: [],
      disputes: [],
    });
    const result = await provider().readPayment('pay_old');
    expect(result.productId).toBe('pdt_creator');
    expect(result.subscription?.productId).toBe('pdt_studio');
    expect(result.quantity).toBe(1);
  });
  it('does not accept a subscription payment with multiple historical products', async () => {
    sdk.subscription.mockResolvedValue(plan());
    sdk.payment.mockResolvedValue({
      payment_id: 'pay_old',
      metadata: {
        picfind_order: 'order_owned',
        picfind_environment: 'test_mode',
      },
      customer: { customer_id: 'cus_owned' },
      currency: 'INR',
      status: 'succeeded',
      total_amount: 99900,
      created_at: '2026-09-01T12:00:00Z',
      subscription_id: 'sub_owned',
      product_cart: [
        { product_id: 'pdt_creator', quantity: 1 },
        { product_id: 'pdt_other', quantity: 1 },
      ],
      refunds: [],
      disputes: [],
    });
    await expect(provider().readPayment('pay_old')).rejects.toMatchObject({
      code: 'BILLING_RECONCILIATION_PENDING',
    });
  });
});

describe('organizer preview cadence verification', () => {
  it('accepts the requested annual cadence without a provider mutation', async () => {
    sdk.preview.mockResolvedValue({
      ...response(),
      new_plan: {
        ...plan(),
        payment_frequency_interval: 'Year',
        recurring_pre_tax_amount: 1999900,
      },
    });
    expect(
      await provider().previewPlanChange(expected, 'pdt_studio', 'INR', 'Year'),
    ).toMatchObject({ recurringBeforeTax: 1999900, chargeNow: 0 });
    expect(sdk.change).not.toHaveBeenCalled();
  });
  it.each([
    { payment_frequency_interval: 'Month', payment_frequency_count: 1 },
    { payment_frequency_interval: 'Year', payment_frequency_count: 2 },
    { payment_frequency_interval: 'Day', payment_frequency_count: 365 },
  ])('rejects the wrong annual billing cadence %#', async (cadence) => {
    sdk.preview.mockResolvedValue({
      ...response(),
      new_plan: { ...plan(), ...cadence },
    });
    await expect(
      provider().previewPlanChange(expected, 'pdt_studio', 'INR', 'Year'),
    ).rejects.toMatchObject({ code: 'PLAN_PREVIEW_UNAVAILABLE' });
    expect(sdk.change).not.toHaveBeenCalled();
  });
});
