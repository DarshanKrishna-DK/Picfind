import { expect, test } from '@playwright/test';

for (const width of [1280, 390]) {
  test(`disabled billing explains availability without a false purchase CTA at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/auth/session')
        return route.fulfill({
          json: {
            user: {
              id: 'test-owner',
              name: 'Test Owner',
              email: 'owner@example.test',
              emailVerified: true,
            },
          },
        });
      if (path === '/api/library')
        return route.fulfill({
          json: { photos: [], events: [], scans: [], jobs: [], photoLimit: 20 },
        });
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'BILLING_DISABLED',
            message: 'Billing is not configured. No payment can be started.',
          },
        },
      });
    });
    await page.goto('/app/billing');
    await expect(
      page.getByRole('heading', { name: 'Purchases are not enabled.' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', {
        name: 'Compare personal packs and organizer plans',
      }),
    ).toHaveAttribute('href', '/pricing');
    if (width === 390)
      await page
        .getByRole('button', { name: 'Toggle studio navigation' })
        .click();
    await expect(
      page.getByText('Purchases not enabled', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'View pricing', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Usage unavailable. Open Billing to retry.'),
    ).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Upgrade / buy a pack' }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

for (const destination of [
  '/app/import?eventId=ad851772-ef2a-46a2-8f66-066975c7b0aa',
  '/app/billing?context=organizer',
]) {
  test(`signed-out studio preserves allowlisted context for Google sign-in: ${destination}`, async ({
    page,
  }) => {
    let returned: unknown;
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.includes('capabilities'))
        return route.fulfill({ json: { google: true } });
      if (path === '/api/account/google') {
        returned = route.request().postDataJSON().returnTo;
        return route.fulfill({
          status: 503,
          json: {
            error: {
              message: 'Synthetic OAuth boundary: no provider request.',
            },
          },
        });
      }
      return route.fulfill({
        status: 401,
        json: { error: { message: 'Sign in to continue.' } },
      });
    });
    await page.goto(destination);
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.getByRole('button', { name: 'Continue with Google' }).click();
    await expect(
      page.getByText('Synthetic OAuth boundary: no provider request.'),
    ).toBeVisible();
    expect(returned).toBe(destination);
  });
}
