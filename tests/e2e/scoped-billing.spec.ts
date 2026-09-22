import { expect, test, type Page } from '@playwright/test';
const eventId = 'c6b83638-a740-4a48-bdfc-6960a3b512aa';
async function fixture(page: Page, moderator = false) {
  const expiresAt = new Date(Date.now() + 365 * 86400000).toISOString();
  const createdAt = new Date(Date.now() - 86400000).toISOString();
  const base = {
    held: false,
    refundFraction: 0,
    createdAt,
    expiresAt,
    usedPhotos: 0,
    photosRemaining: 0,
  };
  const event = {
    id: eventId,
    title: 'Scoped event',
    accessRole: moderator ? 'moderator' : 'owner',
    visibility: 'private',
    expiresAt,
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'user',
            name: 'Morgan',
            email: 'morgan@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: {
          events: [event],
          photos: [],
          jobs: [],
          scans: [],
          photoLimit: 20,
        },
      });
    if (path === '/api/billing')
      return route.fulfill({
        json: {
          environment: 'test_mode',
          roleCatalogAvailable: true,
          checkoutAvailable: false,
          products: [],
          portalAvailable: false,
          subscriptions: [],
          photosRemaining: 9700,
          searchesRemaining: 1500,
          deliveryBytesRemaining: 10e9,
          balances: {
            personal: {
              photosRemaining: 700,
              searchesRemaining: 400,
              deliveryBytesRemaining: 1e9,
              storageBytesLimit: 2e9,
            },
            organizer: {
              photosRemaining: 9000,
              searchesRemaining: 1100,
              deliveryBytesRemaining: 9e9,
              storageBytesLimit: 50e9,
            },
          },
          storageBytesUsedByScope: { personal: 1e9, organizer: 3e9, legacy: 0 },
          grants: [
            {
              ...base,
              id: 'pack',
              plan: 'personal-1000',
              scope: 'personal',
              usedPhotos: 300,
              photosRemaining: 700,
            },
            {
              ...base,
              id: 'root',
              plan: 'organizer-pro-yearly',
              scope: 'organizer',
              entitlementMonths: 12,
              usedPhotos: 99000,
            },
            {
              ...base,
              id: 'window',
              plan: 'organizer-pro-yearly',
              scope: 'organizer',
              parentGrantId: 'root',
              usedPhotos: 1000,
              photosRemaining: 9000,
              expiresAt: new Date(Date.now() + 20 * 86400000).toISOString(),
            },
          ],
        },
      });
    if (path === '/api/capabilities')
      return route.fulfill({
        json: { storage: true, billing: false, cloudImports: false },
      });
    if (path.endsWith('/gallery'))
      return route.fulfill({
        json: { event, photos: [], remainingUploads: 12 },
      });
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Synthetic endpoint unavailable' } },
    });
  });
}
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`scoped billing and Studio never combine monthly and personal credits at ${viewport.width}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    await fixture(page);
    await page.goto('/app/billing');
    const allowance = page.getByRole('region', { name: 'Current allowance' });
    await expect(allowance).toContainText('700');
    await expect(allowance).not.toContainText('9,700');
    await page
      .getByRole('button', { name: 'Organizer plans', exact: true })
      .click();
    await expect(allowance).toContainText('9,000');
    await expect(allowance).toContainText(
      'Future monthly allowances are not available to spend now.',
    );
    await expect(
      page.getByText(
        'Paid hosting entitlement; monthly credits are listed separately.',
      ),
    ).toBeVisible();
    await page.goto('/app/events');
    const toggle = page.getByRole('button', {
      name: 'Toggle studio navigation',
    });
    if (await toggle.isVisible()) await toggle.click();
    await expect(page.locator('.usage')).toContainText(
      '9,000 photo attempts left',
    );
    await expect(page.locator('.usage')).toContainText('1,000 processed');
    await expect(page.locator('.sidebar-upgrade')).toHaveAttribute(
      'href',
      '/app/billing?context=organizer',
    );
    if (await toggle.isVisible()) await toggle.click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (viewport.width === 1280)
      await expect(
        page.getByText('Scoped event', { exact: true }),
      ).toBeInViewport();
    await page.screenshot({
      path: `artifacts/reports/scoped-studio-${viewport.width}-${test.info().project.name}.png`,
      scale: 'css',
      animations: 'disabled',
    });
  });
  test(`moderator is not shown personal credits as event funding at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await fixture(page, true);
    await page.goto(`/app/events/${eventId}`);
    await expect(
      page.getByRole('heading', { name: 'Scoped event' }),
    ).toBeVisible();
    const toggle = page.getByRole('button', {
      name: 'Toggle studio navigation',
    });
    if (await toggle.isVisible()) await toggle.click();
    await expect(page.locator('.usage')).toContainText(
      'Organizer-covered event',
    );
    await expect(page.locator('.usage progress')).toHaveCount(0);
    await expect(page.locator('.sidebar-upgrade')).toHaveCount(0);
  });
}
