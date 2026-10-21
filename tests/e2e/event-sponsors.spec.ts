import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import sharp from 'sharp';
import { sponsorFixture } from '../fixtures/event-sponsors';
import { questionnaireOrigin } from '../fixtures/questionnaires';

async function fixture(page: Page) {
  const f = await sponsorFixture();
  const image = await sharp({
    create: { width: 64, height: 48, channels: 3, background: '#477c79' },
  })
    .jpeg()
    .toBuffer();
  f.photos.forEach((photo) => {
    Object.assign(photo, { bytes: image.length, width: 64, height: 48 });
    f.records.set(photo.id, photo);
  });
  f.store.file = async () =>
    new Response(new Uint8Array(image), {
      headers: { 'Content-Type': 'image/jpeg' },
    });
  const state = {
    actor: f.ownerId as string,
    failRead: false,
    loseReply: false,
    writes: 0,
  };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url());
    const method = incoming.method().toLowerCase() as
      'get' | 'put' | 'patch' | 'post' | 'delete';
    if (state.failRead && url.pathname === f.root && method === 'get')
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Synthetic sponsor read failure.' } },
      });
    const transport = request(f.app);
    let call = transport[method](url.pathname + url.search)
      .set('Origin', questionnaireOrigin)
      .set('Cookie', `picfind_session=${state.actor}`);
    for (const [name, value] of Object.entries(incoming.headers()))
      if (name.startsWith('x-picfind-')) call = call.set(name, value);
    if (incoming.postData()) call = call.send(JSON.parse(incoming.postData()!));
    const result = await call;
    if (url.pathname === f.root && method === 'put') {
      state.writes++;
      if (state.loseReply && result.status === 200) {
        state.loseReply = false;
        return route.fulfill({
          status: 503,
          json: { error: { message: 'Synthetic sponsor reply loss.' } },
        });
      }
    }
    await route
      .fulfill({
        status: result.status,
        contentType: result.headers['content-type'] ?? 'application/json',
        body:
          result.status === 204
            ? ''
            : Buffer.isBuffer(result.body)
              ? result.body
              : JSON.stringify(result.body),
      })
      .catch(() => {});
  });
  const open = async () => {
    await page.goto(`/app/events/${f.eventId}`);
    await page.getByRole('tab', { name: 'Sponsors', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Add sponsor', exact: true }),
    ).toBeEnabled();
  };
  const add = async (name = 'Community Camera') => {
    await page
      .getByRole('button', { name: 'Add sponsor', exact: true })
      .click();
    const group = page.getByRole('group', { name: 'Sponsor 1', exact: true });
    await group
      .getByRole('textbox', { name: 'Sponsor name', exact: true })
      .fill(name);
    await group
      .getByRole('textbox', { name: 'Sponsor caption', exact: true })
      .fill('Supporting local photographers');
    await group
      .getByRole('textbox', { name: 'Sponsor website', exact: true })
      .fill('https://example.test/community');
    await page
      .getByRole('checkbox', { name: 'Highlights gallery', exact: true })
      .check();
    await page
      .getByRole('checkbox', { name: 'Live photo wall', exact: true })
      .check();
  };
  const permit = () =>
    page
      .getByRole('checkbox', {
        name: 'I have permission to publish these sponsor details on the selected event displays.',
      })
      .check();
  return { ...f, state, open, add, permit };
}

test('owner publishes deliberate credits and guests see only the published gallery and wall snapshot', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await f.add();
  await expect(
    page.getByRole('button', { name: 'Publish sponsor credits', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Save private sponsor draft' })
    .click();
  await expect(
    page.getByText(
      'Private sponsor draft saved. Published credits are unchanged.',
    ),
  ).toBeVisible();
  expect((await f.publicRead()).body.sponsors).toBeUndefined();
  await f.permit();
  await page
    .getByRole('button', { name: 'Publish sponsor credits', exact: true })
    .click();
  await expect(
    page.getByText(
      'Sponsor credits published for the selected highlight displays.',
    ),
  ).toBeVisible();
  await page
    .getByRole('region', { name: 'Current published sponsor snapshot' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('sponsor-editor.png') });
  f.state.actor = f.clientId;
  await page.goto(`/highlights/${f.eventId}`);
  const credits = page.getByRole('region', {
    name: 'Published event sponsors',
  });
  await expect(
    credits.getByRole('heading', { name: 'Community Camera' }),
  ).toBeVisible();
  await expect(credits.getByText('Sponsor', { exact: true })).toBeVisible();
  await expect(
    credits.getByRole('link', { name: 'Visit Community Camera' }),
  ).toHaveAttribute('rel', 'noopener noreferrer sponsored');
  await credits.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath('sponsor-gallery.png'),
  });
  await page.getByRole('link', { name: 'Open photo wall' }).click();
  await expect(
    page.getByRole('region', { name: 'Published event sponsors' }),
  ).toBeVisible();
  await expect(async () => {
    await page
      .getByRole('region', { name: 'Published event sponsors' })
      .scrollIntoViewIfNeeded();
  }).toPass({ timeout: 5000 });
  await page.screenshot({ path: test.info().outputPath('sponsor-wall.png') });
});

