import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

async function fixture(page: Page) {
  const state = {
    actor: 'owner',
    writes: [] as string[],
    reads: [] as string[],
    hold: false,
    fail: false,
    release: null as (() => void) | null,
  };
  await page.exposeFunction('beforeDuplicateRead', async (name: string) => {
    state.reads.push(name);
    if (state.hold)
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    if (state.fail) throw new Error('Synthetic unreadable local file.');
  });
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      await (
        window as unknown as {
          beforeDuplicateRead: (name: string) => Promise<void>;
        }
      ).beforeDuplicateRead(this.name);
      return read.call(this);
    };
  });
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') state.writes.push(`${req.method()} ${path}`);
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: state.actor,
            name: state.actor,
            email: `${state.actor}@example.test`,
            emailVerified: true,
          },
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: { photos: [], events: [], jobs: [], scans: [], photoLimit: 100 },
      });
    if (path === '/api/capabilities')
      return route.fulfill({
        json: {
          storage: true,
          drive: false,
          faceMatching: false,
          billing: false,
        },
      });
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Unavailable synthetic endpoint.' } },
    });
  });
  const jpeg = await sharp({
    create: { width: 32, height: 24, channels: 3, background: '#477c79' },
  })
    .jpeg()
    .toBuffer();
  const different = await sharp({
    create: { width: 32, height: 24, channels: 3, background: '#904b3d' },
  })
    .jpeg()
    .toBuffer();
  await page.goto('/app/duplicates');
  await expect(
    page.getByRole('heading', { name: 'Exact duplicate review' }),
  ).toBeVisible();
  const photos = [
    { name: 'same-name.jpg', mimeType: 'image/jpeg', buffer: jpeg },
    { name: 'renamed-copy.jpg', mimeType: 'image/jpeg', buffer: jpeg },
    { name: 'same-name.jpg', mimeType: 'image/jpeg', buffer: different },
  ];
  return { state, photos, jpeg };
}
const input = (page: Page) =>
  page.getByLabel('Choose local photos', { exact: true });
const ready = (page: Page) =>
  expect(
    page.getByText(
      'Review ready. Every file is initially kept. Originals remain unchanged.',
    ),
  ).toBeVisible();
async function download(page: Page, format: string) {
  const waiting = page.waitForEvent('download');
  await page
    .getByRole('button', { name: `Export decisions ${format}`, exact: true })
    .click();
  const file = await waiting;
  return readFile((await file.path())!, 'utf8');
}

