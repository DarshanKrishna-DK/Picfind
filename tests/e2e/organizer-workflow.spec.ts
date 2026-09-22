import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { unzipSync } from 'fflate';

// Synthetic metadata/photos and intercepted APIs. No cloud services are contacted.
async function fixture(page: Page) {
  const jpeg = await sharp({
    create: { width: 80, height: 60, channels: 3, background: '#50796a' },
  })
    .jpeg()
    .toBuffer();
  const eventId = '11111111-1111-4111-8111-111111111111';
  const events = [
    {
      id: eventId,
      title: 'Garden wedding',
      folder: 'Weddings 2026',
      visibility: 'link',
      archived: false,
      date: '2026-09-01',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Campus gathering',
      folder: 'Campus',
      visibility: 'private',
      archived: false,
      date: '2026-08-01',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Old conference',
      folder: '',
      visibility: 'private',
      archived: true,
      date: '',
    },
  ].map((event, i) => ({
    ...event,
    description: 'Synthetic event',
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    createdAt: `2026-09-0${i + 1}T00:00:00.000Z`,
  }));
  const photos = ['Ceremony.jpg', 'Garden.jpg'].map((filename, i) => ({
    id: `44444444-4444-4444-8444-44444444444${i}`,
    filename,
    eventId,
    bytes: jpeg.length,
    width: 80,
    height: 60,
    createdAt: '2026-09-01T00:00:00.000Z',
  }));
  const selection = {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Asha',
    note: 'Please retouch the album cover.',
    photoIds: [...photos.map((photo) => photo.id), 'removed-photo'],
    photos: photos.map(({ id, filename }) => ({ id, filename })),
    createdAt: '2026-09-02T00:00:00.000Z',
    reviewStatus: 'new',
    reviewNote: '',
    reviewVersion: 0,
    reviewedAt: null as string | null,
  };
  const state = {
    conflict: false,
    failDownload: false,
    writes: [] as { path: string; body: Record<string, unknown> }[],
    unexpectedWrites: [] as string[],
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'owner',
            name: 'Studio Owner',
            email: 'owner@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: { events, photos, jobs: [], scans: [], photoLimit: 20 },
      });
    if (path === '/api/events/entitlement')
      return route.fulfill({
        json: {
          entitlement: {
            plan: 'organizer-pro-monthly',
            retentionDays: 90,
            liveEvents: 10,
            paidThrough: new Date(Date.now() + 30 * 86400000).toISOString(),
          },
          activeEvents: 2,
          remainingEvents: 8,
          canCreate: true,
          catalogAvailable: false,
          serverNow: new Date().toISOString(),
          maximumExpiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
        },
      });
    if (path === '/api/capabilities')
      return route.fulfill({
        json: {
          storage: true,
          billing: false,
          faceMatching: false,
          drive: false,
          photoLimit: 20,
          faceIndexMax: 20,
        },
      });
    if (path === `/api/events/${eventId}/insights`)
      return route.fulfill({
        json: {
          photos: 2,
          indexed: 0,
          storageBytes: jpeg.length * 2,
          submissions: 1,
          hasPasscode: false,
          brandingName: '',
          accentColor: '#173f37',
          selections: [selection],
        },
      });
    if (
      path === `/api/events/${eventId}/selections/${selection.id}` &&
      method === 'PATCH'
    ) {
      const body = request.postDataJSON();
      state.writes.push({ path, body });
      if (state.conflict) {
        state.conflict = false;
        selection.reviewVersion++;
        selection.reviewNote = 'Updated in another tab';
        selection.reviewStatus = 'in-progress';
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'REVIEW_CHANGED',
              message:
                'Another tab changed this review. Load the latest review before saving again.',
            },
          },
        });
      }
      expect(body.version).toBe(selection.reviewVersion);
      Object.assign(selection, {
        reviewStatus: body.reviewStatus,
        reviewNote: body.reviewNote.trim(),
        reviewVersion: selection.reviewVersion + 1,
        reviewedAt: new Date().toISOString(),
      });
      return route.fulfill({
        json: {
          review: {
            reviewStatus: selection.reviewStatus,
            reviewNote: selection.reviewNote,
            reviewVersion: selection.reviewVersion,
            reviewedAt: selection.reviewedAt,
          },
        },
      });
    }
    if (path === `/api/events/${eventId}` && method === 'PATCH') {
      const body = request.postDataJSON();
      state.writes.push({ path, body });
      Object.assign(events[0]!, body);
      return route.fulfill({ json: { event: events[0] } });
    }
    if (/^\/api\/photos\/[^/]+\/file$/.test(path)) {
      if (state.failDownload)
        return route.fulfill({
          status: 410,
          json: { error: { message: 'Photo expired.' } },
        });
      return route.fulfill({ contentType: 'image/jpeg', body: jpeg });
    }
    if (!['GET', 'HEAD'].includes(method)) {
      state.unexpectedWrites.push(path);
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Unexpected write in synthetic test.' } },
      });
    }
    return route.fulfill({ json: {} });
  });
  return { eventId, events, selection, state, jpeg };
}

