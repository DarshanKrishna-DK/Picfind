import { test, expect } from '@playwright/test';

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  for (const kind of ['password', 'delete'] as const) {
    test(`account ${kind} dialog is deliberate and contained at ${viewport.width}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      let codes = 0;
      let mutations = 0;
      await page.route('**/api/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/auth/session')
          return route.fulfill({
            json: {
              user: {
                id: 'dialog-test',
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
              recovery: true,
              verification: true,
              deletion: true,
            },
          });
        if (path === '/api/account/confirmation') {
          codes++;
          return route.fulfill({ status: 202, json: {} });
        }
        if (path === '/api/account/password') {
          mutations++;
          expect(route.request().postDataJSON()).toEqual({
            oldPassword: 'old-password',
            password: 'new-password',
            emailCode: '123456',
          });
          return route.fulfill({ status: 204 });
        }
        return route.fulfill({
          status: 503,
          json: { error: { message: 'Test fixture: service not configured.' } },
        });
      });
      await page.goto('/app/settings');
      await expect(
        page.getByLabel('Current password', { exact: true }),
      ).toHaveCount(0);
      await expect(page.getByLabel('Type DELETE to confirm')).toHaveCount(0);
      const dialog = page.getByRole('dialog');
      if (kind === 'delete') {
        const remove = page.getByRole('button', {
          name: 'Delete account',
          exact: true,
        });
        await remove.click();
        await expect(dialog.getByLabel('Type DELETE to confirm')).toBeVisible();
        await expect(
          dialog.getByLabel('Current password to delete account'),
        ).toBeVisible();
        await expect(
          dialog.getByLabel('Email confirmation code'),
        ).toBeVisible();
        await expect(
          dialog.getByRole('link', { name: 'Set a password by email first' }),
        ).toHaveAttribute('href', '/forgot-password');
        expect(codes).toBe(0);
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(remove).toBeFocused();
        expect(mutations).toBe(0);
        return;
      }
      const change = page.getByRole('button', {
        name: 'Change password',
        exact: true,
      });
      await change.click();
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole('link', {
          name: 'Set or recover your password by email',
        }),
      ).toHaveAttribute('href', '/forgot-password');
      expect(codes).toBe(0);
      await dialog.getByRole('button', { name: 'Send email code' }).click();
      await expect(dialog.getByRole('status')).toContainText('Code sent');
      expect(codes).toBe(1);
      await expect(
        dialog.getByRole('button', { name: 'Code sent - check your email' }),
      ).toBeDisabled();
      await expect(dialog.getByLabel('Email confirmation code')).toBeEnabled();
      await dialog
        .getByLabel('Current password', { exact: true })
        .fill('old-password');
      await dialog
        .getByLabel('New password', { exact: true })
        .fill('new-password');
      await dialog.getByLabel('Confirm new password').fill('new-password');
      await dialog
        .getByRole('button', { name: 'Change password', exact: true })
        .click();
      expect(mutations).toBe(0);
      await dialog.getByLabel('Email confirmation code').fill('123456');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(
        await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: `artifacts/reports/account-dialog-${viewport.width}-${testInfo.project.name}.png`,
      });
      await dialog
        .getByRole('button', { name: 'Change password', exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      expect(mutations).toBe(1);
      await expect(change).toBeFocused();
      await expect(
        page.getByRole('button', { name: 'Delete account', exact: true }),
      ).toBeEnabled();
      expect(mutations).toBe(1);
    });
  }
}
