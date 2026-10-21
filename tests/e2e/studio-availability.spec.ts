import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { availabilityFixture } from '../fixtures/studio-availability';
import { randomUUID } from 'node:crypto';
import { questionnaireOrigin } from '../fixtures/questionnaires';
async function fixture(page: Page) {
  const f = availabilityFixture(),
    state = {
      actor: f.ownerId,
      fail: false,
      hold: false,
      held: false,
      release: null as (() => void) | null,
      writes: 0,
      completed: 0,
      loseReply: false,
      payloads: [] as Record<string, unknown>[],
    };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url()),
      isWrite =
        url.pathname.startsWith(f.availabilityRoot) &&
        incoming.method() === 'PUT';
    if (url.pathname === f.availabilityRoot && state.fail)
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Synthetic availability read failure.' } },
      });
    if (isWrite) {
      state.writes++;
      state.payloads.push(incoming.postDataJSON() as Record<string, unknown>);
      if (state.hold)
        await new Promise<void>((resolve) => {
          state.held = true;
          state.release = resolve;
        });
    }
    const method = incoming.method().toLowerCase() as
      'get' | 'put' | 'post' | 'delete' | 'patch';
    const transport = request(f.app);
    let call = transport[method](url.pathname + url.search).set(
      'Origin',
      questionnaireOrigin,
    );
    if (state.actor)
      call = call.set('Cookie', `picfind_session=${state.actor}`);
    const actor = incoming.headers()['x-picfind-studio-actor'];
    if (actor) call = call.set('X-PicFind-Studio-Actor', actor);
    if (incoming.postData()) call = call.send(incoming.postDataJSON());
    const response = await call;
    if (isWrite && state.loseReply && response.status === 200) {
      state.loseReply = false;
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Synthetic lost save response.' } },
      });
    }
    await route
      .fulfill({
        status: response.status,
        contentType: 'application/json',
        body: response.status === 204 ? '' : JSON.stringify(response.body),
      })
      .catch(() => {});
    if (isWrite) state.completed++;
  });
  const open = async () => {
    await page.goto('/app/availability');
    await expect(
      page.getByRole('region', { name: 'Saved unavailable time', exact: true }),
    ).toBeVisible();
  };
  const fill = async (title = 'Travel to venue') => {
    await page.getByLabel('Block title', { exact: true }).fill(title);
    await page
      .getByRole('textbox', { name: 'Private block note', exact: true })
      .fill('Private travel details');
    await page.getByLabel('Block timezone', { exact: true }).fill('UTC');
    await page
      .getByLabel('Start local time', { exact: true })
      .fill('2026-11-01T10:00');
    await page
      .getByLabel('End local time', { exact: true })
      .fill('2026-11-01T11:00');
  };
  return {
    ...f,
    state,
    open,
    fill,
    focus: () =>
      page.evaluate(() => window.dispatchEvent(new Event('visibilitychange'))),
  };
}
const save = (page: Page) =>
  page.getByRole('button', { name: 'Save unavailable time', exact: true });
