import { expect, test } from '@playwright/test';
const eventId = 'c6b83638-a740-4a48-bdfc-6960a3b512aa';
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`moderator imports into the event despite a full personal library at ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    // Mobile WebKit at a desktop CSS width captures a very large high-DPI image.
    // Keep behavior assertions unchanged and budget separately for visual evidence.
    test.setTimeout(60_000);
    const event = {
      id: eventId,
      title: 'Together, in focus',
      description: '',
      visibility: 'private',
      archived: false,
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      accessRole: 'moderator',
    };
    const starts: Record<string, unknown>[] = [];
    const jobs: object[] = [];
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/auth/session')
        return route.fulfill({
          json: {
            user: {
              id: 'moderator',
              name: 'Morgan',
              email: 'morgan@example.test',
              emailVerified: true,
            },
          },
        });
      if (path === '/api/library')
        return route.fulfill({
          json: {
            events: [event],
            photos: [],
            jobs: [],
            scans: [],
            photoLimit: 20,
            storedPhotoCount: 20,
          },
        });
      if (path === '/api/capabilities')
        return route.fulfill({
          json: {
            storage: true,
            billing: false,
            cloudImports: true,
            faceMatching: false,
            eventIndexMax: 20,
          },
        });
      if (path === '/api/billing') return route.fulfill({ json: {} });
      if (path.endsWith('/gallery'))
        return route.fulfill({
          json: { event, photos: [], remainingUploads: 12 },
        });
      if (path === '/api/sources')
        return route.fulfill({
          json: {
            sources: [
              {
                id: 'dropbox',
                configured: true,
                connected: true,
                persistent: true,
              },
            ],
          },
        });
      if (path === '/api/sources/dropbox/items')
        return route.fulfill({
          json: {
            generation: '11111111-1111-4111-8111-111111111111',
            items: [
              {
                id: 'selected-photo',
                name: 'event-photo.jpg',
                folder: false,
                bytes: 200,
              },
            ],
            cursor: null,
          },
        });
      if (path === '/api/imports/queued') {
        if (route.request().method() === 'POST') {
          starts.push(route.request().postDataJSON());
          expect(route.request().headers()['x-picfind-consent']).toBe(
            'cloud-import-v1',
          );
          jobs.push({
            id: 'synthetic-job',
            source: 'dropbox',
            status: 'queued',
            total: 1,
            imported: 0,
            processed: 0,
            failed: 0,
            cancelRequested: false,
            errors: [],
            canResume: true,
          });
          return route.fulfill({ status: 202, json: { job: jobs[0] } });
        }
        return route.fulfill({ json: { jobs } });
      }
      return route.fulfill({
        status: 404,
        json: { error: { message: 'Synthetic endpoint unavailable' } },
      });
    });
    await page.goto(`/app/events/${eventId}`);
    await page.getByRole('button', { name: 'Import now from Dropbox' }).click();
    await page
      .getByRole('button', { name: 'Browse photos', exact: true })
      .click();
    await page.getByRole('button', { name: 'Select loaded photos' }).click();
    await expect(
      page.getByText('1 selected / 12 available in this batch'),
    ).toBeVisible();
    await page
      .getByLabel(/I have permission to copy the selected photos/)
      .check();
    await page
      .getByRole('button', { name: 'Import 1 selected', exact: true })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Import saved.' }),
    ).toBeVisible();
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      eventId,
      provider: 'dropbox',
      ids: ['selected-photo'],
    });
    expect(starts[0]).not.toHaveProperty('ownerId');
    expect(starts[0]).not.toHaveProperty('actorId');
    await expect(
      page.getByRole('button', { name: 'Pause import' }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      scale: 'css',
      animations: 'disabled',
      path: `artifacts/reports/moderator-import-${viewport.width}-${test.info().project.name}.png`,
    });
  });
}
