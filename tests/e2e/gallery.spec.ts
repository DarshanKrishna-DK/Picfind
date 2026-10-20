import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { chooseMenu } from './menu';

// Synthetic photos and intercepted APIs only. Never start the API or call AWS.
async function fixture(page: Page) {
  const jpeg = await sharp({
    create: { width: 160, height: 120, channels: 3, background: '#477c79' },
  })
    .jpeg()
    .toBuffer();
  const photos = ['Garden.jpg', 'Ceremony.jpg', 'Reception.jpg'].map(
    (filename, i) => ({
      id: `photo-${i}`,
      filename,
      createdAt: `2026-09-${10 + i}T00:00:00.000Z`,
      width: 160,
      height: 120,
      bytes: jpeg.length,
      eventId: '',
    }),
  );
  const events = [
    {
      id: 'shared',
      title: 'Garden gathering',
      visibility: 'link',
      archived: false,
      expiresAt: '',
    },
    {
      id: 'private',
      title: 'Private celebration',
      visibility: 'private',
      archived: false,
      expiresAt: '',
    },
    {
      id: 'expired',
      title: 'Past conference',
      visibility: 'link',
      archived: false,
      expiresAt: '2020-01-01T00:00:00.000Z',
    },
    {
      id: 'archived',
      title: 'Archived occasion',
      visibility: 'link',
      archived: true,
      expiresAt: '',
    },
  ].map((event) => ({
    ...event,
    date: '2026-09-18',
    description: 'Synthetic test event',
    createdAt: '2026-09-18T00:00:00.000Z',
  }));
  const scan = {
    id: 'test-scan',
    state: 'complete',
    imported: 3,
    indexed: 3,
    createdAt: '2026-09-18T00:00:00.000Z',
    errors: [],
    matches: [],
  };
  const state = {
    failDownload: false,
    failUpload: false,
    failAfterUploadCommit: false,
    photoLimit: 20,
    uploadCalls: 0,
    scanCalls: 0,
    searchCalls: 0,
    driveFailure: false,
    driveWrites: [] as string[],
    emptyMatches: false,
    holdDownloads: false,
    releaseDownload: null as (() => void) | null,
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (
      path.includes('drive') &&
      !['GET', 'DELETE'].includes(request.method()) &&
      path !== '/api/drive/connect'
    )
      state.driveWrites.push(path);
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'test',
            name: 'Test Person',
            email: 'person@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: {
          photos: [
            ...photos,
            {
              ...photos[0],
              id: 'event-only-photo',
              filename: 'Event-only.jpg',
              eventId: 'shared',
            },
          ],
          events,
          jobs: [],
          scans: [],
          photoLimit: state.photoLimit,
        },
      });
    if (path === '/api/capabilities')
      return route.fulfill({
        json: {
          storage: true,
          drive: true,
          driveOAuth: true,
          driveConnected: true,
          faceMatching: true,
          faceProvider: 'aws-rekognition',
          photoLimit: 20,
          faceIndexMax: 20,
          billing: false,
        },
      });
    if (path === '/api/drive')
      return route.fulfill(
        state.driveFailure
          ? {
              status: 503,
              json: { error: { message: 'Please try disconnecting again.' } },
            }
          : { status: 204 },
      );
    if (path === '/api/sources')
      return route.fulfill({ json: { sources: [] } });
    if (path === '/api/public/events/shared/access')
      return route.fulfill({
        json: { brandingName: '', accentColor: '#173f37' },
      });
    if (path === '/api/public/events/shared')
      return route.fulfill({
        json: {
          event: events[0],
          photos: photos.map((photo) => ({ ...photo, eventId: 'shared' })),
          faceMatching: false,
        },
      });
    if (path === '/api/public/events/shared/find')
      return route.fulfill({
        json: {
          matches: state.emptyMatches
            ? []
            : photos.slice(0, 2).map((photo, i) => ({
                photoId: photo.id,
                filename: photo.filename,
                similarity: 98 - i,
              })),
        },
      });
    if (path === '/api/events/shared' && request.method() === 'PATCH') {
      Object.assign(events[0]!, request.postDataJSON());
      return route.fulfill({ json: { event: events[0] } });
    }
    if (path === '/api/discover/scans' && request.method() === 'POST') {
      state.scanCalls++;
      expect(request.postDataJSON().consent).toBe(true);
      expect(request.postDataJSON().photoIds).toEqual([
        'photo-0',
        'photo-1',
        'photo-2',
      ]);
      return route.fulfill({ status: 201, json: { scan } });
    }
    if (path === '/api/discover/scans/test-scan/search') {
      state.searchCalls++;
      return route.fulfill({
        json: {
          scan,
          matches: photos.slice(0, 2).map((photo, i) => ({
            photoId: photo.id,
            filename: photo.filename,
            similarity: 98 - i,
          })),
        },
      });
    }
    if (
      path === '/api/discover/scans/test-scan' &&
      request.method() === 'DELETE'
    )
      return route.fulfill({ status: 204 });
    if (path === '/api/photos' && request.method() === 'POST') {
      state.uploadCalls++;
      if (state.failUpload)
        return route.fulfill({
          status: 503,
          json: { error: { message: 'Temporary upload failure.' } },
        });
      const committed = photos.find((photo) => photo.id === 'uploaded');
      if (committed)
        return route.fulfill({ status: 201, json: { photo: committed } });
      photos.push({
        id: 'uploaded',
        filename: 'New-photo.jpg',
        createdAt: '2026-09-20T00:00:00.000Z',
        width: 160,
        height: 120,
        bytes: jpeg.length,
        eventId: '',
      });
      if (state.failAfterUploadCommit)
        return route.fulfill({
          status: 503,
          json: { error: { message: 'Upload acknowledgement lost.' } },
        });
      return route.fulfill({ status: 201, json: { photo: photos.at(-1) } });
    }
    if (
      path.endsWith('/file') ||
      path.startsWith('/api/public/events/shared/photos/')
    ) {
      if (state.holdDownloads && request.resourceType() !== 'image') {
        await new Promise<void>((resolve) => {
          state.releaseDownload = resolve;
        });
        return route
          .fulfill({ contentType: 'image/jpeg', body: jpeg })
          .catch(() => {});
      }
      if (state.failDownload && request.resourceType() !== 'image')
        return route.fulfill({
          status: 403,
          json: { error: { message: 'Gallery access expired.' } },
        });
      return route.fulfill({
        contentType: 'image/jpeg',
        body: jpeg,
        headers: new URL(request.url()).searchParams.has('download')
          ? { 'Content-Disposition': 'attachment; filename="photo.jpg"' }
          : {},
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Unexpected synthetic test request.' } },
    });
  });
  return { state, jpeg };
}