test('recovers a lost save response using the same block identity and command', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await f.fill();
  f.state.loseReply = true;
  await save(page).click();
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic lost save response',
  );
  const first = [...f.records.values()].find(
    (row) => row.purpose === 'studio-availability',
  )!;
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(page.getByRole('status')).toContainText(
    'Unavailable-time block saved.',
  );
  const saved = [...f.records.values()].filter(
    (row) => row.purpose === 'studio-availability',
  );
  expect(saved).toEqual([first]);
  expect(saved[0]!.studioAvailability!.version).toBe(1);
  expect(f.state.writes).toBe(2);
  expect(f.state.payloads[0]).not.toHaveProperty('id');
  expect(f.state.payloads[1]).toEqual(f.state.payloads[0]);
});
test('keeps selected-block recovery available after a damaged peer rejects saving', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.create().expect(200);
  await f.open();
  await page
    .getByRole('button', { name: 'Travel to venue', exact: true })
    .click();
  const id = randomUUID();
  f.records.set(id, {
    ...f.records.get(f.id)!,
    id,
    deletionStartedAt: '',
    studioAvailability: { ...f.records.get(f.id)!.studioAvailability!, id },
  });
  await page
    .getByLabel('Block title', { exact: true })
    .fill('Draft requiring a scan');
  await save(page).click();
  await expect(page.getByRole('alert')).toContainText(
    'saved schedule needs repair',
  );
  await expect(
    page.getByRole('button', { name: 'Deactivate saved block', exact: true }),
  ).toBeEnabled();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Deactivate saved block', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('deactivated');
  expect(f.records.get(f.id)?.studioAvailability?.active).toBe(false);
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Remove saved block', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('removed');
  expect(f.records.has(f.id)).toBe(false);
  expect(f.records.has(id)).toBe(true);
});
test('opens from Schedule, persists privately and permits deactivation and removal', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.goto('/app/schedule');
  await page
    .getByRole('link', { name: 'Manage unavailable time', exact: true })
    .click();
  await f.fill();
  await save(page).click();
  await expect(page.getByRole('status')).toContainText(
    'Unavailable-time block saved.',
  );
  expect(
    [...f.records.values()].find((row) => row.purpose === 'studio-availability')
      ?.studioAvailability?.note,
  ).toBe('Private travel details');
  await page.reload();
  await page
    .getByRole('button', { name: 'Travel to venue', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Private block note', exact: true }),
  ).toHaveValue('Private travel details');
  await page.screenshot({
    path: info.outputPath('private-unavailable-time.png'),
    fullPage: true,
  });
  await page
    .getByRole('heading', { name: 'Edit unavailable time', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('private-unavailable-time-editor.png'),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole('button', { name: 'Deactivate saved block', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Saved unavailable time', exact: true }),
  ).toContainText('Inactive');
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Remove saved block', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'Unavailable-time block removed.',
  );
  expect(
    [...f.records.values()].filter(
      (row) => row.purpose === 'studio-availability',
    ),
  ).toHaveLength(0);
});
test('preserves an overlapping draft and allows correction without a reload', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.appoint().expect(200);
  await f.open();
  await f.fill();
  await save(page).click();
  await expect(page.getByRole('alert')).toContainText(
    'overlaps a scheduled appointment',
  );
  await expect(page.getByLabel('Block title', { exact: true })).toHaveValue(
    'Travel to venue',
  );
  await page
    .getByLabel('Start local time', { exact: true })
    .fill('2026-11-01T11:00');
  await page
    .getByLabel('End local time', { exact: true })
    .fill('2026-11-01T12:00');
  await save(page).click();
  await expect(page.getByRole('status')).toContainText(
    'Unavailable-time block saved.',
  );
  expect(f.state.writes).toBe(2);
});
test('preserves stale drafts and requires explicit discard before loading a newer version', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.create().expect(200);
  await f.open();
  await page
    .getByRole('button', { name: 'Travel to venue', exact: true })
    .click();
  await page
    .getByLabel('Block title', { exact: true })
    .fill('Unsaved travel changes');
  await f
    .create({ version: 1, title: 'Changed on another device' })
    .expect(200);
  await save(page).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Your draft is preserved' }),
  ).toBeVisible();
  await expect(save(page)).toBeDisabled();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('button', { name: 'Reload unavailable time', exact: true })
    .click();
  await expect(page.getByLabel('Block title', { exact: true })).toHaveValue(
    'Unsaved travel changes',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Reload unavailable time', exact: true })
    .click();
  await expect(page.getByLabel('Block title', { exact: true })).toHaveValue(
    'Changed on another device',
  );
  await expect(save(page)).toBeEnabled();
});
test('preserves drafts on read failure while saved-block deactivation and removal recover', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.create().expect(200);
  await f.open();
  await page
    .getByRole('button', { name: 'Travel to venue', exact: true })
    .click();
  await page.getByLabel('Block title', { exact: true }).fill('Unsaved draft');
  f.state.fail = true;
  await f.focus();
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic availability read failure',
  );
  await expect(page.getByLabel('Block title', { exact: true })).toHaveValue(
    'Unsaved draft',
  );
  await expect(save(page)).toBeDisabled();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Deactivate saved block', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('deactivated');
  expect(f.records.get(f.id)?.studioAvailability?.active).toBe(false);
  await expect(
    page.getByRole('region', { name: 'Saved unavailable time', exact: true }),
  ).toHaveCount(0);
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Remove saved block', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('removed');
  expect(f.records.has(f.id)).toBe(false);
  f.state.fail = false;
  await page
    .getByRole('button', { name: 'Reload unavailable time', exact: true })
    .click();
  await expect(
    page.getByText('No unavailable time is saved.', { exact: true }),
  ).toBeVisible();
});
test('rejects timezone gaps and requires explicit repeated-hour occurrences', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await f.fill();
  await page
    .getByLabel('Block timezone', { exact: true })
    .fill('America/New_York');
  await page
    .getByLabel('Start local time', { exact: true })
    .fill('2026-03-08T02:30');
  await expect(page.getByRole('alert')).toContainText('does not exist');
  await expect(save(page)).toBeDisabled();
  await page
    .getByLabel('Start local time', { exact: true })
    .fill('2026-11-01T01:30');
  await page
    .getByLabel('End local time', { exact: true })
    .fill('2026-11-01T01:30');
  await expect(save(page)).toBeDisabled();
  await page
    .getByRole('combobox', { name: 'Start occurrence', exact: true })
    .selectOption('2026-11-01T05:30:00.000Z');
  await page
    .getByRole('combobox', { name: 'End occurrence', exact: true })
    .selectOption('2026-11-01T06:30:00.000Z');
  await save(page).click();
  await expect(page.getByRole('status')).toContainText('saved');
});
test('locks pending writes, rejects late responses after URL change and recovers by reload', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await f.fill();
  f.state.hold = true;
  await save(page).click();
  await expect.poll(() => f.state.held).toBe(true);
  await expect(page.getByLabel('Block title', { exact: true })).toBeDisabled();
  await page.evaluate(() =>
    history.pushState({}, '', '/app/availability?different-view=1'),
  );
  f.state.release!();
  await expect.poll(() => f.state.completed).toBe(1);
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByLabel('Block title', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('Block title', { exact: true })).toHaveValue(
    'Travel to venue',
  );
  f.state.hold = false;
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Reload unavailable time', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Travel to venue', exact: true }),
  ).toBeVisible();
});
test('hides private values when the session changes and does not send the stale draft', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.create().expect(200);
  await f.open();
  await page
    .getByRole('button', { name: 'Travel to venue', exact: true })
    .click();
  f.state.actor = f.strangerId;
  await save(page).click();
  await expect(page.getByRole('alert')).toContainText(
    'signed-in account changed',
  );
  await expect(
    page.getByRole('textbox', { name: 'Private block note', exact: true }),
  ).toHaveCount(0);
  expect(f.records.get(f.id)?.studioAvailability?.version).toBe(1);
  await f.focus();
  await expect(
    page.getByText('No unavailable time is saved.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Block title', { exact: true })).toHaveValue('');
});
test('requires discard confirmation when selecting another block or starting a new draft', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.create().expect(200);
  await f.open();
  await f.fill('Unsaved work');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('button', { name: 'Travel to venue', exact: true })
    .click();
  await expect(page.getByLabel('Block title', { exact: true })).toHaveValue(
    'Unsaved work',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Travel to venue', exact: true })
    .click();
  await page
    .getByLabel('Block title', { exact: true })
    .fill('Edited saved block');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('button', { name: 'New unavailable-time block', exact: true })
    .click();
  await expect(page.getByLabel('Block title', { exact: true })).toHaveValue(
    'Edited saved block',
  );
});
