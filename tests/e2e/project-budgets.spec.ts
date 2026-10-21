import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { budgetFixture } from '../fixtures/project-budgets';
import { questionnaireOrigin } from '../fixtures/questionnaires';
import {
  advanceProject,
  blankProject,
} from '../../packages/shared/src/studio-projects';

async function fixture(page: Page) {
  const f = budgetFixture();
  const state = {
    actor: f.ownerId,
    failRead: false,
    loseReply: false,
    corruptReport: false,
    writes: 0,
  };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url()),
      path = url.pathname + url.search,
      method = incoming.method().toLowerCase() as
        'get' | 'put' | 'post' | 'patch' | 'delete';
    if (state.failRead && method === 'get' && url.pathname === f.budgetRoot)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Synthetic budget read failure.' },
        }),
      });
    const transport = request(f.app);
    let call = transport[method](path).set('Origin', questionnaireOrigin);
    if (state.actor)
      call = call.set('Cookie', `picfind_session=${state.actor}`);
    for (const header of ['x-picfind-budget-actor', 'x-picfind-expense-actor'])
      if (incoming.headers()[header])
        call = call.set(header, incoming.headers()[header]!);
    if (incoming.postData()) call = call.send(JSON.parse(incoming.postData()!));
    if (method === 'put' && path === f.budgetRoot) state.writes++;
    const response = await call;
    if (
      state.corruptReport &&
      method === 'get' &&
      path === f.budgetRoot &&
      response.status === 200
    )
      response.body.currencies[0].overBudget = null;
    if (
      method === 'put' &&
      path === f.budgetRoot &&
      state.loseReply &&
      response.status === 200
    ) {
      state.loseReply = false;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Synthetic committed reply loss.' },
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
  });
  page.on('dialog', (dialog) => void dialog.accept());
  const open = async () => {
    await page.goto(`/app/projects/${f.projectId}/budget`);
    await expect(
      page.getByRole('heading', { name: 'Project cost budget', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('INR budget', { exact: true })).toBeEnabled();
  };
  const focus = () =>
    page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  return { ...f, state, open, focus };
}

test('saves separate currency limits and displays real journal comparisons after reload', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await f.save({ amountMinor: 170000 }).expect(200);
  await f
    .save({ currency: 'USD', amountMinor: 1234 }, null, randomUUID())
    .expect(200);
  await f.open();
  await expect(
    page.getByRole('region', { name: 'Recorded cost comparison' }),
  ).toContainText('2 verified journal entries');
  await page.getByLabel('INR budget', { exact: true }).fill('1500.00');
  await page.getByLabel('EUR budget', { exact: true }).fill('0');
  await page
    .getByRole('textbox', { name: 'Private budget note', exact: true })
    .fill('Keep travel within plan');
  await page.getByRole('button', { name: 'Save budget', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(
    'Project cost budget saved',
  );
  const inr = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'INR', exact: true }) });
  await expect(inr).toContainText('-₹200.00');
  await expect(inr).toContainText('Over budget');
  await expect(
    page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: 'USD', exact: true }) }),
  ).toContainText('No budget set');
  await page.screenshot({
    path: info.outputPath('project-budget-editor.png'),
    fullPage: true,
  });
  await page
    .getByRole('region', { name: 'Recorded cost comparison' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('project-budget-comparison.png'),
  });
  await page.reload();
  await expect(page.getByLabel('INR budget', { exact: true })).toHaveValue(
    '1500.00',
  );
  await expect(page.getByLabel('EUR budget', { exact: true })).toHaveValue(
    '0.00',
  );
  await expect(
    page.getByRole('textbox', { name: 'Private budget note', exact: true }),
  ).toHaveValue('Keep travel within plan');
});
test('opens the budget from the project page and filters the linked expense journal', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f
    .save({ projectId: null, title: 'Unrelated overhead' }, null, randomUUID())
    .expect(200);
  await page.goto('/app/projects');
  await page.getByRole('button', { name: /Portrait session/ }).click();
  await page.getByRole('link', { name: 'Cost budget', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Project cost budget', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'Review linked expenses', exact: true })
    .click();
  await expect(
    page.getByRole('combobox', { name: 'Project filter', exact: true }),
  ).toHaveValue(f.projectId);
  await expect(
    page.getByRole('button', {
      name: 'Edit entry: Train to event',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Edit entry: Unrelated overhead',
      exact: true,
    }),
  ).toHaveCount(0);
});
test('requires explicit review of legacy links before costs enter the budget', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  delete f.records.get(f.expenseId)!.studioExpense!.projectCreatedAt;
  await f.open();
  await expect(page.getByRole('alert')).toContainText(
    '1 older project links need review',
  );
  await page
    .getByRole('link', { name: 'Review linked expenses', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Edit entry: Train to event', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Save entry', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('checkbox', {
      name: /I reviewed this historical or unverified link/,
    })
    .check();
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Journal entry saved');
  const row = f.records.get(f.projectId)!;
  const createdAt = new Date(
    Date.parse(f.projectCreatedAt) + 60000,
  ).toISOString();
  row.createdAt = createdAt;
  row.studioProject = advanceProject(
    null,
    f.projectId,
    { ...blankProject(), name: 'Replacement project' },
    '',
    f.ownerId,
    createdAt,
  );
  await f.focus();
  await expect(
    page.getByRole('checkbox', {
      name: /I reviewed this historical or unverified link/,
    }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('button', { name: 'Save entry', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('checkbox', {
      name: /I reviewed this historical or unverified link/,
    })
    .check();
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(
    page.getByRole('checkbox', {
      name: /I reviewed this historical or unverified link/,
    }),
  ).toHaveCount(0);
  await f.open();
  await expect(
    page.getByRole('region', { name: 'Recorded cost comparison' }),
  ).toContainText('1 verified journal entries');
  await expect(
    page.getByText('1 older project links need review', { exact: false }),
  ).toHaveCount(0);
});
test('updates the project filter when the journal URL changes without a page reload', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f
    .save({ projectId: null, title: 'Unrelated overhead' }, null, randomUUID())
    .expect(200);
  await page.goto('/app/expenses');
  await expect(
    page.getByRole('button', {
      name: 'Edit entry: Unrelated overhead',
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate((id) => {
    window.history.pushState({}, '', `/app/expenses?project=${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, f.projectId);
  await expect(
    page.getByRole('combobox', { name: 'Project filter', exact: true }),
  ).toHaveValue(f.projectId);
  await expect(
    page.getByRole('button', {
      name: 'Edit entry: Unrelated overhead',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Edit entry: Train to event',
      exact: true,
    }),
  ).toBeVisible();
});
test('hides a malformed cost report instead of displaying a false zero over-budget amount', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.writeBudget().expect(200);
  await f.open();
  f.state.corruptReport = true;
  await f.focus();
  await expect(
    page.getByRole('region', { name: 'Recorded cost comparison' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Save budget', exact: true }),
  ).toBeDisabled();
});
test('preserves an unsaved expense when the project URL changes and requires confirmation to discard it', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await page.goto('/app/expenses');
  await page
    .getByRole('button', { name: 'Edit entry: Train to event', exact: true })
    .click();
  await page
    .getByLabel('Entry title', { exact: true })
    .fill('Unfinished travel correction');
  await page.evaluate((id) => {
    window.history.pushState({}, '', `/app/expenses?project=${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, f.projectId);
  await expect(
    page.getByText(
      'The requested project filter is waiting. Your current expense draft is preserved.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Entry title', { exact: true })).toHaveValue(
    'Unfinished travel correction',
  );
  await expect(
    page.getByRole('combobox', { name: 'Project filter', exact: true }),
  ).toHaveValue('all');
  page.removeAllListeners('dialog');
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page
    .getByRole('button', { name: 'Load requested project filter', exact: true })
    .click();
  await expect(page.getByLabel('Entry title', { exact: true })).toHaveValue(
    'Unfinished travel correction',
  );
  page.once('dialog', (dialog) => void dialog.accept());
  await page
    .getByRole('button', { name: 'Load requested project filter', exact: true })
    .click();
  await expect(page.getByLabel('Entry title', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('combobox', { name: 'Project filter', exact: true }),
  ).toHaveValue(f.projectId);
  expect(f.records.get(f.expenseId)!.studioExpense!.title).toBe(
    'Train to event',
  );
});
test('rejects invalid decimal input and clears a limit without removing journal costs', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.writeBudget().expect(200);
  await f.open();
  for (const amount of ['-1', '1.001', '10000000.01', '1e2']) {
    await page.getByLabel('INR budget', { exact: true }).fill(amount);
    await expect(
      page.getByRole('button', { name: 'Save budget', exact: true }),
    ).toBeDisabled();
  }
  await page.getByLabel('INR budget', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save budget', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('saved');
  await expect(
    page.getByRole('region', { name: 'Recorded cost comparison' }),
  ).toContainText('No budget set');
  expect(f.records.has(f.expenseId)).toBe(true);
});
test('recovers a committed reply loss without a duplicate budget revision', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await page.getByLabel('INR budget', { exact: true }).fill('42.01');
  f.state.loseReply = true;
  await page.getByRole('button', { name: 'Save budget', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic committed reply loss',
  );
  await expect(page.getByLabel('INR budget', { exact: true })).toHaveValue(
    '42.01',
  );
  await page.getByRole('button', { name: 'Save budget', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('saved');
  expect(f.records.get(f.budgetId)!.projectBudget!.version).toBe(1);
  expect(f.state.writes).toBe(2);
});
test('preserves a stale draft and blocks saving until the latest budget is loaded', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await page.getByLabel('INR budget', { exact: true }).fill('444');
  await f.writeBudget().expect(200);
  await f.focus();
  await expect(
    page.getByText('The budget changed or could not be refreshed.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByLabel('INR budget', { exact: true })).toHaveValue(
    '444',
  );
  await expect(
    page.getByRole('button', { name: 'Save budget', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Load latest budget', exact: true })
    .click();
  await expect(page.getByLabel('INR budget', { exact: true })).toHaveValue(
    '1500.00',
  );
});
test('hides failed cost comparisons, preserves drafts and removes private state after account changes', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.writeBudget().expect(200);
  await f.open();
  await page
    .getByRole('textbox', { name: 'Private budget note', exact: true })
    .fill('Private unreconciled draft');
  f.state.failRead = true;
  await f.focus();
  await expect(
    page.getByText('Synthetic budget read failure.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Recorded cost comparison' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: 'Private budget note', exact: true }),
  ).toHaveValue('Private unreconciled draft');
  await expect(
    page.getByRole('button', { name: 'Save budget', exact: true }),
  ).toBeDisabled();
  f.state.failRead = false;
  await page
    .getByRole('button', { name: 'Load latest budget', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Private budget note', exact: true }),
  ).toHaveValue(f.budgetFields.note);
  f.state.actor = f.strangerId;
  await f.focus();
  await expect(
    page.getByRole('textbox', { name: 'Private budget note', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(f.budgetFields.note, { exact: true }),
  ).toHaveCount(0);
});
