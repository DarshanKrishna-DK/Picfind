import { expect, test } from '@playwright/test';
import { anonymousApi } from './anonymous';

test.beforeEach(async ({ page }) => anonymousApi(page));

test('public site navigation, responsive layout, and unsupported plans are truthful', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await expect(
    page.getByRole('heading', {
      name: /Your photos\.\s*Not the whole folder\./,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole('link', { name: 'Find my photos' }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('home.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('link', { name: 'Find my photos' }).first().click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByLabel('Email address')).toBeVisible();
  await page.goto('/pricing');
  await expect(
    page.getByRole('heading', {
      name: /Find your photos.*Or host the whole event/s,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('No payment details are collected here.'),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await expect(
    page.getByRole('link', { name: 'Find my photos' }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('home-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
});
