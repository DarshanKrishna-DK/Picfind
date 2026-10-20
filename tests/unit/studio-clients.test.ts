import { describe, expect, it } from 'vitest';
import {
  clientDirectoryCsv,
  clientDirectory,
  savedClient,
  type SavedClient,
} from '../../packages/shared/src/studio-clients';
const client: SavedClient = {
  id: 'ad851772-ef2a-46a2-8f66-066975c7b0aa',
  name: 'Asha',
  email: 'asha@example.test',
  phone: '',
  company: '',
  version: 1,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
};
describe('private contact CSV and response contracts', () => {
  it('quotes commas, quotes and Unicode while preserving stable IDs', () => {
    const csv = clientDirectoryCsv([
      { ...client, name: 'Asha, "写真"', company: 'Studio, Inc.' },
    ]);
    expect(csv).toContain('"Asha, ""写真"""');
    expect(csv).toContain('"Studio, Inc."');
    expect(csv).toContain(client.id);
    expect(csv).not.toContain('updatedAt');
    expect(csv).toMatch(/\r\n$/);
  });
  it.each(['=1+1', '+12345', '-2', '@SUM(A1)', '\u00a0=1'])(
    'neutralizes formula prefix %s',
    (value) => {
      expect(
        clientDirectoryCsv([
          { ...client, name: value, phone: value, company: value },
        ]),
      ).toContain(`"'${value.trim()}"`);
    },
  );
  it('exports an empty directory as a header-only CSV', () => {
    expect(clientDirectoryCsv([])).toBe(
      '"Client ID","Name","Email","Phone","Company"\r\n',
    );
  });
  it('rejects duplicate response IDs, unversioned rows and unknown contact fields', () => {
    expect(
      clientDirectory.safeParse({
        accountId: 'owner',
        limit: 200,
        clients: [client, client],
      }).success,
    ).toBe(false);
    expect(savedClient.safeParse({ ...client, version: 0 }).success).toBe(
      false,
    );
    expect(
      savedClient.safeParse({
        ...client,
        privateNote: 'not part of the contract',
      }).success,
    ).toBe(false);
  });
});
