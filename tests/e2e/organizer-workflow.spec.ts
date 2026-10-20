import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { chooseMenu } from './menu';

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
    selectionRules: { minimum: 1, maximum: 100 },
    selectionWindow: {
      closesAt: null as string | null,
      serverNow: new Date().toISOString(),
      closed: false,
      invalid: false,
    },
    writes: [] as { path: string; body: Record<string, unknown> }[],
    unexpectedWrites: [] as string[],
  };
  const selections = [selection];
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
          selectionRules: state.selectionRules,
          selectionWindow: state.selectionWindow,
          selections,
        },
      });
    if (
      path === `/api/events/${eventId}/selection-rules` &&
      method === 'PATCH'
    ) {
      state.selectionRules = request.postDataJSON();
      return route.fulfill({ json: { selectionRules: state.selectionRules } });
    }
    if (
      path === `/api/events/${eventId}/selection-window` &&
      method === 'PATCH'
    ) {
      const body = request.postDataJSON();
      const now = new Date().toISOString();
      state.selectionWindow = {
        closesAt:
          body.action === 'open'
            ? null
            : body.action === 'close'
              ? now
              : body.closesAt,
        closed: body.action === 'close',
        invalid: false,
        serverNow: now,
      };
      return route.fulfill({
        json: { selectionWindow: state.selectionWindow },
      });
    }
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
  return { eventId, events, selection, selections, state, jpeg };
}

test('event folders, search and visibility filters survive reload', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/app/events');
  const cards = page.locator('.event-card');
  await expect(cards).toHaveCount(3);
  await chooseMenu(page, 'Event folder', 'Weddings 2026');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Garden wedding');
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Event folder', exact: true }),
  ).toHaveText('Weddings 2026');
  await expect(cards).toHaveCount(1);
  await page.getByLabel('Search events').fill('not present');
  await expect(page.getByText('No events match these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await chooseMenu(page, 'Filter events', 'Archived');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Old conference');
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await chooseMenu(page, 'Sort events', 'Event name');
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
  await chooseMenu(page, 'Review status', 'Completed');
  await card
    .getByLabel('Private review note')
    .fill('Album edits delivered in person.');
  await card.getByRole('button', { name: 'Save review', exact: true }).click();
  await expect(
    card.getByText('Review saved. No message was sent to the guest.'),
  ).toBeVisible();
  await expect(card.locator('.review-badge')).toHaveText('Completed');
  expect(selection.reviewVersion).toBe(1);
  await chooseMenu(page, 'Filter selection status', 'New');
  await expect(
    page.getByText('No requests match these filters.'),
  ).toBeVisible();
  await chooseMenu(page, 'Filter selection status', 'Completed');
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
  await chooseMenu(page, 'Review status', 'Completed');
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

test('filename export refreshes availability and excludes private notes', async ({
  page,
}) => {
  const { eventId, selection, state } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  const card = page.getByRole('article', { name: 'Selection from Asha' });
  await expect(card).toBeVisible();
  selection.photos = selection.photos.slice(0, 1);
  selection.reviewNote = 'Private editing instruction';
  const pending = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Export filenames CSV' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe(
    `picfind-selection-${selection.id}.csv`,
  );
  const content = await readFile((await download.path())!, 'utf8');
  expect(content).toContain('"Photo ID","Filename"');
  expect(content).toContain('"Ceremony.jpg"');
  expect(content).not.toContain('Garden.jpg');
  expect(content).not.toContain('Private editing instruction');
  await expect(
    card.getByRole('status').filter({ hasText: 'filename exported' }),
  ).toHaveText('1 filename exported. 2 unavailable photos omitted.');
  expect(state.writes).toEqual([]);
});

test('a revoked owner session blocks filename export', async ({ page }) => {
  const { eventId } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  const card = page.getByRole('article', { name: 'Selection from Asha' });
  await expect(card).toBeVisible();
  await page.route(`**/api/events/${eventId}/insights`, (route) =>
    route.fulfill({
      status: 401,
      json: { error: { message: 'Sign in again to export selections.' } },
    }),
  );
  let downloads = 0;
  page.on('download', () => downloads++);
  await card.getByRole('button', { name: 'Export filenames TXT' }).click();
  await expect(card.getByRole('alert')).toContainText('Sign in again');
  await expect(
    card.getByRole('button', { name: 'Export filenames TXT' }),
  ).toBeEnabled();
  expect(downloads).toBe(0);
});

