import { afterEach, describe, expect, it, vi } from 'vitest';
import { reserveFaceUsage } from '../../apps/api/src/usage.js';
import type { BillingService } from '../../apps/api/src/billing/service.js';
import type { LibraryStore } from '../../apps/api/src/library.js';

afterEach(() => vi.unstubAllEnvs());
describe('production usage cannot bypass paid-cloud allowance enforcement', () => {
  it('fails closed without a ledger instead of falling back to unmetered production processing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(
      reserveFaceUsage(
        {} as LibraryStore,
        undefined,
        'owner',
        'index',
        'personal',
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: 'USAGE_ACCOUNTING_UNAVAILABLE',
    });
  });
  it('uses the real plan ledger rather than the twenty-photo development ceiling in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const billing = {
      reserve: vi.fn(async () => {}),
    } as unknown as BillingService;
    await reserveFaceUsage(
      {} as LibraryStore,
      billing,
      'owner',
      'index',
      'personal',
    );
    expect(billing.reserve).toHaveBeenCalledWith(
      'owner',
      'index',
      1,
      undefined,
      'legacy',
    );
  });
});