test('groups real file hashes, preserves same-name identities and exports reversible decisions locally', async ({
  page,
}, testInfo) => {
  const f = await fixture(page);
  await input(page).setInputFiles(f.photos);
  await ready(page);
  const totals = page.getByRole('definition');
  await expect(totals).toHaveText(['3', '1', '1', '3', '0', '0']);
  await expect(
    page.getByRole('region', { name: 'File group 1', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Keep input 3: same-name.jpg', { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel('Show duplicate groups only').uncheck();
  await expect(
    page.getByLabel('Keep input 3: same-name.jpg', { exact: true }),
  ).toBeChecked();
  await page
    .getByRole('button', { name: 'Keep one copy per group', exact: true })
    .click();
  const first = page.getByLabel('Keep input 1: same-name.jpg', { exact: true });
  const second = page.getByLabel('Keep input 2: renamed-copy.jpg', {
    exact: true,
  });
  await expect(first).toBeChecked();
  await expect(first).toBeDisabled();
  await second.check();
  await first.uncheck();
  await expect(second).toBeDisabled();
  await expect(totals).toHaveText([
    '3',
    '1',
    '1',
    '2',
    '1',
    f.jpeg.length.toLocaleString('en-US'),
  ]);
  const report = JSON.parse(await download(page, 'JSON'));
  expect(report.originalsChanged).toBe(false);
  expect(report.items.map((row: { decision: string }) => row.decision)).toEqual(
    ['exclude-from-selection', 'keep', 'keep'],
  );
  expect(report.items[0].digest).toBe(
    createHash('sha256').update(f.jpeg).digest('hex'),
  );
  expect(report.items[2].digest).not.toBe(report.items[0].digest);
  expect(report.items.map((row: { row: number }) => row.row)).toEqual([
    1, 2, 3,
  ]);
  await page.screenshot({
    path: testInfo.outputPath('local-duplicate-review.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Restore all copies' }).click();
  await expect(totals).toHaveText(['3', '1', '1', '3', '0', '0']);
  expect(f.state.writes).toEqual([]);
  const storage = await page.evaluate(
    () =>
      JSON.stringify({ ...localStorage }) +
      JSON.stringify({ ...sessionStorage }),
  );
  expect(storage).not.toContain('same-name.jpg');
  expect(storage).not.toContain(report.items[0].digest);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test('requires explicit replacement and discard confirmation', async ({
  page,
}) => {
  const f = await fixture(page);
  await input(page).setInputFiles(f.photos);
  await ready(page);
  page.once('dialog', (dialog) => dialog.dismiss());
  await input(page).setInputFiles([f.photos[0]!]);
  await expect(page.getByRole('definition').first()).toHaveText('3');
  expect(f.state.reads).toHaveLength(3);
  page.once('dialog', (dialog) => dialog.accept());
  await input(page).setInputFiles([f.photos[0]!]);
  await ready(page);
  await expect(page.getByRole('definition').first()).toHaveText('1');
  await expect(
    page.getByText(
      'No byte-identical duplicates found. Turn off the filter to inspect every file.',
    ),
  ).toBeVisible();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Discard local review' }).click();
  await expect(page.getByRole('definition').first()).toHaveText('1');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Discard local review' }).click();
  await expect(page.getByText('Local review discarded.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Export decisions JSON' }),
  ).toHaveCount(0);
});

test('cancels an in-flight read without publishing partial results or reading another file', async ({
  page,
}) => {
  const f = await fixture(page);
  f.state.hold = true;
  await input(page).setInputFiles(f.photos);
  await expect.poll(() => Boolean(f.state.release)).toBe(true);
  await page.getByRole('button', { name: 'Cancel scan', exact: true }).click();
  await expect(input(page)).toBeDisabled();
  f.state.release!();
  await expect(input(page)).toBeEnabled();
  await expect(
    page.getByText(
      'Scan cancelled. No partial review was retained. Originals remain unchanged.',
    ),
  ).toBeVisible();
  expect(f.state.reads).toEqual(['same-name.jpg']);
  await expect(page.getByRole('definition')).toHaveCount(0);
  f.state.hold = false;
  await input(page).setInputFiles(f.photos);
  await ready(page);
  expect(f.state.writes).toEqual([]);
});

test('rejects invalid metadata before reads and recovers from a read failure', async ({
  page,
}) => {
  const f = await fixture(page);
  await input(page).setInputFiles([
    {
      name: 'vector.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg/>'),
    },
  ]);
  await expect(
    page.getByText(
      'Choose JPEG, PNG or WebP files with valid names, each between 1 byte and 8 MiB.',
    ),
  ).toBeVisible();
  expect(f.state.reads).toEqual([]);
  f.state.fail = true;
  await input(page).setInputFiles(f.photos);
  await expect(
    page.getByText('Synthetic unreadable local file.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Export decisions CSV' }),
  ).toHaveCount(0);
  f.state.fail = false;
  await input(page).setInputFiles(f.photos);
  await ready(page);
});

test('protects CSV spreadsheet formulas while preserving exact names in JSON', async ({
  page,
}) => {
  const f = await fixture(page);
  await input(page).setInputFiles([
    { ...f.photos[0]!, name: '=formula.jpg' },
    { ...f.photos[1]!, name: '\u2003@formula.jpg' },
  ]);
  await ready(page);
  const csv = await download(page, 'CSV');
  expect(csv).toContain('"\'=formula.jpg"');
  expect(csv).toContain('"\'\u2003@formula.jpg"');
  const json = JSON.parse(await download(page, 'JSON'));
  expect(json.items.map((row: { name: string }) => row.name)).toEqual([
    '=formula.jpg',
    '\u2003@formula.jpg',
  ]);
  expect(f.state.writes).toEqual([]);
});

test('clears the local review when the authenticated account changes', async ({
  page,
}) => {
  const f = await fixture(page);
  await input(page).setInputFiles(f.photos);
  await ready(page);
  f.state.actor = 'other';
  await page.evaluate(() =>
    window.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(
    page.getByText(
      'No local review loaded. Select files to compare their exact bytes.',
    ),
  ).toBeVisible();
  await expect(page.getByText('renamed-copy.jpg', { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'Export decisions JSON' }),
  ).toHaveCount(0);
});

test('aborts an unfinished read and reopens an empty review through the studio navigation', async ({
  page,
}) => {
  const f = await fixture(page);
  f.state.hold = true;
  await input(page).setInputFiles(f.photos);
  await expect.poll(() => Boolean(f.state.release)).toBe(true);
  const menu = page.getByRole('button', { name: 'Toggle studio navigation' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('link', { name: 'Clients', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Exact duplicate review' }),
  ).toHaveCount(0);
  f.state.release!();
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('link', { name: 'Duplicate review', exact: true })
    .click();
  await expect(page).toHaveURL('/app/duplicates');
  await expect(
    page.getByRole('heading', { name: 'Exact duplicate review' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'No local review loaded. Select files to compare their exact bytes.',
    ),
  ).toBeVisible();
  expect(f.state.reads).toEqual(['same-name.jpg']);
});
