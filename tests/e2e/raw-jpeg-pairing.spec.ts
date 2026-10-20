import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const eventId = 'a15cfe6e-2ff0-4564-b83d-047d0eb2e673';
async function fixture(page: Page) {
  const image = await sharp({
    create: { width: 40, height: 30, channels: 3, background: '#477c79' },
  })
    .jpeg()
    .toBuffer();
  const event = {
    id: eventId,
    ownerId: 'owner',
    accessRole: 'owner',
    title: 'Synthetic editing event',
    description: '',
    date: '',
    visibility: 'private',
    archived: false,
    expiresAt: '',
    createdAt: '2026-10-20T00:00:00.000Z',
  };
  const photos = ['IMG_01.JPG', 'IMG_01.jpg', 'IMG_02.jpeg'].map(
    (filename, index) => ({
      id: `jpeg-${index}`,
      filename,
      eventId,
      width: 40,
      height: 30,
      bytes: image.length,
      createdAt: event.createdAt,
    }),
  );
  const state = {
    denied: false,
    responseOwner: 'owner',
    responseRole: 'owner',
    galleryReads: 0,
    writes: [] as string[],
  };
  await page.addInitScript(() => {
    const readText = File.prototype.text;
    File.prototype.arrayBuffer = async () => {
      throw new Error('RAW image content must not be read.');
    };
    File.prototype.text = function () {
      if (this.type !== 'application/json')
        throw new Error('Only mapping JSON may be read.');
      return readText.call(this);
    };
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') state.writes.push(path);
    if (path === '/api/auth/session')
      return route.fulfill({
        json: {
          user: {
            id: 'owner',
            name: 'Owner',
            email: 'owner@example.test',
            emailVerified: true,
          },
        },
      });
    if (path === '/api/library')
      return route.fulfill({
        json: { photos, events: [event], jobs: [], scans: [], photoLimit: 100 },
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
    if (path === `/api/events/${eventId}/gallery`) {
      state.galleryReads++;
      if (state.denied)
        return route.fulfill({
          status: 404,
          json: { error: { message: 'Event access unavailable.' } },
        });
      return route.fulfill({
        json: {
          event: {
            ...event,
            ownerId: state.responseOwner,
            accessRole: state.responseRole,
          },
          photos,
          remainingUploads: 97,
        },
      });
    }
    if (path.endsWith('/file'))
      return route.fulfill({ contentType: 'image/jpeg', body: image });
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Unexpected synthetic request.' } },
    });
  });
  return { state, photos };
}
async function open(page: Page) {
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Editing', exact: true }).click();
  const panel = page.getByRole('region', { name: 'RAW to JPEG pairing' });
  await expect(
    panel.getByText('3 currently available event JPEGs.'),
  ).toBeVisible();
  return panel;
}
const raw = (name: string) => ({
  name,
  mimeType: 'application/octet-stream',
  buffer: Buffer.from('synthetic raw bytes never read or sent'),
});
async function download(page: Page, label: string) {
  const ready = page.waitForEvent('download');
  await page.getByRole('button', { name: label, exact: true }).click();
  const result = await ready;
  const path = await result.path();
  expect(path).toBeTruthy();
  return readFile(path!, 'utf8');
}

test('RAW pairing resolves ambiguous filenames and exports only distinct explicit mappings without reading RAW bytes', async ({
  page,
}) => {
  const f = await fixture(page);
  const panel = await open(page);
  await panel
    .getByLabel('Local RAW files', { exact: true })
    .setInputFiles([
      raw('IMG_01.CR3'),
      raw('IMG_01.NEF'),
      raw('IMG_02.ARW'),
      raw('notes.txt'),
    ]);
  await expect(
    panel.getByText(
      '3 RAW filenames prepared. 1 files skipped. Review suggestions before applying them.',
    ),
  ).toBeVisible();
  await panel.getByText('Skipped file report (1)').click();
  await expect(
    panel.getByText('notes.txt: Not a supported RAW filename.'),
  ).toBeVisible();
  await panel
    .getByRole('button', { name: 'Apply unambiguous suggestions' })
    .click();
  await expect(
    panel.getByRole('combobox', { name: 'JPEG for IMG_02.ARW', exact: true }),
  ).toHaveValue('jpeg-2');
  await expect(
    panel.getByRole('combobox', { name: 'JPEG for IMG_01.CR3', exact: true }),
  ).toHaveValue('');
  await panel
    .getByRole('combobox', { name: 'JPEG for IMG_01.CR3', exact: true })
    .selectOption('jpeg-0');
  await panel
    .getByRole('combobox', { name: 'JPEG for IMG_01.NEF', exact: true })
    .selectOption('jpeg-0');
  await expect(
    panel.getByText(
      'This JPEG is assigned to more than one RAW entry. Choose a different JPEG or skip an entry.',
    ),
  ).toHaveCount(2);
  await panel.getByRole('button', { name: 'Export RAW to JPEG CSV' }).click();
  await expect(
    panel.getByText(
      'Review 2 unresolved or changed mappings before exporting.',
    ),
  ).toBeVisible();
  await panel
    .getByRole('combobox', { name: 'JPEG for IMG_01.NEF', exact: true })
    .selectOption('jpeg-1');
  const before = f.state.galleryReads;
  const csv = await download(page, 'Export RAW to JPEG CSV');
  expect(f.state.galleryReads).toBe(before + 1);
  expect(csv).toContain('"IMG_01.CR3"');
  expect(csv).toContain('"jpeg-0","IMG_01.JPG"');
  expect(csv).toContain('"jpeg-1","IMG_01.jpg"');
  expect(csv).not.toContain('notes.txt');
  expect(csv).not.toContain('synthetic raw bytes');
  expect(f.state.writes).toEqual([]);
});

