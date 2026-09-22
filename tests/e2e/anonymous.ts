import type { Page } from '@playwright/test';

// Public UI tests must not depend on a running API or live cloud credentials.
export async function anonymousApi(page: Page) {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('capabilities'))
      return route.fulfill({
        json: {
          google: false,
          storage: false,
          drive: false,
          billing: false,
          faceMatching: false,
          photoLimit: 20,
        },
      });
    if (path.includes('plans')) return route.fulfill({ json: { plans: [] } });
    return route.fulfill({
      status: 401,
      json: { error: { message: 'Sign in to continue.' } },
    });
  });
}
