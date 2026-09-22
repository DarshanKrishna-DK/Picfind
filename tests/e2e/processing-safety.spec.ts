import { expect, test, type Page } from '@playwright/test';

async function processingFixture(
  page: Page,
  deleting = false,
  lostReply = false,
) {
  const event = {
    id: 'synthetic-event',
    title: 'Synthetic processing safety',
    description: '',
    date: '',
    visibility: 'private',
    archived: false,
    expiresAt: '',
    createdAt: '2026-09-21T00:00:00Z',
  };
  let submitted: { requestId: string; retryUncertain: boolean } | undefined;
  let job: Record<string, unknown> | undefined;
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'synthetic-owner',
            name: 'Synthetic owner',
            email: 'owner@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/capabilities' || path === '/api/auth/capabilities')
      return route.fulfill({
        json: {
          storage: true,
          faceMatching: true,
          faceIndexMax: 20,
          photoLimit: 20,
          billing: false,
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: {
          events: [event],
          photos: [
            {
              id: 'synthetic-photo',
              eventId: event.id,
              filename: 'Synthetic.jpg',
              createdAt: event.createdAt,
              width: 1,
              height: 1,
              bytes: 10,
            },
          ],
          jobs: [],
          scans: [],
          photoLimit: 20,
        },
      });
    if (path === `/api/events/${event.id}/processing`)
      return route.fulfill({
        json: {
          enabled: true,
          jobs: job ? [job] : [],
          retryUncertainRequired: !job,
          deleting,
        },
      });
    if (path === `/api/events/${event.id}/index-faces`) {
      expect(req.headers()['x-picfind-consent']).toBe('face-matching-v1');
      submitted = req.postDataJSON();
      job = {
        id: 'a'.repeat(36),
        requestId: submitted!.requestId,
        status: 'queued',
        total: 1,
        processed: 0,
        indexed: 0,
        empty: 0,
        failed: 0,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      };
      return route.fulfill(
        lostReply
          ? {
              status: 503,
              json: { error: { message: 'Synthetic lost acknowledgement.' } },
            }
          : { status: 202, json: { job } },
      );
    }
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Unused synthetic endpoint.' } },
    });
  });
  await page.goto(`/app/events/${event.id}`);
  await page.getByRole('tab', { name: 'Sharing', exact: true }).click();
  return { submitted: () => submitted };
}

test('uncertain cloud retry requires a second deliberate consent before submission', async ({
  page,
}) => {
  const state = await processingFixture(page);
  const prepare = page.getByRole('button', { name: /Prepare face search/i });
  const checks = page.getByRole('checkbox');
  await expect(checks).toHaveCount(2);
  await expect(prepare).toBeDisabled();
  await checks.nth(0).check();
  await expect(prepare).toBeDisabled();
  expect(state.submitted()).toBeUndefined();
  await checks.nth(1).check();
  await expect(prepare).toBeEnabled();
  await prepare.click();
  await expect.poll(() => state.submitted()?.retryUncertain).toBe(true);
  expect(state.submitted()?.requestId).toMatch(/^[a-f0-9-]{36}$/);
  await expect(
    page.getByRole('progressbar', { name: 'Photos processed' }),
  ).toBeVisible();
});

test('a deleting event cannot submit another processing job', async ({
  page,
}) => {
  const state = await processingFixture(page, true);
  await expect(
    page.getByText(/deletion.*started|being deleted|deletion.*progress/i),
  ).toBeVisible();
  const prepare = page.getByRole('button', { name: /Prepare face search/i });
  if (await prepare.count()) await expect(prepare).toBeDisabled();
  expect(state.submitted()).toBeUndefined();
});

test('a reconciled saved job clears the misleading lost-response error', async ({
  page,
}) => {
  await processingFixture(page, false, true);
  await page
    .getByLabel('I have permission to process these photos for face matching.')
    .check();
  await page
    .getByLabel(
      'I authorize another processing attempt for these unresolved photos.',
    )
    .check();
  await page.getByRole('button', { name: 'Prepare face search' }).click();
  await expect(
    page.getByRole('progressbar', { name: 'Photos processed' }),
  ).toBeVisible();
  await expect(page.getByText('Synthetic lost acknowledgement.')).toHaveCount(
    0,
  );
});
