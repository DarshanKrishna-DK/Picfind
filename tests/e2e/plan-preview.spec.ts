import { expect, test, type Page } from '@playwright/test';
import { chooseMenu } from './menu';

async function fixture(
  page: Page,
  mode: 'success' | 'failure' | 'expired' | 'delayed' = 'success',
  roleCatalogAvailable = false,
  savedStatus: string | null = null,
  planChangesAvailable = false,
) {
  let nextBillingAt = new Date(Date.now() + 20 * 86400_000).toISOString();
  const writes: string[] = [];
  const previews: unknown[] = [];
  let release: (() => void) | undefined;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') writes.push(path);
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'fixture-owner',
            name: 'Owner',
            email: 'owner@example.test',
            emailVerified: true,
          },
        },
      });
    if (path.includes('capabilities'))
      return route.fulfill({
        json: {
          storage: true,
          google: true,
          billing: true,
          faceMatching: false,
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: { photos: [], events: [], scans: [], jobs: [] },
      });
    if (path === '/api/billing')
      return route.fulfill({
        json: {
          environment: 'test_mode',
          roleCatalogAvailable,
          planChangesAvailable,
          planChangeCancellationAvailable: planChangesAvailable,
          checkoutAvailable: false,
          portalAvailable: false,
          reconciliationAvailable: false,
          cancellationAvailable: true,
          products: ['creator:INR', 'studio:INR'],
          photosRemaining: 200,
          searchesRemaining: 100,
          deliveryBytesRemaining: 1e9,
          grants: [],
          pendingCheckouts: [],
          deletionPending: false,
          subscriptions: [
            {
              id: 'sub_owned',
              status: 'active',
              nextBillingAt,
              cancelAtPeriodEnd: false,
            },
          ],
        },
      });
    if (path.endsWith('/plan-status'))
      return route.fulfill({
        json: {
          change: savedStatus
            ? {
                quoteId: 'b386741b-7308-477e-9366-f61282fcf2ea',
                plan: 'organizer-pro-monthly',
                status: savedStatus,
                currency: 'INR',
                recurringBeforeTax: 199900,
                effectiveAt: nextBillingAt,
                expiresAt: nextBillingAt,
                expired: false,
              }
            : null,
        },
      });
    if (path.endsWith('/recover-change')) {
      const input = route.request().postDataJSON();
      if (
        input.quoteId !== 'b386741b-7308-477e-9366-f61282fcf2ea' ||
        !['schedule', 'cancel'].includes(input.operation)
      )
        return route.fulfill({
          status: 400,
          json: { error: { message: 'Invalid synthetic recovery input' } },
        });
      savedStatus = input.operation === 'cancel' ? 'cancelled' : 'scheduled';
      return route.fulfill({
        json: { quoteId: input.quoteId, status: savedStatus },
      });
    }
    if (path.endsWith('/discard-quote')) {
      savedStatus = 'discarded';
      return route.fulfill({ json: { status: savedStatus } });
    }
    if (path.endsWith('/plan-preview')) {
      previews.push(route.request().postDataJSON());
      const originalDate = nextBillingAt;
      if (mode === 'delayed')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (mode === 'failure')
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'PLAN_PREVIEW_UNAVAILABLE',
              message:
                'A renewal price preview could not be verified. Your subscription has not changed.',
            },
          },
        });
      return route.fulfill({
        json: {
          subscriptionId: 'sub_owned',
          targetPlan: route.request().postDataJSON().plan,
          currency: 'INR',
          chargeNow: 0,
          recurringBeforeTax: 249900,
          effectiveAt: originalDate,
          expiresAt: new Date(
            Date.now() + (mode === 'expired' ? -1000 : 300_000),
          ).toISOString(),
          previewOnly: true,
        },
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Unconfigured fixture endpoint.' } },
    });
  });
  await page.goto('/app/billing');
  await expect(
    page.getByRole('heading', { name: 'Billing & usage' }),
  ).toBeVisible();
  return {
    writes,
    previews,
    release: () => release?.(),
    changeRenewal: () => {
      nextBillingAt = new Date(Date.now() + 30 * 86400_000).toISOString();
    },
  };
}
for (const width of [1280, 390]) {
  test(`saved plan-change recovery is read-only at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    const f = await fixture(page, 'success', true, 'submitting');
    await expect(
      page.getByText(
        'Plan change awaiting confirmation. Do not submit another change.',
      ),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Refresh plan-change status', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: 'Refresh plan-change status',
        exact: true,
      }),
    ).toBeEnabled();
    await page.reload();
    await expect(
      page.getByText(
        'Plan change awaiting confirmation. Do not submit another change.',
      ),
    ).toBeVisible();
    expect(f.writes).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
for (const state of ['submitting', 'cancelling']) {
  test(`explicit recovery resolves ${state} without resubmitting`, async ({
    page,
  }) => {
    const f = await fixture(page, 'success', true, state);
    await page
      .getByRole('button', { name: 'Check existing attempt', exact: true })
      .click();
    await expect(
      page.getByText(
        state === 'cancelling'
          ? 'Scheduled plan change cancelled. This does not cancel your subscription.'
          : 'Plan change scheduled for your next billing period.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Check existing attempt', exact: true }),
    ).toHaveCount(0);
    expect(f.writes).toEqual([
      '/api/billing/subscriptions/sub_owned/recover-change',
    ]);
  });
}
test('unavailable recovery preserves the saved attempt and permits a later check', async ({
  page,
}) => {
  const f = await fixture(page, 'success', true, 'submitting');
  const recoveries: unknown[] = [];
  await page.route(
    '**/api/billing/subscriptions/sub_owned/recover-change',
    async (route) => {
      recoveries.push(route.request().postDataJSON());
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'PLAN_CHANGE_RECONCILIATION_PENDING',
            message: 'Synthetic provider unavailable',
          },
        },
      });
    },
  );
  const button = page.getByRole('button', {
    name: 'Check existing attempt',
    exact: true,
  });
  await button.click();
  await expect(page.getByRole('alert')).toContainText(
    'Your existing attempt is saved',
  );
  await expect(button).toBeEnabled();
  await expect(
    page.getByText(
      'Plan change awaiting confirmation. Do not submit another change.',
      { exact: true },
    ),
  ).toBeVisible();
  await button.click();
  await expect(button).toBeEnabled();
  expect(recoveries).toEqual([
    { quoteId: 'b386741b-7308-477e-9366-f61282fcf2ea', operation: 'schedule' },
    { quoteId: 'b386741b-7308-477e-9366-f61282fcf2ea', operation: 'schedule' },
  ]);
  expect(f.writes).toEqual([]);
});
for (const width of [1280, 390]) {
  test(`plan confirmation requires explicit consent at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await fixture(page, 'success', true, null, true);
    const confirmations: unknown[] = [];
    const quoteId = 'b386741b-7308-477e-9366-f61282fcf2ea';
    await page.route(
      '**/api/billing/subscriptions/sub_owned/plan-quote',
      (route) =>
        route.fulfill({
          json: {
            quoteId,
            targetPlan: 'organizer-pro-monthly',
            currency: 'INR',
            recurringBeforeTax: 199900,
            chargeNow: 0,
            effectiveAt: new Date(Date.now() + 86400000).toISOString(),
            expiresAt: new Date(Date.now() + 300000).toISOString(),
          },
        }),
    );
    await page.route(
      '**/api/billing/subscriptions/sub_owned/confirm',
      (route) => {
        confirmations.push(route.request().postDataJSON());
        return route.fulfill({ json: { status: 'scheduled' } });
      },
    );
    await page
      .getByRole('button', { name: 'Review plan change', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Confirm renewal plan change',
    });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole('button', {
      name: 'Confirm plan change',
      exact: true,
    });
    await expect(confirm).toBeDisabled();
    expect(confirmations).toEqual([]);
    await dialog.getByRole('checkbox').check();
    await confirm.click();
    await expect(dialog).toContainText('Your plan change is scheduled.');
    expect(confirmations).toEqual([{ quoteId, confirmed: true }]);
    await expect(confirm).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
test('uncertain confirmation cannot be resubmitted from the dialog', async ({
  page,
}) => {
  await fixture(page, 'success', true, null, true);
  const quoteId = 'b386741b-7308-477e-9366-f61282fcf2ea';
  let attempts = 0;
  await page.route(
    '**/api/billing/subscriptions/sub_owned/plan-quote',
    (route) =>
      route.fulfill({
        json: {
          quoteId,
          targetPlan: 'organizer-pro-monthly',
          currency: 'INR',
          recurringBeforeTax: 199900,
          chargeNow: 0,
          effectiveAt: new Date(Date.now() + 86400000).toISOString(),
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        },
      }),
  );
  await page.route(
    '**/api/billing/subscriptions/sub_owned/confirm',
    (route) => {
      attempts++;
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'PLAN_CHANGE_RECONCILIATION_PENDING',
            message: 'Synthetic uncertain result',
          },
        },
      });
    },
  );
  await page
    .getByRole('button', { name: 'Review plan change', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Confirm renewal plan change',
  });
  await dialog.getByRole('checkbox').check();
  await dialog
    .getByRole('button', { name: 'Confirm plan change', exact: true })
    .click();
  await expect(dialog).toContainText('Do not submit another plan change.');
  await expect(
    dialog.getByRole('button', { name: 'Confirm plan change', exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('button', { name: 'Close', exact: true }),
  ).toBeEnabled();
  expect(attempts).toBe(1);
});
test('scheduled cancellation asks for confirmation without cancelling the subscription', async ({
  page,
}) => {
  await fixture(page, 'success', true, 'scheduled', true);
  const requests: unknown[] = [];
  await page.route(
    '**/api/billing/subscriptions/sub_owned/cancel-change',
    (route) => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: 'cancelled' } });
    },
  );
  await page
    .getByRole('button', { name: 'Cancel scheduled change', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Cancel scheduled plan change?',
  });
  await expect(dialog).toContainText('It does not cancel your subscription');
  expect(requests).toEqual([]);
  await dialog
    .getByRole('button', { name: 'Confirm scheduled-change cancellation' })
    .click();
  await expect(dialog).toContainText('Your subscription remains active.');
  expect(requests).toEqual([
    { quoteId: 'b386741b-7308-477e-9366-f61282fcf2ea', confirmed: true },
  ]);
  await expect(
    dialog.getByRole('button', {
      name: 'Confirm scheduled-change cancellation',
    }),
  ).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
