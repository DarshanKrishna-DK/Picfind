import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { serviceFixture } from '../fixtures/studio-services';
import { questionnaireOrigin } from '../fixtures/questionnaires';

async function fixture(page: Page) {
  const f = serviceFixture();
  const state = {
    actor: f.ownerId as string,
    loseReply: false,
    failRead: '',
    holdExport: false,
    release: null as (() => void) | null,
    writes: 0,
    exportsCompleted: 0,
  };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url()),
      path = url.pathname + url.search,
      method = incoming.method().toLowerCase() as
        'get' | 'post' | 'put' | 'patch' | 'delete';
    if (method === 'get' && state.failRead === url.pathname)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Synthetic catalog read failure.' },
        }),
      });
    if (
      method === 'get' &&
      state.holdExport &&
      url.pathname === `${f.root}/export`
    )
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    let call = request(f.app)[method](path).set('Origin', questionnaireOrigin);
    if (state.actor)
      call = call.set('Cookie', `picfind_session=${state.actor}`);
    const actor = incoming.headers()['x-picfind-service-actor'];
    if (actor) call = call.set('X-PicFind-Service-Actor', actor);
    if (incoming.postData()) call = call.send(JSON.parse(incoming.postData()!));
    if (method === 'put' && path.startsWith(f.root)) state.writes++;
    const response = await call;
    if (method === 'put' && state.loseReply && response.status === 200) {
      state.loseReply = false;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Synthetic saved reply loss.' },
        }),
      });
    }
    await route
      .fulfill({
        status: response.status,
        contentType: 'application/json',
        body: response.status === 204 ? '' : JSON.stringify(response.body),
      })
      .catch(() => {});
    if (method === 'get' && url.pathname === `${f.root}/export`)
      state.exportsCompleted++;
  });
  const open = async () => {
    await page.goto('/app/services');
    await expect(
      page.getByRole('heading', { name: 'Services', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'New service', exact: true }),
    ).toBeEnabled();
  };
  const edit = async () => {
    await open();
    await page
      .getByRole('button', {
        name: 'Edit service: Event portraits',
        exact: true,
      })
      .click();
    await expect(
      page.getByRole('textbox', { name: 'Service title' }),
    ).toHaveValue('Event portraits');
  };
  return { ...f, state, open, edit };
}
async function createDraft(page: Page) {
  await page.getByRole('button', { name: 'New service', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Service title' })
    .fill('Event portraits');
  await page
    .getByRole('textbox', { name: 'Service description' })
    .fill('Two photographers for your event.');
  await page
    .getByRole('textbox', { name: 'Deliverables, one per line' })
    .fill('Two hours of coverage\n40 edited JPEG files');
  await page
    .getByRole('textbox', {
      name: 'Session duration in minutes (optional)',
      exact: true,
    })
    .fill('120');
  await page
    .getByRole('combobox', { name: 'Pricing mode' })
    .selectOption('starting');
  await page.getByRole('textbox', { name: 'Package amount' }).fill('2500.09');
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Save service', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Service saved privately.' }),
  ).toBeVisible();
}

test('creates a private package, reloads exact prices and archives and restores it', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.goto('/app');
  if (info.project.name === 'webkit-mobile')
    await page
      .getByRole('button', { name: 'Toggle studio navigation' })
      .click();
  await page.getByRole('link', { name: 'Services', exact: true }).click();
  await createDraft(page);
  await save(page);
  const row = [...f.records.values()].find((value) => value.studioService)!;
  expect(row.studioService).toMatchObject({
    amountMinor: 250009,
    durationMinutes: 120,
    archived: false,
  });
  await page.reload();
  await page
    .getByRole('button', { name: 'Edit service: Event portraits', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Package amount' }),
  ).toHaveValue('2500.09');
  await expect(
    page.getByRole('textbox', { name: 'Deliverables, one per line' }),
  ).toHaveValue('Two hours of coverage\n40 edited JPEG files');
  await page
    .getByRole('region', { name: 'Service editor' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('service-editor.png'),
    fullPage: true,
  });
  await page.getByRole('checkbox', { name: 'Archive service' }).check();
  await save(page);
  await expect(
    page.getByText('No services in this view.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Catalog view' })
    .selectOption('archived');
  await page
    .getByRole('button', { name: 'Edit service: Event portraits', exact: true })
    .click();
  await page.getByRole('checkbox', { name: 'Archive service' }).uncheck();
  await save(page);
  await page
    .getByRole('combobox', { name: 'Catalog view' })
    .selectOption('active');
  await expect(
    page.getByRole('button', {
      name: 'Edit service: Event portraits',
      exact: true,
    }),
  ).toBeVisible();
  expect(f.records.get(row.id)?.studioService?.version).toBe(3);
});

