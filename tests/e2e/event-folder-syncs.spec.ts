import { expect, test, type Page } from '@playwright/test';
const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const syncId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const generation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const replacementId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
async function fixture(page: Page, retry = false, reconnect = false) {
  let source: Record<string, unknown> | null = reconnect
    ? {
        id: syncId,
        eventId,
        provider: 'drive',
        folder: 'photo-folder',
        sourceOwner: true,
        status: 'paused',
        imported: 12,
        canStop: false,
        canResume: true,
        error: null,
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        nextCheckAt: null,
      }
    : null;
  const writes: {
    path: string;
    body: Record<string, unknown>;
    consent: string | undefined;
  }[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const send = (json: unknown, status = 200) =>
      route.fulfill({ status, json });
    if (path === '/api/auth/session')
      return send({
        user: {
          id: 'owner',
          name: 'Morgan',
          email: 'owner@example.test',
          emailVerified: true,
        },
      });
    if (path === '/api/library')
      return send({
        photos: [],
        jobs: [],
        scans: [],
        photoLimit: 20,
        storedPhotoCount: 0,
        events: [eventId, other].map((id, i) => ({
          id,
          title: i ? 'Second collection' : 'Together, in focus',
          archived: false,
          visibility: 'private',
          expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
          createdAt: new Date().toISOString(),
        })),
      });
    if (path === '/api/capabilities')
      return send({
        storage: true,
        billing: false,
        cloudImports: true,
        folderSync: true,
        folderSyncManagement: true,
        driveOAuth: true,
        driveConnected: true,
        faceMatching: false,
        eventIndexMax: 20,
      });
    if (path === '/api/billing') return send({});
    if (path === '/api/sources') return send({ sources: [] });
    if (path.endsWith('/insights'))
      return send({ selections: [], visits: 0, downloads: 0 });
    if (path === '/api/imports/queued/drive/items')
      return send({ items: [], cursor: null, generation });
    if (path === '/api/imports/queued') return send({ jobs: [] });
    if (path.includes('/processing')) return send({ enabled: false, jobs: [] });
    if (path === `/api/events/${other}/sources`) return send({ sources: [] });
    if (path.startsWith(`/api/events/${eventId}/sources`)) {
      if (request.method() === 'GET')
        return send({ sources: source ? [source] : [] });
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({
        path,
        body,
        consent: request.headers()['x-picfind-consent'],
      });
      if (reconnect && path.endsWith('/resume'))
        return send(
          {
            error: {
              code: 'SOURCE_CONNECTION_CHANGED',
              message:
                'The connected account changed. Confirm replacement to continue.',
            },
          },
          409,
        );
      if (
        reconnect &&
        body.replacesSyncId === syncId &&
        writes.filter((write) => write.body.replacesSyncId === syncId)
          .length === 1
      )
        return send(
          {
            error: {
              code: 'TEMPORARY',
              message: 'Synthetic interrupted replacement reply. Retry safely.',
            },
          },
          503,
        );
      if (retry && writes.length === 1)
        return send(
          {
            error: {
              code: 'TEMPORARY',
              message: 'Synthetic interrupted reply. Retry safely.',
            },
          },
          503,
        );
      if (path.endsWith('/stop'))
        source = {
          ...source,
          status: 'paused',
          canStop: false,
          canResume: true,
        };
      else
        source = {
          id: body.replacesSyncId ? replacementId : syncId,
          eventId,
          provider: 'drive',
          folder: 'photo-folder',
          sourceOwner: true,
          status: 'active',
          imported: 12,
          canStop: true,
          canResume: false,
          error: null,
          expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
          nextCheckAt: new Date().toISOString(),
        };
      return send({ source }, path.endsWith('/sources') ? 201 : 200);
    }
    return send({});
  });
  return { writes };
}
async function openFolder(page: Page) {
  await page.goto(`/app/events/${eventId}`);
  await page
    .getByRole('button', { name: 'Import now from Google Drive' })
    .click();
  await page
    .getByRole('textbox', { name: 'Google Drive folder link' })
    .fill('https://drive.google.com/drive/folders/photo-folder');
  await page
    .getByRole('button', { name: 'Open Drive folder', exact: true })
    .click();
  return page.getByRole('region', {
    name: 'Keep this folder syncing',
    exact: true,
  });
}
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`event source consent, start, stop and resume at ${viewport.width}`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const f = await fixture(page),
      setup = await openFolder(page);
    await expect(
      setup.getByRole('button', { name: 'Start folder syncing' }),
    ).toBeDisabled();
    await setup
      .getByRole('checkbox', { name: /I have permission to keep copying/ })
      .check();
    await setup.getByRole('button', { name: 'Start folder syncing' }).click();
    await expect(
      setup.getByText('This folder is already syncing into this event.'),
    ).toBeVisible();
    expect(f.writes[0]).toMatchObject({
      path: `/api/events/${eventId}/sources`,
      consent: 'folder-sync-v1',
      body: { provider: 'drive', folderId: 'photo-folder', generation },
    });
    expect(f.writes[0]!.body).not.toHaveProperty('ownerId');
    const management = page.getByRole('region', {
      name: 'Event folder syncing',
      exact: true,
    });
    await expect(
      management.getByText('12 files processed', { exact: false }),
    ).toBeVisible();
    await management
      .getByRole('button', { name: 'Stop syncing', exact: true })
      .click();
    await expect(
      management.getByText('Stopped', { exact: true }),
    ).toBeVisible();
    await expect(setup.getByRole('checkbox')).not.toBeChecked();
    await setup.getByRole('checkbox').check();
    await setup.getByRole('button', { name: 'Resume folder syncing' }).click();
    expect(f.writes.at(-1)).toMatchObject({
      path: `/api/events/${eventId}/sources/${syncId}/resume`,
      consent: 'folder-sync-v1',
      body: { generation },
    });
    await expect(
      management.getByText('Syncing on', { exact: true }),
    ).toBeVisible();
    await management.scrollIntoViewIfNeeded();
    await expect(
      management.getByText(/^Google Drive syncing stopped/),
    ).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator('.studio-shell')).toBeVisible();
    await page.screenshot({
      path: `artifacts/reports/event-sync-${viewport.width}-${test.info().project.name}.png`,
      animations: 'disabled',
      scale: 'css',
    });
    expect(errors).toEqual([]);
    await page.goto(`/app/events/${other}`);
    await expect(
      page
        .getByRole('region', { name: 'Event folder syncing' })
        .getByText(/No folders are syncing/),
    ).toBeVisible();
    await expect(page.getByText('photo-folder', { exact: true })).toHaveCount(
      0,
    );
  });
}
test('ambiguous failures reuse the same sync request id', async ({ page }) => {
  const f = await fixture(page, true),
    setup = await openFolder(page);
  await setup.getByRole('checkbox').check();
  await setup.getByRole('button', { name: 'Start folder syncing' }).click();
  await expect(
    setup.getByText('Synthetic interrupted reply. Retry safely.'),
  ).toBeVisible();
  await setup.getByRole('button', { name: 'Start folder syncing' }).click();
  await expect(
    setup.getByText('This folder is already syncing into this event.'),
  ).toBeVisible();
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0]!.body.requestId).toBe(f.writes[1]!.body.requestId);
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`reconnected account requires separate replacement consent at ${viewport.width}`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize(viewport);
    const f = await fixture(page, false, true);
    const setup = await openFolder(page);
    const copying = setup.getByRole('checkbox', {
      name: /I have permission to keep copying/,
    });
    const resume = setup.getByRole('button', {
      name: 'Resume folder syncing',
      exact: true,
    });
    await expect(resume).toBeDisabled();
    await copying.check();
    await resume.click();
    const replacement = setup.getByRole('checkbox', {
      name: /I confirm this reconnected account/,
    });
    const replace = setup.getByRole('button', {
      name: 'Replace stopped source',
      exact: true,
    });
    await expect(replacement).toBeVisible();
    await expect(copying).not.toBeChecked();
    await expect(replacement).not.toBeChecked();
    await expect(replace).toBeDisabled();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({
      path: `/api/events/${eventId}/sources/${syncId}/resume`,
      consent: 'folder-sync-v1',
      body: { generation },
    });
    await replacement.check();
    await expect(replace).toBeDisabled();
    await replacement.uncheck();
    await copying.check();
    await expect(replace).toBeDisabled();
    await replacement.check();
    await expect(replace).toBeEnabled();
    expect(f.writes).toHaveLength(1);
    await replace.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/reports/event-source-replacement-${viewport.width}-${test.info().project.name}.png`,
      animations: 'disabled',
      scale: 'css',
    });
    await replace.click();
    await expect(
      setup.getByText('Synthetic interrupted replacement reply. Retry safely.'),
    ).toBeVisible();
    expect(f.writes).toHaveLength(2);
    expect(f.writes[1]).toMatchObject({
      path: `/api/events/${eventId}/sources`,
      consent: 'folder-sync-v1',
      body: {
        provider: 'drive',
        folderId: 'photo-folder',
        generation,
        replacesSyncId: syncId,
        acceptConnectionChange: true,
      },
    });
    expect(f.writes[1]!.body).not.toHaveProperty('ownerId');
    expect(f.writes[1]!.body.requestId).not.toBe(f.writes[0]!.body.requestId);
    await replace.click();
    await expect(
      setup.getByText('This folder is already syncing into this event.'),
    ).toBeVisible();
    expect(f.writes).toHaveLength(3);
    expect(f.writes[2]!.body).toEqual(f.writes[1]!.body);
    await expect(
      page
        .getByRole('region', { name: 'Event folder syncing', exact: true })
        .getByText('Syncing on', { exact: true }),
    ).toBeVisible();
  });
}
