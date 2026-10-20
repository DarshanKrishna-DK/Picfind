import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { proposalFixture } from '../fixtures/studio-proposals';
import { questionnaireOrigin } from '../fixtures/questionnaires';

async function fixture(page: Page) {
  const f = await proposalFixture();
  const state = {
    actor: f.ownerId as string,
    loseReply: false,
    failRead: '',
    writes: 0,
  };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url()),
      path = url.pathname + url.search,
      method = incoming.method().toLowerCase() as
        'get' | 'post' | 'put' | 'patch' | 'delete';
    if (method === 'get' && state.failRead === url.pathname)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Synthetic proposal read failure.' },
        }),
      });
    let call = request(f.app)[method](path).set('Origin', questionnaireOrigin);
    if (state.actor)
      call = call.set('Cookie', `picfind_session=${state.actor}`);
    for (const header of [
      'x-picfind-proposal-actor',
      'x-picfind-service-actor',
    ])
      if (incoming.headers()[header])
        call = call.set(header, incoming.headers()[header]!);
    if (incoming.postData()) call = call.send(JSON.parse(incoming.postData()!));
    if (method === 'put') state.writes++;
    const response = await call;
    if (method === 'put' && state.loseReply && response.status === 200) {
      state.loseReply = false;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Synthetic saved reply loss.' },
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
  const openOwner = async () => {
    state.actor = f.ownerId;
    await page.goto(`/app/projects/${f.projectId}/proposals`);
    await expect(
      page.getByRole('heading', { name: 'Prepare a proposal' }),
    ).toBeVisible();
  };
  const openClient = async (id: string = f.proposalId) => {
    state.actor = f.clientId;
    await page.goto(`/proposals/${id}`);
    await expect(
      page.getByRole('heading', { name: 'Your preference', exact: true }),
    ).toBeVisible();
  };
  const choose = async () => {
    await page.getByRole('radio', { name: /Event portraits/ }).check();
    await page.getByRole('checkbox', { name: /I agree to share/ }).check();
  };
  return { ...f, state, openOwner, openClient, choose };
}
test('issues immutable packages and records an explicit client preference', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await f.openOwner();
  await page.getByRole('checkbox', { name: /Event portraits/ }).check();
  await page
    .getByLabel('Introduction', { exact: true })
    .fill('A private set of options for your event.');
  await page.screenshot({
    path: info.outputPath('proposal-editor.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Issue proposal', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Proposal issued');
  const id = [...f.records.values()].find(
    (row) => row.purpose === 'studio-proposal',
  )!.id;
  const proposal = f.records.get(id)!.studioProposal!;
  await f.save({ amountMinor: 500000 }, 1).expect(200);
  await f.openClient(id);
  await expect(
    page.getByRole('button', { name: 'Save preference' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('radio', { name: /Event portraits/ }),
  ).not.toBeChecked();
  await f.choose();
  await page
    .getByLabel('Note for your photographer')
    .fill('Please confirm the afternoon slot.');
  await page.getByRole('button', { name: 'Save preference' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Your preference is saved',
  );
  expect(proposal.options[0]!.amountMinor).toBe(250000);
  await page.screenshot({
    path: info.outputPath('client-preference.png'),
    fullPage: true,
  });
  await f.openOwner();
  await expect(
    page.getByText('Preferred: Event portraits', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Please confirm the afternoon slot.', { exact: true }),
  ).toBeVisible();
  expect(f.records.get(f.projectId)!.studioProject!.stage).toBe('inquiry');
});
test('recovers an issued proposal after a lost reply without creating duplicates', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.openOwner();
  await page.getByRole('checkbox', { name: /Event portraits/ }).check();
  f.state.loseReply = true;
  await page
    .getByRole('button', { name: 'Issue proposal', exact: true })
    .click();
  await expect(page.getByText('Synthetic saved reply loss.')).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: /Event portraits/ }),
  ).toBeChecked();
  await page
    .getByRole('button', { name: 'Issue proposal', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Proposal issued');
  expect(
    [...f.records.values()].filter((row) => row.purpose === 'studio-proposal'),
  ).toHaveLength(1);
});
test('recovers a lost preference reply and then permits a versioned decline', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.issue().expect(200);
  await f.openClient();
  await f.choose();
  await page
    .getByLabel('Note for your photographer')
    .fill('Keep this note after an uncertain reply.');
  f.state.loseReply = true;
  await page.getByRole('button', { name: 'Save preference' }).click();
  await expect(page.getByText('Synthetic saved reply loss.')).toBeVisible();
  await expect(page.getByLabel('Note for your photographer')).toHaveValue(
    'Keep this note after an uncertain reply.',
  );
  await page.getByRole('button', { name: 'Save preference' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Your preference is saved',
  );
  expect(f.records.get(f.responseId)!.proposalResponse!.version).toBe(1);
  await page
    .getByRole('radio', { name: 'Decline these options', exact: true })
    .check();
  await page.getByRole('checkbox', { name: /I agree to share/ }).check();
  await page.getByRole('button', { name: 'Save preference' }).click();
  await expect(
    page.getByText('Client declined these options', { exact: true }),
  ).toBeVisible();
  expect(f.records.get(f.responseId)!.proposalResponse!.version).toBe(2);
  expect(f.records.get(f.responseId)!.proposalResponse!.serviceId).toBeNull();
});
test('preserves stale drafts and requires an explicit latest-preference replacement', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.issue().expect(200);
  await f.openClient();
  await f.choose();
  await page
    .getByLabel('Note for your photographer')
    .fill('My unsaved local preference');
  await f.respond({ note: 'Another tab saved this' }).expect(200);
  await page
    .getByRole('button', { name: 'Reload proposal', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'A newer preference is available',
  );
  await expect(page.getByLabel('Note for your photographer')).toHaveValue(
    'My unsaved local preference',
  );
  await expect(
    page.getByRole('button', { name: 'Save preference' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Load latest preference' }).click();
  await expect(page.getByLabel('Note for your photographer')).toHaveValue(
    'Another tab saved this',
  );
  await expect(
    page.getByRole('checkbox', { name: /I agree to share/ }),
  ).not.toBeChecked();
});
test('blocks writes and cached adoption after a failed read and recovers the draft', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.issue().expect(200);
  await f.openClient();
  await f.choose();
  await page
    .getByLabel('Note for your photographer')
    .fill('Preserve while offline');
  f.state.failRead = f.clientPath;
  await page
    .getByRole('button', { name: 'Reload proposal', exact: true })
    .click();
  await expect(
    page.getByText('Synthetic proposal read failure.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save preference' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Load latest preference' }),
  ).toBeDisabled();
  f.state.failRead = '';
  await page
    .getByRole('button', { name: 'Reload proposal', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Save preference' }),
  ).toBeEnabled();
  await expect(page.getByLabel('Note for your photographer')).toHaveValue(
    'Preserve while offline',
  );
});
test('requires recipient and catalog changes to be explicitly reviewed', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.openOwner();
  await page.getByRole('checkbox', { name: /Event portraits/ }).check();
  const client = f.records.get(f.clientRecordId)!.studioClient!;
  client.email = 'updated@example.test';
  client.version++;
  await f.save({ amountMinor: 300000 }, 1).expect(200);
  await page
    .getByRole('button', { name: 'Reload proposals and catalog' })
    .click();
  await expect(
    page.getByText('Current recipient: updated@example.test'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Issue proposal', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Load current recipient' }).click();
  await expect(
    page.getByRole('button', { name: 'Issue proposal', exact: true }),
  ).toBeDisabled();
  await page.getByRole('checkbox', { name: /Event portraits/ }).uncheck();
  await page.getByRole('checkbox', { name: /Event portraits/ }).check();
  await expect(
    page.getByRole('button', { name: 'Issue proposal', exact: true }),
  ).toBeEnabled();
});
test('withdraws and removes the proposal with its recipient-owned preference', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.issue().expect(200);
  await f.respond().expect(200);
  await f.openOwner();
  await page.getByRole('button', { name: 'Withdraw proposal' }).click();
  await expect(page.getByRole('status')).toHaveText('Proposal withdrawn.');
  await f.openClient();
  await expect(page.getByRole('alert')).toContainText(
    'This proposal is closed',
  );
  await expect(
    page.getByRole('button', { name: 'Save preference' }),
  ).toBeDisabled();
  await f.openOwner();
  await page.getByRole('button', { name: 'Remove proposal' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Proposal and client preference removed.',
  );
  expect(f.records.has(f.proposalId)).toBe(false);
  expect(f.records.has(f.responseId)).toBe(false);
});
test('hides private contents when the live account changes', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.issue().expect(200);
  await f.openClient();
  f.state.actor = f.strangerId;
  await page
    .getByRole('button', { name: 'Reload proposal', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Proposal unavailable', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Your portrait options', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Note for your photographer')).toHaveCount(0);
});
test('preserves the private proposal route through sign-in', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.issue().expect(200);
  f.state.actor = '';
  await page.goto(`/proposals/${f.proposalId}`);
  await expect(
    page.getByRole('heading', { name: 'Sign in to view your proposal' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Sign in to continue' }),
  ).toHaveAttribute(
    'href',
    `/sign-in?returnTo=${encodeURIComponent(`/proposals/${f.proposalId}`)}`,
  );
});
