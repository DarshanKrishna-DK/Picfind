import { expect, test, type Page } from '@playwright/test';
import type { DiscoverScan } from '../../apps/web/src/api';
declare global {
  interface Window {
    __discoverUploadSizes: number[];
  }
}
test('library album photos can be selected and cleared', async ({ page }) => {
  const state = await fixture(page);
  await expect(page.getByLabel('Source 0.jpg', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Source 1.jpg', { exact: true })).toBeChecked();
  await page
    .getByRole('button', { name: 'Clear selection', exact: true })
    .click();
  await expect(
    page.getByLabel('Source 0.jpg', { exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole('button', { name: 'Use this album', exact: true })
    .click();
  await expect(page.getByLabel('Source 0.jpg', { exact: true })).toBeChecked();
  expect(state.creates).toBe(0);
  expect(state.searches).toBe(0);
});

// Entirely synthetic browser contracts. No cloud provider or real biometric requests.
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfWQAAAAASUVORK5CYII=',
  'base64',
);
async function fixture(page: Page) {
  await page.addInitScript(() => {
    const metrics = window as Window & { __discoverUploadSizes: number[] };
    metrics.__discoverUploadSizes = [];
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (
        typeof input === 'string' &&
        /^\/api\/discover\/scans\/[^/]+\/search$/.test(input)
      )
        metrics.__discoverUploadSizes.push(
          init?.body instanceof Blob ? init.body.size : 0,
        );
      return original(input, init);
    };
  });
  const photos = [0, 1].map((i) => ({
    id: `source-${i}`,
    filename: `Source ${i}.jpg`,
    createdAt: '2026-09-21T00:00:00Z',
    bytes: 100,
    width: 1,
    height: 1,
  }));
  const state = {
    scan: null as DiscoverScan | null,
    creates: 0,
    searches: 0,
    pauses: 0,
    retries: [] as { requestId: string; retryUncertain: boolean }[],
    loseCreate: false,
    loseResume: false,
    unavailable: false,
    uncertain: false,
  };
  function save(requestId: string) {
    state.scan = {
      id: 'scan',
      requestId: state.scan?.requestId ?? requestId,
      state: 'running',
      imported: 0,
      indexed: 0,
      errors: [],
      createdAt: '2026-09-21T00:00:00Z',
      matches: [],
      resultsRetained: false,
      processing: {
        id: requestId,
        requestId,
        type: 'discover-library',
        status: 'queued',
        total: 2,
        processed: 0,
        indexed: 0,
        empty: 0,
        failed: 0,
        cancelRequested: false,
      },
    };
  }
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'owner',
            name: 'Synthetic owner',
            email: 'owner@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/capabilities')
      return route.fulfill({
        json: {
          storage: true,
          drive: false,
          driveOAuth: false,
          faceMatching: true,
          durableDiscover: true,
          discoverJobLimit: 10000,
          faceIndexMax: 20,
          photoLimit: 25000,
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: {
          photos,
          events: [],
          jobs: [],
          scans: state.scan ? [state.scan] : [],
          photoLimit: 25000,
        },
      });
    if (path === '/api/discover/scans' && req.method() === 'POST') {
      state.creates++;
      const body = req.postDataJSON();
      expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
      expect(body.consent).toBe(true);
      expect(body.photoIds).toEqual(['source-0', 'source-1']);
      save(body.requestId as string);
      return route.fulfill(
        state.loseCreate
          ? {
              status: 503,
              json: { error: { message: 'Synthetic lost create reply.' } },
            }
          : { status: 202, json: { scan: state.scan } },
      );
    }
    if (path === '/api/discover/scans/scan' && req.method() === 'GET')
      return route.fulfill(
        state.unavailable
          ? {
              status: 503,
              json: {
                error: {
                  message: 'Processing status is temporarily unavailable.',
                },
              },
            }
          : { json: { scan: state.scan, matches: [] } },
      );
    if (path === '/api/discover/scans/scan/processing/cancel') {
      state.pauses++;
      state.scan!.state = 'failed';
      state.scan!.processing!.status = 'cancelled';
      state.scan!.processing!.cancelRequested = true;
      return route.fulfill({ json: { scan: state.scan } });
    }
    if (path === '/api/discover/scans/scan/processing') {
      const body = req.postDataJSON() as {
        requestId: string;
        retryUncertain: boolean;
      };
      state.retries.push(body);
      if (state.uncertain && !body.retryUncertain)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              message:
                'A previous provider attempt may already have been charged. Explicitly allow a new paid attempt before resuming.',
            },
          },
        });
      save(body.requestId);
      return route.fulfill(
        state.loseResume
          ? {
              status: 503,
              json: { error: { message: 'Synthetic lost resume reply.' } },
            }
          : { status: 202, json: { scan: state.scan } },
      );
    }
    if (path === '/api/discover/scans/scan/search') {
      state.searches++;
      expect(req.headers()['content-type']).toBe('application/octet-stream');
      // WebKit does not expose file-backed upload bytes through this protocol field.
      const exposed = req.postDataBuffer();
      if (exposed) expect(exposed.length).toBeGreaterThan(0);
      return route.fulfill({
        json: {
          scan: state.scan,
          matches: [
            {
              photoId: 'prepared',
              filename: 'Your moment.jpg',
              similarity: 97,
              width: 1,
              height: 1,
            },
          ],
        },
      });
    }
    if (path.endsWith('/file'))
      return route.fulfill({ contentType: 'image/png', body: pixel });
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Unexpected synthetic request.' } },
    });
  });
  await page.goto('/app/discover/new');
  return state;
}
async function enqueue(page: Page) {
  await page.getByLabel('Source 0.jpg', { exact: true }).check();
  await page.getByLabel('Source 1.jpg', { exact: true }).check();
  await page.getByLabel('Reference selfie', { exact: true }).setInputFiles({
    name: 'synthetic.png',
    mimeType: 'image/png',
    buffer: pixel,
  });
  await page
    .getByRole('checkbox', { name: /I understand Amazon Rekognition/ })
    .check();
  await page
    .getByRole('button', { name: 'Find my photos', exact: true })
    .click();
}
test('Discover processing survives reload, pauses and resumes without sending the selfie automatically', async ({
  page,
}) => {
  const state = await fixture(page);
  await enqueue(page);
  const panel = page.getByRole('region', {
    name: 'Saved collection processing',
  });
  await expect(panel.getByRole('progressbar')).toHaveAttribute('value', '0');
  expect(state.creates).toBe(1);
  expect(state.searches).toBe(0);
  await page.reload();
  await page.getByRole('button', { name: /photos \/ running/ }).click();
  await expect(panel).toBeVisible();
  await panel
    .getByRole('button', { name: 'Pause processing', exact: true })
    .click();
  await expect(
    panel.getByRole('button', { name: 'Resume remaining photos' }),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Resume remaining photos' }).click();
  await expect(
    panel.getByRole('button', { name: 'Pause processing', exact: true }),
  ).toBeVisible();
  expect(state.pauses).toBe(1);
  expect(state.retries).toHaveLength(1);
  expect(state.searches).toBe(0);
  state.scan!.state = 'complete';
  state.scan!.imported = 2;
  state.scan!.indexed = 2;
  Object.assign(state.scan!.processing!, {
    status: 'complete',
    processed: 2,
    indexed: 2,
  });
  await panel
    .getByRole('button', { name: 'Refresh processing status' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Search again', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Search again', exact: true }).click();
  expect(state.searches).toBe(0);
  await page
    .getByLabel('Reference selfie', { exact: true })
    .setInputFiles({ name: 'fresh.png', mimeType: 'image/png', buffer: pixel });
  await page
    .getByRole('checkbox', { name: /I understand Amazon Rekognition/ })
    .check();
  await page.getByRole('button', { name: 'Search again', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Your likely matches' }),
  ).toBeVisible();
  expect(state.searches).toBe(1);
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __discoverUploadSizes: number[] })
          .__discoverUploadSizes,
    ),
  ).toEqual([pixel.length]);
  expect(state.creates).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test('a lost creation response restores the saved collection without a second batch', async ({
  page,
}) => {
  const state = await fixture(page);
  state.loseCreate = true;
  await enqueue(page);
  await expect(
    page.getByText(
      'Your saved processing request was recovered. No second batch was started.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Pause processing', exact: true }),
  ).toBeVisible();
  expect(state.creates).toBe(1);
  expect(state.searches).toBe(0);
});
test('uncertain provider attempts need explicit paid retry consent and a lost resume response reconciles', async ({
  page,
}) => {
  const state = await fixture(page);
  await enqueue(page);
  await page
    .getByRole('button', { name: 'Pause processing', exact: true })
    .click();
  state.uncertain = true;
  await page.getByRole('button', { name: 'Resume remaining photos' }).click();
  await expect(
    page.getByText(/A previous provider attempt may already have been charged/),
  ).toBeVisible();
  expect(state.retries[0]!.retryUncertain).toBe(false);
  await page
    .getByRole('checkbox', { name: /I allow a new paid attempt/ })
    .check();
  state.loseResume = true;
  await page.getByRole('button', { name: 'Resume remaining photos' }).click();
  await expect(
    page.getByText(
      'Your saved resume request was recovered without another batch.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Pause processing', exact: true }),
  ).toBeVisible();
  expect(state.retries).toHaveLength(2);
  expect(state.retries[1]!.retryUncertain).toBe(true);
  expect(state.searches).toBe(0);
});
test('processing status outages offer manual recovery without resubmitting photos', async ({
  page,
}) => {
  const state = await fixture(page);
  await enqueue(page);
  state.unavailable = true;
  await page.getByRole('button', { name: 'Refresh processing status' }).click();
  await expect(
    page.getByText('Processing status is temporarily unavailable.').first(),
  ).toBeVisible();
  state.unavailable = false;
  await page.getByRole('button', { name: 'Refresh processing status' }).click();
  await expect(
    page.getByRole('region', { name: 'Saved collection processing' }),
  ).toBeVisible();
  expect(state.creates).toBe(1);
  expect(state.searches).toBe(0);
});
