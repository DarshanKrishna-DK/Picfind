import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { enquiryReportFixture } from '../fixtures/enquiry-report';
import { questionnaireOrigin } from '../fixtures/questionnaires';
async function fixture(page: Page) {
  const f = await enquiryReportFixture(),
    state = {
      actor: f.ownerId,
      fail: false,
      hold: false,
      held: false,
      release: null as (() => void) | null,
      completed: 0,
    };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url()),
      isReport = url.pathname === f.reportRoot;
    if (isReport && state.fail)
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Synthetic report read failure.' } },
      });
    if (isReport && state.hold)
      await new Promise<void>((resolve) => {
        state.held = true;
        state.release = resolve;
      });
    const method = incoming.method().toLowerCase() as
        'get' | 'put' | 'post' | 'delete' | 'patch',
      transport = request(f.app);
    let call = transport[method](url.pathname + url.search).set(
      'Origin',
      questionnaireOrigin,
    );
    if (state.actor)
      call = call.set('Cookie', `picfind_session=${state.actor}`);
    const actor = incoming.headers()['x-picfind-enquiry-report-actor'];
    if (actor) call = call.set('X-PicFind-Enquiry-Report-Actor', actor);
    if (incoming.postData()) call = call.send(incoming.postDataJSON());
    const response = await call;
    await route
      .fulfill({
        status: response.status,
        contentType: 'application/json',
        body: response.status === 204 ? '' : JSON.stringify(response.body),
      })
      .catch(() => {});
    if (isReport) state.completed++;
  });
  const open = async () => {
    await page.goto('/app/enquiry-report');
    await expect(
      page.getByRole('button', {
        name: 'Download matching enquiries CSV',
        exact: true,
      }),
    ).toBeEnabled();
  };
  const download = async () => {
    const pending = page.waitForEvent('download');
    await page
      .getByRole('button', {
        name: 'Download matching enquiries CSV',
        exact: true,
      })
      .click();
    const file = await pending;
    expect(file.suggestedFilename()).toBe('picfind-enquiry-report.csv');
    return readFile((await file.path())!, 'utf8');
  };
  const focus = () =>
    page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  return { ...f, state, open, download, focus };
}
const results = (page: Page) =>
  page.getByRole('region', { name: 'Enquiry report results', exact: true });
