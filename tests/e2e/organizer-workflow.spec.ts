import { expect, test, type Page, type Locator } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { chooseMenu } from './menu';
import type { ProofingCollection } from '../../packages/shared/src/proofing-collection';
import type { ProofingDecisions } from '../../packages/shared/src/proofing-decisions';
import type { ProofingComment } from '../../packages/shared/src/proofing-comments';
import type { ProofingSubmissionState } from '../../packages/shared/src/proofing-submission';

// Synthetic metadata/photos and intercepted APIs. No cloud services are contacted.
test('submitted round exports reauthorize, preserve round identity and omit private or unavailable data', async ({
  page,
}) => {
  // Two complete owner visits and multiple downloads need time on mobile WebKit.
  test.setTimeout(60_000);
  const { eventId, photos } = await fixture(page);
  const collectionId = '66666666-6666-4666-8666-666666666666';
  const invitationId = '77777777-7777-4777-8777-777777777777';
  const submissionId = '88888888-8888-4888-8888-888888888888';
  const oldId = '99999999-9999-4999-8999-999999999999';
  const ownerRoot = `/api/events/${eventId}/proofing-collections`;
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  let reads = 0,
    failure = 0,
    transientFailure = 0,
    hold = false,
    finishedHeld = false;
  let release: (() => void) | undefined;
  const downloaded: string[] = [];
  page.on('download', (download) =>
    downloaded.push(download.suggestedFilename()),
  );
  const current: ProofingSubmissionState = {
    round: 2,
    decisionVersion: 5,
    collectionVersion: 3,
    reopenReason: 'Private client reason',
    canReopen: false,
    current: {
      id: submissionId,
      round: 2,
      submittedAt: expiresAt,
      decisionVersion: 5,
      collectionVersion: 2,
      note: 'Private client note',
      favoriteCount: 3,
      unavailableCount: 1,
      photos: photos.map((photo) => ({
        photoId: photo.id,
        filename: 'duplicate.jpg',
      })),
    },
    history: [
      {
        id: oldId,
        round: 1,
        submittedAt: expiresAt,
        decisionVersion: 1,
        collectionVersion: 1,
        note: 'Earlier private note',
        favoriteCount: 1,
        unavailableCount: 0,
        photos: [{ photoId: photos[1]!.id, filename: 'Earlier.jpg' }],
      },
    ],
  };
  await page.route(`**${ownerRoot}`, (route) =>
    route.fulfill({
      json: {
        limit: 50,
        collections: [
          {
            id: collectionId,
            title: 'Editing album',
            version: 3,
            createdAt: expiresAt,
            updatedAt: expiresAt,
            photoIds: photos.map((photo) => photo.id),
            photos,
            unavailableCount: 0,
          },
        ],
      },
    }),
  );
  await page.route(`**${ownerRoot}/${collectionId}/invitations`, (route) =>
    route.fulfill({
      json: {
        invitations: [
          {
            id: invitationId,
            email: 'client@example.test',
            createdAt: expiresAt,
            expiresAt,
            revokedAt: null,
          },
        ],
      },
    }),
  );
  await page.route('**/api/**/decisions', (route) =>
    route.fulfill({
      json: {
        version: 5,
        updatedAt: expiresAt,
        decisions: [],
        unavailableCount: 0,
        submitted: { id: submissionId, round: 2, submittedAt: expiresAt },
      },
    }),
  );
  await page.route('**/api/**/submission', async (route) => {
    reads += 1;
    expect(route.request().method()).toBe('GET');
    if (hold) {
      hold = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await route.fulfill({ json: current });
      } finally {
        finishedHeld = true;
      }
      return;
    }
    if (transientFailure) {
      const status = transientFailure;
      transientFailure = 0;
      return route.fulfill({
        status,
        json: { error: { message: 'Export unavailable.' } },
      });
    }
    if (failure)
      return route.fulfill({
        status: failure,
        json: { error: { message: 'Export unavailable.' } },
      });
    return route.fulfill({ json: current });
  });
  async function openHistory() {
    await page.goto(`/app/events/${eventId}`);
    await page.getByRole('tab', { name: 'Collections', exact: true }).click();
    await page
      .getByRole('button', { name: 'Client invitations for Editing album' })
      .click();
    await page
      .getByRole('button', { name: 'View decisions from client@example.test' })
      .click();
    await page.getByRole('button', { name: 'View submitted rounds' }).click();
    await expect(
      page.getByRole('article', { name: 'Submitted round 2' }),
    ).toBeVisible();
  }
  await openHistory();
  const panel = page.getByRole('region', {
    name: 'Client submission history',
    exact: true,
  });
  const round = panel.getByRole('article', { name: 'Submitted round 2' });
  const csv = round.getByRole('button', {
    name: 'Export round 2 filenames CSV',
  });
  const txt = round.getByRole('button', {
    name: 'Export round 2 filenames TXT',
  });
  async function clickExport(button: Locator, expectedReads = 1) {
    const before = reads;
    await button.click();
    await expect.poll(() => reads).toBe(before + expectedReads);
  }
  let downloadEvent = page.waitForEvent('download');
  await clickExport(csv);
  let download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(
    `picfind-round-2-${submissionId}.csv`,
  );
  const duplicateCsv = await readFile((await download.path())!, 'utf8');
  expect(duplicateCsv).toContain(`"${photos[0]!.id}","duplicate.jpg"`);
  expect(duplicateCsv).toContain(`"${photos[1]!.id}","duplicate.jpg"`);
  expect(duplicateCsv).not.toMatch(
    /Private|client@example|Earlier|note|reason/,
  );
  await expect(round).toContainText('1 unavailable photo omitted.');
  await expect(round).toContainText('Some filenames repeat.');

  current.current!.photos = [
    { photoId: photos[1]!.id, filename: '=SUM(1,2).jpg' },
  ];
  current.current!.unavailableCount = 2;
  // Changing the next API response does not change the already rendered snapshot.
  await expect(round.getByText('duplicate.jpg', { exact: true })).toHaveCount(
    2,
  );
  downloadEvent = page.waitForEvent('download');
  await clickExport(csv);
  download = await downloadEvent;
  const freshCsv = await readFile((await download.path())!, 'utf8');
  expect(freshCsv).toContain(`"${photos[1]!.id}","'=SUM(1,2).jpg"`);
  expect(freshCsv).not.toContain(photos[0]!.id);
  await expect(round).toContainText('2 unavailable photos omitted.');

  downloadEvent = page.waitForEvent('download');
  await clickExport(
    panel.getByRole('button', { name: 'Export round 1 filenames TXT' }),
  );
  download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(`picfind-round-1-${oldId}.txt`);
  expect(await readFile((await download.path())!, 'utf8')).toBe(
    'Earlier.jpg\r\n',
  );
  const count = downloaded.length;
  current.current!.photos[0]!.filename = 'line\nbreak.jpg';
  await clickExport(txt);
  await expect(round).toContainText('Use CSV to preserve the filenames.');
  expect(downloaded).toHaveLength(count);
  current.current!.photos = [];
  current.current!.unavailableCount = 3;
  await clickExport(csv);
  await expect(round).toContainText(
    'No selected photos are currently available to export.',
  );
  expect(downloaded).toHaveLength(count);
  const retained = current.current!;
  current.current = null;
  await clickExport(csv);
  await expect(round).toContainText(
    'This submitted round is no longer available.',
  );
  expect(downloaded).toHaveLength(count);
  current.current = retained;
  for (const status of [401, 403]) {
    current.current.photos = [
      { photoId: photos[1]!.id, filename: `Recovered ${status}.jpg` },
    ];
    current.current.unavailableCount = 2;
    transientFailure = status;
    await clickExport(csv, 2);
    await expect(
      round.getByText(`Recovered ${status}.jpg`, { exact: true }),
    ).toBeVisible();
    await expect(round.getByText('duplicate.jpg', { exact: true })).toHaveCount(
      0,
    );
    expect(downloaded).toHaveLength(count);
  }
  failure = 503;
  await clickExport(csv);
  await expect(
    round.getByText('Export unavailable.', { exact: true }),
  ).toBeVisible();
  expect(downloaded).toHaveLength(count);
  failure = 404;
  await clickExport(csv, 2);
  await expect(panel.getByRole('article')).toHaveCount(0);
  await expect(
    panel.getByText('Export unavailable.', { exact: true }),
  ).toBeVisible();
  expect(downloaded).toHaveLength(count);

  failure = 0;
  current.current!.photos = [
    { photoId: photos[0]!.id, filename: 'Current.jpg' },
  ];
  await openHistory();
  hold = true;
  await clickExport(csv);
  await expect.poll(() => Boolean(release)).toBe(true);
  await expect(csv).toBeDisabled();
  await expect(txt).toBeDisabled();
  await page.goto('/app/events');
  await expect(page.locator('.event-card')).toHaveCount(3);
  release!();
  await expect.poll(() => finishedHeld).toBe(true);
  expect(downloaded).toHaveLength(count);
});

