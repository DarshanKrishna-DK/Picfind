import { expect, test, type Page } from '@playwright/test';

const generation = '11111111-1111-4111-8111-111111111111',
  nextGeneration = '22222222-2222-4222-8222-222222222222';
async function setup(
  page: Page,
  options: {
    paused?: boolean;
    reconnect?: boolean;
    failFirst?: boolean;
    changedPage?: boolean;
    emptyFolder?: boolean;
    photoLimit?: number;
    reconnectAgain?: boolean;
  } = {},
) {
  const base = {
    id: 'saved-job',
    importId: 'saved-import',
    source: 'dropbox',
    status: options.paused ? 'cancelled' : 'queued',
    total: 1,
    imported: 0,
    processed: 0,
    failed: 0,
    cancelRequested: false,
    errors: [] as string[],
  };
  let jobs = options.paused ? [{ ...base }] : [];
  const starts: Record<string, unknown>[] = [],
    resumes: Record<string, unknown>[] = [];
  let connectionReads = 0;
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'synthetic-owner',
            name: 'Synthetic owner',
            email: 'owner@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/capabilities')
      return route.fulfill({
        json: {
          cloudImports: true,
          eventIndexMax: 20,
          storage: true,
          faceMatching: false,
          billing: false,
          drive: false,
          driveOAuth: false,
          photoLimit: 20,
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: {
          events: [],
          photos: [],
          scans: [],
          jobs: [],
          photoLimit: options.photoLimit ?? 20,
        },
      });
    if (path === '/api/sources')
      return route.fulfill({
        json: {
          sources: [
            {
              id: 'dropbox',
              configured: true,
              connected: true,
              persistent: true,
            },
            {
              id: 'onedrive',
              configured: false,
              connected: false,
              persistent: true,
            },
            {
              id: 'box',
              configured: false,
              connected: false,
              persistent: true,
            },
          ],
        },
      });
    if (path === '/api/sources/dropbox/items')
      return route.fulfill({
        json: {
          items: options.emptyFolder
            ? url.searchParams.get('folder')
              ? []
              : [
                  {
                    id: 'id:empty',
                    name: 'Empty folder',
                    folder: true,
                    bytes: 0,
                  },
                ]
            : [
                {
                  id: url.searchParams.has('cursor') ? 'id:second' : 'id:first',
                  name: 'photo.jpg',
                  folder: false,
                  bytes: 100,
                },
              ],
          cursor:
            options.changedPage && !url.searchParams.has('cursor')
              ? 'next'
              : null,
          generation:
            options.changedPage && url.searchParams.has('cursor')
              ? nextGeneration
              : generation,
        },
      });
    if (path === '/api/imports/queued' && req.method() === 'GET')
      return route.fulfill({ json: { jobs } });
    if (path === '/api/imports/queued' && req.method() === 'POST') {
      expect(req.headers()['x-picfind-consent']).toBe('cloud-import-v1');
      starts.push(req.postDataJSON());
      if (options.failFirst && starts.length === 1)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              message: 'Synthetic lost response. Retry the same selection.',
            },
          },
        });
      jobs = [{ ...base }];
      return route.fulfill({ status: 202, json: { job: jobs[0] } });
    }
    if (path === '/api/imports/queued/connection/dropbox') {
      connectionReads++;
      return route.fulfill({
        json: {
          generation:
            options.reconnectAgain && connectionReads > 1
              ? '33333333-3333-4333-8333-333333333333'
              : options.reconnect
                ? nextGeneration
                : generation,
        },
      });
    }
    if (path.endsWith('/pause')) {
      jobs = [{ ...jobs[0]!, status: 'cancelled' }];
      return route.fulfill({ json: { job: jobs[0] } });
    }
    if (path.endsWith('/resume')) {
      const body = req.postDataJSON() as Record<string, unknown>;
      resumes.push(body);
      expect(req.headers()['x-picfind-consent']).toBe('cloud-import-v1');
      if (options.reconnect && !body.acceptConnectionChange)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'SOURCE_CONNECTION_CHANGED',
              message: 'Confirm the reconnected account before resuming.',
            },
          },
        });
      jobs = [{ ...base, id: 'resumed-job', status: 'queued' }];
      return route.fulfill({ status: 202, json: { job: jobs[0] } });
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Synthetic endpoint not found.' } },
    });
  });
  return { starts, resumes };
}
async function selectPhoto(page: Page) {
  await page
    .getByRole('button', { name: 'Browse photos', exact: true })
    .click();
  await page.getByRole('checkbox', { name: /photo\.jpg/ }).check();
}
test('saved import requires copy consent, survives reload, and supports pause/resume', async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto('/app/import');
  await selectPhoto(page);
  const start = page.getByRole('button', {
    name: 'Import 1 selected',
    exact: true,
  });
  await expect(start).toBeDisabled();
  await page
    .getByRole('checkbox', { name: /I have permission to copy/ })
    .check();
  await start.click();
  await expect(
    page.getByText('Import saved. You can leave this page;', { exact: false }),
  ).toBeVisible();
  expect(state.starts[0]?.generation).toBe(generation);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Saved cloud imports' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Pause import' }).click();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume missing photos' }).click();
  await expect(page.getByText('Queued', { exact: true })).toBeVisible();
  expect(state.resumes).toHaveLength(1);
  await expect(
    page.getByRole('progressbar', { name: 'Imported photos' }),
  ).toHaveAttribute('max', '1');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test('reconnected accounts require explicit confirmation and preserve the retry id', async ({
  page,
}) => {
  const state = await setup(page, { paused: true, reconnect: true });
  await page.goto('/app/import');
  const resume = page.getByRole('button', { name: 'Resume missing photos' });
  await resume.click();
  await expect(
    page.getByText('Confirm the reconnected account before resuming.'),
  ).toBeVisible();
  await expect(resume).toBeDisabled();
  await page
    .getByRole('checkbox', { name: /I confirm the reconnected source account/ })
    .check();
  await resume.click();
  await expect(page.getByText('Queued', { exact: true })).toBeVisible();
  expect(state.resumes).toHaveLength(2);
  expect(state.resumes[1]?.requestId).toBe(state.resumes[0]?.requestId);
  expect(state.resumes[1]?.acceptConnectionChange).toBe(true);
});
test('retrying a failed enqueue reuses the selected snapshot and request id', async ({
  page,
}) => {
  const state = await setup(page, { failFirst: true });
  await page.goto('/app/import');
  await selectPhoto(page);
  await page
    .getByRole('checkbox', { name: /I have permission to copy/ })
    .check();
  const start = page.getByRole('button', {
    name: 'Import 1 selected',
    exact: true,
  });
  await start.click();
  await expect(
    page.getByText('Synthetic lost response. Retry the same selection.'),
  ).toBeVisible();
  await start.click();
  await expect(
    page.getByText('Import saved. You can leave this page;', { exact: false }),
  ).toBeVisible();
  expect(state.starts).toHaveLength(2);
  expect(state.starts[1]).toEqual(state.starts[0]);
});
test('a changed connection during pagination discards the old selection', async ({
  page,
}) => {
  const state = await setup(page, { changedPage: true });
  await page.goto('/app/import');
  await selectPhoto(page);
  await page.getByRole('button', { name: 'Load more files' }).click();
  await expect(
    page.getByText(
      'Your cloud connection changed. Browse this folder again before choosing photos.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Import 0 selected', exact: true }),
  ).toBeDisabled();
  expect(state.starts).toHaveLength(0);
});

