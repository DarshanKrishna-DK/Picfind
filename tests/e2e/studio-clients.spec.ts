import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { SavedClient } from '../../packages/shared/src/studio-clients';

const firstId = 'ad851772-ef2a-46a2-8f66-066975c7b0aa';
function contact(changes: Partial<SavedClient> = {}): SavedClient {
  return {
    id: firstId,
    name: 'Asha Rao',
    email: 'asha@example.test',
    phone: '+91 555 0100',
    company: 'Wedding client',
    version: 1,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    ...changes,
  };
}
async function fixture(page: Page, initial: SavedClient[] = []) {
  const state = {
    clients: structuredClone(initial),
    actor: 'owner',
    conflict: false,
    lostReply: false,
    failRead: false,
    reads: 0,
    downloads: 0,
    writes: [] as string[],
    headers: [] as string[],
  };
  page.on('download', () => state.downloads++);
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'owner',
            name: 'Owner',
            email: 'owner@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: { photos: [], events: [], jobs: [], scans: [], photoLimit: 100 },
      });
    if (path === '/api/capabilities')
      return route.fulfill({
        json: {
          storage: true,
          faceMatching: false,
          drive: false,
          billing: false,
        },
      });
    if (path.startsWith('/api/studio/clients')) {
      const expected = req.headers()['x-picfind-studio-actor'] ?? '';
      state.headers.push(expected);
      if (expected !== state.actor)
        return route.fulfill({
          status: 403,
          json: {
            error: {
              code: 'ACCOUNT_CHANGED',
              message: 'Your signed-in account changed. Reload the studio.',
            },
          },
        });
      if (path === '/api/studio/clients' && req.method() === 'GET') {
        state.reads++;
        if (state.failRead)
          return route.fulfill({
            status: 503,
            json: { error: { message: 'Directory storage is unavailable.' } },
          });
        return route.fulfill({
          json: {
            accountId: state.actor,
            limit: 200,
            clients: state.clients.slice(0, 200),
            totalCount: state.clients.length,
          },
        });
      }
      const id = path.split('/').at(-1)!;
      const existing = state.clients.find((client) => client.id === id);
      const body = req.postDataJSON();
      if (state.conflict && existing) {
        existing.version++;
        existing.company = 'Changed in another tab';
        state.conflict = false;
      }
      if ((existing?.version ?? 0) !== body.version)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'CLIENT_CHANGED',
              message:
                'This client changed in another tab. Your draft is still here. Load the latest directory before saving again.',
            },
          },
        });
      if (req.method() === 'PUT') {
        if (
          body.email &&
          state.clients.some(
            (row) =>
              row.id !== id &&
              row.email.toLowerCase() === body.email.toLowerCase(),
          )
        )
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: 'CLIENT_EMAIL_EXISTS',
                message:
                  'A client with this email already exists in your directory.',
              },
            },
          });
        const saved = contact({ ...body, id, version: body.version + 1 });
        state.clients = [
          ...state.clients.filter((client) => client.id !== id),
          saved,
        ];
        state.writes.push('PUT');
        if (state.lostReply) {
          state.lostReply = false;
          return route.fulfill({
            status: 503,
            json: {
              error: {
                message:
                  'The save reply was interrupted. Reload the directory to confirm.',
              },
            },
          });
        }
        return route.fulfill({
          json: { accountId: state.actor, client: saved },
        });
      }
      if (req.method() === 'DELETE') {
        state.clients = state.clients.filter((client) => client.id !== id);
        state.writes.push('DELETE');
        return route.fulfill({ status: 204 });
      }
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Synthetic unavailable route.' } },
    });
  });
  await page.goto('/app/clients');
  await expect(
    page.getByRole('heading', { name: 'Client directory', exact: true }),
  ).toBeVisible();
  return state;
}
const savedList = (page: Page) =>
  page.getByRole('list', { name: 'Saved clients' });
