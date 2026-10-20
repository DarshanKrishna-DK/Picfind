import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';

const origin = 'http://127.0.0.1:5173';
async function fixture(page: Page) {
  const now = new Date().toISOString(),
    clientId = randomUUID(),
    eventId = randomUUID();
  const records = new Map<string, LibraryRecord>([
    [
      eventId,
      {
        id: eventId,
        ownerId: 'owner',
        kind: 'event',
        title: 'Wedding gallery',
        createdAt: now,
        visibility: 'private',
      },
    ],
    [
      clientId,
      {
        id: clientId,
        ownerId: 'owner',
        kind: 'job',
        purpose: 'studio-client',
        createdAt: now,
        studioClient: {
          id: clientId,
          name: 'Asha Rao',
          email: 'private@example.test',
          phone: '',
          company: '',
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
  ]);
  const store: LibraryStore = {
    list: async (actor, kind) =>
      [...records.values()]
        .filter((row) => row.ownerId === actor && row.kind === kind)
        .map((row) => structuredClone(row)),
    get: async (id) => {
      const row = records.get(id);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unavailable.');
      return structuredClone(row);
    },
    put: async (row, create) => {
      if (create && records.has(row.id))
        throw new ApiError(409, 'CONFLICT', 'Existing record.');
      records.set(row.id, structuredClone(row));
    },
    remove: async (id) => {
      records.delete(id);
    },
    upload: async () => {
      throw new Error('No file uploads expected.');
    },
    file: async () => {
      throw new Error('No photo reads expected.');
    },
    removeFile: async () => {
      throw new Error('No photo deletion expected.');
    },
  };
  const app = createApp(
    {
      webOrigin: origin,
      secureCookies: false,
      provider: {
        getUser: async (id) => ({
          id,
          name: 'Owner',
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
  const state = { actor: 'owner', failRead: false, loseReply: false };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      path = new URL(incoming.url()).pathname;
    if (
      state.failRead &&
      path === '/api/studio/projects' &&
      incoming.method() === 'GET'
    )
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Synthetic project read outage.' } },
      });
    const target = request(app);
    const outgoing =
      incoming.method() === 'PUT'
        ? target.put(path)
        : incoming.method() === 'DELETE'
          ? target.delete(path)
          : incoming.method() === 'POST'
            ? target.post(path)
            : target.get(path);
    outgoing
      .set('Cookie', `picfind_session=${state.actor}`)
      .set('Origin', origin);
    const actor = incoming.headers()['x-picfind-studio-actor'];
    if (actor) outgoing.set('X-PicFind-Studio-Actor', actor);
    if (incoming.postData()) outgoing.send(incoming.postDataJSON());
    const response = await outgoing;
    if (
      state.loseReply &&
      incoming.method() === 'PUT' &&
      path.startsWith('/api/studio/projects/')
    ) {
      state.loseReply = false;
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Synthetic reply loss after commit.' } },
      });
    }
    return route.fulfill({
      status: response.status,
      body: response.text,
      headers: {
        'content-type': response.headers['content-type'] ?? 'application/json',
      },
    });
  });
  await page.goto('/app/projects');
  await expect(
    page.getByRole('heading', { name: 'Projects', exact: true }),
  ).toBeVisible();
  const projects = () =>
    [...records.values()].filter((row) => row.purpose === 'studio-project');
  async function externalEdit(id: string, changes: object) {
    const current = records.get(id)!.studioProject!;
    return request(app)
      .put(`/api/studio/projects/${id}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send({
        name: current.name,
        summary: current.summary,
        clientId: current.clientId,
        eventIds: current.eventIds,
        stage: current.stage,
        reason: '',
        version: current.version,
        ...changes,
      })
      .expect(200);
  }
  return { records, projects, state, clientId, eventId, externalEdit };
}
async function createProject(page: Page, clientId: string) {
  await page
    .getByLabel('Project name', { exact: true })
    .fill('Asha wedding delivery');
  await page
    .getByLabel('Private project brief')
    .fill('Prepare a small private album selection.');
  await page
    .getByRole('combobox', { name: 'Linked client', exact: true })
    .selectOption(clientId);
  await page.getByRole('checkbox', { name: 'Wedding gallery' }).check();
  await page.getByRole('button', { name: 'Save private project' }).click();
  await expect(page.getByText('Private project saved.')).toBeVisible();
}
const projectList = (page: Page) =>
  page.getByRole('list', { name: 'Saved projects' });
test('creates linked work, advances stages, searches and reloads actual persisted API state', async ({
  page,
}, testInfo) => {
  const f = await fixture(page);
  await createProject(page, f.clientId);
  expect(f.projects()[0]!.studioProject).toMatchObject({
    clientId: f.clientId,
    eventIds: [f.eventId],
    stage: 'inquiry',
    version: 1,
  });
  await page
    .getByRole('combobox', { name: 'Project stage', exact: true })
    .selectOption('editing');
  await page.getByLabel('Reason for stage change').fill('Photos selected');
  await page.getByRole('button', { name: 'Save private project' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Project history' })
      .getByText('Photos selected'),
  ).toBeVisible();
  await page.getByLabel('Filter by stage').selectOption('inquiry');
  await expect(projectList(page).getByRole('button')).toHaveCount(0);
  await page.getByLabel('Filter by stage').selectOption('editing');
  await page.getByLabel('Search projects').fill('Asha');
  await expect(projectList(page).getByRole('button')).toHaveCount(1);
  await page.reload();
  await projectList(page).getByRole('button').click();
  await expect(
    page.getByRole('combobox', { name: 'Project stage', exact: true }),
  ).toHaveValue('editing');
  await expect(
    page.getByRole('combobox', { name: 'Linked client', exact: true }),
  ).toHaveValue(f.clientId);
  await expect(
    page.getByRole('checkbox', { name: 'Wedding gallery' }),
  ).toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath('studio-projects.png'),
    fullPage: true,
  });
});
test('requires backward reasons and removes only a confirmed archived project', async ({
  page,
}) => {
  const f = await fixture(page);
  await createProject(page, f.clientId);
  await page
    .getByRole('combobox', { name: 'Project stage', exact: true })
    .selectOption('archived');
  await page.getByRole('button', { name: 'Save private project' }).click();
  await expect(
    page.getByRole('button', { name: 'Remove archived project' }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Project stage', exact: true })
    .selectOption('editing');
  await expect(
    page.getByRole('button', { name: 'Save private project' }),
  ).toBeDisabled();
  await page
    .getByLabel('Reason for stage change')
    .fill('Client requested an amendment');
  await page.getByRole('button', { name: 'Save private project' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Project history' })
      .getByText('Client requested an amendment'),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Project stage', exact: true })
    .selectOption('archived');
  await page.getByRole('button', { name: 'Save private project' }).click();
  await page.getByRole('button', { name: 'Remove archived project' }).click();
  await page.getByRole('button', { name: 'Keep project' }).click();
  expect(f.projects()).toHaveLength(1);
  await page.getByRole('button', { name: 'Remove archived project' }).click();
  await page.getByRole('button', { name: 'Confirm remove project' }).click();
  await expect(
    page.getByText('Archived project record removed.'),
  ).toBeVisible();
  expect(f.projects()).toHaveLength(0);
  expect(f.records.has(f.clientId)).toBe(true);
  expect(f.records.has(f.eventId)).toBe(true);
});
test('preserves a stale draft and shows current unavailable linked records after reload', async ({
  page,
}) => {
  const f = await fixture(page);
  await createProject(page, f.clientId);
  await page.getByLabel('Private project brief').fill('Local unsaved brief');
  await f.externalEdit(f.projects()[0]!.id, {
    summary: 'Other tab saved this brief',
  });
  await page.getByRole('button', { name: 'Save private project' }).click();
  await expect(
    page.getByText('Your draft is preserved.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel('Private project brief')).toHaveValue(
    'Local unsaved brief',
  );
  await expect(
    page.getByRole('button', { name: 'Save private project' }),
  ).toBeDisabled();
  f.records.delete(f.clientId);
  f.records.delete(f.eventId);
  await page
    .getByRole('button', { name: 'Load latest projects and discard draft' })
    .click();
  await expect(page.getByText('Latest projects loaded.')).toBeVisible();
  await projectList(page).getByRole('button').click();
  await expect(page.getByLabel('Private project brief')).toHaveValue(
    'Other tab saved this brief',
  );
  await expect(
    page.getByRole('checkbox', { name: 'Unavailable linked event' }),
  ).toBeChecked();
  await page
    .getByRole('combobox', { name: 'Project stage', exact: true })
    .selectOption('archived');
  await page.getByRole('button', { name: 'Save private project' }).click();
  await expect(page.getByText('Private project saved.')).toBeVisible();
  expect(f.projects()[0]!.studioProject!.stage).toBe('archived');
});
test('recovers the exact committed save after a lost browser reply without a duplicate stage change', async ({
  page,
}) => {
  const f = await fixture(page);
  f.state.loseReply = true;
  await page
    .getByLabel('Project name', { exact: true })
    .fill('Lost reply project');
  await page.getByRole('button', { name: 'Save private project' }).click();
  await expect(
    page.getByText('Synthetic reply loss after commit.'),
  ).toBeVisible();
  expect(f.projects()).toHaveLength(1);
  await page.getByRole('button', { name: 'Save private project' }).click();
  await expect(page.getByText('Private project saved.')).toBeVisible();
  expect(f.projects()).toHaveLength(1);
  expect(f.projects()[0]!.studioProject).toMatchObject({
    version: 1,
    transitionCount: 1,
  });
});
test('hides private project data when a different account is detected', async ({
  page,
}) => {
  const f = await fixture(page);
  await createProject(page, f.clientId);
  f.state.actor = 'other';
  await page
    .getByRole('button', { name: 'Load latest projects and discard draft' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Projects unavailable' }),
  ).toBeVisible();
  await expect(projectList(page)).toHaveCount(0);
  await expect(page.getByLabel('Private project brief')).toHaveCount(0);
  expect(f.projects()).toHaveLength(1);
});
