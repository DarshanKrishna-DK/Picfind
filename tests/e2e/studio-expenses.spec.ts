import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { expenseFixture } from '../fixtures/studio-expenses';
import { questionnaireOrigin } from '../fixtures/questionnaires';

async function fixture(page: Page) {
  const f = expenseFixture();
  const state = {
    actor: f.ownerId as string,
    loseReply: false,
    failRead: false,
    holdExport: false,
    release: null as (() => void) | null,
    exportsCompleted: 0,
    writes: 0,
  };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url()),
      path = url.pathname + url.search,
      method = incoming.method().toLowerCase() as
        'get' | 'put' | 'post' | 'delete' | 'patch';
    if (method === 'get' && state.failRead && url.pathname === f.root)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Synthetic journal read failure.' },
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
    const actor = incoming.headers()['x-picfind-expense-actor'];
    if (actor) call = call.set('X-PicFind-Expense-Actor', actor);
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
  page.on('dialog', (dialog) => void dialog.accept());
  const open = async () => {
    await page.goto('/app/expenses');
    await expect(
      page.getByRole('heading', { name: 'Expenses', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'New entry', exact: true }),
    ).toBeEnabled();
  };
  const edit = async () => {
    await open();
    await page
      .getByRole('button', { name: 'Edit entry: Train to event', exact: true })
      .click();
    await expect(page.getByLabel('Entry title', { exact: true })).toHaveValue(
      'Train to event',
    );
  };
  return { ...f, state, open, edit };
}
async function fill(page: Page) {
  await page.getByRole('button', { name: 'New entry', exact: true }).click();
  await page
    .getByLabel('Entry title', { exact: true })
    .fill('Travel to portrait session');
  await page.getByLabel('Date incurred', { exact: true }).fill('2026-10-20');
  await page
    .getByRole('combobox', { name: 'Category', exact: true })
    .selectOption('travel');
  await page
    .getByLabel('Merchant or payee', { exact: true })
    .fill('Rail service');
  await page.getByLabel('Amount', { exact: true }).fill('1250.50');
  await page
    .getByRole('combobox', { name: 'Linked project', exact: true })
    .selectOption({ label: 'Portrait session' });
  await page
    .getByLabel('Receipt or reference', { exact: true })
    .fill('TKT-100');
  await page
    .getByRole('textbox', { name: 'Private note', exact: true })
    .fill('Return travel for the shoot.');
}
test('records private costs and separate refunds with exact currency totals', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await f.open();
  await fill(page);
  await page
    .locator('.expense-form')
    .evaluate((form) => form.scrollIntoView({ block: 'start' }));
  await page.screenshot({
    path: info.outputPath('expense-editor.png'),
    fullPage: false,
  });
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Journal entry saved.');
  const first = [...f.records.values()].find(
    (row) => row.purpose === 'studio-expense',
  )!.studioExpense!;
  expect(first.amountMinor).toBe(125050);
  expect(first.incurredOn).toBe('2026-10-20');
  await page.getByRole('button', { name: 'New entry', exact: true }).click();
  await page
    .getByLabel('Entry title', { exact: true })
    .fill('Unused return fare refund');
  await page
    .getByRole('combobox', { name: 'Expense or refund', exact: true })
    .selectOption('refund');
  await page.getByLabel('Amount', { exact: true }).fill('250.50');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Journal entry saved.');
  await expect(
    page.getByText('Net cost: ₹1,000.00', { exact: true }),
  ).toBeVisible();
  expect(
    [...f.records.values()].filter((row) => row.purpose === 'studio-expense'),
  ).toHaveLength(2);
});
test('recovers lost save replies and preserves the stable record identity', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await fill(page);
  f.state.loseReply = true;
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByText('Synthetic saved reply loss.')).toBeVisible();
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue(
    '1250.50',
  );
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Journal entry saved.');
  const rows = [...f.records.values()].filter(
    (row) => row.purpose === 'studio-expense',
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.studioExpense!.version).toBe(1);
});
test('preserves stale drafts and explicitly loads the newer saved revision', async ({
  page,
}) => {
  const f = await fixture(page),
    initial = (await f.save().expect(200)).body.entry;
  await f.edit();
  await page
    .getByRole('textbox', { name: 'Private note', exact: true })
    .fill('Keep my local draft');
  await f.save({ note: 'Saved in another tab' }, initial).expect(200);
  await page
    .getByRole('button', { name: 'Reload journal', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'The saved journal changed',
  );
  await expect(
    page.getByRole('textbox', { name: 'Private note', exact: true }),
  ).toHaveValue('Keep my local draft');
  await expect(
    page.getByRole('button', { name: 'Save entry', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Load latest entry', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Private note', exact: true }),
  ).toHaveValue('Saved in another tab');
  await expect(
    page.getByRole('button', { name: 'Save entry', exact: true }),
  ).toBeEnabled();
});
test('blocks saves and cached adoption after failed refresh while retaining the draft', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.edit();
  await page
    .getByRole('textbox', { name: 'Private note', exact: true })
    .fill('Preserve this draft');
  f.state.failRead = true;
  await page
    .getByRole('button', { name: 'Reload journal', exact: true })
    .click();
  await expect(page.getByText('Synthetic journal read failure.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save entry', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Load latest entry', exact: true }),
  ).toBeDisabled();
  f.state.failRead = false;
  await page
    .getByRole('button', { name: 'Reload journal', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Save entry', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('textbox', { name: 'Private note', exact: true }),
  ).toHaveValue('Preserve this draft');
});
test('detects deletion of the selected entry without losing its unsaved draft', async ({
  page,
}) => {
  const f = await fixture(page);
  const saved = (await f.save().expect(200)).body.entry;
  await f.edit();
  await page
    .getByRole('textbox', { name: 'Private note', exact: true })
    .fill('Keep this draft');
  await f.removeEntry(saved).expect(204);
  await page
    .getByRole('button', { name: 'Reload journal', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Save entry', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Remove entry', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('textbox', { name: 'Private note', exact: true }),
  ).toHaveValue('Keep this draft');
  expect(f.state.writes).toBe(0);
  await page.getByRole('button', { name: 'New entry', exact: true }).click();
  await expect(page.getByLabel('Entry title', { exact: true })).toHaveValue('');
});
test('keeps a valid selected record editable after its saved direction leaves the filter', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.open();
  await page
    .getByRole('combobox', { name: 'Direction', exact: true })
    .selectOption('expense');
  await page
    .getByRole('button', { name: 'Edit entry: Train to event', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Expense or refund', exact: true })
    .selectOption('refund');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(
    page.getByText('No entries match these filters.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save entry', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('textbox', { name: 'Private note', exact: true })
    .fill('Refund confirmed');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect
    .poll(() => f.records.get(f.expenseId)?.studioExpense?.note)
    .toBe('Refund confirmed');
});
test('confirms changed drafts even after amount is cleared and clears discarded editor state', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await page.getByRole('button', { name: 'New entry', exact: true }).click();
  page.removeAllListeners('dialog');
  let dialogs = 0;
  page.on('dialog', async (dialog) => {
    dialogs++;
    await dialog.dismiss();
  });
  await page
    .getByRole('combobox', { name: 'Category filter', exact: true })
    .selectOption('travel');
  expect(dialogs).toBe(0);
  await page.getByRole('button', { name: 'New entry', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Private note', exact: true })
    .fill('Unsaved note');
  await page.getByLabel('Amount', { exact: true }).fill('1.00');
  await page.getByLabel('Amount', { exact: true }).fill('');
  await page
    .getByRole('combobox', { name: 'Category filter', exact: true })
    .selectOption('other');
  expect(dialogs).toBe(1);
  await expect(
    page.getByRole('textbox', { name: 'Private note', exact: true }),
  ).toHaveValue('Unsaved note');
  page.removeAllListeners('dialog');
  page.on('dialog', (dialog) => void dialog.accept());
  await page
    .getByRole('combobox', { name: 'Category filter', exact: true })
    .selectOption('other');
  await expect(page.locator('.expense-form')).toHaveCount(0);
  await page.getByRole('button', { name: 'New entry', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Private note', exact: true }),
  ).toHaveValue('');
  await expect(
    page.getByRole('button', { name: 'Remove entry', exact: true }),
  ).toHaveCount(0);
});
test('exports all matching pages and preserves exact amounts and escaped notes', async ({
  page,
}) => {
  const f = await fixture(page);
  await f
    .save({ title: '=Train', note: 'A\n"B"', amountMinor: 101 })
    .expect(200);
  const seed = structuredClone(f.records.get(f.expenseId)!);
  for (let i = 0; i < 43; i++) {
    const row = structuredClone(seed),
      id = randomUUID();
    row.id = row.studioExpense!.id = id;
    row.studioExpense!.generation = randomUUID();
    f.records.set(id, row);
  }
  await f.open();
  await expect(
    page.getByText('44 matching entries. 44 of 500 retained entries.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Next entries', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Edit entry:/ })).toHaveCount(
    4,
  );
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Export all matching entries', exact: true })
    .click();
  const csv = await readFile((await (await download).path())!, 'utf8');
  expect(csv).toContain(`"'=Train"`);
  expect(csv).toContain('"A\n""B"""');
  expect(csv).toContain('"INR","1.01","101"');
  for (const row of f.records.values())
    if (row.studioExpense) expect(csv).toContain(row.id);
});
test('removes records with empty deletion replies and updates the saved view', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.edit();
  await page.getByRole('button', { name: 'Remove entry', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Journal entry removed.');
  await expect(
    page.getByText('No entries match these filters.', { exact: true }),
  ).toBeVisible();
  expect(f.records.has(f.expenseId)).toBe(false);
});
test('hides journal data after an account switch during refresh', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.edit();
  f.state.actor = f.strangerId;
  await page
    .getByRole('button', { name: 'Reload journal', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Expense journal unavailable',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Private note', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Edit entry: Train to event',
      exact: true,
    }),
  ).toHaveCount(0);
});
test('rejects invalid money before writing and accepts one minor unit', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await fill(page);
  for (const value of ['0', '1.001', '1e3', '10000000.01']) {
    await page.getByLabel('Amount', { exact: true }).fill(value);
    await expect(
      page.getByRole('button', { name: 'Save entry', exact: true }),
    ).toBeDisabled();
  }
  expect(f.state.writes).toBe(0);
  await page.getByLabel('Amount', { exact: true }).fill('0.01');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Journal entry saved.');
  expect(
    [...f.records.values()].find((row) => row.studioExpense)!.studioExpense!
      .amountMinor,
  ).toBe(1);
});
test('cancels a delayed export when navigating away from the journal', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.open();
  let downloads = 0;
  page.on('download', () => {
    downloads++;
  });
  f.state.holdExport = true;
  await page
    .getByRole('button', { name: 'Export all matching entries', exact: true })
    .click();
  await expect.poll(() => f.state.release !== null).toBe(true);
  for (const name of [
    'New entry',
    'Reload journal',
    'Export all matching entries',
  ])
    await expect(
      page.getByRole('button', { name, exact: true }),
    ).toBeDisabled();
  const overview = page.getByRole('link', { name: 'Overview', exact: true });
  if (!(await overview.isVisible()))
    await page
      .getByRole('button', { name: 'Toggle studio navigation', exact: true })
      .click();
  await overview.click();
  await expect(page).toHaveURL(/\/app$/);
  f.state.release!();
  await expect.poll(() => f.state.exportsCompleted).toBe(1);
  expect(downloads).toBe(0);
});
