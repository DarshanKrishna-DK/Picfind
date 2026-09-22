import { z } from 'zod';
import { AppwriteBillingStore } from '../adapters/appwrite-billing.js';
import { DodoBillingProvider } from '../adapters/dodo-billing.js';
import { BillingService } from './service.js';
import { SubscriptionPaymentAttribution } from './payment-attribution.js';
import { PAID_PLAN_IDS, type ProductMap } from './model.js';

export function billingFromEnvironment(
  env: NodeJS.ProcessEnv,
  webOrigin: string,
) {
  // Explicit opt-in avoids breaking a development project whose schema is not provisioned yet.
  if (env.BILLING_ENABLED !== 'true') return undefined;
  const schema = z.object({
    APPWRITE_ENDPOINT: z.url(),
    APPWRITE_PROJECT_ID: z.string().min(1),
    APPWRITE_API_KEY: z.string().min(1),
    DODO_PAYMENTS_ENVIRONMENT: z
      .enum(['test_mode', 'live_mode'])
      .default('test_mode'),
    DODO_PAYMENTS_API_KEY: z.string().min(1),
    DODO_WEBHOOK_SECRET: z.string().min(1),
    BILLING_ROLE_CATALOG_ENABLED: z.enum(['true', 'false']).default('false'),
    BILLING_PLAN_CHANGES_ENABLED: z.enum(['true', 'false']).default('false'),
    BILLING_PLAN_CHANGES_LIVE_APPROVED: z
      .enum(['true', 'false'])
      .default('false'),
    BILLING_ROLE_CATALOG_LIVE_APPROVED: z
      .enum(['true', 'false'])
      .default('false'),
  });
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      'Billing requires Appwrite, a Dodo API key, an explicit environment and a webhook signing secret.',
    );
  const config = result.data;
  const planChangesEnabled = config.BILLING_PLAN_CHANGES_ENABLED === 'true';
  if (planChangesEnabled && env.BILLING_RECONCILIATION_ENABLED !== 'true')
    throw new Error(
      'Plan changes require BILLING_RECONCILIATION_ENABLED=true.',
    );
  if (
    planChangesEnabled &&
    config.DODO_PAYMENTS_ENVIRONMENT === 'live_mode' &&
    config.BILLING_PLAN_CHANGES_LIVE_APPROVED !== 'true'
  )
    throw new Error(
      'Live plan changes require separate BILLING_PLAN_CHANGES_LIVE_APPROVED=true after provider lifecycle acceptance.',
    );
  const roleCatalogEnabled = config.BILLING_ROLE_CATALOG_ENABLED === 'true';
  if (
    roleCatalogEnabled &&
    config.DODO_PAYMENTS_ENVIRONMENT === 'live_mode' &&
    config.BILLING_ROLE_CATALOG_LIVE_APPROVED !== 'true'
  )
    throw new Error(
      'Live role billing requires explicit BILLING_ROLE_CATALOG_LIVE_APPROVED=true after role-catalog provider acceptance.',
    );
  if (
    config.DODO_PAYMENTS_ENVIRONMENT === 'live_mode' &&
    (env.BILLING_LIVE_APPROVED !== 'true' || !webOrigin.startsWith('https://'))
  )
    throw new Error(
      'Live billing requires HTTPS and explicit BILLING_LIVE_APPROVED=true after the launch checklist passes.',
    );
  const products: ProductMap = {};
  for (const plan of PAID_PLAN_IDS)
    for (const currency of ['INR', 'USD'] as const) {
      const value =
        env[
          `DODO_PRODUCT_${plan.replace(/-/g, '_').toUpperCase()}_${currency}`
        ];
      if (value) {
        if (!/^pdt_[A-Za-z0-9]+$/.test(value))
          throw new Error('A Dodo product ID is invalid.');
        products[`${plan}:${currency}`] = value;
      }
    }
  if (new Set(Object.values(products)).size !== Object.keys(products).length)
    throw new Error(
      'Each billing plan and currency must use its own product ID.',
    );
  const store = new AppwriteBillingStore({
    endpoint: config.APPWRITE_ENDPOINT,
    projectId: config.APPWRITE_PROJECT_ID,
    apiKey: config.APPWRITE_API_KEY,
  });
  const attribution = new SubscriptionPaymentAttribution(
    store,
    config.DODO_PAYMENTS_ENVIRONMENT,
    products,
  );
  return new BillingService(
    store,
    new DodoBillingProvider({
      apiKey: config.DODO_PAYMENTS_API_KEY,
      webhookSecret: config.DODO_WEBHOOK_SECRET,
      environment: config.DODO_PAYMENTS_ENVIRONMENT,
      webOrigin,
      planChangesEnabled,
      resolveSubscriptionProduct: (context, lookup) =>
        attribution.resolve(context, lookup),
    }),
    products,
    config.DODO_PAYMENTS_ENVIRONMENT,
    env.BILLING_CHECKOUT_ENABLED === 'true',
    roleCatalogEnabled,
    planChangesEnabled,
  );
}
