import Dodo from 'dodopayments';
import { loadEnvFile } from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  PERSONAL_PLANS,
  ORGANIZER_PLANS,
} from '../packages/shared/src/plans.ts';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
loadEnvFile(envPath);
if (!process.env.DODO_PAYMENTS_API_KEY)
  throw new Error('A server-only Dodo API key is required.');
// Deliberately hard-coded: this script cannot create live products or charge anyone.
const client = new Dodo({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  environment: 'test_mode',
  timeout: 20000,
  maxRetries: 1,
});
const plans = [...PERSONAL_PLANS, ...ORGANIZER_PLANS];
const existing = [];
for await (const product of client.products.list({ page_size: 100 }))
  existing.push(product);
const products = {};
for (const plan of plans)
  for (const currency of ['INR', 'USD']) {
    const amount = Math.round((currency === 'INR' ? plan.inr : plan.usd) * 100);
    const recurring = plan.cadence !== 'once';
    const interval = plan.cadence === 'year' ? 'Year' : 'Month';
    const matches = existing.filter(
      (p) =>
        p.metadata?.picfind_plan === plan.id &&
        p.metadata?.picfind_currency === currency,
    );
    if (matches.length > 1)
      throw new Error(
        `Duplicate test products for ${plan.id}/${currency}; reconcile the catalog before continuing.`,
      );
    let product = matches[0];
    if (!product)
      product = await client.products.create(
        {
          name: `PicFind ${plan.name} ${plan.cadence} ${currency} - Test`,
          description: `Test only. ${plan.scope === 'organizer' ? 'Organizer plan: guest usage included, no per-guest fee. Monthly allowance:' : 'Personal one-time pack:'} ${plan.photos} photo processing attempts and ${plan.searches} selfie searches. ${plan.storageGb} GB storage; up to ${plan.retentionDays} days retention. No automatic overages. ${recurring ? `${interval === 'Year' ? 'Yearly' : 'Monthly'} renewal; cancel future renewal any time. Allowances refresh monthly, not all at once for yearly billing.` : 'No subscription. Personal credits cannot fund event hosting.'}`,
          tax_category: 'saas',
          // Dodo enforces a 20-year maximum term. Customers can cancel monthly renewal earlier.
          price: recurring
            ? {
                type: 'recurring_price',
                currency,
                price: amount,
                tax_inclusive: false,
                payment_frequency_count: 1,
                payment_frequency_interval: interval,
                subscription_period_count: 20,
                subscription_period_interval: 'Year',
                trial_period_days: 0,
              }
            : {
                type: 'one_time_price',
                currency,
                price: amount,
                tax_inclusive: false,
              },
          metadata: {
            picfind_plan: plan.id,
            picfind_currency: currency,
            picfind_environment: 'test_mode',
          },
        },
        {
          headers: {
            'Idempotency-Key': `picfind-test-v2-${plan.id}-${currency}`,
          },
        },
      );
    const detail = await client.products.retrieve(product.product_id);
    if (
      detail.price.currency !== currency ||
      detail.price.price !== amount ||
      detail.price.type !==
        (recurring ? 'recurring_price' : 'one_time_price') ||
      (recurring &&
        (detail.price.payment_frequency_count !== 1 ||
          detail.price.payment_frequency_interval !== interval))
    )
      throw new Error(
        `Test product price mismatch for ${plan.id}/${currency}.`,
      );
    products[
      `DODO_PRODUCT_${plan.id.replaceAll('-', '_').toUpperCase()}_${currency}`
    ] = product.product_id;
  }
const catalogPath = new URL(
  '../infra/dodo-test-products.json',
  import.meta.url,
);
let historical = {};
try {
  const previous = JSON.parse(await readFile(catalogPath, 'utf8'));
  if (previous.environment !== 'test_mode' || !previous.products)
    throw new Error('Existing product mapping is not a test-mode catalog.');
  historical = previous.products;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await writeFile(
  catalogPath,
  `${JSON.stringify({ environment: 'test_mode', products: { ...historical, ...products } }, null, 2)}\n`,
);
if (process.argv.includes('--write-env')) {
  let text = await readFile(envPath, 'utf8');
  for (const [key, value] of Object.entries(products)) {
    const line = new RegExp(`^${key}=.*$`, 'm');
    text = line.test(text)
      ? text.replace(line, `${key}=${value}`)
      : `${text.trimEnd()}\n${key}=${value}\n`;
  }
  await writeFile(envPath, text);
}
console.info(
  `${Object.keys(products).length} current-catalog Dodo test products are provisioned and price/cadence-checked. Legacy mappings are preserved. No customer charged. Checkout activation and webhook setup remain separate.`,
);
