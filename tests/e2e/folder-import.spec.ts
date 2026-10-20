import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import sharp from 'sharp';
import { creditFixture } from '../fixtures/credit-presets';
import { questionnaireOrigin } from '../fixtures/questionnaires';
import { uploadQueueKey } from '../../packages/shared/src/upload-queue';

type Input = { path: string; bytes: string; type: string };
async function choose(page: Page, inputs: Input[]) {
  // Synthetic browser Files exercise directory descriptors without reading user files.
  await page
    .getByLabel('Select folder for import')
    .evaluate((element, rows) => {
      const transfer = new DataTransfer();
      for (const row of rows) {
        const bytes = Uint8Array.from(atob(row.bytes), (char) =>
          char.charCodeAt(0),
        );
        const file = new File([bytes], row.path.split('/').at(-1)!, {
          type: row.type,
        });
        Object.defineProperty(file, 'webkitRelativePath', { value: row.path });
        transfer.items.add(file);
      }
      (element as HTMLInputElement).files = transfer.files;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, inputs);
}
async function fixture(page: Page) {
  const f = creditFixture();
  f.photos.forEach((row) => f.records.delete(row.id));
  const stored = new Map<string, Uint8Array>();
  f.store.upload = async (id, bytes) => {
    stored.set(id, bytes);
  };
  f.store.removeFile = async (id) => {
    stored.delete(id);
  };
  f.store.file = async (id) =>
    new Response(new Uint8Array(stored.get(id) ?? []), {
      headers: { 'Content-Type': 'image/jpeg' },
    });
  const colors = await Promise.all(
    ['#345678', '#876543'].map((background) =>
      sharp({ create: { width: 32, height: 24, channels: 3, background } })
        .jpeg()
        .toBuffer(),
    ),
  );
  const inputs: Input[] = [
    {
      path: 'Wedding/Ceremony/same.jpg',
      bytes: colors[0]!.toString('base64'),
      type: 'image/jpeg',
    },
    {
      path: 'Wedding/Portraits/same.jpg',
      bytes: colors[1]!.toString('base64'),
      type: 'image/jpeg',
    },
    {
      path: 'Wedding/Portraits/copy.jpg',
      bytes: colors[0]!.toString('base64'),
      type: 'image/jpeg',
    },
    {
      path: 'Wedding/Portraits/original.raw',
      bytes: Buffer.from('synthetic raw').toString('base64'),
      type: '',
    },
  ];
  const bodies: Buffer[] = [];
  const state = {
    actor: f.ownerId as string,
    uploads: 0,
    mappings: 0,
    loseMapping: false,
    failUpload: false,
    holdUpload: false,
    release: null as (() => void) | null,
  };
  await page.exposeFunction('observeFolderUpload', (bytes: number[]) => {
    bodies.push(Buffer.from(bytes));
  });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      if (
        typeof input === 'string' &&
        input.startsWith('/api/photos') &&
        options?.body instanceof Blob
      )
        await (
          window as unknown as {
            observeFolderUpload: (bytes: number[]) => Promise<void>;
          }
        ).observeFolderUpload([
          ...new Uint8Array(await options.body.arrayBuffer()),
        ]);
      return original(input, options);
    };
  });
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url()),
      method = incoming.method().toLowerCase() as
        'get' | 'post' | 'put' | 'patch' | 'delete';
    const upload = method === 'post' && url.pathname === '/api/photos';
    const mapping = method === 'put' && url.pathname.endsWith('/import');
    let call = request(f.app)[method](url.pathname + url.search);
    call = call
      .set('Origin', questionnaireOrigin)
      .set('Cookie', `picfind_session=${state.actor}`);
    const headers = incoming.headers();
    if (headers['x-picfind-upload-actor'])
      call = call.set(
        'X-PicFind-Upload-Actor',
        headers['x-picfind-upload-actor'],
      );
    if (upload) {
      state.uploads++;
      const bytes = bodies.shift();
      if (!bytes) throw new Error('Synthetic upload body missing.');
      if (state.failUpload) {
        state.failUpload = false;
        return route.fulfill({
          status: 409,
          json: { error: { message: 'Synthetic capacity pause.' } },
        });
      }
      call = call
        .set('Content-Type', 'application/octet-stream')
        .set('X-File-Name', headers['x-file-name'] ?? '')
        .send(bytes);
    } else if (incoming.postData())
      call = call.send(JSON.parse(incoming.postData()!));
    if (mapping) state.mappings++;
    const result = await call;
    if (upload && state.holdUpload) {
      state.holdUpload = false;
      await new Promise<void>((resolve) => {
        state.release = resolve;
      });
    }
    if (mapping && state.loseMapping && result.status === 201) {
      state.loseMapping = false;
      return route.fulfill({
        status: 503,
        json: {
          error: { message: 'Synthetic committed collection reply loss.' },
        },
      });
    }
    await route
      .fulfill({
        status: result.status,
        contentType: 'application/json',
        body: result.status === 204 ? '' : JSON.stringify(result.body),
      })
      .catch(() => {});
  });
  const open = async (personal = false) => {
    await page.goto(`/app/import${personal ? '' : `?eventId=${f.eventId}`}`);
    await expect(
      page
        .getByRole('region', { name: 'Folder import plan' })
        .getByRole('button', { name: 'Choose a folder', exact: true }),
    ).toBeEnabled();
  };
  const collections = () =>
    [...f.records.values()].filter(
      (row) => row.purpose === 'proofing-collection',
    );
  return { ...f, inputs, state, open, stored, collections };
}
function panel(page: Page) {
  return page.getByRole('region', { name: 'Folder import plan' });
}
async function prepare(page: Page, inputs: Input[], map = true) {
  await choose(page, inputs);
  if (map)
    for (const box of await panel(page)
      .getByRole('checkbox', { name: 'Create a private proofing collection' })
      .all())
      await box.check();
  await panel(page)
    .getByRole('button', { name: 'Save reviewed folder plan' })
    .click();
  await expect(panel(page).getByText(/Queue: paused/)).toBeVisible();
}
async function run(page: Page) {
  await panel(page)
    .getByRole('button', { name: 'Start or resume folder upload' })
    .click();
  await expect(panel(page).getByText(/Queue: complete/)).toBeVisible();
}