test('organizers save selection count rules and see them after reload', async ({
  page,
}) => {
  const { eventId, state } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  await page.getByText('Selection count rules', { exact: true }).click();
  await page.getByLabel('Minimum favorites per request').fill('3');
  await page.getByLabel('Maximum favorites per request').fill('2');
  await page.getByRole('button', { name: 'Save selection limits' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'minimum must be no greater',
  );
  expect(state.selectionRules).toEqual({ minimum: 1, maximum: 100 });
  await page.getByLabel('Maximum favorites per request').fill('3');
  await page.getByRole('button', { name: 'Save selection limits' }).click();
  await expect(
    page.getByText('Selection limits saved for future submissions.'),
  ).toBeVisible();
  expect(state.selectionRules).toEqual({ minimum: 3, maximum: 3 });
  await page.reload();
  await page.getByText('Selection count rules', { exact: true }).click();
  await expect(page.getByLabel('Minimum favorites per request')).toHaveValue(
    '3',
  );
  await expect(page.getByLabel('Maximum favorites per request')).toHaveValue(
    '3',
  );
});

test('organizers schedule, close and reopen favorites without changing the gallery', async ({
  page,
}) => {
  const { eventId, state, events } = await fixture(page);
  const before = structuredClone(events[0]);
  await page.goto(`/app/events/${eventId}`);
  await page
    .getByText('Favorites submission deadline', { exact: true })
    .click();
  const form = page
    .locator('details')
    .filter({ hasText: 'Favorites submission deadline' });
  await expect(
    form.getByText('Favorites submissions are open.', { exact: true }),
  ).toBeVisible();
  const tomorrow = new Date(Date.now() + 86400000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T18:30`;
  await page.getByLabel('Submission deadline in your time zone').fill(local);
  await page
    .getByRole('button', { name: 'Schedule submission deadline' })
    .click();
  await expect(
    form.getByText('Submission window saved. Existing requests are unchanged.'),
  ).toBeVisible();
  expect(state.selectionWindow.closesAt).toBe(new Date(local).toISOString());
  await expect(form.getByText(/Time zone:/)).toBeVisible();
  await page.reload();
  await page
    .getByText('Favorites submission deadline', { exact: true })
    .click();
  await expect(
    page.getByLabel('Submission deadline in your time zone'),
  ).toHaveValue(local);
  await page.getByRole('button', { name: 'Close submissions now' }).click();
  await expect(
    form.getByText('Favorites submissions are closed.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reopen without deadline' }).click();
  await expect(
    form.getByText('Favorites submissions are open.', { exact: true }),
  ).toBeVisible();
  expect(state.selectionWindow.closesAt).toBeNull();
  expect(events[0]).toEqual(before);
});

test('compare requests, filter shared favorites and export current availability', async ({
  page,
}) => {
  const { eventId, selection, selections, state } = await fixture(page);
  selections.push({
    ...selection,
    id: '66666666-6666-4666-8666-666666666666',
    name: 'Ravi',
    note: 'Guest note excluded from comparison',
    reviewNote: 'Private note excluded from comparison',
    photoIds: [selection.photos[1]!.id],
    photos: [selection.photos[1]!],
  });
  await page.goto(`/app/events/${eventId}`);
  await page.getByText('Compare client selections', { exact: true }).click();
  const comparison = page.locator('.selection-comparison');
  await chooseMenu(page, 'First selection request', /^1\. Asha/);
  await chooseMenu(page, 'Second selection request', /^2\. Ravi/);
  await expect(comparison).toContainText(
    '2 available photos, 1 shared favorites, 1 unavailable photos omitted.',
  );
  const list = comparison.getByRole('list', { name: 'Compared photos' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await chooseMenu(page, 'Comparison photos', 'Shared favorites');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('Garden.jpg');
  await chooseMenu(page, 'Comparison photos', 'Only in first request');
  await expect(list).toContainText('Ceremony.jpg');
  await chooseMenu(page, 'Comparison photos', 'All selected photos');
  // The photo disappears after rendering. Export must use the new projection.
  selection.photos = selection.photos.slice(1);
  const pending = page.waitForEvent('download');
  await comparison
    .getByRole('button', { name: 'Export comparison CSV' })
    .click();
  const download = await pending;
  const content = await readFile((await download.path())!, 'utf8');
  expect(content).toContain('Garden.jpg');
  expect(content).not.toContain('Ceremony.jpg');
  expect(content).not.toMatch(/Asha|Ravi|Private note|Guest note/);
  await expect(comparison).toContainText(
    '1 filenames exported from current availability.',
  );
  await chooseMenu(page, 'Second selection request', /^1\. Asha/);
  await expect(comparison).toContainText(
    'Choose two different selection requests.',
  );
  await expect(comparison.getByRole('list')).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test('comparison export fails when owner access is revoked', async ({
  page,
}) => {
  const { eventId, selection, selections } = await fixture(page);
  selections.push({ ...selection, id: 'second', name: 'Ravi' });
  await page.goto(`/app/events/${eventId}`);
  await page.getByText('Compare client selections', { exact: true }).click();
  await chooseMenu(page, 'First selection request', /^1\. Asha/);
  await chooseMenu(page, 'Second selection request', /^2\. Ravi/);
  await page.route(`**/api/events/${eventId}/insights`, (route) =>
    route.fulfill({
      status: 403,
      json: { error: { message: 'Owner access is required.' } },
    }),
  );
  let downloads = 0;
  page.on('download', () => downloads++);
  const comparison = page.locator('.selection-comparison');
  await comparison
    .getByRole('button', { name: 'Export comparison CSV' })
    .click();
  await expect(comparison.getByRole('alert')).toContainText('Owner access');
  expect(downloads).toBe(0);
});

test('leaving an event cancels a pending comparison export', async ({
  page,
}) => {
  const { eventId, selection, selections } = await fixture(page);
  selections.push({ ...selection, id: 'second', name: 'Ravi' });
  await page.goto(`/app/events/${eventId}`);
  await page.getByText('Compare client selections', { exact: true }).click();
  await chooseMenu(page, 'First selection request', /^1\. Asha/);
  await chooseMenu(page, 'Second selection request', /^2\. Ravi/);
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  const started = deferred();
  const release = deferred();
  await page.route(`**/api/events/${eventId}/insights`, async (route) => {
    started.resolve();
    await release.promise;
    await route.fulfill({ json: { selections } });
  });
  let downloads = 0;
  page.on('download', () => downloads++);
  const cancelled = page.waitForEvent('requestfailed', {
    predicate: (request) =>
      new URL(request.url()).pathname === `/api/events/${eventId}/insights`,
  });
  try {
    await page.getByRole('button', { name: 'Export comparison CSV' }).click();
    await started.promise;
    await page.getByRole('link', { name: 'All events', exact: true }).click();
    await expect(page).toHaveURL('/app/events');
    expect((await cancelled).failure()).not.toBeNull();
  } finally {
    release.resolve();
  }
  expect(downloads).toBe(0);
});
