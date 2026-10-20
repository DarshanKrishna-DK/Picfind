import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { enquiryFixture } from '../fixtures/studio-enquiries';
import { questionnaireOrigin } from '../fixtures/questionnaires';

async function fixture(page: Page) {
  const f = enquiryFixture();
  const state = {
    actor: f.ownerId as string,
    losePath: '',
    failRead: '',
  };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url()),
      path = url.pathname + url.search,
      method = incoming.method().toLowerCase() as
        'get' | 'post' | 'put' | 'patch' | 'delete';
    if (method === 'get' && state.failRead && url.pathname === state.failRead)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Synthetic read outage.' } }),
      });
    let call = request(f.app)[method](path).set('Origin', questionnaireOrigin);
    if (state.actor)
      call = call.set('Cookie', `picfind_session=${state.actor}`);
    const actor = incoming.headers()['x-picfind-enquiry-actor'];
    if (actor) call = call.set('X-PicFind-Enquiry-Actor', actor);
    if (incoming.postData()) call = call.send(JSON.parse(incoming.postData()!));
    const result = await call;
    if (
      method !== 'get' &&
      state.losePath &&
      path.startsWith(state.losePath) &&
      [200, 201].includes(result.status)
    ) {
      state.losePath = '';
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
    await page.goto('/app/enquiries');
    await expect(
      page.getByRole('heading', { name: 'Enquiries', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: 'Public studio name' }),
    ).toBeVisible();
  };
  const visitor = async () => {
    state.actor = '';
    await page.goto(`/enquire/${f.formId}`);
    await expect(
      page.getByRole('heading', { name: 'Asha Studio', exact: true }),
    ).toBeVisible();
  };
  const review = async () => {
    await open();
    await page
      .getByRole('button', {
        name: 'Review enquiry from Synthetic Client',
        exact: true,
      })
      .click();
    await expect(
      page.getByRole('textbox', { name: 'Private follow-up note' }),
    ).toBeVisible();
  };
  return { ...f, state, open, visitor, review };
}
async function fillVisitor(page: Page) {
  await page
    .getByRole('textbox', { name: 'Your name', exact: true })
    .fill('Synthetic Client');
  await page
    .getByRole('textbox', { name: 'Reply email', exact: true })
    .fill('client@example.test');
  await page
    .getByRole('textbox', { name: 'Type of photography' })
    .fill('Event portraits');
  await page
    .getByRole('textbox', { name: 'Session details' })
    .fill('Private session requirements.');
  await page.getByRole('checkbox', { name: /I agree to share/ }).check();
}

test('publishes a form explicitly, receives an anonymous enquiry and records private follow-up', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await f.open();
  await expect(
    page.getByRole('checkbox', { name: 'Publish enquiry form' }),
  ).not.toBeChecked();
  await page
    .getByRole('textbox', { name: 'Public studio name' })
    .fill('Asha Studio');
  await page
    .getByRole('textbox', { name: 'Public introduction' })
    .fill('Tell us about your session.');
  await page.getByRole('checkbox', { name: 'Publish enquiry form' }).check();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('button', { name: 'Save enquiry form', exact: true })
    .click();
  expect(f.records.has(f.formId)).toBe(false);
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Save enquiry form', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Enquiry form published.' }),
  ).toBeVisible();
  await f.visitor();
  await expect(
    page.getByRole('button', { name: 'Send enquiry' }),
  ).toBeDisabled();
  await fillVisitor(page);
  await page.screenshot({
    path: info.outputPath('enquiry-public.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Send enquiry' }).click();
  await expect(
    page.getByRole('heading', { name: 'Enquiry saved' }),
  ).toBeVisible();
  expect(
    [...f.records.values()].filter((r) => r.purpose === 'studio-enquiry'),
  ).toHaveLength(1);
  f.state.actor = f.ownerId;
  await f.review();
  await page
    .getByRole('combobox', { name: 'Follow-up stage' })
    .selectOption('contacted');
  await page
    .getByRole('textbox', { name: 'Private follow-up note' })
    .fill('Discuss timing by phone.');
  await page
    .getByRole('button', { name: 'Save follow-up', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Follow-up saved.' }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole('button', { name: 'Review enquiry from Synthetic Client' })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Private follow-up note' }),
  ).toHaveValue('Discuss timing by phone.');
  await expect(
    page
      .getByRole('region', { name: 'Selected enquiry' })
      .getByRole('listitem'),
  ).toHaveCount(2);
  await page
    .getByRole('region', { name: 'Selected enquiry' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('enquiry-private.png'),
    fullPage: true,
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Remove enquiry', exact: true })
    .click();
  await expect(
    page.getByText('No enquiries on this page.', { exact: true }),
  ).toBeVisible();
});

