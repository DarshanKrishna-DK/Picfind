import { randomUUID } from 'node:crypto';
import { BillingService } from '../../apps/api/src/billing/service.js';
import {
  addMonths,
  planById,
  type BillingOrder,
  type BillingProvider,
  type PaymentSnapshot,
  type PlanId,
} from '../../apps/api/src/billing/model.js';
import type { LibraryRecord } from '../../apps/api/src/library.js';
import { ImportTestBillingStore } from './cloud-import-billing-store.js';

/** Synthetic paid entitlement using the real fulfillment and event policy code.
 * No Dodo client or external requests. Shared records model the two Appwrite tables.
 */
export async function paidOrganizerBilling(
  records: Map<string, LibraryRecord>,
  owner: string,
  plan: Extract<PlanId, `organizer-${string}`> = 'organizer-starter-monthly',
  syncs?: Map<string, import('../../apps/api/src/folder-sync.js').FolderSync>,
) {
  const store = new ImportTestBillingStore();
  store.events = records;
  if (syncs) store.syncs = syncs;
  const provider: BillingProvider = {
    checkout: async (order) => ({
      sessionId: 'session_' + order.id,
      url: 'https://checkout.example.test/' + order.id,
    }),
    portal: async () => {
      throw new Error('Synthetic fixture has no portal');
    },
    verify: async () => {
      throw new Error('Synthetic fixture has no signature verifier');
    },
  };
  const billing = new BillingService(
    store,
    provider,
    { [plan + ':INR']: 'pdt_synthetic_organizer' },
    'test_mode',
    true,
    true,
  );
  const requestId = randomUUID();
  await billing.checkout(
    {
      id: owner,
      name: 'Synthetic organizer',
      email: 'organizer@example.test',
      emailVerified: true,
    },
    requestId,
    plan,
    'INR',
  );
  const order = (await store.transaction((tx) =>
    tx.get<BillingOrder>(billing.key('order', owner + ':' + requestId)),
  ))!;
  const now = new Date().toISOString();
  const payment: PaymentSnapshot = {
    id: 'pay_' + randomUUID(),
    orderId: order.id,
    customerId: 'customer_synthetic',
    productId: order.productId,
    quantity: 1,
    currency: 'INR',
    status: 'succeeded',
    total: planById(plan).inr * 100,
    refunded: 0,
    held: false,
    createdAt: now,
    observedAt: now,
    setupOnly: false,
    sessionId: order.sessionId!,
    subscription: {
      id: 'sub_' + randomUUID(),
      orderId: order.id,
      customerId: 'customer_synthetic',
      productId: order.productId,
      status: 'active',
      nextBillingAt: addMonths(now, plan.endsWith('yearly') ? 12 : 1),
      cancelAtPeriodEnd: false,
      observedAt: now,
    },
  };
  await billing.apply({ id: randomUUID(), type: 'payment.succeeded', payment });
  return billing;
}
