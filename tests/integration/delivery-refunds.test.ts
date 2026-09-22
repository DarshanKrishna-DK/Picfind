import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BillingService } from '../../apps/api/src/billing/service.js';
import type { BillingStore } from '../../apps/api/src/billing/model.js';

function fixture() {
  const rows = new Map<
    string,
    { owner: string; kind: string; value: unknown }
  >();
  const store: BillingStore = {
    transaction: async (operation) =>
      operation({
        get: async <T>(id: string) => (rows.get(id)?.value ?? null) as T | null,
        list: async <T>(owner: string, kind: string) =>
          [...rows.values()]
            .filter((row) => row.owner === owner && row.kind === kind)
            .map((row) => row.value as T),
        put: async (id, owner, kind, value) => {
          rows.set(id, { owner, kind, value: structuredClone(value) });
        },
      }),
  };
  const service = new BillingService(store, undefined, {}, 'test_mode', false);
  const owner = randomUUID();
  const used = () =>
    [...rows.values()]
      .filter((row) => row.kind === 'grant')
      .reduce(
        (sum, row) =>
          sum + (row.value as { usedDeliveryBytes: number }).usedDeliveryBytes,
        0,
      );
  const stored = () =>
    (
      [...rows.values()].find((row) => row.kind === 'account')?.value as
        { storedBytes?: number } | undefined
    )?.storedBytes;
  return { service, owner, used, stored };
}
describe('delivery reservations refund only the original grant allocations', () => {
  it('debits one attempt once and refunds a failed upstream request once', async () => {
    const { service, owner, used } = fixture();
    const attempt = randomUUID();
    await service.reserveDelivery(owner, attempt, 1024);
    await service.reserveDelivery(owner, attempt, 1024);
    expect(used()).toBe(1024);
    await service.refundDelivery(owner, attempt, 'upstream-http-failure');
    await service.refundDelivery(owner, attempt, 'upstream-http-failure');
    expect(used()).toBe(0);
  });
  it('does not permit amount changes or another owner to refund a reservation', async () => {
    const { service, owner, used } = fixture();
    const attempt = randomUUID();
    await service.reserveDelivery(owner, attempt, 1024);
    await expect(
      service.reserveDelivery(owner, attempt, 2048),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.refundDelivery('other-owner', attempt, 'metadata-mismatch'),
    ).rejects.toMatchObject({ status: 404 });
    expect(used()).toBe(1024);
  });
  it('refunds only its own bytes when successful deliveries share the grant', async () => {
    const { service, owner, used } = fixture();
    const failed = randomUUID();
    await service.reserveDelivery(owner, randomUUID(), 4096);
    await service.reserveDelivery(owner, failed, 1024);
    await service.refundDelivery(owner, failed, 'metadata-mismatch');
    expect(used()).toBe(4096);
  });
});
describe('pending-upload storage compensation', () => {
  it('does not subtract another photo when an upload never acquired a reservation', async () => {
    const { service, owner, stored } = fixture();
    const photoId = randomUUID();
    await service.reserveStorage(owner, photoId, 100, async () => 0);
    expect(stored()).toBe(100);
    await service.releaseStorage(
      owner,
      randomUUID(),
      50,
      async () => 100,
      true,
    );
    expect(stored()).toBe(100);
    await service.releaseStorage(owner, photoId, 100, async () => 100, true);
    await service.releaseStorage(owner, photoId, 100, async () => 0, true);
    expect(stored()).toBe(0);
  });
});