test('recovers a lost submission reply with one retained request and no browser contact storage', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.publish().expect(200);
  await f.visitor();
  await fillVisitor(page);
  f.state.losePath = f.publicPath;
  await page.getByRole('button', { name: 'Send enquiry' }).click();
  await expect(
    page.getByText('Synthetic committed reply loss.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Reply email', exact: true }),
  ).toHaveValue('client@example.test');
  await page.getByRole('button', { name: 'Send enquiry' }).click();
  await expect(
    page.getByRole('heading', { name: 'Enquiry saved' }),
  ).toBeVisible();
  expect(
    [...f.records.values()].filter((r) => r.purpose === 'studio-enquiry'),
  ).toHaveLength(1);
  expect(
    await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
  ).not.toContain('client@example.test');
});

test('requires renewed consent after a publication changes while retaining the visitor draft', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.publish().expect(200);
  await f.visitor();
  await fillVisitor(page);
  await f
    .publish({ introduction: 'Updated studio introduction.' }, 1)
    .expect(200);
  await page.getByRole('button', { name: 'Refresh form details' }).click();
  await expect(
    page.getByRole('button', { name: 'Accept updated form details' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Send enquiry' }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Accept updated form details' })
    .click();
  await expect(
    page.getByRole('checkbox', { name: /I agree to share/ }),
  ).not.toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Your name' })).toHaveValue(
    'Synthetic Client',
  );
  await page.getByRole('checkbox', { name: /I agree to share/ }).check();
  await page.getByRole('button', { name: 'Send enquiry' }).click();
  await expect(
    page.getByRole('heading', { name: 'Enquiry saved' }),
  ).toBeVisible();
  expect(
    [...f.records.values()].find((r) => r.purpose === 'studio-enquiry')
      ?.studioEnquiry?.formVersion,
  ).toBe(2);
});

test('retains a visitor draft during a transient refresh failure and blocks sending until recovery', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.publish().expect(200);
  await f.visitor();
  await fillVisitor(page);
  f.state.failRead = f.publicPath;
  await page.getByRole('button', { name: 'Refresh form details' }).click();
  await expect(
    page.getByText('Synthetic read outage.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Your name' })).toHaveValue(
    'Synthetic Client',
  );
  await expect(
    page.getByRole('button', { name: 'Send enquiry' }),
  ).toBeDisabled();
  f.state.failRead = '';
  await page.getByRole('button', { name: 'Refresh form details' }).click();
  await expect(
    page.getByRole('button', { name: 'Send enquiry' }),
  ).toBeEnabled();
});

test('retries a committed follow-up without adding a second history entry', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.publish().expect(200);
  await f.submit().expect(201);
  await f.review();
  await page
    .getByRole('combobox', { name: 'Follow-up stage' })
    .selectOption('qualified');
  await page
    .getByRole('textbox', { name: 'Private follow-up note' })
    .fill('Ready to discuss a date.');
  f.state.losePath = `/api/studio/enquiries/${f.enquiryId}`;
  await page.getByRole('button', { name: 'Save follow-up' }).click();
  await expect(
    page.getByText('Synthetic committed reply loss.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save follow-up' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Follow-up saved.' }),
  ).toBeVisible();
  expect(f.records.get(f.enquiryId)?.studioEnquiry).toMatchObject({
    version: 2,
    stage: 'qualified',
  });
  expect(f.records.get(f.enquiryId)?.studioEnquiry?.history).toHaveLength(2);
});

