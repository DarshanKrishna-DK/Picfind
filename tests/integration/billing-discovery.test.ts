import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppwriteBillingStore } from '../../apps/api/src/adapters/appwrite-billing.js';
const sdk = vi.hoisted(() => ({ listRows: vi.fn() }));
vi.mock('node-appwrite', async (original) => ({
  ...(await original<typeof import('node-appwrite')>()),
  TablesDB: class {
    listRows = sdk.listRows;
  },
}));
const store = () =>
  new AppwriteBillingStore({
    endpoint: 'https://example.test/v1',
    projectId: 'synthetic',
    apiKey: 'secret',
  });
const row = (id = 'a'.repeat(36)) => ({
  $id: id,
  ownerId: 'test_mode:owner',
  kind: 'account',
  payload: 'never parsed or exposed',
});
beforeEach(() => vi.resetAllMocks());
describe('bounded private billing account discovery', () => {
  it('uses ordered keyset discovery without reading payment/customer payloads', async () => {
    sdk.listRows.mockResolvedValue({ rows: [row()] });
    expect(await store().accountPage('0'.repeat(36))).toEqual({
      items: [{ id: 'a'.repeat(36), ownerKey: 'test_mode:owner' }],
      end: true,
    });
    const queries = sdk.listRows.mock.calls[0]![0].queries.map(
      (value: string) => JSON.parse(value),
    );
    expect(queries).toContainEqual({
      method: 'equal',
      attribute: 'kind',
      values: ['account'],
    });
    expect(queries).toContainEqual({
      method: 'greaterThan',
      attribute: '$id',
      values: ['0'.repeat(36)],
    });
    expect(queries).toContainEqual({ method: 'limit', values: [25] });
  });
  it('marks a full page as needing another read', async () => {
    sdk.listRows.mockResolvedValue({
      rows: Array.from({ length: 25 }, (_, i) =>
        row(i.toString(16).padStart(36, '0')),
      ),
    });
    expect((await store().accountPage()).end).toBe(false);
  });
  it.each([
    [row('bad-id')],
    [row(), row()],
    [row('b'.repeat(36)), row()],
    [{ ...row(), kind: 'grant' }],
    [{ ...row(), ownerId: null }],
    Array.from({ length: 26 }, () => row()),
  ])(
    'rejects malformed, unordered or excessive row pages %#',
    async (...rows) => {
      sdk.listRows.mockResolvedValue({ rows });
      await expect(store().accountPage()).rejects.toMatchObject({
        code: 'BILLING_DISCOVERY_UNAVAILABLE',
      });
    },
  );
  it('rejects stale/backward results and invalid cursors', async () => {
    sdk.listRows.mockResolvedValue({ rows: [row()] });
    await expect(store().accountPage('b'.repeat(36))).rejects.toMatchObject({
      code: 'BILLING_DISCOVERY_UNAVAILABLE',
    });
    sdk.listRows.mockClear();
    await expect(store().accountPage('bad')).rejects.toMatchObject({
      code: 'BILLING_CURSOR_INVALID',
    });
    expect(sdk.listRows).not.toHaveBeenCalled();
  });
  it('sanitizes database exception bodies', async () => {
    sdk.listRows.mockRejectedValue(new Error('database secret'));
    await expect(store().accountPage()).rejects.toThrow(
      'Billing account discovery is unavailable.',
    );
  });
});
