import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  cancelDodoPlanChange,
  inspectDodoPlanCancellation,
  type PlanCancellationRequest,
} from '../../apps/api/src/adapters/dodo-plan-cancellation.js';

function fixture() {
  const date = new Date(Date.now() + 86400000).toISOString();
  const request: PlanCancellationRequest = {
    requestId: randomUUID(),
    scheduleId: 'schedule',
    change: {
      requestId: randomUUID(),
      productId: 'target',
      currency: 'INR',
      interval: 'Month',
      recurringBeforeTax: 199900,
      subscription: {
        id: 'sub',
        orderId: 'order',
        customerId: 'customer',
        productId: 'source',
        status: 'active',
        cancelAtPeriodEnd: false,
        observedAt: new Date().toISOString(),
        nextBillingAt: date,
      },
    },
  };
  const current = {
    subscription_id: 'sub',
    product_id: 'source',
    quantity: 1,
    customer: { customer_id: 'customer' },
    metadata: { picfind_order: 'order', picfind_environment: 'test_mode' },
    currency: 'INR',
    status: 'active',
    next_billing_date: date,
    on_demand: false,
    addons: [],
    scheduled_change: {
      id: 'schedule',
      product_id: 'target',
      quantity: 1,
      effective_at: date,
      addons: [],
    } as unknown,
  };
  const port = {
    retrieve: vi.fn(async () => structuredClone(current)),
    cancelChangePlan: vi.fn(async () => {
      current.scheduled_change = null;
    }),
  };
  return {
    request,
    current,
    port,
    run: () => cancelDodoPlanChange(port, 'test_mode', request, true),
  };
}
describe('scheduled plan cancellation, synthetic provider only', () => {
  it('checks the schedule before deletion and confirms removal without cancelling the subscription', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toMatchObject({
      scheduleId: 'schedule',
      cancelled: true,
    });
    expect(f.port.cancelChangePlan).toHaveBeenCalledWith('sub', {
      maxRetries: 0,
      headers: {
        'Idempotency-Key': `picfind-plan-cancel-test_mode-${f.request.requestId}`,
      },
    });
    expect(f.port.retrieve).toHaveBeenCalledTimes(3);
    expect(f.current.status).toBe('active');
  });
  it('has no mutation permission by default', async () => {
    const f = fixture();
    await expect(
      cancelDodoPlanChange(f.port, 'test_mode', f.request),
    ).rejects.toMatchObject({ code: 'PLAN_CANCELLATION_PENDING' });
    expect(f.port.cancelChangePlan).not.toHaveBeenCalled();
  });
  it('recovers a lost cancellation acknowledgement through a read', async () => {
    const f = fixture();
    f.port.cancelChangePlan.mockImplementation(async () => {
      f.current.scheduled_change = null;
      throw new Error('Private timeout');
    });
    await expect(f.run()).resolves.toMatchObject({ cancelled: true });
    await expect(
      inspectDodoPlanCancellation(f.port, 'test_mode', f.request),
    ).resolves.toMatchObject({ cancelled: true });
    expect(f.port.cancelChangePlan).toHaveBeenCalledTimes(1);
  });
  it('does not repeat a deletion that has not been confirmed', async () => {
    const f = fixture();
    f.port.cancelChangePlan.mockImplementation(async () => undefined);
    await expect(f.run()).rejects.toMatchObject({
      code: 'PLAN_CANCELLATION_PENDING',
    });
    await expect(
      inspectDodoPlanCancellation(f.port, 'test_mode', f.request),
    ).rejects.toMatchObject({ code: 'PLAN_CANCELLATION_PENDING' });
    expect(f.port.cancelChangePlan).toHaveBeenCalledTimes(1);
  });
  it.each(['schedule', 'customer', 'product', 'environment', 'missing-field'])(
    'rejects a changed %s binding without deletion',
    async (kind) => {
      const f = fixture();
      if (kind === 'schedule')
        f.current.scheduled_change = {
          ...(f.current.scheduled_change as object),
          id: 'another-schedule',
        };
      if (kind === 'customer') f.current.customer.customer_id = 'other';
      if (kind === 'product') f.current.product_id = 'target';
      if (kind === 'environment')
        f.current.metadata.picfind_environment = 'live_mode';
      if (kind === 'missing-field') f.current.scheduled_change = undefined;
      await expect(f.run()).rejects.toMatchObject({
        code: 'PLAN_CANCELLATION_PENDING',
      });
      expect(f.port.cancelChangePlan).not.toHaveBeenCalled();
    },
  );
});
