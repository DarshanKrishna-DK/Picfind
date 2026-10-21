import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import {
  questionnaireFixture,
  questionnaireOrigin,
} from '../fixtures/questionnaires';

async function fixture(page: Page, signedIn = true) {
  const f = questionnaireFixture(),
    apiCalls: string[] = [],
    modules: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith('/src/')) modules.push(url.pathname);
  });
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url());
    apiCalls.push(url.pathname);
    const method = incoming.method().toLowerCase() as
        'get' | 'put' | 'post' | 'delete' | 'patch',
      transport = request(f.app);
    let call = transport[method](url.pathname + url.search).set(
      'Origin',
      questionnaireOrigin,
    );
    if (signedIn) call = call.set('Cookie', `picfind_session=${f.ownerId}`);
    if (incoming.postData()) call = call.send(incoming.postDataJSON());
    const response = await call;
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: response.status === 204 ? '' : JSON.stringify(response.body),
    });
  });
  return { ...f, apiCalls, modules };
}
async function studioLink(page: Page, name: string) {
  const toggle = page.getByRole('button', {
    name: 'Toggle studio navigation',
    exact: true,
  });
  await expect(page.getByRole('banner')).toBeVisible();
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('link', { name, exact: true }).click();
}
test('a cold public page does not load unrelated studio implementations', async ({
  page,
}) => {
  const f = await fixture(page, false);
  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(
    page
      .getByRole('contentinfo')
      .getByRole('link', { name: 'Privacy', exact: true }),
  ).toBeVisible();
  for (const feature of [
    'studio-clients',
    'studio-expenses',
    'studio-projects',
    'enquiry-report',
    'project-brief',
    'events',
    'gallery',
    'billing',
  ])
    expect(f.modules).not.toContain(`/src/features/${feature}.tsx`);
  await page
    .getByRole('contentinfo')
    .getByRole('link', { name: 'Privacy', exact: true })
    .click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(
    page.getByRole('heading', {
      name: 'Your memories. Your choice.',
      exact: true,
    }),
  ).toBeVisible();
  expect(f.modules).toContain('/src/features/public.tsx');
});
test('keeps the studio shell available while a direct-linked workflow module loads', async ({
  page,
}) => {
  const f = await fixture(page),
    state = { held: false, release: null as (() => void) | null };
  await page.route('**/src/features/studio-clients.tsx*', async (route) => {
    await new Promise<void>((resolve) => {
      state.held = true;
      state.release = resolve;
    });
    await route.continue();
  });
  await page.goto('/app/clients');
  await expect.poll(() => state.held).toBe(true);
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(
    page
      .getByRole('main')
      .getByRole('status', { name: 'Loading', exact: true }),
  ).toBeVisible();
  expect(f.apiCalls).not.toContain('/api/studio/clients');
  state.release!();
  await expect(
    page.getByRole('heading', { name: 'Client directory', exact: true }),
  ).toBeVisible();
  expect(f.apiCalls).toContain('/api/studio/clients');
});
test('checks the session before requesting a private route implementation', async ({
  page,
}) => {
  const f = await fixture(page, false);
  await page.goto('/app/clients');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(
    page.getByRole('heading', {
      name: 'Your photos are waiting.',
      exact: true,
    }),
  ).toBeVisible();
  expect(f.modules).not.toContain('/src/features/studio-clients.tsx');
  expect(f.apiCalls).not.toContain('/api/studio/clients');
});
test('recovers a failed workflow import through an explicit page reload', async ({
  page,
}) => {
  await fixture(page);
  let fail = true;
  await page.route('**/src/features/studio-clients.tsx*', async (route) => {
    if (fail) await route.abort('failed');
    else await route.continue();
  });
  await page.goto('/app/clients');
  await expect(page.getByRole('alert')).toContainText(
    'This page could not be displayed.',
  );
  const reload = page.getByRole('button', { name: 'Reload page', exact: true });
  await expect(reload).toBeVisible();
  fail = false;
  await reload.click();
  await expect(
    page.getByRole('heading', { name: 'Client directory', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
test('does not mount an abandoned workflow after its delayed module resolves', async ({
  page,
}) => {
  const f = await fixture(page),
    state = { held: false, release: null as (() => void) | null };
  await page.route('**/src/features/studio-clients.tsx*', async (route) => {
    await new Promise<void>((resolve) => {
      state.held = true;
      state.release = resolve;
    });
    await route.continue();
  });
  await page.goto('/app/clients');
  await expect.poll(() => state.held).toBe(true);
  await studioLink(page, 'Projects');
  await expect(
    page.getByRole('heading', { name: 'Projects', exact: true }),
  ).toBeVisible();
  const response = page.waitForResponse(
    (url) => new URL(url.url()).pathname === '/src/features/studio-clients.tsx',
  );
  state.release!();
  await response;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(
    page.getByRole('heading', { name: 'Client directory', exact: true }),
  ).toHaveCount(0);
  expect(f.apiCalls).not.toContain('/api/studio/clients');
  await studioLink(page, 'Clients');
  await expect(
    page.getByRole('heading', { name: 'Client directory', exact: true }),
  ).toBeVisible();
});
