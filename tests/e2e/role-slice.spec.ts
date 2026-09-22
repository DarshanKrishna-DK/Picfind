import { expect, test, type Page } from '@playwright/test';
const eventId = 'c6b83638-a740-4a48-bdfc-6960a3b512aa';
async function fixture(page: Page, signedIn = true, organizer = true) {
  let authenticated = signedIn;
  const events: object[] = [];
  const writes: string[] = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method !== 'GET') writes.push(path);
    if (path === '/api/auth/session') {
      if (method === 'POST') authenticated = true;
      return authenticated
        ? route.fulfill({
            json: {
              user: {
                id: 'fixture-owner',
                name: 'Sam',
                email: 'sam@example.test',
                emailVerified: true,
              },
            },
          })
        : route.fulfill({
            status: 401,
            json: {
              error: {
                code: 'UNAUTHENTICATED',
                message: 'Sign in to continue.',
              },
            },
          });
    }
    if (path.includes('capabilities'))
      return route.fulfill({
        json: {
          storage: true,
          billing: false,
          google: false,
          cloudImports: false,
          faceMatching: false,
          photoLimit: 20,
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: { photos: [], events, jobs: [], scans: [], photoLimit: 20 },
      });
    if (path === '/api/events/entitlement')
      return route.fulfill({
        json: {
          entitlement: organizer
            ? {
                plan: 'organizer-starter-monthly',
                retentionDays: 30,
                liveEvents: 2,
                paidThrough: new Date(Date.now() + 30 * 86400000).toISOString(),
              }
            : null,
          activeEvents: events.length,
          remainingEvents: organizer ? Math.max(0, 2 - events.length) : 0,
          maximumExpiresAt: organizer
            ? new Date(Date.now() + 30 * 86400000).toISOString()
            : null,
          serverNow: new Date().toISOString(),
          canCreate: organizer && events.length < 2,
          catalogAvailable: false,
        },
      });
    if (path === '/api/billing')
      return route.fulfill({
        json: {
          environment: 'test_mode',
          checkoutAvailable: false,
          products: [],
          portalAvailable: false,
          photosRemaining: 17,
          searchesRemaining: 18,
          deliveryBytesRemaining: 500000000,
          storageBytesUsed: 0,
          subscriptions: [],
          grants: [
            {
              id: 'trial',
              plan: 'preview',
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
              usedPhotos: 3,
              photosRemaining: 17,
              held: false,
              refundFraction: 0,
            },
          ],
        },
      });
    if (path === '/api/events' && method === 'POST') {
      const event = {
        ...route.request().postDataJSON(),
        id: eventId,
        visibility: 'private',
        archived: false,
        createdAt: new Date().toISOString(),
      };
      events.push(event);
      return route.fulfill({ status: 201, json: { event } });
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
          brandingName: '',
          accentColor: '#173f37',
        },
      });
    if (path === `/api/public/events/${eventId}/access`)
      return route.fulfill({
        json: { brandingName: '', accentColor: '#173f37' },
      });
    if (path === `/api/public/events/${eventId}`)
      return route.fulfill({
        json: {
          event: {
            id: eventId,
            title: 'Invited event',
            description: '',
            date: '',
          },
          photos: [],
        },
      });
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Synthetic endpoint not configured.' } },
    });
  });
  return { writes };
}
async function openNavigation(page: Page) {
  const toggle = page.getByRole('button', {
    name: 'Toggle navigation',
    exact: true,
  });
  if (await toggle.isVisible()) await toggle.click();
}
test('an incomplete billing response cannot crash the rest of Studio', async ({
  page,
}) => {
  await fixture(page);
  await page.route('**/api/billing', (route) => route.fulfill({ json: {} }));
  await page.goto('/app/events');
  await expect(page.locator('.studio-shell')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: "Let's get you back." }),
  ).toHaveCount(0);
  const toggle = page.getByRole('button', { name: 'Toggle studio navigation' });
  if (await toggle.isVisible()) await toggle.click();
  await expect(page.locator('.usage')).toContainText(
    'Usage unavailable. Open Billing to retry.',
  );
});
test('public navbar has exactly the correct account action', async ({
  page,
}) => {
  await fixture(page, false);
  await page.goto('/');
  await openNavigation(page);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(
    nav.getByRole('link', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Open your studio' })).toHaveCount(
    0,
  );
});
test('signed-in marketing header has no sign-in or sign-out control', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/');
  await openNavigation(page);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(
    nav.getByRole('link', { name: 'Open your studio' }),
  ).toBeVisible();
  await expect(
    nav.getByRole('link', { name: 'Sign in', exact: true }),
  ).toHaveCount(0);
  await expect(nav.getByRole('button', { name: /sign out/i })).toHaveCount(0);
});
test('personal packs and organizer yearly prices switch without navigation', async ({
  page,
}) => {
  const f = await fixture(page, false);
  await page.goto('/#pricing');
  const pricing = page.locator('#pricing');
  await expect(
    pricing.getByRole('article', { name: '250-photo pack', exact: true }),
  ).toContainText('99');
  await expect(
    pricing.getByRole('button', { name: 'Yearly', exact: true }),
  ).toHaveCount(0);
  await pricing
    .getByRole('button', { name: 'Organizer plans', exact: true })
    .click();
  await expect(
    pricing.getByRole('article', { name: 'Pro', exact: true }),
  ).toContainText('1,999');
  await pricing.getByRole('button', { name: 'Yearly', exact: true }).click();
  await expect(
    pricing.getByRole('article', { name: 'Pro', exact: true }),
  ).toContainText('19,990');
  await expect(
    pricing.getByRole('article', { name: 'Pro', exact: true }),
  ).toContainText('Billed yearly');
  await pricing
    .getByRole('button', { name: 'Personal packs', exact: true })
    .click();
  await pricing.getByLabel('Photos to process', { exact: true }).fill('1250');
  await expect(pricing.getByRole('status')).toContainText('398');
  expect(f.writes).toEqual([]);
});
test('blank event creation immediately exposes invitation and QR download', async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize(
    test.info().project.name === 'webkit-mobile'
      ? { width: 390, height: 844 }
      : { width: 1280, height: 800 },
  );
  await page.goto('/app/events/new');
  await expect(
    page.getByRole('button', { name: 'Wedding', exact: true }),
  ).toHaveCount(0);
  await page.getByLabel('Event name', { exact: true }).fill('Product meetup');
  await expect(page.getByLabel('Gallery/storage expires on')).toHaveAttribute(
    'required',
    '',
  );
  await expect(page.getByText(/Your plan allows up to 30 days/)).toBeVisible();
  await page
    .getByLabel('Gallery/storage expires on')
    .fill(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
  await page.screenshot({
    path: `artifacts/reports/event-create-${test.info().project.name}.png`,
  });
  await page.getByRole('button', { name: 'Create event', exact: true }).click();
  const setup = page.getByRole('region', { name: 'Event setup' });
  await expect(setup).toBeVisible();
  await expect(setup.getByLabel('Event invitation link')).toHaveValue(
    new RegExp(`/e/${eventId}$`),
  );
  const download = page.waitForEvent('download');
  await setup.getByRole('button', { name: 'Download invitation QR' }).click();
  expect((await download).suggestedFilename()).toBe('picfind-event-qr.svg');
});
test('personal packs do not show a free event creation form', async ({
  page,
}) => {
  const f = await fixture(page, true, false);
  await page.goto('/app/events/new');
  await expect(
    page.getByRole('heading', { name: 'An organizer plan is required.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Create event', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Open Billing', exact: true }),
  ).toHaveAttribute('href', '/app/billing');
  expect(f.writes).toEqual([]);
});
test('required expiry and the plan date maximum prevent invalid creation', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/app/events/new');
  await page.getByLabel('Event name', { exact: true }).fill('Expiry boundary');
  await page.getByRole('button', { name: 'Create event', exact: true }).click();
  expect(f.writes).not.toContain('/api/events');
  await page
    .getByLabel('Gallery/storage expires on')
    .fill(new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10));
  await page.getByRole('button', { name: 'Create event', exact: true }).click();
  expect(f.writes).not.toContain('/api/events');
});
test('guest sign-in returns to the secret event instead of Studio', async ({
  page,
}) => {
  await fixture(page, false);
  await page.goto(`/e/${eventId}`);
  await expect(page).toHaveURL(new RegExp(`/sign-in\\?returnTo=`));
  await page
    .getByLabel('Email address', { exact: true })
    .fill('guest@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('synthetic-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/e/${eventId}$`));
  await expect(
    page.getByRole('heading', { name: 'Invited event' }),
  ).toBeVisible();
});
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`Studio fits ${viewport.width}x${viewport.height} with live usage`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await fixture(page);
    await page.goto('/app/billing');
    await expect(
      page.getByRole('heading', { name: 'Billing & usage' }),
    ).toBeVisible();
    if (viewport.width < 600)
      await page
        .getByRole('button', { name: 'Toggle studio navigation' })
        .click();
    await expect(page.locator('.usage')).toContainText(
      '17 photo attempts left',
    );
    await expect(page.locator('.usage')).toContainText(
      '3 processed / 18 searches left',
    );
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: innerWidth,
      height: document.querySelector('.studio-shell')!.getBoundingClientRect()
        .height,
      main: getComputedStyle(document.querySelector('.workspace-content')!)
        .overflowY,
    }));
    expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.height).toBe(viewport.height);
    expect(dimensions.main).toBe('auto');
    if (viewport.width < 600)
      await page
        .getByRole('button', { name: 'Toggle studio navigation' })
        .click();
    await page.screenshot({
      path: testInfo.outputPath(`studio-${viewport.width}.png`),
    });
  });
}
