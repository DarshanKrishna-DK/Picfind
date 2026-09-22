import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

async function fixture(page: Page) {
  const jpeg = await sharp({
    create: { width: 32, height: 24, channels: 3, background: '#40745d' },
  })
    .jpeg()
    .toBuffer();
  const state = {
    unlocked: false,
    imports: 0,
    scans: 0,
    searches: 0,
    selections: 0,
  };
  const photo = {
    id: 'p1',
    filename: 'Cloud photo.jpg',
    createdAt: '2026-09-20T00:00:00Z',
    width: 32,
    height: 24,
    bytes: jpeg.length,
  };
  const event = {
    id: 'event1',
    title: 'Test celebration',
    description: 'A fixture gallery',
    date: '2026-09-20',
    visibility: 'link',
    archived: false,
    createdAt: '2026-09-20T00:00:00Z',
    expiresAt: '',
  };
  const scan = {
    id: 'scan1',
    state: 'complete',
    imported: 1,
    indexed: 1,
    errors: [],
    createdAt: '2026-09-20T00:00:00Z',
    matches: [],
  };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'owner',
            name: 'Test owner',
            email: 'owner@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/capabilities' || path === '/api/auth/capabilities')
      return route.fulfill({
        json: {
          storage: true,
          drive: false,
          driveOAuth: false,
          driveConnected: false,
          photoLimit: 20,
          faceIndexMax: 20,
          faceMatching: true,
          billing: false,
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: {
          photos: [photo],
          events: [],
          jobs: [],
          scans: [],
          photoLimit: 20,
        },
      });
    if (path === '/api/sources')
      return route.fulfill({
        json: {
          sources: [
            { id: 'dropbox', configured: true, connected: true },
            { id: 'onedrive', configured: false, connected: false },
            { id: 'box', configured: false, connected: false },
          ],
        },
      });
    if (path === '/api/sources/dropbox/items')
      return route.fulfill({
        json: {
          items: [
            {
              id: 'cloud1',
              name: 'Cloud photo.jpg',
              folder: false,
              bytes: jpeg.length,
            },
          ],
          cursor: null,
        },
      });
    if (path === '/api/imports/source') {
      expect(req.postDataJSON()).toEqual({
        provider: 'dropbox',
        ids: ['cloud1'],
      });
      state.imports++;
      return route.fulfill({
        status: 201,
        json: {
          job: { id: 'job1', state: 'complete', imported: 1, errors: [] },
        },
      });
    }
    if (path === '/api/discover/scans') {
      expect(req.postDataJSON()).toEqual({
        photoIds: ['p1'],
        consent: true,
        policyVersion: 'face-matching-v1',
      });
      state.scans++;
      return route.fulfill({ status: 201, json: { scan } });
    }
    if (path === '/api/discover/scans/scan1/search') {
      state.searches++;
      return route.fulfill({
        json: {
          scan,
          matches: [
            { photoId: 'p1', filename: photo.filename, similarity: 95 },
          ],
        },
      });
    }
    if (path === '/api/public/events/event1/unlock') {
      state.unlocked = req.postDataJSON().passcode === 'secret123';
      return route.fulfill({
        status: state.unlocked ? 204 : 403,
        ...(state.unlocked
          ? {}
          : {
              json: {
                error: {
                  message: 'That passcode did not unlock this gallery.',
                },
              },
            }),
      });
    }
    if (path.startsWith('/api/public/events/event1') && !state.unlocked)
      return route.fulfill({
        status: 401,
        json: {
          error: {
            code: 'GALLERY_LOCKED',
            message: 'Enter the organizer passcode.',
          },
        },
      });
    if (path === '/api/public/events/event1/access')
      return route.fulfill({
        json: { brandingName: 'Test Studio', accentColor: '#173f37' },
      });
    if (path === '/api/public/events/event1')
      return route.fulfill({ json: { event, photos: [photo] } });
    if (path === '/api/public/events/event1/selections') {
      expect(req.postDataJSON()).toEqual({
        name: 'Guest',
        note: 'Please use this one',
        photoIds: ['p1'],
      });
      state.selections++;
      return route.fulfill({
        status: 201,
        json: { message: 'Your selection was sent to the organizer.' },
      });
    }
    if (path.endsWith('/file') || path.includes('/photos/p1'))
      return route.fulfill({ contentType: 'image/jpeg', body: jpeg });
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Fixture endpoint not found.' } },
    });
  });
  return { state, jpeg };
}
test('landing no longer promotes competitor alternatives', async ({ page }) => {
  await fixture(page);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: /find your fit/i }),
  ).toHaveCount(0);
  if (await page.getByRole('button', { name: 'Toggle navigation' }).isVisible())
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await expect(
    page.getByRole('link', { name: 'Pricing', exact: true }),
  ).toBeVisible();
});
test('pricing switches currency and estimates packs without offering checkout', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/pricing');
  await expect(
    page.getByRole('heading', { name: '1,000-photo pack', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Photos to process').fill('1001');
  await expect(page.getByRole('status')).toContainText('398');
  await page
    .getByLabel('Display currency', { exact: true })
    .selectOption('USD');
  await expect(page.getByRole('status')).toContainText('$5');
  await page.getByLabel('Photos to process').fill('2500');
  await page
    .getByRole('button', { name: 'Organizer plans', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Starter');
  await expect(
    page.getByRole('link', { name: 'Try your own collection' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /checkout|buy|subscribe/i }),
  ).toHaveCount(0);
});
test('Dropbox selection imports to the library and unconfigured sources stay disabled', async ({
  page,
}) => {
  const { state } = await fixture(page);
  await page.goto('/app/import');
  await page
    .getByRole('button', { name: 'Browse photos', exact: true })
    .click();
  await page.getByLabel('Cloud photo.jpg', { exact: false }).check();
  await page
    .getByRole('button', { name: 'Import 1 selected', exact: true })
    .click();
  await expect(
    page.getByText('1 photos imported. Status: complete.'),
  ).toBeVisible();
  expect(state.imports).toBe(1);
  await page.getByRole('button', { name: 'OneDrive', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Connect OneDrive', exact: true }),
  ).toBeDisabled();
});
test('Discover searches library photos and reuses the collection on repeat searches', async ({
  page,
}) => {
  const { state, jpeg } = await fixture(page);
  await page.goto('/app/discover/new');
  await page
    .getByRole('button', { name: 'Library photos', exact: true })
    .click();
  await page.getByLabel('Cloud photo.jpg', { exact: true }).check();
  await page.getByLabel('Reference selfie').setInputFiles({
    name: 'fixture.jpg',
    mimeType: 'image/jpeg',
    buffer: jpeg,
  });
  await page
    .getByRole('checkbox', { name: /I understand Amazon Rekognition/ })
    .check();
  await page
    .getByRole('button', { name: 'Find my photos', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Your likely matches' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Search again', exact: true }).click();
  await expect.poll(() => state.searches).toBe(2);
  expect(state.scans).toBe(1);
});
test('signed-in guests unlock a gallery and send a selection without purchasing', async ({
  page,
}) => {
  const { state } = await fixture(page);
  await page.goto('/e/event1');
  await expect(
    page.getByRole('heading', { name: 'This gallery has a passcode.' }),
  ).toBeVisible();
  await page.getByLabel('Gallery passcode').fill('wrong');
  await page.getByRole('button', { name: 'Unlock gallery' }).click();
  await expect(
    page.getByText('That passcode did not unlock this gallery.'),
  ).toBeVisible();
  await page.getByLabel('Gallery passcode').fill('secret123');
  await page.getByRole('button', { name: 'Unlock gallery' }).click();
  await expect(
    page.getByRole('heading', { name: 'Test celebration' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Choose favorites for organizer' })
    .click();
  await page.getByLabel('Cloud photo.jpg', { exact: true }).check();
  await page.getByLabel('Your name', { exact: true }).fill('Guest');
  await page.getByLabel('Note for the organizer').fill('Please use this one');
  await page.getByRole('button', { name: 'Send 1 favorites' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Your selection was sent' }),
  ).toBeVisible();
  expect(state.selections).toBe(1);
});
