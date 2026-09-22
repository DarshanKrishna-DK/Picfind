import { expect, test, type Page } from '@playwright/test';

const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherEventId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const generation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

for (const width of [1280, 390]) {
  test(`source cards show connection readiness without starting work at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    const f = await fixture(page);
    await page.route('**/api/sources', (route) =>
      route.fulfill({
        json: {
          sources: [
            { id: 'dropbox', configured: true, connected: false },
            { id: 'onedrive', configured: false, connected: false },
            {
              id: 'box',
              configured: true,
              connected: true,
              reconnectRequired: true,
            },
          ],
        },
      }),
    );
    await page.goto('/app/events/' + eventId + '?created=1');
    await page
      .getByRole('button', { name: 'Add photos to this event', exact: true })
      .click();
    const sources = page.getByRole('region', {
      name: 'Add photos to this event',
      exact: true,
    });
    const card = (name: string) =>
      sources
        .getByRole('article')
        .filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(
      card('Google Drive').getByText('Connected', { exact: true }),
    ).toBeVisible();
    await expect(
      card('Dropbox').getByText('Not connected', { exact: true }),
    ).toBeVisible();
    await expect(card('OneDrive').getByRole('button')).toBeDisabled();
    await expect(card('Box').getByText('Reconnect needed')).toBeVisible();
    expect(f.imports).toEqual([]);
    await card('Dropbox').getByRole('button').click();
    await expect(
      page.getByRole('button', { name: 'Connect Dropbox', exact: true }),
    ).toBeVisible();
    expect(f.imports).toEqual([]);
    expect(f.uploads).toEqual([]);
    await card('Dropbox').getByRole('button').click();
    await sources.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/reports/studio-sources-${width}-${info.project.name}.png`,
    });
  });
}
async function fixture(page: Page) {
  const uploads: string[] = [];
  const imports: Record<string, unknown>[] = [],
    histories: string[] = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname,
      method = route.request().method();
    const send = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (path === '/api/auth/session')
      return send({
        user: {
          id: 'synthetic-owner',
          name: 'Event owner',
          email: 'owner@example.test',
          emailVerified: true,
        },
      });
    if (path === '/api/capabilities')
      return send({
        storage: true,
        faceMatching: false,
        billing: false,
        cloudImports: true,
        eventIndexMax: 20,
        driveOAuth: true,
        driveConnected: true,
      });
    if (path === '/api/library')
      return send({
        photos: [],
        folders: [],
        jobs: [],
        photoLimit: 20,
        storedPhotoCount: 0,
        events: [eventId, otherEventId].map((id, index) => ({
          id,
          ownerId: 'synthetic-owner',
          title: index ? 'Event Two' : 'Event One',
          kind: 'event',
          visibility: 'private',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        })),
      });
    if (path === '/api/billing')
      return send(
        {
          error: {
            code: 'BILLING_DISABLED',
            message: 'Synthetic test: billing is disabled.',
          },
        },
        503,
      );
    if (path === '/api/sources')
      return send({
        sources: ['dropbox', 'onedrive', 'box'].map((id) => ({
          id,
          configured: true,
          connected: true,
          persistent: true,
        })),
      });
    if (path.endsWith('/items'))
      return send({
        items: [
          {
            id: 'source-photo-1',
            name: 'Event-photo.jpg',
            folder: false,
            bytes: 1024,
          },
        ],
        cursor: null,
        generation,
      });
    if (path === '/api/imports/queued' && method === 'GET') {
      histories.push(url.searchParams.get('eventId') ?? 'personal');
      return send({ jobs: [] });
    }
    if (path === '/api/imports/queued' && method === 'POST') {
      imports.push(route.request().postDataJSON());
      return send(
        { job: { id: generation, status: 'queued', imported: 0, total: 1 } },
        202,
      );
    }
    if (path === '/api/photos' && method === 'POST') {
      uploads.push(url.searchParams.get('eventId') ?? 'personal');
      return send({});
    }
    if (path.includes('/processing')) return send({ enabled: false, jobs: [] });
    if (path.endsWith('/insights'))
      return send({ selections: [], visits: 0, downloads: 0 });
    return send({});
  });
  return { imports, histories, uploads };
}
async function choosePhoto(page: Page) {
  await page
    .getByRole('button', { name: 'Browse photos', exact: true })
    .click();
  await page.getByRole('checkbox', { name: /Event-photo.jpg/ }).check();
  await page
    .getByRole('checkbox', { name: /I have permission to copy/ })
    .check();
}
test('event deep links lock the destination and enqueue only event-scoped photos', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/app/import?eventId=' + eventId + '&source=drive');
  await expect(
    page.getByRole('heading', { name: 'Import into this event' }),
  ).toBeVisible();
  await expect(page.getByRole('combobox', { name: /Destination/ })).toHaveCount(
    0,
  );
  await choosePhoto(page);
  await page
    .getByRole('button', { name: 'Import 1 selected', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Import saved.' }),
  ).toBeVisible();
  expect(f.imports).toEqual([
    expect.objectContaining({
      eventId,
      provider: 'drive',
      ids: ['source-photo-1'],
    }),
  ]);
  expect(f.histories).toContain(eventId);
  expect(f.histories).not.toContain('personal');
});
test('switching event deep links cannot reuse the previous event import history', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/app/import?eventId=' + eventId);
  await expect.poll(() => f.histories.includes(eventId)).toBe(true);
  await page.goto('/app/import?eventId=' + otherEventId);
  await expect.poll(() => f.histories.includes(otherEventId)).toBe(true);
  await page.goto('/app/import');
  await expect.poll(() => f.histories.includes('personal')).toBe(true);
});
test('OAuth return restores an event destination rather than personal storage', async ({
  page,
}) => {
  await page.addInitScript(
    ({ id }) =>
      sessionStorage.setItem(
        'picfind:event-import:return',
        JSON.stringify({ eventId: id, source: 'dropbox' }),
      ),
    { id: eventId },
  );
  const f = await fixture(page);
  await page.goto('/app/import?connected=1');
  await expect(
    page.getByRole('heading', { name: 'Import into this event' }),
  ).toBeVisible();
  await choosePhoto(page);
  await page
    .getByRole('button', { name: 'Import 1 selected', exact: true })
    .click();
  await expect.poll(() => f.imports.length).toBe(1);
  expect(f.imports[0]).toMatchObject({ eventId, provider: 'dropbox' });
});
for (const width of [1280, 390]) {
  test(`event import layout stays within ${width}px Studio`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await fixture(page);
    await page.goto('/app/import?eventId=' + eventId + '&source=drive');
    await expect(
      page.getByRole('heading', { name: 'Import into this event' }),
    ).toBeVisible();
    await choosePhoto(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`event-import-${width}.png`),
    });
  });
}
test('event import page scopes device uploads as well as cloud imports', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/app/import?eventId=' + eventId);
  await expect(
    page.getByRole('heading', { name: 'Add photos to this event.' }),
  ).toBeVisible();
  await page.getByLabel('Choose photos', { exact: true }).setInputFiles({
    name: 'synthetic.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('synthetic bytes intercepted by the test adapter'),
  });
  await expect.poll(() => f.uploads.length).toBe(1);
  expect(f.uploads).toEqual([eventId]);
});
test('an unavailable event never falls back to personal uploads', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/app/import?eventId=dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  await expect(
    page.getByText(
      'This event is unavailable or expired. Nothing will be imported into your personal library instead.',
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel('Choose photos', { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Choose a folder', exact: true }),
  ).toBeDisabled();
  await choosePhoto(page);
  await expect(
    page.getByRole('button', { name: 'Import 1 selected', exact: true }),
  ).toBeDisabled();
  expect(f.uploads).toEqual([]);
  expect(f.imports).toEqual([]);
});
test('event page exposes separate cloud cards with a fixed destination', async ({
  page,
}, testInfo) => {
  const f = await fixture(page);
  await page.goto('/app/events/' + eventId + '?created=1');
  await page
    .getByRole('button', { name: 'Add photos to this event', exact: true })
    .click();
  const sources = page.getByRole('region', {
    name: 'Add photos to this event',
    exact: true,
  });
  await expect(sources.getByRole('article')).toHaveCount(4);
  await page.screenshot({
    path: testInfo.outputPath('event-source-cards.png'),
  });
  await sources
    .getByRole('button', { name: /Import now.*Google Drive/ })
    .click();
  await choosePhoto(page);
  await page
    .getByRole('button', { name: 'Import 1 selected', exact: true })
    .click();
  await expect.poll(() => f.imports.length).toBe(1);
  expect(f.imports[0]).toMatchObject({ eventId, provider: 'drive' });
});
for (const source of ['toString', '__proto__', 'constructor', 'unknown']) {
  test(`invalid OAuth provider hint ${source} cannot crash the import page or start an import`, async ({
    page,
  }) => {
    await page.addInitScript(
      ({ id, provider }) =>
        sessionStorage.setItem(
          'picfind:event-import:return',
          JSON.stringify({ eventId: id, source: provider }),
        ),
      { id: eventId, provider: source },
    );
    const f = await fixture(page);
    await page.goto('/app/import?connected=1');
    await expect(
      page.getByRole('heading', { name: 'Bring your cloud photos together.' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: "Let's get you back." }),
    ).toHaveCount(0);
    expect(f.imports).toEqual([]);
    expect(f.uploads).toEqual([]);
  });
}
