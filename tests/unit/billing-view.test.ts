import { describe, expect, it } from 'vitest';
import {
  billingUsage,
  type BillingUsageSummary,
  type UsageGrant,
} from '../../packages/shared/src/billing-view.js';
const now = Date.parse('2026-09-21T00:00:00Z');
const grant = (patch: Partial<UsageGrant> = {}): UsageGrant => ({
  id: 'pack',
  plan: 'personal-1000',
  scope: 'personal',
  createdAt: '2026-09-01T00:00:00Z',
  expiresAt: '2027-09-01T00:00:00Z',
  held: false,
  refundFraction: 0,
  photosRemaining: 700,
  usedPhotos: 300,
  ...patch,
});
const summary = (): BillingUsageSummary => ({
  roleCatalogAvailable: true,
  photosRemaining: 9700,
  searchesRemaining: 1500,
  balances: {
    personal: { photosRemaining: 700, searchesRemaining: 400 },
    organizer: { photosRemaining: 9000, searchesRemaining: 1100 },
  },
  grants: [
    grant(),
    grant({
      id: 'root',
      plan: 'organizer-pro-yearly',
      scope: 'organizer',
      entitlementMonths: 12,
      usedPhotos: 40000,
      photosRemaining: 0,
    }),
    grant({
      id: 'window',
      plan: 'organizer-pro-yearly',
      scope: 'organizer',
      parentGrantId: 'root',
      usedPhotos: 1000,
      photosRemaining: 9000,
      expiresAt: '2026-10-01T00:00:00Z',
    }),
  ],
  storageBytesUsed: 4e9,
  storageBytesUsedByScope: { personal: 1e9, organizer: 3e9, legacy: 0 },
});
describe('role-aware allowance presentation', () => {
  it('uses server-scoped balances without adding personal and organizer credits', () => {
    const data = summary();
    expect(billingUsage(data, 'personal', now)).toMatchObject({
      photosRemaining: 700,
      processed: 300,
      searchesRemaining: 400,
      storageBytesUsed: 1e9,
    });
    expect(billingUsage(data, 'organizer', now)).toMatchObject({
      photosRemaining: 9000,
      processed: 1000,
      storageBytesUsed: 3e9,
    });
  });
  it('separates paid entitlement dates from current monthly window dates', () => {
    expect(billingUsage(summary(), 'organizer', now)).toMatchObject({
      paidThrough: '2027-09-01T00:00:00Z',
      windowEndsAt: '2026-10-01T00:00:00Z',
      processed: 1000,
    });
  });
  it('does not fall back to mixed totals when scoped balances are missing', () => {
    const data = summary();
    delete data.balances;
    expect(billingUsage(data, 'organizer', now)).toMatchObject({
      available: false,
      photosRemaining: 0,
    });
  });
  it('keeps older deployments explicitly in existing-account mode', () => {
    const data = summary();
    data.roleCatalogAvailable = false;
    expect(billingUsage(data, 'personal', now)).toMatchObject({
      available: true,
      scoped: false,
      photosRemaining: 9700,
      storageBytesUsed: 4e9,
    });
  });
  it('warns that legacy credits overlap, without summing balances', () => {
    const data = summary();
    data.grants!.push(
      grant({ id: 'legacy', plan: 'creator', scope: 'legacy', usedPhotos: 40 }),
    );
    expect(billingUsage(data, 'organizer', now)).toMatchObject({
      sharedLegacy: true,
      photosRemaining: 9000,
      processed: 1040,
    });
  });
  it('excludes held, fully refunded, expired and future usage', () => {
    const data = summary();
    data.grants!.push(
      ...[
        grant({ held: true }),
        grant({ refundFraction: 1 }),
        grant({ expiresAt: '2026-08-01T00:00:00Z' }),
        grant({ createdAt: '2027-01-01T00:00:00Z' }),
      ],
    );
    expect(billingUsage(data, 'personal', now).processed).toBe(300);
  });
  it('does not invent reconciled storage or credit values from malformed data', () => {
    expect(billingUsage({}, 'personal', now)).toMatchObject({
      available: false,
      storageBytesUsed: null,
    });
    const data = summary();
    data.balances!.personal!.photosRemaining = NaN;
    data.storageBytesUsedByScope = null;
    expect(billingUsage(data, 'personal', now)).toMatchObject({
      available: false,
      storageBytesUsed: null,
    });
  });
  it('does not describe a personal preview as a purchased organizer entitlement', () => {
    expect(
      billingUsage(
        { ...summary(), grants: [grant({ plan: 'preview' })] },
        'organizer',
        now,
      ).hasPlan,
    ).toBe(false);
  });
});