test('empty folders preserve breadcrumbs for returning to the parent', async ({
  page,
}) => {
  await setup(page, { emptyFolder: true });
  await page.goto('/app/import');
  await page
    .getByRole('button', { name: 'Browse photos', exact: true })
    .click();
  await page.getByRole('button', { name: 'Empty folder', exact: true }).click();
  await expect(
    page.getByText('No supported photos or folders here.', { exact: false }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Source folders' })
    .getByRole('button', { name: 'Root', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Empty folder', exact: true }),
  ).toBeVisible();
});

test('bulk selection respects available capacity and clears copy consent', async ({
  page,
}) => {
  await setup(page, { photoLimit: 1 });
  await page.goto('/app/import');
  await page
    .getByRole('button', { name: 'Browse photos', exact: true })
    .click();
  await page.getByRole('button', { name: 'Select loaded photos' }).click();
  await expect(
    page.getByRole('checkbox', { name: /photo\.jpg/ }),
  ).toBeChecked();
  await expect(
    page.getByText('1 selected / 1 available in this batch'),
  ).toBeVisible();
  const consent = page.getByRole('checkbox', {
    name: /I have permission to copy/,
  });
  await consent.check();
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await expect(consent).not.toBeChecked();
  await expect(
    page.getByRole('button', { name: 'Import 0 selected', exact: true }),
  ).toBeDisabled();
});

test('a second reconnect cannot reuse consent for a different source account', async ({
  page,
}) => {
  const state = await setup(page, {
    paused: true,
    reconnect: true,
    reconnectAgain: true,
  });
  await page.goto('/app/import');
  const resume = page.getByRole('button', { name: 'Resume missing photos' });
  await resume.click();
  const confirm = page.getByRole('checkbox', {
    name: /I confirm the reconnected source account/,
  });
  await confirm.check();
  await resume.click();
  await expect(
    page.getByText(
      'Your source account changed again. Confirm the current account before resuming.',
    ),
  ).toBeVisible();
  await expect(confirm).not.toBeChecked();
  expect(state.resumes).toHaveLength(1);
  await confirm.check();
  await resume.click();
  await expect(page.getByText('Queued', { exact: true })).toBeVisible();
  expect(state.resumes[1]?.generation).toBe(
    '33333333-3333-4333-8333-333333333333',
  );
});
