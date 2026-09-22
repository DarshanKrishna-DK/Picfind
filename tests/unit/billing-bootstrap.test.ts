import { describe, expect, it, vi } from 'vitest';
import { billingFromEnvironment } from '../../apps/api/src/billing/bootstrap.js';

// Constructor isolation: no Appwrite connection, Dodo requests or payments.
vi.mock('../../apps/api/src/adapters/appwrite-billing.js', () => ({
  AppwriteBillingStore: class {},
}));
vi.mock('../../apps/api/src/adapters/dodo-billing.js', () => ({
  DodoBillingProvider: class {},
}));

const config = (): NodeJS.ProcessEnv => ({
  BILLING_ENABLED: 'true',
  APPWRITE_ENDPOINT: 'https://appwrite.example.test/v1',
  APPWRITE_PROJECT_ID: 'synthetic',
  APPWRITE_API_KEY: 'synthetic-not-a-key',
  DODO_PAYMENTS_API_KEY: 'synthetic-not-a-key',
  DODO_WEBHOOK_SECRET: 'synthetic-not-a-secret',
  DODO_PRODUCT_PERSONAL_250_INR: 'pdt_synthetic250',
});
const origin = 'https://picfind.example.test';

describe('environment role billing activation boundaries', () => {
  it('keeps plan changes off independently of checkout', () => {
    expect(
      billingFromEnvironment(
        { ...config(), BILLING_CHECKOUT_ENABLED: 'true' },
        origin,
      )!.planChangesEnabled,
    ).toBe(false);
  });
  it('requires reconciliation for explicitly enabled plan changes', () => {
    expect(() =>
      billingFromEnvironment(
        { ...config(), BILLING_PLAN_CHANGES_ENABLED: 'true' },
        origin,
      ),
    ).toThrow('BILLING_RECONCILIATION_ENABLED');
    expect(
      billingFromEnvironment(
        {
          ...config(),
          BILLING_PLAN_CHANGES_ENABLED: 'true',
          BILLING_RECONCILIATION_ENABLED: 'true',
        },
        origin,
      )!.planChangesEnabled,
    ).toBe(true);
  });
  it('requires separate live plan-change acceptance', () => {
    expect(() =>
      billingFromEnvironment(
        {
          ...config(),
          DODO_PAYMENTS_ENVIRONMENT: 'live_mode',
          BILLING_LIVE_APPROVED: 'true',
          BILLING_PLAN_CHANGES_ENABLED: 'true',
          BILLING_RECONCILIATION_ENABLED: 'true',
        },
        origin,
      ),
    ).toThrow('BILLING_PLAN_CHANGES_LIVE_APPROVED');
  });
  it('keeps billing disabled unless explicitly enabled', () => {
    expect(
      billingFromEnvironment({ BILLING_ROLE_CATALOG_ENABLED: 'true' }, origin),
    ).toBeUndefined();
  });
  it('does not activate the catalog or checkout from product IDs alone', () => {
    const billing = billingFromEnvironment(config(), origin)!;
    expect(billing.roleCatalogEnabled).toBe(false);
    expect(billing.checkoutEnabled).toBe(false);
    expect(billing.products['personal-250:INR']).toBe('pdt_synthetic250');
    expect(billing.products['personal-500:INR']).toBeUndefined();
  });
  it('allows test role accounting without enabling checkout', () => {
    const billing = billingFromEnvironment(
      { ...config(), BILLING_ROLE_CATALOG_ENABLED: 'true' },
      origin,
    )!;
    expect(billing.namespace).toBe('test_mode');
    expect(billing.roleCatalogEnabled).toBe(true);
    expect(billing.checkoutEnabled).toBe(false);
  });
  it('requires separate explicit checkout activation', () => {
    const billing = billingFromEnvironment(
      {
        ...config(),
        BILLING_ROLE_CATALOG_ENABLED: 'true',
        BILLING_CHECKOUT_ENABLED: 'true',
      },
      origin,
    )!;
    expect(billing.checkoutEnabled).toBe(true);
  });
  it.each(['yes', 'TRUE', '1'])(
    'rejects an ambiguous role flag %s',
    (value) => {
      expect(() =>
        billingFromEnvironment(
          { ...config(), BILLING_ROLE_CATALOG_ENABLED: value },
          origin,
        ),
      ).toThrow();
    },
  );
  it('requires a separate role approval even when legacy live billing is approved', () => {
    expect(() =>
      billingFromEnvironment(
        {
          ...config(),
          DODO_PAYMENTS_ENVIRONMENT: 'live_mode',
          BILLING_LIVE_APPROVED: 'true',
          BILLING_ROLE_CATALOG_ENABLED: 'true',
        },
        origin,
      ),
    ).toThrow('BILLING_ROLE_CATALOG_LIVE_APPROVED');
  });
  it.each([
    {},
    { BILLING_LIVE_APPROVED: 'true', webOrigin: 'http://localhost:5173' },
  ])(
    'cannot bypass general live approval or HTTPS with role approval',
    (options) => {
      const { webOrigin, ...flags } = options;
      expect(() =>
        billingFromEnvironment(
          {
            ...config(),
            DODO_PAYMENTS_ENVIRONMENT: 'live_mode',
            BILLING_ROLE_CATALOG_ENABLED: 'true',
            BILLING_ROLE_CATALOG_LIVE_APPROVED: 'true',
            ...flags,
          },
          webOrigin ?? origin,
        ),
      ).toThrow('Live billing requires HTTPS');
    },
  );
  it('allows explicitly approved live role accounting while checkout stays off', () => {
    const billing = billingFromEnvironment(
      {
        ...config(),
        DODO_PAYMENTS_ENVIRONMENT: 'live_mode',
        BILLING_LIVE_APPROVED: 'true',
        BILLING_ROLE_CATALOG_ENABLED: 'true',
        BILLING_ROLE_CATALOG_LIVE_APPROVED: 'true',
      },
      origin,
    )!;
    expect(billing.namespace).toBe('live_mode');
    expect(billing.roleCatalogEnabled).toBe(true);
    expect(billing.checkoutEnabled).toBe(false);
  });
  it('rejects product aliases across currencies or tiers', () => {
    expect(() =>
      billingFromEnvironment(
        { ...config(), DODO_PRODUCT_PERSONAL_250_USD: 'pdt_synthetic250' },
        origin,
      ),
    ).toThrow('own product ID');
  });
});
