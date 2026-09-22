import { randomUUID } from 'node:crypto';
import DodoPayments from 'dodopayments';
import { z } from 'zod';
import { ApiError } from '../auth.js';
import type {
  SubscriptionPaymentContext,
  ProductPaymentQuery,
} from '../billing/payment-attribution.js';
import {
  BILLING_HISTORY_PAGE_SIZE,
  type BillingHistoryPage,
} from '../billing/model.js';
import type {
  BillingOrder,
  Currency,
  BillingProvider,
  PaymentSnapshot,
  SubscriptionSnapshot,
  VerifiedBillingEvent,
} from '../billing/model.js';

const customerSchema = z.object({ customer_id: z.string().min(1) });
const metadataSchema = z.record(z.string(), z.string());
const subscriptionSchema = z.object({
  subscription_id: z.string(),
  metadata: metadataSchema,
  customer: customerSchema,
  product_id: z.string(),
  quantity: z.number().int(),
  status: z.string(),
  next_billing_date: z.iso.datetime({ offset: true }),
  cancel_at_next_billing_date: z.boolean(),
});
const paymentSchema = z.object({
  payment_id: z.string(),
  metadata: metadataSchema,
  customer: customerSchema,
  currency: z.string(),
  status: z.string().nullable(),
  total_amount: z.number().int().nonnegative(),
  created_at: z.iso.datetime({ offset: true }),
  subscription_id: z.string().nullish(),
  checkout_session_id: z.string().nullish(),
  is_update_payment_method: z.boolean().optional().default(false),
  product_cart: z
    .array(z.object({ product_id: z.string(), quantity: z.number().int() }))
    .nullish(),
  refunds: z.array(
    z.object({
      status: z.string(),
      amount: z.number().nonnegative().nullish(),
    }),
  ),
  disputes: z.array(z.object({ dispute_status: z.string() })),
});
function safeUrl(value: string | null | undefined) {
  if (!value) throw new Error('Missing hosted URL.');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.dodopayments.com') ||
    url.username ||
    url.password
  )
    throw new Error('Invalid hosted URL.');
  return url.href;
}
export class DodoBillingProvider implements BillingProvider {
  private readonly client: DodoPayments;
  constructor(
    private readonly config: {
      apiKey: string;
      webhookSecret: string;
      environment: 'test_mode' | 'live_mode';
      webOrigin: string;
      planChangesEnabled?: boolean;
      resolveSubscriptionProduct?: (
        context: SubscriptionPaymentContext,
        lookup: (query: ProductPaymentQuery) => Promise<unknown>,
      ) => Promise<string>;
    },
  ) {
    this.client = new DodoPayments({
      bearerToken: config.apiKey,
      environment: config.environment,
      timeout: 20000,
      maxRetries: 1,
    });
  }
  async checkout(
    order: BillingOrder,
    customer: { email: string; name: string },
  ) {
    try {
      const result = await this.client.checkoutSessions.create(
        {
          product_cart: [{ product_id: order.productId, quantity: 1 }],
          customer: order.customerId
            ? { customer_id: order.customerId }
            : { email: customer.email, name: customer.name },
          billing_currency: order.currency,
          metadata: {
            picfind_order: order.id,
            picfind_environment: this.config.environment,
          },
          feature_flags: {
            allow_currency_selection: false,
            allow_customer_editing_email: false,
            allow_discount_code: false,
            allow_editing_addons: false,
          },
          ...(isSubscriptionPlan(order.plan)
            ? { subscription_data: { trial_period_days: 0 } }
            : {}),
          return_url: `${this.config.webOrigin}/app/billing?checkout=returned`,
        },
        { headers: { 'Idempotency-Key': `picfind-${order.id}` } },
      );
      return {
        sessionId: result.session_id,
        url: safeUrl(result.checkout_url),
      };
    } catch {
      throw new ApiError(
        503,
        'CHECKOUT_UNAVAILABLE',
        'The payment provider could not start checkout. Retry this purchase; no credits have been granted.',
      );
    }
  }
  async portal(customerId: string) {
    try {
      const result = await this.client.customers.customerPortal.create(
        customerId,
        {
          return_url: `${this.config.webOrigin}/app/billing`,
          send_email: false,
        },
      );
      return safeUrl(result.link);
    } catch {
      throw new ApiError(
        503,
        'PORTAL_UNAVAILABLE',
        'The billing portal is temporarily unavailable. Please retry.',
      );
    }
  }

