import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import { coverageRecordId } from '../../apps/api/src/event-coverage';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';

const origin = 'http://127.0.0.1:5173';
async function fixture(page: Page, count = 3) {
  const now = new Date().toISOString(),
    eventId = randomUUID();
  const image = await sharp({
    create: { width: 40, height: 30, channels: 3, background: '#477c79' },
  })
    .jpeg()
    .toBuffer();
  const event: LibraryRecord = {
    id: eventId,
    ownerId: 'owner',
    kind: 'event',
    createdAt: now,
    title: 'Wedding coverage',
    description: '',
    date: '',
    visibility: 'private',
    archived: false,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const photos: LibraryRecord[] = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    ownerId: 'owner',
    kind: 'photo',
    eventId,
    createdAt: now,
    bytes: image.length,
    width: 40,
    height: 30,
    filename: `Wedding-${String(index + 1).padStart(2, '0')}.jpg`,
  }));
  const records = new Map([event, ...photos].map((row) => [row.id, row]));
  const state = { actor: 'owner', loseReply: false, writes: 0 };
  const store: LibraryStore = {
    list: async (actor, kind) =>
      [...records.values()]
        .filter((row) => row.ownerId === actor && row.kind === kind)
        .map((row) => structuredClone(row)),
    get: async (id) => {
      const row = records.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable.');
      return structuredClone(row);
    },
    put: async (row, create) => {
      if (create && records.has(row.id))
        throw new ApiError(409, 'CONFLICT', 'Existing record.');
      state.writes++;
      records.set(row.id, structuredClone(row));
    },
    remove: async (id) => {
      records.delete(id);
    },
    upload: async () => {
      throw new Error('No uploads expected.');
    },
    file: async () =>
      new Response(new Uint8Array(image), {
        headers: { 'content-type': 'image/jpeg' },
      }),
    removeFile: async () => {
      throw new Error('No photo deletion expected.');
    },
  };
  const app = createApp(
    {
      webOrigin: origin,
      secureCookies: false,
      provider: {
        getUser: async (id) => ({
          id,
          name: id,
          email: `${id}@example.test`,
          emailVerified: true,
        }),
        register: async () => {
          throw new Error('No registration.');
        },
        login: async () => {
          throw new Error('No login.');
        },
        logout: async () => {},
      },
    },
    { store },
  );
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      path = new URL(incoming.url()).pathname,
      target = request(app);
    const outgoing =
      incoming.method() === 'PUT'
        ? target.put(path)
        : incoming.method() === 'GET'
          ? target.get(path)
          : target.post(path);
    outgoing
      .set('Cookie', `picfind_session=${state.actor}`)
      .set('Origin', origin);
    const actor = incoming.headers()['x-picfind-coverage-actor'];
    if (actor) outgoing.set('X-PicFind-Coverage-Actor', actor);
    if (incoming.postData()) outgoing.send(incoming.postDataJSON());
    const response = await outgoing;
    if (
      path.endsWith('/coverage') &&
      incoming.method() === 'PUT' &&
      response.status === 200 &&
      state.loseReply
    ) {
      state.loseReply = false;
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Synthetic coverage reply loss.' } },
      });
    }
    return route.fulfill({
      status: response.status,
      body: response.headers['content-type']?.startsWith('image/')
        ? response.body
        : response.text,
      headers: {
        'content-type': response.headers['content-type'] ?? 'application/json',
      },
    });
  });
  await open(page, eventId);
  return {
    state,
    event,
    photos,
    records,
    eventId,
    plan: () => records.get(coverageRecordId(eventId))!.coverage!,
  };
}
async function open(page: Page, eventId: string) {
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Coverage', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Refresh saved coverage', exact: true }),
  ).toBeEnabled();
}
const panel = (page: Page) =>
  page.getByRole('region', { name: 'Private event coverage', exact: true });