test('reviews nested folders, uploads unique bytes and deliberately maps exact private collections', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await f.open();
  await choose(page, f.inputs);
  await expect(
    panel(page).getByText(/4 files inspected. 1 excluded. 3 supported/),
  ).toBeVisible();
  await panel(page).getByText('Inspect file report', { exact: true }).click();
  await expect(panel(page).getByText(/Unsupported file type/)).toBeVisible();
  expect(f.state.uploads).toBe(0);
  for (const box of await panel(page)
    .getByRole('checkbox', { name: 'Create a private proofing collection' })
    .all())
    await box.check();
  await panel(page)
    .getByRole('button', { name: 'Save reviewed folder plan' })
    .click();
  await expect(
    panel(page).getByText('0 of 2 uploads acknowledged. Queue: paused.'),
  ).toBeVisible();
  expect(f.state.uploads).toBe(0);
  await run(page);
  expect(f.state.uploads).toBe(2);
  expect(f.stored.size).toBe(2);
  expect(f.collections()).toHaveLength(0);
  await panel(page)
    .getByRole('button', { name: 'Create or verify folder collections' })
    .click();
  await expect(
    panel(page).getByText(/Folder collections confirmed/),
  ).toBeVisible();
  const rows = f.collections();
  expect(rows).toHaveLength(2);
  expect(
    rows.find((row) => row.title === 'Ceremony')!.selectedIds,
  ).toHaveLength(1);
  expect(
    rows.find((row) => row.title === 'Portraits')!.selectedIds,
  ).toHaveLength(2);
  expect(rows.every((row) => row.collectionVersion === 1)).toBe(true);
  await page.locator('.workspace-content').evaluate((element) => {
    const folder = element.querySelector('.folder-import')!;
    element.scrollTop +=
      folder.getBoundingClientRect().top - element.getBoundingClientRect().top;
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('folder-import.png'),
    fullPage: true,
  });
  await page.reload();
  await expect(
    panel(page).getByText(/2 of 2 uploads acknowledged/),
  ).toBeVisible();
  await panel(page)
    .getByRole('button', { name: 'Create or verify folder collections' })
    .click();
  await expect(
    panel(page).getByText(/Folder collections confirmed/),
  ).toBeVisible();
  expect(f.collections()).toHaveLength(2);
  page.once('dialog', (dialog) => dialog.accept());
  await panel(page)
    .getByRole('button', { name: 'Clear saved folder plan' })
    .click();
  await expect(
    panel(page).getByText(/Saved folder plan cleared/),
  ).toBeVisible();
  expect(f.stored.size).toBe(2);
  expect(f.collections()).toHaveLength(2);
});