test('recovers a committed new-service reply without duplicating the package', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await createDraft(page);
  f.state.loseReply = true;
  await page.getByRole('button', { name: 'Save service', exact: true }).click();
  await expect(
    page.getByText('Synthetic saved reply loss.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Package amount' }),
  ).toHaveValue('2500.09');
  await save(page);
  const rows = [...f.records.values()].filter((row) => row.studioService);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.studioService?.version).toBe(1);
});

test('rejects excess decimal precision before writing and removes the amount for quote-only pricing', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await createDraft(page);
  await page.getByRole('textbox', { name: 'Package amount' }).fill('2500.009');
  await page.getByRole('button', { name: 'Save service', exact: true }).click();
  await expect(
    page.getByText(/Enter an amount with at most two decimal places/),
  ).toBeVisible();
  expect(f.state.writes).toBe(0);
  await page
    .getByRole('combobox', { name: 'Pricing mode' })
    .selectOption('quote');
  await expect(
    page.getByRole('textbox', { name: 'Package amount' }),
  ).toHaveCount(0);
  await save(page);
  expect(
    [...f.records.values()].find((row) => row.studioService)?.studioService
      ?.amountMinor,
  ).toBeNull();
  await page.reload();
  await expect(
    page.getByText('Request a quote', { exact: true }),
  ).toBeVisible();
});

test('preserves stale drafts and requires confirmation even when reselecting the same package', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.edit();
  const description = page.getByRole('textbox', {
    name: 'Service description',
  });
  await description.fill('Unsaved local description.');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('button', { name: 'Edit service: Event portraits', exact: true })
    .click();
  await expect(description).toHaveValue('Unsaved local description.');
  await f.save({ description: 'Saved elsewhere.' }, 1).expect(200);
  await page.getByRole('button', { name: 'Refresh catalog' }).click();
  await expect(
    page.getByRole('button', { name: 'Save service', exact: true }),
  ).toBeDisabled();
  await expect(description).toHaveValue('Unsaved local description.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Load latest service' }).click();
  await expect(description).toHaveValue('Saved elsewhere.');
  await expect(
    page.getByRole('button', { name: 'Save service', exact: true }),
  ).toBeEnabled();
});

