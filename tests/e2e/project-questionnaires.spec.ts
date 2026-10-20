import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import {
  questionnaireFixture,
  questionnaireOrigin,
} from '../fixtures/questionnaires';
import { QUESTIONNAIRE_CONSENT } from '../../packages/shared/src/studio-questionnaires';

async function fixture(page: Page, issued = true) {
  const f = questionnaireFixture();
  if (issued) await f.issue().expect(200);
  const state = {
    actor: f.ownerId as string,
    loseReply: false,
    failRead: false,
    holdWrite: false,
    release: null as (() => void) | null,
  };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      path = new URL(incoming.url()).pathname,
      method = incoming.method().toLowerCase() as
        'get' | 'put' | 'post' | 'delete';
    if (state.failRead && method === 'get' && path === f.clientPath)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Temporary questionnaire outage.' },
        }),
      });
    if (state.holdWrite && method === 'put' && path.endsWith('/response'))
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    let call = request(f.app)[method](path).set('Origin', questionnaireOrigin);
    if (state.actor)
      call = call.set('Cookie', `picfind_session=${state.actor}`);
    const expected = incoming.headers()['x-picfind-questionnaire-actor'];
    if (expected) call = call.set('X-PicFind-Questionnaire-Actor', expected);
    const studio = incoming.headers()['x-picfind-studio-actor'];
    if (studio) call = call.set('X-PicFind-Studio-Actor', studio);
    const body = incoming.postData();
    if (body) call = call.send(JSON.parse(body));
    const result = await call;
    if (
      state.loseReply &&
      method === 'put' &&
      path.endsWith('/response') &&
      result.status === 200
    ) {
      state.loseReply = false;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Synthetic lost response reply.' },
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
  const ownerPath = `/app/projects/${f.projectId}/questionnaires`,
    clientPath = `/questionnaires/${f.formId}`;
  const client = async () => {
    state.actor = f.clientId;
    await page.goto(clientPath);
    await expect(
      page.getByRole('heading', { name: f.fields.title, exact: true }),
    ).toBeVisible();
  };
  const owner = async () => {
    state.actor = f.ownerId;
    await page.goto(ownerPath);
    await expect(
      page.getByRole('heading', { name: 'Portrait session: questionnaires' }),
    ).toBeVisible();
  };
  return { ...f, state, ownerPath, webClientPath: clientPath, client, owner };
}
const priority = (page: Page) =>
  page.getByRole('textbox', {
    name: 'Priority photographs (required for submission)',
    exact: true,
  });