test('final proofing submission locks saved choices, retries safely and preserves reopened history', async ({
  page,
}) => {
  const { eventId, photos, jpeg } = await fixture(page);
  const collectionId = '66666666-6666-4666-8666-666666666666';
  const invitationId = '77777777-7777-4777-8777-777777777777';
  const ownerRoot = `/api/events/${eventId}/proofing-collections`;
  const clientRoot = `/api/proofing-invitations/${invitationId}`;
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  let actor = 'client',
    denied = false,
    failAfterSave = true;
  let releaseSave: (() => void) | undefined;
  const requests: Record<string, unknown>[] = [];
  const decisions: ProofingDecisions = {
    version: 1,
    updatedAt: expiresAt,
    unavailableCount: 0,
    decisions: [
      {
        photoId: photos[0]!.id,
        filename: photos[0]!.filename,
        status: 'favorite',
      },
    ],
  };
  const state: ProofingSubmissionState = {
    round: 1,
    decisionVersion: 1,
    collectionVersion: 1,
    current: null,
    history: [],
    reopenReason: null,
    canReopen: false,
  };
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        user: {
          id: actor,
          name: actor,
          email: `${actor}@example.test`,
          emailVerified: true,
        },
      },
    }),
  );
  await page.route(`**${ownerRoot}`, (route) =>
    route.fulfill({
      json: {
        limit: 50,
        collections: [
          {
            id: collectionId,
            title: 'Final album',
            version: 1,
            createdAt: expiresAt,
            updatedAt: expiresAt,
            photoIds: photos.map((photo) => photo.id),
            photos,
            unavailableCount: 0,
          },
        ],
      },
    }),
  );
  await page.route(`**${ownerRoot}/${collectionId}/invitations`, (route) =>
    route.fulfill({
      json: {
        invitations: [
          {
            id: invitationId,
            email: 'client@example.test',
            createdAt: expiresAt,
            expiresAt,
            revokedAt: null,
          },
        ],
      },
    }),
  );
  await page.route(`**${clientRoot}**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/photos/'))
      return route.fulfill({ contentType: 'image/jpeg', body: jpeg });
    return route.fulfill({
      json: {
        title: 'Final album',
        eventTitle: 'Garden wedding',
        expiresAt,
        photos,
      },
    });
  });
  await page.route('**/api/**/decisions', (route) => {
    if (route.request().method() === 'PATCH') {
      const input = route.request().postDataJSON();
      expect(state.current).toBeNull();
      expect(input.version).toBe(decisions.version);
      decisions.version += 1;
      state.decisionVersion = decisions.version;
      decisions.decisions = [
        {
          photoId: input.photoId,
          filename: photos[0]!.filename,
          status: input.status,
        },
      ];
    }
    return route.fulfill({ json: decisions });
  });
  await page.route('**/api/**/submission', async (route) => {
    const owner = new URL(route.request().url()).pathname.startsWith(ownerRoot);
    if (denied)
      return route.fulfill({
        status: 404,
        json: { error: { message: 'Submission unavailable.' } },
      });
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      requests.push(input);
      if (owner) {
        expect(input.submissionId).toBe(state.current!.id);
        state.history.unshift(state.current!);
        state.current = null;
        state.round += 1;
        decisions.version += 1;
        state.decisionVersion = decisions.version;
        state.reopenReason = input.reason;
        delete decisions.submitted;
        return route.fulfill({ json: { reopened: true } });
      }
      if (!state.current)
        state.current = {
          id: input.id,
          round: state.round,
          submittedAt: new Date().toISOString(),
          decisionVersion: input.decisionVersion,
          collectionVersion: input.collectionVersion,
          note: input.note,
          favoriteCount: 1,
          unavailableCount: 0,
          photos: [{ photoId: photos[0]!.id, filename: photos[0]!.filename }],
        };
      expect(input.id).toBe(state.current.id);
      decisions.submitted = {
        id: state.current.id,
        round: state.round,
        submittedAt: state.current.submittedAt,
      };
      if (failAfterSave) {
        failAfterSave = false;
        await new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        return route.fulfill({
          status: 503,
          json: {
            error: { message: 'Response interrupted. Retry the submission.' },
          },
        });
      }
      return route.fulfill({ json: { submitted: true, id: input.id } });
    }
    return route.fulfill({
      json: { ...state, canReopen: owner && Boolean(state.current) },
    });
  });
  await page.goto(`/proofing/${invitationId}`);
  const choice = page.getByLabel(`Decision for ${photos[0]!.filename}`);
  const panel = page.getByRole('region', {
    name: 'Your final submission',
    exact: true,
  });
  await expect(choice).toHaveValue('favorite');
  await panel.getByRole('button', { name: 'Review final submission' }).click();
  await panel
    .getByLabel('Final submission note')
    .fill('Please keep <b>the original colors</b>.');
  page.once('dialog', (dialog) => void dialog.dismiss());
  await panel.getByRole('button', { name: 'Submit final favorites' }).click();
  expect(requests).toHaveLength(0);
  page.once('dialog', (dialog) => void dialog.accept());
  await panel.getByRole('button', { name: 'Submit final favorites' }).click();
  await expect.poll(() => Boolean(releaseSave)).toBe(true);
  await expect(choice).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Refresh saved decisions' }),
  ).toBeDisabled();
  releaseSave!();
  await expect(
    panel.getByText('Response interrupted. Retry the submission.'),
  ).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await panel.getByRole('button', { name: 'Submit final favorites' }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(requests[1]!.id).toBe(requests[0]!.id);
  expect(requests[1]).toEqual(requests[0]);
  await expect(
    panel.getByText('This round is submitted and locked.'),
  ).toBeVisible();
  await expect(choice).toBeDisabled();
  await expect(panel.locator('b')).toHaveCount(0);
  await page.reload();
  await expect(choice).toBeDisabled();
  await panel.getByRole('button', { name: 'Review final submission' }).click();
  await expect(
    panel.getByRole('article', { name: 'Submitted round 1' }),
  ).toContainText('1 submitted favorites');
  await expect(panel.getByRole('button', { name: /Export round/ })).toHaveCount(
    0,
  );

  actor = 'owner';
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Collections', exact: true }).click();
  await page
    .getByRole('button', { name: 'Client invitations for Final album' })
    .click();
  await page
    .getByRole('button', { name: 'View decisions from client@example.test' })
    .click();
  const history = page.getByRole('region', {
    name: 'Client submission history',
    exact: true,
  });
  await history.getByRole('button', { name: 'View submitted rounds' }).click();
  await history
    .getByLabel('Reason to reopen')
    .fill('Please choose a different cover.');
  page.once('dialog', (dialog) => void dialog.accept());
  await history.getByRole('button', { name: 'Reopen submitted round' }).click();
  await expect(
    history.getByText('Round 2 is open for saved draft choices.'),
  ).toBeVisible();
  await expect(
    history.getByRole('article', { name: 'Submitted round 1' }),
  ).toBeVisible();
  actor = 'client';
  await page.goto(`/proofing/${invitationId}`);
  await expect(choice).toBeEnabled();
  await panel.getByRole('button', { name: 'Review final submission' }).click();
  await expect(panel).toContainText(
    'Photographer reopening reason: Please choose a different cover.',
  );
  await expect(
    panel.getByRole('article', { name: 'Submitted round 1' }),
  ).toBeVisible();
  denied = true;
  await panel.getByRole('button', { name: 'Refresh submission' }).click();
  await expect(panel.getByText('Submission unavailable.')).toBeVisible();
  await expect(panel.getByRole('article')).toHaveCount(0);
  await expect(
    panel.getByRole('button', { name: 'Submit final favorites' }),
  ).toHaveCount(0);
});

test('collection final submission requirements refresh counts and close on server-relative time', async ({
  page,
}) => {
  const { photos, jpeg } = await fixture(page);
  const invitationId = '77777777-7777-4777-8777-777777777777';
  const root = `/api/proofing-invitations/${invitationId}`;
  const now = Date.now();
  let posts = 0;
  const requirements = {
    policy: { minimum: 1, maximum: 2, closesAt: null as string | null },
    window: {
      closesAt: null as string | null,
      serverNow: new Date(now).toISOString(),
      closed: false,
      invalid: false,
    },
    favoriteCount: 0,
    unavailableCount: 0,
  };
  await page.route(`**${root}**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/photos/'))
      return route.fulfill({ contentType: 'image/jpeg', body: jpeg });
    if (path.endsWith('/decisions'))
      return route.fulfill({
        json: {
          version: 1,
          updatedAt: null,
          unavailableCount: 0,
          decisions: photos.map((photo) => ({
            photoId: photo.id,
            filename: photo.filename,
            status: 'favorite',
          })),
        },
      });
    if (path.endsWith('/submission')) {
      if (route.request().method() === 'POST') {
        posts += 1;
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'SUBMISSION_CLOSED',
              message: 'The deadline changed. Refresh submission.',
            },
          },
        });
      }
      return route.fulfill({
        json: {
          round: 1,
          decisionVersion: 1,
          collectionVersion: 1,
          current: null,
          history: [],
          reopenReason: null,
          canReopen: false,
          requirements,
        },
      });
    }
    return route.fulfill({
      json: {
        title: 'Policy collection',
        eventTitle: 'Wedding',
        expiresAt: new Date(now + 86400000).toISOString(),
        photos,
      },
    });
  });
  await page.clock.install({ time: now });
  await page.goto(`/proofing/${invitationId}`);
  const panel = page.getByRole('region', {
    name: 'Your final submission',
    exact: true,
  });
  await panel.getByRole('button', { name: 'Review final submission' }).click();
  const submit = panel.getByRole('button', { name: 'Submit final favorites' });
  const refresh = panel.getByRole('button', { name: 'Refresh submission' });
  await expect(panel).toContainText('Save 1 more favorites before submitting.');
  await expect(submit).toBeDisabled();
  requirements.favoriteCount = 3;
  await refresh.click();
  await expect(panel).toContainText('Remove 1 favorites before submitting.');
  await expect(submit).toBeDisabled();
  requirements.favoriteCount = 2;
  requirements.unavailableCount = 1;
  await refresh.click();
  await expect(panel).toContainText('1 saved favorites are unavailable.');
  await expect(submit).toBeDisabled();
  requirements.unavailableCount = 0;
  requirements.policy.closesAt = new Date(now + 2000).toISOString();
  requirements.window.closesAt = requirements.policy.closesAt;
  await refresh.click();
  await expect(submit).toBeEnabled();
  await expect(panel).toContainText('Shown in your device time zone.');
  await page.clock.runFor(2100);
  await expect(submit).toBeDisabled();
  await expect(panel).toContainText('Final submissions are closed.');
  await expect(
    page.getByLabel(`Decision for ${photos[0]!.filename}`),
  ).toBeEnabled();
  expect(posts).toBe(0);
  requirements.policy.closesAt = null;
  requirements.window.closesAt = null;
  await refresh.click();
  await expect(submit).toBeEnabled();
  page.once('dialog', (dialog) => void dialog.accept());
  await submit.click();
  await expect(panel).toContainText(
    'The deadline changed. Refresh submission.',
  );
  await expect(submit).toBeDisabled();
  expect(posts).toBe(1);
  await refresh.click();
  await expect(submit).toBeEnabled();
});