async function add(page: Page, label = 'Family portraits', target = '2') {
  await panel(page)
    .getByRole('button', { name: 'Add shot category', exact: true })
    .click();
  await page.getByLabel('Shot category name', { exact: true }).fill(label);
  await page.getByLabel('Target photo count', { exact: true }).fill(target);
}
async function assign(page: Page, photo: LibraryRecord) {
  await page
    .getByRole('button', {
      name: `Assign ${photo.filename} (${photo.id})`,
      exact: true,
    })
    .click();
}
async function save(page: Page) {
  await page
    .getByRole('button', { name: 'Save coverage plan', exact: true })
    .click();
  await expect(
    page.getByText(
      'Private coverage plan saved. Counts use currently available assigned photos.',
    ),
  ).toBeVisible();
}
const savedRows = (page: Page) =>
  page.getByRole('list', { name: 'Saved shot categories' });
async function refresh(page: Page) {
  await page
    .getByRole('button', { name: 'Refresh saved coverage', exact: true })
    .click();
  await expect(
    page.getByText('Saved coverage and photo availability refreshed.'),
  ).toBeVisible();
}

test('persists private shot targets and assignments with honest saved status across reloads', async ({
  page,
}, testInfo) => {
  const f = await fixture(page);
  await add(page);
  await page
    .getByLabel('Private coverage note')
    .fill('Include grandparents in the wide portrait.');
  await assign(page, f.photos[0]!);
  await expect(
    page.getByText(
      'Unsaved coverage changes. Saved counts above do not include this draft.',
    ),
  ).toBeVisible();
  await expect(savedRows(page)).toHaveCount(0);
  await save(page);
  await expect(savedRows(page)).toContainText(
    '1 of 2 available assignments. 1 still needed.',
  );
  await assign(page, f.photos[1]!);
  await save(page);
  await expect(savedRows(page)).toContainText(
    '2 of 2 available assignments. Target met.',
  );
  await add(page, 'Venue details', '1');
  await save(page);
  await open(page, f.eventId);
  await expect(savedRows(page)).toContainText(
    '2 of 2 available assignments. Target met.',
  );
  await expect(savedRows(page)).toContainText(
    '0 of 1 available assignments. 1 still needed.',
  );
  await page
    .getByRole('button', { name: 'Family portraits', exact: true })
    .click();
  await expect(page.getByLabel('Private coverage note')).toHaveValue(
    'Include grandparents in the wide portrait.',
  );
  expect(f.plan().items).toHaveLength(2);
  expect(f.plan().items[0]!.photoIds).toEqual([
    f.photos[0]!.id,
    f.photos[1]!.id,
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('event-coverage.png'),
    fullPage: true,
  });
});

test('refreshes expired assignments without counting them or showing their stale filenames', async ({
  page,
}) => {
  const f = await fixture(page);
  await add(page);
  await assign(page, f.photos[0]!);
  await assign(page, f.photos[1]!);
  await save(page);
  f.photos[0]!.expiresAt = '2000-01-01T00:00:00.000Z';
  await refresh(page);
  await expect(savedRows(page)).toContainText(
    '1 of 2 available assignments. 1 still needed. 1 unavailable assignments.',
  );
  const assigned = page.getByRole('list', { name: 'Assigned coverage photos' });
  await expect(assigned).toContainText(`Unavailable photo ${f.photos[0]!.id}`);
  await expect(assigned).not.toContainText(f.photos[0]!.filename!);
  await page
    .getByRole('button', {
      name: `Remove assignment ${f.photos[0]!.id}`,
      exact: true,
    })
    .click();
  await save(page);
  expect(f.plan().items[0]!.photoIds).toEqual([f.photos[1]!.id]);
  expect(f.records.has(f.photos[0]!.id)).toBe(true);
});