  async inspectCheckout(
    order: BillingOrder,
  ): Promise<VerifiedBillingEvent | null> {
    if (!order.sessionId) return null;
    try {
      const session = await this.client.checkoutSessions.retrieve(
        order.sessionId,
      );
      if (session.id !== order.sessionId)
        throw new Error('Checkout session mismatch.');
      if (!session.payment_id) return null;
      const payment = await this.payment(
        session.payment_id,
        new Date().toISOString(),
      );
      if (payment.orderId !== order.id || payment.sessionId !== order.sessionId)
        throw new Error('Checkout payment mismatch.');
      return { id: randomUUID(), type: 'payment.reconciled', payment };
    } catch {
      throw new ApiError(
        503,
        'BILLING_RECONCILIATION_PENDING',
        'Payment status could not be verified. Your saved checkout is unchanged; retry later.',
      );
    }
  }
  async listPayments(
    customerId: string,
    page: number,
    through: string,
  ): Promise<BillingHistoryPage> {
    try {
      if (
        !customerId ||
        !Number.isSafeInteger(page) ||
        page < 0 ||
        page >= 1000 ||
        !Number.isFinite(Date.parse(through))
      )
        throw new Error('Invalid history boundary.');
      const result = await this.client.payments.list({
        customer_id: customerId,
        page_number: page,
        page_size: BILLING_HISTORY_PAGE_SIZE,
        created_at_lte: through,
      });
      const rows = z
        .array(
          z.object({
            payment_id: z.string().min(1).max(200),
            customer: customerSchema,
            created_at: z.iso.datetime({ offset: true }),
            metadata: z.record(z.string(), z.unknown()).default({}),
            subscription_id: z.string().min(1).max(200).nullish(),
          }),
        )
        .max(BILLING_HISTORY_PAGE_SIZE)
        .parse(result.items);
      const items = rows.map((row) => {
        if (
          row.customer.customer_id !== customerId ||
          Date.parse(row.created_at) > Date.parse(through)
        )
          throw new Error('Payment history scope mismatch.');
        const orderId = row.metadata.picfind_order;
        const environment = row.metadata.picfind_environment;
        return {
          id: row.payment_id,
          ...(typeof orderId === 'string' && orderId ? { orderId } : {}),
          ...(typeof environment === 'string' && environment
            ? { environment }
            : {}),
          ...(row.subscription_id
            ? { subscriptionId: row.subscription_id }
            : {}),
        };
      });
      return { items, hasMore: items.length === BILLING_HISTORY_PAGE_SIZE };
    } catch {
      throw new ApiError(
        503,
        'BILLING_RECONCILIATION_PENDING',
        'Payment history could not be read safely. Your saved progress is unchanged; retry later.',
      );
    }
  }
  async readPayment(id: string) {
    try {
      return await this.payment(id, new Date().toISOString());
    } catch {
      throw new ApiError(
        503,
        'BILLING_RECONCILIATION_PENDING',
        'A historical payment could not be verified. Continue checking history later; no unverified credits were granted.',
      );
    }
  }
  async readSubscription(id: string) {
    try {
      return this.subscription(
        await this.client.subscriptions.retrieve(id),
        new Date().toISOString(),
      );
    } catch {
      throw new ApiError(
        503,
        'BILLING_RECONCILIATION_PENDING',
        'Subscription status could not be verified. Retry later.',
      );
    }
  }
  async schedulePlanChange(
    input: import('./dodo-plan-scheduling.js').ApprovedPlanChangeRequest,
  ) {
    if (!this.config.planChangesEnabled)
      throw new ApiError(
        503,
        'PLAN_CHANGE_UNAVAILABLE',
        'Plan changes are not enabled. Your subscription is unchanged.',
      );
    const { scheduleDodoPlanChange } =
      await import('./dodo-plan-scheduling.js');
    return scheduleDodoPlanChange(
      this.client.subscriptions,
      this.config.environment,
      input,
      () =>
        this.previewPlanChange(
          input.subscription,
          input.productId,
          input.currency,
          input.interval,
        ),
    );
  }
  async inspectPlanChange(
    input: import('../billing/model.js').ApprovedPlanChangeRequest,
  ) {
    const { inspectDodoPlanChange } = await import('./dodo-plan-scheduling.js');
    return inspectDodoPlanChange(
      this.client.subscriptions,
      this.config.environment,
      input,
    );
  }
  async cancelScheduledPlanChange(
    input: import('../billing/model.js').PlanCancellationRequest,
  ) {
    const { cancelDodoPlanChange } =
      await import('./dodo-plan-cancellation.js');
    return cancelDodoPlanChange(
      this.client.subscriptions,
      this.config.environment,
      input,
      true,
    );
  }
  async inspectScheduledPlanCancellation(
    input: import('../billing/model.js').PlanCancellationRequest,
  ) {
    const { inspectDodoPlanCancellation } =
      await import('./dodo-plan-cancellation.js');
    return inspectDodoPlanCancellation(
      this.client.subscriptions,
      this.config.environment,
      input,
    );
  }
  async cancelSubscription(id: string, immediately: boolean) {
    try {
      const result = await this.client.subscriptions.update(
        id,
        immediately
          ? { status: 'cancelled', cancel_at_next_billing_date: false }
          : { cancel_at_next_billing_date: true },
      );
      return this.subscription(result, new Date().toISOString());
    } catch {
      throw new ApiError(
        503,
        'CANCELLATION_UNAVAILABLE',
        'Cancellation could not be confirmed. Check billing status or the provider portal before retrying.',
      );
    }
  }
  async previewPlanChange(
    expected: SubscriptionSnapshot,
    productId: string,
    currency: Currency,
    interval: 'Month' | 'Year' = 'Month',
  ) {
    try {
      const value = await this.client.subscriptions.previewChangePlan(
        expected.id,
        {
          product_id: productId,
          quantity: 1,
          effective_at: 'next_billing_date',
          proration_billing_mode: 'full_immediately',
          on_payment_failure: 'prevent_change',
        },
      );
      const parsed = z
        .object({
          immediate_charge: z.object({
            summary: z.object({
              currency: z.enum(['INR', 'USD']),
              total_amount: z.literal(0),
            }),
          }),
          new_plan: subscriptionSchema.extend({
            currency: z.enum(['INR', 'USD']),
            recurring_pre_tax_amount: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER),
            payment_frequency_count: z.literal(1),
            payment_frequency_interval: z.literal(interval),
            on_demand: z.literal(false),
            addons: z.array(z.unknown()).max(0),
          }),
        })
        .parse(value);
      const plan = parsed.new_plan;
      if (
        plan.subscription_id !== expected.id ||
        plan.customer.customer_id !== expected.customerId ||
        plan.metadata.picfind_order !== expected.orderId ||
        plan.metadata.picfind_environment !== this.config.environment ||
        plan.product_id !== productId ||
        plan.quantity !== 1 ||
        plan.currency !== currency ||
        parsed.immediate_charge.summary.currency !== currency ||
        plan.cancel_at_next_billing_date ||
        Date.parse(plan.next_billing_date) !==
          Date.parse(expected.nextBillingAt)
      )
        throw new Error('Preview binding mismatch.');
      return {
        currency,
        chargeNow: 0,
        recurringBeforeTax: plan.recurring_pre_tax_amount,
        effectiveAt: expected.nextBillingAt,
      };
    } catch {
      throw new ApiError(
        503,
        'PLAN_PREVIEW_UNAVAILABLE',
        'A renewal price preview could not be verified. Your subscription has not changed.',
      );
    }
  }
  private subscription(
    value: unknown,
    observedAt: string,
  ): SubscriptionSnapshot {
    const sub = subscriptionSchema.parse(value);
    if (sub.metadata.picfind_environment !== this.config.environment)
      throw new Error('Billing environment mismatch.');
    return {
      id: sub.subscription_id,
      orderId: sub.metadata.picfind_order ?? '',
      customerId: sub.customer.customer_id,
      productId: sub.product_id,
      status: sub.status,
      nextBillingAt: sub.next_billing_date,
      cancelAtPeriodEnd: sub.cancel_at_next_billing_date,
      observedAt,
    };
  }
  private async payment(
    id: string,
    observedAt: string,
  ): Promise<PaymentSnapshot> {
    const pay = paymentSchema.parse(await this.client.payments.retrieve(id));
    if (pay.payment_id !== id) throw new Error('Payment ID mismatch.');
    const rawSub = pay.subscription_id
      ? await this.client.subscriptions.retrieve(pay.subscription_id)
      : undefined;
    const subscription = rawSub
      ? this.subscription(rawSub, observedAt)
      : undefined;
    if (
      subscription &&
      (subscription.id !== pay.subscription_id ||
        subscription.customerId !== pay.customer.customer_id)
    )
      throw new Error('Payment subscription mismatch.');
    if (
      pay.metadata.picfind_environment &&
      pay.metadata.picfind_environment !== this.config.environment
    )
      throw new Error('Billing environment mismatch.');
    if (
      pay.metadata.picfind_order &&
      subscription?.orderId &&
      pay.metadata.picfind_order !== subscription.orderId
    )
      throw new Error('Order metadata mismatch.');
    const cart = pay.product_cart ?? [];
    if (cart.length > 1 || (!subscription && cart.length !== 1))
      throw new Error('Unexpected cart.');
    // A payment cart is historical evidence. Never rewrite it from today's subscription.
    const quantity =
      cart[0]?.quantity ?? subscriptionSchema.parse(rawSub).quantity;
    const orderId = pay.metadata.picfind_order ?? subscription?.orderId ?? '';
    let productId = cart[0]?.product_id;
    if (!productId) {
      if (
        !subscription ||
        quantity !== 1 ||
        !this.config.resolveSubscriptionProduct
      )
        throw new Error('Missing historical subscription attribution.');
      productId = await this.config.resolveSubscriptionProduct(
        {
          paymentId: pay.payment_id,
          orderId,
          customerId: pay.customer.customer_id,
          subscriptionId: subscription.id,
          currency: pay.currency,
          createdAt: pay.created_at,
          total: pay.total_amount,
          status: pay.status ?? 'pending',
        },
        async (query) => {
          const result = await this.client.payments.list({
            product_id: query.productId,
            customer_id: query.customerId,
            subscription_id: query.subscriptionId,
            currency: query.currency,
            created_at_gte: query.from,
            created_at_lte: query.through,
            page_number: query.page,
            page_size: query.pageSize,
          });
          return { items: result.items };
        },
      );
    }
    return {
      id: pay.payment_id,
      orderId,
      customerId: pay.customer.customer_id,
      productId,
      quantity,
      currency: pay.currency,
      status: pay.status ?? 'pending',
      total: pay.total_amount,
      refunded: pay.refunds
        .filter((r) => r.status === 'succeeded')
        .reduce((sum, r) => sum + (r.amount ?? 0), 0),
      held: pay.disputes.some(
        (d) => !['dispute_won', 'dispute_cancelled'].includes(d.dispute_status),
      ),
      createdAt: pay.created_at,
      observedAt,
      setupOnly: pay.is_update_payment_method,
      ...(pay.checkout_session_id
        ? { sessionId: pay.checkout_session_id }
        : {}),
      ...(subscription ? { subscription } : {}),
    };
  }
  async verify(
    raw: string,
    headers: Record<string, string>,
  ): Promise<VerifiedBillingEvent> {
    let event: {
      type: string;
      timestamp: string;
      data: Record<string, unknown>;
    };
    try {
      if (!headers['webhook-id'] || headers['webhook-id'].length > 200)
        throw new Error('Missing webhook ID.');
      const verified = this.client.webhooks.unwrap(raw, {
        headers,
        key: this.config.webhookSecret,
      });
      event = z
        .object({
          type: z.string(),
          timestamp: z.iso.datetime({ offset: true }),
          data: z.record(z.string(), z.unknown()),
        })
        .parse(verified);
    } catch {
      throw new ApiError(
        400,
        'INVALID_WEBHOOK',
        'The webhook signature or payload is invalid.',
      );
    }
    const result: VerifiedBillingEvent = {
      id: headers['webhook-id']!,
      type: event.type,
    };
    const id = (key: string) =>
      z.string().min(1).max(200).parse(event.data[key]);
    try {
      if (event.type.startsWith('payment.'))
        result.payment = await this.payment(id('payment_id'), event.timestamp);
      else if (event.type.startsWith('refund.')) {
        const refund = await this.client.refunds.retrieve(id('refund_id'));
        result.payment = await this.payment(refund.payment_id, event.timestamp);
      } else if (event.type.startsWith('dispute.')) {
        const dispute = await this.client.disputes.retrieve(id('dispute_id'));
        result.payment = await this.payment(
          dispute.payment_id,
          event.timestamp,
        );
      } else if (event.type.startsWith('subscription.'))
        result.subscription = this.subscription(
          await this.client.subscriptions.retrieve(id('subscription_id')),
          event.timestamp,
        );
      return result;
    } catch {
      throw new ApiError(
        503,
        'BILLING_RECONCILIATION_PENDING',
        'The billing event could not be reconciled. The provider should retry.',
      );
    }
  }
}
import { isSubscriptionPlan } from '../billing/model.js';
