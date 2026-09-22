import { z } from 'zod';
import { ApiError } from '../auth.js';
import type { PlanCancellationRequest } from '../billing/model.js';

export type { PlanCancellationRequest } from '../billing/model.js';
interface Port {
  retrieve(id: string): Promise<unknown>;
  cancelChangePlan?(
    id: string,
    options: { maxRetries: number; headers: Record<string, string> },
  ): Promise<unknown>;
}
const schema = z.object({
  subscription_id: z.string(),
  product_id: z.string(),
  quantity: z.literal(1),
  customer: z.object({ customer_id: z.string() }),
  metadata: z.record(z.string(), z.string()),
  currency: z.enum(['INR', 'USD']),
  status: z.string(),
  next_billing_date: z.iso.datetime({ offset: true }),
  on_demand: z.literal(false),
  addons: z.array(z.unknown()).length(0),
  scheduled_change: z
    .object({
      id: z.string(),
      product_id: z.string(),
      quantity: z.literal(1),
      effective_at: z.iso.datetime({ offset: true }),
      addons: z.array(z.unknown()).length(0),
    })
    .nullable(),
});
const pending = () =>
  new ApiError(
    503,
    'PLAN_CANCELLATION_PENDING',
    'The scheduled change cancellation is not confirmed. Check its status before trying another change.',
  );

/** Caller must persist explicit cancellation consent and a one-time attempt before allowing submission. */
export async function cancelDodoPlanChange(
  port: Port,
  environment: 'test_mode' | 'live_mode',
  request: PlanCancellationRequest,
  allowSubmission = false,
) {
  const expected = request.change.subscription;
  if (
    !z.uuid().safeParse(request.requestId).success ||
    !request.scheduleId ||
    request.change.productId === expected.productId
  )
    throw pending();
  const read = async () => {
    const current = schema.parse(await port.retrieve(expected.id));
    if (
      current.subscription_id !== expected.id ||
      current.customer.customer_id !== expected.customerId ||
      current.metadata.picfind_order !== expected.orderId ||
      current.metadata.picfind_environment !== environment ||
      current.product_id !== expected.productId ||
      current.currency !== request.change.currency ||
      Date.parse(current.next_billing_date) !==
        Date.parse(expected.nextBillingAt)
    )
      throw pending();
    const schedule = current.scheduled_change;
    if (
      schedule &&
      (schedule.id !== request.scheduleId ||
        schedule.product_id !== request.change.productId ||
        Date.parse(schedule.effective_at) !==
          Date.parse(expected.nextBillingAt))
    )
      throw pending();
    return current;
  };
  const confirmed = () => ({
    subscriptionId: expected.id,
    scheduleId: request.scheduleId,
    cancelled: true as const,
  });
  try {
    const first = await read();
    if (!first.scheduled_change) return confirmed();
    if (
      !allowSubmission ||
      !port.cancelChangePlan ||
      first.status !== 'active' ||
      Date.parse(expected.nextBillingAt) <= Date.now() + 60_000
    )
      throw pending();
    const latest = await read();
    if (!latest.scheduled_change) return confirmed();
    if (
      latest.status !== 'active' ||
      Date.parse(expected.nextBillingAt) <= Date.now() + 60_000
    )
      throw pending();
    try {
      await port.cancelChangePlan(expected.id, {
        maxRetries: 0,
        headers: {
          'Idempotency-Key': `picfind-plan-cancel-${environment}-${request.requestId}`,
        },
      });
    } catch {
      // A lost response is not permission to repeat a DELETE. Inspect the result instead.
    }
    if ((await read()).scheduled_change) throw pending();
    return confirmed();
  } catch {
    throw pending();
  }
}

export function inspectDodoPlanCancellation(
  port: Pick<Port, 'retrieve'>,
  environment: 'test_mode' | 'live_mode',
  request: PlanCancellationRequest,
) {
  return cancelDodoPlanChange(
    { retrieve: (id) => port.retrieve(id) },
    environment,
    request,
  );
}