test('retains drafts through catalog outages and canceled view changes', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.edit();
  const description = page.getByRole('textbox', {
    name: 'Service description',
  });
  await description.fill('Keep this service draft.');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('combobox', { name: 'Catalog view' })
    .selectOption('archived');
  await expect(
    page.getByRole('combobox', { name: 'Catalog view' }),
  ).toHaveValue('active');
  f.state.failRead = f.root;
  await page.getByRole('button', { name: 'Refresh catalog' }).click();
  await expect(
    page.getByText('Synthetic catalog read failure.', { exact: true }),
  ).toBeVisible();
  await expect(description).toHaveValue('Keep this service draft.');
  await expect(
    page.getByRole('button', { name: 'Save service', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Load latest service' }),
  ).toBeDisabled();
  f.state.failRead = '';
  await page.getByRole('button', { name: 'Refresh catalog' }).click();
  await expect(
    page.getByRole('button', { name: 'Save service', exact: true }),
  ).toBeEnabled();
  await expect(description).toHaveValue('Keep this service draft.');
});

test('hides private catalog details after a changed-account save', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.edit();
  await page
    .getByRole('textbox', { name: 'Service description' })
    .fill('Do not write across accounts.');
  f.state.actor = f.strangerId;
  await page.getByRole('button', { name: 'Save service', exact: true }).click();
  await expect(
    page.getByText('The signed-in account changed. Reload the catalog.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Service editor' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Event portraits', exact: true }),
  ).toHaveCount(0);
  expect(f.records.get(f.serviceId)?.studioService?.version).toBe(1);
});

test('downloads all filtered saved services beyond one page with spreadsheet-safe fields', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save({ title: '=Private package' }).expect(200);
  const original = f.records.get(f.serviceId)!;
  for (let i = 1; i <= 40; i++) {
    const row = structuredClone(original),
      id = randomUUID();
    row.id = row.studioService!.id = id;
    row.studioService!.title = `Package ${String(i).padStart(2, '0')}`;
    f.records.set(id, row);
  }
  await f.open();
  await expect(
    page.getByRole('button', { name: /^Edit service:/ }),
  ).toHaveCount(40);
  await page.getByRole('button', { name: 'Next services' }).click();
  await expect(
    page.getByRole('button', { name: /^Edit service:/ }),
  ).toHaveCount(1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export saved view CSV' }).click();
  const file = await download,
    contents = await readFile((await file.path())!, 'utf8');
  expect(file.suggestedFilename()).toBe('picfind-private-services.csv');
  expect(contents).toContain(`"'=Private package"`);
  expect(contents).toContain('"Package 40"');
  for (const row of f.records.values())
    if (row.studioService) expect(contents).toContain(row.id);
  await expect(page.getByRole('status')).toContainText('41 saved services');
  await page
    .getByRole('textbox', { name: 'Search services' })
    .fill('Package 40');
  await expect(
    page.getByRole('button', { name: /^Edit service:/ }),
  ).toHaveCount(1);
  const filtered = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export saved view CSV' }).click();
  const filteredText = await readFile((await (await filtered).path())!, 'utf8');
  expect(filteredText).toContain('"Package 40"');
  expect(filteredText).not.toContain('=Private package');
});

test('does not download cached data after export fails or completes after navigation', async ({
  page,
}) => {
  const f = await fixture(page),
    downloads: string[] = [];
  page.on('download', (value) => downloads.push(value.suggestedFilename()));
  await f.save().expect(200);
  await f.open();
  f.state.failRead = `${f.root}/export`;
  await page.getByRole('button', { name: 'Export saved view CSV' }).click();
  await expect(
    page.getByText('Synthetic catalog read failure.', { exact: true }),
  ).toBeVisible();
  expect(downloads).toHaveLength(0);
  f.state.failRead = '';
  f.state.holdExport = true;
  await page.getByRole('button', { name: 'Export saved view CSV' }).click();
  await expect.poll(() => Boolean(f.state.release)).toBe(true);
  const overview = page.getByRole('link', { name: 'Overview', exact: true });
  if (!(await overview.isVisible()))
    await page
      .getByRole('button', { name: 'Toggle studio navigation' })
      .click();
  await overview.click();
  f.state.holdExport = false;
  f.state.release?.();
  await expect(page).toHaveURL(/\/app$/);
  await expect.poll(() => f.state.exportsCompleted).toBe(1);
  await expect(
    page.getByRole('region', { name: 'Service editor' }),
  ).toHaveCount(0);
  expect(downloads).toHaveLength(0);
});

test('requires explicit archived removal confirmation and refreshes after an empty successful reply', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save({ archived: true }).expect(200);
  await f.open();
  await page
    .getByRole('combobox', { name: 'Catalog view' })
    .selectOption('archived');
  await page
    .getByRole('button', { name: 'Edit service: Event portraits', exact: true })
    .click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Remove archived service' }).click();
  expect(f.records.has(f.serviceId)).toBe(true);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Remove archived service' }).click();
  await expect(
    page.getByText('No services in this view.', { exact: true }),
  ).toBeVisible();
  expect(f.records.has(f.serviceId)).toBe(false);
});
