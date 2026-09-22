import { z } from 'zod';
import { ApiError } from '../auth.js';
import {
  billingId,
  type BillingAccount,
  type BillingOrder,
  type BillingStore,
  type BillingTransaction,
  type Currency,
  type ProductMap,
} from './model.js';

export interface SubscriptionPaymentContext {
  paymentId: string;
  orderId: string;
  customerId: string;
  subscriptionId: string;
  currency: string;
  createdAt: string;
  total: number;
  status: string;
}
export interface ProductPaymentQuery {
  productId: string;
  customerId: string;
  subscriptionId: string;
  currency: Currency;
  from: string;
  through: string;
  page: number;
  pageSize: number;
}
interface Receipt extends SubscriptionPaymentContext {
  version: 1;
  ownerId: string;
  productId: string;
  recordedAt: string;
  evidence: 'provider-product-filter';
}
type Lookup = (query: ProductPaymentQuery) => Promise<unknown>;
const contextSchema = z
  .object({
    paymentId: z.string().min(1).max(200),
    orderId: z.string().regex(/^[a-f0-9]{36}$/),
    customerId: z.string().min(1).max(200),
    subscriptionId: z.string().min(1).max(200),
    currency: z.enum(['INR', 'USD']),
    createdAt: z.iso.datetime({ offset: true }),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    status: z.string().min(1).max(80),
  })
  .strict();
