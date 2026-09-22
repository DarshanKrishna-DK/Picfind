import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  PERSONAL_PLANS,
  ORGANIZER_PLANS,
} from '../../packages/shared/src/plans.js';

const source = readFileSync(
  new URL('../../scripts/setup-dodo-test.mjs', import.meta.url),
  'utf8',
)
  .replace(/^import[\s\S]*?;\r?\n/gm, '')
  .replace(/^loadEnvFile\(.*\);\r?\n/gm, '')
  .replaceAll(
    'import.meta.url',
    JSON.stringify(
      new URL('../../scripts/setup-dodo-test.mjs', import.meta.url).href,
    ),
  );

type Product = {
  product_id: string;
  metadata: Record<string, string>;
  price: Record<string, unknown>;
};
function fixture(wrongCadence = false) {
  const products: Product[] = [];
  const options: unknown[] = [];
  const writeFile = vi.fn(async () => {});
  const readFile = vi.fn(async (path: string | URL) =>
    String(path).endsWith('.env')
      ? 'EXISTING_SETTING=synthetic\n'
      : JSON.stringify({
          environment: 'test_mode',
          products: { DODO_PRODUCT_CREATOR_INR: 'legacy-id' },
        }),
  );
  class Dodo {
    constructor(config: unknown) {
      options.push(config);
    }
    products = {
      list: async function* () {
        /* Synthetic empty remote catalog. */
      },
      create: async (data: Omit<Product, 'product_id'>) => {
        const product = { ...data, product_id: `synthetic-${products.length}` };
        products.push(product);
        return product;
      },
      retrieve: async (id: string) => {
        const product = products.find((item) => item.product_id === id)!;
        return wrongCadence &&
          product.price.payment_frequency_interval === 'Year'
          ? {
              ...product,
              price: { ...product.price, payment_frequency_interval: 'Month' },
            }
          : product;
      },
    };
  }
  const execute = () =>
    runInNewContext(`(async () => {${source}\n})()`, {
      Dodo,
      PERSONAL_PLANS,
      ORGANIZER_PLANS,
      readFile,
      writeFile,
      fileURLToPath,
      URL,
      console: { info: vi.fn() },
      process: {
        env: { DODO_PAYMENTS_API_KEY: 'synthetic-not-a-secret' },
        argv: ['--write-env'],
      },
    }) as Promise<void>;
  return { execute, products, options, writeFile };
}

describe('current Dodo catalog provisioning with a synthetic SDK', () => {
  it('creates nine current plans in both currencies, with exact amounts and cadence', async () => {
    const f = fixture();
    await f.execute();
    expect(f.options).toEqual([
      expect.objectContaining({ environment: 'test_mode' }),
    ]);
    expect(f.products).toHaveLength(18);
    for (const plan of [...PERSONAL_PLANS, ...ORGANIZER_PLANS]) {
      for (const currency of ['INR', 'USD'] as const) {
        const product = f.products.find(
          (p) =>
            p.metadata.picfind_plan === plan.id &&
            p.metadata.picfind_currency === currency,
        )!;
        expect(product.price.price).toBe(
          Math.round((currency === 'INR' ? plan.inr : plan.usd) * 100),
        );
        expect(product.price.type).toBe(
          plan.cadence === 'once' ? 'one_time_price' : 'recurring_price',
        );
        if (plan.cadence !== 'once') {
          expect(product.price.payment_frequency_count).toBe(1);
          expect(product.price.payment_frequency_interval).toBe(
            plan.cadence === 'year' ? 'Year' : 'Month',
          );
        }
      }
    }
  });
  it('preserves legacy mappings and uses underscore-only environment keys for yearly plans', async () => {
    const f = fixture();
    await f.execute();
    const writes = f.writeFile.mock.calls as unknown as [
      URL | string,
      string,
    ][];
    const catalog = JSON.parse(
      writes.find(([path]) =>
        String(path).endsWith('dodo-test-products.json'),
      )![1],
    );
    expect(catalog.products.DODO_PRODUCT_CREATOR_INR).toBe('legacy-id');
    expect(catalog.products.DODO_PRODUCT_ORGANIZER_PRO_YEARLY_INR).toMatch(
      /^synthetic-/,
    );
    const env = writes.find(([path]) => String(path).endsWith('.env'))![1];
    expect(env).toContain('EXISTING_SETTING=synthetic');
    expect(env).toContain('DODO_PRODUCT_ORGANIZER_PRO_YEARLY_USD=');
    expect(env).not.toContain('PRO-YEARLY');
  });
  it('rejects a yearly product returned with monthly cadence before writing mappings', async () => {
    const f = fixture(true);
    await expect(f.execute()).rejects.toThrow('Test product price mismatch');
    expect(f.writeFile).not.toHaveBeenCalled();
  });
});