test('excludes an unchecked folder and keeps collection creation off by default', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await choose(page, f.inputs);
  await panel(page)
    .getByRole('group', { name: 'Wedding/Portraits', exact: true })
    .getByRole('checkbox', { name: 'Include folder' })
    .uncheck();
  await panel(page)
    .getByRole('button', { name: 'Save reviewed folder plan' })
    .click();
  await run(page);
  expect(f.state.uploads).toBe(1);
  expect(f.collections()).toHaveLength(0);
  await expect(
    panel(page).getByRole('button', {
      name: 'Create or verify folder collections',
    }),
  ).toHaveCount(0);
});

test('retains the reviewed paths and collection identities across reload and renamed reselection', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await prepare(page, f.inputs);
  await page.reload();
  await expect(
    panel(page).getByText(/0 unfinished originals attached/),
  ).toBeVisible();
  await expect(
    panel(page).getByRole('button', { name: 'Start or resume folder upload' }),
  ).toBeDisabled();
  await choose(
    page,
    f.inputs
      .slice(0, 2)
      .map((row, i) => ({ ...row, path: `Reselected/renamed-${i}.jpg` })),
  );
  await expect(
    panel(page).getByText(/2 unfinished originals attached/),
  ).toBeVisible();
  await run(page);
  await panel(page)
    .getByRole('button', { name: 'Create or verify folder collections' })
    .click();
  await expect(
    panel(page).getByText(/Folder collections confirmed/),
  ).toBeVisible();
  expect(
    f
      .collections()
      .map((row) => row.title)
      .sort(),
  ).toEqual(['Ceremony', 'Portraits']);
  expect(
    [...f.records.values()]
      .filter((row) => row.kind === 'photo')
      .every((row) => row.filename === 'same.jpg'),
  ).toBe(true);
});

test('recovers a committed collection reply loss without duplicating or replacing the collection', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await prepare(page, f.inputs);
  await run(page);
  f.state.loseMapping = true;
  await panel(page)
    .getByRole('button', { name: 'Create or verify folder collections' })
    .click();
  await expect(
    panel(page).getByText(/Collection mapping stopped/),
  ).toBeVisible();
  expect(f.collections()).toHaveLength(1);
  const committed = structuredClone(f.collections()[0]);
  await panel(page)
    .getByRole('button', { name: 'Create or verify folder collections' })
    .click();
  await expect(
    panel(page).getByText(/Folder collections confirmed/),
  ).toBeVisible();
  expect(f.collections()).toHaveLength(2);
  expect(f.records.get(committed!.id)).toEqual(committed);
});