test('opens from the inbox and shows counts without contact details', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.goto('/app/enquiries');
  await page.getByRole('link', { name: 'Enquiry report', exact: true }).click();
  await expect(results(page)).toContainText(
    '4 matching enquiries of 4 retained.',
  );
  await expect(
    page
      .getByRole('table', { name: 'Current stage counts', exact: true })
      .getByRole('row'),
  ).toHaveCount(5);
  await expect(results(page)).not.toContainText(f.contact.email);
  await page
    .getByRole('table', { name: 'Current stage counts', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('private-enquiry-report.png'),
    fullPage: true,
  });
  const csv = await f.download();
  expect(csv.split('\r\n')).toHaveLength(6);
  expect(csv).not.toContain(f.contact.email);
  expect(csv).not.toContain('Secret follow-up instructions');
});
test('filters UTC received days and stage, rejects reversed ranges and recovers', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await page
    .getByLabel('Received from (UTC)', { exact: true })
    .fill('2026-10-21');
  await page
    .getByLabel('Received through (UTC)', { exact: true })
    .fill('2026-10-21');
  await expect(results(page)).toContainText(
    '2 matching enquiries of 4 retained.',
  );
  await page
    .getByRole('combobox', { name: 'Report stage', exact: true })
    .selectOption('qualified');
  await expect(results(page)).toContainText(
    '1 matching enquiries of 4 retained.',
  );
  expect(await f.download()).toContain(f.ids[1]!);
  await page
    .getByLabel('Received from (UTC)', { exact: true })
    .fill('2026-10-22');
  await expect(page.getByRole('alert')).toContainText('end date on or after');
  await expect(results(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Download matching enquiries CSV',
      exact: true,
    }),
  ).toBeDisabled();
  await page.getByLabel('Received from (UTC)', { exact: true }).fill('');
  await expect(results(page)).toContainText(
    '1 matching enquiries of 4 retained.',
  );
});
test('includes contacts only when selected and removes them again before exporting', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  const checkbox = page.getByLabel('Include unverified contact details', {
    exact: true,
  });
  await checkbox.check();
  await expect(
    page.getByRole('table', { name: 'Matching enquiries', exact: true }),
  ).toContainText(f.contact.email);
  const included = await f.download();
  expect(included).toContain(f.contact.email);
  expect(included).toContain('Name (unverified)');
  await checkbox.uncheck();
  await expect(results(page)).not.toContainText(f.contact.email);
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(await f.download()).not.toContain(f.contact.email);
});
test('exports all matching rows beyond the page and re-reads newly changed sources', async ({
  page,
}) => {
  const f = await fixture(page);
  for (let i = 0; i < 58; i++) f.add(`Event type ${i}`);
  await f.open();
  const table = page.getByRole('table', {
    name: 'Matching enquiries',
    exact: true,
  });
  await expect(table.getByRole('row')).toHaveCount(31);
  const csv = await f.download();
  expect(csv.split('\r\n')).toHaveLength(64);
  await page
    .getByRole('button', { name: 'Show more enquiry rows', exact: true })
    .click();
  await expect(table.getByRole('row')).toHaveCount(61);
  f.records.get(f.ids[0]!)!.studioEnquiry!.sessionType =
    'Fresh renamed session';
  await page
    .getByLabel('Session type contains', { exact: true })
    .fill('fresh renamed');
  await expect(results(page)).toContainText(
    '1 matching enquiries of 62 retained.',
  );
  f.records.delete(f.ids[0]!);
  expect((await f.download()).split('\r\n')).toHaveLength(2);
  await expect(results(page)).toContainText(
    '0 matching enquiries of 61 retained.',
  );
});
test('blocks failed exports, recovers reads and hides contacts after an account change', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  let downloads = 0;
  page.on('download', () => downloads++);
  f.state.fail = true;
  await page
    .getByRole('button', {
      name: 'Download matching enquiries CSV',
      exact: true,
    })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic report read failure.',
  );
  expect(downloads).toBe(0);
  await page
    .getByRole('button', { name: 'Refresh enquiry report', exact: true })
    .click();
  await expect(results(page)).toHaveCount(0);
  f.state.fail = false;
  await page
    .getByRole('button', { name: 'Refresh enquiry report', exact: true })
    .click();
  await expect(results(page)).toContainText('4 matching enquiries');
  await page
    .getByLabel('Include unverified contact details', { exact: true })
    .check();
  await expect(results(page)).toContainText(f.contact.email);
  f.state.actor = f.strangerId;
  await f.focus();
  await expect(page.getByText(f.contact.email, { exact: true })).toHaveCount(0);
  await expect(results(page)).toContainText(
    '0 matching enquiries of 0 retained.',
  );
  await expect(
    page.getByLabel('Include unverified contact details', { exact: true }),
  ).not.toBeChecked();
});
test('locks filters and cancels a pending export when leaving the report', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  let downloads = 0;
  page.on('download', () => downloads++);
  f.state.hold = true;
  await page
    .getByRole('button', {
      name: 'Download matching enquiries CSV',
      exact: true,
    })
    .click();
  await expect.poll(() => f.state.held).toBe(true);
  await expect(
    page.getByLabel('Include unverified contact details', { exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('link', { name: 'Back to enquiry inbox', exact: true })
    .click();
  await expect(page).toHaveURL(/\/app\/enquiries$/);
  const completed = f.state.completed;
  f.state.hold = false;
  f.state.release!();
  await expect.poll(() => f.state.completed).toBeGreaterThan(completed);
  expect(downloads).toBe(0);
});
test('rejects a completed export after the URL changes even before an unmount effect can run', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  let downloads = 0;
  page.on('download', () => downloads++);
  f.state.hold = true;
  await page
    .getByRole('button', {
      name: 'Download matching enquiries CSV',
      exact: true,
    })
    .click();
  await expect.poll(() => f.state.held).toBe(true);
  await page.evaluate(() =>
    window.history.pushState({}, '', '/app/enquiry-report?changed=1'),
  );
  const completed = f.state.completed;
  f.state.hold = false;
  f.state.release!();
  await expect.poll(() => f.state.completed).toBeGreaterThan(completed);
  await expect(page.getByRole('alert')).toContainText(
    'The page changed before the export completed.',
  );
  await expect(
    page.getByRole('button', {
      name: 'Download matching enquiries CSV',
      exact: true,
    }),
  ).toBeEnabled();
  expect(downloads).toBe(0);
  expect((await f.download()).split('\r\n')).toHaveLength(6);
});
