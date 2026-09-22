import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  scheduleDodoPlanChange,
  inspectDodoPlanChange,
  type ApprovedPlanChangeRequest,
} from '../../apps/api/src/adapters/dodo-plan-scheduling.js';
import { DodoBillingProvider } from '../../apps/api/src/adapters/dodo-billing.js';

function fixture() {
  const at = new Date(Date.now() + 86400000).toISOString();
  const request: ApprovedPlanChangeRequest = {
    requestId: randomUUID(),
    productId: 'pdt_pro',
    currency: 'INR',
    interval: 'Month',
    recurringBeforeTax: 199900,
    subscription: {
      id: 'sub_owned',
      orderId: 'order_owned',
      customerId: 'cus_owned',
      productId: 'pdt_starter',
      status: 'active',
      nextBillingAt: at,
      observedAt: new Date().toISOString(),
      cancelAtPeriodEnd: false,
    },
  };
  const current = {
    subscription_id: 'sub_owned',
    customer: { customer_id: 'cus_owned' },
    metadata: {
      picfind_order: 'order_owned',
      picfind_environment: 'test_mode',
    },
    product_id: 'pdt_starter',
    quantity: 1,
    currency: 'INR',
    status: 'active',
    next_billing_date: at,
    cancel_at_next_billing_date: false,
    on_demand: false,
    addons: [],
    scheduled_change: null as unknown,
  };
  const schedule = {
    id: 'schedule_owned',
    product_id: 'pdt_pro',
    quantity: 1,
    effective_at: at,
    addons: [],
  };
  const port = {
    retrieve: vi.fn(async () => structuredClone(current)),
    changePlan: vi.fn(async () => {
      current.scheduled_change = schedule;
    }),
  };
  const preview = vi.fn(async () => ({
    currency: 'INR' as const,
    chargeNow: 0,
    recurringBeforeTax: 199900,
    effectiveAt: at,
  }));
  const run = () => scheduleDodoPlanChange(port, 'test_mode', request, preview);
  return { request, current, schedule, port, preview, run };
}
describe('Dodo scheduling contract with synthetic provider responses only', () => {
  it('exposes read-only adapter recovery even while new plan changes are disabled', async () => {
    const scheduling =
      await import('../../apps/api/src/adapters/dodo-plan-scheduling.js');
    const f = fixture();
    const receipt = {
      id: 'schedule_owned',
      subscriptionId: 'sub_owned',
      orderId: 'order_owned',
      customerId: 'cus_owned',
      productId: 'pdt_pro',
      currency: 'INR' as const,
      quantity: 1 as const,
      effectiveAt: f.request.subscription.nextBillingAt,
    };
    const inspect = vi
      .spyOn(scheduling, 'inspectDodoPlanChange')
      .mockResolvedValue(receipt);
    const mutate = vi.spyOn(scheduling, 'scheduleDodoPlanChange');
    try {
      const provider = new DodoBillingProvider({
        apiKey: 'synthetic',
        webhookSecret: 'synthetic',
        environment: 'test_mode',
        webOrigin: 'http://localhost:5173',
      });
      await expect(provider.inspectPlanChange(f.request)).resolves.toEqual(
        receipt,
      );
      expect(inspect).toHaveBeenCalledWith(
        expect.any(Object),
        'test_mode',
        f.request,
      );
      expect(mutate).not.toHaveBeenCalled();
    } finally {
      inspect.mockRestore();
      mutate.mockRestore();
    }
  });
  it('recovers an existing matching schedule without mutation or price preview', async () => {
    const f = fixture();
    f.current.scheduled_change = f.schedule;
    await expect(
      inspectDodoPlanChange(f.port, 'test_mode', f.request),
    ).resolves.toMatchObject({ id: 'schedule_owned', productId: 'pdt_pro' });
    expect(f.port.retrieve).toHaveBeenCalledTimes(1);
    expect(f.port.changePlan).not.toHaveBeenCalled();
    expect(f.preview).not.toHaveBeenCalled();
  });
  it('does not resubmit when recovery cannot find a saved schedule', async () => {
    const f = fixture();
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        inspectDodoPlanChange(f.port, 'test_mode', f.request),
      ).rejects.toMatchObject({ code: 'PLAN_CHANGE_RECONCILIATION_PENDING' });
    }
    expect(f.port.changePlan).not.toHaveBeenCalled();
    expect(f.preview).not.toHaveBeenCalled();
  });
  it('does not overwrite a conflicting schedule during recovery', async () => {
    const f = fixture();
    f.current.scheduled_change = { ...f.schedule, product_id: 'other-product' };
    await expect(
      inspectDodoPlanChange(f.port, 'test_mode', f.request),
    ).rejects.toMatchObject({ code: 'PLAN_CHANGE_RECONCILIATION_PENDING' });
    expect(f.port.changePlan).not.toHaveBeenCalled();
  });
  it('sanitizes recovery failures without permitting a fallback mutation', async () => {
    const f = fixture();
    f.port.retrieve.mockRejectedValue(new Error('private-provider-detail'));
    await expect(
      inspectDodoPlanChange(f.port, 'test_mode', f.request),
    ).rejects.toMatchObject({
      code: 'PLAN_CHANGE_RECONCILIATION_PENDING',
      message:
        'The plan change could not be confirmed. Refresh its status before requesting another change.',
    });
    expect(f.port.changePlan).not.toHaveBeenCalled();
  });
  it('is disabled in the configured adapter by default', async () => {
    const provider = new DodoBillingProvider({
      apiKey: 'synthetic',
      webhookSecret: 'synthetic',
      environment: 'test_mode',
      webOrigin: 'http://localhost:5173',
    });
    await expect(
      provider.schedulePlanChange(fixture().request),
    ).rejects.toMatchObject({ code: 'PLAN_CHANGE_UNAVAILABLE' });
  });
  it('uses explicit next-renewal semantics and confirms the saved schedule', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toMatchObject({
      id: 'schedule_owned',
      productId: 'pdt_pro',
      quantity: 1,
    });
    expect(f.port.changePlan).toHaveBeenCalledWith(
      'sub_owned',
      {
        product_id: 'pdt_pro',
        quantity: 1,
        effective_at: 'next_billing_date',
        proration_billing_mode: 'full_immediately',
        on_payment_failure: 'prevent_change',
      },
      {
        maxRetries: 0,
        headers: {
          'Idempotency-Key': `picfind-plan-test_mode-${f.request.requestId}`,
        },
      },
    );
    expect(f.port.retrieve).toHaveBeenCalledTimes(3);
    await f.run();
    expect(f.port.changePlan).toHaveBeenCalledTimes(1);
  });
  it('recovers an ambiguous accepted request by reading, never submitting twice', async () => {
    const f = fixture();
    f.port.changePlan.mockImplementation(async () => {
      f.current.scheduled_change = f.schedule;
      throw new Error('private timeout detail');
    });
    await expect(f.run()).resolves.toMatchObject({ id: 'schedule_owned' });
    expect(f.port.changePlan).toHaveBeenCalledTimes(1);
  });
  it('does not treat a 200 response without a saved schedule as success', async () => {
    const f = fixture();
    f.port.changePlan.mockImplementation(async () => {});
    await expect(f.run()).rejects.toMatchObject({
      code: 'PLAN_CHANGE_RECONCILIATION_PENDING',
    });
    expect(f.port.changePlan).toHaveBeenCalledTimes(1);
  });
  it.each([
    { currency: 'USD' },
    { chargeNow: 1 },
    { recurringBeforeTax: 199901 },
    { effectiveAt: '2000-01-01T00:00:00Z' },
  ])('rejects changed pricing before submission %#', async (change) => {
    const f = fixture();
    f.preview.mockResolvedValue({ ...(await f.preview()), ...change } as never);
    await expect(f.run()).rejects.toMatchObject({
      code: 'PLAN_CHANGE_RECONCILIATION_PENDING',
    });
    expect(f.port.changePlan).not.toHaveBeenCalled();
  });
  it.each([
    { subscription_id: 'foreign' },
    { customer: { customer_id: 'foreign' } },
    { currency: 'USD' },
    { quantity: 2 },
    { cancel_at_next_billing_date: true },
    { addons: [{}] },
    {
      metadata: {
        picfind_order: 'order_owned',
        picfind_environment: 'live_mode',
      },
    },
  ])('rejects unsafe provider state without writes %#', async (change) => {
    const f = fixture();
    Object.assign(f.current, change);
    await expect(f.run()).rejects.toMatchObject({
      code: 'PLAN_CHANGE_RECONCILIATION_PENDING',
    });
    expect(f.port.changePlan).not.toHaveBeenCalled();
  });
  it('never replaces a different pending schedule', async () => {
    const f = fixture();
    f.current.scheduled_change = { ...f.schedule, product_id: 'pdt_other' };
    await expect(f.run()).rejects.toMatchObject({
      code: 'PLAN_CHANGE_RECONCILIATION_PENDING',
    });
    expect(f.port.changePlan).not.toHaveBeenCalled();
  });
});