test('pauses an ambiguous upload and recovers the committed image before continuing', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await prepare(page, f.inputs);
  f.state.holdUpload = true;
  await panel(page)
    .getByRole('button', { name: 'Start or resume folder upload' })
    .click();
  await expect.poll(() => f.stored.size).toBe(1);
  await panel(page)
    .getByRole('button', { name: 'Pause folder upload' })
    .click();
  f.state.release?.();
  await expect(panel(page).getByText(/Queue: paused/)).toBeVisible();
  expect(f.state.uploads).toBe(1);
  await run(page);
  expect(f.state.uploads).toBe(3);
  expect(f.stored.size).toBe(2);
});

test('a changed server account stops uploads and hides the prior folder details', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await prepare(page, f.inputs);
  f.state.actor = f.clientId;
  await panel(page)
    .getByRole('button', { name: 'Start or resume folder upload' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Folder import paused' }),
  ).toBeVisible();
  await expect(page.getByText('Wedding/Ceremony', { exact: true })).toHaveCount(
    0,
  );
  expect(f.stored.size).toBe(0);
  expect(f.state.uploads).toBe(1);
});

test('personal folder imports never create event collection mappings', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open(true);
  await prepare(page, f.inputs, false);
  await run(page);
  await expect(
    panel(page).getByRole('button', {
      name: 'Create or verify folder collections',
    }),
  ).toHaveCount(0);
  expect(
    [...f.records.values()]
      .filter((row) => row.kind === 'photo')
      .every((row) => !row.eventId),
  ).toBe(true);
});

test('invalid and oversized plans remain local with no upload, and a corrected selection can proceed', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await choose(page, [f.inputs[0]!, f.inputs[0]!]);
  await expect(panel(page).getByText(/duplicate relative paths/)).toBeVisible();
  await choose(
    page,
    Array.from({ length: 101 }, (_, i) => ({
      ...f.inputs[0]!,
      path: `Root/${i}.jpg`,
    })),
  );
  await expect(
    panel(page).getByRole('button', { name: 'Save reviewed folder plan' }),
  ).toBeDisabled();
  expect(f.state.uploads).toBe(0);
  await prepare(page, [f.inputs[0]!], false);
  await run(page);
  expect(f.state.uploads).toBe(1);
});

test('a lock held by another tab prevents collection mapping until released', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await prepare(page, f.inputs);
  await run(page);
  const second = await page.context().newPage();
  await second.route('**/folder-lock-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<title>Queue lock fixture</title>',
    }),
  );
  await second.goto('http://127.0.0.1:5173/folder-lock-test');
  await second.evaluate(
    (key) =>
      new Promise<void>((ready) => {
        void navigator.locks.request(key, async () => {
          await new Promise<void>((release) => {
            (
              window as unknown as { releaseFolderLock: () => void }
            ).releaseFolderLock = release;
            ready();
          });
        });
      }),
    uploadQueueKey(f.ownerId, f.eventId, true),
  );
  await panel(page)
    .getByRole('button', { name: 'Create or verify folder collections' })
    .click();
  await expect(panel(page).getByText(/active in another tab/)).toBeVisible();
  expect(f.state.mappings).toBe(0);
  await second.close();
  await panel(page)
    .getByRole('button', { name: 'Create or verify folder collections' })
    .click();
  await expect(
    panel(page).getByText(/Folder collections confirmed/),
  ).toBeVisible();
  expect(f.collections()).toHaveLength(2);
});

test('a changed saved manifest cannot be mapped from an older on-screen plan', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await prepare(page, f.inputs);
  await run(page);
  await page.evaluate(
    (key) => localStorage.removeItem(key),
    uploadQueueKey(f.ownerId, f.eventId, true),
  );
  await panel(page)
    .getByRole('button', { name: 'Create or verify folder collections' })
    .click();
  await expect(
    panel(page).getByText(/saved folder plan changed/),
  ).toBeVisible();
  expect(f.state.mappings).toBe(0);
  expect(f.collections()).toHaveLength(0);
});
