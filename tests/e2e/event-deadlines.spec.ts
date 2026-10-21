import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ICAL from 'ical.js';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { deadlineFixture } from '../fixtures/event-deadlines';
import { questionnaireOrigin } from '../fixtures/questionnaires';

async function fixture(page: Page) {
  const f = deadlineFixture();
  const state = {
    actor: f.ownerId,
    failRead: false,
    holdRead: false,
    held: false,
    release: null as (() => void) | null,
    reads: 0,
    completedReads: 0,
  };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url()),
      path = url.pathname + url.search;
    if (path === f.deadlineRoot) {
      state.reads++;
      if (state.failRead)
        return route.fulfill({
          status: 503,
          json: { error: { message: 'Synthetic deadline read failure.' } },
        });
      if (state.holdRead)
        await new Promise<void>((resolve) => {
          state.held = true;
          state.release = resolve;
        });
    }
    const method = incoming.method().toLowerCase() as
        'get' | 'post' | 'put' | 'patch' | 'delete',
      transport = request(f.app);
    let call = transport[method](path).set('Origin', questionnaireOrigin);
    if (state.actor)
      call = call.set('Cookie', `picfind_session=${state.actor}`);
    const header = incoming.headers()['x-picfind-deadline-actor'];
    if (header) call = call.set('X-PicFind-Deadline-Actor', header);
    if (incoming.postData()) call = call.send(incoming.postDataJSON());
    const response = await call;
    await route
      .fulfill({
        status: response.status,
        contentType: 'application/json',
        body: response.status === 204 ? '' : JSON.stringify(response.body),
      })
      .catch(() => {});
    if (path === f.deadlineRoot) state.completedReads++;
  });
  const open = async () => {
    await page.goto('/app/event-deadlines');
    await expect(
      page.getByRole('heading', { name: 'Event access planner', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: 'Download future deadlines',
        exact: true,
      }),
    ).toBeEnabled();
  };
  const focus = () =>
    page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  const calendar = async () => {
    const pending = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Download future deadlines', exact: true })
      .click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe(
      'picfind-event-access-deadlines.ics',
    );
    return new ICAL.Component(
      ICAL.parse(await readFile((await download.path())!, 'utf8')),
    );
  };
  return { ...f, state, open, focus, calendar };
}
const results = (page: Page) =>
  page.getByRole('region', { name: 'Owned event deadlines', exact: true });
