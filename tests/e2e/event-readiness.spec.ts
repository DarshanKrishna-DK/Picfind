import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
import { highlightRecordId } from '../../apps/api/src/highlights';
import type { JobQueue } from '../../apps/api/src/jobs';

const origin = 'http://127.0.0.1:5173';
async function fixture(page: Page) {
  const eventId = randomUUID(),
    photoId = randomUUID(),
    now = new Date().toISOString();
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
    title: 'Wedding preparation',
    description: '',
    date: '',
    visibility: 'private',
    archived: false,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const photo: LibraryRecord = {
    id: photoId,
    ownerId: 'owner',
    kind: 'photo',
    eventId,
    createdAt: now,
    bytes: image.length,
    width: 40,
    height: 30,
    filename: 'Wedding.jpg',
    indexState: 'queued',
  };
  const highlightId = highlightRecordId(eventId);
  const records = new Map<string, LibraryRecord>([
    [eventId, event],
    [photoId, photo],
    [
      highlightId,
      {
        id: highlightId,
        kind: 'job',
        purpose: 'event-highlights',
        eventId,
        ownerId: 'owner',
        createdAt: now,
        highlights: {
          title: 'Wedding highlights',
          photoIds: [photoId],
          version: 1,
          updatedAt: now,
          published: true,
        },
      },
    ],
  ]);
  const state = {
    actor: 'owner',
    fail: false,
    workerOutage: false,
    hold: false,
    release: null as (() => void) | null,
    writes: 0,
  };
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
    put: async (row) => {
      state.writes++;
      records.set(row.id, structuredClone(row));
    },
    remove: async () => {
      throw new Error('No deletion expected.');
    },
    upload: async () => {
      throw new Error('No upload expected.');
    },
    file: async () =>
      new Response(new Uint8Array(image), {
        headers: { 'content-type': 'image/jpeg' },
      }),
    removeFile: async () => {
      throw new Error('No file deletion expected.');
    },
  };
  const app = createApp(
    {
      webOrigin: origin,
      secureCookies: false,
      provider: {
        getUser: async (id) => ({
          id,
          name: 'Owner',
          email: `${id}@example.test`,
          emailVerified: true,
        }),
        register: async () => {
          throw new Error('No registration expected.');
        },
        login: async () => {
          throw new Error('No login expected.');
        },
        logout: async () => {},
      },
    },
    {
      store,
      jobQueue: {
        list: async () => {
          if (state.workerOutage) throw new Error('Synthetic worker outage');
          return [];
        },
      } as unknown as JobQueue,
    },
  );
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      path = new URL(incoming.url()).pathname;
    if (path.endsWith('/readiness') && state.hold) {
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
      state.release = null;
    }
    if (path.endsWith('/readiness') && state.fail)
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Synthetic readiness outage.' } },
      });
    const target = request(app);
    const outgoing =
      incoming.method() === 'GET' ? target.get(path) : target.post(path);
    outgoing
      .set('Cookie', `picfind_session=${state.actor}`)
      .set('Origin', origin);
    const actor = incoming.headers()['x-picfind-readiness-actor'];
    if (actor) outgoing.set('X-PicFind-Readiness-Actor', actor);
    const response = await outgoing;
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
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Readiness', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Event day readiness', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Refresh event readiness', exact: true }),
  ).toBeEnabled();
  return { state, event, photo, records, eventId };
}
const panel = (page: Page) =>
  page.getByRole('region', { name: 'Event day readiness', exact: true });
test('shows actual event readiness and takes the owner to relevant sections without writes', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await expect(
    panel(page).getByText('Full gallery is private', { exact: true }),
  ).toBeVisible();
  await expect(
    panel(page).getByText(
      'All selected highlights are available to signed-in guests',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    panel(page).getByText('Face search provider is not configured', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole('article', { name: 'Photo storage check' }),
  ).toContainText(String(f.photo.bytes));
  await page.screenshot({
    path: info.outputPath('event-readiness.png'),
    fullPage: true,
  });
  for (const [action, tab] of [
    ['Review event photos', 'Photos (1)'],
    ['Review event imports', 'Photos (1)'],
    ['Review face preparation', 'Sharing'],
    ['Review highlights', 'Highlights'],
    ['Review gallery access', 'Sharing'],
  ] as const) {
    await panel(page)
      .getByRole('button', { name: action, exact: true })
      .click();
    await expect(
      page.getByRole('tab', { name: tab, exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Readiness', exact: true }).click();
    await expect(
      panel(page).getByRole('button', { name: 'Refresh event readiness' }),
    ).toBeEnabled();
  }
  expect(f.state.writes).toBe(0);
});
test('hides stale checks during refresh and failure, then displays current archive state', async ({
  page,
}) => {
  const f = await fixture(page);
  f.state.hold = true;
  await panel(page)
    .getByRole('button', { name: 'Refresh event readiness' })
    .click();
  await expect(panel(page).getByRole('article')).toHaveCount(0);
  await expect.poll(() => !!f.state.release).toBe(true);
  f.state.fail = true;
  f.state.hold = false;
  f.state.release!();
  await expect(
    panel(page).getByText('Synthetic readiness outage.'),
  ).toBeVisible();
  await expect(panel(page).getByRole('article')).toHaveCount(0);
  f.state.fail = false;
  f.event.archived = true;
  await panel(page)
    .getByRole('button', { name: 'Refresh event readiness' })
    .click();
  await expect(
    panel(page).getByText('Event is archived', { exact: true }),
  ).toBeVisible();
  await expect(
    panel(page).getByText('Published highlights cannot currently be delivered'),
  ).toBeVisible();
  await panel(page)
    .getByRole('button', { name: 'Review gallery access' })
    .click();
  await expect(
    page.getByRole('tab', { name: 'Settings', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
});
test('reports a worker outage as unknown while leaving independent checks available', async ({
  page,
}) => {
  const f = await fixture(page);
  f.state.workerOutage = true;
  const id = randomUUID();
  f.records.set(id, {
    id,
    ownerId: 'owner',
    kind: 'job',
    eventId: f.eventId,
    purpose: 'import',
    processingSource: 'cloud',
    processingRequestId: 'request-1',
    createdAt: f.event.createdAt,
  });
  await panel(page)
    .getByRole('button', { name: 'Refresh event readiness' })
    .click();
  await expect(panel(page).getByRole('alert')).toContainText(
    'Worker status is unavailable',
  );
  await expect(
    panel(page).getByRole('article', { name: 'Import progress check' }),
  ).toContainText('Some saved batches need a worker status check');
  await expect(
    panel(page).getByText('Full gallery is private', { exact: true }),
  ).toBeVisible();
  await expect(
    panel(page).getByText('Face search provider is not configured', {
      exact: true,
    }),
  ).toHaveCount(0);
  expect(f.state.writes).toBe(0);
});
test('removes cached readiness when the browser account changes', async ({
  page,
}) => {
  const f = await fixture(page);
  f.state.actor = 'other';
  await panel(page)
    .getByRole('button', { name: 'Refresh event readiness' })
    .click();
  await expect(
    panel(page).getByText('Your signed-in account changed. Reload the event.'),
  ).toBeVisible();
  await expect(panel(page).getByRole('article')).toHaveCount(0);
});
