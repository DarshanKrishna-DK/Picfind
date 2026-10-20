import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { prepareQrPack } from '../../apps/web/src/qr-pack';

const eventId = 'a15cfe6e-2ff0-4564-b83d-047d0eb2e673';
async function fixture(page: Page) {
  const event = {
    id: eventId,
    kind: 'event',
    ownerId: 'owner',
    accessRole: 'owner',
    title: 'Private event name',
    description: '',
    date: '',
    visibility: 'link',
    archived: false,
    expiresAt: '',
    createdAt: new Date().toISOString(),
  };
  const state = {
    event,
    galleryReads: 0,
    published: true,
    version: 1,
    role: 'owner',
    ownerId: 'owner',
    denyAt: 0,
    closeAt: 0,
    hold: false,
    downloads: 0,
    writes: [] as string[],
  };
  page.on('download', () => state.downloads++);
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
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
        json: {
          photos: [],
          events: [event],
          jobs: [],
          scans: [],
          photoLimit: 100,
        },
      });
    if (path === '/api/capabilities')
      return route.fulfill({
        json: {
          storage: true,
          faceMatching: false,
          drive: false,
          billing: false,
        },
      });
    if (path === `/api/events/${eventId}/processing`)
      return route.fulfill({
        json: { enabled: false, jobs: [] },
      });
    if (path === `/api/events/${eventId}/gallery`) {
      state.galleryReads++;
      if (state.hold) return;
      if (state.galleryReads === state.denyAt)
        return route.fulfill({
          status: 404,
          json: { error: { message: 'Event access was removed.' } },
        });
      if (state.galleryReads === state.closeAt) state.event.archived = true;
      return route.fulfill({
        json: {
          event: { ...event, accessRole: state.role, ownerId: state.ownerId },
          photos: [],
        },
      });
    }
    if (path === `/api/events/${eventId}/highlights`)
      return route.fulfill({
        json: {
          highlights: {
            title: 'Published subset',
            photoIds: ['d15cfe6e-2ff0-4564-b83d-047d0eb2e670'],
            published: state.published,
            version: state.version,
            updatedAt: event.createdAt,
          },
        },
      });
    return route.fulfill({
      status: 404,
      json: { error: { message: 'Synthetic unavailable route.' } },
    });
  });
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Sharing', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Printable QR pack' }),
  ).toBeVisible();
  return state;
}
async function downloadPack(page: Page) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Generate print pack' }).click();
  const path = await (await download).path();
  return unzipSync(await readFile(path!));
}
async function decodedPng(bytes: Uint8Array) {
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data;
}
async function inspectPrint(
  page: Page,
  html: string,
  copies: number,
  expectedTarget: string,
) {
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.emulateMedia({ media: 'print' });
  await page.setContent(html);
  await expect(page.locator('article')).toHaveCount(copies);
  await page
    .locator('article img')
    .evaluateAll(async (images) =>
      Promise.all(images.map((image) => (image as HTMLImageElement).decode())),
    );
  const images = await page.locator('article img').evaluateAll((nodes) =>
    nodes.map((node) => ({
      source: (node as HTMLImageElement).src,
      width: (node as HTMLImageElement).naturalWidth,
    })),
  );
  expect(images).toHaveLength(copies);
  for (const image of images) {
    expect(image.width).toBe(600);
    expect(image.source).toMatch(/^data:image\/png;base64,/);
    expect(
      await decodedPng(Buffer.from(image.source.split(',')[1]!, 'base64')),
    ).toBe(expectedTarget);
  }
  for (const link of await page.locator('article a').all())
    await expect(link).toHaveAttribute('href', expectedTarget);
  const size = await page.locator('.sheet').evaluate((sheet) => ({
    height: sheet.getBoundingClientRect().height,
    width: sheet.getBoundingClientRect().width,
    scrollWidth: sheet.scrollWidth,
  }));
  expect(size.height).toBeLessThanOrEqual((277 * 96) / 25.4);
  expect(size.width).toBeLessThanOrEqual((190 * 96) / 25.4 + 1);
  expect(size.scrollWidth).toBeLessThanOrEqual(Math.ceil(size.width));
}
test('downloads a decoded full-gallery print pack after two fresh access checks', async ({
  page,
  context,
}) => {
  const state = await fixture(page);
  const files = await downloadPack(page);
  const target = `${new URL(page.url()).origin}/e/${eventId}`;
  expect(Object.keys(files).sort()).toEqual([
    'destination.json',
    'instructions.txt',
    'print.html',
    'qr.png',
    'qr.svg',
  ]);
  expect(await decodedPng(files['qr.png']!)).toBe(target);
  const html = new TextDecoder().decode(files['print.html']);
  expect(html).not.toContain('Private event name');
  expect(html).toContain(target);
  expect(state.galleryReads).toBe(2);
  expect(state.writes).toEqual([]);
  await expect(
    page.getByText(
      'Local preview only. This link will not work for a guest on another device.',
    ),
  ).toBeVisible();
  const printPage = await context.newPage();
  await inspectPrint(printPage, html, 2, target);
  await printPage.close();
});
test('prepares only the published highlights destination for a private full event', async ({
  page,
}) => {
  const state = await fixture(page);
  state.event.visibility = 'private';
  await page.getByRole('button', { name: 'Generate print pack' }).click();
  await expect(
    page.getByText(
      'Enable full gallery link sharing, or choose published highlights.',
    ),
  ).toBeVisible();
  expect(state.downloads).toBe(0);
  await page.getByLabel('QR destination').selectOption('highlights');
  const files = await downloadPack(page);
  expect(await decodedPng(files['qr.png']!)).toBe(
    `${new URL(page.url()).origin}/highlights/${eventId}`,
  );
  expect(state.event.visibility).toBe('private');
  expect(state.writes).toEqual([]);
  state.published = false;
  await page.getByRole('button', { name: 'Generate print pack' }).click();
  await expect(
    page.getByText(
      'Publish a highlight selection before preparing its print pack.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Generated QR preview' }),
  ).toHaveCount(0);
  expect(state.downloads).toBe(1);
});
test('fits four maximum-text cards on A4 and keeps hostile headings inert', async ({
  page,
}, testInfo) => {
  const pack = await prepareQrPack(
    `https://${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.test`,
    {
      eventId,
      destination: 'highlights',
      heading: '活動'.repeat(40),
      instruction: '写真'.repeat(80),
      copies: 4,
    },
    new AbortController().signal,
  );
  await inspectPrint(
    page,
    new TextDecoder().decode(pack.files['print.html']),
    4,
    pack.target,
  );
  await page.screenshot({
    path: testInfo.outputPath('four-card-print.png'),
    fullPage: true,
  });
  const hostile = await prepareQrPack(
    'https://picfind.example.test',
    {
      eventId,
      destination: 'event',
      heading: '<img src=x onerror=alert(1)>',
      instruction: '</style><script>alert(1)</script>',
      copies: 1,
    },
    new AbortController().signal,
  );
  await inspectPrint(
    page,
    new TextDecoder().decode(hostile.files['print.html']),
    1,
    hostile.target,
  );
  await expect(page.getByRole('heading')).toHaveText(
    '<img src=x onerror=alert(1)>',
  );
  await expect(page.locator('script')).toHaveCount(0);
  await expect(page.getByRole('img')).toHaveCount(1);
});
test('blocks a removed owner grant or event closure during generation', async ({
  page,
}) => {
  const state = await fixture(page);
  state.denyAt = 2;
  await page.getByRole('button', { name: 'Generate print pack' }).click();
  await expect(page.getByText('Event access was removed.')).toBeVisible();
  expect(state.downloads).toBe(0);
  state.denyAt = 0;
  state.closeAt = 4;
  await page.getByRole('button', { name: 'Generate print pack' }).click();
  await expect(
    page.getByText(
      'Restore an open event before preparing a guest print pack.',
    ),
  ).toBeVisible();
  expect(state.downloads).toBe(0);
  expect(state.writes).toEqual([]);
});
test('denies moderator and changed-owner responses and can recover', async ({
  page,
}) => {
  const state = await fixture(page);
  state.role = 'moderator';
  await page.getByRole('button', { name: 'Generate print pack' }).click();
  await expect(
    page.getByText('This print pack is unavailable for the current account.'),
  ).toBeVisible();
  state.role = 'owner';
  state.ownerId = 'other';
  await page.getByRole('button', { name: 'Generate print pack' }).click();
  await expect(
    page.getByText('This print pack is unavailable for the current account.'),
  ).toBeVisible();
  expect(state.downloads).toBe(0);
  state.ownerId = 'owner';
  await downloadPack(page);
  expect(state.downloads).toBe(1);
});
test('cancels pending access validation without downloading a pack', async ({
  page,
}) => {
  const state = await fixture(page);
  state.hold = true;
  await page.getByRole('button', { name: 'Generate print pack' }).click();
  await expect.poll(() => state.galleryReads).toBe(1);
  await page.getByRole('button', { name: 'Cancel print pack' }).click();
  await expect(
    page.getByText('Generation cancelled. No new pack was downloaded.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Generate print pack' }),
  ).toBeEnabled();
  expect(state.downloads).toBe(0);
  state.hold = false;
  await downloadPack(page);
  expect(state.downloads).toBe(1);
});

test('keeps selected card counts in the generated pack and accurately reports download initiation', async ({
  page,
}) => {
  await fixture(page);
  const copies = page.getByLabel('Cards per A4 sheet');
  await expect(copies).toHaveValue('2');
  for (const count of ['1', '4']) {
    await copies.selectOption(count);
    await expect(copies).toHaveValue(count);
    const files = await downloadPack(page);
    expect(
      new TextDecoder().decode(files['print.html']).match(/<article>/g),
    ).toHaveLength(Number(count));
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Print pack download started.' }),
    ).toBeVisible();
  }
});