async function fixture(page: Page) {
  const jpeg = await sharp({
    create: { width: 80, height: 60, channels: 3, background: '#50796a' },
  })
    .jpeg()
    .toBuffer();
  const eventId = '11111111-1111-4111-8111-111111111111';
  const events = [
    {
      id: eventId,
      title: 'Garden wedding',
      folder: 'Weddings 2026',
      visibility: 'link',
      archived: false,
      date: '2026-09-01',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Campus gathering',
      folder: 'Campus',
      visibility: 'private',
      archived: false,
      date: '2026-08-01',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Old conference',
      folder: '',
      visibility: 'private',
      archived: true,
      date: '',
    },
  ].map((event, i) => ({
    ...event,
    description: 'Synthetic event',
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    createdAt: `2026-09-0${i + 1}T00:00:00.000Z`,
  }));
  const photos = ['Ceremony.jpg', 'Garden.jpg'].map((filename, i) => ({
    id: `44444444-4444-4444-8444-44444444444${i}`,
    filename,
    eventId,
    bytes: jpeg.length,
    width: 80,
    height: 60,
    createdAt: '2026-09-01T00:00:00.000Z',
  }));
  const selection = {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Asha',
    note: 'Please retouch the album cover.',
    photoIds: [...photos.map((photo) => photo.id), 'removed-photo'],
    photos: photos.map(({ id, filename }) => ({ id, filename })),
    createdAt: '2026-09-02T00:00:00.000Z',
    reviewStatus: 'new',
    reviewNote: '',
    reviewVersion: 0,
    reviewedAt: null as string | null,
  };
  const state = {
    conflict: false,
    failDownload: false,
    selectionRules: { minimum: 1, maximum: 100 },
    selectionWindow: {
      closesAt: null as string | null,
      serverNow: new Date().toISOString(),
      closed: false,
      invalid: false,
    },
    writes: [] as { path: string; body: Record<string, unknown> }[],
    unexpectedWrites: [] as string[],
  };
  const selections = [selection];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'owner',
            name: 'Studio Owner',
            email: 'owner@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: { events, photos, jobs: [], scans: [], photoLimit: 20 },
      });
    if (path === '/api/events/entitlement')
      return route.fulfill({
        json: {
          entitlement: {
            plan: 'organizer-pro-monthly',
            retentionDays: 90,
            liveEvents: 10,
            paidThrough: new Date(Date.now() + 30 * 86400000).toISOString(),
          },
          activeEvents: 2,
          remainingEvents: 8,
          canCreate: true,
          catalogAvailable: false,
          serverNow: new Date().toISOString(),
          maximumExpiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
        },
      });
    if (path === '/api/capabilities')
      return route.fulfill({
        json: {
          storage: true,
          billing: false,
          faceMatching: false,
          drive: false,
          photoLimit: 20,
          faceIndexMax: 20,
        },
      });
    if (path === `/api/events/${eventId}/insights`)
      return route.fulfill({
        json: {
          photos: 2,
          indexed: 0,
          storageBytes: jpeg.length * 2,
          submissions: 1,
          hasPasscode: false,
          brandingName: '',
          accentColor: '#173f37',
          selectionRules: state.selectionRules,
          selectionWindow: state.selectionWindow,
          selections,
        },
      });
    if (
      path === `/api/events/${eventId}/selection-rules` &&
      method === 'PATCH'
    ) {
      state.selectionRules = request.postDataJSON();
      return route.fulfill({ json: { selectionRules: state.selectionRules } });
    }
    if (
      path === `/api/events/${eventId}/selection-window` &&
      method === 'PATCH'
    ) {
      const body = request.postDataJSON();
      const now = new Date().toISOString();
      state.selectionWindow = {
        closesAt:
          body.action === 'open'
            ? null
            : body.action === 'close'
              ? now
              : body.closesAt,
        closed: body.action === 'close',
        invalid: false,
        serverNow: now,
      };
      return route.fulfill({
        json: { selectionWindow: state.selectionWindow },
      });
    }
    if (
      path === `/api/events/${eventId}/selections/${selection.id}` &&
      method === 'PATCH'
    ) {
      const body = request.postDataJSON();
      state.writes.push({ path, body });
      if (state.conflict) {
        state.conflict = false;
        selection.reviewVersion++;
        selection.reviewNote = 'Updated in another tab';
        selection.reviewStatus = 'in-progress';
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'REVIEW_CHANGED',
              message:
                'Another tab changed this review. Load the latest review before saving again.',
            },
          },
        });
      }
      expect(body.version).toBe(selection.reviewVersion);
      Object.assign(selection, {
        reviewStatus: body.reviewStatus,
        reviewNote: body.reviewNote.trim(),
        reviewVersion: selection.reviewVersion + 1,
        reviewedAt: new Date().toISOString(),
      });
      return route.fulfill({
        json: {
          review: {
            reviewStatus: selection.reviewStatus,
            reviewNote: selection.reviewNote,
            reviewVersion: selection.reviewVersion,
            reviewedAt: selection.reviewedAt,
          },
        },
      });
    }
    if (path === `/api/events/${eventId}` && method === 'PATCH') {
      const body = request.postDataJSON();
      state.writes.push({ path, body });
      Object.assign(events[0]!, body);
      return route.fulfill({ json: { event: events[0] } });
    }
    if (/^\/api\/photos\/[^/]+\/file$/.test(path)) {
      if (state.failDownload)
        return route.fulfill({
          status: 410,
          json: { error: { message: 'Photo expired.' } },
        });
      return route.fulfill({ contentType: 'image/jpeg', body: jpeg });
    }
    if (!['GET', 'HEAD'].includes(method)) {
      state.unexpectedWrites.push(path);
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Unexpected write in synthetic test.' } },
      });
    }
    return route.fulfill({ json: {} });
  });
  return { eventId, events, photos, selection, selections, state, jpeg };
}

