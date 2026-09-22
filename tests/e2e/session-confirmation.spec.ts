import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, failFirst = false) {
  let mutations = 0;
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'session-test',
            name: 'Test Person',
            email: 'person@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: { photos: [], events: [], jobs: [], photoLimit: 20 },
      });
    if (path === '/api/account/capabilities')
      return route.fulfill({
        json: {
          google: true,
          verification: true,
          deletion: true,
          recovery: true,
        },
      });
    if (path === '/api/account/sessions/others') {
      expect(route.request().method()).toBe('DELETE');
      mutations++;
      return failFirst && mutations === 1
        ? route.fulfill({
            status: 503,
            json: {
              error: {
                message: 'Could not reach the account service. Please retry.',
              },
            },
          })
        : route.fulfill({ status: 204 });
    }
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'BILLING_DISABLED',
          message: 'Synthetic test: billing disabled.',
        },
      },
    });
  });
  return () => mutations;
}

for (const width of [1280, 390]) {
  test(`other-device sign-out requires confirmation and fits ${width}px`, async ({
    page,
  }) => {
    const mutations = await fixture(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.goto('/app/settings');
    const trigger = page.getByRole('button', {
      name: 'Sign out other sessions',
      exact: true,
    });
    await trigger.click();
    const dialog = page.getByRole('dialog', {
      name: 'Sign out other devices?',
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/This device stays signed in/)).toBeVisible();
    expect(mutations()).toBe(0);
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(mutations()).toBe(0);
    await trigger.click();
    await dialog
      .getByRole('button', { name: 'Confirm sign out other devices' })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'This device is still signed in.' }),
    ).toBeVisible();
    expect(mutations()).toBe(1);
    await expect(trigger).toBeFocused();
    await expect(page).toHaveURL(/\/app\/settings$/);
  });
}

test('failed session revocation stays in the dialog and can be retried explicitly', async ({
  page,
}) => {
  const mutations = await fixture(page, true);
  await page.goto('/app/settings');
  await page
    .getByRole('button', { name: 'Sign out other sessions', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Sign out other devices?' });
  const confirm = dialog.getByRole('button', {
    name: 'Confirm sign out other devices',
  });
  await confirm.click();
  await expect(
    dialog.getByText('Could not reach the account service. Please retry.'),
  ).toBeVisible();
  expect(mutations()).toBe(1);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  expect(mutations()).toBe(2);
});
