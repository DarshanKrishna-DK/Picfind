import { expect, test, type Page } from '@playwright/test';

const generation = '11111111-1111-4111-8111-111111111111';
async function fixture(
  page: Page,
  options: { connected?: boolean; expired?: boolean; emptyPage?: boolean } = {},
) {
  const requests: Record<string, unknown>[] = [];
  const folders: URL[] = [];
  let queued = false;
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'synthetic-owner',
            name: 'Test photographer',
            email: 'test@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/capabilities')
      return route.fulfill({
        json: {
          storage: true,
          cloudImports: true,
          eventIndexMax: 20,
          drive: true,
          driveOAuth: true,
          driveConnected: options.connected !== false,
          photoLimit: 20,
          faceMatching: false,
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: { events: [], photos: [], jobs: [], scans: [], photoLimit: 20 },
      });
    if (path === '/api/sources')
      return route.fulfill({ json: { sources: [] } });
    if (path === '/api/imports/queued/drive/items') {
      folders.push(url);
      if (options.expired && url.searchParams.has('cursor'))
        return route.fulfill({
          status: 400,
          json: {
            error: {
              code: 'DRIVE_CURSOR_INVALID',
              message:
                'This folder page expired or the connection changed. Browse the folder again.',
            },
          },
        });
      return route.fulfill({
        json: {
          generation,
          cursor: url.searchParams.has('cursor') ? null : 'opaque-page',
          items:
            options.emptyPage && !url.searchParams.has('cursor')
              ? []
              : [
                  {
                    id: url.searchParams.has('cursor') ? 'second' : 'first',
                    name: url.searchParams.has('cursor')
                      ? 'Second photo.jpg'
                      : 'First photo.jpg',
                    bytes: 1024,
                    folder: false,
                  },
                ],
        },
      });
    }
    if (path === '/api/imports/queued' && req.method() === 'POST') {
      expect(req.headers()['x-picfind-consent']).toBe('cloud-import-v1');
      requests.push(req.postDataJSON());
      queued = true;
      return route.fulfill({
        status: 202,
        json: { job: { id: 'saved-drive-import' } },
      });
    }
    if (path === '/api/imports/queued')
      return route.fulfill({
        json: {
          jobs: queued
            ? [
                {
                  id: 'saved-drive-import',
                  importId: 'root',
                  source: 'drive',
                  status: 'queued',
                  total: 2,
                  imported: 0,
                  processed: 0,
                  failed: 0,
                  cancelRequested: false,
                  errors: [],
                },
              ]
            : [],
        },
      });
    if (path === '/api/drive/connect') {
      requests.push(req.postDataJSON());
      return route.fulfill({
        json: { url: '/app/import?source=drive&drive=connected' },
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Unexpected synthetic request: ' + path } },
    });
  });
  await page.goto('/app/import?source=drive');
  return { requests, folders };
}
async function browse(page: Page) {
  await page
    .getByLabel('Google Drive folder link', { exact: true })
    .fill('https://drive.google.com/drive/folders/folder-1');
  await page
    .getByRole('button', { name: 'Open Drive folder', exact: true })
    .click();
}
test('Drive folder pages feed one consented saved import and survive navigation', async ({
  page,
}) => {
  const state = await fixture(page);
  await browse(page);
  await page.getByRole('checkbox', { name: /First photo/ }).check();
  await page.getByRole('button', { name: 'Load more files' }).click();
  await page.getByRole('checkbox', { name: /Second photo/ }).check();
  const start = page.getByRole('button', {
    name: 'Import 2 selected',
    exact: true,
  });
  await expect(start).toBeDisabled();
  await page
    .getByRole('checkbox', { name: /I have permission to copy/ })
    .check();
  await start.click();
  expect(state.requests[0]).toMatchObject({
    provider: 'drive',
    ids: ['first', 'second'],
    generation,
  });
  expect(state.folders[1]?.searchParams.get('cursor')).toBe('opaque-page');
  await page.reload();
  await expect(
    page.getByRole('article', { name: 'drive import' }),
  ).toBeVisible();
  await expect(page.getByText('Queued', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test('expired Drive page clears stale selection and explains recovery', async ({
  page,
}) => {
  const state = await fixture(page, { expired: true });
  await browse(page);
  await page.getByRole('checkbox', { name: /First photo/ }).check();
  await page.getByRole('button', { name: 'Load more files' }).click();
  await expect(
    page.getByText(
      'This folder page expired or the connection changed. Browse the folder again.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Import 0 selected', exact: true }),
  ).toBeDisabled();
  expect(state.requests).toHaveLength(0);
});
test('empty Drive pages can still load the next provider page', async ({
  page,
}) => {
  await fixture(page, { emptyPage: true });
  await browse(page);
  await page.getByRole('button', { name: 'Load more files' }).click();
  await expect(
    page.getByRole('checkbox', { name: /Second photo/ }),
  ).toBeVisible();
});
test('Drive connect requests return to imports rather than discarding the workflow', async ({
  page,
}) => {
  const state = await fixture(page, { connected: false });
  await page
    .getByRole('button', { name: 'Connect Google Drive', exact: true })
    .click();
  await expect(page).toHaveURL(/source=drive&drive=connected/);
  expect(state.requests[0]).toEqual({ returnTo: '/app/import' });
});
