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
  const projectId = randomUUID(),
    createdAt = '2026-01-01T00:00:00.000Z';
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
          { ...blankProject(), name: 'Wedding booking', stage: 'booked' },
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
      throw new Error('No upload expected.');
    },
    file: async () => {
      throw new Error('No file reads expected.');
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
      path = new URL(incoming.url()).pathname,
      target = request(app);
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
      path.startsWith('/api/studio/appointments/')
    ) {
      state.loseReply = false;
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Synthetic appointment reply loss.' } },
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
  await page.goto('/app/schedule');
  await expect(
    page.getByRole('heading', { name: 'Private schedule', exact: true }),
  ).toBeVisible();
  const appointments = () =>
    [...records.values()].filter((row) => row.purpose === 'studio-appointment');
  const externalEdit = (changes: object) => {
    const current = appointments()[0]!.studioAppointment!;
    const fields = Object.fromEntries(
      Object.entries(current).filter(
        ([key]) => !['id', 'createdAt', 'updatedAt'].includes(key),
      ),
    );
    return request(app)
      .put(`/api/studio/appointments/${current.id}`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .send({ ...fields, ...changes });
  };
  const archive = () =>
    request(app)
      .put(`/api/studio/projects/${projectId}`)
      .set('Cookie', 'picfind_session=owner')
      .set('Origin', origin)
      .send({
        ...blankProject(),
        name: 'Wedding booking',
        stage: 'archived',
        reason: '',
        version: 1,
      });
  return { records, projectId, state, appointments, externalEdit, archive };
}
const list = (page: Page) =>
  page.getByRole('list', { name: 'Appointments', exact: true });
async function fill(page: Page, projectId: string, title = 'Portrait session') {
  await page
    .getByRole('combobox', { name: 'Appointment project', exact: true })
    .selectOption(projectId);
  await page.getByLabel('Appointment title', { exact: true }).fill(title);
  await page
    .getByLabel('Private appointment note')
    .fill('Private location instructions');
  await page
    .getByLabel('Appointment timezone', { exact: true })
    .fill('Asia/Kolkata');
  await page
    .getByLabel('Start local time', { exact: true })
    .fill('2026-11-01T10:00');
  await page
    .getByLabel('End local time', { exact: true })
    .fill('2026-11-01T11:00');
}
async function save(page: Page) {
  await page
    .getByRole('button', { name: 'Save appointment', exact: true })
    .click();
  await expect(
    page.getByText('Private appointment saved.', { exact: true }),
  ).toBeVisible();
}
test('persists timezone reservations with date, project and text filters across reloads', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await fill(page, f.projectId);
  await save(page);
  expect(f.appointments()[0]!.studioAppointment!.startAt).toBe(
    '2026-11-01T04:30:00.000Z',
  );
  await page.getByLabel('Search appointments').fill('missing');
  await expect(list(page).getByRole('button')).toHaveCount(0);
  await page.getByLabel('Search appointments').fill('portrait');
  await page.getByLabel('From date', { exact: true }).fill('2026-11-02');
  await expect(list(page).getByRole('button')).toHaveCount(0);
  await page.getByLabel('From date', { exact: true }).fill('2026-11-01');
  await page.getByLabel('Through date', { exact: true }).fill('2026-11-01');
  await page
    .getByRole('combobox', { name: 'Schedule project filter', exact: true })
    .selectOption(f.projectId);
  await expect(list(page).getByRole('button')).toHaveCount(1);
  await page.reload();
  await list(page).getByRole('button').click();
  await expect(
    page.getByLabel('Appointment timezone', { exact: true }),
  ).toHaveValue('Asia/Kolkata');
  await expect(
    page.getByLabel('Start local time', { exact: true }),
  ).toHaveValue('2026-11-01T10:00');
  await page.screenshot({
    path: info.outputPath('studio-schedule.png'),
    fullPage: true,
  });
});
test('rejects overlapping drafts and releases a reservation only after explicit cancellation', async ({
  page,
}) => {
  const f = await fixture(page);
  await fill(page, f.projectId);
  await save(page);
  await page
    .getByRole('button', { name: 'New appointment', exact: true })
    .click();
  await fill(page, f.projectId, 'Second session');
  await page
    .getByRole('button', { name: 'Save appointment', exact: true })
    .click();
  await expect(
    page.getByText('This time overlaps another scheduled appointment.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Appointment title', { exact: true }),
  ).toHaveValue('Second session');
  expect(f.appointments()).toHaveLength(1);
  await list(page)
    .getByRole('button', { name: /Portrait session/ })
    .click();
  await page
    .getByRole('button', { name: 'Cancel saved appointment', exact: true })
    .click();
  await expect(
    page.getByText('Saved appointment cancelled. Its time is available again.'),
  ).toBeVisible();
  await expect(list(page).getByRole('button')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'New appointment', exact: true })
    .click();
  await fill(page, f.projectId, 'Second session');
  await save(page);
  await page
    .getByRole('combobox', { name: 'Appointment filter', exact: true })
    .selectOption('all');
  await list(page)
    .getByRole('button', { name: /Portrait session/ })
    .click();
  await page
    .getByRole('button', { name: 'Restore saved appointment', exact: true })
    .click();
  await expect(
    page.getByText('This time overlaps another scheduled appointment.', {
      exact: false,
    }),
  ).toBeVisible();
  expect(
    f
      .appointments()
      .find((row) => row.studioAppointment!.title === 'Portrait session')!
      .studioAppointment!.status,
  ).toBe('cancelled');
});
test('rejects a DST gap and requires choosing an occurrence for a repeated local hour', async ({
  page,
}) => {
  const f = await fixture(page);
  await fill(page, f.projectId);
  await page
    .getByLabel('Appointment timezone', { exact: true })
    .fill('America/New_York');
  await page
    .getByLabel('Start local time', { exact: true })
    .fill('2026-03-08T02:30');
  await page
    .getByLabel('End local time', { exact: true })
    .fill('2026-03-08T03:30');
  await expect(
    page.getByText('This start time or timezone is invalid', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save appointment', exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel('Start local time', { exact: true })
    .fill('2026-11-01T01:30');
  await page
    .getByLabel('End local time', { exact: true })
    .fill('2026-11-01T02:30');
  await expect(
    page.getByRole('button', { name: 'Save appointment', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('combobox', { name: 'Start occurrence', exact: true })
    .selectOption('2026-11-01T06:30:00.000Z');
  await save(page);
  expect(f.appointments()[0]!.studioAppointment).toMatchObject({
    startAt: '2026-11-01T06:30:00.000Z',
    endAt: '2026-11-01T07:30:00.000Z',
    timeZone: 'America/New_York',
  });
});
test('preserves stale appointment drafts until an explicit reload', async ({
  page,
}) => {
  const f = await fixture(page);
  await fill(page, f.projectId);
  await save(page);
  await page.getByLabel('Private appointment note').fill('Local draft');
  await f.externalEdit({ note: 'Other tab instructions' }).expect(200);
  await page
    .getByRole('button', { name: 'Save appointment', exact: true })
    .click();
  await expect(
    page.getByText('Your appointment draft is preserved.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel('Private appointment note')).toHaveValue(
    'Local draft',
  );
  await expect(
    page.getByRole('button', { name: 'Save appointment', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Reload and discard appointment draft' })
    .click();
  await expect(page.getByText('Latest schedule loaded.')).toBeVisible();
  await list(page).getByRole('button').click();
  await expect(page.getByLabel('Private appointment note')).toHaveValue(
    'Other tab instructions',
  );
});
test('recovers a lost save reply without duplicating or changing the reserved interval', async ({
  page,
}) => {
  const f = await fixture(page);
  await fill(page, f.projectId);
  f.state.loseReply = true;
  await page
    .getByRole('button', { name: 'Save appointment', exact: true })
    .click();
  await expect(
    page.getByText('Synthetic appointment reply loss.'),
  ).toBeVisible();
  const committed = structuredClone(f.appointments()[0]!.studioAppointment);
  await save(page);
  expect(f.appointments()).toHaveLength(1);
  expect(f.appointments()[0]!.studioAppointment).toEqual(committed);
});
test('allows cancelling an archived project reservation while preventing edits and restoration', async ({
  page,
}) => {
  const f = await fixture(page);
  await fill(page, f.projectId);
  await save(page);
  await f.archive().expect(200);
  await page
    .getByRole('button', { name: 'Reload and discard appointment draft' })
    .click();
  await expect(page.getByText('Latest schedule loaded.')).toBeVisible();
  await list(page).getByRole('button').click();
  await expect(
    page.getByRole('button', { name: 'Save appointment', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Cancel saved appointment', exact: true })
    .click();
  await expect(
    page.getByText('Saved appointment cancelled. Its time is available again.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Restore saved appointment',
      exact: true,
    }),
  ).toBeDisabled();
});
test('removes only the explicitly confirmed appointment', async ({ page }) => {
  const f = await fixture(page);
  await fill(page, f.projectId);
  await save(page);
  await page
    .getByRole('button', { name: 'Remove appointment', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Keep appointment', exact: true })
    .click();
  expect(f.appointments()).toHaveLength(1);
  await page
    .getByRole('button', { name: 'Remove appointment', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Confirm appointment removal', exact: true })
    .click();
  await expect(
    page.getByText('Appointment removed.', { exact: true }),
  ).toBeVisible();
  expect(f.appointments()).toHaveLength(0);
  expect(f.records.has(f.projectId)).toBe(true);
});
test('hides private reservations after a browser account change', async ({
  page,
}) => {
  const f = await fixture(page);
  await fill(page, f.projectId);
  await save(page);
  f.state.actor = 'other';
  await page
    .getByRole('button', { name: 'Reload and discard appointment draft' })
    .click();
  await expect(
    page.getByText(
      'Private appointments are hidden until your account is checked again.',
    ),
  ).toBeVisible();
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByLabel('Private appointment note')).toHaveCount(0);
});
