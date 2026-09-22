import { test, expect } from '@playwright/test';

test('recovery uses the account API and displays its privacy-safe result', async ({
  page,
}) => {
  let email = '';
  await page.route('**/api/account/recovery', async (route) => {
    email = (route.request().postDataJSON() as { email: string }).email;
    await route.fulfill({ status: 202, json: { message: 'Accepted' } });
  });
  await page.goto('/forgot-password');
  await page.getByLabel('Email address').fill('person@example.test');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText(
    'If that address has an account',
  );
  expect(email).toBe('person@example.test');
});

test('reset removes the token from the URL and submits it only with the password', async ({
  page,
}) => {
  let submitted: unknown;
  await page.route('**/api/account/reset-password', async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 204 });
  });
  await page.goto('/reset-password?userId=example-user&secret=test-only-token');
  await expect(page).toHaveURL(/\/reset-password$/);
  await page
    .getByLabel('New password', { exact: true })
    .fill('new-test-password');
  await page.getByLabel('Confirm new password').fill('new-test-password');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByRole('status')).toContainText('Password updated');
  expect(submitted).toEqual({
    userId: 'example-user',
    secret: 'test-only-token',
    password: 'new-test-password',
  });
});

test('verification requires a deliberate confirmation', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/account/verify-email', async (route) => {
    calls++;
    await route.fulfill({ status: 204 });
  });
  await page.goto('/verify-email?userId=example-user&secret=test-only-token');
  await expect(page).toHaveURL(/\/verify-email$/);
  expect(calls).toBe(0);
  await page.getByRole('button', { name: 'Verify email address' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Your email address is verified',
  );
  expect(calls).toBe(1);
});

test('an incomplete recovery link cannot submit a password', async ({
  page,
}) => {
  await page.goto('/reset-password');
  await expect(page.getByRole('alert')).toContainText(
    'This link is incomplete',
  );
  await expect(
    page.getByRole('button', { name: 'Reset password' }),
  ).toHaveCount(0);
});

test('settings saves real API responses and requires explicit account deletion', async ({
  page,
}) => {
  let user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
  } | null = {
    id: 'test-account',
    name: 'Test Person',
    email: 'person@example.test',
    emailVerified: false,
  };
  let removed = false;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session')
      return route.fulfill(
        user
          ? { json: { user } }
          : { status: 401, json: { error: { message: 'Sign in.' } } },
      );
    if (path === '/api/library')
      return route.fulfill({
        json: { photos: [], events: [], jobs: [], photoLimit: 20 },
      });
    if (path === '/api/account/capabilities')
      return route.fulfill({
        json: {
          google: false,
          recovery: true,
          verification: true,
          deletion: true,
        },
      });
    if (path === '/api/account/profile') {
      user = { ...user!, name: String(route.request().postDataJSON().name) };
      return route.fulfill({ json: { user } });
    }
    if (path === '/api/account' && route.request().method() === 'DELETE') {
      expect(route.request().postDataJSON()).toEqual({
        password: 'test-password',
        confirmation: 'DELETE',
        emailCode: '123456',
      });
      user = null;
      removed = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Unexpected test request.' } },
    });
  });
  await page.goto('/app/settings');
  await page.getByLabel('Your name', { exact: true }).fill('Updated Person');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Your name has been updated',
  );
  expect(user?.name).toBe('Updated Person');
  await expect(
    page.getByLabel('Current password to delete account'),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Delete account', exact: true })
    .click();
  await page.getByLabel('Email confirmation code').fill('123456');
  await page
    .getByLabel('Current password to delete account')
    .fill('test-password');
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await page
    .getByRole('button', { name: 'Permanently delete account' })
    .click();
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(removed).toBe(true);
});