test('opens from studio navigation and filters real owned access states on desktop and mobile', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.goto('/app/events');
  await expect(
    page.getByRole('heading', { name: 'Your events.', exact: true }),
  ).toBeVisible();
  const toggle = page.getByRole('button', {
    name: 'Toggle studio navigation',
    exact: true,
  });
  if (await toggle.isVisible()) await toggle.click();
  await page
    .getByRole('link', { name: 'Event deadlines', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Event access planner', exact: true }),
  ).toBeVisible();
  await expect(results(page).getByRole('article')).toHaveCount(5);
  await expect(results(page)).not.toContainText('Another photographer');
  await page.screenshot({
    path: info.outputPath('event-deadline-planner.png'),
    fullPage: true,
  });
  await page
    .getByRole('combobox', { name: 'Deadline state', exact: true })
    .selectOption('soon');
  await expect(results(page).getByRole('article')).toHaveCount(1);
  await expect(results(page)).toContainText('Portrait deadline');
  await page
    .getByRole('combobox', { name: 'Deadline state', exact: true })
    .selectOption('expired');
  await expect(results(page)).toContainText('Expired gallery');
  await expect(
    page.getByRole('button', {
      name: 'Download future deadlines',
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole('combobox', { name: 'Deadline state', exact: true })
    .selectOption('all');
  await page.getByLabel('Find event', { exact: true }).fill('conference');
  await expect(results(page).getByRole('article')).toHaveCount(1);
  await expect(
    page.getByRole('link', { name: 'Review Conference delivery', exact: true }),
  ).toHaveAttribute('href', `/app/events/${f.events[1]!.id}`);
});
test('exports a fresh filtered calendar and respects the selected alarm without sending messages', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await page
    .getByRole('combobox', { name: 'Calendar alarm', exact: true })
    .selectOption('week');
  f.records.get(f.events[1]!.id)!.title = 'Fresh conference title';
  const calendar = await f.calendar(),
    events = calendar.getAllSubcomponents('vevent');
  expect(events).toHaveLength(2);
  expect(
    events.some((component) =>
      String(component.getFirstPropertyValue('summary')).includes(
        'Fresh conference title',
      ),
    ),
  ).toBe(true);
  expect(
    events.flatMap((component) => component.getAllSubcomponents('valarm')),
  ).toHaveLength(1);
  expect(
    events.flatMap((component) => component.getAllProperties('attendee')),
  ).toHaveLength(0);
  await expect(page.getByRole('status')).toContainText(
    'Past alarm triggers omitted: 1',
  );
  expect(f.state.reads).toBeGreaterThanOrEqual(2);
  await page.getByLabel('Find event', { exact: true }).fill('Fresh conference');
  await expect(page.getByRole('status')).toHaveCount(0);
  expect((await f.calendar()).getAllSubcomponents('vevent')).toHaveLength(1);
});
test('does not download stale future deadlines after they are archived or removed', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  let downloads = 0;
  page.on('download', () => downloads++);
  f.records.get(f.events[0]!.id)!.archived = true;
  f.records.delete(f.events[1]!.id);
  await page
    .getByRole('button', { name: 'Download future deadlines', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'No future active event deadlines',
  );
  await expect(
    page.getByRole('button', {
      name: 'Download future deadlines',
      exact: true,
    }),
  ).toBeDisabled();
  expect(downloads).toBe(0);
});
test('hides failed snapshots and private event names after an account change', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  f.state.failRead = true;
  await f.focus();
  await expect(
    page.getByText('Synthetic deadline read failure.', { exact: true }),
  ).toBeVisible();
  await expect(results(page)).toHaveCount(0);
  await expect(
    page.getByText('No events match these filters.', { exact: true }),
  ).toHaveCount(0);
  f.state.failRead = false;
  await page
    .getByRole('button', { name: 'Refresh event deadlines', exact: true })
    .click();
  await expect(results(page).getByRole('article')).toHaveCount(5);
  f.state.actor = f.strangerId;
  await f.focus();
  await expect(
    page.getByRole('heading', { name: 'Portrait deadline', exact: true }),
  ).toHaveCount(0);
  await expect(results(page)).toContainText('Another photographer');
});
test('cancels a pending calendar export when navigating away', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  let downloads = 0;
  page.on('download', () => downloads++);
  f.state.holdRead = true;
  await page
    .getByRole('button', { name: 'Download future deadlines', exact: true })
    .click();
  await expect.poll(() => f.state.held).toBe(true);
  await expect(page.getByLabel('Find event', { exact: true })).toBeDisabled();
  const completed = f.state.completedReads;
  await page.goto('/app/projects');
  f.state.holdRead = false;
  f.state.release?.();
  await expect(
    page.getByRole('heading', { name: 'Projects', exact: true }),
  ).toBeVisible();
  await expect.poll(() => f.state.completedReads).toBeGreaterThan(completed);
  expect(downloads).toBe(0);
});
test('exports all matching records beyond the first rendered page', async ({
  page,
}) => {
  const f = await fixture(page);
  for (let index = 0; index < 60; index++) {
    const row = {
      ...f.events[1]!,
      id: randomUUID(),
      title: `Batch event ${index}`,
    };
    f.records.set(row.id, row);
  }
  await f.open();
  await expect(results(page).getByRole('article')).toHaveCount(30);
  await page
    .getByRole('button', { name: 'Show more event deadlines', exact: true })
    .click();
  await expect(results(page).getByRole('article')).toHaveCount(60);
  const calendar = await f.calendar();
  expect(calendar.getAllSubcomponents('vevent')).toHaveLength(62);
  await page.getByLabel('Find event', { exact: true }).fill('Batch event 59');
  await expect(results(page).getByRole('article')).toHaveCount(1);
});
