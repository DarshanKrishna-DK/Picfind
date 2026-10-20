import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

const eventId = 'a15cfe6e-2ff0-4564-b83d-047d0eb2e673';
const wallPath = `/highlights/${eventId}/wall`;
async function fixture(page: Page) {
  await page.clock.install({ time: new Date('2040-01-01T00:00:00Z') });
  const image = await sharp({
    create: { width: 120, height: 80, channels: 3, background: '#477c79' },
  })
    .jpeg()
    .toBuffer();
  const photos = ['First.jpg', 'Second.jpg'].map((filename, index) => ({
    id: `d15cfe6e-2ff0-4564-b83d-047d0eb2e67${index}`,
    filename,
    createdAt: '2040-01-01T00:00:00Z',
    width: 120,
    height: 80,
    bytes: image.length,
    credit: {
      name: 'Published photographer',
      website: 'https://example.test/studio',
    },
  }));
  const state = {
    signedIn: true,
    denied: false,
    holdReads: false,
    imageFailure: false,
    photos: [...photos],
    reads: 0,
    files: [] as string[],
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === '/api/auth/session') {
      if (request.method() === 'POST') {
        state.signedIn = true;
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({
        json: {
          user: state.signedIn
            ? {
                id: 'guest',
                name: 'Guest',
                email: 'guest@example.test',
                emailVerified: true,
              }
            : null,
        },
      });
    }
    if (path === '/api/account/capabilities')
      return route.fulfill({ json: { google: false, recovery: false } });
    if (path === `/api/public/highlights/${eventId}`) {
      state.reads++;
      if (state.holdReads) return;
      if (state.denied)
        return route.fulfill({
          status: 404,
          json: { error: { message: 'Highlights withdrawn.' } },
        });
      return route.fulfill({
        json: {
          title: 'Live selected moments',
          coverId: state.photos[0]?.id ?? null,
          photos: state.photos,
        },
      });
    }
    if (path.startsWith(`/api/public/highlights/${eventId}/photos/`)) {
      state.files.push(path);
      if (
        state.imageFailure ||
        state.denied ||
        !state.photos.some((photo) => path.endsWith(`/${photo.id}`))
      )
        return route.fulfill({
          status: 404,
          json: { error: { message: 'Photo unavailable.' } },
        });
      return route.fulfill({ contentType: 'image/jpeg', body: image });
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Unexpected synthetic route.' } },
    });
  });
  return { state, photos };
}
async function openWall(page: Page) {
  await page.goto(wallPath);
  await expect(
    page.getByRole('img', { name: 'First.jpg', exact: true }),
  ).toBeVisible();
}
test('starts paused, advances on request and preserves identity across refreshed ordering', async ({
  page,
}, testInfo) => {
  const { state } = await fixture(page);
  await openWall(page);
  await expect(
    page.getByRole('button', { name: 'Start slideshow' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Published photographer' }),
  ).toHaveAttribute('rel', 'noopener noreferrer');
  await page.getByLabel('Photo interval').selectOption('5');
  await page.getByRole('button', { name: 'Start slideshow' }).click();
  await page.clock.runFor(5100);
  await expect(
    page.getByRole('img', { name: 'Second.jpg', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Pause slideshow' }).click();
  await page.clock.runFor(5100);
  await expect(
    page.getByRole('img', { name: 'Second.jpg', exact: true }),
  ).toBeVisible();
  state.photos.reverse();
  await page.getByRole('button', { name: 'Refresh wall' }).click();
  await expect(
    page.getByText('1 of 2 photos. Slideshow paused.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Second.jpg', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Next photo' }).click();
  await expect(
    page.getByRole('img', { name: 'First.jpg', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('wall.png'),
    fullPage: true,
  });
  expect(
    state.files.every((path) =>
      path.startsWith(`/api/public/highlights/${eventId}/photos/`),
    ),
  ).toBe(true);
});
test('removes withdrawn photos, pauses and clears stale content on denied refresh', async ({
  page,
}) => {
  const { state, photos } = await fixture(page);
  await openWall(page);
  await page.getByRole('button', { name: 'Start slideshow' }).click();
  await page.clock.runFor(10_100);
  await expect(
    page.getByRole('img', { name: 'Second.jpg', exact: true }),
  ).toBeVisible();
  state.photos = [photos[0]!];
  await page.clock.runFor(5100);
  await expect(
    page.getByRole('img', { name: 'Second.jpg', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('img', { name: 'First.jpg', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('1 of 1 photos. Slideshow paused.', { exact: true }),
  ).toBeVisible();
  state.denied = true;
  await page.getByRole('button', { name: 'Refresh wall' }).click();
  await expect(
    page.getByText(
      'Highlights are unavailable. Refresh to check access again.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'First.jpg', exact: true }),
  ).toHaveCount(0);
  state.denied = false;
  state.photos = [...photos];
  await page.getByRole('button', { name: 'Refresh wall' }).click();
  await expect(
    page.getByRole('img', { name: 'First.jpg', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start slideshow' }),
  ).toBeVisible();
});
test('blanks offline and hidden views and requires a fresh response before returning', async ({
  page,
}) => {
  const { state } = await fixture(page);
  await openWall(page);
  await page.getByRole('button', { name: 'Start slideshow' }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    window.dispatchEvent(new Event('offline'));
  });
  await expect(
    page.getByText(
      'Offline. Photos are hidden until access can be checked again.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'First.jpg', exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
    });
    window.dispatchEvent(new Event('online'));
  });
  await expect(
    page.getByRole('img', { name: 'First.jpg', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start slideshow' }),
  ).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(
    page.getByRole('img', { name: 'First.jpg', exact: true }),
  ).toHaveCount(0);
  state.denied = true;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(
    page.getByText(
      'Highlights are unavailable. Refresh to check access again.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'First.jpg', exact: true }),
  ).toHaveCount(0);
});
test('pauses when only the currently displayed photo remains', async ({
  page,
}) => {
  const { state, photos } = await fixture(page);
  await openWall(page);
  await page.getByRole('button', { name: 'Start slideshow' }).click();
  await page.clock.runFor(10_100);
  await expect(
    page.getByRole('img', { name: 'Second.jpg', exact: true }),
  ).toBeVisible();
  state.photos = [photos[1]!];
  await page.clock.runFor(5100);
  await expect(
    page.getByText('1 of 1 photos. Slideshow paused.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start slideshow' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('img', { name: 'Second.jpg', exact: true }),
  ).toBeVisible();
});
test('times out a stalled refresh and recovers without automatic playback', async ({
  page,
}) => {
  const { state } = await fixture(page);
  await openWall(page);
  state.holdReads = true;
  await page.getByRole('button', { name: 'Start slideshow' }).click();
  await page.getByRole('button', { name: 'Refresh wall' }).click();
  await expect.poll(() => state.reads).toBe(2);
  await page.clock.runFor(10_100);
  await expect(
    page.getByText(
      'Highlights are unavailable. Refresh to check access again.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'First.jpg', exact: true }),
  ).toHaveCount(0);
  state.holdReads = false;
  await page.getByRole('button', { name: 'Refresh wall' }).click();
  await expect(
    page.getByRole('img', { name: 'First.jpg', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start slideshow' }),
  ).toBeVisible();
});
test('handles image failure, an empty set and fullscreen rejection without retaining a photo', async ({
  page,
}) => {
  const { state } = await fixture(page);
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = () =>
      Promise.reject(new Error('Synthetic fullscreen rejection'));
  });
  await openWall(page);
  await page.getByRole('button', { name: 'Open fullscreen' }).click();
  await expect(
    page.getByText(
      'Fullscreen is unavailable in this browser. The photo wall remains available here.',
    ),
  ).toBeVisible();
  state.imageFailure = true;
  await page.getByRole('button', { name: 'Refresh wall' }).click();
  await expect(
    page.getByText(
      'This photo could not be loaded. Refresh the wall to check access again.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'First.jpg', exact: true }),
  ).toHaveCount(0);
  state.imageFailure = false;
  state.photos = [];
  await page.getByRole('button', { name: 'Refresh wall' }).click();
  await expect(
    page.getByText('No published photos are currently available.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start slideshow' }),
  ).toBeDisabled();
});
test('returns to the wall after sign-in', async ({ page }) => {
  const { state } = await fixture(page);
  state.signedIn = false;
  await page.goto(wallPath);
  await page.getByRole('link', { name: 'Sign in to view photo wall' }).click();
  await page
    .getByLabel('Email address', { exact: true })
    .fill('guest@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${wallPath}$`));
  await expect(
    page.getByRole('img', { name: 'First.jpg', exact: true }),
  ).toBeVisible();
});