test('preserves a stale follow-up draft and requires explicit replacement', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.publish().expect(200);
  await f.submit().expect(201);
  await f.review();
  const note = page.getByRole('textbox', { name: 'Private follow-up note' });
  await note.fill('Unsaved local note.');
  await f.update({ note: 'Saved elsewhere.' }).expect(200);
  await page.getByRole('button', { name: 'Refresh inbox' }).click();
  await expect(
    page.getByRole('button', { name: 'Save follow-up' }),
  ).toBeDisabled();
  await expect(note).toHaveValue('Unsaved local note.');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Load latest enquiry' }).click();
  await expect(note).toHaveValue('Unsaved local note.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Load latest enquiry' }).click();
  await expect(note).toHaveValue('Saved elsewhere.');
  await expect(
    page.getByRole('button', { name: 'Save follow-up' }),
  ).toBeEnabled();
});

test('retains private drafts through an inbox outage and protects dirty filter navigation', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.publish().expect(200);
  await f.submit().expect(201);
  await f.review();
  const note = page.getByRole('textbox', { name: 'Private follow-up note' });
  await note.fill('Keep this draft.');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('combobox', { name: 'Filter stage' })
    .selectOption('closed');
  await expect(note).toHaveValue('Keep this draft.');
  await expect(
    page.getByRole('combobox', { name: 'Filter stage' }),
  ).toHaveValue('');
  f.state.failRead = '/api/studio/enquiries';
  await page.getByRole('button', { name: 'Refresh inbox' }).click();
  await expect(
    page.getByText('Synthetic read outage.', { exact: true }),
  ).toBeVisible();
  await expect(note).toHaveValue('Keep this draft.');
  await expect(
    page.getByRole('button', { name: 'Save follow-up' }),
  ).toBeDisabled();
  f.state.failRead = '';
  await page.getByRole('button', { name: 'Refresh inbox' }).click();
  await expect(
    page.getByRole('button', { name: 'Save follow-up' }),
  ).toBeEnabled();
  await expect(note).toHaveValue('Keep this draft.');
});

test('hides the entire private inbox when the signed-in account changes during a save', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.publish().expect(200);
  await f.submit().expect(201);
  await f.review();
  await page
    .getByRole('textbox', { name: 'Private follow-up note' })
    .fill('Do not save across accounts.');
  f.state.actor = f.strangerId;
  await page.getByRole('button', { name: 'Save follow-up' }).click();
  await expect(
    page.getByText('The signed-in account changed. Reload the studio.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Enquiry inbox' })).toHaveCount(
    0,
  );
  await expect(page.getByText(/client@example.test/)).toHaveCount(0);
  expect(f.records.get(f.enquiryId)?.studioEnquiry?.version).toBe(1);
});

test('closes public intake while retaining existing private enquiries', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.publish().expect(200);
  await f.submit().expect(201);
  await f.open();
  await page.getByRole('checkbox', { name: 'Publish enquiry form' }).uncheck();
  await page.getByRole('button', { name: 'Save enquiry form' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Enquiry form closed.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Review enquiry from Synthetic Client' }),
  ).toBeVisible();
  f.state.actor = '';
  await page.goto(`/enquire/${f.formId}`);
  await expect(
    page.getByRole('heading', { name: 'Enquiry form unavailable' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send enquiry' })).toHaveCount(
    0,
  );
  expect(f.records.has(f.enquiryId)).toBe(true);
});

test('pages actual retained enquiries and searches beyond the first page', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.publish().expect(200);
  await f.submit().expect(201);
  const original = f.records.get(f.enquiryId)!;
  for (let i = 1; i <= 50; i++) {
    const row = structuredClone(original),
      id = randomUUID();
    row.id = row.studioEnquiry!.id = id;
    row.studioEnquiry!.name = `Request ${i}`;
    f.records.set(id, row);
  }
  await f.open();
  await expect(
    page.getByRole('button', { name: /^Review enquiry from/ }),
  ).toHaveCount(50);
  await page.getByRole('button', { name: 'Next enquiries' }).click();
  await expect(
    page.getByRole('button', { name: /^Review enquiry from/ }),
  ).toHaveCount(1);
  await page
    .getByRole('textbox', { name: 'Search enquiries' })
    .fill('Request 50');
  await expect(
    page.getByRole('button', {
      name: 'Review enquiry from Request 50',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Review enquiry from/ }),
  ).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Previous enquiries' }),
  ).toBeDisabled();
});
