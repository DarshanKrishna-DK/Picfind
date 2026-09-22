import { expect, test } from '@playwright/test';
import { anonymousApi } from './anonymous';

test('persistent cloud connection explains storage, disconnect and reconnect', async ({
  page,
}) => {
  let connected = true,
    reconnectRequired = false;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'synthetic-owner',
            name: 'Synthetic owner',
            email: 'owner@example.test',
            emailVerified: true,
          },
        },
      });
    if (path.includes('capabilities'))
      return route.fulfill({
        json: {
          storage: true,
          faceMatching: false,
          billing: false,
          drive: false,
          driveOAuth: false,
          photoLimit: 20,
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: { events: [], photos: [], scans: [], jobs: [], photoLimit: 20 },
      });
    if (path === '/api/sources')
      return route.fulfill({
        json: {
          sources: [
            {
              id: 'dropbox',
              configured: true,
              connected,
              reconnectRequired,
              persistent: true,
            },
            {
              id: 'onedrive',
              configured: false,
              connected: false,
              persistent: true,
            },
            {
              id: 'box',
              configured: false,
              connected: false,
              persistent: true,
            },
          ],
        },
      });
    if (
      path === '/api/sources/dropbox' &&
      route.request().method() === 'DELETE'
    ) {
      connected = false;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Synthetic endpoint not found.' } },
    });
  });
  await page.goto('/app/import');
  await expect(
    page.getByText(
      'Your connection is encrypted on the server until you disconnect it or delete your account.',
      { exact: false },
    ),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Disconnect Dropbox', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Connect Dropbox', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Browse photos', exact: true }),
  ).toHaveCount(0);
  reconnectRequired = true;
  await page.reload();
  await expect(
    page.getByText(
      'Reconnect Dropbox to restore access. Your imported photos are still in your library.',
    ),
  ).toBeVisible();
});
test('privacy and terms describe grants and actual deployment allowances', async ({
  page,
}) => {
  await anonymousApi(page);
  await page.goto('/privacy');
  await expect(
    page.getByRole('heading', { name: 'Cloud connections' }),
  ).toBeVisible();
  await expect(
    page.getByText('account deletion removes connection records.', {
      exact: false,
    }),
  ).toBeVisible();
  await page.goto('/terms');
  await expect(
    page.getByText(
      'Your Studio shows the photo, processing and storage allowances',
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByText('The current library is capped at 20 photographs.', {
      exact: false,
    }),
  ).toHaveCount(0);
});