async function downloadArchive(page: Page, button: RegExp, count: number) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const path = await download.path();
  expect(path).toBeTruthy();
  expect(Object.keys(unzipSync(await readFile(path!)))).toHaveLength(count);
}

test('selection survives filtering and downloads only selected photos', async ({
  page,
}) => {
  const { state } = await fixture(page);
  await page.goto('/app/library');
  await expect(
    page.getByRole('button', { name: 'Open Event-only.jpg', exact: true }),
  ).toHaveCount(0);
  await page.getByLabel('Select Garden.jpg', { exact: true }).check();
  await page.getByLabel('Select Reception.jpg', { exact: true }).check();
  await page.getByLabel('Search photos by filename').fill('Garden');
  await expect(
    page.getByRole('button', { name: 'Open Reception.jpg' }),
  ).toHaveCount(0);
  await downloadArchive(page, /^Download selected/, 2);
  await expect(page.getByRole('link', { name: /Save download/ })).toBeVisible();
  expect(state.driveWrites).toEqual([]);
});

test('download all works without selecting and keeps the mobile layout within the viewport', async ({
  page,
}, info) => {
  const { state } = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/library');
  await downloadArchive(page, /^Download all$/, 3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByText('Where do downloads go on my phone?').click();
  await expect(page.locator('.download-help')).toContainText('Files');
  await page.screenshot({
    path: info.outputPath('gallery-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(state.driveWrites).toEqual([]);
});

test('photo viewer supports keyboard navigation and Escape', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/app/library');
  await chooseMenu(page, 'Sort photos', 'Filename');
  await page.getByRole('button', { name: 'Open Ceremony.jpg' }).click();
  const viewer = page.getByRole('dialog');
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText('Ceremony.jpg');
  await page.keyboard.press('ArrowRight');
  await expect(viewer).toContainText('Garden.jpg');
  await page.keyboard.press('ArrowLeft');
  await expect(viewer).toContainText('Ceremony.jpg');
  await page.keyboard.press('Escape');
  await expect(viewer).not.toBeVisible();
});

test('failed downloads are explained and can be retried without producing a partial ZIP', async ({
  page,
}) => {
  const { state } = await fixture(page);
  state.failDownload = true;
  await page.goto('/app/library');
  await page.getByRole('button', { name: 'Download all', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('link', { name: /Save download/ })).toHaveCount(
    0,
  );
  state.failDownload = false;
  await downloadArchive(page, /^Download all$/, 3);
});

test('event search and access-state filters use actual event data', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/app/events');
  await chooseMenu(page, 'Filter events', 'Expired');
  await expect(
    page.getByRole('heading', { name: 'Past conference' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Garden gathering' }),
  ).toHaveCount(0);
  await chooseMenu(page, 'Filter events', 'All events');
  await page.getByLabel('Search events').fill('Private celebration');
  await expect(
    page.getByRole('heading', { name: 'Private celebration' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Past conference' }),
  ).toHaveCount(0);
});

test('failed uploads can be retried without repeating successful photos', async ({
  page,
}) => {
  const { state, jpeg } = await fixture(page);
  state.failUpload = true;
  await page.goto('/app/library');
  await page.getByRole('button', { name: 'Add photos' }).click();
  await page.getByLabel('Choose photos', { exact: true }).setInputFiles({
    name: 'New-photo.jpg',
    mimeType: 'image/jpeg',
    buffer: jpeg,
  });
  await expect(
    page.getByRole('button', { name: 'Retry 1 failed upload' }),
  ).toBeVisible();
  state.failUpload = false;
  await page.getByRole('button', { name: 'Retry 1 failed upload' }).click();
  await expect(
    page.getByRole('button', { name: 'Open New-photo.jpg' }),
  ).toBeVisible();
  expect(state.uploadCalls).toBe(2);
});

test('a committed upload with a lost reply can be retried at zero remaining capacity', async ({
  page,
}) => {
  const { state, jpeg } = await fixture(page);
  state.photoLimit = 5;
  state.failAfterUploadCommit = true;
  await page.goto('/app/library');
  await page.getByRole('button', { name: 'Add photos' }).click();
  await page.getByLabel('Choose photos', { exact: true }).setInputFiles({
    name: 'New-photo.jpg',
    mimeType: 'image/jpeg',
    buffer: jpeg,
  });
  await expect(
    page.getByText('Upload acknowledgement lost.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Choose photos', { exact: true }),
  ).toBeDisabled();
  const retry = page.getByRole('button', { name: 'Retry 1 failed upload' });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Open New-photo.jpg' }),
  ).toHaveCount(1);
  expect(state.uploadCalls).toBe(2);
});

test('Discover presents synthetic returned matches as a downloadable gallery without Drive exports', async ({
  page,
}) => {
  const { state, jpeg } = await fixture(page);
  await page.goto('/app/discover/new');
  await chooseMenu(page, 'Imported album', 'Personal library');
  await expect(
    page.getByRole('checkbox', { name: 'Event-only.jpg', exact: true }),
  ).toHaveCount(0);
  await page.getByLabel('Reference selfie').setInputFiles({
    name: 'synthetic-reference.jpg',
    mimeType: 'image/jpeg',
    buffer: jpeg,
  });
  expect(state.scanCalls).toBe(0);
  await page.getByLabel(/I understand Amazon Rekognition/).check();
  await page.getByRole('button', { name: 'Find my photos' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your likely matches' }),
  ).toBeVisible();
  await downloadArchive(page, /^Download all$/, 2);
  expect(state.scanCalls).toBe(1);
  expect(state.searchCalls).toBe(1);
  expect(state.driveWrites).toEqual([]);
  await page.getByRole('button', { name: 'Search again', exact: true }).click();
  await expect.poll(() => state.searchCalls).toBe(2);
  await expect(
    page.getByRole('button', { name: 'Search again', exact: true }),
  ).toBeEnabled();
  expect(state.scanCalls).toBe(1);
  await expect(
    page.getByRole('button', { name: 'Imported album', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('checkbox', { name: 'Garden.jpg', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Delete this search session' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Your likely matches' }),
  ).toHaveCount(0);
});

test('Drive disconnect errors are visible instead of becoming unhandled rejections', async ({
  page,
}) => {
  const { state } = await fixture(page);
  state.driveFailure = true;
  await page.goto('/app/import');
  await page.getByRole('button', { name: 'Disconnect Google Drive' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Please try disconnecting again.',
  );
});

test('signed-in event guests can download the gallery without a purchase', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/e/shared');
  await expect(
    page.getByRole('heading', { name: 'Garden gathering' }),
  ).toBeVisible();
  await downloadArchive(page, /^Download all$/, 3);
  await expect(page.getByRole('button', { name: /Delete photo/ })).toHaveCount(
    0,
  );
});

test('event search keeps matches separate from the full gallery, including empty results', async ({
  page,
}) => {
  const { state, jpeg } = await fixture(page);
  await page.goto('/e/shared');
  await page.getByLabel('I agree to face matching for this event.').check();
  await page.getByLabel('Reference selfie').setInputFiles({
    name: 'synthetic-reference.jpg',
    mimeType: 'image/jpeg',
    buffer: jpeg,
  });
  await page.getByRole('button', { name: 'Search this gallery' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your likely matches' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open Garden.jpg' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open Reception.jpg' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Sort photos', exact: true }),
  ).toHaveText('Result order');
  await downloadArchive(page, /^Download all$/, 2);
  state.emptyMatches = true;
  await page.getByRole('button', { name: 'Search this gallery' }).click();
  await expect(
    page.getByText('No likely matches were found.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Open .+\.jpg$/ }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Show all event photos' }).click();
  await expect(
    page.getByRole('button', { name: /^Open .+\.jpg$/ }),
  ).toHaveCount(3);
});

test('an in-progress ZIP download can be cancelled', async ({ page }) => {
  const { state } = await fixture(page);
  state.holdDownloads = true;
  await page.goto('/app/library');
  await page.getByRole('button', { name: 'Download all', exact: true }).click();
  await expect.poll(() => Boolean(state.releaseDownload)).toBe(true);
  await page.getByRole('button', { name: 'Cancel download' }).click();
  await expect(page.getByRole('status')).toContainText('Download cancelled');
  state.releaseDownload?.();
  await expect(page.getByRole('link', { name: 'Save download' })).toHaveCount(
    0,
  );
});

test('single photo downloads remain individual JPEG files', async ({
  page,
}) => {
  const { jpeg } = await fixture(page);
  await page.goto('/app/library');
  const pending = page.waitForEvent('download');
  await page
    .getByRole('link', { name: 'Download Garden.jpg', exact: true })
    .click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.jpg$/);
  expect(await readFile((await download.path())!)).toEqual(jpeg);
});

test('organizers can download a QR code, make an event private, and archive it', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/app/events/shared');
  await page.getByRole('tab', { name: 'Sharing' }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download QR code' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('picfind-event-qr.svg');
  expect(await readFile((await download.path())!, 'utf8')).toContain('<svg');
  await page.getByRole('button', { name: 'Make private' }).click();
  await expect(
    page.getByText('This event is private.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Gallery link')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page
    .getByRole('button', { name: 'Archive event', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Restore event' }),
  ).toBeVisible();
});
