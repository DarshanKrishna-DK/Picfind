import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import express from 'express';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import { invitationPageRecordId } from '../../apps/api/src/event-invitation-page';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
import { blankInvitationPage } from '../../packages/shared/src/event-invitation-page';

const origin = 'http://127.0.0.1:5173';
const servers = new WeakMap<Page, Server>();
const origins = new WeakMap<Page, string>();
async function navigate(page: Page, path: string) {
  await page.goto(new URL(path, origins.get(page)).href);
}
test.afterEach(async ({ page }) => {
  const server = servers.get(page);
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
async function fixture(page: Page) {
  const now = new Date().toISOString(),
    event: LibraryRecord = {
      id: randomUUID(),
      ownerId: 'owner',
      kind: 'event',
      createdAt: now,
      title: 'Response planning',
      description: '',
      date: '',
      visibility: 'private',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
  const fields = {
    ...blankInvitationPage(),
    heading: 'Our celebration',
    date: '2026-11-01',
  };
  const publication: LibraryRecord = {
    id: invitationPageRecordId(event.id),
    ownerId: 'owner',
    kind: 'job',
    purpose: 'event-invitation-page',
    eventId: event.id,
    createdAt: now,
    invitationPage: {
      draft: fields,
      published: { fields, revision: 1, publishedAt: now },
      version: 1,
      updatedAt: now,
      commandDigest: 'a'.repeat(64),
    },
  };
  const records = new Map([event, publication].map((row) => [row.id, row]));
  const state = {
    actor: 'owner',
    writes: 0,
    loseReply: false,
    holdGuestRead: false,
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
        throw new ApiError(409, 'CONFLICT', 'Exists.');
      state.writes++;
      records.set(row.id, structuredClone(row));
    },
    remove: async (id) => {
      records.delete(id);
    },
    upload: async () => {
      throw new Error('No uploads.');
    },
    file: async () => {
      throw new Error('No photo reads.');
    },
    removeFile: async () => {
      throw new Error('No photo removal.');
    },
  };
  const transport = express();
  const server = transport.listen(0, '127.0.0.1');
  servers.set(page, server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing RSVP HTTP fixture address.');
  const fixtureOrigin = `http://127.0.0.1:${address.port}`;
  origins.set(page, fixtureOrigin);
  const app = createApp(
    {
      webOrigin: fixtureOrigin,
      secureCookies: false,
      provider: {
        getUser: async (id) => ({
          id,
          name: id,
          email: `${id}@example.test`,
          emailVerified: true,
        }),
        login: async () => {
          throw new Error('No login.');
        },
        register: async () => {
          throw new Error('No registration.');
        },
        logout: async () => {},
      },
    },
    { store },
  );
  transport.use(async (incoming, response, next) => {
    const path = incoming.path;
    if (
      state.holdGuestRead &&
      incoming.method === 'GET' &&
      path === `/api/public/invitations/${event.id}/rsvp`
    )
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    incoming.headers.cookie = [
      incoming.headers.cookie ?? '',
      state.actor ? `picfind_session=${state.actor}` : '',
    ]
      .filter(Boolean)
      .join(';');
    const sendJson = response.json.bind(response);
    response.json = (body: unknown) => {
      if (
        state.loseReply &&
        incoming.method === 'PUT' &&
        path.startsWith('/api/public/') &&
        response.statusCode === 200
      ) {
        state.loseReply = false;
        response.status(503);
        return sendJson({ error: { message: 'Synthetic RSVP reply loss.' } });
      }
      return sendJson(body);
    };
    next();
  });
  transport.use((incoming, response, next) => {
    if (incoming.path.startsWith('/api/')) app(incoming, response, next);
    else next();
  });
  transport.use((incoming, response) => {
    const upstream = httpRequest(
      new URL(incoming.originalUrl, origin),
      {
        method: incoming.method,
        headers: { ...incoming.headers, host: new URL(origin).host },
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on('error', () => response.status(502).end());
    incoming.pipe(upstream);
  });
  const url = `/api/events/${event.id}/rsvp`;
  const configure = (changes: object = {}) =>
    request(app)
      .put(url)
      .set('Origin', fixtureOrigin)
      .set('Cookie', 'picfind_session=owner')
      .send({
        version: 0,
        enabled: true,
        maxPartySize: 5,
        closesAt: null,
        ...changes,
      });
  const responses = () =>
    [...records.values()].filter(
      (row) => row.purpose === 'event-rsvp-response',
    );
  await host(page, event.id);
  return { event, publication, records, state, app, configure, responses };
}
async function host(page: Page, eventId: string) {
  await navigate(page, `/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Responses', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Private event responses', exact: true }),
  ).toBeVisible();
}
async function guest(page: Page, eventId: string) {
  await navigate(page, `/invite/${eventId}`);
  const preparation = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/public/invitations/${eventId}/rsvp/session` &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', {
      name: 'Start my response on this browser',
      exact: true,
    })
    .click();
  const cookieHeader = await (await preparation).headerValue('set-cookie');
  expect(/;\s*HttpOnly(?:;|$)/i.test(cookieHeader ?? '')).toBe(true);
  expect(/;\s*SameSite=Lax(?:;|$)/i.test(cookieHeader ?? '')).toBe(true);
  await expect(
    page.getByRole('textbox', { name: 'Your display name', exact: true }),
  ).toBeVisible();
  expect(
    (await page.context().cookies()).some(
      (cookie) => cookie.name === `picfind_rsvp_${eventId}` && cookie.httpOnly,
    ),
  ).toBe(true);
}
async function fill(page: Page, name = 'Guest family', size = '2') {
  await page
    .getByRole('textbox', { name: 'Your display name', exact: true })
    .fill(name);
  await page
    .getByRole('spinbutton', { name: 'Reported party size', exact: true })
    .fill(size);
  await page
    .getByRole('textbox', {
      name: 'Private message to host (optional)',
      exact: true,
    })
    .fill('We will arrive together.');
}
async function save(page: Page) {
  await page
    .getByLabel(
      'I have reviewed the invitation and agree to share these response details with the host.',
      { exact: true },
    )
    .check();
  await page
    .getByRole('button', { name: 'Save my response', exact: true })
    .click();
  await expect(
    page.getByText('Your response was saved privately for the event host.', {
      exact: true,
    }),
  ).toBeVisible();
}
test('enables collection and preserves a real browser receipt across reloads with private host totals and removal', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await page
    .getByLabel('Enable RSVP collection on the published invitation', {
      exact: true,
    })
    .check();
  await page
    .getByRole('spinbutton', {
      name: 'Maximum reported party size',
      exact: true,
    })
    .fill('5');
  await page
    .getByRole('button', { name: 'Save response settings', exact: true })
    .click();
  await expect(
    page.getByText('Response collection settings saved.', { exact: true }),
  ).toBeVisible();
  f.state.actor = '';
  await guest(page, f.event.id);
  await fill(page);
  await save(page);
  const cookies = await page.context().cookies();
  expect(
    cookies
      .filter((entry) => entry.name.startsWith('picfind_rsvp_'))
      .map(({ name, httpOnly, secure, path }) => ({
        name,
        httpOnly,
        secure,
        path,
      })),
  ).toEqual([
    {
      name: `picfind_rsvp_${f.event.id}`,
      httpOnly: true,
      secure: false,
      path: '/',
    },
  ]);
  await page.reload();
  await expect(
    page.getByRole('textbox', { name: 'Your display name', exact: true }),
  ).toHaveValue('Guest family');
  expect(f.responses()).toHaveLength(1);
  await page
    .getByRole('region', { name: 'Your event response', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('guest-rsvp.png'),
    fullPage: true,
  });
  f.state.actor = 'owner';
  await host(page, f.event.id);
  const totals = page.getByRole('definition').filter({ hasText: /^2$/ });
  await expect(totals).toHaveCount(1);
  await expect(
    page.getByRole('list', { name: 'Saved private responses' }),
  ).toContainText('Guest family');
  await page
    .getByRole('textbox', { name: 'Search private responses', exact: true })
    .fill('absent');
  await expect(
    page.getByText(
      '0 matching responses. Totals above include every saved response.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText('1 / 300', { exact: true })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Search private responses', exact: true })
    .fill('');
  await page
    .getByRole('list', { name: 'Saved private responses' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('host-rsvp.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', {
      name: 'Remove response from Guest family',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', { name: 'Keep response', exact: true })
    .click();
  expect(f.responses()).toHaveLength(1);
  await page
    .getByRole('button', {
      name: 'Remove response from Guest family',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', { name: 'Confirm remove response', exact: true })
    .click();
  await expect(page.getByText('0 / 300', { exact: true })).toBeVisible();
  expect(f.responses()).toHaveLength(0);
});
test('edits an intention, resets consent and permits withdrawal after the invitation is unpublished', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.configure().expect(200);
  f.state.actor = '';
  await guest(page, f.event.id);
  await fill(page);
  await save(page);
  await page
    .getByRole('combobox', { name: 'Your attendance intention', exact: true })
    .selectOption('not-going');
  await expect(
    page.getByRole('spinbutton', { name: 'Reported party size', exact: true }),
  ).toHaveValue('0');
  await expect(
    page.getByRole('button', { name: 'Save my response', exact: true }),
  ).toBeDisabled();
  await save(page);
  expect(f.responses()[0]!.rsvpResponse!.partySize).toBe(0);
  f.publication.invitationPage!.published = null;
  await navigate(page, `/invite/${f.event.id}/response`);
  await expect(
    page.getByText(
      'This event is not accepting new or changed responses. You can still withdraw a saved response from this browser.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Your display name', exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel('Confirm withdrawal of my saved response', { exact: true })
    .check();
  await page
    .getByRole('button', { name: 'Withdraw my response', exact: true })
    .click();
  await expect(
    page.getByText(
      'Your response was withdrawn and this browser receipt was cleared.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(f.responses()).toHaveLength(0);
  expect(
    (await page.context().cookies()).filter((entry) =>
      entry.name.startsWith('picfind_rsvp_'),
    ),
  ).toHaveLength(0);
});
test('recovers a lost reply and preserves a stale guest draft until confirmed reload', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.configure().expect(200);
  f.state.actor = '';
  await guest(page, f.event.id);
  await fill(page);
  f.state.loseReply = true;
  await page
    .getByLabel(
      'I have reviewed the invitation and agree to share these response details with the host.',
      { exact: true },
    )
    .check();
  await page
    .getByRole('button', { name: 'Save my response', exact: true })
    .click();
  await expect(
    page.getByText('Synthetic RSVP reply loss.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Save my response', exact: true })
    .click();
  await expect(
    page.getByText('Your response was saved privately for the event host.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(f.responses()).toHaveLength(1);
  expect(f.state.writes).toBe(2);
  f.responses()[0]!.rsvpResponse!.version++;
  f.responses()[0]!.rsvpResponse!.displayName = 'Saved elsewhere';
  await page
    .getByRole('textbox', { name: 'Your display name', exact: true })
    .fill('My unsaved name');
  await page
    .getByLabel(
      'I have reviewed the invitation and agree to share these response details with the host.',
      { exact: true },
    )
    .check();
  await page
    .getByRole('button', { name: 'Save my response', exact: true })
    .click();
  await expect(
    page.getByText(
      'Saved details changed. Your draft is preserved. Reload before submitting again.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Your display name', exact: true }),
  ).toHaveValue('My unsaved name');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page
    .getByRole('button', { name: 'Reload my response', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Your display name', exact: true }),
  ).toHaveValue('My unsaved name');
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Reload my response', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Your display name', exact: true }),
  ).toHaveValue('Saved elsewhere');
});
test('rejects a closing collection and changed invitation before recording a new response', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.configure().expect(200);
  f.state.actor = '';
  await guest(page, f.event.id);
  await fill(page);
  f.publication.invitationPage!.version = 2;
  f.publication.invitationPage!.published!.revision = 2;
  await page
    .getByLabel(
      'I have reviewed the invitation and agree to share these response details with the host.',
      { exact: true },
    )
    .check();
  await page
    .getByRole('button', { name: 'Save my response', exact: true })
    .click();
  await expect(
    page.getByText(
      'The invitation changed. Reload its details before submitting.',
      { exact: true },
    ),
  ).toBeVisible();
  expect(f.responses()).toHaveLength(0);
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Reload my response', exact: true })
    .click();
  await expect(
    page.getByText(
      'The invitation changed. Refresh the invitation page and review its latest details before responding.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.reload();
  await fill(page);
  await f.configure({ version: 1, enabled: false }).expect(200);
  await page
    .getByLabel(
      'I have reviewed the invitation and agree to share these response details with the host.',
      { exact: true },
    )
    .check();
  await page
    .getByRole('button', { name: 'Save my response', exact: true })
    .click();
  await expect(
    page.getByText('This event is not accepting responses.', { exact: true }),
  ).toBeVisible();
  expect(f.responses()).toHaveLength(0);
});
test('keeps private owner settings drafts on conflict and hides response data after an account change', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.configure().expect(200);
  await page
    .getByLabel('Enable RSVP collection on the published invitation', {
      exact: true,
    })
    .check();
  await page
    .getByRole('spinbutton', {
      name: 'Maximum reported party size',
      exact: true,
    })
    .fill('3');
  await page
    .getByRole('button', { name: 'Save response settings', exact: true })
    .click();
  await expect(
    page.getByText(
      'Saved details changed. Your settings draft is preserved. Reload before saving again.',
      { exact: true },
    ),
  ).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Reload event responses', exact: true })
    .click();
  await expect(
    page.getByRole('spinbutton', {
      name: 'Maximum reported party size',
      exact: true,
    }),
  ).toHaveValue('5');
  await page
    .getByRole('spinbutton', {
      name: 'Maximum reported party size',
      exact: true,
    })
    .fill('4');
  f.state.actor = 'other';
  await page
    .getByRole('button', { name: 'Save response settings', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Private responses unavailable',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Saved private responses' }),
  ).toHaveCount(0);
});
test('does not retain another browser receipt view after cookies are cleared', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.configure().expect(200);
  f.state.actor = '';
  await guest(page, f.event.id);
  await fill(page);
  await save(page);
  await page.context().clearCookies();
  await page
    .getByRole('textbox', { name: 'Your display name', exact: true })
    .fill('Unsaved after cookie loss');
  await page
    .getByLabel(
      'I have reviewed the invitation and agree to share these response details with the host.',
      { exact: true },
    )
    .check();
  await page
    .getByRole('button', { name: 'Save my response', exact: true })
    .click();
  await expect(
    page.getByText(
      'Response details are hidden because access changed. Reload this page to check your browser receipt.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Your display name', exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('button', {
      name: 'Start my response on this browser',
      exact: true,
    }),
  ).toBeVisible();
  expect(f.responses()).toHaveLength(1);
});
test('does not restore a held receipt response after navigating away', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.configure().expect(200);
  f.state.actor = '';
  await guest(page, f.event.id);
  await fill(page);
  await save(page);
  f.state.holdGuestRead = true;
  await navigate(page, `/invite/${f.event.id}/response`);
  await expect.poll(() => !!f.state.release).toBe(true);
  await navigate(page, '/contact');
  f.state.holdGuestRead = false;
  f.state.release!();
  await expect(page).toHaveURL(/\/contact$/);
  await expect(
    page.getByRole('textbox', { name: 'Your display name', exact: true }),
  ).toHaveCount(0);
});
