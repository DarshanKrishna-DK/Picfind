import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import sharp from 'sharp';
import { templateFixture } from '../fixtures/coverage-templates';
import { questionnaireOrigin } from '../fixtures/questionnaires';
import { coverageRecordId } from '../../apps/api/src/event-coverage';

async function fixture(page: Page) {
  const f = templateFixture();
  const image = await sharp({
    create: { width: 40, height: 30, channels: 3, background: '#477c79' },
  })
    .jpeg()
    .toBuffer();
  f.store.file = async () =>
    new Response(new Uint8Array(image), {
      headers: { 'content-type': 'image/jpeg' },
    });
  const state = {
    actor: f.ownerId,
    failRead: false,
    loseReply: false,
    holdRead: false,
    held: false,
    release: null as (() => void) | null,
  };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url()),
      path = url.pathname + url.search,
      method = incoming.method().toLowerCase() as
        'get' | 'put' | 'post' | 'patch' | 'delete';
    if (method === 'get' && path.startsWith(f.templateRoot) && state.failRead)
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Synthetic template read failure.' } },
      });
    if (
      method === 'get' &&
      path.startsWith(`${f.templateRoot}/`) &&
      state.holdRead
    )
      await new Promise<void>((resolve) => {
        state.held = true;
        state.release = resolve;
      });
    const transport = request(f.app);
    let call = transport[method](path).set('Origin', questionnaireOrigin);
    if (state.actor)
      call = call.set('Cookie', `picfind_session=${state.actor}`);
    for (const header of [
      'x-picfind-coverage-actor',
      'x-picfind-coverage-template-actor',
    ])
      if (incoming.headers()[header])
        call = call.set(header, incoming.headers()[header]!);
    if (incoming.postData()) call = call.send(incoming.postDataJSON());
    const response = await call;
    if (
      method === 'put' &&
      path.startsWith(f.templateRoot) &&
      state.loseReply &&
      response.status === 200
    ) {
      state.loseReply = false;
      return route.fulfill({
        status: 503,
        json: {
          error: { message: 'Synthetic committed template reply loss.' },
        },
      });
    }
    await route
      .fulfill({
        status: response.status,
        body: response.headers['content-type']?.startsWith('image/')
          ? response.body
          : response.text,
        contentType: response.headers['content-type'] ?? 'application/json',
      })
      .catch(() => {});
  });
  const seed = async (eventId = f.eventId) => {
    const items = [
      {
        id: randomUUID(),
        label: 'Family portraits',
        target: 3,
        note: 'Include both generations',
        photoIds: eventId === f.eventId ? [f.photos[0]!.id] : [],
      },
    ];
    await f
      .put(`/api/events/${eventId}/coverage`, { version: 0, items })
      .expect(200);
    return items;
  };
  const open = async (eventId = f.eventId) => {
    await page.goto(`/app/events/${eventId}`);
    await page.getByRole('tab', { name: 'Coverage', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Refresh templates', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole('combobox', { name: 'Reviewed template', exact: true }),
    ).toBeEnabled();
  };
  const select = async (id: string = f.templateId) =>
    page
      .getByRole('combobox', { name: 'Reviewed template', exact: true })
      .selectOption(id);
  const focus = () =>
    page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  return { ...f, state, seed, open, select, focus };
}
const templates = (page: Page) =>
  page.getByRole('region', {
    name: 'Reusable coverage templates',
    exact: true,
  });
const categories = (page: Page) =>
  page.getByRole('list', { name: 'Draft categories', exact: true });
