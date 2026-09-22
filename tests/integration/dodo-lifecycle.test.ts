import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DodoBillingProvider } from '../../apps/api/src/adapters/dodo-billing.js';
import type { BillingOrder } from '../../apps/api/src/billing/model.js';

const sdk = vi.hoisted(() => ({
  checkout: vi.fn(),
  payment: vi.fn(),
  subscription: vi.fn(),
  update: vi.fn(),
}));
vi.mock('dodopayments', () => ({
  default: class SyntheticDodo {
    checkoutSessions = { retrieve: sdk.checkout };
    payments = { retrieve: sdk.payment };
    subscriptions = { retrieve: sdk.subscription, update: sdk.update };
  },
}));
const order: BillingOrder = {
  id: 'owned-order',
  ownerId: 'owner',
  plan: 'photo-pack',
  currency: 'INR',
  productId: 'pdt_pack',
  createdAt: '2026-09-21T00:00:00Z',
  sessionId: 'cks_owned',
};
const sub = () => ({
  subscription_id: 'sub_owned',
  metadata: { picfind_order: 'owned-order', picfind_environment: 'test_mode' },
  customer: { customer_id: 'cus_owner' },
  product_id: 'pdt_creator',
  quantity: 1,
  status: 'active',
  next_billing_date: '2026-10-21T00:00:00Z',
  cancel_at_next_billing_date: false,
});
const pay = () => ({
  payment_id: 'pay_owned',
  metadata: { picfind_order: order.id, picfind_environment: 'test_mode' },
  customer: { customer_id: 'cus_owner' },
  currency: 'INR',
  status: 'succeeded',
  total_amount: 29900,
  created_at: '2026-09-21T00:00:00Z',
  checkout_session_id: order.sessionId,
  product_cart: [{ product_id: 'pdt_pack', quantity: 1 }],
  refunds: [],
  disputes: [],
});
function provider() {
  return new DodoBillingProvider({
    apiKey: 'synthetic-never-used',
    webhookSecret: 'synthetic',
    environment: 'test_mode',
    webOrigin: 'http://localhost:5173',
  });
}
beforeEach(() => vi.resetAllMocks());

describe('Dodo lifecycle adapter using a synthetic SDK, no network calls', () => {
  it('never treats an unsubmitted checkout as a paid purchase', async () => {
    sdk.checkout.mockResolvedValue({
      id: order.sessionId,
      payment_id: null,
      payment_status: null,
    });
    expect(await provider().inspectCheckout(order)).toBeNull();
    expect(sdk.payment).not.toHaveBeenCalled();
  });
  it('retrieves the authoritative payment behind the exact saved session', async () => {
    sdk.checkout.mockResolvedValue({
      id: order.sessionId,
      payment_id: 'pay_owned',
      payment_status: 'succeeded',
    });
    sdk.payment.mockResolvedValue(pay());
    const result = await provider().inspectCheckout(order);
    expect(result?.payment).toMatchObject({
      id: 'pay_owned',
      orderId: order.id,
      sessionId: order.sessionId,
      status: 'succeeded',
    });
    expect(sdk.payment).toHaveBeenCalledWith('pay_owned');
  });
  it.each(['session', 'order', 'environment'])(
    'rejects a mismatched %s instead of accepting its payment',
    async (kind) => {
      sdk.checkout.mockResolvedValue({
        id: order.sessionId,
        payment_id: 'pay_owned',
      });
      const payment = pay();
      if (kind === 'session') payment.checkout_session_id = 'cks_foreign';
      if (kind === 'order') payment.metadata.picfind_order = 'foreign-order';
      if (kind === 'environment')
        payment.metadata.picfind_environment = 'live_mode';
      sdk.payment.mockResolvedValue(payment);
      await expect(provider().inspectCheckout(order)).rejects.toMatchObject({
        code: 'BILLING_RECONCILIATION_PENDING',
      });
    },
  );
  it('sets a period-end cancellation without changing prices or granting a refund', async () => {
    sdk.update.mockResolvedValue({
      ...sub(),
      cancel_at_next_billing_date: true,
    });
    expect(
      (await provider().cancelSubscription('sub_owned', false))
        .cancelAtPeriodEnd,
    ).toBe(true);
    expect(sdk.update).toHaveBeenCalledWith('sub_owned', {
      cancel_at_next_billing_date: true,
    });
  });
  it('immediate cancellation explicitly clears a previously scheduled period-end flag', async () => {
    sdk.update.mockResolvedValue({
      ...sub(),
      status: 'cancelled',
      cancel_at_next_billing_date: false,
    });
    expect(
      (await provider().cancelSubscription('sub_owned', true)).status,
    ).toBe('cancelled');
    expect(sdk.update).toHaveBeenCalledWith('sub_owned', {
      status: 'cancelled',
      cancel_at_next_billing_date: false,
    });
  });
  it('treats provider read and cancellation failures as unconfirmed, never successful', async () => {
    sdk.subscription.mockRejectedValue(new Error('Synthetic outage'));
    sdk.update.mockRejectedValue(new Error('Synthetic lost response'));
    await expect(
      provider().readSubscription('sub_owned'),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      provider().cancelSubscription('sub_owned', true),
    ).rejects.toMatchObject({ status: 503 });
  });
});
