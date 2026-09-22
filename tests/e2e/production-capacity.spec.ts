import { expect, test } from '@playwright/test';
import sharp from 'sharp';

test('metered Studio capacity and uploads are not capped at twenty photos', async ({
  page,
}) => {
  const jpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#246b54' },
  })
    .jpeg()
    .toBuffer();
  const photos = Array.from({ length: 21 }, (_, index) => ({
    id: `existing-${index}`,
    filename: `Existing-${index}.jpg`,
    bytes: jpeg.length,
    width: 8,
    height: 8,
    createdAt: '2026-09-21T00:00:00Z',
  }));
  let uploads = 0;
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
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
    if (path === '/api/capabilities' || path === '/api/auth/capabilities')
      return route.fulfill({
        json: {
          storage: true,
          photoLimit: 25000,
          faceIndexMax: 20,
          eventIndexMax: 10000,
          faceMatching: false,
          billing: false,
          maxUploadBytes: 8 * 1024 * 1024,
          capacityMode: 'metered',
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: {
          photos,
          events: [],
          jobs: [],
          scans: [],
          photoLimit: 25000,
          storedPhotoCount: photos.length + 24,
          capacityMode: 'metered',
        },
      });
    if (path === '/api/photos' && req.method() === 'POST') {
      const photo = {
        id: `uploaded-${++uploads}`,
        filename: decodeURIComponent(
          req.headers()['x-file-name'] ?? 'photo.jpg',
        ),
        bytes: jpeg.length,
        width: 8,
        height: 8,
        createdAt: new Date().toISOString(),
      };
      photos.push(photo);
      return route.fulfill({ status: 201, json: { photo } });
    }
    if (path.endsWith('/file'))
      return route.fulfill({ contentType: 'image/jpeg', body: jpeg });
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Unused synthetic endpoint.' } },
    });
  });
  await page.goto('/app/library');
  const menu = page.getByRole('button', { name: 'Toggle studio navigation' });
  await expect(page.locator('.usage')).toBeAttached();
  if (await menu.isVisible()) await menu.click();
  await expect(
    page.getByText('45 photos in your account', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Usage unavailable. Open Billing to retry.', {
      exact: true,
    }),
  ).toBeVisible();
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Add photos', exact: true }).click();
  await page.getByLabel('Choose photos', { exact: true }).setInputFiles(
    Array.from({ length: 21 }, (_, index) => ({
      name: `New-${index}.jpg`,
      mimeType: 'image/jpeg',
      buffer: jpeg,
    })),
  );
  await expect.poll(() => uploads).toBe(21);
  if (await menu.isVisible()) await menu.click();
  await expect(
    page.getByText('66 photos in your account', { exact: true }),
  ).toBeVisible();
  await page.goto('/app');
  await expect(
    page.getByText('Storage and processing follow your allowance', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('photo preview capacity', { exact: false }),
  ).toHaveCount(0);
});