test('an approved saved quote can be reviewed without creating a replacement quote', async ({
  page,
}) => {
  const f = await fixture(page, 'success', true, 'approved', true);
  const confirmations: unknown[] = [];
  await page.route(
    '**/api/billing/subscriptions/sub_owned/confirm',
    (route) => {
      confirmations.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: 'scheduled' } });
    },
  );
  await page
    .locator('[aria-label="Saved plan change"]')
    .getByRole('button', { name: 'Review plan change', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Confirm renewal plan change',
  });
  await expect(
    dialog.getByRole('button', { name: 'Confirm plan change', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await dialog
    .getByRole('button', { name: 'Confirm plan change', exact: true })
    .click();
  await expect(dialog).toContainText('Your plan change is scheduled.');
  expect(confirmations).toEqual([
    { quoteId: 'b386741b-7308-477e-9366-f61282fcf2ea', confirmed: true },
  ]);
  expect(f.writes).toEqual([]);
});
test('an unsubmitted approval can be discarded without provider mutations', async ({
  page,
}) => {
  const f = await fixture(page, 'success', true, 'approved');
  await page
    .getByRole('button', { name: 'Discard unsubmitted quote', exact: true })
    .click();
  await expect(
    page.getByText(
      'Unsubmitted quote discarded. Your subscription is unchanged.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Discard unsubmitted quote',
      exact: true,
    }),
  ).toHaveCount(0);
  expect(f.writes).toEqual([
    '/api/billing/subscriptions/sub_owned/discard-quote',
  ]);
});
test('shows a provider price with zero due today and no plan mutation controls', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByRole('button', { name: 'Preview renewal price' }).click();
  await expect(
    page.getByText('Preview only. No plan change made.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Studio:.*per month before tax/)).toBeVisible();
  await expect(page.getByText(/Due today:/)).toContainText('0.00');
  expect(f.previews).toEqual([{ plan: 'studio' }]);
  expect(f.writes).toEqual([
    '/api/billing/subscriptions/sub_owned/plan-preview',
  ]);
  await expect(
    page.getByRole('button', { name: /confirm.*change/i }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test('changing the selected plan clears the previous estimate', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByRole('button', { name: 'Preview renewal price' }).click();
  await expect(
    page.getByText('Preview only. No plan change made.', { exact: true }),
  ).toBeVisible();
  await chooseMenu(page, 'Plan to preview', 'Creator (legacy)');
  await expect(page.getByText(/Due today:/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview renewal price' }).click();
  await expect(page.getByText(/Creator:.*per month before tax/)).toBeVisible();
  expect(f.previews).toHaveLength(2);
});
test('provider failure leaves the existing subscription intact', async ({
  page,
}) => {
  const f = await fixture(page, 'failure');
  await page.getByRole('button', { name: 'Preview renewal price' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Your subscription has not changed',
  );
  await expect(
    page.getByRole('button', { name: 'Cancel renewal', exact: true }),
  ).toBeVisible();
  expect(f.writes).toEqual([
    '/api/billing/subscriptions/sub_owned/plan-preview',
  ]);
});
test('expired preview hides old price and asks for a fresh estimate', async ({
  page,
}) => {
  await fixture(page, 'expired');
  await page.getByRole('button', { name: 'Preview renewal price' }).click();
  await expect(
    page.getByText('Preview expired', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Due today:/)).toHaveCount(0);
});
test('ignores a late preview after the subscription refresh changes renewal', async ({
  page,
}) => {
  const f = await fixture(page, 'delayed');
  await page.getByRole('button', { name: 'Preview renewal price' }).click();
  await expect.poll(() => f.previews.length).toBe(1);
  f.changeRenewal();
  await page
    .getByRole('button', { name: 'Refresh balance', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Refresh balance', exact: true }),
  ).toBeEnabled();
  f.release();
  await expect(
    page.getByRole('button', { name: 'Preview renewal price' }),
  ).toBeEnabled();
  await expect(page.getByText(/Due today:/)).toHaveCount(0);
});

for (const width of [1280, 390]) {
  test(
    'organizer monthly/yearly preview is read-only at ' + width,
    async ({ page, browserName }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      const f = await fixture(page, 'success', true);
      await page.getByRole('button', { name: 'Plan to preview', exact: true }).click();
      await expect(page.getByRole('option', { name: /Yearly/ })).toHaveCount(3);
      await expect(page.getByRole('option', { name: /Personal/ })).toHaveCount(0);
      await page.getByRole('option', { name: 'Pro - Yearly', exact: true }).click();
      await page.getByRole('button', { name: 'Preview renewal price' }).click();
      await expect(page.getByText(/Pro:.*per year\s+before tax/)).toBeVisible();
      await expect(page.getByText(/Due today:/)).toContainText('0.00');
      await expect(
        page.getByText(/Personal photo packs do not add event/),
      ).toBeVisible();
      await chooseMenu(page, 'Plan to preview', 'Scale - Monthly');
      await expect(page.getByText(/Due today:/)).toHaveCount(0);
      await page.getByRole('button', { name: 'Preview renewal price' }).click();
      await expect(
        page.getByText(/Scale:.*per month\s+before tax/),
      ).toBeVisible();
      expect(f.previews).toEqual([
        { plan: 'organizer-pro-yearly' },
        { plan: 'organizer-scale-monthly' },
      ]);
      expect(f.writes.every((path) => path.endsWith('/plan-preview'))).toBe(
        true,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page
        .getByRole('heading', { name: 'Preview another subscription plan' })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `artifacts/reports/organizer-preview-${width}-${browserName}.png`,
      });
    },
  );
}
