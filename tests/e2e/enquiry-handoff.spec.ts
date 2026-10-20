import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { ApiError } from '../../apps/api/src/auth';
import { handoffFixture } from '../fixtures/enquiry-handoff';
import { questionnaireOrigin } from '../fixtures/questionnaires';

async function fixture(page: Page) {
  const f = await handoffFixture();
  const state = {
    actor: f.ownerId as string,
    failProject: false,
    failRead: false,
    loseReply: false,
  };
  const put = f.store.put.bind(f.store);
  f.store.put = async (row, create) => {
    if (
      state.failProject &&
      row.purpose === 'studio-project' &&
      row.id !== f.projectId
    ) {
      state.failProject = false;
      throw new ApiError(
        503,
        'SYNTHETIC_FAILURE',
        'Synthetic interrupted project creation.',
      );
    }
    return put(row, create);
  };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url());
    const method = incoming.method().toLowerCase() as
      'get' | 'put' | 'patch' | 'post' | 'delete';
    if (state.failRead && method === 'get' && url.pathname === f.root)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Synthetic handoff read failure.' },
        }),
      });
    const client = request(f.app);
    let call = client[method](url.pathname + url.search).set(
      'Origin',
      questionnaireOrigin,
    );
    if (state.actor)
      call = call.set('Cookie', `picfind_session=${state.actor}`);
    const actor = incoming.headers()['x-picfind-enquiry-actor'];
    if (actor) call = call.set('X-PicFind-Enquiry-Actor', actor);
    if (incoming.postData()) call = call.send(JSON.parse(incoming.postData()!));
    const response = await call;
    if (
      state.loseReply &&
      method === 'put' &&
      url.pathname === f.root &&
      response.status === 200
    ) {
      state.loseReply = false;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Synthetic completed reply loss.' },
        }),
      });
    }
    await route
      .fulfill({
        status: response.status,
        contentType: 'application/json',
        body: response.status === 204 ? '' : JSON.stringify(response.body),
      })
      .catch(() => {});
  });
  page.on('dialog', (dialog) => void dialog.accept());
  const open = async () => {
    await page.goto(`/app/enquiries/${f.enquiryId}/handoff`);
    await expect(
      page.getByRole('heading', { name: 'Enquiry to project', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Load latest handoff', exact: true }),
    ).toBeEnabled();
  };
  const create = () =>
    page
      .getByRole('button', {
        name: 'Create client/project handoff',
        exact: true,
      })
      .click();
  return { ...f, state, open, create };
}
test('opens from the enquiry inbox and creates reviewed private client and project work', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page.goto('/app/enquiries');
  await page
    .getByRole('button', {
      name: 'Review enquiry from Synthetic Client',
      exact: true,
    })
    .click();
  await page
    .getByRole('link', {
      name: 'Create or recover project handoff',
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/app/enquiries/${f.enquiryId}/handoff$`),
  );
  await page
    .getByLabel('Client company', { exact: true })
    .fill('Portrait client');
  await page
    .getByLabel('Project name', { exact: true })
    .fill('December portrait session');
  await page
    .getByRole('textbox', { name: 'Project summary', exact: true })
    .fill('Reviewed portrait delivery work.');
  await page.locator('.handoff-draft').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('handoff-editor.png'),
    fullPage: false,
  });
  expect(
    await page
      .locator('.workspace-content')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await f.create();
  await expect(
    page.getByRole('heading', { name: 'Handoff completed', exact: true }),
  ).toBeVisible();
  const current = await f.current();
  expect(current.handoff!.status).toBe('completed');
  if (current.handoff!.status === 'pending')
    throw new Error('Expected completion');
  expect(
    f.records.get(current.handoff!.projectId)!.studioProject,
  ).toMatchObject({
    stage: 'inquiry',
    name: 'December portrait session',
    eventIds: [],
  });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Handoff completed', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Create client/project handoff',
      exact: true,
    }),
  ).toHaveCount(0);
});
test('reuses a matching existing client after review without creating a duplicate', async ({
  page,
}) => {
  const f = await fixture(page);
  await f
    .put(`/api/studio/clients/${f.command.client.id}`, {
      ...f.command.client.fields,
      version: 0,
    })
    .expect(200);
  await f.open();
  await expect(
    page.getByRole('combobox', { name: 'Client record', exact: true }),
  ).toHaveValue(f.command.client.id);
  await expect(
    page.getByText(
      'The selected client record will be reused without changing its contact details.',
    ),
  ).toBeVisible();
  await expect(
    page.locator('.handoff-draft').getByText(f.contact.phone, { exact: true }),
  ).toBeVisible();
  await f.create();
  await expect(
    page.getByRole('heading', { name: 'Handoff completed', exact: true }),
  ).toBeVisible();
  expect(
    [...f.records.values()].filter((row) => row.purpose === 'studio-client'),
  ).toHaveLength(1);
  expect(f.records.get(f.command.client.id)!.studioClient!.version).toBe(1);
});
test('resumes partial creation after reload only after confirmation of missing destinations', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  f.state.failProject = true;
  await f.create();
  await expect(
    page.getByText('Synthetic interrupted project creation.'),
  ).toBeVisible();
  expect(
    [...f.records.values()].filter((row) => row.purpose === 'studio-client'),
  ).toHaveLength(1);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Handoff needs recovery', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Planned email', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Resume handoff', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('checkbox', {
      name: 'Create the missing planned records shown above. A previously removed record may be recreated.',
      exact: true,
    })
    .check();
  await page
    .getByRole('button', { name: 'Resume handoff', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Handoff completed', exact: true }),
  ).toBeVisible();
  expect(
    [...f.records.values()].filter((row) => row.purpose === 'studio-client'),
  ).toHaveLength(1);
  expect(
    [...f.records.values()].filter((row) => row.purpose === 'studio-project'),
  ).toHaveLength(2);
});
test('retries a lost completed response without creating duplicate work', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  f.state.loseReply = true;
  await f.create();
  await expect(page.getByText('Synthetic completed reply loss.')).toBeVisible();
  await f.create();
  await expect(
    page.getByRole('heading', { name: 'Handoff completed', exact: true }),
  ).toBeVisible();
  expect(
    [...f.records.values()].filter((row) => row.purpose === 'studio-client'),
  ).toHaveLength(1);
  expect(
    [...f.records.values()].filter((row) => row.purpose === 'studio-project'),
  ).toHaveLength(2);
});
test('abandons recovery while retaining independently edited client work', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  f.state.failProject = true;
  await f.create();
  await expect(
    page.getByText('Synthetic interrupted project creation.'),
  ).toBeVisible();
  const client = [...f.records.values()].find(
    (row) => row.studioClient,
  )!.studioClient!;
  await f
    .put(`/api/studio/clients/${client.id}`, {
      name: 'Edited client',
      email: client.email,
      phone: client.phone,
      company: client.company,
      version: client.version,
    })
    .expect(200);
  await page.reload();
  await expect(
    page.getByText(
      'A destination changed or a pre-existing client was removed. Abandon this handoff and reconcile the records manually.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Resume handoff', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Abandon handoff', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Handoff abandoned', exact: true }),
  ).toBeVisible();
  expect(f.records.get(client.id)!.studioClient!.name).toBe('Edited client');
});
test('preserves stale drafts and requires explicit latest-source loading', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await page.getByLabel('Project name', { exact: true }).fill('Keep my draft');
  await f.update().expect(200);
  await f.create();
  await expect(
    page.getByText(
      'The source or handoff changed, or a refresh failed. Your draft is retained. Load the latest preview before continuing.',
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(
    'Keep my draft',
  );
  await page
    .getByRole('button', { name: 'Load latest handoff', exact: true })
    .click();
  await expect(
    page.getByLabel('Project name', { exact: true }),
  ).not.toHaveValue('Keep my draft');
  await f.create();
  await expect(
    page.getByRole('heading', { name: 'Handoff completed', exact: true }),
  ).toBeVisible();
});
test('blocks cached writes after a failed refresh and hides private data after an account switch', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await page
    .getByLabel('Project name', { exact: true })
    .fill('Preserved draft');
  f.state.failRead = true;
  await page
    .getByRole('button', { name: 'Load latest handoff', exact: true })
    .click();
  await expect(page.getByText('Synthetic handoff read failure.')).toBeVisible();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveValue(
    'Preserved draft',
  );
  await expect(
    page.getByRole('button', {
      name: 'Create client/project handoff',
      exact: true,
    }),
  ).toBeDisabled();
  f.state.failRead = false;
  f.state.actor = f.strangerId;
  await page
    .getByRole('button', { name: 'Load latest handoff', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Enquiry handoff unavailable',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Project name', { exact: true })).toHaveCount(0);
});
