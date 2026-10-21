import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { preflightFixture } from '../fixtures/upload-preflight';
import { questionnaireOrigin } from '../fixtures/questionnaires';
import {
  uploadQueueKey,
  type UploadQueue,
} from '../../packages/shared/src/upload-queue';

async function fixture(page: Page, folder = false) {
  const f = preflightFixture();
  const eventId = folder ? f.eventId : null;
  if (!folder) delete f.records.get(f.photos[0]!.id)!.eventId;
  const now = new Date().toISOString();
  const queue: UploadQueue = {
    schema: 1,
    id: randomUUID(),
    accountId: f.ownerId,
    eventId,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    mode: 'paused',
    items: f.items.map((item, index) => ({
      ...item,
      name: `private-${index}.jpg`,
      type: 'image/jpeg',
      status: 'pending',
      ...(folder
        ? { relativePaths: [`Shoot/Portraits/private-${index}.jpg`] }
        : {}),
    })),
    ...(folder
      ? {
          folders: [
            {
              path: 'Shoot/Portraits',
              title: 'Portraits',
              collectionId: randomUUID(),
              createCollection: false,
            },
          ],
        }
      : {}),
  };
  await page.addInitScript(
    ({ key, value }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    {
      key: uploadQueueKey(f.ownerId, eventId, folder),
      value: JSON.stringify(queue),
    },
  );
  const state = {
    actor: f.ownerId as string,
    checks: 0,
    uploads: 0,
    fail: false,
    mismatch: false,
    hold: false,
    release: null as (() => void) | null,
  };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url());
    const method = incoming.method().toLowerCase() as
      'get' | 'post' | 'put' | 'delete';
    const isCheck = url.pathname === '/api/photos/preflight';
    if (url.pathname === '/api/photos' && method === 'post') state.uploads++;
    if (isCheck) {
      state.checks++;
      if (state.fail)
        return route.fulfill({
          status: 503,
          json: { error: { message: 'Synthetic preflight storage failure.' } },
        });
    }
    const transport = request(f.app);
    let call = transport[method](url.pathname + url.search)
      .set('Origin', questionnaireOrigin)
      .set('Cookie', `picfind_session=${state.actor}`);
    for (const [name, value] of Object.entries(incoming.headers()))
      if (name.startsWith('x-picfind-')) call = call.set(name, value);
    if (incoming.postData()) call = call.send(JSON.parse(incoming.postData()!));
    const result = await call;
    if (isCheck && state.hold)
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    if (isCheck && state.mismatch) result.body.accountId = f.strangerId;
    await route
      .fulfill({
        status: result.status,
        contentType: 'application/json',
        body: result.status === 204 ? '' : JSON.stringify(result.body),
      })
      .catch(() => {});
  });
  const open = async () => {
    if (folder) {
      await page.goto(`/app/import?eventId=${f.eventId}`);
    } else {
      await page.goto('/app/library');
      await page
        .getByRole('button', { name: 'Add photos', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Use saved upload queue' })
        .click();
    }
    await expect(
      page.getByRole('button', { name: 'Check batch capacity' }),
    ).toBeEnabled();
  };
  return { ...f, queue, state, open };
}

test('saved direct batch checks current replay and capacity without originals or uploads', async ({
  page,
}) => {
  const f = await fixture(page);
  const before = JSON.stringify([...f.records]);
  await f.open();
  await page.getByRole('button', { name: 'Check batch capacity' }).click();
  const report = page.getByLabel('Batch capacity report');
  await expect(
    report.getByText('Current photo slots fit this batch.'),
  ).toBeVisible();
  await expect(
    report.getByText('Exact-input uploads available to recover'),
  ).toBeVisible();
  await expect(report.getByText('Files that may need new slots')).toBeVisible();
  await expect(report.getByText('360', { exact: true })).toBeVisible();
  await expect(report.getByText('240', { exact: true })).toBeVisible();
  await expect(report.getByText(/not a reservation/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start or resume batch' }),
  ).toBeDisabled();
  expect(f.state.uploads).toBe(0);
  expect(JSON.stringify([...f.records])).toBe(before);
  await report.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath('batch-preflight.png'),
  });
  await f.open();
  await expect(page.getByLabel('Batch capacity report')).toHaveCount(0);
  await page.getByRole('button', { name: 'Check batch capacity' }).click();
  await expect(page.getByLabel('Batch capacity report')).toBeVisible();
  expect(f.state.checks).toBe(2);
});

test('folder queue uses the same check with event capacity and keeps mapping state', async ({
  page,
}) => {
  const f = await fixture(page, true);
  await f.open();
  await page.getByRole('button', { name: 'Check batch capacity' }).click();
  const report = page.getByLabel('Batch capacity report');
  await expect(report.getByText('Event photo slots remaining')).toBeVisible();
  await expect(
    report.getByText('Current photo slots fit this batch.'),
  ).toBeVisible();
  expect(f.state.uploads).toBe(0);
  await expect(
    page.getByText('0 of 2 uploads acknowledged. Queue: paused.'),
  ).toBeVisible();
});

test('failed refresh removes the older report and a retry recovers', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await page.getByRole('button', { name: 'Check batch capacity' }).click();
  await expect(page.getByLabel('Batch capacity report')).toBeVisible();
  f.state.fail = true;
  await page.getByRole('button', { name: 'Check batch capacity' }).click();
  await expect(
    page.getByText('Synthetic preflight storage failure.'),
  ).toBeVisible();
  await expect(page.getByLabel('Batch capacity report')).toHaveCount(0);
  f.state.fail = false;
  await page.getByRole('button', { name: 'Check batch capacity' }).click();
  await expect(page.getByLabel('Batch capacity report')).toBeVisible();
});

test('clearing a queue aborts a pending check and ignores its late reply', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  f.state.hold = true;
  await page.getByRole('button', { name: 'Check batch capacity' }).click();
  await expect.poll(() => Boolean(f.state.release)).toBe(true);
  await page.getByRole('button', { name: 'Clear saved queue' }).click();
  await expect(
    page.getByRole('button', { name: 'Check batch capacity' }),
  ).toHaveCount(0);
  f.state.release?.();
  await expect(page.getByLabel('Batch capacity report')).toHaveCount(0);
  expect(f.state.uploads).toBe(0);
});

test('cancel permits another check and a mismatched account response is rejected', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  f.state.hold = true;
  await page.getByRole('button', { name: 'Check batch capacity' }).click();
  await expect.poll(() => Boolean(f.state.release)).toBe(true);
  await page.getByRole('button', { name: 'Cancel batch check' }).click();
  f.state.hold = false;
  f.state.release?.();
  f.state.mismatch = true;
  await page.getByRole('button', { name: 'Check batch capacity' }).click();
  await expect(
    page.getByText(
      'The batch check no longer matches this account and queue. Check again.',
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Batch capacity report')).toHaveCount(0);
});

test('account changes hide the previous private batch and report', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await page.getByRole('button', { name: 'Check batch capacity' }).click();
  await expect(page.getByLabel('Batch capacity report')).toBeVisible();
  f.state.actor = f.strangerId;
  await page.evaluate(() =>
    window.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(page.getByLabel('Batch capacity report')).toHaveCount(0);
  await expect(page.getByText('private-0.jpg', { exact: false })).toHaveCount(
    0,
  );
});
