import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  outputDir: './artifacts/reports/test-results',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'artifacts/reports/playwright' }],
  ],
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit-mobile', use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command:
      'node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort',
    cwd: fileURLToPath(new URL('./apps/web', import.meta.url)),
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
  },
});