async function save(page: Page) {
  await page
    .getByRole('button', { name: 'Save private draft', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Private draft saved' }),
  ).toBeVisible();
}
async function submit(page: Page) {
  await page
    .getByRole('checkbox', {
      name: 'I agree to share these answers with the photographer when I submit.',
    })
    .check();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Submit answers', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Answers submitted' }),
  ).toBeVisible();
}
test('issues from the project, saves privately, submits, exports and withdraws the same persisted brief', async ({
  page,
}, info) => {
  const f = await fixture(page, false);
  await page.goto('/app/projects');
  await page.getByRole('button', { name: /Portrait session/ }).click();
  await page.getByRole('link', { name: 'Client questionnaires' }).click();
  await expect(page).toHaveURL(new RegExp(`${f.projectId}/questionnaires$`));
  await page
    .getByRole('textbox', { name: 'Title', exact: true })
    .fill('Portrait preparation');
  await page
    .getByRole('textbox', { name: 'Client email', exact: true })
    .fill('client@example.test');
  await page
    .getByRole('textbox', { name: 'Question 1', exact: true })
    .fill('Priority photographs');
  await page.getByRole('button', { name: 'Add question', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Question 2', exact: true })
    .fill('Location preference');
  await page
    .getByRole('button', { name: 'Issue questionnaire', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Questionnaire issued' }),
  ).toBeVisible();
  const link = await page
    .getByRole('textbox', { name: 'Client questionnaire link', exact: true })
    .inputValue();
  const id = new URL(link).pathname.split('/').at(-1)!;
  f.state.actor = f.clientId;
  await page.goto(new URL(link).pathname);
  await priority(page).fill(
    '<script>literal</script> Family portraits\nGrandparents first',
  );
  await save(page);
  await page.reload();
  await expect(priority(page)).toHaveValue(
    '<script>literal</script> Family portraits\nGrandparents first',
  );
  await f.owner();
  await expect(
    page.getByText(
      'No submitted brief is available. Private drafts are never shown here.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText('Grandparents first', { exact: false }),
  ).toHaveCount(0);
  f.state.actor = f.clientId;
  await page.goto(`/questionnaires/${id}`);
  await submit(page);
  await expect(priority(page)).toBeDisabled();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect
    .poll(async () => {
      const heading = await page
        .getByRole('heading', { name: 'Portrait preparation', exact: true })
        .boundingBox();
      const header = await page.locator('.public-header').boundingBox();
      return !!heading && !!header && heading.y >= header.y + header.height;
    })
    .toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('client-submitted.png'),
    fullPage: true,
  });
  await f.owner();
  await expect(
    page.getByRole('heading', { name: 'Submitted brief', exact: true }),
  ).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export submitted brief' }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('picfind-client-brief.txt');
  const text = await readFile((await file.path())!, 'utf8');
  expect(text).toContain(
    '<script>literal</script> Family portraits\nGrandparents first',
  );
  expect(text).not.toMatch(/commandDigest|photographerId|client@example/);
  await page
    .locator('.workspace-content')
    .evaluate((element) => element.scrollTo(0, 0));
  await page.screenshot({
    path: info.outputPath('owner-submitted.png'),
    fullPage: true,
  });
  f.state.actor = f.clientId;
  await page.goto(`/questionnaires/${id}`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Withdraw saved answers' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved answers withdrawn' }),
  ).toBeVisible();
  await f.owner();
  await expect(
    page.getByRole('heading', { name: 'Submitted brief', exact: true }),
  ).toHaveCount(0);
});
test('preserves the assigned form destination through sign-in', async ({
  page,
}) => {
  const f = await fixture(page);
  f.state.actor = '';
  await page.goto(f.webClientPath);
  const link = page.getByRole('link', { name: 'Sign in to continue' });
  await expect(link).toHaveAttribute(
    'href',
    `/sign-in?returnTo=${encodeURIComponent(f.webClientPath)}`,
  );
  await link.click();
  f.state.actor = f.clientId;
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`${f.formId}$`));
  await expect(priority(page)).toBeVisible();
});
test('requires final required answers and resets consent when an answer changes', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.client();
  const consent = page.getByRole('checkbox', { name: /I agree to share/ });
  await consent.check();
  await expect(
    page.getByRole('button', { name: 'Submit answers', exact: true }),
  ).toBeDisabled();
  await priority(page).fill('Family');
  await expect(consent).not.toBeChecked();
  await save(page);
  expect(f.records.get(f.responseId)?.questionnaireResponse?.state).toBe(
    'draft',
  );
});
test('recovers a committed draft after a lost reply using the same request', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.client();
  await priority(page).fill('Keep this private draft');
  f.state.loseReply = true;
  await page
    .getByRole('button', { name: 'Save private draft', exact: true })
    .click();
  await expect(page.getByText('Synthetic lost response reply.')).toBeVisible();
  await expect(priority(page)).toHaveValue('Keep this private draft');
  await save(page);
  expect(f.records.get(f.responseId)?.questionnaireResponse?.version).toBe(1);
});
test('preserves unsaved edits on conflict and confirms discarding them before reload', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.client();
  await priority(page).fill('Local draft');
  await f
    .write({
      answers: f.fields.questions.map((q) => ({
        questionId: q.id,
        text: 'Other tab',
      })),
    })
    .expect(200);
  await page
    .getByRole('button', { name: 'Save private draft', exact: true })
    .click();
  await expect(
    page.getByText(
      'Questionnaire details changed. Reload before trying again.',
    ),
  ).toBeVisible();
  await expect(priority(page)).toHaveValue('Local draft');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Reload saved response' }).click();
  await expect(priority(page)).toHaveValue('Local draft');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reload saved response' }).click();
  await expect(priority(page)).toHaveValue('Other tab');
});
test('hides private fields when the signed-in actor changes before save', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.client();
  await priority(page).fill('Private phrase');
  f.state.actor = f.strangerId;
  await page
    .getByRole('button', { name: 'Save private draft', exact: true })
    .click();
  await expect(
    page.getByText('Your signed-in account changed. Reload this page.'),
  ).toBeVisible();
  await expect(priority(page)).toHaveCount(0);
  expect(f.records.has(f.responseId)).toBe(false);
});
test('keeps a draft after a transient read failure and recovers on explicit reload', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.client();
  await priority(page).fill('Unsaved private notes');
  f.state.failRead = true;
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reload saved response' }).click();
  await expect(page.getByText('Temporary questionnaire outage.')).toBeVisible();
  await expect(priority(page)).toHaveValue('Unsaved private notes');
  f.state.failRead = false;
  await save(page);
});
test('revokes new answers while retaining withdrawal and permits explicit owner removal', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.client();
  await priority(page).fill('Retained response');
  await save(page);
  await f.owner();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Revoke questionnaire' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Questionnaire revoked.' }),
  ).toBeVisible();
  await f.client();
  await expect(priority(page)).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Withdraw saved answers' }),
  ).toBeEnabled();
  await f.owner();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Remove questionnaire', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Questionnaire removed.' }),
  ).toBeVisible();
  expect(f.records.has(f.formId) || f.records.has(f.responseId)).toBe(false);
});
test('reauthorizes exported answers and refuses a withdrawn brief', async ({
  page,
}) => {
  const f = await fixture(page);
  await f
    .write({
      action: 'submit',
      consent: QUESTIONNAIRE_CONSENT,
      answers: f.fields.questions.map((q) => ({
        questionId: q.id,
        text: 'Now withdrawn',
      })),
    })
    .expect(200);
  await f.owner();
  f.records.delete(f.responseId);
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByRole('button', { name: 'Export submitted brief' }).click();
  await expect(
    page.getByText(
      'The submitted brief changed or was withdrawn. Reload questionnaires before exporting.',
    ),
  ).toBeVisible();
  expect(downloads).toBe(0);
});
test('does not apply a late save result after navigating away', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.client();
  await priority(page).fill('Pending response');
  f.state.holdWrite = true;
  await page
    .getByRole('button', { name: 'Save private draft', exact: true })
    .click();
  await expect.poll(() => !!f.state.release).toBe(true);
  await page
    .getByRole('link', { name: 'picfind.', exact: true })
    .first()
    .click();
  await expect(priority(page)).toHaveCount(0);
  f.state.release!();
  f.state.holdWrite = false;
  await expect(page).not.toHaveURL(new RegExp(`${f.formId}$`));
  await expect(
    page.getByText('Private draft saved.', { exact: false }),
  ).toHaveCount(0);
});
