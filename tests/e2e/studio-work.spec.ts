import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { createApp } from '../../apps/api/src/app';
import { ApiError } from '../../apps/api/src/auth';
import type { LibraryRecord, LibraryStore } from '../../apps/api/src/library';
import {
  advanceProject,
  blankProject,
} from '../../packages/shared/src/studio-projects';

const origin = 'http://127.0.0.1:5173';
async function fixture(page: Page) {
  const createdAt = '2026-01-01T00:00:00.000Z',
    projectId = randomUUID();
  const records = new Map<string, LibraryRecord>([
    [
      projectId,
      {
        id: projectId,
        ownerId: 'owner',
        kind: 'job',
        purpose: 'studio-project',
        createdAt,
        studioProject: advanceProject(
          null,
          projectId,
          { ...blankProject(), name: 'Wedding delivery', stage: 'editing' },
          '',
          'owner',
          createdAt,
        ),
        projectCommandDigest: 'a'.repeat(64),
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
      throw new Error('No uploads expected.');
    },
    file: async () => {
      throw new Error('No files expected.');
    },
    removeFile: async () => {
      throw new Error('No file deletion expected.');
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
  const state = { actor: 'owner', loseReply: false };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      path = new URL(incoming.url()).pathname;
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
      path.startsWith('/api/studio/milestones/')
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
  await page.goto('/app/work');
  await expect(
    page.getByRole('heading', { name: 'Work queue', exact: true }),
  ).toBeVisible();
  const milestones = () =>
    [...records.values()].filter((row) => row.purpose === 'studio-milestone');
  const externalEdit = (changes: object) => {
    const current = milestones()[0]!.studioMilestone!;
    return request(app)
      .put(`/api/studio/milestones/${current.id}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send({
        projectId: current.projectId,
        title: current.title,
        note: current.note,
        dueDate: current.dueDate,
        timeZone: current.timeZone,
        status: current.status,
        version: current.version,
        ...changes,
      });
  };
  const archive = async () => {
    const row = records.get(projectId)!.studioProject!;
    await request(app)
      .put(`/api/studio/projects/${projectId}`)
      .set('Origin', origin)
      .set('Cookie', 'picfind_session=owner')
      .send({
        ...blankProject(),
        name: row.name,
        stage: 'archived',
        reason: '',
        version: row.version,
      })
      .expect(200);
  };
  return { records, projectId, state, milestones, externalEdit, archive };
}
const list = (page: Page) =>
  page.getByRole('list', { name: 'Milestones', exact: true });
async function fillMilestone(page: Page, projectId: string) {
  await page
    .getByRole('combobox', { name: 'Milestone project', exact: true })
    .selectOption(projectId);
  await page
    .getByLabel('Milestone title', { exact: true })
    .fill('Deliver first proofs');
  await page.getByLabel('Private work note').fill('Check crop selections');
  await page.getByLabel('Due date', { exact: true }).fill('2020-02-29');
  await page.getByLabel('Due timezone', { exact: true }).fill('Asia/Kolkata');
}
async function save(page: Page) {
  await page
    .getByRole('button', { name: 'Save milestone', exact: true })
    .click();
  await expect(
    page.getByText('Private milestone saved.', { exact: true }),
  ).toBeVisible();
}
test('persists dated work, filters it, completes and reopens it across reloads', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await fillMilestone(page, f.projectId);
  await save(page);
  await expect(list(page)).toContainText('Overdue');
  await page
    .getByRole('combobox', { name: 'Work status', exact: true })
    .selectOption('overdue');
  await expect(list(page).getByRole('button')).toHaveCount(1);
  await page.getByLabel('Search work').fill('absent');
  await expect(list(page).getByRole('button')).toHaveCount(0);
  await page.getByLabel('Search work').fill('proofs');
  await expect(list(page).getByRole('button')).toHaveCount(1);
  await page
    .getByRole('combobox', { name: 'Filter by project', exact: true })
    .selectOption(f.projectId);
  await page
    .getByRole('combobox', { name: 'Milestone status', exact: true })
    .selectOption('completed');
  await save(page);
  const completedAt = f.milestones()[0]!.studioMilestone!.completedAt;
  expect(completedAt).not.toBeNull();
  await expect(list(page).getByRole('button')).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Work status', exact: true })
    .selectOption('completed');
  await expect(list(page)).toContainText('Completed');
  await page.reload();
  await page
    .getByRole('combobox', { name: 'Work status', exact: true })
    .selectOption('completed');
  await list(page).getByRole('button').click();
  await expect(page.getByLabel('Due date', { exact: true })).toHaveValue(
    '2020-02-29',
  );
  await expect(page.getByLabel('Due timezone', { exact: true })).toHaveValue(
    'Asia/Kolkata',
  );
  await page.getByLabel('Private work note').fill('Completed work amended');
  await save(page);
  expect(f.milestones()[0]!.studioMilestone!.completedAt).toBe(completedAt);
  await page
    .getByRole('combobox', { name: 'Milestone status', exact: true })
    .selectOption('open');
  await save(page);
  expect(f.milestones()[0]!.studioMilestone!.completedAt).toBeNull();
  await page
    .getByRole('combobox', { name: 'Work status', exact: true })
    .selectOption('overdue');
  await page.screenshot({
    path: info.outputPath('studio-work.png'),
    fullPage: true,
  });
});
test('preserves stale drafts until explicit reload', async ({ page }) => {
  const f = await fixture(page);
  await fillMilestone(page, f.projectId);
  await save(page);
  await page.getByLabel('Private work note').fill('Local unsaved instructions');
  await f.externalEdit({ note: 'Other tab instructions' }).expect(200);
  await page
    .getByRole('button', { name: 'Save milestone', exact: true })
    .click();
  await expect(
    page.getByText('Your draft is preserved.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel('Private work note')).toHaveValue(
    'Local unsaved instructions',
  );
  await expect(
    page.getByRole('button', { name: 'Save milestone', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Reload and discard draft' }).click();
  await expect(page.getByText('Latest work queue loaded.')).toBeVisible();
  await list(page).getByRole('button').click();
  await expect(page.getByLabel('Private work note')).toHaveValue(
    'Other tab instructions',
  );
});
test('suppresses archived alerts and removes only the explicitly confirmed milestone', async ({
  page,
}) => {
  const f = await fixture(page);
  await fillMilestone(page, f.projectId);
  await save(page);
  await f.archive();
  await page.getByRole('button', { name: 'Reload and discard draft' }).click();
  await expect(page.getByText('Latest work queue loaded.')).toBeVisible();
  await list(page).getByRole('button').click();
  await expect(list(page)).toContainText('(archived)');
  await expect(list(page)).not.toContainText('Overdue');
  await expect(
    page.getByRole('button', { name: 'Save milestone', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Remove milestone', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Keep milestone', exact: true })
    .click();
  expect(f.milestones()).toHaveLength(1);
  await page
    .getByRole('button', { name: 'Remove milestone', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Confirm removal', exact: true })
    .click();
  await expect(
    page.getByText('Milestone removed.', { exact: true }),
  ).toBeVisible();
  expect(f.milestones()).toHaveLength(0);
  expect(f.records.has(f.projectId)).toBe(true);
});
test('recovers a committed completion after losing its reply without changing the completion time', async ({
  page,
}) => {
  const f = await fixture(page);
  await fillMilestone(page, f.projectId);
  await page
    .getByRole('combobox', { name: 'Milestone status', exact: true })
    .selectOption('completed');
  f.state.loseReply = true;
  await page
    .getByRole('button', { name: 'Save milestone', exact: true })
    .click();
  await expect(
    page.getByText('Synthetic reply loss after commit.'),
  ).toBeVisible();
  const committed = structuredClone(f.milestones()[0]!.studioMilestone);
  await save(page);
  expect(f.milestones()).toHaveLength(1);
  expect(f.milestones()[0]!.studioMilestone).toEqual(committed);
});
test('hides cached work when the signed-in account changes', async ({
  page,
}) => {
  const f = await fixture(page);
  await fillMilestone(page, f.projectId);
  await save(page);
  f.state.actor = 'other';
  await page.getByRole('button', { name: 'Reload and discard draft' }).click();
  await expect(
    page.getByText(
      'Private work is hidden until your account is checked again.',
    ),
  ).toBeVisible();
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByLabel('Private work note')).toHaveCount(0);
  await expect(page.getByText('Wedding delivery', { exact: true })).toHaveCount(
    0,
  );
  expect(f.milestones()).toHaveLength(1);
});
test('updates overdue display when the saved timezone crosses midnight', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-03-09T03:59:30Z') });
  const f = await fixture(page);
  await fillMilestone(page, f.projectId);
  await page.getByLabel('Due date', { exact: true }).fill('2026-03-08');
  await page
    .getByLabel('Due timezone', { exact: true })
    .fill('America/New_York');
  await save(page);
  await page
    .getByRole('combobox', { name: 'Work status', exact: true })
    .selectOption('overdue');
  await expect(list(page).getByRole('button')).toHaveCount(0);
  await page.clock.fastForward(61_000);
  await expect(list(page).getByRole('button')).toHaveCount(1);
});
