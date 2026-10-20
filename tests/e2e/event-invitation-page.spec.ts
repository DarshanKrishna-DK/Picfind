import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import { invitationPageRecordId } from '../../apps/api/src/event-invitation-page';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';

const origin = 'http://127.0.0.1:5173';
async function fixture(page: Page) {
  const event: LibraryRecord = {
    id: randomUUID(),
    ownerId: 'owner',
    kind: 'event',
    createdAt: new Date().toISOString(),
    title: 'Private event name',
    description: 'Private gallery description',
    date: '',
    visibility: 'private',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const records = new Map([[event.id, event]]);
  const state = {
    actor: 'owner',
    writes: 0,
    loseReply: false,
    holdPublic: false,
    release: null as null | (() => void),
  };
  const store: LibraryStore = {
    get: async (id) => {
      const row = records.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable.');
      return structuredClone(row);
    },
    list: async (owner, kind) =>
      [...records.values()]
        .filter((row) => row.ownerId === owner && row.kind === kind)
        .map((row) => structuredClone(row)),
    put: async (row, create) => {
      if (create && records.has(row.id))
        throw new ApiError(409, 'CONFLICT', 'Existing record.');
      state.writes++;
      records.set(row.id, structuredClone(row));
    },
    remove: async (id) => {
      records.delete(id);
    },
    upload: async () => {
      throw new Error('No uploads expected.');
    },
    file: async () => {
      throw new Error('No photo reads expected.');
    },
    removeFile: async () => {
      throw new Error('No photo removals expected.');
    },
  };
  const app = createApp(
    {
      webOrigin: origin,
      secureCookies: false,
      provider: {
        getUser: async (id) => ({
          id,
          name: id,
          email: `${id}@example.test`,
          emailVerified: true,
        }),
        register: async () => {
          throw new Error('No registration expected.');
        },
        login: async () => {
          throw new Error('No login expected.');
        },
        logout: async () => {},
      },
    },
    { store },
  );
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      path = new URL(incoming.url()).pathname;
    if (state.holdPublic && path.startsWith('/api/public/invitations/'))
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    const target = request(app),
      outgoing =
        incoming.method() === 'PUT' ? target.put(path) : target.get(path);
    outgoing.set('Origin', origin);
    if (state.actor) outgoing.set('Cookie', `picfind_session=${state.actor}`);
    const header = incoming.headers()['x-picfind-invitation-actor'];
    if (header) outgoing.set('X-PicFind-Invitation-Actor', header);
    if (incoming.postData()) outgoing.send(incoming.postDataJSON());
    const response = await outgoing;
    if (
      incoming.method() === 'PUT' &&
      response.status === 200 &&
      state.loseReply
    ) {
      state.loseReply = false;
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Synthetic reply loss.' } },
      });
    }
    return route.fulfill({
      status: response.status,
      body: response.text,
      contentType: 'application/json',
    });
  });
  const url = `/api/events/${event.id}/invitation-page`;
  const saved = () =>
    records.get(invitationPageRecordId(event.id))!.invitationPage!;
  const command = (
    action: 'save' | 'publish' | 'withdraw',
    fields = saved().draft,
  ) =>
    request(app)
      .put(url)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send({ version: saved().version, action, fields });
  await open(page, event.id);
  return { event, records, state, app, saved, command };
}
async function open(page: Page, eventId: string) {
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Invitation', exact: true }).click();
  await expect(
    page.getByLabel('Invitation heading', { exact: true }),
  ).toBeVisible();
}
async function fill(page: Page) {
  await page
    .getByLabel('Invitation heading', { exact: true })
    .fill('A celebration together');
  await page
    .getByLabel('Host display name', { exact: true })
    .fill('The family');
  await page.getByLabel('Invitation date', { exact: true }).fill('2026-11-01');
  await page
    .getByLabel('Invitation local time (optional)', { exact: true })
    .fill('17:30');
  await page
    .getByLabel('Invitation timezone', { exact: true })
    .fill('Asia/Kolkata');
  await page.getByLabel('Venue name', { exact: true }).fill('Garden hall');
  await page
    .getByRole('textbox', { name: 'Venue address', exact: true })
    .fill('Use the east entrance');
  await page
    .getByRole('textbox', { name: 'Guest instructions', exact: true })
    .fill('Please arrive ten minutes early.');
}
async function save(page: Page) {
  await page
    .getByRole('button', { name: 'Save private invitation draft', exact: true })
    .click();
  await expect(
    page.getByText(
      'Private invitation draft saved. Published details were not changed.',
      { exact: true },
    ),
  ).toBeVisible();
}
async function publish(page: Page) {
  await page
    .getByLabel('I confirm these invitation details can be public.', {
      exact: true,
    })
    .check();
  await page
    .getByRole('button', { name: 'Publish current invitation', exact: true })
    .click();
  await expect(
    page.getByText(
      'Invitation published. Anyone with its link can read these details.',
      { exact: true },
    ),
  ).toBeVisible();
}
test('saves privately, previews literal text and publishes a separate responsive invitation without gallery access', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await fill(page);
  await page
    .getByRole('textbox', { name: 'Guest instructions', exact: true })
    .fill('<script>alert("hello")</script>\nPlease use the garden entrance.');
  const preview = page.getByRole('article', {
    name: 'Local invitation preview',
  });
  await expect(preview).toContainText('<script>alert("hello")</script>');
  expect(await preview.locator('script').count()).toBe(0);
  await expect(
    page.getByRole('button', {
      name: 'Publish current invitation',
      exact: true,
    }),
  ).toBeDisabled();
  await save(page);
  expect(f.saved().published).toBeNull();
  await open(page, f.event.id);
  await expect(
    page.getByRole('textbox', { name: 'Venue address', exact: true }),
  ).toHaveValue('Use the east entrance');
  await page
    .getByRole('combobox', { name: 'Invitation theme', exact: true })
    .selectOption('forest');
  await page.screenshot({
    path: info.outputPath('invitation-editor.png'),
    fullPage: true,
  });
  await publish(page);
  expect(f.event.visibility).toBe('private');
  f.state.actor = '';
  await page
    .getByRole('link', { name: 'Open published invitation', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/invite/${f.event.id}$`));
  await expect(
    page.getByRole('heading', { name: 'A celebration together', exact: true }),
  ).toBeVisible();
  const card = page.getByRole('article', { name: 'Published invitation' });
  await expect(card).toContainText('17:30 (Asia/Kolkata)');
  await expect(card).toHaveClass(/invitation-forest/);
  await expect(
    page.getByText('Private gallery description', { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('Private event name');
  await expect(card.locator('script')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('invitation-public.png'),
    fullPage: true,
  });
});
test('keeps edited drafts separate, requires renewed publication consent and preserves unsaved work on withdrawal', async ({
  page,
}) => {
  const f = await fixture(page);
  await fill(page);
  await publish(page);
  await page
    .getByRole('textbox', { name: 'Venue address', exact: true })
    .fill('Private replacement address');
  await save(page);
  await expect(
    page.getByText(/Your saved draft differs from the published page/),
  ).toBeVisible();
  expect(f.saved().published!.fields.address).toBe('Use the east entrance');
  await page
    .getByLabel('I confirm these invitation details can be public.', {
      exact: true,
    })
    .check();
  await page.getByLabel('Venue name', { exact: true }).fill('Updated hall');
  await expect(
    page.getByLabel('I confirm these invitation details can be public.', {
      exact: true,
    }),
  ).not.toBeChecked();
  await publish(page);
  expect(f.saved().published!.fields.address).toBe(
    'Private replacement address',
  );
  await page
    .getByRole('textbox', { name: 'Guest instructions', exact: true })
    .fill('Unsaved final instructions');
  await page
    .getByLabel('Confirm withdrawal of the invitation page', { exact: true })
    .check();
  await page
    .getByRole('button', { name: 'Withdraw invitation', exact: true })
    .click();
  await expect(
    page.getByText(
      'Invitation withdrawn. Unsaved editor changes were preserved.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Guest instructions', exact: true }),
  ).toHaveValue('Unsaved final instructions');
  expect(f.saved().published).toBeNull();
  await page.goto(`/invite/${f.event.id}`);
  await expect(
    page.getByRole('heading', {
      name: 'This invitation is unavailable.',
      exact: true,
    }),
  ).toBeVisible();
});
test('recovers a lost publish reply and preserves conflicted drafts until explicit discard', async ({
  page,
}) => {
  const f = await fixture(page);
  await fill(page);
  f.state.loseReply = true;
  await page
    .getByLabel('I confirm these invitation details can be public.', {
      exact: true,
    })
    .check();
  await page
    .getByRole('button', { name: 'Publish current invitation', exact: true })
    .click();
  await expect(
    page.getByText('Synthetic reply loss.', { exact: true }),
  ).toBeVisible();
  expect(f.state.writes).toBe(1);
  await page
    .getByRole('button', { name: 'Publish current invitation', exact: true })
    .click();
  await expect(
    page.getByText(
      'Invitation published. Anyone with its link can read these details.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(f.state.writes).toBe(1);
  await f
    .command('save', { ...f.saved().draft, host: 'Saved elsewhere' })
    .expect(200);
  await page
    .getByLabel('Host display name', { exact: true })
    .fill('My unsaved host');
  await page
    .getByRole('button', { name: 'Save private invitation draft', exact: true })
    .click();
  await expect(
    page.getByText(
      'Your draft is preserved. Reload the current invitation before saving again.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel('Host display name', { exact: true }),
  ).toHaveValue('My unsaved host');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('button', { name: 'Reload invitation details', exact: true })
    .click();
  await expect(
    page.getByLabel('Host display name', { exact: true }),
  ).toHaveValue('My unsaved host');
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Reload invitation details', exact: true })
    .click();
  await expect(
    page.getByLabel('Host display name', { exact: true }),
  ).toHaveValue('Saved elsewhere');
});
test('allows withdrawal from a closed event while keeping content read-only', async ({
  page,
}) => {
  const f = await fixture(page);
  await fill(page);
  await publish(page);
  f.event.archived = true;
  await open(page, f.event.id);
  await expect(
    page.getByLabel('Invitation heading', { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', {
      name: 'Publish current invitation',
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByLabel('Confirm withdrawal of the invitation page', { exact: true })
    .check();
  await page
    .getByRole('button', { name: 'Withdraw invitation', exact: true })
    .click();
  await expect(
    page.getByText(
      'Invitation withdrawn. Unsaved editor changes were preserved.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(f.saved().published).toBeNull();
});
test('hides private editor details after an account change denies a write', async ({
  page,
}) => {
  const f = await fixture(page);
  await fill(page);
  await save(page);
  await page
    .getByRole('textbox', { name: 'Venue address', exact: true })
    .fill('Unsaved private address');
  f.state.actor = 'other';
  await page
    .getByRole('button', { name: 'Save private invitation draft', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Invitation details unavailable',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Venue address', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('article', { name: 'Local invitation preview' }),
  ).toHaveCount(0);
  expect(f.state.writes).toBe(1);
});
test('clears a withdrawn public page on refresh and never shows its private replacement draft', async ({
  page,
}) => {
  const f = await fixture(page);
  await fill(page);
  await publish(page);
  await page.goto(`/invite/${f.event.id}`);
  await expect(
    page.getByRole('article', { name: 'Published invitation' }),
  ).toBeVisible();
  await f
    .command('save', { ...f.saved().draft, address: 'Hidden next venue' })
    .expect(200);
  await page.evaluate(() =>
    window.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(
    page.getByRole('article', { name: 'Published invitation' }),
  ).not.toContainText('Hidden next venue');
  await f.command('withdraw').expect(200);
  await page.evaluate(() =>
    window.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(
    page.getByRole('heading', {
      name: 'This invitation is unavailable.',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('article', { name: 'Published invitation' }),
  ).toHaveCount(0);
});
test('does not restore a pending public response after leaving the invitation route', async ({
  page,
}) => {
  const f = await fixture(page);
  await fill(page);
  await publish(page);
  f.state.holdPublic = true;
  await page.goto(`/invite/${f.event.id}`);
  await expect.poll(() => !!f.state.release).toBe(true);
  await page.goto('/contact');
  await expect(
    page.getByRole('article', { name: 'Published invitation' }),
  ).toHaveCount(0);
  f.state.holdPublic = false;
  f.state.release!();
  await expect(page).toHaveURL(/\/contact$/);
  await expect(
    page.getByRole('heading', { name: 'A celebration together', exact: true }),
  ).toHaveCount(0);
});
