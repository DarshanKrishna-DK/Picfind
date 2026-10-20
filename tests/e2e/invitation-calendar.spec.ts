import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { expect, test, type Page } from '@playwright/test';
import {
  blankInvitationPage,
  type PublicInvitationPage,
} from '../../packages/shared/src/event-invitation-page';

async function fixture(page: Page) {
  const publication: PublicInvitationPage = {
    eventId: randomUUID(),
    revision: 1,
    publishedAt: '2026-10-21T10:00:00.000Z',
    fields: {
      ...blankInvitationPage(),
      heading: 'Public celebration',
      date: '2026-12-31',
      venue: 'Published garden',
      instructions: 'Please arrive together.',
    },
  };
  const state = {
    publication,
    reads: 0,
    unavailableAt: 0,
    replaceAt: 0,
    holdAt: 0,
    downloads: 0,
    release: null as null | (() => void),
  };
  page.on('download', () => state.downloads++);
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/public/invitations/${publication.eventId}`) {
      state.reads++;
      if (state.reads === state.holdAt)
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      if (state.unavailableAt && state.reads >= state.unavailableAt)
        return route.fulfill({
          status: 404,
          json: { error: { message: 'This invitation is unavailable.' } },
        });
      if (state.reads === state.replaceAt) {
        publication.revision++;
        publication.fields.heading = 'Updated celebration';
      }
      return route.fulfill({ json: publication });
    }
    if (path === `/api/public/invitations/${publication.eventId}/rsvp`)
      return route.fulfill({
        json: {
          eventId: publication.eventId,
          receiptId: null,
          invitationRevision: publication.revision,
          accepting: false,
          policy: { enabled: false, closesAt: null, maxPartySize: 1 },
          response: null,
        },
      });
    return route.fulfill({
      status: 401,
      json: { error: { message: 'No signed-in account.' } },
    });
  });
  return state;
}
async function open(page: Page, eventId: string) {
  await page.goto(`/invite/${eventId}`);
  await expect(
    page.getByRole('heading', { name: 'Save the date' }),
  ).toBeVisible();
}
const button = (page: Page) =>
  page.getByRole('button', { name: 'Download calendar reminder', exact: true });
async function download(page: Page) {
  const pending = page.waitForEvent('download');
  await button(page).click();
  const file = await pending;
  expect(file.suggestedFilename()).toBe('picfind-invitation.ics');
  const content = await readFile((await file.path())!, 'utf8'),
    calendar = new ICAL.Component(ICAL.parse(content));
  return {
    content,
    component: calendar.getFirstSubcomponent('vevent')!,
    event: new ICAL.Event(calendar.getFirstSubcomponent('vevent')!),
  };
}
test('downloads a fresh all-day reminder containing only public invitation details', async ({
  page,
}, info) => {
  const state = await fixture(page);
  await open(page, state.publication.eventId);
  const beforeDownload = state.reads;
  const { event, component } = await download(page);
  expect(event.summary).toBe('Public celebration');
  expect(event.startDate.toString()).toBe('2026-12-31');
  expect(event.endDate.toString()).toBe('2027-01-01');
  expect(component.getFirstPropertyValue('location')).toBe('Published garden');
  expect(event.description).toContain('Please arrive together.');
  expect(component.getFirstPropertyValue('url')).toContain(
    `/invite/${state.publication.eventId}`,
  );
  expect(component.hasProperty('attendee')).toBe(false);
  expect(state.reads).toBeGreaterThanOrEqual(beforeDownload + 2);
  expect(state.downloads).toBe(1);
  await expect(
    page.getByText(/Calendar download started\. Import the saved file/),
  ).toBeVisible();
  await page
    .getByRole('region', { name: 'Calendar reminder' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('calendar-reminder.png'),
    fullPage: true,
  });
});
test('requires a repeated-hour choice and exports the selected UTC occurrence', async ({
  page,
}) => {
  const state = await fixture(page);
  Object.assign(state.publication.fields, {
    date: '2026-11-01',
    time: '01:30',
    timeZone: 'America/New_York',
  });
  await open(page, state.publication.eventId);
  await expect(button(page)).toBeDisabled();
  await page
    .getByRole('combobox', {
      name: 'Intended occurrence of the repeated local time',
      exact: true,
    })
    .selectOption('2026-11-01T06:30:00.000Z');
  await expect(
    page.getByText('Calendar start in UTC: 2026-11-01T06:30:00.000Z.'),
  ).toBeVisible();
  const { event, component } = await download(page);
  expect(event.startDate.toJSDate().toISOString()).toBe(
    '2026-11-01T06:30:00.000Z',
  );
  expect(component.hasProperty('dtend')).toBe(false);
});
for (const readOffset of [1, 2])
  test(`rejects publication replacement on export read ${readOffset} and succeeds after reloading`, async ({
    page,
  }) => {
    const state = await fixture(page);
    await open(page, state.publication.eventId);
    state.replaceAt = state.reads + readOffset;
    await button(page).click();
    await expect(
      page.getByText(/The published invitation changed\./),
    ).toBeVisible();
    expect(state.downloads).toBe(0);
    await page.reload();
    expect((await download(page)).event.summary).toBe('Updated celebration');
  });
test('blocks withdrawal at the final read without downloading a stale reminder', async ({
  page,
}) => {
  const state = await fixture(page);
  await open(page, state.publication.eventId);
  state.unavailableAt = state.reads + 2;
  await button(page).click();
  await expect(
    page.getByText('This invitation is unavailable.', { exact: true }),
  ).toBeVisible();
  expect(state.downloads).toBe(0);
  await expect(button(page)).toBeEnabled();
});
test('cancels a held final read and permits a fresh retry', async ({
  page,
}) => {
  const state = await fixture(page);
  await open(page, state.publication.eventId);
  state.holdAt = state.reads + 2;
  await button(page).click();
  await expect.poll(() => !!state.release).toBe(true);
  await page
    .getByRole('button', { name: 'Cancel calendar download', exact: true })
    .click();
  await expect(
    page.getByText('Calendar download cancelled.', { exact: true }),
  ).toBeVisible();
  state.release!();
  state.holdAt = 0;
  expect((await download(page)).event.summary).toBe('Public celebration');
  expect(state.downloads).toBe(1);
});
test('does not download after leaving a pending calendar read', async ({
  page,
}) => {
  const state = await fixture(page);
  await open(page, state.publication.eventId);
  state.holdAt = state.reads + 1;
  await button(page).click();
  await expect.poll(() => !!state.release).toBe(true);
  await page.goto('/contact');
  state.release!();
  await expect(page).toHaveURL(/\/contact$/);
  expect(state.downloads).toBe(0);
  await expect(button(page)).toHaveCount(0);
});
