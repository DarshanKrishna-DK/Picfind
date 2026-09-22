import { expect, test, type Page } from '@playwright/test';
import { anonymousApi } from './anonymous';
const createdEventId = 'ad851772-ef2a-46a2-8f66-066975c7b0aa';

for (const width of [1280, 390]) {
  test(`Studio separates personal discovery and event hosting at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await studioFixture(page);
    await page.goto('/app');
    const paths = page.getByRole('region', { name: 'Start or continue' });
    await expect(
      paths.getByRole('link', { name: 'Find my photos' }),
    ).toHaveAttribute('href', '/app/discover/new');
    await expect(
      paths.getByRole('link', { name: 'Open events' }),
    ).toHaveAttribute('href', '/app/events');
    await expect(
      page.getByText('Personal packs never pay for an event.', {
        exact: false,
      }),
    ).toBeVisible();
    const guide = page.locator('.dashboard-guide');
    await expect(guide).not.toHaveAttribute('open', '');
    await guide.locator('summary').click();
    await expect(guide).toHaveAttribute('open', '');
    await expect(guide.getByText('0 of 3 steps complete')).toBeVisible();
    await guide.locator('summary').click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .locator('.workspace-content')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.locator('.workspace-content').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({
      path: `artifacts/reports/studio-overview-${width}-${info.project.name}.png`,
    });
  });
}

async function studioFixture(page: Page) {
  const rows: {
    id: string;
    title: string;
    description: string;
    date: string;
    visibility: string;
    archived: boolean;
    expiresAt: string;
    createdAt: string;
  }[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'fixture-owner',
            name: 'Studio Owner',
            email: 'owner@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: { photos: [], events: rows, scans: [], jobs: [], photoLimit: 20 },
      });
    if (path.includes('capabilities'))
      return route.fulfill({
        json: {
          storage: true,
          photoLimit: 20,
          faceMatching: false,
          google: true,
          recovery: true,
          deletion: true,
          verification: true,
        },
      });
    if (path === '/api/sources')
      return route.fulfill({ json: { sources: [] } });
    if (path === '/api/events/entitlement')
      return route.fulfill({
        json: {
          entitlement: {
            plan: 'organizer-starter-monthly',
            retentionDays: 30,
            liveEvents: 2,
            paidThrough: new Date(Date.now() + 30 * 86400000).toISOString(),
          },
          activeEvents: rows.length,
          remainingEvents: Math.max(0, 2 - rows.length),
          maximumExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
          serverNow: new Date().toISOString(),
          canCreate: rows.length < 2,
          catalogAvailable: false,
        },
      });
    if (path.endsWith('/insights'))
      return route.fulfill({
        json: {
          photos: 0,
          indexed: 0,
          storageBytes: 0,
          submissions: 0,
          selections: [],
          hasPasscode: false,
          brandingName: '',
          accentColor: '#173f37',
        },
      });
    if (path === '/api/events' && route.request().method() === 'POST') {
      rows.push({
        ...route.request().postDataJSON(),
        id: createdEventId,
        visibility: 'private',
        archived: false,
        createdAt: new Date().toISOString(),
      });
      return route.fulfill({ status: 201, json: { event: rows[0] } });
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Fixture endpoint unavailable.' } },
    });
  });
  return rows;
}
test('public anchors, pricing, FAQ and brand icons are available on the landing page', async ({
  page,
  request,
}) => {
  await anonymousApi(page);
  await page.goto('/');
  await expect(page.locator('#pricing')).toBeAttached();
  if (await page.getByRole('button', { name: 'Toggle navigation' }).isVisible())
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Pricing', exact: true })
    .click();
  await expect(page).toHaveURL(/\/#pricing$/);
  await expect(
    page.getByRole('heading', {
      name: /Find your photos.*Or host the whole event/s,
    }),
  ).toBeVisible();
  await page.locator('#faq summary').first().click();
  await expect(page.locator('#faq details').first()).toHaveAttribute(
    'open',
    '',
  );
  for (const icon of [
    '/favicon-32.png',
    '/apple-touch-icon.png',
    '/icon-192.png',
    '/icon-512.png',
  ])
    expect((await request.get(icon)).status()).toBe(200);
});
test('anonymous studio links lead to sign-in without requesting private library data', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await anonymousApi(page);
  let requests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/library') requests++;
  });
  for (const path of [
    '/app',
    '/app/library',
    '/app/events/new',
    '/app/discover/new',
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByLabel('Email address')).toBeVisible();
  }
  expect(requests).toBe(0);
});
test('API outages show recovery instead of a generic error or private data', async ({
  page,
}) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 502,
      contentType: 'text/plain',
      body: 'proxy unavailable',
    }),
  );
  await page.goto('/app');
  await expect(page.getByRole('alert')).toContainText(
    'PicFind is temporarily unavailable',
  );
  await expect(
    page.getByRole('button', { name: 'Try again', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to sign in' })).toBeVisible();
});
test('Studio overview uses actual empty data, has separate navigation and creates a private event', async ({
  page,
}) => {
  const events = await studioFixture(page);
  await page.goto('/app');
  await expect(
    page.getByRole('heading', { name: 'Welcome, Studio.' }),
  ).toBeVisible();
  await expect(page.getByText('Your story starts here.')).toBeVisible();
  await expect(page.getByText('Currently off', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Create event', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Wedding', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('A few words about the day')).toHaveValue('');
  await page.getByLabel('Event name').fill('Our day');
  await page
    .getByLabel('Gallery/storage expires on')
    .fill(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  await page.getByRole('button', { name: 'Create event', exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/app/events/${createdEventId}\\?created=1$`),
  );
  expect(events[0]?.visibility).toBe('private');
});
test('all public and Studio pages fit mobile and render without runtime exceptions', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await studioFixture(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const path of [
    '/',
    '/discover',
    '/events',
    '/pricing',
    '/privacy',
    '/terms',
    '/contact',
    '/forgot-password',
    '/reset-password',
    '/verify-email',
    '/not-a-page',
    '/e/unavailable',
    '/app',
    '/app/library',
    '/app/events',
    '/app/events/new',
    '/app/events/missing',
    '/app/import',
    '/app/discover/new',
    '/app/settings',
    '/app/missing',
  ]) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      path,
    ).toBe(true);
  }
  await page.goto('/app');
  await page.getByRole('button', { name: 'Toggle studio navigation' }).click();
  await expect(
    page.getByRole('navigation', { name: 'Workspace' }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Photo library' })
    .click();
  await expect(page).toHaveURL(/\/app\/library$/);
  await expect(
    page.getByRole('button', { name: 'Toggle studio navigation' }),
  ).toHaveAttribute('aria-expanded', 'false');
  await page.screenshot({
    path: info.outputPath('studio-mobile.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test('malformed URL hashes do not crash the public site', async ({ page }) => {
  await anonymousApi(page);
  await page.goto('/#%E0%A4%A');
  await expect(
    page.getByRole('heading', { name: /Your photos/ }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload page' })).toHaveCount(
    0,
  );
});
test('Google sign-in preserves the selected Studio destination', async ({
  page,
}) => {
  await anonymousApi(page);
  await page.route('**/api/account/capabilities', (route) =>
    route.fulfill({ json: { google: true } }),
  );
  let destination = '';
  await page.route('**/api/account/google', (route) => {
    destination = route.request().postDataJSON().returnTo;
    return route.fulfill({ json: { url: '/sign-in?error=google' } });
  });
  await page.goto('/app/events/new');
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect.poll(() => destination).toBe('/app/events/new');
});

test('blank event form keeps the entered name and date without templates', async ({
  page,
}) => {
  await studioFixture(page);
  await page.goto('/app/events/new');
  await page.getByLabel('Event name').fill('A name I already entered');
  await page.getByLabel('Event date', { exact: true }).fill('2026-10-15');
  await expect(
    page.getByRole('button', { name: 'Wedding', exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel('A few words about the day')
    .fill('My own introduction.');
  await expect(page.getByLabel('Event name')).toHaveValue(
    'A name I already entered',
  );
  await expect(page.getByLabel('Event date', { exact: true })).toHaveValue(
    '2026-10-15',
  );
});