test('RAW mapping JSON restores after reload and rejects a foreign event without replacing current decisions', async ({
  page,
}) => {
  const f = await fixture(page);
  let panel = await open(page);
  await panel
    .getByLabel('Local RAW files', { exact: true })
    .setInputFiles([raw('IMG_02.ARW')]);
  await panel
    .getByRole('button', { name: 'Apply unambiguous suggestions' })
    .click();
  const saved = await download(page, 'Download mapping JSON');
  expect(saved).not.toContain('synthetic raw bytes');
  await page.reload();
  await page.getByRole('tab', { name: 'Editing', exact: true }).click();
  panel = page.getByRole('region', { name: 'RAW to JPEG pairing' });
  await expect(
    panel.getByText('3 currently available event JPEGs.'),
  ).toBeVisible();
  await panel.getByLabel('Restore RAW mapping file').setInputFiles({
    name: 'mapping.json',
    mimeType: 'application/json',
    buffer: Buffer.from(saved),
  });
  await expect(
    panel.getByRole('combobox', { name: 'JPEG for IMG_02.ARW', exact: true }),
  ).toHaveValue('jpeg-2');
  const foreign = JSON.parse(saved);
  foreign.eventId = 'another-event';
  page.once('dialog', (dialog) => dialog.accept());
  await panel.getByLabel('Restore RAW mapping file').setInputFiles({
    name: 'foreign.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(foreign)),
  });
  await expect(
    panel.getByText('This mapping belongs to another account or event.'),
  ).toBeVisible();
  await expect(
    panel.getByRole('combobox', { name: 'JPEG for IMG_02.ARW', exact: true }),
  ).toHaveValue('jpeg-2');
  const csv = await download(page, 'Export RAW to JPEG CSV');
  expect(csv).toContain('"jpeg-2","IMG_02.jpeg"');
  expect(f.state.writes).toEqual([]);
});

test('RAW CSV rechecks access and requires review after a JPEG is renamed', async ({
  page,
}) => {
  const f = await fixture(page);
  const panel = await open(page);
  await panel
    .getByLabel('Local RAW files', { exact: true })
    .setInputFiles([raw('IMG_02.ARW')]);
  await panel
    .getByRole('button', { name: 'Apply unambiguous suggestions' })
    .click();
  let downloads = 0;
  page.on('download', () => {
    downloads++;
  });
  f.state.denied = true;
  await panel.getByRole('button', { name: 'Export RAW to JPEG CSV' }).click();
  await expect(panel.getByText('Event access unavailable.')).toBeVisible();
  await expect(
    panel.getByRole('combobox', { name: 'JPEG for IMG_02.ARW', exact: true }),
  ).toHaveCount(0);
  expect(downloads).toBe(0);
  f.state.denied = false;
  f.photos[2]!.filename = 'Edited_IMG_02.jpeg';
  await panel.getByRole('button', { name: 'Refresh event JPEGs' }).click();
  await expect(
    panel.getByText(
      'The JPEG filename changed. Choose it again to confirm the current filename.',
    ),
  ).toBeVisible();
  await panel.getByRole('button', { name: 'Export RAW to JPEG CSV' }).click();
  await expect(
    panel.getByText(
      'Review 1 unresolved or changed mappings before exporting.',
    ),
  ).toBeVisible();
  expect(downloads).toBe(0);
  await panel
    .getByRole('button', { name: 'Confirm renamed JPEG for IMG_02.ARW' })
    .click();
  const csv = await download(page, 'Export RAW to JPEG CSV');
  expect(csv).toContain('Edited_IMG_02.jpeg');
  expect(f.state.writes).toEqual([]);
});

test('RAW workspace rejects a changed account or role on the current gallery response', async ({
  page,
}) => {
  const f = await fixture(page);
  const panel = await open(page);
  f.state.responseOwner = 'other';
  await panel.getByRole('button', { name: 'Refresh event JPEGs' }).click();
  await expect(
    panel.getByText(
      'This editing workspace is unavailable for the current account.',
    ),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Choose RAW files', exact: true }),
  ).toBeDisabled();
  f.state.responseOwner = 'owner';
  f.state.responseRole = 'moderator';
  await panel.getByRole('button', { name: 'Refresh event JPEGs' }).click();
  await expect(
    panel.getByText(
      'This editing workspace is unavailable for the current account.',
    ),
  ).toBeVisible();
  expect(f.state.writes).toEqual([]);
});

test('RAW replacement can be cancelled and the same file selected again', async ({
  page,
}) => {
  await fixture(page);
  const panel = await open(page);
  const picker = panel.getByLabel('Local RAW files', { exact: true });
  await picker.setInputFiles([raw('IMG_02.ARW')]);
  await panel
    .getByRole('button', { name: 'Apply unambiguous suggestions' })
    .click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await picker.setInputFiles([raw('IMG_01.CR3')]);
  await expect(
    panel.getByRole('combobox', { name: 'JPEG for IMG_02.ARW', exact: true }),
  ).toHaveValue('jpeg-2');
  page.once('dialog', (dialog) => dialog.accept());
  await picker.setInputFiles([raw('IMG_01.CR3')]);
  await expect(
    panel.getByRole('combobox', { name: 'JPEG for IMG_01.CR3', exact: true }),
  ).toHaveValue('');
  await expect(
    panel.getByRole('combobox', { name: 'JPEG for IMG_02.ARW', exact: true }),
  ).toHaveCount(0);
});
