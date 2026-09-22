import type { Page } from '@playwright/test';

export async function chooseMenu(page: Page, name: string, option: string) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