test('saving an edited draft leaves public credits unchanged and withdrawal works with an invalid local draft', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.publish().expect(200);
  await f.open();
  const name = page.getByRole('textbox', { name: 'Sponsor name', exact: true });
  await name.fill('Private replacement');
  await page
    .getByRole('button', { name: 'Save private sponsor draft' })
    .click();
  await expect(
    page.getByText(
      'Private sponsor draft saved. Published credits are unchanged.',
    ),
  ).toBeVisible();
  expect((await f.publicRead()).body.sponsors.placements[0].name).toBe(
    'Community Camera',
  );
  await name.fill('');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Withdraw sponsor credits' }).click();
  await expect(page.getByText(/Sponsor credits withdrawn/)).toBeVisible();
  expect((await f.publicRead()).body.sponsors).toBeUndefined();
  await expect(name).toHaveValue('Private replacement');
});

test('reordering requires renewed publication permission and persists across reload', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await f.add();
  await page.getByRole('button', { name: 'Add sponsor', exact: true }).click();
  await page
    .getByRole('group', { name: 'Sponsor 2', exact: true })
    .getByRole('textbox', { name: 'Sponsor name', exact: true })
    .fill('Second studio');
  await f.permit();
  await page.getByRole('button', { name: 'Move sponsor 2 up' }).click();
  await expect(
    page.getByRole('button', { name: 'Publish sponsor credits', exact: true }),
  ).toBeDisabled();
  await f.permit();
  await page
    .getByRole('button', { name: 'Publish sponsor credits', exact: true })
    .click();
  await expect(
    page.getByText(
      'Sponsor credits published for the selected highlight displays.',
    ),
  ).toBeVisible();
  await f.open();
  await expect(
    page
      .getByRole('group', { name: 'Sponsor 1', exact: true })
      .getByRole('textbox', { name: 'Sponsor name', exact: true }),
  ).toHaveValue('Second studio');
  expect(
    (await f.publicRead()).body.sponsors.placements.map(
      (item: { name: string }) => item.name,
    ),
  ).toEqual(['Second studio', 'Community Camera']);
});

test('a committed publish with a lost reply retries without duplicate revisions', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.open();
  await f.add();
  await f.permit();
  f.state.loseReply = true;
  await page
    .getByRole('button', { name: 'Publish sponsor credits', exact: true })
    .click();
  await expect(page.getByText('Synthetic sponsor reply loss.')).toBeVisible();
  expect(f.stored().eventSponsors!.version).toBe(1);
  await page
    .getByRole('button', { name: 'Publish sponsor credits', exact: true })
    .click();
  await expect(
    page.getByText(
      'Sponsor credits published for the selected highlight displays.',
    ),
  ).toBeVisible();
  expect(f.stored().eventSponsors!.version).toBe(1);
});

test('stale drafts remain visible but cannot overwrite a newer published version', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.open();
  await page
    .getByRole('textbox', { name: 'Sponsor name', exact: true })
    .fill('Unsaved local name');
  await f.publish({ version: 1 }).expect(200);
  await page.evaluate(() =>
    window.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(
    page.getByText(
      'Sponsor settings changed or could not be refreshed. Load the latest version before saving.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Sponsor name', exact: true }),
  ).toHaveValue('Unsaved local name');
  await expect(
    page.getByRole('button', { name: 'Save private sponsor draft' }),
  ).toBeDisabled();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Load latest sponsor settings' })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Sponsor name', exact: true }),
  ).toHaveValue('Community Camera');
});

test('failed refresh blocks writes and an account change hides private sponsor fields', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.open();
  f.state.failRead = true;
  await page
    .getByRole('button', { name: 'Load latest sponsor settings' })
    .click();
  await expect(page.getByText('Synthetic sponsor read failure.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save private sponsor draft' }),
  ).toBeDisabled();
  f.state.failRead = false;
  await page
    .getByRole('button', { name: 'Load latest sponsor settings' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Save private sponsor draft' }),
  ).toBeEnabled();
  f.state.actor = f.strangerId;
  await page.evaluate(() =>
    window.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(
    page.getByRole('textbox', { name: 'Sponsor name', exact: true }),
  ).toHaveCount(0);
});

test('gallery-only placement stays off the wall and withdrawal removes displayed credits on refresh', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.publish({ fields: { ...f.sponsorFields, wall: false } }).expect(200);
  f.state.actor = f.clientId;
  await page.goto(`/highlights/${f.eventId}`);
  await expect(
    page.getByRole('region', { name: 'Published event sponsors' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Open photo wall' }).click();
  await expect(
    page.getByRole('heading', { name: 'Selected portraits' }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Published event sponsors' }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to highlights' }).click();
  await expect(
    page.getByRole('region', { name: 'Published event sponsors' }),
  ).toBeVisible();
  await f.withdraw(1).expect(200);
  await page.getByRole('button', { name: 'Refresh highlights' }).click();
  await expect(
    page.getByRole('region', { name: 'Published event sponsors' }),
  ).toHaveCount(0);
});
