import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import {
  emptyHighlights,
  type HighlightDraft,
} from '../../packages/shared/src/highlights';

const eventId = 'a15cfe6e-2ff0-4564-b83d-047d0eb2e673';
async function fixture(page: Page) {
  const image = await sharp({
    create: { width: 40, height: 30, channels: 3, background: '#477c79' },
  })
    .jpeg()
    .toBuffer();
  const event = {
    id: eventId,
    title: 'Private event title',
    description: '',
    date: '',
    visibility: 'private',
    archived: false,
    expiresAt: '',
    createdAt: '2026-10-20T00:00:00.000Z',
  };
  const photos = ['First.jpg', 'Second.jpg', 'Unselected.jpg'].map(
    (filename, index) => ({
      id: `d15cfe6e-2ff0-4564-b83d-047d0eb2e67${index}`,
      filename,
      eventId,
      width: 40,
      height: 30,
      bytes: image.length,
      createdAt: event.createdAt,
    }),
  );
  const state = {
    highlights: emptyHighlights() as HighlightDraft,
    signedIn: true,
    denied: false,
    files: [] as string[],
    writes: 0,
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: state.signedIn
            ? {
                id: 'owner',
                name: 'Owner',
                email: 'owner@example.test',
                emailVerified: true,
              }
            : null,
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: { photos, events: [event], jobs: [], scans: [], photoLimit: 100 },
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
    if (path === `/api/events/${eventId}/highlights`) {
      if (state.denied)
        return route.fulfill({
          status: 404,
          json: { error: { message: 'Highlights are unavailable.' } },
        });
      if (request.method() === 'PATCH') {
        const data = request.postDataJSON();
        if (data.version !== state.highlights.version)
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: 'HIGHLIGHTS_CHANGED',
                message: 'Highlights changed. Reload before saving.',
              },
            },
          });
        state.writes++;
        state.highlights = {
          ...data,
          version: data.version + 1,
          updatedAt: new Date().toISOString(),
        };
      }
      return route.fulfill({
        json: { highlights: state.highlights, unavailableIds: [] },
      });
    }
    if (path === `/api/public/highlights/${eventId}`) {
      if (!state.highlights.published || state.denied)
        return route.fulfill({
          status: 404,
          json: { error: { message: 'Highlights are unavailable.' } },
        });
      return route.fulfill({
        json: {
          title: state.highlights.title,
          coverId: state.highlights.photoIds[0],
          photos: state.highlights.photoIds.map((id) =>
            photos.find((photo) => photo.id === id),
          ),
        },
      });
    }
    if (path.startsWith(`/api/public/highlights/${eventId}/photos/`)) {
      state.files.push(path);
      const photoId = path.split('/').at(-1)!;
      if (
        state.highlights.published &&
        state.highlights.photoIds.includes(photoId) &&
        !state.denied
      )
        return route.fulfill({ contentType: 'image/jpeg', body: image });
      return route.fulfill({
        status: 404,
        json: { error: { message: 'Photo unavailable.' } },
      });
    }
    if (/\/photos\/[^/]+\/file$/.test(path))
      return route.fulfill({ contentType: 'image/jpeg', body: image });
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Synthetic unavailable route.' } },
    });
  });
  return { state, photos, image };
}
async function openEditor(page: Page) {
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Highlights', exact: true }).click();
  await expect(
    page.getByLabel('Highlight title', { exact: true }),
  ).toBeVisible();
}
test('saves ordered private highlights, publishes and withdraws after reloading', async ({
  page,
}) => {
  const { state, photos } = await fixture(page);
  await openEditor(page);
  await page
    .getByLabel('Highlight title', { exact: true })
    .fill('Wedding highlights');
  await page
    .getByRole('button', { name: 'Add First.jpg', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add Second.jpg', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Move Second.jpg up', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Save highlights', exact: true })
    .click();
  await expect(
    page.getByText('Private highlight draft saved.', { exact: false }),
  ).toBeVisible();
  expect(state.highlights.photoIds).toEqual([photos[1]!.id, photos[0]!.id]);
  await expect(page.getByLabel('Published highlights link')).toHaveCount(0);
  await page.reload();
  await page.getByRole('tab', { name: 'Highlights', exact: true }).click();
  await expect(page.getByLabel('Highlight title', { exact: true })).toHaveValue(
    'Wedding highlights',
  );
  await expect(
    page
      .getByRole('list', { name: 'Highlight order' })
      .getByRole('listitem')
      .first(),
  ).toContainText('Second.jpg');
  await page.getByLabel('Publish selected highlights').check();
  await page
    .getByRole('button', { name: 'Save highlights', exact: true })
    .click();
  await expect(page.getByLabel('Published highlights link')).toHaveValue(
    new RegExp(`/highlights/${eventId}$`),
  );
  expect(state.highlights.published).toBe(true);
  await page.getByLabel('Publish selected highlights').uncheck();
  await page
    .getByRole('button', { name: 'Save highlights', exact: true })
    .click();
  await expect(page.getByLabel('Published highlights link')).toHaveCount(0);
  expect(state.highlights.published).toBe(false);
});
test('downloads only the published ordered subset and hides the gallery after withdrawal refresh', async ({
  page,
}) => {
  const { state, photos, image } = await fixture(page);
  state.highlights = {
    ...emptyHighlights(),
    title: 'Selected moments',
    photoIds: [photos[1]!.id, photos[0]!.id],
    published: true,
    version: 1,
  };
  await page.goto(`/highlights/${eventId}`);
  await expect(
    page.getByRole('heading', { name: 'Selected moments' }),
  ).toBeVisible();
  await expect(
    page.getByText('Private event title', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('img', { name: 'Unselected.jpg', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /download all/i }).click();
  const path = await (await download).path();
  const archive = unzipSync(await readFile(path!));
  expect(Object.keys(archive)).toEqual(['001-Second.jpg', '002-First.jpg']);
  expect(Buffer.from(archive['002-First.jpg']!)).toEqual(image);
  expect(
    state.files.every((path) =>
      [photos[0]!.id, photos[1]!.id].includes(path.split('/').at(-1)!),
    ),
  ).toBe(true);
  state.highlights.published = false;
  await page
    .getByRole('button', { name: 'Refresh highlights', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Highlights are unavailable.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'First.jpg', exact: true }),
  ).toHaveCount(0);
});
test('preserves a conflicting draft, blocks saving and clears denied reloads', async ({
  page,
}) => {
  const { state, photos } = await fixture(page);
  state.highlights = {
    ...emptyHighlights(),
    photoIds: [photos[0]!.id],
    version: 1,
  };
  await openEditor(page);
  await page.getByLabel('Highlight title', { exact: true }).fill('My draft');
  state.highlights = {
    ...state.highlights,
    title: 'Other editor title',
    version: 2,
  };
  await page
    .getByRole('button', { name: 'Save highlights', exact: true })
    .click();
  await expect(
    page.getByText('Highlights changed. Reload before saving.'),
  ).toBeVisible();
  await expect(page.getByLabel('Highlight title', { exact: true })).toHaveValue(
    'My draft',
  );
  await expect(
    page.getByRole('button', { name: 'Save highlights', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Replace draft with latest highlights' })
    .click();
  await expect(page.getByLabel('Highlight title', { exact: true })).toHaveValue(
    'Other editor title',
  );
  expect(state.writes).toBe(0);
  state.denied = true;
  await page
    .getByRole('button', { name: 'Replace draft with latest highlights' })
    .click();
  await expect(page.getByLabel('Highlight title', { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByText('Highlights are unavailable.', { exact: true }),
  ).toBeVisible();
});
test('keeps a valid highlights destination through the sign-in link', async ({
  page,
}) => {
  const { state } = await fixture(page);
  state.signedIn = false;
  await page.goto(`/highlights/${eventId}`);
  await expect(
    page.getByRole('link', { name: 'Sign in to view highlights' }),
  ).toHaveAttribute(
    'href',
    `/sign-in?returnTo=${encodeURIComponent(`/highlights/${eventId}`)}`,
  );
  await expect(page.getByRole('button', { name: /download all/i })).toHaveCount(
    0,
  );
});
