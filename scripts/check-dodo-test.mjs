import Dodo from 'dodopayments';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

if (process.env.PICFIND_DODO_TEST !== '1')
  throw new Error(
    'Set PICFIND_DODO_TEST=1 to create one unpaid test checkout. This never submits a payment.',
  );
loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
const client = new Dodo({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  environment: 'test_mode',
  timeout: 20000,
  maxRetries: 0,
});
const productId = process.env.DODO_PRODUCT_PHOTO_PACK_INR;
if (!productId) throw new Error('Run the Dodo test catalog setup first.');
const product = await client.products.retrieve(productId);
if (
  product.price.type !== 'one_time_price' ||
  product.price.currency !== 'INR' ||
  product.price.price !== 29900
)
  throw new Error('Unexpected test product price.');
const result = await client.checkoutSessions.create({
  product_cart: [{ product_id: productId, quantity: 1 }],
  billing_currency: 'INR',
  metadata: { picfind_test: randomUUID() },
  return_url: 'http://127.0.0.1:5173/app/billing?checkout=returned',
  feature_flags: {
    allow_currency_selection: false,
    allow_discount_code: false,
  },
});
if (
  !result.checkout_url ||
  new URL(result.checkout_url).protocol !== 'https:' ||
  !new URL(result.checkout_url).hostname.endsWith('.dodopayments.com')
)
  throw new Error('Missing or invalid hosted checkout address.');
await client.checkoutSessions.retrieve(result.session_id);
console.info(
  'PASS: Dodo test product price, hosted checkout creation and session retrieval. No customer details submitted, no card entered, no payment made.',
);
