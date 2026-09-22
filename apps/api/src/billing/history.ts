import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../auth.js';
import {
  BILLING_HISTORY_PAGE_SIZE,
  type BillingAccount,
  type BillingOrder,
  type BillingProvider,
  type BillingStore,
  type BillingTransaction,
  type PaymentHistoryCursor,
  type VerifiedBillingEvent,
} from './model.js';

interface Context {
  ownerId: string;
  ownerKey: string;
  accountKey: string;
  namespace: 'test_mode' | 'live_mode';
  store: BillingStore;
  provider: BillingProvider;
  account(tx: BillingTransaction): Promise<BillingAccount>;
  apply(event: VerifiedBillingEvent): Promise<void>;
}
function unavailable(message: string): never {
  throw new ApiError(503, 'BILLING_RECONCILIATION_PENDING', message);
}

// The caller holds the account lock. Provider reads stay outside transactions;
// checkpoints compare run/page so concurrent instances cannot skip a page.
export async function reconcilePaymentHistory(
  context: Context,
  resumeCompleted = false,
) {
  const { provider } = context;
  if (!provider.listPayments || !provider.readPayment) return;
  const snapshot = await context.store.transaction(async (tx) => {
    const account = await context.account(tx);
    if (!account.customerId) return null;
    let cursor = account.paymentHistory;
    if (
      resumeCompleted &&
      cursor?.status === 'complete' &&
      cursor.completedAt &&
      Date.now() - Date.parse(cursor.completedAt) < 5 * 60_000
    )
      return null;
    if (!cursor || cursor.status === 'complete') {
      const now = new Date().toISOString();
      cursor = {
        runId: randomUUID(),
        status: 'running',
        page: 0,
        checkedPayments: 0,
        startedAt: now,
        through: now,
        updatedAt: now,
      };
      account.paymentHistory = cursor;
      await tx.put(context.accountKey, context.ownerKey, 'account', account);
    }
    return {
      account,
      cursor,
      orders: await tx.list<BillingOrder>(context.ownerKey, 'order'),
    };
  });
  if (!snapshot) return;
  const customerId = snapshot.account.customerId!;
  const { cursor } = snapshot;
  const orders = new Map(
    snapshot.orders
      .filter((order) => order.ownerId === context.ownerId)
      .map((order) => [order.id, order]),
  );
  const page = await provider.listPayments(
    customerId,
    cursor.page,
    cursor.through,
  );
  if (
    page.items.length > BILLING_HISTORY_PAGE_SIZE ||
    (page.hasMore && !page.items.length)
  )
    unavailable(
      'The provider returned an inconsistent history page. Your progress was retained.',
    );
  const ids = page.items.map((item) => item.id);
  if (new Set(ids).size !== ids.length)
    unavailable(
      'The provider repeated a payment within this page. Retry history verification later.',
    );
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([...ids].sort()))
    .digest('hex');
  if (ids.length && fingerprint === cursor.lastFingerprint)
    unavailable(
      'Payment history did not advance. Your previous progress is safe; retry later.',
    );
  let checked = 0;
  for (const item of page.items) {
    if (item.environment && item.environment !== context.namespace) continue;
    const orderId =
      item.orderId ??
      (item.subscriptionId
        ? snapshot.account.subscriptions[item.subscriptionId]?.orderId
        : undefined);
    const order = orderId ? orders.get(orderId) : undefined;
    // Other products/accounts in this merchant customer must never grant here.
    if (!order) continue;
    const payment = await provider.readPayment(item.id);
    if (
      payment.id !== item.id ||
      payment.orderId !== order.id ||
      payment.customerId !== customerId ||
      (item.subscriptionId &&
        payment.subscription?.id !== item.subscriptionId) ||
      (payment.subscription &&
        (payment.subscription.orderId !== order.id ||
          payment.subscription.customerId !== customerId))
    )
      unavailable(
        'A historical payment did not match this account and order. No unverified allowance was accepted.',
      );
    // Fulfillment independently checks the historical payment product and the
    // current subscription against the private approval timeline.
    await context.apply({
      id: randomUUID(),
      type: 'payment.history-reconciled',
      payment,
    });
    checked++;
  }
  await context.store.transaction(async (tx) => {
    const account = await context.account(tx);
    const current = account.paymentHistory;
    if (
      account.customerId !== customerId ||
      current?.runId !== cursor.runId ||
      current.page !== cursor.page
    )
      throw new ApiError(
        409,
        'BILLING_HISTORY_CHANGED',
        'Another check advanced billing history. Refresh and continue from the saved progress.',
      );
    const now = new Date().toISOString();
    const next: PaymentHistoryCursor = {
      ...cursor,
      page: cursor.page + 1,
      checkedPayments: cursor.checkedPayments + checked,
      status: page.hasMore ? 'running' : 'complete',
      updatedAt: now,
      lastFingerprint: fingerprint,
      ...(!page.hasMore ? { completedAt: now } : {}),
    };
    account.paymentHistory = next;
    await tx.put(context.accountKey, context.ownerKey, 'account', account);
  });
}