test('collection invitations persist, survive client reload and stop access after revocation', async ({
  page,
}) => {
  const { eventId, photos, jpeg, state } = await fixture(page);
  const collectionId = '66666666-6666-4666-8666-666666666666';
  const invitationId = '77777777-7777-4777-8777-777777777777';
  const root = `/api/events/${eventId}/proofing-collections`;
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  let invitation: {
    id: string;
    email: string;
    createdAt: string;
    expiresAt: string;
    revokedAt: string | null;
  } | null = null;
  let signedIn = true;
  let recipient = false;
  let conflict = false;
  let holdDecisionSave = false;
  let releaseDecisionSave: (() => void) | undefined;
  let decisions: ProofingDecisions = {
    version: 0,
    updatedAt: null,
    unavailableCount: 0,
    decisions: [],
  };
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        user: signedIn
          ? {
              id: recipient ? 'client' : 'owner',
              name: 'Account',
              email: recipient ? 'client@example.test' : 'owner@example.test',
              emailVerified: true,
            }
          : null,
      },
    }),
  );
  await page.route(`**${root}`, (route) =>
    route.fulfill({
      json: {
        limit: 50,
        collections: [
          {
            id: collectionId,
            title: 'Album round',
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            photoIds: [photos[0]!.id],
            photos: [photos[0]],
            unavailableCount: 0,
          },
        ],
      },
    }),
  );
  await page.route(`**${root}/${collectionId}/invitations**`, (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/decisions'))
      return route.fulfill({ json: decisions });
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({
        email: 'client@example.test',
        days: 3,
      });
      invitation = {
        id: invitationId,
        email: 'client@example.test',
        createdAt: new Date().toISOString(),
        expiresAt,
        revokedAt: null,
      };
      return route.fulfill({ status: 201, json: { invitation } });
    }
    if (route.request().method() === 'DELETE') {
      invitation!.revokedAt = new Date().toISOString();
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      json: { invitations: invitation ? [invitation] : [] },
    });
  });
  await page.route(
    `**/api/proofing-invitations/${invitationId}**`,
    async (route) => {
      if (!recipient || invitation?.revokedAt)
        return route.fulfill({
          status: 404,
          json: { error: { message: 'Invitation unavailable.' } },
        });
      if (new URL(route.request().url()).pathname.endsWith('/decisions')) {
        if (route.request().method() === 'PATCH') {
          const input = route.request().postDataJSON();
          if (holdDecisionSave) {
            holdDecisionSave = false;
            await new Promise<void>((resolve) => {
              releaseDecisionSave = resolve;
            });
          }
          if (conflict) {
            conflict = false;
            decisions = {
              ...decisions,
              version: decisions.version + 1,
              decisions: [
                {
                  photoId: photos[0]!.id,
                  filename: photos[0]!.filename,
                  status: 'maybe',
                },
              ],
            };
            return route.fulfill({
              status: 409,
              json: {
                error: {
                  message:
                    'Choices changed in another tab. Refresh saved decisions.',
                },
              },
            });
          }
          expect(input.version).toBe(decisions.version);
          decisions = {
            version: decisions.version + 1,
            updatedAt: new Date().toISOString(),
            unavailableCount: 0,
            decisions: input.status
              ? [
                  {
                    photoId: input.photoId,
                    filename: photos[0]!.filename,
                    status: input.status,
                  },
                ]
              : [],
          };
        }
        return route.fulfill({ json: decisions });
      }
      if (new URL(route.request().url()).pathname.includes('/photos/'))
        return route.fulfill({ contentType: 'image/jpeg', body: jpeg });
      return route.fulfill({
        json: {
          title: 'Album round',
          eventTitle: 'Garden wedding',
          expiresAt,
          photos: [photos[0]],
        },
      });
    },
  );
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Collections', exact: true }).click();
  await page
    .getByRole('button', { name: 'Client invitations for Album round' })
    .click();
  const manager = page.getByRole('region', {
    name: 'Collection invitations',
    exact: true,
  });
  await manager.getByLabel('Client account email').fill('client@example.test');
  await manager.getByLabel('Access duration in days').fill('3');
  await manager
    .getByRole('button', { name: 'Create invitation', exact: true })
    .click();
  await expect(
    manager.getByLabel('Invitation link for client@example.test'),
  ).toHaveValue(new RegExp(`/proofing/${invitationId}$`));
  await page.reload();
  await page.getByRole('tab', { name: 'Collections', exact: true }).click();
  await page
    .getByRole('button', { name: 'Client invitations for Album round' })
    .click();
  await expect(
    manager.getByLabel('Invitation link for client@example.test'),
  ).toBeVisible();

  signedIn = false;
  await page.goto(`/proofing/${invitationId}`);
  await expect(
    page.getByRole('link', { name: 'Sign in to view collection' }),
  ).toHaveAttribute(
    'href',
    `/sign-in?returnTo=${encodeURIComponent(`/proofing/${invitationId}`)}`,
  );
  signedIn = true;
  recipient = true;
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Album round' }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: photos[0]!.filename }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: photos[1]!.filename }),
  ).toHaveCount(0);
  const review = page.getByRole('region', { name: 'Your photo decisions' });
  const choice = review.getByLabel(`Decision for ${photos[0]!.filename}`);
  holdDecisionSave = true;
  await choice.selectOption('favorite');
  await expect.poll(() => Boolean(releaseDecisionSave)).toBe(true);
  await expect(choice).toBeDisabled();
  await expect(
    review.getByRole('button', { name: 'Refresh saved decisions' }),
  ).toBeDisabled();
  releaseDecisionSave!();
  await expect(choice).toHaveValue('favorite');
  await expect(review).toContainText('1 favorites');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Album round' }),
  ).toBeVisible();
  await expect(choice).toHaveValue('favorite');
  await review.getByLabel('Filter photo decisions').selectOption('undecided');
  await expect(
    review.getByText('No photos match this decision filter.'),
  ).toBeVisible();
  await review.getByLabel('Filter photo decisions').selectOption('all');
  conflict = true;
  await choice.selectOption('rejected');
  await expect(choice).toBeDisabled();
  await expect(
    review.getByText(
      'Choices changed in another tab. Refresh saved decisions.',
    ),
  ).toBeVisible();
  await review.getByRole('button', { name: 'Refresh saved decisions' }).click();
  await expect(choice).toHaveValue('maybe');
  await choice.selectOption('');
  await expect(choice).toHaveValue('');
  await expect(review).toContainText('1 undecided');
  await choice.selectOption('favorite');
  await expect(choice).toHaveValue('favorite');
  invitation!.revokedAt = new Date().toISOString();
  await choice.selectOption('rejected');
  await expect(
    review.getByRole('img', { name: photos[0]!.filename }),
  ).toHaveCount(0);
  await expect(
    review.getByText('Invitation unavailable.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Refresh collection', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'This collection is unavailable.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: photos[0]!.filename }),
  ).toHaveCount(0);

  recipient = false;
  invitation!.revokedAt = null;
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Collections', exact: true }).click();
  await page
    .getByRole('button', { name: 'Client invitations for Album round' })
    .click();
  await manager
    .getByRole('button', { name: 'View decisions from client@example.test' })
    .click();
  await expect(
    manager.getByText(`${photos[0]!.filename}: Favorite`, { exact: true }),
  ).toBeVisible();
  page.once('dialog', (dialog) => void dialog.dismiss());
  await manager
    .getByRole('button', { name: 'Revoke access for client@example.test' })
    .click();
  expect(invitation!.revokedAt).toBeNull();
  page.once('dialog', (dialog) => void dialog.accept());
  await manager
    .getByRole('button', { name: 'Revoke access for client@example.test' })
    .click();
  await expect(manager.getByText(/^Revoked · Expires/)).toBeVisible();
  await expect(
    manager.getByLabel('Invitation link for client@example.test'),
  ).toHaveCount(0);
  expect(state.unexpectedWrites).toEqual([]);
});