test('preserves a stale draft and requires explicit reload before another save', async ({
  page,
}) => {
  const f = await fixture(page);
  await add(page);
  await save(page);
  f.plan().version++;
  f.plan().items[0]!.label = 'Concurrent photographer edit';
  await page
    .getByLabel('Private coverage note')
    .fill('My unsaved private instruction');
  await page
    .getByRole('button', { name: 'Save coverage plan', exact: true })
    .click();
  await expect(
    page.getByText(
      'Your draft is preserved for inspection. Reload the saved plan before editing or saving again.',
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Private coverage note')).toHaveValue(
    'My unsaved private instruction',
  );
  await expect(
    page.getByRole('button', { name: 'Save coverage plan', exact: true }),
  ).toBeDisabled();
  page.once('dialog', (dialog) => dialog.accept());
  await refresh(page);
  await expect(page.getByLabel('Shot category name')).toHaveValue(
    'Concurrent photographer edit',
  );
});

test('retries a committed write after reply loss without incrementing or duplicating the plan', async ({
  page,
}) => {
  const f = await fixture(page);
  await add(page);
  await assign(page, f.photos[0]!);
  f.state.loseReply = true;
  await page
    .getByRole('button', { name: 'Save coverage plan', exact: true })
    .click();
  await expect(page.getByText('Synthetic coverage reply loss.')).toBeVisible();
  const committed = structuredClone(f.plan());
  await save(page);
  expect(f.plan()).toEqual(committed);
  expect(f.state.writes).toBe(1);
});

test('removes a category only after confirmation and saves an empty plan without deleting photos', async ({
  page,
}) => {
  const f = await fixture(page);
  await add(page);
  await assign(page, f.photos[0]!);
  await save(page);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('button', { name: 'Remove category from draft' })
    .click();
  await expect(page.getByLabel('Shot category name')).toHaveValue(
    'Family portraits',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Remove category from draft' })
    .click();
  expect(f.plan().items).toHaveLength(1);
  await save(page);
  expect(f.plan().items).toEqual([]);
  expect(f.photos.every((photo) => f.records.has(photo.id))).toBe(true);
});

test('shows archived plans read-only and hides private data on a detected account change', async ({
  page,
}) => {
  const f = await fixture(page);
  await add(page);
  await page.getByLabel('Private coverage note').fill('Private family detail');
  await save(page);
  f.event.archived = true;
  await open(page, f.eventId);
  await expect(
    page.getByText(
      'Archived or expired event. Restore an active event before editing this plan.',
    ),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Family portraits', exact: true })
    .click();
  await expect(page.getByLabel('Private coverage note')).toHaveValue(
    'Private family detail',
  );
  await expect(page.getByLabel('Private coverage note')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Add shot category', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Save coverage plan', exact: true }),
  ).toBeDisabled();
  expect(f.state.writes).toBe(1);
  f.state.actor = 'other';
  await page
    .getByRole('button', { name: 'Refresh saved coverage', exact: true })
    .click();
  await expect(
    page.getByText(
      'Private coverage is hidden until your account and event access are checked again.',
    ),
  ).toBeVisible();
  await expect(savedRows(page)).toHaveCount(0);
  await expect(page.getByLabel('Private coverage note')).toHaveCount(0);
});

test('searches and reveals bounded photo candidates beyond the first page', async ({
  page,
}) => {
  const f = await fixture(page, 55);
  await add(page);
  const candidates = page.getByRole('list', {
    name: 'Coverage photo candidates',
  });
  await expect(candidates.getByRole('listitem')).toHaveCount(50);
  await page
    .getByRole('button', { name: 'Show more coverage candidates' })
    .click();
  await expect(candidates.getByRole('listitem')).toHaveCount(55);
  await page.getByLabel('Search coverage photo filenames').fill('Wedding-55');
  await expect(candidates.getByRole('listitem')).toHaveCount(1);
  await assign(page, f.photos[54]!);
  await save(page);
  expect(f.plan().items[0]!.photoIds).toEqual([f.photos[54]!.id]);
});