const savePlan = async (page: Page) => {
  await page
    .getByRole('button', { name: 'Save coverage plan', exact: true })
    .click();
  await expect(
    page.getByText(
      'Private coverage plan saved. Counts use currently available assigned photos.',
      { exact: true },
    ),
  ).toBeVisible();
};
test('reuses saved shot definitions in another event without copying photo assignments', async ({
  page,
}, info) => {
  const f = await fixture(page),
    source = await f.seed();
  await f.open();
  await page
    .getByLabel('Template name', { exact: true })
    .fill('Wedding essentials');
  await page
    .getByRole('button', { name: 'Save draft as new template', exact: true })
    .click();
  await expect(templates(page).getByRole('status')).toContainText(
    'Reusable template saved',
  );
  const saved = [...f.records.values()].find(
    (row) => row.purpose === 'coverage-template',
  )!.coverageTemplate!;
  expect(saved.fields.categories).toEqual([
    { label: 'Family portraits', target: 3, note: 'Include both generations' },
  ]);
  expect(JSON.stringify(saved)).not.toContain(f.photos[0]!.id);
  const eventId = randomUUID();
  f.records.set(eventId, {
    ...structuredClone(f.records.get(f.eventId)!),
    id: eventId,
    title: 'Next event',
  });
  await f.open(eventId);
  await f.select(saved.id);
  await expect(page.getByLabel('Selected template preview')).toContainText(
    'Family portraits',
  );
  await page
    .getByRole('button', { name: 'Append reviewed template', exact: true })
    .click();
  await expect(templates(page).getByRole('status')).toContainText(
    'local draft',
  );
  expect(f.records.has(coverageRecordId(eventId))).toBe(false);
  await expect(
    page.getByText('No photos assigned to this category.', { exact: true }),
  ).toBeVisible();
  await templates(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('coverage-template-library.png'),
    fullPage: true,
  });
  await savePlan(page);
  const plan = f.records.get(coverageRecordId(eventId))!.coverage!;
  expect(plan.items[0]!.id).not.toBe(source[0]!.id);
  expect(plan.items[0]!.photoIds).toEqual([]);
  await page.reload();
  await page.getByRole('tab', { name: 'Coverage', exact: true }).click();
  await expect(
    page.getByRole('list', { name: 'Saved shot categories', exact: true }),
  ).toContainText('0 of 3 available assignments');
});
test('blocks duplicate appends and requires confirmation before replacing assigned draft categories', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.seed();
  await f.saveTemplate().expect(200);
  await f.open();
  await f.select();
  await expect(
    page.getByRole('button', { name: 'Append reviewed template', exact: true }),
  ).toBeDisabled();
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page
    .getByRole('button', { name: 'Replace draft with template', exact: true })
    .click();
  await expect(categories(page).getByRole('button')).toHaveCount(1);
  page.once('dialog', (dialog) => void dialog.accept());
  await page
    .getByRole('button', { name: 'Replace draft with template', exact: true })
    .click();
  await expect(categories(page).getByRole('button')).toHaveCount(2);
  expect(
    f.records.get(coverageRecordId(f.eventId))!.coverage!.items[0]!.photoIds,
  ).toHaveLength(1);
  await savePlan(page);
  expect(
    f.records
      .get(coverageRecordId(f.eventId))!
      .coverage!.items.every((row) => row.photoIds.length === 0),
  ).toBe(true);
  const plan = structuredClone(f.records.get(coverageRecordId(f.eventId)));
  page.once('dialog', (dialog) => void dialog.accept());
  await page
    .getByRole('button', { name: 'Remove template', exact: true })
    .click();
  await expect(templates(page).getByRole('status')).toContainText(
    'Template removed',
  );
  expect(f.records.get(coverageRecordId(f.eventId))).toEqual(plan);
});
test('updates a selected template from the draft and recovers lost save acknowledgements', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.seed();
  await f.saveTemplate().expect(200);
  await f.open();
  await f.select();
  await categories(page)
    .getByRole('button', { name: 'Family portraits', exact: true })
    .click();
  await page.getByLabel('Target photo count', { exact: true }).fill('5');
  f.state.loseReply = true;
  await page
    .getByRole('button', {
      name: 'Update selected template from draft',
      exact: true,
    })
    .click();
  await expect(templates(page).getByRole('alert')).toContainText(
    'Synthetic committed template reply loss',
  );
  await page
    .getByRole('button', {
      name: 'Update selected template from draft',
      exact: true,
    })
    .click();
  await expect(templates(page).getByRole('status')).toContainText(
    'Reusable template saved',
  );
  expect(f.records.get(f.templateId)!.coverageTemplate!.version).toBe(2);
  expect(
    f.records.get(f.templateId)!.coverageTemplate!.fields.categories[0]!.target,
  ).toBe(5);
  expect(
    f.records.get(coverageRecordId(f.eventId))!.coverage!.items[0]!.target,
  ).toBe(3);
});
test('keeps a stable template identity when retrying a committed create', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.seed();
  await f.open();
  await page
    .getByLabel('Template name', { exact: true })
    .fill('Recoverable template');
  f.state.loseReply = true;
  await page
    .getByRole('button', { name: 'Save draft as new template', exact: true })
    .click();
  await expect(templates(page).getByRole('alert')).toContainText(
    'Synthetic committed template reply loss',
  );
  await page
    .getByRole('button', { name: 'Save draft as new template', exact: true })
    .click();
  await expect(templates(page).getByRole('status')).toContainText(
    'Reusable template saved',
  );
  const rows = [...f.records.values()].filter(
    (row) => row.purpose === 'coverage-template',
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.coverageTemplate!.version).toBe(1);
});
test('detects a changed reviewed template during its final read and preserves the event draft', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.seed();
  const saved = (await f.saveTemplate().expect(200)).body.template;
  await f.open();
  await f.select();
  await f
    .saveTemplate(
      { fields: { ...f.templateFields, title: 'Changed elsewhere' } },
      saved,
    )
    .expect(200);
  page.once('dialog', (dialog) => void dialog.accept());
  await page
    .getByRole('button', { name: 'Replace draft with template', exact: true })
    .click();
  await expect(
    templates(page).getByText(
      'The reviewed template changed. Refresh and review it again.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(categories(page).getByRole('button')).toHaveCount(1);
  await expect(
    page.getByRole('button', {
      name: 'Replace draft with template',
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Refresh templates', exact: true })
    .click();
  await f.select();
  await expect(page.getByLabel('Selected template preview')).toContainText(
    'Changed elsewhere',
  );
});
test('locks the event draft during a delayed apply read and cancels application after navigation', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.seed();
  await f.saveTemplate().expect(200);
  await f.open();
  await f.select();
  f.state.holdRead = true;
  page.once('dialog', (dialog) => void dialog.accept());
  await page
    .getByRole('button', { name: 'Replace draft with template', exact: true })
    .click();
  await expect.poll(() => f.state.held).toBe(true);
  await expect(
    page.getByRole('button', { name: 'Add shot category', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Refresh saved coverage', exact: true }),
  ).toBeDisabled();
  const plan = structuredClone(f.records.get(coverageRecordId(f.eventId)));
  await page.goto('/app/projects');
  f.state.holdRead = false;
  f.state.release?.();
  await expect(
    page.getByRole('heading', { name: 'Projects', exact: true }),
  ).toBeVisible();
  expect(f.records.get(coverageRecordId(f.eventId))).toEqual(plan);
});
test('preserves the coverage draft during failed refresh and hides templates after an account change', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.seed();
  await f.saveTemplate().expect(200);
  await f.open();
  await f.select();
  f.state.failRead = true;
  await f.focus();
  await expect(
    templates(page).getByText('Synthetic template read failure.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Replace draft with template',
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    categories(page).getByRole('button', {
      name: 'Family portraits',
      exact: true,
    }),
  ).toBeVisible();
  f.state.failRead = false;
  await page
    .getByRole('button', { name: 'Refresh templates', exact: true })
    .click();
  await expect(
    page.getByRole('combobox', { name: 'Reviewed template', exact: true }),
  ).toHaveValue('');
  f.state.actor = f.strangerId;
  await f.focus();
  await expect(
    page.getByRole('combobox', { name: 'Reviewed template', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Include both generations', { exact: true }),
  ).toHaveCount(0);
});