test('private photo discussion persists, retries safely, supports photographer replies and hides denied access', async ({
  page,
}) => {
  const { eventId, photos, jpeg } = await fixture(page);
  const collectionId = '66666666-6666-4666-8666-666666666666';
  const invitationId = '77777777-7777-4777-8777-777777777777';
  const ownerRoot = `/api/events/${eventId}/proofing-collections`;
  const clientRoot = `/api/proofing-invitations/${invitationId}`;
  let actor: 'client' | 'owner' = 'client';
  let revoked = false;
  let denyDiscussionRead = false;
  let holdCommentSave = true;
  let releaseCommentSave: (() => void) | undefined;
  let discussionPhotos = [photos[0]!];
  let failAfterSave = true;
  let lastId: string | undefined;
  const comments: ProofingComment[] = [];
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        user: {
          id: actor,
          name: actor,
          email: `${actor}@example.test`,
          emailVerified: true,
        },
      },
    }),
  );
  await page.route(`**${ownerRoot}`, (route) =>
    route.fulfill({
      json: {
        limit: 50,
        collections: [
          {
            id: collectionId,
            title: 'Album round',
            version: 1,
            createdAt: expiresAt,
            updatedAt: expiresAt,
            photoIds: [photos[0]!.id],
            photos: [photos[0]],
            unavailableCount: 0,
          },
        ],
      },
    }),
  );
  await page.route(`**${ownerRoot}/${collectionId}/invitations`, (route) =>
    route.fulfill({
      json: {
        invitations: [
          {
            id: invitationId,
            email: 'client@example.test',
            createdAt: expiresAt,
            expiresAt,
            revokedAt: null,
          },
        ],
      },
    }),
  );
  await page.route(`**${clientRoot}**`, (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/decisions'))
      return route.fulfill({
        json: {
          version: 0,
          updatedAt: null,
          unavailableCount: 0,
          decisions: [],
        },
      });
    if (new URL(route.request().url()).pathname.includes('/photos/'))
      return route.fulfill({ contentType: 'image/jpeg', body: jpeg });
    return route.fulfill({
      json: {
        title: 'Album round',
        eventTitle: 'Garden wedding',
        expiresAt,
        photos: [photos[0]],
      },
    });
  });
  await page.route('**/api/**/comments**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const owner = path.startsWith(ownerRoot);
    if (
      (!owner && (revoked || actor !== 'client')) ||
      (owner && actor !== 'owner') ||
      (denyDiscussionRead && route.request().method() === 'GET')
    )
      return route.fulfill({
        status: 404,
        json: { error: { message: 'Discussion unavailable.' } },
      });
    if (route.request().method() === 'POST') {
      if (holdCommentSave) {
        holdCommentSave = false;
        await new Promise<void>((resolve) => {
          releaseCommentSave = resolve;
        });
      }
      const input = route.request().postDataJSON() as {
        id: string;
        photoId: string;
        text: string;
      };
      if (lastId && input.text === 'Please remove <b>the sign</b>.')
        expect(input.id).toBe(lastId);
      if (!comments.some((row) => row.id === input.id))
        comments.push({
          ...input,
          author: owner ? 'photographer' : 'client',
          createdAt: new Date().toISOString(),
          removedAt: null,
          canRemove: true,
        });
      if (failAfterSave) {
        failAfterSave = false;
        lastId = input.id;
        return route.fulfill({
          status: 503,
          json: {
            error: { message: 'Response interrupted. Retry this message.' },
          },
        });
      }
      return route.fulfill({ status: 201, json: { id: input.id } });
    }
    if (route.request().method() === 'DELETE') {
      const row = comments.find((entry) => path.endsWith(`/${entry.id}`))!;
      row.text = null;
      row.removedAt = new Date().toISOString();
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      json: {
        canPost: !revoked,
        remaining: 100 - comments.length,
        unavailableCount: 0,
        photos: discussionPhotos.map(({ id, filename }) => ({ id, filename })),
        comments: comments.map((row) => ({
          ...row,
          canRemove: !row.removedAt && (owner || row.author === 'client'),
        })),
      },
    });
  });
  await page.goto(`/proofing/${invitationId}`);
  const clientDiscussion = page.getByRole('region', {
    name: 'Photo discussion with your photographer',
    exact: true,
  });
  await clientDiscussion
    .getByRole('button', {
      name: 'Photo discussion with your photographer',
      exact: true,
    })
    .click();
  const draft = clientDiscussion.getByLabel(
    'Message to client or photographer',
  );
  await draft.fill('Please remove <b>the sign</b>.');
  await clientDiscussion
    .getByRole('button', { name: 'Save message', exact: true })
    .click();
  await expect.poll(() => Boolean(releaseCommentSave)).toBe(true);
  await expect(
    clientDiscussion.getByRole('button', {
      name: 'Refresh discussion',
      exact: true,
    }),
  ).toBeDisabled();
  await expect(draft).toBeDisabled();
  releaseCommentSave!();
  await expect(clientDiscussion.getByRole('alert')).toContainText(
    'Response interrupted',
  );
  await expect(draft).toHaveValue('Please remove <b>the sign</b>.');
  await clientDiscussion
    .getByRole('button', { name: 'Save message', exact: true })
    .click();
  await expect(
    clientDiscussion.getByRole('list', { name: 'Photo messages' }),
  ).toContainText('Please remove <b>the sign</b>.');
  await expect(draft).toHaveValue('');
  expect(comments).toHaveLength(1);
  await expect(clientDiscussion.locator('b')).toHaveCount(0);
  await page.reload();
  await clientDiscussion
    .getByRole('button', {
      name: 'Photo discussion with your photographer',
      exact: true,
    })
    .click();
  await expect(
    clientDiscussion.getByRole('list', { name: 'Photo messages' }),
  ).toContainText('Please remove <b>the sign</b>.');

  denyDiscussionRead = true;
  await clientDiscussion
    .getByRole('button', { name: 'Refresh discussion', exact: true })
    .click();
  await expect(clientDiscussion.getByRole('alert')).toContainText(
    'Discussion unavailable',
  );
  await expect(
    clientDiscussion.getByRole('list', { name: 'Photo messages' }),
  ).toHaveCount(0);
  denyDiscussionRead = false;
  await clientDiscussion
    .getByRole('button', { name: 'Refresh discussion', exact: true })
    .click();
  await expect(
    clientDiscussion.getByRole('list', { name: 'Photo messages' }),
  ).toContainText('Please remove <b>the sign</b>.');
  await draft.fill('This draft belongs only to the first photo.');
  discussionPhotos = [photos[1]!];
  await clientDiscussion
    .getByRole('button', { name: 'Refresh discussion', exact: true })
    .click();
  await expect(draft).toHaveCount(0);
  page.once('dialog', (dialog) => void dialog.accept());
  await clientDiscussion
    .getByLabel('Discussion photo')
    .selectOption(photos[1]!.id);
  await expect(draft).toHaveValue('');
  discussionPhotos = [photos[0]!];
  await clientDiscussion
    .getByRole('button', { name: 'Refresh discussion', exact: true })
    .click();
  await clientDiscussion
    .getByLabel('Discussion photo')
    .selectOption(photos[0]!.id);

  actor = 'owner';
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Collections', exact: true }).click();
  await page
    .getByRole('button', { name: 'Client invitations for Album round' })
    .click();
  const ownerDiscussion = page.getByRole('region', {
    name: 'Photo discussion with client@example.test',
    exact: true,
  });
  await ownerDiscussion
    .getByRole('button', {
      name: 'Photo discussion with client@example.test',
      exact: true,
    })
    .click();
  await expect(
    ownerDiscussion.getByRole('list', { name: 'Photo messages' }),
  ).toContainText('Please remove <b>the sign</b>.');
  await ownerDiscussion
    .getByLabel('Message to client or photographer')
    .fill('I can retouch that sign.');
  await ownerDiscussion
    .getByRole('button', { name: 'Save message', exact: true })
    .click();
  await expect(
    ownerDiscussion.getByRole('list', { name: 'Photo messages' }),
  ).toContainText('I can retouch that sign.');

  actor = 'client';
  await page.goto(`/proofing/${invitationId}`);
  await clientDiscussion
    .getByRole('button', {
      name: 'Photo discussion with your photographer',
      exact: true,
    })
    .click();
  await expect(
    clientDiscussion.getByRole('list', { name: 'Photo messages' }),
  ).toContainText('Photographer');
  await expect(
    clientDiscussion.getByRole('button', {
      name: 'Remove message',
      exact: true,
    }),
  ).toHaveCount(1);
  page.once('dialog', (dialog) => void dialog.dismiss());
  await clientDiscussion
    .getByRole('button', { name: 'Remove message', exact: true })
    .click();
  expect(comments[0]!.text).not.toBeNull();
  page.once('dialog', (dialog) => void dialog.accept());
  await clientDiscussion
    .getByRole('button', { name: 'Remove message', exact: true })
    .click();
  await expect(
    clientDiscussion.getByText('Message removed.', { exact: true }).last(),
  ).toBeVisible();
  expect(comments[0]!.text).toBeNull();
  revoked = true;
  await draft.fill('A message after revocation');
  await clientDiscussion
    .getByRole('button', { name: 'Save message', exact: true })
    .click();
  await expect(clientDiscussion.getByRole('alert')).toContainText(
    'Discussion unavailable',
  );
  await expect(
    clientDiscussion.getByText('I can retouch that sign.', { exact: true }),
  ).toHaveCount(0);
  await expect(draft).toHaveCount(0);
  expect(comments).toHaveLength(2);
});

