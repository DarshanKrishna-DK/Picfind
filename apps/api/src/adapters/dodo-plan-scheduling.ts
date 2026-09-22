import { z } from 'zod';
import { ApiError } from '../auth.js';
import type {
  PlanChangePrice,
  ApprovedPlanChangeRequest,
} from '../billing/model.js';

export type { ApprovedPlanChangeRequest } from '../billing/model.js';
interface SchedulePort {
  retrieve(id: string): Promise<unknown>;
  changePlan?(
    id: string,
    body: {
      product_id: string;
      quantity: number;
      effective_at: 'next_billing_date';
      proration_billing_mode: 'full_immediately';
      on_payment_failure: 'prevent_change';
    },
    options: { maxRetries: number; headers: Record<string, string> },
  ): Promise<unknown>;
}
const scheduled = z.object({
  id: z.string().min(1),
  product_id: z.string().min(1),
  quantity: z.literal(1),
  effective_at: z.iso.datetime({ offset: true }),
  addons: z.array(z.unknown()).length(0),
});
const schema = z.object({
  subscription_id: z.string(),
  product_id: z.string(),
  quantity: z.literal(1),
  customer: z.object({ customer_id: z.string() }),
  metadata: z.record(z.string(), z.string()),
  currency: z.enum(['INR', 'USD']),
  status: z.literal('active'),
  cancel_at_next_billing_date: z.literal(false),
  next_billing_date: z.iso.datetime({ offset: true }),
  on_demand: z.literal(false),
  addons: z.array(z.unknown()).length(0),
  scheduled_change: scheduled.nullish(),
});
const pending = () =>
  new ApiError(
    503,
    'PLAN_CHANGE_RECONCILIATION_PENDING',
    'The plan change could not be confirmed. Refresh its status before requesting another change.',
  );

/** Caller must persist the owner-approved quote and acquire a durable attempt before calling. */
export async function scheduleDodoPlanChange(
  port: SchedulePort,
  environment: 'test_mode' | 'live_mode',
  request: ApprovedPlanChangeRequest,
  preview?: () => Promise<PlanChangePrice>,
) {
  const expected = request.subscription;
  if (
    !z.uuid().safeParse(request.requestId).success ||
    !request.productId ||
    request.productId === expected.productId ||
    !Number.isSafeInteger(request.recurringBeforeTax) ||
    request.recurringBeforeTax < 0 ||
    expected.status !== 'active' ||
    expected.cancelAtPeriodEnd ||
    !Number.isFinite(Date.parse(expected.nextBillingAt)) ||
    Date.parse(expected.nextBillingAt) <= Date.now() + 60_000
  )
    throw pending();
  const read = async () => {
    const value = schema.parse(await port.retrieve(expected.id));
    if (
      value.subscription_id !== expected.id ||
      value.customer.customer_id !== expected.customerId ||
      value.metadata.picfind_order !== expected.orderId ||
      value.metadata.picfind_environment !== environment ||
      value.product_id !== expected.productId ||
      value.currency !== request.currency ||
      Date.parse(value.next_billing_date) !== Date.parse(expected.nextBillingAt)
    )
      throw pending();
    if (
      value.scheduled_change &&
      (value.scheduled_change.product_id !== request.productId ||
        Date.parse(value.scheduled_change.effective_at) !==
          Date.parse(expected.nextBillingAt))
    )
      throw pending();
    return value.scheduled_change;
  };
  const receipt = (value: z.infer<typeof scheduled>) => ({
    id: value.id,
    subscriptionId: expected.id,
    orderId: expected.orderId,
    customerId: expected.customerId,
    productId: request.productId,
    currency: request.currency,
    quantity: 1 as const,
    effectiveAt: value.effective_at,
  });
  try {
    const existing = await read();
    if (existing) return receipt(existing);
    if (!port.changePlan || !preview) throw pending();
    const price = await preview();
    if (
      price.currency !== request.currency ||
      price.chargeNow !== 0 ||
      price.recurringBeforeTax !== request.recurringBeforeTax ||
      Date.parse(price.effectiveAt) !== Date.parse(expected.nextBillingAt)
    )
      throw pending();
    const concurrent = await read();
    if (concurrent) return receipt(concurrent);
    try {
      await port.changePlan(
        expected.id,
        {
          product_id: request.productId,
          quantity: 1,
          effective_at: 'next_billing_date',
          proration_billing_mode: 'full_immediately',
          on_payment_failure: 'prevent_change',
        },
        {
          maxRetries: 0,
          headers: {
            'Idempotency-Key': `picfind-plan-${environment}-${request.requestId}`,
          },
        },
      );
    } catch {
      // An ambiguous timeout is not permission to submit again. Read the provider instead.
    }
    const saved = await read();
    if (!saved) throw pending();
    return receipt(saved);
  } catch {
    throw pending();
  }
}

/** Recovery deliberately receives no mutation capability, even if the original port has one. */
export function inspectDodoPlanChange(
  port: Pick<SchedulePort, 'retrieve'>,
  environment: 'test_mode' | 'live_mode',
  request: ApprovedPlanChangeRequest,
) {
  return scheduleDodoPlanChange(
    { retrieve: (id) => port.retrieve(id) },
    environment,
    request,
  );
}
