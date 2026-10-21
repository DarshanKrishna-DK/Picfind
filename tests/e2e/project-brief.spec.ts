import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { briefFixture } from '../fixtures/project-brief';
import { questionnaireOrigin } from '../fixtures/questionnaires';
async function fixture(page: Page) {
  const f = briefFixture(),
    state = {
      actor: f.ownerId,
      fail: false,
      hold: false,
      held: false,
      release: null as (() => void) | null,
      completed: 0,
    };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url()),
      isBrief = url.pathname === f.briefRoot;
    if (isBrief && state.fail)
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Synthetic brief read failure.' } },
      });
    if (isBrief && state.hold)
      await new Promise<void>((resolve) => {
        state.held = true;
        state.release = resolve;
      });
    const method = incoming.method().toLowerCase() as
        'get' | 'put' | 'post' | 'delete' | 'patch',
      transport = request(f.app);
    let call = transport[method](url.pathname + url.search).set(
      'Origin',
      questionnaireOrigin,
    );
    if (state.actor)
      call = call.set('Cookie', `picfind_session=${state.actor}`);
    const actor = incoming.headers()['x-picfind-brief-actor'];
    if (actor) call = call.set('X-PicFind-Brief-Actor', actor);
    if (incoming.postData()) call = call.send(incoming.postDataJSON());
    const response = await call;
    await route
      .fulfill({
        status: response.status,
        contentType: 'application/json',
        body: response.status === 204 ? '' : JSON.stringify(response.body),
      })
      .catch(() => {});
    if (isBrief) state.completed++;
  });
  const open = async () => {
    await page.goto(`/app/projects/${f.projectId}/brief`);
    await expect(
      page.getByRole('button', { name: 'Download text brief', exact: true }),
    ).toBeEnabled();
  };
  const download = async (format: 'text' | 'JSON') => {
    const pending = page.waitForEvent('download');
    await page
      .getByRole('button', { name: `Download ${format} brief`, exact: true })
      .click();
    const file = await pending;
    expect(file.suggestedFilename()).toBe(
      `picfind-project-${f.projectId}-brief.${format === 'text' ? 'txt' : 'json'}`,
    );
    return readFile((await file.path())!, 'utf8');
  };
  const focus = () =>
    page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  return { ...f, state, open, download, focus };
}
const preview = (page: Page) =>
  page.getByRole('region', { name: 'Production brief preview', exact: true });
test('opens from projects and reviews complete work with notes omitted by default', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.goto('/app/projects');
  await page.getByRole('button', { name: /Portrait session/ }).click();
  await page
    .getByRole('link', { name: 'Production brief', exact: true })
    .click();
  await expect(preview(page)).toContainText('Deliver edited portraits');
  await expect(preview(page)).toContainText('Portrait shoot');
  await expect(preview(page)).toContainText('Unavailable linked event');
  await expect(preview(page)).not.toContainText('Private project instructions');
  await expect(
    page.getByLabel('Include private project and work notes', { exact: true }),
  ).not.toBeChecked();
  await preview(page)
    .getByRole('heading', { name: 'Milestones (1)', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('project-production-brief.png'),
    fullPage: true,
  });
  const text = await f.download('text');
  expect(text).toContain('Private notes: omitted');
  expect(text).toContain('Portrait shoot');
  expect(text).not.toContain('Private appointment note');
  expect(text).not.toContain('Confidential foreign title');
});
test('includes notes only after explicit choice and clears them when the mode is disabled', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  const checkbox = page.getByLabel('Include private project and work notes', {
    exact: true,
  });
  await checkbox.check();
  await expect(preview(page)).toContainText('Private project instructions');
  await expect(preview(page)).toContainText('Private milestone note');
  const json = JSON.parse(await f.download('JSON'));
  expect(json.notes).toBe('include');
  expect(json.appointments[0].note).toBe('Private appointment note');
  await checkbox.uncheck();
  await expect(preview(page)).not.toContainText('Private project instructions');
  await expect(page.getByRole('status')).toHaveCount(0);
  const clean = JSON.parse(await f.download('JSON'));
  expect(clean.project.summary).toBeUndefined();
  expect(clean.milestones[0].note).toBeUndefined();
});
test('downloads fresh project and work values instead of the old preview', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  f.records.get(f.projectId)!.studioProject!.name = 'Updated portrait plan';
  f.records.get(f.appointmentId)!.studioAppointment!.status = 'cancelled';
  const json = JSON.parse(await f.download('JSON'));
  expect(json.project.name).toBe('Updated portrait plan');
  expect(json.appointments[0].status).toBe('cancelled');
  await expect(preview(page)).toContainText('Updated portrait plan');
  await expect(preview(page)).toContainText('cancelled');
});
test('reports export failures without a download and recovers through refresh', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  let downloads = 0;
  page.on('download', () => downloads++);
  f.state.fail = true;
  await page
    .getByRole('button', { name: 'Download text brief', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic brief read failure.',
  );
  expect(downloads).toBe(0);
  await page
    .getByRole('button', { name: 'Refresh production brief', exact: true })
    .click();
  await expect(preview(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Download text brief', exact: true }),
  ).toBeDisabled();
  f.state.fail = false;
  await page
    .getByRole('button', { name: 'Refresh production brief', exact: true })
    .click();
  await expect(preview(page)).toContainText('Portrait session');
  expect(JSON.parse(await f.download('JSON')).notes).toBe('omit');
});
test('hides private notes on account change and denies removed projects at fresh download', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await page
    .getByLabel('Include private project and work notes', { exact: true })
    .check();
  await expect(preview(page)).toContainText('Private appointment note');
  f.state.actor = f.strangerId;
  await f.focus();
  await expect(preview(page)).toHaveCount(0);
  await expect(
    page.getByText('Private appointment note', { exact: true }),
  ).toHaveCount(0);
  f.state.actor = f.ownerId;
  await f.open();
  f.records.delete(f.projectId);
  let downloads = 0;
  page.on('download', () => downloads++);
  await page
    .getByRole('button', { name: 'Download text brief', exact: true })
    .click();
  await expect(preview(page)).toHaveCount(0);
  expect(downloads).toBe(0);
});
test('aborts held downloads after navigation and locks disclosure changes while pending', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  let downloads = 0;
  page.on('download', () => downloads++);
  f.state.hold = true;
  await page
    .getByRole('button', { name: 'Download text brief', exact: true })
    .click();
  await expect.poll(() => f.state.held).toBe(true);
  await expect(
    page.getByLabel('Include private project and work notes', { exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('link', { name: 'Back to projects', exact: true })
    .click();
  await expect(page).toHaveURL(/\/app\/projects$/);
  const completed = f.state.completed;
  f.state.hold = false;
  f.state.release!();
  await expect.poll(() => f.state.completed).toBeGreaterThan(completed);
  expect(downloads).toBe(0);
});
