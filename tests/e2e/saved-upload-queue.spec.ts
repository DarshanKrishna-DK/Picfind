import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import sharp from 'sharp';

// Synthetic photos and intercepted API responses. Server replay has API coverage.
async function fixture(context: BrowserContext) {
  const originals = await Promise.all(
    ['#477c79', '#803524'].map(async (background, index) => ({
      name: `original-${index}.jpg`,
      mimeType: 'image/jpeg',
      buffer: await sharp({
        create: { width: 160, height: 120, channels: 3, background },
      })
        .jpeg()
        .toBuffer(),
    })),
  );
  const photos: {
    id: string;
    filename: string;
    createdAt: string;
    bytes: number;
    width: number;
    height: number;
  }[] = [];
  const committed: { bytes: Buffer; id: string }[] = [];
  const bodies = new Map<Page, Buffer[]>();
  const state = {
    actor: 'owner',
    calls: [] as {
      bytes: Buffer;
      actor: string | undefined;
      filename: string;
    }[],
    loseNextReply: false,
    loseReplyFor: '',
    holdNext: false,
    release: null as (() => void) | null,
  };
  await context.exposeBinding(
    'observeQueueUpload',
    ({ page }, bytes: number[]) => {
      const pending = bodies.get(page) ?? [];
      pending.push(Buffer.from(bytes));
      bodies.set(page, pending);
    },
  );
  await context.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      if (input === '/api/photos' && options?.body instanceof Blob) {
        const observer = window as unknown as {
          observeQueueUpload: (bytes: number[]) => Promise<void>;
        };
        await observer.observeQueueUpload([
          ...new Uint8Array(await options.body.arrayBuffer()),
        ]);
      }
      return originalFetch(input, options);
    };
  });
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: state.actor,
            name: 'Synthetic photographer',
            email: 'photographer@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: {
          photos,
          events: [],
          jobs: [],
          scans: [],
          photoLimit: 2,
          storedPhotoCount: photos.length,
        },
      });
    if (path === '/api/capabilities')
      return route.fulfill({
        json: {
          storage: true,
          drive: false,
          faceMatching: false,
          billing: false,
        },
      });
    if (path.endsWith('/file'))
      return route.fulfill({
        body: originals[0]!.buffer,
        contentType: 'image/jpeg',
      });
    if (path === '/api/photos' && request.method() === 'POST') {
      const bytes = bodies.get(request.frame().page())?.shift();
      if (!bytes) throw new Error('Upload bytes were not observed.');
      const headers = request.headers();
      const filename = decodeURIComponent(headers['x-file-name'] ?? '');
      state.calls.push({
        bytes,
        actor: headers['x-picfind-upload-actor'],
        filename,
      });
      if (headers['x-picfind-upload-actor'] !== state.actor)
        return route.fulfill({
          status: 409,
          json: { error: { message: 'The signed-in account changed.' } },
        });
      const found = committed.find((row) => row.bytes.equals(bytes));
      if (found)
        return route.fulfill({
          status: 201,
          json: { photo: photos.find((photo) => photo.id === found.id) },
        });
      if (photos.length >= 2)
        return route.fulfill({
          status: 409,
          json: { error: { message: 'Photo capacity reached.' } },
        });
      const photo = {
        id: `saved-${photos.length}`,
        filename,
        createdAt: new Date().toISOString(),
        bytes: bytes.length,
        width: 160,
        height: 120,
      };
      photos.push(photo);
      committed.push({ id: photo.id, bytes });
      if (state.holdNext) {
        state.holdNext = false;
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      }
      if (state.loseNextReply || state.loseReplyFor === filename) {
        state.loseNextReply = false;
        state.loseReplyFor = '';
        return route
          .fulfill({
            status: 503,
            json: { error: { message: 'Upload acknowledgement lost.' } },
          })
          .catch(() => {});
      }
      return route.fulfill({ status: 201, json: { photo } }).catch(() => {});
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Unexpected synthetic request.' } },
    });
  });
  return { originals, photos, state };
}

async function openQueue(page: Page) {
  await page.goto('/app/library');
  await page.getByRole('button', { name: 'Add photos', exact: true }).click();
  await page.getByRole('button', { name: 'Use saved upload queue' }).click();
  const queue = page.getByRole('region', { name: 'Saved upload queue' });
  await expect(
    queue.getByRole('button', { name: 'Refresh saved queue' }),
  ).toBeEnabled();
  return queue;
}