test('recovers an overcapacity directory through bounded display and removal', async ({
  page,
}) => {
  const contacts = Array.from({ length: 201 }, (_, index) =>
    contact({
      id: randomUUID(),
      name: `Contact ${String(index).padStart(3, '0')}`,
      email: '',
    }),
  );
  const state = await fixture(page, contacts);
  await expect(
    page.getByText('Showing the first 200 of 201 contacts.', { exact: false }),
  ).toBeVisible();
  await expect(savedList(page).getByRole('button')).toHaveCount(200);
  await expect(
    page.getByRole('button', { name: 'New client', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Export private clients CSV' }),
  ).toBeDisabled();
  await savedList(page)
    .getByRole('button', { name: /Contact 000/ })
    .click();
  await page
    .getByRole('button', { name: 'Remove client', exact: true })
    .click();
  await page.getByRole('button', { name: 'Confirm remove client' }).click();
  await expect(
    savedList(page).getByRole('button', { name: /Contact 200/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Export private clients CSV' }),
  ).toBeEnabled();
  expect(state.clients).toHaveLength(200);
});
test('refuses to export a partial directory discovered by the fresh read', async ({
  page,
}) => {
  const state = await fixture(page, [contact()]);
  state.clients.push(
    ...Array.from({ length: 200 }, () =>
      contact({ id: randomUUID(), email: '' }),
    ),
  );
  await page
    .getByRole('button', { name: 'Export private clients CSV' })
    .click();
  await expect(
    page.getByText(
      'The directory exceeds its limit. Remove unused contacts and reload before exporting a complete CSV.',
    ),
  ).toBeVisible();
  expect(state.downloads).toBe(0);
});
test('creates, reloads, searches, edits and explicitly removes a private contact', async ({
  page,
}, testInfo) => {
  const state = await fixture(page);
  await page.getByLabel('Client name', { exact: true }).fill('Asha Rao');
  await page.getByLabel('Client email (optional)').fill('ASHA@EXAMPLE.TEST');
  await page.getByLabel('Client phone (optional)').fill('+91 555 0100');
  await page.getByLabel('Client company (optional)').fill('Wedding client');
  await page.getByRole('button', { name: 'Save private client' }).click();
  await expect(page.getByText('Private client saved.')).toBeVisible();
  expect(state.clients[0]?.email).toBe('asha@example.test');
  expect(state.writes).toEqual(['PUT']);
  await page.reload();
  await savedList(page)
    .getByRole('button', { name: /Asha Rao/ })
    .click();
  await expect(page.getByLabel('Client company (optional)')).toHaveValue(
    'Wedding client',
  );
  await page.getByLabel('Search clients').fill('unmatched');
  await expect(savedList(page).getByRole('button')).toHaveCount(0);
  await page.getByLabel('Search clients').fill('wedding');
  await expect(savedList(page).getByRole('button')).toHaveCount(1);
  await page.getByLabel('Client company (optional)').fill('Portrait client');
  await page.getByRole('button', { name: 'Save private client' }).click();
  await expect(page.getByText('Private client saved.')).toBeVisible();
  await page.getByLabel('Search clients').fill('');
  await page.screenshot({
    path: testInfo.outputPath('client-directory.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Remove client', exact: true })
    .click();
  await page.getByRole('button', { name: 'Keep client' }).click();
  expect(state.clients).toHaveLength(1);
  await page
    .getByRole('button', { name: 'Remove client', exact: true })
    .click();
  await page.getByRole('button', { name: 'Confirm remove client' }).click();
  await expect(savedList(page).getByRole('button')).toHaveCount(0);
  expect(state.clients).toHaveLength(0);
  expect(state.writes).toEqual(['PUT', 'PUT', 'DELETE']);
  expect(state.headers.every((value) => value === 'owner')).toBe(true);
});
test('preserves a conflicting draft until an explicit reload', async ({
  page,
}) => {
  const state = await fixture(page, [contact()]);
  await savedList(page).getByRole('button').click();
  await page
    .getByLabel('Client company (optional)')
    .fill('Unsaved local company');
  state.conflict = true;
  await page.getByRole('button', { name: 'Save private client' }).click();
  await expect(
    page.getByText('Your draft is preserved.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel('Client company (optional)')).toHaveValue(
    'Unsaved local company',
  );
  await expect(
    page.getByRole('button', { name: 'Save private client' }),
  ).toBeDisabled();
  expect(state.writes).toEqual([]);
  await page
    .getByRole('button', { name: 'Load latest directory and discard draft' })
    .click();
  await expect(page.getByText('Latest directory loaded.')).toBeVisible();
  await savedList(page).getByRole('button').click();
  await expect(page.getByLabel('Client company (optional)')).toHaveValue(
    'Changed in another tab',
  );
  await page.getByLabel('Client company (optional)').fill('Reconciled');
  await page.getByRole('button', { name: 'Save private client' }).click();
  await expect(page.getByText('Private client saved.')).toBeVisible();
  expect(state.clients[0]?.version).toBe(3);
});
test('allows correction after a duplicate email without losing the draft', async ({
  page,
}) => {
  const state = await fixture(page, [contact()]);
  await page
    .getByLabel('Client name', { exact: true })
    .fill('Different client');
  await page.getByLabel('Client email (optional)').fill('asha@example.test');
  await page.getByRole('button', { name: 'Save private client' }).click();
  await expect(
    page.getByText(
      'A client with this email already exists in your directory.',
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Client name', { exact: true })).toHaveValue(
    'Different client',
  );
  await page.getByLabel('Client email (optional)').fill('');
  await page.getByRole('button', { name: 'Save private client' }).click();
  await expect(page.getByText('Private client saved.')).toBeVisible();
  expect(state.clients).toHaveLength(2);
});
test('exports fresh contact details and blocks export after an account change', async ({
  page,
}) => {
  const state = await fixture(page, [contact()]);
  state.clients[0]!.name = '=1+1';
  state.clients[0]!.company = '写真, "Studio"';
  const readsBeforeExport = state.reads;
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export private clients CSV' })
    .click();
  const csv = await readFile((await (await download).path())!, 'utf8');
  expect(csv).toContain(`"'=1+1"`);
  expect(csv).toContain('"写真, ""Studio"""');
  expect(state.reads).toBe(readsBeforeExport + 1);
  expect(state.writes).toEqual([]);
  state.actor = 'other';
  await page
    .getByRole('button', { name: 'Export private clients CSV' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Client directory unavailable' }),
  ).toBeVisible();
  await expect(savedList(page)).toHaveCount(0);
  expect(state.downloads).toBe(1);
});
test('does not download a stale CSV on storage failure and can reload a committed interrupted save', async ({
  page,
}) => {
  const state = await fixture(page);
  state.failRead = true;
  await page
    .getByRole('button', { name: 'Export private clients CSV' })
    .click();
  await expect(
    page.getByText('Directory storage is unavailable.'),
  ).toBeVisible();
  expect(state.downloads).toBe(0);
  state.failRead = false;
  state.lostReply = true;
  await page
    .getByLabel('Client name', { exact: true })
    .fill('Committed client');
  await page.getByRole('button', { name: 'Save private client' }).click();
  await expect(
    page.getByText(
      'The save reply was interrupted. Reload the directory to confirm.',
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Client name', { exact: true })).toHaveValue(
    'Committed client',
  );
  await page
    .getByRole('button', { name: 'Load latest directory and discard draft' })
    .click();
  await expect(
    savedList(page).getByRole('button', { name: /Committed client/ }),
  ).toBeVisible();
  expect(state.clients).toHaveLength(1);
});