test('event folders, search and visibility filters survive reload', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/app/events');
  const cards = page.locator('.event-card');
  await expect(cards).toHaveCount(3);
  await page
    .getByRole('combobox', { name: 'Event folder', exact: true })
    .selectOption('folder:Weddings 2026');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Garden wedding');
  await page.reload();
  await expect(
    page.getByRole('combobox', { name: 'Event folder', exact: true }),
  ).toHaveValue('folder:Weddings 2026');
  await expect(cards).toHaveCount(1);
  await page.getByLabel('Search events').fill('not present');
  await expect(page.getByText('No events match these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await page
    .getByRole('combobox', { name: 'Filter events', exact: true })
    .selectOption('Archived');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Old conference');
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await page.getByLabel('Sort events').selectOption('name');
  await expect(cards.first()).toContainText('Campus gathering');
});

test('organizer edits a private event folder and can clear it', async ({
  page,
}) => {
  const { eventId, events } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page
    .getByText('Optional private organization', { exact: true })
    .click();
  const input = page.getByLabel('Event folder (private)', { exact: false });
  await expect(input).toHaveValue('Weddings 2026');
  await input.fill('Client albums');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('Event details saved.')).toBeVisible();
  expect(events[0]?.folder).toBe('Client albums');
  await input.fill('');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect.poll(() => events[0]?.folder).toBe('');
});

test('favorites reviews persist and can be found by status or guest', async ({
  page,
}) => {
  const { eventId, selection, state } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  const card = page.getByRole('article', { name: 'Selection from Asha' });
  await card
    .getByRole('combobox', { name: 'Review status', exact: true })
    .selectOption('completed');
  await card
    .getByLabel('Private review note')
    .fill('Album edits delivered in person.');
  await card.getByRole('button', { name: 'Save review', exact: true }).click();
  await expect(
    card.getByText('Review saved. No message was sent to the guest.'),
  ).toBeVisible();
  await expect(card.locator('.review-badge')).toHaveText('Completed');
  expect(selection.reviewVersion).toBe(1);
  await page.getByLabel('Filter selection status').selectOption('new');
  await expect(
    page.getByText('No requests match these filters.'),
  ).toBeVisible();
  await page.getByLabel('Filter selection status').selectOption('completed');
  await page.getByLabel('Search selections').fill('asha');
  await expect(card).toBeVisible();
  await page.reload();
  await expect(card.getByLabel('Private review note')).toHaveValue(
    'Album edits delivered in person.',
  );
  expect(state.unexpectedWrites).toEqual([]);
});

test('a competing review preserves the draft until explicit reload', async ({
  page,
}) => {
  const { eventId, state, selection } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  const card = page.getByRole('article', { name: 'Selection from Asha' });
  await card.getByLabel('Private review note').fill('My unsaved draft');
  state.conflict = true;
  await card.getByRole('button', { name: 'Save review', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('Another tab changed');
  await expect(card.getByLabel('Private review note')).toHaveValue(
    'My unsaved draft',
  );
  await expect(
    card.getByRole('button', { name: 'Save review', exact: true }),
  ).toBeDisabled();
  await card.getByRole('button', { name: 'Load latest review' }).click();
  await expect(card.getByLabel('Private review note')).toHaveValue(
    'Updated in another tab',
  );
  await card
    .getByRole('combobox', { name: 'Review status', exact: true })
    .selectOption('completed');
  await card.getByRole('button', { name: 'Save review', exact: true }).click();
  await expect(
    card.getByText('Review saved. No message was sent to the guest.'),
  ).toBeVisible();
  expect(selection.reviewVersion).toBe(2);
});

test('favorites ZIP contains only available photos and fits mobile', async ({
  page,
}) => {
  const { eventId, jpeg, state } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  const card = page.getByRole('article', { name: 'Selection from Asha' });
  await expect(
    card.getByText(/1 selected photo is no longer available/),
  ).toBeVisible();
  await expect(card.locator('.selection-thumbnails img')).toHaveCount(2);
  const pending = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Download favorites ZIP' }).click();
  const download = await pending;
  const path = await download.path();
  expect(path).toBeTruthy();
  const archive = unzipSync(new Uint8Array(await readFile(path!)));
  expect(Object.keys(archive)).toEqual(['001-Ceremony.jpg', '002-Garden.jpg']);
  expect(Buffer.from(archive['001-Ceremony.jpg']!)).toEqual(jpeg);
  await expect(
    card.getByText('ZIP ready. Your device handles the download.'),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  expect(state.unexpectedWrites).toEqual([]);
});

test('an expired photo stops the ZIP with an actionable error', async ({
  page,
}) => {
  const { eventId, state } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  const card = page.getByRole('article', { name: 'Selection from Asha' });
  await expect(card).toBeVisible();
  state.failDownload = true;
  let downloads = 0;
  page.on('download', () => {
    downloads++;
  });
  await card.getByRole('button', { name: 'Download favorites ZIP' }).click();
  await expect(card.getByRole('alert')).toContainText(
    'Could not download Ceremony.jpg',
  );
  await expect(
    card.getByRole('button', { name: 'Download favorites ZIP' }),
  ).toBeEnabled();
  expect(downloads).toBe(0);
});
