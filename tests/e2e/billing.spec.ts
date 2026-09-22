import { expect, test, type Page } from '@playwright/test';
import { chooseMenu } from './menu';

const summary = {
  environment: 'test_mode',
  checkoutAvailable: true,
  products: ['personal-1000:INR', 'organizer-starter-monthly:INR'],
  portalAvailable: false,
  photosRemaining: 1018,
  searchesRemaining: 119,
  deliveryBytesRemaining: 5500000000,
  subscriptions: [],
  grants: [
    {
      id: 'synthetic-pack',
      plan: 'photo-pack',
      expiresAt: '2027-09-20T00:00:00.000Z',
      photosRemaining: 1000,
      usedPhotos: 0,
      held: false,
      refundFraction: 0,
    },
  ],
};
async function prepare(page: Page, unavailable = false) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data =
      path === '/api/auth/session'
        ? {
            user: {
              id: 'billing-user',
              name: 'Synthetic billing test',
              email: 'test@example.test',
              emailVerified: true,
            },
          }
        : path === '/api/library'
          ? { photos: [], events: [], jobs: [], scans: [], photoLimit: 20 }
          : path === '/api/billing'
            ? unavailable
              ? {
                  error: {
                    code: 'BILLING_DISABLED',
                    message:
                      'Billing is not configured. No payment can be started.',
                  },
                }
              : summary
            : {
                error: {
                  message:
                    'This synthetic fixture does not expose this endpoint.',
                },
              };
    await route.fulfill({
      status: path === '/api/billing' && unavailable ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(data),
    });
  });
}
test('unresolved cancellation remains visible and recoverable for a locally terminal subscription', async ({
  page,
}) => {
  await prepare(page);
  let mutations = 0;
  await page.route('**/api/billing', (route) =>
    route.fulfill({
      json: {
        ...summary,
        cancellationAvailable: true,
        subscriptions: [
          {
            id: 'sub_pending',
            status: 'cancelled',
            cancelAtPeriodEnd: true,
            nextBillingAt: new Date().toISOString(),
            cancellationPending: true,
          },
        ],
      },
    }),
  );
  await page.route('**/api/billing/subscriptions/**', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { change: null } });
    mutations++;
    return route.fulfill({
      status: 503,
      json: { error: { message: 'Synthetic provider boundary' } },
    });
  });
  await page.goto('/app/billing');
  await expect(
    page.getByText(/A cancellation request still needs confirmation/),
  ).toBeVisible();
  const retry = page.getByRole('button', {
    name: 'Cancel subscription now',
    exact: true,
  });
  await expect(retry).toBeEnabled();
  expect(mutations).toBe(0);
  await retry.click();
  await expect(
    page.getByRole('region', { name: 'Confirm subscription cancellation' }),
  ).toBeVisible();
  expect(mutations).toBe(0);
});

test('non-resumable checkout waits for authoritative recovery before enabling resume', async ({
  page,
}) => {
  await prepare(page);
  let canResume = false;
  let resumes = 0;
  const current = () => ({
    ...summary,
    reconciliationAvailable: true,
    pendingCheckouts: [
      {
        id: 'pending',
        plan: 'personal-1000',
        currency: 'INR',
        status: 'unresolved',
        canResume,
      },
    ],
  });
  await page.route('**/api/billing', (route) =>
    route.fulfill({ json: current() }),
  );
  await page.route('**/api/billing/reconcile', (route) => {
    canResume = true;
    return route.fulfill({ json: current() });
  });
  await page.route('**/api/billing/checkout/pending/resume', (route) => {
    resumes++;
    return route.fulfill({ json: { url: 'https://unexpected.example.test/' } });
  });
  await page.goto('/app/billing');
  const resume = page.getByRole('button', { name: 'Resume saved checkout' });
  await expect(resume).toBeDisabled();
  await expect(
    page.getByText(/This checkout cannot be reopened yet/),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Continue to secure checkout' }),
  ).toBeDisabled();
  expect(resumes).toBe(0);
  await page
    .getByRole('button', { name: 'Check payment status', exact: true })
    .click();
  await expect(resume).toBeEnabled();
  await expect(
    page.getByText(/This checkout cannot be reopened yet/),
  ).toHaveCount(0);
  expect(resumes).toBe(0);
  await resume.click();
  await expect(page.getByText(/unexpected address/)).toBeVisible();
  expect(resumes).toBe(1);
});

