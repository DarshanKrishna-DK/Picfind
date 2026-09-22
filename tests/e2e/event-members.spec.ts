import { expect, test, type Page } from '@playwright/test';
const eventId = 'c6b83638-a740-4a48-bdfc-6960a3b512aa';
async function fixture(page: Page, role: 'owner' | 'moderator') {
  const members: object[] = [];
  const event = {
    id: eventId,
    title: 'An evening together',
    description: 'A private event collection.',
    visibility: 'private',
    archived: false,
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    accessRole: role,
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: role,
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
    if (path.includes('capabilities'))
      return route.fulfill({
        json: {
          storage: true,
          billing: false,
          cloudImports: false,
          faceMatching: false,
        },
      });
    if (path === '/api/billing') return route.fulfill({ json: {} });
    if (path.endsWith('/gallery'))
      return route.fulfill({
        json: { event, photos: [], remainingUploads: 12 },
      });
    if (path.endsWith('/members')) {
      if (route.request().method() === 'POST')
        members.push({
          userId: 'morgan',
          name: 'Morgan',
          email: 'morgan@example.test',
          role: 'moderator',
          grantId: 'synthetic-grant',
        });
      return route.fulfill({ json: { members } });
    }
    if (path.endsWith('/members/morgan')) {
      members.splice(0);
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith('/insights'))
      return route.fulfill({
        json: {
          photos: 0,
          indexed: 0,
          storageBytes: 0,
          submissions: 0,
          selections: [],
          hasPasscode: false,
        },
      });
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Synthetic endpoint unavailable.' } },
    });
  });
}
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`owner manages moderators at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await fixture(page, 'owner');
    await page.goto(`/app/events/${eventId}`);
    await page.getByRole('tab', { name: 'Members', exact: true }).click();
    await page.getByLabel('Moderator email').fill('morgan@example.test');
    await page
      .getByRole('button', { name: 'Add moderator', exact: true })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Moderator added.' }),
    ).toBeVisible();
    await expect(page.locator('.member-list')).toContainText(
      'morgan@example.test',
    );
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Remove Morgan' }).click();
    await expect(page.getByText('No moderators yet.')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  test(`moderator sees only event contribution controls at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await fixture(page, 'moderator');
    await page.goto(`/app/events/${eventId}`);
    await expect(
      page.getByRole('heading', { name: 'An evening together' }),
    ).toBeVisible();
    await expect(page.getByText('12 spaces remaining.')).toBeVisible();
    await expect(
      page.locator('button').filter({ hasText: /^Choose photos$/ }),
    ).toBeEnabled();
    await expect(
      page.getByLabel('Choose photos', { exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole('tab', { name: 'Settings' })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Delete event' }),
    ).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Members' })).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/reports/moderator-${viewport.width}-${test.info().project.name}.png`,
    });
  });
}
