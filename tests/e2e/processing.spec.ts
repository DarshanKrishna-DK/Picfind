import { expect, test, type Page } from '@playwright/test';

// Synthetic API responses only. No real event indexing or cloud calls.
async function fixture(page: Page) {
  const event = {
    id: 'event',
    title: 'Synthetic studio event',
    visibility: 'private',
    archived: false,
    createdAt: '2026-09-21T00:00:00Z',
    date: '',
    description: '',
  };
  const photos = [0, 1].map((i) => ({
    id: `photo-${i}`,
    eventId: event.id,
    filename: `Synthetic ${i}.jpg`,
    bytes: 10,
    width: 10,
    height: 10,
    createdAt: '2026-09-21T00:00:00Z',
  }));
  type Job = {
    id: string;
    requestId: string;
    eventId: string;
    status: string;
    total: number;
    processed: number;
    indexed: number;
    empty: number;
    failed: number;
    cancelRequested: boolean;
    createdAt: string;
    updatedAt: string;
  };
  const state = {
    jobs: [] as Job[],
    calls: 0,
    loseAcknowledgement: false,
    unavailable: false,
    cancellations: 0,
  };
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'owner',
            name: 'Synthetic Owner',
            email: 'owner@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: { events: [event], photos, jobs: [], scans: [], photoLimit: 20 },
      });
    if (path === '/api/capabilities')
      return route.fulfill({
        json: {
          storage: true,
          drive: false,
          faceMatching: true,
          photoLimit: 20,
          faceIndexMax: 20,
          billing: false,
        },
      });
    if (path === '/api/sources')
      return route.fulfill({ json: { sources: [] } });
    if (path === '/api/events/event/insights')
      return route.fulfill({
        json: {
          photos: 2,
          indexed: 0,
          storageBytes: 20,
          submissions: 0,
          hasPasscode: false,
          brandingName: '',
          accentColor: '#173f37',
          selections: [],
        },
      });
    if (path === '/api/events/event/processing')
      return route.fulfill(
        state.unavailable
          ? {
              status: 503,
              json: {
                error: {
                  message: 'Processing status temporarily unavailable.',
                },
              },
            }
          : { json: { enabled: true, jobs: state.jobs } },
      );
    if (path === '/api/events/event/index-faces') {
      state.calls++;
      expect(req.headers()['x-picfind-consent']).toBe('face-matching-v1');
      const requestId = req.postDataJSON().requestId as string;
      expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
      const job = {
        id: 'synthetic-job',
        requestId,
        eventId: event.id,
        status: 'queued',
        total: 2,
        processed: 0,
        indexed: 0,
        empty: 0,
        failed: 0,
        cancelRequested: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.jobs = [job];
      return route.fulfill(
        state.loseAcknowledgement
          ? {
              status: 503,
              json: {
                error: {
                  message: 'Response was lost. Checking saved progress.',
                },
              },
            }
          : { status: 202, json: { job } },
      );
    }
    if (path === '/api/processing/jobs/synthetic-job/cancel') {
      state.cancellations++;
      state.jobs[0]!.status = 'cancelled';
      state.jobs[0]!.cancelRequested = true;
      return route.fulfill({ json: { job: state.jobs[0] } });
    }
    if (path.endsWith('/file')) return route.fulfill({ status: 204 });
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Unexpected synthetic request.' } },
    });
  });
  await page.goto('/app/events/event');
  await page.getByRole('tab', { name: 'Sharing' }).click();
  return state;
}

test('event indexing requires consent and its saved progress survives a page reload', async ({
  page,
}) => {
  const state = await fixture(page);
  const panel = page.getByRole('region', { name: 'Event face processing' });
  await expect(
    panel.getByRole('button', { name: 'Prepare face search' }),
  ).toBeDisabled();
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Prepare face search' }).click();
  await expect(
    panel.getByText('Waiting to start', { exact: true }),
  ).toBeVisible();
  expect(state.calls).toBe(1);
  await page.reload();
  await page.getByRole('tab', { name: 'Sharing' }).click();
  await expect(
    panel.getByRole('progressbar', { name: 'Photos processed' }),
  ).toHaveAttribute('value', '0');
  await panel
    .getByRole('button', { name: 'Stop processing', exact: true })
    .click();
  await expect(
    panel.getByText('Processing stopped', { exact: true }),
  ).toBeVisible();
  expect(state.cancellations).toBe(1);
  expect(state.calls).toBe(1);
});

test('a lost enqueue response reconciles saved work instead of submitting another paid batch', async ({
  page,
}) => {
  const state = await fixture(page);
  state.loseAcknowledgement = true;
  const panel = page.getByRole('region', { name: 'Event face processing' });
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Prepare face search' }).click();
  await expect(
    panel.getByText('Waiting to start', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Prepare face search' }),
  ).toHaveCount(0);
  expect(state.calls).toBe(1);
});

test('unavailable status has a recovery action and cannot start processing', async ({
  page,
}) => {
  const state = await fixture(page);
  state.unavailable = true;
  await page.reload();
  await page.getByRole('tab', { name: 'Sharing' }).click();
  const panel = page.getByRole('region', { name: 'Event face processing' });
  await expect(
    panel.getByRole('button', { name: 'Prepare face search' }),
  ).toBeDisabled();
  await expect(
    panel.getByText('Processing status temporarily unavailable.'),
  ).toBeVisible();
  state.unavailable = false;
  await panel.getByRole('button', { name: 'Retry processing status' }).click();
  await expect(panel.getByRole('checkbox')).toBeEnabled();
  expect(state.calls).toBe(0);
});