test('named collections persist, recover conflicts, remove unavailable photos and delete only the set', async ({
  page,
}) => {
  const { eventId, photos } = await fixture(page);
  let collection: ProofingCollection | null = null;
  let conflict = false;
  await page.route(
    `**/api/events/${eventId}/proofing-collections**`,
    (route) => {
      const req = route.request();
      const single = new URL(req.url()).pathname.endsWith('/collection1');
      if (req.method() === 'GET')
        return route.fulfill({
          json: single
            ? { collection }
            : { collections: collection ? [collection] : [], limit: 50 },
        });
      const body = req.postDataJSON();
      if (req.method() === 'DELETE') {
        expect(body.version).toBe(collection!.version);
        collection = null;
        return route.fulfill({ status: 204 });
      }
      if (conflict) {
        conflict = false;
        collection = {
          ...collection!,
          title: 'Changed in another tab',
          version: collection!.version + 1,
          submissionPolicy: { minimum: 0, maximum: 1, closesAt: null },
        };
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'COLLECTION_CHANGED',
              message: 'Load the latest collection.',
            },
          },
        });
      }
      if (single) expect(body.version).toBe(collection!.version);
      collection = {
        id: 'collection1',
        title: body.title.trim(),
        version: (collection?.version ?? 0) + 1,
        createdAt: '2026-10-20T12:00:00.000Z',
        updatedAt: '2026-10-20T12:00:00.000Z',
        photoIds: body.photoIds,
        submissionPolicy: body.submissionPolicy,
        unavailableCount: 0,
        photos: photos
          .filter((photo) => body.photoIds.includes(photo.id))
          .map(({ id, filename }) => ({ id, filename })),
      };
      return route.fulfill({
        status: single ? 200 : 201,
        json: { collection },
      });
    },
  );
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Collections', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Proofing collections' });
  await panel.getByRole('button', { name: 'New collection' }).click();
  const editor = panel.getByRole('form', { name: 'Collection editor' });
  await editor
    .getByLabel('Collection name', { exact: true })
    .fill('Album round');
  await editor.getByLabel('Ceremony.jpg', { exact: true }).check();
  await editor.getByLabel('Garden.jpg', { exact: true }).check();
  await editor.getByLabel('Minimum final favorites').fill('1');
  await editor.getByLabel('Maximum final favorites').fill('2');
  await editor
    .getByLabel('Final submission deadline', { exact: true })
    .fill('2030-01-02T12:30');
  const editorWidth = await editor.evaluate((element) => ({
    visible: element.clientWidth,
    content: element.scrollWidth,
  }));
  expect(editorWidth.content).toBeLessThanOrEqual(editorWidth.visible + 1);
  await editor
    .getByRole('button', { name: 'Save collection', exact: true })
    .click();
  await expect(
    panel.getByRole('heading', { name: 'Album round', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Collections', exact: true }).click();
  await panel
    .getByRole('button', { name: 'Edit Album round', exact: true })
    .click();
  await expect(editor.getByLabel('Garden.jpg', { exact: true })).toBeChecked();
  await expect(editor.getByLabel('Minimum final favorites')).toHaveValue('1');
  await expect(editor.getByLabel('Maximum final favorites')).toHaveValue('2');
  await expect(
    editor.getByLabel('Final submission deadline', { exact: true }),
  ).toHaveValue('2030-01-02T12:30');
  expect(collection!.submissionPolicy?.closesAt).toMatch(/Z$/);
  await editor.getByLabel('Maximum final favorites').fill('3');
  await editor
    .getByLabel('Collection name', { exact: true })
    .fill('My revision');
  page.once('dialog', (dialog) => void dialog.dismiss());
  await panel
    .getByRole('button', { name: 'New collection', exact: true })
    .click();
  await expect(
    editor.getByLabel('Collection name', { exact: true }),
  ).toHaveValue('My revision');
  conflict = true;
  await editor
    .getByRole('button', { name: 'Save collection', exact: true })
    .click();
  await expect(editor.getByRole('alert')).toContainText('Load the latest');
  await expect(
    editor.getByLabel('Collection name', { exact: true }),
  ).toHaveValue('My revision');
  await editor
    .getByRole('button', { name: 'Replace draft with latest collection' })
    .click();
  await expect(
    editor.getByLabel('Collection name', { exact: true }),
  ).toHaveValue('Changed in another tab');
  await expect(editor.getByLabel('Minimum final favorites')).toHaveValue('0');
  await expect(editor.getByLabel('Maximum final favorites')).toHaveValue('1');
  await expect(
    editor.getByLabel('Final submission deadline', { exact: true }),
  ).toHaveValue('');
  await editor
    .getByLabel('Collection name', { exact: true })
    .fill('Retouch round');
  await editor
    .getByRole('button', { name: 'Save collection', exact: true })
    .click();
  await expect(
    panel.getByRole('heading', { name: 'Retouch round', exact: true }),
  ).toBeVisible();
  photos.pop();
  await page.reload();
  await page.getByRole('tab', { name: 'Collections', exact: true }).click();
  await panel
    .getByRole('button', { name: 'Edit Retouch round', exact: true })
    .click();
  await expect(
    editor.getByRole('button', { name: 'Save collection', exact: true }),
  ).toBeDisabled();
  await editor
    .getByRole('button', {
      name: 'Remove unavailable photos from this collection',
    })
    .click();
  await editor
    .getByRole('button', { name: 'Save collection', exact: true })
    .click();
  await expect(
    panel.getByText('1 selected photos', { exact: true }),
  ).toBeVisible();
  page.once('dialog', (dialog) => void dialog.dismiss());
  await panel.getByRole('button', { name: 'Delete Retouch round' }).click();
  await expect(
    panel.getByRole('heading', { name: 'Retouch round', exact: true }),
  ).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await panel.getByRole('button', { name: 'Delete Retouch round' }).click();
  await expect(
    panel.getByText('No collections yet. Create your first photo set.'),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Photos (1)', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Open Ceremony.jpg' }),
  ).toBeVisible();
});