test('saved checkout survives a reload and resumes its server selection, not the new selector', async ({
  page,
}) => {
  await prepare(page);
  await page.route('**/api/billing', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...summary,
        reconciliationAvailable: true,
        pendingCheckouts: [
          {
            id: 'saved',
            plan: 'creator',
            currency: 'INR',
            status: 'unresolved',
            canResume: true,
          },
        ],
      }),
    }),
  );
  const purchases: Record<string, unknown>[] = [];
  await page.route('**/api/billing/checkout/saved/resume', async (route) => {
    purchases.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ url: 'https://wrong.example.test/' }),
    });
  });
  await page.goto('/app/billing', { waitUntil: 'domcontentloaded' });
  // Confirm the first render before exercising a reload; wait on the product UI,
  // not completion of unrelated browser subresource loading.
  await expect(
    page.getByRole('heading', { name: 'Your saved checkout' }),
  ).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(
    page.getByRole('heading', { name: 'Your saved checkout' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Continue to secure checkout' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Resume saved checkout' }).click();
  await expect(page.getByText(/unexpected address/)).toBeVisible();
  expect(purchases).toHaveLength(1);
  expect(purchases[0]).toEqual({});
});

test('subscription cancellation needs deliberate confirmation and preserves the displayed allowance', async ({
  page,
}) => {
  await prepare(page);
  let state = 'active';
  let scheduled = false;
  const calls: Record<string, unknown>[] = [];
  const data = () => ({
    ...summary,
    portalAvailable: true,
    cancellationAvailable: true,
    reconciliationAvailable: true,
    subscriptions: [
      {
        id: 'sub_owned',
        status: state,
        nextBillingAt: '2026-10-21T00:00:00.000Z',
        cancelAtPeriodEnd: scheduled,
      },
    ],
  });
  await page.route('**/api/billing', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(data()),
    }),
  );
  await page.route(
    '**/api/billing/subscriptions/sub_owned/cancel',
    async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      calls.push(body);
      state = body.mode === 'immediate' ? 'cancelled' : 'active';
      scheduled = body.mode === 'period-end';
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(data()),
      });
    },
  );
  await page.goto('/app/billing');
  await page
    .getByRole('button', { name: 'Organizer plans', exact: true })
    .click();
  await chooseMenu(page, 'Plan', 'Starter');
  await page.getByRole('checkbox').check();
  await expect(
    page.getByRole('button', { name: 'Continue to secure checkout' }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Cancel renewal', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Confirm subscription cancellation' }),
  ).toBeVisible();
  expect(calls).toHaveLength(0);
  await page.getByRole('button', { name: 'Keep subscription' }).click();
  expect(calls).toHaveLength(0);
  await page
    .getByRole('button', { name: 'Cancel renewal', exact: true })
    .click();
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(
    page.getByText(/Cancellation confirmed by the provider/),
  ).toBeVisible();
  await expect(page.getByText(/Renewal cancelled; period ends/)).toBeVisible();
  expect(calls[0]).toEqual({ mode: 'period-end', confirmed: true });
  await page.getByRole('button', { name: 'Cancel subscription now' }).click();
  await expect(page.getByText(/This ends the subscription now/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.getByText('cancelled', { exact: true })).toBeVisible();
  await expect(page.getByText('1,018', { exact: true })).toBeVisible();
  expect(calls[1]).toEqual({ mode: 'immediate', confirmed: true });
});

test('payment verification outages remain recoverable and never claim cancellation', async ({
  page,
}) => {
  await prepare(page);
  await page.route('**/api/billing', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ...summary, reconciliationAvailable: true }),
    }),
  );
  let checks = 0;
  await page.route('**/api/billing/reconcile', async (route) => {
    checks++;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          message: 'Payment status could not be verified. Retry later.',
        },
      }),
    });
  });
  await page.goto('/app/billing');
  await page.getByRole('button', { name: 'Check payment status' }).click();
  await expect(
    page.getByText('Payment status could not be verified. Retry later.'),
  ).toBeVisible();
  await expect(page.getByText(/Cancellation confirmed/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Check payment status' }).click();
  await expect.poll(() => checks).toBe(2);
});

test('an account deletion fence disables purchases and links back to account settings', async ({
  page,
}) => {
  await prepare(page);
  await page.route('**/api/billing', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...summary,
        checkoutAvailable: false,
        deletionPending: true,
      }),
    }),
  );
  await page.goto('/app/billing');
  await expect(page.getByText(/Account deletion has started/)).toBeVisible();
  await page.getByRole('checkbox').check();
  await expect(
    page.getByRole('button', { name: 'Continue to secure checkout' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('link', { name: 'Account settings', exact: true }),
  ).toHaveAttribute('href', '/app/settings');
});

