import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page) {
  const summary = {
    environment: 'test_mode',
    checkoutAvailable: false,
    products: [],
    portalAvailable: false,
    reconciliationAvailable: true,
    historyReconciliationAvailable: true,
    pendingCheckouts: [],
    photosRemaining: 20,
    searchesRemaining: 5,
    deliveryBytesRemaining: 1000,
    subscriptions: [],
    grants: [],
    paymentHistory: null as null | {
      status: string;
      checkedPayments: number;
      startedAt: string;
      through: string;
      completedAt: string | null;
    },
  };
  const state = { fail: false, checks: 0, otherWrites: [] as string[] };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'synthetic',
            name: 'Synthetic',
            email: 'synthetic@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: { events: [], photos: [], jobs: [], scans: [], photoLimit: 20 },
      });
    if (path === '/api/billing') return route.fulfill({ json: summary });
    if (path === '/api/billing/reconcile') {
      expect(route.request().postDataJSON()).toEqual({});
      state.checks++;
      if (state.fail)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              message:
                'Payment history could not be verified. Your progress is retained.',
            },
          },
        });
      const complete = summary.paymentHistory?.status === 'running';
      summary.paymentHistory = {
        status: complete ? 'complete' : 'running',
        checkedPayments: complete ? 7 : 5,
        startedAt: '2026-09-21T00:00:00Z',
        through: '2026-09-21T00:00:00Z',
        completedAt: complete ? '2026-09-21T00:01:00Z' : null,
      };
      if (complete) summary.photosRemaining = 1020;
      return route.fulfill({ json: summary });
    }
    if (route.request().method() !== 'GET') state.otherWrites.push(path);
    return route.fulfill({ json: {} });
  });
  return { summary, state };
}
test('a newer completed status does not leave an obsolete continue-checking message', async ({
  page,
}) => {
  const { summary } = await fixture(page);
  await page.route('**/api/billing/reconcile', async (route) => {
    const cursor = {
      status: 'running',
      checkedPayments: 5,
      startedAt: '2026-09-21T00:00:00Z',
      through: '2026-09-21T00:00:00Z',
      completedAt: null,
    };
    const response = { ...summary, paymentHistory: cursor };
    // Another tab finishes before the follow-up balance read reaches the server.
    summary.paymentHistory = {
      ...cursor,
      status: 'complete',
      checkedPayments: 7,
      completedAt: '2026-09-21T00:01:00Z',
    };
    await route.fulfill({ json: response });
  });
  await page.goto('/app/billing');
  await page
    .getByRole('button', { name: 'Check payment status', exact: true })
    .click();
  await expect(
    page.getByText('Payment history check completed', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/More payment history remains/)).toHaveCount(0);
});

test('history checks survive reload and do not call a partial batch complete', async ({
  page,
}) => {
  const { state } = await fixture(page);
  await page.goto('/app/billing');
  await page
    .getByRole('button', { name: 'Check payment status', exact: true })
    .click();
  await expect(
    page.getByText('Payment history check in progress', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/More payment history remains/)).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Continue checking history' }).click();
  await expect(
    page.getByText('Payment history check completed', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('.billing-metrics')).toContainText('1,020');
  expect(state.checks).toBe(2);
  expect(state.otherWrites).toEqual([]);
});
test('history outages retain balances and allow resuming the same server-owned progress', async ({
  page,
}) => {
  const { state } = await fixture(page);
  await page.goto('/app/billing');
  await page
    .getByRole('button', { name: 'Check payment status', exact: true })
    .click();
  state.fail = true;
  await page.getByRole('button', { name: 'Continue checking history' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Your progress is retained',
  );
  await expect(
    page.getByText('Payment history check in progress', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Payment history check completed', { exact: true }),
  ).toHaveCount(0);
  state.fail = false;
  await page.getByRole('button', { name: 'Continue checking history' }).click();
  await expect(
    page.getByText('Payment history check completed', { exact: true }),
  ).toBeVisible();
  expect(state.otherWrites).toEqual([]);
});
test('checking history never enables a disabled checkout and fits mobile', async ({
  page,
}) => {
  const { state } = await fixture(page);
  await page.goto('/app/billing');
  await page
    .getByRole('button', { name: 'Check payment status', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Continue to secure checkout' }),
  ).toBeDisabled();
  await expect(
    page.getByText(/does not charge you or change a subscription/),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  expect(state.otherWrites).toEqual([]);
});
