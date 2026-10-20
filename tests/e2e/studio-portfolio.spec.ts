import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import request from 'supertest';
import { portfolioFixture } from '../fixtures/studio-portfolio';
import { questionnaireOrigin } from '../fixtures/questionnaires';

async function fixture(page: Page) {
  const f = await portfolioFixture();
  const state = {
    actor: f.ownerId as string,
    loseReply: false,
    failRead: false,
  };
  await page.route('**/api/**', async (route) => {
    const incoming = route.request(),
      url = new URL(incoming.url());
    const method = incoming.method().toLowerCase() as
      'get' | 'put' | 'post' | 'delete' | 'patch' | 'head';
    if (state.failRead && method === 'get' && url.pathname === f.root)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Synthetic portfolio read failure.' },
        }),
      });
    const client = request(f.app);
    let call = client[method](url.pathname + url.search).set(
      'Origin',
      questionnaireOrigin,
    );
    if (state.actor)
      call = call.set('Cookie', `picfind_session=${state.actor}`);
    const actor = incoming.headers()['x-picfind-portfolio-actor'];
    if (actor) call = call.set('X-PicFind-Portfolio-Actor', actor);
    if (incoming.postData()) call = call.send(JSON.parse(incoming.postData()!));
    const response = await call;
    if (state.loseReply && method === 'put' && response.status === 200) {
      state.loseReply = false;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'Synthetic saved reply loss.' },
        }),
      });
    }
    const image = response.headers['content-type']?.includes('image/');
    await route
      .fulfill({
        status: response.status,
        contentType: response.headers['content-type'] ?? 'application/json',
        body: image
          ? response.body
          : response.status === 204
            ? ''
            : JSON.stringify(response.body),
      })
      .catch(() => {});
  });
  page.on('dialog', (dialog) => void dialog.accept());
  const open = async () => {
    await page.goto('/app/portfolio');
    await expect(
      page.getByLabel('Display name', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Save private draft', exact: true }),
    ).toBeEnabled();
  };
  const consent = () =>
    page
      .getByRole('checkbox', {
        name: 'I have permission to publish these photographs and profile details for anyone to view and save.',
        exact: true,
      })
      .check();
  const publish = async () => {
    await consent();
    await page
      .getByRole('button', { name: 'Publish portfolio', exact: true })
      .click();
    await expect(page.getByRole('status')).toHaveText('Portfolio published.');
  };
  return { ...f, state, open, consent, publishUi: publish };
}
test('prepares a private portfolio and explicitly publishes ordered photos for anonymous visitors', async ({
  page,
}, info) => {
  const f = await fixture(page);
  await f.open();
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Asha Photography');
  await page
    .getByLabel('Tagline', { exact: true })
    .fill('Portraits and celebrations');
  await page
    .getByRole('textbox', { name: 'Biography', exact: true })
    .fill('Carefully chosen moments.');
  for (const photo of f.photos.slice(0, 2))
    await page
      .getByRole('button', {
        name: `Add photograph: ${photo.filename}`,
        exact: true,
      })
      .click();
  await page.getByLabel('Caption 1', { exact: true }).fill('First portrait');
  await page.getByLabel('Caption 2', { exact: true }).fill('Second portrait');
  await page
    .getByRole('button', { name: 'Move photograph 2 earlier', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Save private draft', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText(
    'Private draft saved. The published page is unchanged.',
  );
  await f.publicRead().expect(404);
  await page.locator('.portfolio-fields').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('portfolio-editor.png'),
    fullPage: false,
  });
  expect(
    await page
      .locator('.workspace-content')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await f.publishUi();
  expect(f.stored().studioPortfolio!.published!.fields.photos[0]!.id).toBe(
    f.photos[1]!.id,
  );
  f.state.actor = '';
  await page.goto(`/portfolio/${f.id}`);
  await expect(
    page.getByRole('heading', { name: 'Asha Photography', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.portfolio-public-gallery figure').first(),
  ).toContainText('Second portrait');
  await expect
    .poll(() =>
      page
        .locator('.portfolio-public-gallery img')
        .first()
        .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBe(64);
  await expect(
    page.getByText('Private portrait session', { exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('public-portfolio.png'),
    fullPage: true,
  });
});
test('keeps edited profile details private until republished and clears consent after every draft edit', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.publish().expect(200);
  await f.open();
  await f.consent();
  await page
    .getByLabel('Tagline', { exact: true })
    .fill('Private future tagline');
  await expect(
    page.getByRole('button', { name: 'Publish portfolio', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Save private draft', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Private draft saved');
  expect((await f.publicRead().expect(200)).body.tagline).toBe(
    f.fields.tagline,
  );
  await f.publishUi();
  expect((await f.publicRead().expect(200)).body.tagline).toBe(
    'Private future tagline',
  );
});
test('recovers a lost publication reply without changing identity or issuing another revision', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.open();
  await f.consent();
  f.state.loseReply = true;
  await page
    .getByRole('button', { name: 'Publish portfolio', exact: true })
    .click();
  await expect(page.getByText('Synthetic saved reply loss.')).toBeVisible();
  await page
    .getByRole('button', { name: 'Publish portfolio', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText('Portfolio published.');
  expect(f.stored().studioPortfolio!.version).toBe(2);
  expect(
    [...f.records.values()].filter((row) => row.purpose === 'studio-portfolio'),
  ).toHaveLength(1);
});
test('preserves a conflicting draft until the owner explicitly loads the newer saved version', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.open();
  await page.getByLabel('Tagline', { exact: true }).fill('Keep my draft');
  await f
    .save({
      version: 1,
      fields: { ...f.fields, tagline: 'Another saved revision' },
    })
    .expect(200);
  await page
    .getByRole('button', { name: 'Save private draft', exact: true })
    .click();
  await expect(
    page.getByText(
      'The saved portfolio changed or could not be refreshed. Your draft is preserved. Load the latest version before saving.',
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Tagline', { exact: true })).toHaveValue(
    'Keep my draft',
  );
  await page
    .getByRole('button', { name: 'Load latest portfolio', exact: true })
    .click();
  await expect(page.getByLabel('Tagline', { exact: true })).toHaveValue(
    'Another saved revision',
  );
});
test('retains drafts after a failed refresh and hides private data after an account switch', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.save().expect(200);
  await f.open();
  await page
    .getByLabel('Tagline', { exact: true })
    .fill('Unsaved local tagline');
  f.state.failRead = true;
  await page
    .getByRole('button', { name: 'Load latest portfolio', exact: true })
    .click();
  await expect(
    page.getByText('Synthetic portfolio read failure.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Save private draft', exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel('Tagline', { exact: true })).toHaveValue(
    'Unsaved local tagline',
  );
  f.state.failRead = false;
  f.state.actor = f.strangerId;
  await page
    .getByRole('button', { name: 'Load latest portfolio', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Portfolio unavailable', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Display name', { exact: true })).toHaveCount(0);
});
test('withdraws a live portfolio even when the unsaved draft has an empty name', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.publish().expect(200);
  await f.open();
  await page.getByLabel('Display name', { exact: true }).fill('');
  await page
    .getByRole('button', { name: 'Withdraw portfolio', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText(
    'Portfolio withdrawn. Your saved draft is retained.',
  );
  await expect(page.getByLabel('Display name', { exact: true })).toHaveValue(
    f.fields.name,
  );
  await f.publicRead().expect(404);
  f.state.actor = '';
  await page.goto(`/portfolio/${f.id}`);
  await expect(
    page.getByRole('heading', { name: 'Portfolio unavailable', exact: true }),
  ).toBeVisible();
});
test('allows removal of unavailable draft photographs before republishing', async ({
  page,
}) => {
  const f = await fixture(page);
  await f.publish().expect(200);
  f.records.delete(f.photos[0]!.id);
  await f.open();
  await expect(
    page.getByText('Unavailable photograph. Remove it before publishing.'),
  ).toBeVisible();
  await f.consent();
  await expect(
    page.getByRole('button', { name: 'Publish portfolio', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Remove photograph 1', exact: true })
    .click();
  await f.publishUi();
  expect((await f.publicRead().expect(200)).body.photos).toHaveLength(1);
});
test('browses later library pages and keeps selected photos when searching', async ({
  page,
}) => {
  const f = await fixture(page);
  for (let i = 0; i < 42; i++) {
    const photo = {
      ...f.photos[0]!,
      id: randomUUID(),
      filename: `Additional ${i}.jpg`,
    };
    f.records.set(photo.id, photo);
  }
  await f.open();
  await expect(
    page.getByText('45 available photographs match this search.', {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Next photographs', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /^Add photograph:/ }),
  ).toHaveCount(5);
  await page
    .getByRole('button', { name: /^Add photograph:/ })
    .first()
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Selected photographs (1/24)',
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel('Search available photographs', { exact: true })
    .fill('no-photo-match');
  await expect(
    page.getByText('0 available photographs match this search.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel('Caption 1', { exact: true })).toBeVisible();
});