test('confirmed payment resolution retires an old request ID for the next intentional purchase', async ({
  page,
}) => {
  await prepare(page);
  await page.route('**/api/billing', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...summary,
        reconciliationAvailable: true,
        pendingCheckouts: [],
      }),
    }),
  );
  await page.route('**/api/billing/reconcile', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...summary,
        reconciliationAvailable: true,
        pendingCheckouts: [],
      }),
    }),
  );
  const attempts: string[] = [];
  await page.route('**/api/billing/checkout', async (route) => {
    attempts.push(
      (route.request().postDataJSON() as { requestId: string }).requestId,
    );
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { message: 'Synthetic lost checkout response.' },
      }),
    });
  });
  await page.goto('/app/billing');
  await page.getByRole('checkbox').check();
  await page
    .getByRole('button', { name: 'Continue to secure checkout' })
    .click();
  await expect(
    page.getByText('Synthetic lost checkout response.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Check payment status' }).click();
  await expect(
    page.getByText('Billing status checked with the provider.'),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Continue to secure checkout' })
    .click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[0]).not.toEqual(attempts[1]);
});

test('billing shows actual returned balances and never treats a checkout return as payment', async ({
  page,
}) => {
  await prepare(page);
  await page.goto('/app/billing?checkout=returned');
  await expect(
    page.getByRole('heading', { name: 'Billing & usage' }),
  ).toBeVisible();
  await expect(page.getByText('1,018', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/This page does not confirm payment/),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Continue to secure checkout' }),
  ).toBeDisabled();
  await page.getByRole('checkbox').check();
  await expect(
    page.getByRole('button', { name: 'Continue to secure checkout' }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Organizer plans', exact: true })
    .click();
  await chooseMenu(page, 'Plan', 'Starter');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByText(/Renews monthly until cancelled/)).toBeVisible();
});
test('unavailable billing is recoverable on mobile without exposing checkout', async ({
  page,
}) => {
  await prepare(page, true);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/app/billing');
  await expect(
    page.getByRole('heading', { name: 'Purchases are not enabled.' }),
  ).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(
    page.getByRole('link', {
      name: 'Compare personal packs and organizer plans',
    }),
  ).toHaveAttribute('href', '/pricing');
  await expect(
    page.getByRole('link', { name: 'Return to your photos' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test('checkout rejects an unexpected redirect and retries the same owned attempt', async ({
  page,
}) => {
  await prepare(page);
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/api/billing/checkout', async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ url: 'https://not-dodo.example.test/' }),
    });
  });
  await page.goto('/app/billing');
  await page.getByRole('checkbox').check();
  await page
    .getByRole('button', { name: 'Continue to secure checkout' })
    .click();
  await expect(page.getByText(/unexpected address/)).toBeVisible();
  await page
    .getByRole('button', { name: 'Continue to secure checkout' })
    .click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toMatchObject({
    plan: 'personal-1000',
    currency: 'INR',
    acceptedTerms: true,
  });
  expect(bodies[0]).not.toHaveProperty('price');
  expect(page.url()).toContain('/app/billing');
});

for (const width of [1280, 390]) {
  test(
    'purchase consent stays readable and keyboard accessible at ' + width,
    async ({ page, browserName }) => {
      await prepare(page);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      await page.goto('/app/billing', { waitUntil: 'domcontentloaded' });
      const consent = page.locator('label.billing-consent');
      const checkbox = consent.getByRole('checkbox');
      const text = consent.locator('span');
      await expect(text).toHaveText(
        'I agree to the terms and the one-time purchase above.',
      );
      await expect(
        consent.getByRole('link', { name: 'terms', exact: true }),
      ).toHaveAttribute('href', '/terms');
      await checkbox.focus();
      await page.keyboard.press('Space');
      await expect(checkbox).toBeChecked();
      await expect(
        page.getByRole('button', { name: 'Continue to secure checkout' }),
      ).toBeEnabled();
      const box = await checkbox.boundingBox();
      const copy = await text.boundingBox();
      expect(box).not.toBeNull();
      expect(copy).not.toBeNull();
      expect(copy!.x).toBeGreaterThanOrEqual(box!.x + box!.width + 8);
      expect(Math.abs(copy!.y - box!.y)).toBeLessThan(8);
      expect(copy!.width).toBeGreaterThan(120);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `artifacts/reports/billing-consent-${width}-${browserName}.png`,
      });
      await page.keyboard.press('Space');
      await expect(checkbox).not.toBeChecked();
      await expect(
        page.getByRole('button', { name: 'Continue to secure checkout' }),
      ).toBeDisabled();
    },
  );
}
