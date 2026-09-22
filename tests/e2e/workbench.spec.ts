import { expect, test } from '@playwright/test';
import { anonymousApi } from './anonymous';

test.beforeEach(async ({ page }) => anonymousApi(page));

test('product homepage replaces the development blueprint', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(
    page.getByRole('heading', {
      name: /Your photos\.\s*Not the whole folder\./,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Find my photos' }).first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('legacy benchmark is not exposed by product routes', async ({ page }) => {
  const models: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/models/')) models.push(request.url());
  });
  await page.goto('/benchmark');
  await expect(
    page.getByRole('heading', { name: 'A little off the beaten path.' }),
  ).toBeVisible();
  expect(models).toEqual([]);
});

test('private workspace leads to sign in', async ({ page }) => {
  await page.goto('/app');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByLabel('Email address')).toBeVisible();
});

test('mobile layout and reduced motion remain accessible', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const path of ['/', '/discover', '/events', '/privacy']) {
    await page.goto(path);
    expect(await page.locator('body').innerText()).not.toMatch(
      /[\p{Extended_Pictographic}\u2014]/u,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.goto('/');
  await expect(page.locator('.hero-logo')).toHaveCSS('animation-name', 'none');
});