test('collections reach duplicate filenames beyond page one and protect pending saves', async ({
  page,
}) => {
  const { eventId, photos } = await fixture(page);
  const source = photos[0]!;
  photos.splice(
    0,
    photos.length,
    ...Array.from({ length: 105 }, (_, index) => ({
      ...source,
      id: `photo-${index}`,
      filename: 'Same.jpg',
    })),
  );
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  let collection: ProofingCollection | null = null;
  await page.route(
    `**/api/events/${eventId}/proofing-collections**`,
    async (route) => {
      if (route.request().method() === 'GET')
        return route.fulfill({
          json: { collections: collection ? [collection] : [], limit: 50 },
        });
      const body = route.request().postDataJSON();
      started();
      await pending;
      expect(body.photoIds).toEqual(['photo-104']);
      collection = {
        id: 'saved-page-two',
        title: body.title,
        version: 1,
        createdAt: '2026-10-20T12:00:00.000Z',
        updatedAt: '2026-10-20T12:00:00.000Z',
        photoIds: body.photoIds,
        photos: [{ id: 'photo-104', filename: 'Same.jpg' }],
        unavailableCount: 0,
      };
      return route.fulfill({ status: 201, json: { collection } });
    },
  );
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Collections', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Proofing collections' });
  await panel
    .getByRole('button', { name: 'New collection', exact: true })
    .click();
  const editor = panel.getByRole('form', { name: 'Collection editor' });
  await editor.getByLabel('Collection name', { exact: true }).fill('Page two');
  await expect(editor.getByLabel('Same.jpg', { exact: true })).toHaveCount(100);
  await editor.getByRole('button', { name: 'Next photo page' }).click();
  await expect(editor.getByLabel('Same.jpg', { exact: true })).toHaveCount(5);
  await editor.getByLabel('Same.jpg', { exact: true }).last().check();
  await editor
    .getByRole('button', { name: 'Save collection', exact: true })
    .click();
  await requested;
  try {
    await expect(
      panel.getByRole('button', { name: 'New collection', exact: true }),
    ).toBeDisabled();
    await expect(
      panel.getByRole('button', { name: 'Refresh collections', exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(
    panel.getByRole('heading', { name: 'Page two', exact: true }),
  ).toBeVisible();
  await panel
    .getByRole('button', { name: 'Edit Page two', exact: true })
    .click();
  await editor.getByLabel('Show selected photos only').check();
  await expect(editor.getByLabel('Same.jpg', { exact: true })).toHaveCount(1);
  await expect(editor.getByLabel('Same.jpg', { exact: true })).toBeChecked();
  // Deselecting removes this row from the selected-only view.
  await editor.getByLabel('Same.jpg', { exact: true }).click();
  await expect(editor.getByLabel('Same.jpg', { exact: true })).toHaveCount(0);
  await expect(
    editor.getByText('0 / 100 photos selected', { exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByRole('button', { name: 'Save collection', exact: true }),
  ).toBeDisabled();
});

test('event folders, search and visibility filters survive reload', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/app/events');
  const cards = page.locator('.event-card');
  await expect(cards).toHaveCount(3);
  await chooseMenu(page, 'Event folder', 'Weddings 2026');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Garden wedding');
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Event folder', exact: true }),
  ).toHaveText('Weddings 2026');
  await expect(cards).toHaveCount(1);
  await page.getByLabel('Search events').fill('not present');
  await expect(page.getByText('No events match these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await chooseMenu(page, 'Filter events', 'Archived');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Old conference');
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await chooseMenu(page, 'Sort events', 'Event name');
  await expect(cards.first()).toContainText('Campus gathering');
});

test('organizer edits a private event folder and can clear it', async ({
  page,
}) => {
  const { eventId, events } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page
    .getByText('Optional private organization', { exact: true })
    .click();
  const input = page.getByLabel('Event folder (private)', { exact: false });
  await expect(input).toHaveValue('Weddings 2026');
  await input.fill('Client albums');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('Event details saved.')).toBeVisible();
  expect(events[0]?.folder).toBe('Client albums');
  await input.fill('');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect.poll(() => events[0]?.folder).toBe('');
});

test('favorites reviews persist and can be found by status or guest', async ({
  page,
}) => {
  const { eventId, selection, state } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  const card = page.getByRole('article', { name: 'Selection from Asha' });
  await chooseMenu(page, 'Review status', 'Completed');
  await card
    .getByLabel('Private review note')
    .fill('Album edits delivered in person.');
  await card.getByRole('button', { name: 'Save review', exact: true }).click();
  await expect(
    card.getByText('Review saved. No message was sent to the guest.'),
  ).toBeVisible();
  await expect(card.locator('.review-badge')).toHaveText('Completed');
  expect(selection.reviewVersion).toBe(1);
  await chooseMenu(page, 'Filter selection status', 'New');
  await expect(
    page.getByText('No requests match these filters.'),
  ).toBeVisible();
  await chooseMenu(page, 'Filter selection status', 'Completed');
  await page.getByLabel('Search selections').fill('asha');
  await expect(card).toBeVisible();
  await page.reload();
  await expect(card.getByLabel('Private review note')).toHaveValue(
    'Album edits delivered in person.',
  );
  expect(state.unexpectedWrites).toEqual([]);
});

test('a competing review preserves the draft until explicit reload', async ({
  page,
}) => {
  const { eventId, state, selection } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  const card = page.getByRole('article', { name: 'Selection from Asha' });
  await card.getByLabel('Private review note').fill('My unsaved draft');
  state.conflict = true;
  await card.getByRole('button', { name: 'Save review', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('Another tab changed');
  await expect(card.getByLabel('Private review note')).toHaveValue(
    'My unsaved draft',
  );
  await expect(
    card.getByRole('button', { name: 'Save review', exact: true }),
  ).toBeDisabled();
  await card.getByRole('button', { name: 'Load latest review' }).click();
  await expect(card.getByLabel('Private review note')).toHaveValue(
    'Updated in another tab',
  );
  await chooseMenu(page, 'Review status', 'Completed');
  await card.getByRole('button', { name: 'Save review', exact: true }).click();
  await expect(
    card.getByText('Review saved. No message was sent to the guest.'),
  ).toBeVisible();
  expect(selection.reviewVersion).toBe(2);
});

test('favorites ZIP contains only available photos and fits mobile', async ({
  page,
}) => {
  const { eventId, jpeg, state } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  const card = page.getByRole('article', { name: 'Selection from Asha' });
  await expect(
    card.getByText(/1 selected photo is no longer available/),
  ).toBeVisible();
  await expect(card.locator('.selection-thumbnails img')).toHaveCount(2);
  const pending = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Download favorites ZIP' }).click();
  const download = await pending;
  const path = await download.path();
  expect(path).toBeTruthy();
  const archive = unzipSync(new Uint8Array(await readFile(path!)));
  expect(Object.keys(archive)).toEqual(['001-Ceremony.jpg', '002-Garden.jpg']);
  expect(Buffer.from(archive['001-Ceremony.jpg']!)).toEqual(jpeg);
  await expect(
    card.getByText('ZIP ready. Your device handles the download.'),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  expect(state.unexpectedWrites).toEqual([]);
});

test('an expired photo stops the ZIP with an actionable error', async ({
  page,
}) => {
  const { eventId, state } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  const card = page.getByRole('article', { name: 'Selection from Asha' });
  await expect(card).toBeVisible();
  state.failDownload = true;
  let downloads = 0;
  page.on('download', () => {
    downloads++;
  });
  await card.getByRole('button', { name: 'Download favorites ZIP' }).click();
  await expect(card.getByRole('alert')).toContainText(
    'Could not download Ceremony.jpg',
  );
  await expect(
    card.getByRole('button', { name: 'Download favorites ZIP' }),
  ).toBeEnabled();
  expect(downloads).toBe(0);
});

test('filename export refreshes availability and excludes private notes', async ({
  page,
}) => {
  const { eventId, selection, state } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  const card = page.getByRole('article', { name: 'Selection from Asha' });
  await expect(card).toBeVisible();
  selection.photos = selection.photos.slice(0, 1);
  selection.reviewNote = 'Private editing instruction';
  const pending = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Export filenames CSV' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe(
    `picfind-selection-${selection.id}.csv`,
  );
  const content = await readFile((await download.path())!, 'utf8');
  expect(content).toContain('"Photo ID","Filename"');
  expect(content).toContain('"Ceremony.jpg"');
  expect(content).not.toContain('Garden.jpg');
  expect(content).not.toContain('Private editing instruction');
  await expect(
    card.getByRole('status').filter({ hasText: 'filename exported' }),
  ).toHaveText('1 filename exported. 2 unavailable photos omitted.');
  expect(state.writes).toEqual([]);
});

test('a revoked owner session blocks filename export', async ({ page }) => {
  const { eventId } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  const card = page.getByRole('article', { name: 'Selection from Asha' });
  await expect(card).toBeVisible();
  await page.route(`**/api/events/${eventId}/insights`, (route) =>
    route.fulfill({
      status: 401,
      json: { error: { message: 'Sign in again to export selections.' } },
    }),
  );
  let downloads = 0;
  page.on('download', () => downloads++);
  await card.getByRole('button', { name: 'Export filenames TXT' }).click();
  await expect(card.getByRole('alert')).toContainText('Sign in again');
  await expect(
    card.getByRole('button', { name: 'Export filenames TXT' }),
  ).toBeEnabled();
  expect(downloads).toBe(0);
});

test('organizers save selection count rules and see them after reload', async ({
  page,
}) => {
  const { eventId, state } = await fixture(page);
  await page.goto(`/app/events/${eventId}`);
  await page.getByText('Selection count rules', { exact: true }).click();
  await page.getByLabel('Minimum favorites per request').fill('3');
  await page.getByLabel('Maximum favorites per request').fill('2');
  await page.getByRole('button', { name: 'Save selection limits' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'minimum must be no greater',
  );
  expect(state.selectionRules).toEqual({ minimum: 1, maximum: 100 });
  await page.getByLabel('Maximum favorites per request').fill('3');
  await page.getByRole('button', { name: 'Save selection limits' }).click();
  await expect(
    page.getByText('Selection limits saved for future submissions.'),
  ).toBeVisible();
  expect(state.selectionRules).toEqual({ minimum: 3, maximum: 3 });
  await page.reload();
  await page.getByText('Selection count rules', { exact: true }).click();
  await expect(page.getByLabel('Minimum favorites per request')).toHaveValue(
    '3',
  );
  await expect(page.getByLabel('Maximum favorites per request')).toHaveValue(
    '3',
  );
});

test('organizers schedule, close and reopen favorites without changing the gallery', async ({
  page,
}) => {
  const { eventId, state, events } = await fixture(page);
  const before = structuredClone(events[0]);
  await page.goto(`/app/events/${eventId}`);
  await page
    .getByText('Favorites submission deadline', { exact: true })
    .click();
  const form = page
    .locator('details')
    .filter({ hasText: 'Favorites submission deadline' });
  await expect(
    form.getByText('Favorites submissions are open.', { exact: true }),
  ).toBeVisible();
  const tomorrow = new Date(Date.now() + 86400000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T18:30`;
  await page.getByLabel('Submission deadline in your time zone').fill(local);
  await page
    .getByRole('button', { name: 'Schedule submission deadline' })
    .click();
  await expect(
    form.getByText('Submission window saved. Existing requests are unchanged.'),
  ).toBeVisible();
  expect(state.selectionWindow.closesAt).toBe(new Date(local).toISOString());
  await expect(form.getByText(/Time zone:/)).toBeVisible();
  await page.reload();
  await page
    .getByText('Favorites submission deadline', { exact: true })
    .click();
  await expect(
    page.getByLabel('Submission deadline in your time zone'),
  ).toHaveValue(local);
  await page.getByRole('button', { name: 'Close submissions now' }).click();
  await expect(
    form.getByText('Favorites submissions are closed.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reopen without deadline' }).click();
  await expect(
    form.getByText('Favorites submissions are open.', { exact: true }),
  ).toBeVisible();
  expect(state.selectionWindow.closesAt).toBeNull();
  expect(events[0]).toEqual(before);
});

test('compare requests, filter shared favorites and export current availability', async ({
  page,
}) => {
  const { eventId, selection, selections, state } = await fixture(page);
  selections.push({
    ...selection,
    id: '66666666-6666-4666-8666-666666666666',
    name: 'Ravi',
    note: 'Guest note excluded from comparison',
    reviewNote: 'Private note excluded from comparison',
    photoIds: [selection.photos[1]!.id],
    photos: [selection.photos[1]!],
  });
  await page.goto(`/app/events/${eventId}`);
  await page.getByText('Compare client selections', { exact: true }).click();
  const comparison = page.locator('.selection-comparison');
  await chooseMenu(page, 'First selection request', /^1\. Asha/);
  await chooseMenu(page, 'Second selection request', /^2\. Ravi/);
  await expect(comparison).toContainText(
    '2 available photos, 1 shared favorites, 1 unavailable photos omitted.',
  );
  const list = comparison.getByRole('list', { name: 'Compared photos' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await chooseMenu(page, 'Comparison photos', 'Shared favorites');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('Garden.jpg');
  await chooseMenu(page, 'Comparison photos', 'Only in first request');
  await expect(list).toContainText('Ceremony.jpg');
  await chooseMenu(page, 'Comparison photos', 'All selected photos');
  // The photo disappears after rendering. Export must use the new projection.
  selection.photos = selection.photos.slice(1);
  const pending = page.waitForEvent('download');
  await comparison
    .getByRole('button', { name: 'Export comparison CSV' })
    .click();
  const download = await pending;
  const content = await readFile((await download.path())!, 'utf8');
  expect(content).toContain('Garden.jpg');
  expect(content).not.toContain('Ceremony.jpg');
  expect(content).not.toMatch(/Asha|Ravi|Private note|Guest note/);
  await expect(comparison).toContainText(
    '1 filenames exported from current availability.',
  );
  await chooseMenu(page, 'Second selection request', /^1\. Asha/);
  await expect(comparison).toContainText(
    'Choose two different selection requests.',
  );
  await expect(comparison.getByRole('list')).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test('an invalid stored deadline can be reopened by the owner', async ({
  page,
}) => {
  const { eventId, state } = await fixture(page);
  state.selectionWindow = {
    closesAt: null,
    serverNow: new Date().toISOString(),
    closed: true,
    invalid: true,
  };
  await page.goto(`/app/events/${eventId}`);
  await page
    .getByText('Favorites submission deadline', { exact: true })
    .click();
  await expect(page.getByText(/The stored deadline is invalid/)).toBeVisible();
  await page.getByRole('button', { name: 'Reopen without deadline' }).click();
  await expect(
    page.getByText('Favorites submissions are open.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/The stored deadline is invalid/)).toHaveCount(0);
  expect(state.selectionWindow.closed).toBe(false);
});

test('private photo instructions save, reload, clear and recover a conflicting draft', async ({
  page,
}) => {
  const { eventId } = await fixture(page);
  let note = { text: '', version: 0, updatedAt: null as string | null };
  let conflict = false;
  await page.route('**/api/photos/*/private-note', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { note } });
    const body = route.request().postDataJSON();
    if (conflict) {
      conflict = false;
      note = {
        text: 'Saved in another tab',
        version: note.version + 1,
        updatedAt: new Date().toISOString(),
      };
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'PHOTO_NOTE_CHANGED',
            message: 'Another tab changed this photo note.',
          },
        },
      });
    }
    expect(body.version).toBe(note.version);
    note = {
      text: body.text.trim(),
      version: note.version + 1,
      updatedAt: new Date().toISOString(),
    };
    return route.fulfill({ json: { note } });
  });
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('button', { name: 'Open Ceremony.jpg' }).click();
  const dialog = page.getByRole('dialog', { name: 'Photo viewer' });
  await dialog.getByText('Private photo instructions', { exact: true }).click();
  const input = dialog.getByLabel('Private editing note');
  await input.fill('Crop from the left');
  await input.press('ArrowRight');
  await expect(
    dialog.getByRole('heading', { name: 'Ceremony.jpg' }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Save private note' }).click();
  await expect(
    dialog.getByText('Private note saved.', { exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close photo' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Open Ceremony.jpg' }).click();
  await dialog.getByText('Private photo instructions', { exact: true }).click();
  await expect(input).toHaveValue('Crop from the left');
  conflict = true;
  await input.fill('My unsaved draft');
  await dialog.getByRole('button', { name: 'Save private note' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Another tab');
  await expect(input).toHaveValue('My unsaved draft');
  await dialog.getByText('Private photo instructions', { exact: true }).click();
  await expect(input).not.toBeVisible();
  await dialog.getByText('Private photo instructions', { exact: true }).click();
  await expect(input).toHaveValue('My unsaved draft');
  await expect(
    dialog.getByRole('button', { name: 'Save private note' }),
  ).toBeDisabled();
  await dialog
    .getByRole('button', { name: 'Replace draft with latest note' })
    .click();
  await expect(input).toHaveValue('Saved in another tab');
  await input.fill('');
  await dialog.getByRole('button', { name: 'Save private note' }).click();
  await expect(
    dialog.getByText('Private note cleared.', { exact: true }),
  ).toBeVisible();
  expect(note.text).toBe('');
  expect(note.version).toBe(3);
});

test('comparison export fails when owner access is revoked', async ({
  page,
}) => {
  const { eventId, selection, selections } = await fixture(page);
  selections.push({ ...selection, id: 'second', name: 'Ravi' });
  await page.goto(`/app/events/${eventId}`);
  await page.getByText('Compare client selections', { exact: true }).click();
  await chooseMenu(page, 'First selection request', /^1\. Asha/);
  await chooseMenu(page, 'Second selection request', /^2\. Ravi/);
  await page.route(`**/api/events/${eventId}/insights`, (route) =>
    route.fulfill({
      status: 403,
      json: { error: { message: 'Owner access is required.' } },
    }),
  );
  let downloads = 0;
  page.on('download', () => downloads++);
  const comparison = page.locator('.selection-comparison');
  await comparison
    .getByRole('button', { name: 'Export comparison CSV' })
    .click();
  await expect(comparison.getByRole('alert')).toContainText('Owner access');
  expect(downloads).toBe(0);
});

test('leaving an event cancels a pending comparison export', async ({
  page,
}) => {
  const { eventId, selection, selections } = await fixture(page);
  selections.push({ ...selection, id: 'second', name: 'Ravi' });
  await page.goto(`/app/events/${eventId}`);
  await page.getByText('Compare client selections', { exact: true }).click();
  await chooseMenu(page, 'First selection request', /^1\. Asha/);
  await chooseMenu(page, 'Second selection request', /^2\. Ravi/);
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  const started = deferred();
  const release = deferred();
  await page.route(`**/api/events/${eventId}/insights`, async (route) => {
    started.resolve();
    await release.promise;
    await route.fulfill({ json: { selections } });
  });
  let downloads = 0;
  page.on('download', () => downloads++);
  const cancelled = page.waitForEvent('requestfailed', {
    predicate: (request) =>
      new URL(request.url()).pathname === `/api/events/${eventId}/insights`,
  });
  try {
    await page.getByRole('button', { name: 'Export comparison CSV' }).click();
    await started.promise;
    await page.getByRole('link', { name: 'All events', exact: true }).click();
    await expect(page).toHaveURL('/app/events');
    expect((await cancelled).failure()).not.toBeNull();
  } finally {
    release.resolve();
  }
  expect(downloads).toBe(0);
});