const pageSchema = z.object({
  items: z
    .array(
      z.object({
        payment_id: z.string().min(1).max(200),
        customer: z.object({ customer_id: z.string() }),
        subscription_id: z.string(),
        currency: z.enum(['INR', 'USD']),
        created_at: z.iso.datetime({ offset: true }),
        total_amount: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER),
        metadata: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .max(25),
});
function unavailable(): never {
  throw new ApiError(
    503,
    'PAYMENT_ATTRIBUTION_PENDING',
    'The original subscription product could not be verified. No unverified allowance was granted; retry billing reconciliation later.',
  );
}
function samePayment(
  a: SubscriptionPaymentContext,
  b: SubscriptionPaymentContext,
) {
  return (
    a.paymentId === b.paymentId &&
    a.orderId === b.orderId &&
    a.customerId === b.customerId &&
    a.subscriptionId === b.subscriptionId &&
    a.currency === b.currency &&
    Date.parse(a.createdAt) === Date.parse(b.createdAt) &&
    a.total === b.total
  );
}

/** Persist product membership evidence; never infer an old plan from today's subscription. */
export class SubscriptionPaymentAttribution {
  constructor(
    private readonly store: BillingStore,
    private readonly namespace: 'test_mode' | 'live_mode',
    private readonly products: ProductMap,
  ) {}

  private async owned(
    tx: BillingTransaction,
    context: SubscriptionPaymentContext,
  ) {
    const candidate = await tx.get<BillingOrder>(context.orderId);
    if (!candidate?.ownerId) unavailable();
    const order = (
      await tx.list<BillingOrder>(
        `${this.namespace}:${candidate.ownerId}`,
        'order',
      )
    ).find(
      (value) =>
        value.id === context.orderId && value.ownerId === candidate.ownerId,
    );
    if (
      !order ||
      order.id !== context.orderId ||
      !order.ownerId ||
      !isSubscriptionPlan(order.plan) ||
      order.currency !== context.currency ||
      (order.customerId && order.customerId !== context.customerId)
    )
      unavailable();
    const accountKey = billingId(this.namespace, 'account', order.ownerId);
    const account = await tx.get<BillingAccount>(accountKey);
    if (
      !account ||
      account.ownerId !== order.ownerId ||
      (account.customerId && account.customerId !== context.customerId)
    )
      unavailable();
    // An initially unbound customer is checked again by normal fulfillment. This
    // receipt alone never binds a customer, changes a subscription or grants credits.
    return {
      order,
      account,
      accountKey,
      ownerKey: `${this.namespace}:${order.ownerId}`,
    };
  }
  private validateReceipt(
    receipt: Receipt,
    context: SubscriptionPaymentContext,
    owner: string,
  ) {
    if (
      receipt.version !== 1 ||
      receipt.status !== 'succeeded' ||
      receipt.ownerId !== owner ||
      receipt.evidence !== 'provider-product-filter' ||
      !/^pdt_[A-Za-z0-9]+$/.test(receipt.productId) ||
      !samePayment(receipt, context)
    )
      unavailable();
    return receipt.productId;
  }
  async resolve(
    input: SubscriptionPaymentContext,
    lookup: Lookup,
  ): Promise<string> {
    try {
      const context = contextSchema.parse(input);
      const key = billingId(
        this.namespace,
        'payment-attribution',
        context.paymentId,
      );
      const snapshot = await this.store.transaction(async (tx) => {
        const owned = await this.owned(tx, context);
        const receipt = await tx.get<Receipt>(key);
        return { ...owned, receipt };
      });
      if (snapshot.receipt)
        return this.validateReceipt(
          snapshot.receipt,
          context,
          snapshot.order.ownerId,
        );
      const candidates = [
        ...new Set(
          [
            snapshot.order.productId,
            isLegacyPlan(snapshot.order.plan)
              ? this.products[`creator:${context.currency}`]
              : undefined,
            isLegacyPlan(snapshot.order.plan)
              ? this.products[`studio:${context.currency}`]
              : undefined,
          ].filter((id): id is string => Boolean(id)),
        ),
      ];
      if (
        !candidates.length ||
        candidates.length > 3 ||
        candidates.some((id) => !/^pdt_[A-Za-z0-9]+$/.test(id))
      )
        unavailable();
      const created = Date.parse(context.createdAt);
      const from = new Date(created - 1000).toISOString();
      const through = new Date(created + 1000).toISOString();
      const matches: string[] = [];
      for (const productId of candidates) {
        const seen = new Set<string>();
        for (let page = 0; page < 2; page++) {
          const result = pageSchema.parse(
            await lookup({
              productId,
              customerId: context.customerId,
              subscriptionId: context.subscriptionId,
              currency: context.currency,
              from,
              through,
              page,
              pageSize: 25,
            }),
          );
          let found = false;
          for (const item of result.items) {
            if (
              seen.has(item.payment_id) ||
              item.customer.customer_id !== context.customerId ||
              item.subscription_id !== context.subscriptionId ||
              item.currency !== context.currency ||
              Date.parse(item.created_at) < created - 1000 ||
              Date.parse(item.created_at) > created + 1000
            )
              unavailable();
            seen.add(item.payment_id);
            if (item.payment_id !== context.paymentId) continue;
            if (
              Date.parse(item.created_at) !== created ||
              item.total_amount !== context.total ||
              (item.metadata.picfind_order !== undefined &&
                item.metadata.picfind_order !== context.orderId) ||
              (item.metadata.picfind_environment !== undefined &&
                item.metadata.picfind_environment !== this.namespace)
            )
              unavailable();
            found = true;
          }
          if (found) {
            matches.push(productId);
            break;
          }
          if (result.items.length < 25) break;
          if (page === 1) unavailable();
        }
      }
      if (matches.length !== 1) unavailable();
      const productId = matches[0]!;
      return await this.store.transaction(async (tx) => {
        const owned = await this.owned(tx, context);
        if (
          owned.order.ownerId !== snapshot.order.ownerId ||
          owned.order.productId !== snapshot.order.productId
        )
          unavailable();
        const existing = await tx.get<Receipt>(key);
        if (existing) {
          if (
            this.validateReceipt(existing, context, owned.order.ownerId) !==
            productId
          )
            unavailable();
          return productId;
        }
        // Unsettled payment details may still change. Persist only settled evidence.
        if (context.status !== 'succeeded') return productId;
        // Conflict with concurrent customer binding/account updates before commit.
        owned.account.revision += 1;
        await tx.put(
          owned.accountKey,
          owned.ownerKey,
          'account',
          owned.account,
        );
        await tx.put(key, owned.ownerKey, 'event', {
          ...context,
          version: 1,
          ownerId: owned.order.ownerId,
          productId,
          evidence: 'provider-product-filter',
          recordedAt: new Date().toISOString(),
        } satisfies Receipt);
        return productId;
      });
    } catch {
      unavailable();
    }
  }
}
import { isSubscriptionPlan, isLegacyPlan } from './model.js';
