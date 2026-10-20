import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { creditFixture } from '../fixtures/credit-presets';
import { questionnaireOrigin } from '../fixtures/questionnaires';

async function fixture(page: Page) {
  const f = creditFixture();
  const state = {
    actor: f.ownerId as string,
    failId: '',
    loseReplyId: '',
    holdId: '',
    release: null as (() => void) | null,
    readsFail: false,
  };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      path = new URL(incoming.url()).pathname + new URL(incoming.url()).search,
      method = incoming.method().toLowerCase() as
        'get' | 'post' | 'put' | 'patch' | 'delete';
    if (
      state.readsFail &&
      method === 'get' &&
      path.startsWith('/api/studio/credit-presets')
    )
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Synthetic preset outage.' },
        }),
      });
    if (method === 'patch' && state.failId && path.includes(state.failId)) {
      state.failId = '';
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Synthetic credit save failure.' },
        }),
      });
    }
    if (method === 'patch' && state.holdId && path.includes(state.holdId))
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    let call = request(f.app)[method](path).set('Origin', questionnaireOrigin);
    if (state.actor)
      call = call.set('Cookie', `picfind_session=${state.actor}`);
    const actor = incoming.headers()['x-picfind-credit-actor'];
    if (actor) call = call.set('X-PicFind-Credit-Actor', actor);
    const body = incoming.postData();
    if (body) call = call.send(JSON.parse(body));
    const result = await call;
    if (
      method === 'patch' &&
      state.loseReplyId &&
      path.includes(state.loseReplyId) &&
      result.status === 200
    ) {
      state.loseReplyId = '';
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Synthetic committed reply loss.' },
        }),
      });
    }
    await route
      .fulfill({
        status: result.status,
        contentType: 'application/json',
        body: result.status === 204 ? '' : JSON.stringify(result.body),
      })
      .catch(() => {});
  });
  const open = async () => {
    await page.goto('/app/credits');
    await expect(
      page.getByRole('heading', { name: 'Photo credits', exact: true }),
    ).toBeVisible();
  };
  return { ...f, state, open };
}
async function selectPhotos(page: Page, count = 3) {
  for (let index = 1; index <= count; index++)
    await page
      .getByRole('checkbox', { name: `portrait-${index}.jpg`, exact: true })
      .check();
}
async function prepare(page: Page, name = 'Asha Photography') {
  await page
    .getByRole('textbox', { name: 'Batch credit name', exact: true })
    .fill(name);
  await selectPhotos(page);
  await page.getByRole('button', { name: 'Preview credit changes' }).click();
  await expect(
    page.getByRole('heading', { name: 'Review photo credit changes' }),
  ).toBeVisible();
}
async function apply(page: Page, remaining = false) {
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', {
      name: remaining
        ? 'Apply remaining credit changes'
        : 'Apply credit changes',
      exact: true,
    })
    .click();
}
test('saves and reloads a private preset and preserves existing photo credits by default', async ({
  page,
}, info) => {
  const f = await fixture(page),
    existing = f.photos[1]!;
  existing.attribution = {
    name: 'Second shooter',
    website: '',
    published: true,
    version: 1,
    updatedAt: existing.createdAt,
  };
  await page.goto('/app');
  if (info.project.name === 'webkit-mobile')
    await page
      .getByRole('button', { name: 'Toggle studio navigation' })
      .click();
  await page.getByRole('link', { name: 'Photo credits', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Preset label', exact: true })
    .fill('Main studio');
  await page
    .getByRole('textbox', { name: 'Preset credit name', exact: true })
    .fill('Asha Photography');
  await page
    .getByRole('textbox', { name: 'Preset website', exact: true })
    .fill('https://example.test/portfolio');
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Private preset saved' }),
  ).toBeVisible();
  expect(f.records.get(f.photos[0]!.id)?.attribution).toBeUndefined();
  await page.reload();
  await page
    .getByRole('combobox', { name: 'Saved preset', exact: true })
    .selectOption({ label: 'Main studio' });
  await page.getByRole('button', { name: 'Use saved preset in batch' }).click();
  await expect(
    page.getByRole('textbox', { name: 'Batch website', exact: true }),
  ).toHaveValue('https://example.test/portfolio');
  await expect(
    page.getByRole('checkbox', {
      name: 'Publish this credit with authorized photo delivery.',
    }),
  ).not.toBeChecked();
  await selectPhotos(page);
  await page.getByRole('button', { name: 'Preview credit changes' }).click();
  await expect(
    page.getByText('2 updates; 1 preserved or unchanged. 0 updates confirmed.'),
  ).toBeVisible();
  await expect(
    page
      .locator('.credit-preview-list li')
      .filter({ hasText: 'portrait-2.jpg' }),
  ).toContainText('preserved');
  await apply(page);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '2 photo credit updates confirmed' }),
  ).toBeVisible();
  expect(f.records.get(existing.id)?.attribution).toEqual(existing.attribution);
  expect(f.records.get(f.photos[0]!.id)?.attribution).toMatchObject({
    name: 'Asha Photography',
    published: false,
    version: 1,
  });
  await page
    .locator('.workspace-content')
    .evaluate((element) => element.scrollTo(0, 0));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('credit-presets.png'),
    fullPage: true,
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Remove preset', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Preset removed' }),
  ).toBeVisible();
  expect(f.records.get(f.photos[0]!.id)?.attribution?.name).toBe(
    'Asha Photography',
  );
});
test('requires explicit replacement and publication and invalidates preview after input changes', async ({
  page,
}) => {
  const f = await fixture(page),
    photo = f.photos[0]!;
  photo.attribution = {
    name: 'Old credit',
    website: '',
    published: false,
    version: 1,
    updatedAt: photo.createdAt,
  };
  await f.open();
  await prepare(page);
  await page
    .getByRole('checkbox', {
      name: 'Replace existing nonempty credits in this selection.',
    })
    .check();
  await expect(
    page.getByRole('heading', { name: 'Review photo credit changes' }),
  ).toHaveCount(0);
  await page
    .getByRole('checkbox', {
      name: 'Publish this credit with authorized photo delivery.',
    })
    .check();
  await page.getByRole('button', { name: 'Preview credit changes' }).click();
  await expect(
    page.getByText('3 updates; 0 preserved or unchanged. 0 updates confirmed.'),
  ).toBeVisible();
  await apply(page);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '3 photo credit updates confirmed' }),
  ).toBeVisible();
  expect(f.records.get(photo.id)?.attribution).toMatchObject({
    name: 'Asha Photography',
    published: true,
    version: 2,
  });
});
test('stops after a partial failure and retries only unfinished photo requests', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await prepare(page);
  f.state.failId = f.photos[1]!.id;
  await apply(page);
  await expect(page.getByText('Synthetic credit save failure.')).toBeVisible();
  await expect(
    page.getByText('3 updates; 0 preserved or unchanged. 1 updates confirmed.'),
  ).toBeVisible();
  expect(f.records.get(f.photos[2]!.id)?.attribution).toBeUndefined();
  await apply(page, true);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '3 photo credit updates confirmed' }),
  ).toBeVisible();
  f.photos.forEach((photo) =>
    expect(f.records.get(photo.id)?.attribution?.version).toBe(1),
  );
});
test('reconciles a committed photo update after its reply is lost', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await prepare(page);
  f.state.loseReplyId = f.photos[0]!.id;
  await apply(page);
  await expect(page.getByText('Synthetic committed reply loss.')).toBeVisible();
  expect(f.records.get(f.photos[0]!.id)?.attribution?.version).toBe(1);
  await apply(page);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '3 photo credit updates confirmed' }),
  ).toBeVisible();
  expect(f.records.get(f.photos[0]!.id)?.attribution?.version).toBe(1);
});
test('cancels further requests while retaining completed updates and reconciling an in-flight save', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await prepare(page);
  f.state.holdId = f.photos[1]!.id;
  await apply(page);
  await expect.poll(() => !!f.state.release).toBe(true);
  await page.getByRole('button', { name: 'Stop credit batch' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Batch stopped' }),
  ).toBeVisible();
  f.state.holdId = '';
  f.state.release!();
  await expect
    .poll(() => f.records.get(f.photos[1]!.id)?.attribution?.version)
    .toBe(1);
  expect(f.records.get(f.photos[2]!.id)?.attribution).toBeUndefined();
  await apply(page, true);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '3 photo credit updates confirmed' }),
  ).toBeVisible();
  f.photos.forEach((photo) =>
    expect(f.records.get(photo.id)?.attribution?.version).toBe(1),
  );
});
test('refuses a newer photographer credit instead of overwriting a stale preview', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await prepare(page);
  const photo = f.photos[0]!;
  f.records.get(photo.id)!.attribution = {
    name: 'Newer photographer',
    website: '',
    published: false,
    version: 1,
    updatedAt: photo.createdAt,
  };
  await apply(page);
  await expect(
    page.getByText(
      'Another edit changed this photographer credit. Load the latest version before saving.',
    ),
  ).toBeVisible();
  expect(f.records.get(photo.id)?.attribution?.name).toBe('Newer photographer');
  expect(f.records.get(f.photos[1]!.id)?.attribution).toBeUndefined();
});
test('hides private presets and preview after an account change on apply', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.open();
  await prepare(page);
  f.state.actor = f.clientId;
  await apply(page);
  await expect(
    page.getByText(
      'Your signed-in account changed. Reload photographer credits.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Batch credit name', exact: true }),
  ).toHaveCount(0);
  f.photos.forEach((photo) =>
    expect(f.records.get(photo.id)?.attribution).toBeUndefined(),
  );
});
test('preserves a stale preset draft and confirms reload before discarding it', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.open();
  await page
    .getByRole('combobox', { name: 'Saved preset', exact: true })
    .selectOption({ label: 'Main studio' });
  await page
    .getByRole('textbox', { name: 'Preset credit name', exact: true })
    .fill('Local unsaved name');
  await f.save({ name: 'Other tab name' }, 1).expect(200);
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(
    page.getByText('The credit preset changed. Reload before saving again.'),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Preset credit name', exact: true }),
  ).toHaveValue('Local unsaved name');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Reload presets' }).click();
  await expect(
    page.getByRole('textbox', { name: 'Preset credit name', exact: true }),
  ).toHaveValue('Local unsaved name');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reload presets' }).click();
  await expect(
    page.getByRole('textbox', { name: 'Preset credit name', exact: true }),
  ).toHaveValue('Other tab name');
});
test('selects a bounded page and preserves selected identities across filename filters', async ({
  page,
}) => {
  const f = await fixture(page);
  for (let index = 0; index < 104; index++) {
    const photo = {
      ...f.photos[0]!,
      id: randomUUID(),
      filename: `extra-${index}.jpg`,
    };
    f.records.set(photo.id, photo);
  }
  await f.open();
  await page.getByRole('button', { name: 'Select this page' }).click();
  await expect(
    page.getByText('100 / 100 photos selected across filters and pages.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Next photos' }).click();
  await expect(
    page.getByText('107 matching photos. Showing 7 from position 101.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Select this page' }),
  ).toBeDisabled();
  await page
    .getByRole('textbox', { name: 'Find photo filenames', exact: true })
    .fill('portrait-1');
  await expect(
    page.getByText('1 matching photos. Showing 1 from position 1.'),
  ).toBeVisible();
  await expect(
    page.getByText('100 / 100 photos selected across filters and pages.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await expect(
    page.getByText('0 / 100 photos selected across filters and pages.'),
  ).toBeVisible();
});
test('does not start later photo writes after navigating away during an in-flight batch', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await prepare(page);
  f.state.holdId = f.photos[0]!.id;
  await apply(page);
  await expect.poll(() => !!f.state.release).toBe(true);
  await page.getByRole('link', { name: 'PicFind home', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Photo credits', exact: true }),
  ).toHaveCount(0);
  f.state.holdId = '';
  f.state.release!();
  await expect
    .poll(() => f.records.get(f.photos[0]!.id)?.attribution?.version)
    .toBe(1);
  expect(f.records.get(f.photos[1]!.id)?.attribution).toBeUndefined();
  expect(f.records.get(f.photos[2]!.id)?.attribution).toBeUndefined();
});
