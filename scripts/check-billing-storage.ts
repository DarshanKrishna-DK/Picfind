import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client, Query, TablesDB } from 'node-appwrite';
import { developmentStorageConfig } from './storage-test-config.js';
import { AppwriteBillingStore } from '../apps/api/src/adapters/appwrite-billing.js';
import { BillingService } from '../apps/api/src/billing/service.js';
import type {
  BillingProvider,
  SubscriptionSnapshot,
  VerifiedBillingEvent,
} from '../apps/api/src/billing/model.js';

if (process.env.PICFIND_BILLING_STORAGE_TEST !== '1')
  throw new Error(
    'Set PICFIND_BILLING_STORAGE_TEST=1 to explicitly test disposable Appwrite ledger rows. No AWS or payments are used.',
  );
loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
const config = developmentStorageConfig(process.env);
const db = new TablesDB(
  new Client()
    .setEndpoint(config.endpoint)
    .setProject(config.projectId)
    .setKey(config.apiKey),
);
const owner = randomUUID();
const service = new BillingService(
  new AppwriteBillingStore(config),
  undefined,
  {},
  'test_mode',
  false,
);
const params = { databaseId: 'picfind-library', tableId: 'billing' };
try {
  const initial = await service.summary(owner);
  if (initial.photosRemaining !== 20)
    throw new Error(
      `Preview grant was not committed: ${JSON.stringify(initial)}`,
    );
  await service.reserve(owner, 'index', 18);
  const photoId = randomUUID();
  await service.reserveStorage(owner, photoId, 1000, async () => 500);
  await service.reserveStorage(owner, photoId, 1000, async () => 500);
  if ((await service.summary(owner)).storageBytesUsed !== 1500)
    throw new Error('Storage reservation was duplicated or baseline was lost.');
  await service.releaseStorage(owner, photoId, 1000, async () => 500);
  await service.releaseStorage(owner, photoId, 1000, async () => 500);
  if ((await service.summary(owner)).storageBytesUsed !== 500)
    throw new Error('Storage release was not idempotent.');
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () => service.reserve(owner, 'index')),
  );
  const succeeded = results.filter(
    (item) => item.status === 'fulfilled',
  ).length;
  const final = await service.summary(owner);
  if (succeeded !== 2 || final.photosRemaining !== 0)
    throw new Error(
      `Concurrent reservation failed: successful=${succeeded}, remaining=${final.photosRemaining}.`,
    );
  let providerCreates = 0;
  let verified: VerifiedBillingEvent | null = null;
  let subscription: SubscriptionSnapshot | undefined;
  const synthetic: BillingProvider = {
    checkout: async (order) => {
      providerCreates++;
      return {
        sessionId: `cks_${order.id}`,
        url: `https://test.checkout.dodopayments.com/${order.id}`,
      };
    },
    portal: async () => 'https://test.customer.dodopayments.com/synthetic',
    verify: async () => {
      throw new Error('No real webhook in this diagnostic.');
    },
    inspectCheckout: async () => verified,
    readSubscription: async () => {
      if (!subscription) throw new Error('Missing synthetic subscription.');
      return subscription;
    },
    cancelSubscription: async (_id, immediately) => {
      if (!subscription) throw new Error('Missing synthetic subscription.');
      subscription = {
        ...subscription,
        status: immediately ? 'cancelled' : 'active',
        cancelAtPeriodEnd: !immediately,
        observedAt: new Date().toISOString(),
      };
      return subscription;
    },
  };
  const lifecycle = new BillingService(
    service.store,
    synthetic,
    { 'creator:INR': 'pdt_synthetic' },
    'test_mode',
    true,
  );
  const customer = {
    id: owner,
    name: 'Disposable ledger diagnostic',
    email: 'synthetic@example.test',
    emailVerified: true,
  };
  const requestId = randomUUID();
  const first = await lifecycle.checkout(customer, requestId, 'creator', 'INR');
  if (
    (await lifecycle.checkout(customer, randomUUID(), 'creator', 'INR')).url !==
      first.url ||
    providerCreates !== 1
  )
    throw new Error('Pending checkout was not reused.');
  const now = new Date().toISOString();
  const orderId = lifecycle.key('order', `${owner}:${requestId}`);
  subscription = {
    id: 'sub_synthetic',
    orderId,
    customerId: 'cus_synthetic',
    productId: 'pdt_synthetic',
    status: 'active',
    nextBillingAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    cancelAtPeriodEnd: false,
    observedAt: now,
  };
  verified = {
    id: randomUUID(),
    type: 'payment.synthetic',
    payment: {
      id: `pay_${randomUUID()}`,
      orderId,
      customerId: 'cus_synthetic',
      productId: 'pdt_synthetic',
      quantity: 1,
      currency: 'INR',
      status: 'succeeded',
      total: 69900,
      refunded: 0,
      held: false,
      createdAt: now,
      observedAt: now,
      setupOnly: false,
      sessionId: `cks_${orderId}`,
      subscription,
    },
  };
  await lifecycle.reconcile(owner);
  await lifecycle.reconcile(owner);
  if ((await lifecycle.summary(owner)).photosRemaining !== 2500)
    throw new Error('Reconciliation duplicated or missed a grant.');
  let blocked = false;
  try {
    await lifecycle.prepareDeletion(owner);
  } catch (error) {
    blocked = (error as { code?: string }).code === 'SUBSCRIPTION_ACTIVE';
  }
  if (!blocked)
    throw new Error('An active subscription did not block deletion.');
  await lifecycle.cancelSubscription(owner, 'sub_synthetic', true);
  await lifecycle.prepareDeletion(owner);
  const restarted = new BillingService(
    new AppwriteBillingStore(config),
    synthetic,
    { 'creator:INR': 'pdt_synthetic' },
    'test_mode',
    true,
  );
  blocked = false;
  try {
    await restarted.checkout(customer, randomUUID(), 'creator', 'INR');
  } catch (error) {
    blocked = (error as { code?: string }).code === 'ACCOUNT_DELETION_PENDING';
  }
  if (!blocked || providerCreates !== 1)
    throw new Error('Deletion fence did not survive a service restart.');
  console.info(
    'PASS: live Appwrite commit/conflict retry, exact credit exhaustion, idempotent storage, saved checkout reuse, reconciliation, cancellation and durable deletion fence. Synthetic billing provider only; no Dodo or AWS calls.',
  );
} finally {
  const rows = await db.listRows({
    ...params,
    queries: [Query.equal('ownerId', `test_mode:${owner}`), Query.limit(100)],
  });
  for (const row of rows.rows)
    await db.deleteRow({ ...params, rowId: row.$id });
  console.info(
    `Removed ${rows.rows.length} disposable billing rows for this test only.`,
  );
}
