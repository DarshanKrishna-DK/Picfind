import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import type { PhotoAttribution } from '../../packages/shared/src/photo-attribution';
import { ATTRIBUTION_HEADER } from '../../packages/shared/src/photo-attribution';

async function fixture(page: Page) {
  const image = await sharp({
    create: { width: 120, height: 80, channels: 3, background: '#477c79' },
  })
    .jpeg()
    .toBuffer();
  const event = {
    id: 'event',
    title: 'Synthetic credits',
    date: '',
    description: '',
    visibility: 'link',
    archived: false,
    expiresAt: '',
    createdAt: new Date().toISOString(),
  };
  const base = {
    width: 120,
    height: 80,
    bytes: image.length,
    createdAt: event.createdAt,
  };
  const state = {
    credit: {
      name: '',
      website: '',
      published: false,
      version: 0,
      updatedAt: null,
    } as PhotoAttribution,
    denied: false,
    saves: 0,
  };
  const projection = () =>
    state.credit.published
      ? { credit: { name: state.credit.name, website: state.credit.website } }
      : {};
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'owner',
            name: 'Owner',
            email: 'owner@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: {
          photos: [
            { id: 'one', filename: 'Portrait.jpg', ...base, ...projection() },
            { id: 'two', filename: 'Second.jpg', ...base },
          ],
          events: [event],
          jobs: [],
          scans: [],
          photoLimit: 20,
        },
      });
    if (path === '/api/capabilities')
      return route.fulfill({
        json: {
          storage: true,
          faceMatching: false,
          drive: false,
          billing: false,
        },
      });
    if (path === '/api/photos/one/attribution') {
      if (state.denied)
        return route.fulfill({
          status: 404,
          json: { error: { message: 'Photo access unavailable.' } },
        });
      if (request.method() === 'PATCH') {
        const data = request.postDataJSON();
        if (data.version !== state.credit.version)
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: 'ATTRIBUTION_CHANGED',
                message: 'Another edit changed this photographer credit.',
              },
            },
          });
        state.credit = {
          ...data,
          version: state.credit.version + 1,
          updatedAt: new Date().toISOString(),
        };
        state.saves++;
      }
      return route.fulfill({ json: { attribution: state.credit } });
    }
    if (path === '/api/public/events/event/access')
      return route.fulfill({
        json: { brandingName: '', accentColor: '#173f37' },
      });
    if (path === '/api/public/events/event')
      return route.fulfill({
        json: {
          event,
          photos: [
            { id: 'one', filename: 'Portrait.jpg', ...base, ...projection() },
            { id: 'two', filename: 'Second.jpg', ...base },
          ],
          faceMatching: false,
        },
      });
    if (
      path.endsWith('/file') ||
      path.startsWith('/api/public/events/event/photos/')
    ) {
      const credited =
        (path.includes('/one/') || path.endsWith('/one')) &&
        state.credit.published;
      return route.fulfill({
        contentType: 'image/jpeg',
        body: image,
        headers: credited
          ? {
              [ATTRIBUTION_HEADER]: encodeURIComponent(
                JSON.stringify({
                  name: state.credit.name,
                  website: state.credit.website,
                }),
              ),
            }
          : {},
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Unexpected synthetic request.' } },
    });
  });
  return { state, image };
}
async function editor(page: Page) {
  await page
    .getByRole('button', { name: 'Open Portrait.jpg', exact: true })
    .click();
  await page.getByText('Photographer credit', { exact: true }).click();
  await expect(page.getByLabel('Credit name', { exact: true })).toBeVisible();
}
async function zip(page: Page) {
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download all', exact: true }).click();
  const download = await ready;
  const path = await download.path();
  expect(path).toBeTruthy();
  return unzipSync(await readFile(path!));
}

test('owner saves private credit, publishes it, reloads and withdraws it', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/app/library');
  await editor(page);
  await page.getByLabel('Credit name', { exact: true }).fill('Asha Studio');
  await page
    .getByLabel('Photographer website', { exact: true })
    .fill('https://example.test');
  await page
    .getByRole('button', { name: 'Save photographer credit', exact: true })
    .click();
  await expect(
    page.getByText('Photographer credit saved privately.', { exact: false }),
  ).toBeVisible();
  expect(f.state.credit.published).toBe(false);
  await page
    .getByLabel('Publish this credit in the gallery and new ZIP downloads')
    .check();
  await page
    .getByRole('button', { name: 'Save photographer credit', exact: true })
    .click();
  await expect(
    page.getByText('Photographer credit published.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Asha Studio', exact: true }),
  ).toHaveAttribute('rel', 'noopener noreferrer');
  await page.reload();
  await editor(page);
  await expect(page.getByLabel('Credit name', { exact: true })).toHaveValue(
    'Asha Studio',
  );
  await expect(
    page.getByLabel('Publish this credit in the gallery and new ZIP downloads'),
  ).toBeChecked();
  await page
    .getByLabel('Publish this credit in the gallery and new ZIP downloads')
    .uncheck();
  await page
    .getByRole('button', { name: 'Save photographer credit', exact: true })
    .click();
  await expect(
    page.getByText('Photographer credit saved privately.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Asha Studio', exact: true }),
  ).toHaveCount(0);
  expect(f.state.saves).toBe(3);
});

test('guest ZIP includes current published credits and omits a credit withdrawn after the gallery loaded', async ({
  page,
}) => {
  const f = await fixture(page);
  f.state.credit = {
    name: '=Asha, "Studio"',
    website: 'https://example.test',
    published: true,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  await page.goto('/e/event');
  await page
    .getByRole('button', { name: 'Open Portrait.jpg', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: '=Asha, "Studio"', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Photographer credit', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Close photo', exact: true }).click();
  const first = await zip(page);
  expect(Object.keys(first)).toHaveLength(3);
  const csv = new TextDecoder().decode(first['credits.csv']);
  expect(csv).toContain(`"'=Asha, ""Studio"""`);
  expect(csv).toContain('"one","Portrait.jpg"');
  for (const [name, bytes] of Object.entries(first)) {
    if (name.endsWith('.jpg'))
      expect(Buffer.from(bytes).equals(f.image)).toBe(true);
  }
  f.state.credit.published = false;
  const second = await zip(page);
  expect(Object.keys(second)).toHaveLength(2);
  expect(second).not.toHaveProperty('credits.csv');
});

test('credit editor preserves a conflicting draft and clears private data after denied reload', async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto('/app/library');
  await editor(page);
  await page.getByLabel('Credit name', { exact: true }).fill('My draft');
  f.state.credit = {
    name: 'Concurrent credit',
    website: '',
    published: false,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  await page
    .getByRole('button', { name: 'Save photographer credit', exact: true })
    .click();
  await expect(
    page.getByText('Another edit changed this photographer credit.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Credit name', { exact: true })).toHaveValue(
    'My draft',
  );
  await expect(
    page.getByRole('button', { name: 'Save photographer credit', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', {
      name: 'Replace draft with latest credit',
      exact: true,
    })
    .click();
  await expect(page.getByLabel('Credit name', { exact: true })).toHaveValue(
    'Concurrent credit',
  );
  f.state.denied = true;
  await page
    .getByRole('button', {
      name: 'Replace draft with latest credit',
      exact: true,
    })
    .click();
  await expect(
    page.getByText('Photo access unavailable.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Credit name', { exact: true })).toHaveCount(0);
  expect(f.state.saves).toBe(0);
});