test('saved batch restores after reload, matches renamed originals and recovers a lost reply at capacity', async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  let queue = await openQueue(page);
  await queue.getByLabel('Choose batch photos').setInputFiles(f.originals);
  await expect(
    queue.getByText('2 unfinished files matched and ready.'),
  ).toBeVisible();
  f.state.loseReplyFor = f.originals[1]!.name;
  await queue.getByRole('button', { name: 'Start or resume batch' }).click();
  await expect(
    queue.getByText('1 of 2 uploads acknowledged. Queue: paused.'),
  ).toBeVisible();
  expect(f.photos).toHaveLength(2);
  expect(f.state.calls).toHaveLength(2);
  await page.reload();
  await page.getByRole('button', { name: 'Add photos', exact: true }).click();
  await page.getByRole('button', { name: 'Use saved upload queue' }).click();
  queue = page.getByRole('region', { name: 'Saved upload queue' });
  await expect(
    queue.getByText('1 unfinished files need their originals reselected.'),
  ).toBeVisible();
  await expect(
    queue.getByRole('button', { name: 'Start or resume batch' }),
  ).toBeDisabled();
  await queue.getByLabel('Reselect batch originals').setInputFiles(
    f.originals.map((file, index) => ({
      ...file,
      name: `renamed-${index}.jpg`,
    })),
  );
  await expect(
    queue.getByText('1 unfinished files matched and ready.'),
  ).toBeVisible();
  await queue.getByRole('button', { name: 'Start or resume batch' }).click();
  await expect(
    queue.getByText('2 of 2 uploads acknowledged. Queue: complete.'),
  ).toBeVisible();
  expect(f.state.calls).toHaveLength(3);
  expect(f.state.calls[2]!.bytes.equals(f.originals[1]!.buffer)).toBe(true);
  expect(f.state.calls[2]!.filename).toBe(f.originals[1]!.name);
  expect(f.state.calls.every((call) => call.actor === 'owner')).toBe(true);
  const manifest = await page.evaluate(
    () =>
      Object.entries(localStorage).find(([key]) =>
        key.startsWith('picfind.upload-queue.v1:'),
      )?.[1],
  );
  expect(manifest).toBeTruthy();
  expect(manifest).not.toContain(f.originals[0]!.buffer.toString('base64'));
  await queue.getByRole('button', { name: 'Clear saved queue' }).click();
  await expect(
    queue.getByText('Saved queue cleared. Server photos were kept.'),
  ).toBeVisible();
  expect(f.photos).toHaveLength(2);
});

test('saved batch locks a second tab, then pause lets that tab recover and finish', async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  const queue = await openQueue(page);
  await queue.getByLabel('Choose batch photos').setInputFiles(f.originals);
  await expect(
    queue.getByText('2 unfinished files matched and ready.'),
  ).toBeVisible();
  const other = await context.newPage();
  const otherQueue = await openQueue(other);
  await otherQueue
    .getByLabel('Reselect batch originals')
    .setInputFiles(f.originals);
  await expect(
    otherQueue.getByText('2 unfinished files matched and ready.'),
  ).toBeVisible();
  f.state.holdNext = true;
  await queue.getByRole('button', { name: 'Start or resume batch' }).click();
  await expect.poll(() => f.state.release !== null).toBe(true);
  await expect(
    otherQueue.getByText(
      'Another tab holds this queue. Refresh after it pauses or finishes.',
    ),
  ).toBeVisible();
  await expect(
    otherQueue.getByRole('button', { name: 'Start or resume batch' }),
  ).toBeDisabled();
  await otherQueue.getByRole('button', { name: 'Clear saved queue' }).click();
  await expect(
    otherQueue.getByText(
      'This saved queue is active in another tab. Refresh after that tab pauses or finishes.',
    ),
  ).toBeVisible();
  expect(f.state.calls).toHaveLength(1);
  await queue.getByRole('button', { name: 'Pause uploads' }).click();
  await expect(
    queue.getByText('0 of 2 uploads acknowledged. Queue: paused.'),
  ).toBeVisible();
  f.state.release!();
  await otherQueue.getByRole('button', { name: 'Refresh saved queue' }).click();
  await expect(
    otherQueue.getByRole('button', { name: 'Start or resume batch' }),
  ).toBeEnabled();
  await otherQueue
    .getByRole('button', { name: 'Start or resume batch' })
    .click();
  await expect(
    otherQueue.getByText('2 of 2 uploads acknowledged. Queue: complete.'),
  ).toBeVisible();
  expect(f.photos).toHaveLength(2);
  expect(f.state.calls).toHaveLength(3);
  await other.close();
});

test('saved batch cancel stops future requests and explicit resume recovers unfinished work', async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  const queue = await openQueue(page);
  await queue.getByLabel('Choose batch photos').setInputFiles(f.originals);
  await expect(
    queue.getByText('2 unfinished files matched and ready.'),
  ).toBeVisible();
  f.state.holdNext = true;
  await queue.getByRole('button', { name: 'Start or resume batch' }).click();
  await expect.poll(() => f.state.release !== null).toBe(true);
  await queue
    .getByRole('button', { name: 'Cancel unfinished uploads' })
    .click();
  await expect(
    queue.getByText('0 of 2 uploads acknowledged. Queue: cancelled.'),
  ).toBeVisible();
  expect(f.state.calls).toHaveLength(1);
  f.state.release!();
  await queue.getByRole('button', { name: 'Start or resume batch' }).click();
  await expect(
    queue.getByText('2 of 2 uploads acknowledged. Queue: complete.'),
  ).toBeVisible();
  expect(f.photos).toHaveLength(2);
  expect(f.state.calls).toHaveLength(3);
});

test('saved batch stops at an account change and keeps the original actor on resume', async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  const queue = await openQueue(page);
  await queue.getByLabel('Choose batch photos').setInputFiles(f.originals);
  await expect(
    queue.getByText('2 unfinished files matched and ready.'),
  ).toBeVisible();
  f.state.actor = 'other';
  await queue.getByRole('button', { name: 'Start or resume batch' }).click();
  await expect(
    queue.getByText('0 of 2 uploads acknowledged. Queue: paused.'),
  ).toBeVisible();
  await expect(
    queue.getByText('. The signed-in account changed.', { exact: true }),
  ).toBeVisible();
  expect(f.state.calls).toHaveLength(1);
  expect(f.photos).toHaveLength(0);
  f.state.actor = 'owner';
  await queue.getByRole('button', { name: 'Start or resume batch' }).click();
  await expect(
    queue.getByText('2 of 2 uploads acknowledged. Queue: complete.'),
  ).toBeVisible();
  expect(f.state.calls.every((call) => call.actor === 'owner')).toBe(true);
});
