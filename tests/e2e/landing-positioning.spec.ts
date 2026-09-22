import { expect, test } from '@playwright/test';

for (const width of [1280, 390]) {
  test(`personal discovery positioning is clear and contained at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await page.route('**/api/**', (route) =>
      route.fulfill({
        status: 401,
        json: {
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Synthetic anonymous visitor',
          },
        },
      }),
    );
    await page.goto('/');
    const row = page
      .getByRole('row')
      .filter({ hasText: 'Find your photos without hosting an event' });
    await expect(row).toContainText(
      'Personal Discover with one-time packs; no organizer subscription needed',
    );
    const question = page
      .locator('summary')
      .filter({ hasText: 'Do I need an organizer to find my photos?' });
    await question.click();
    await expect(
      page.getByText(
        /No\. Sign in and use Discover with a folder you can access/,
      ),
    ).toBeVisible();
    await expect(
      page.getByText(/its organizer covers the event usage instead/),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
