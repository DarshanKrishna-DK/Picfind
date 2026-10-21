import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: ['**/project-brief.spec.ts', '**/enquiry-report.spec.ts'],
  outputDir: './artifacts/reports/production-test-results',
  reporter: [
    ['list'],
    [
      'html',
      {
        open: 'never',
        outputFolder: 'artifacts/reports/production-playwright',
      },
    ],
  ],
  use: { ...base.use, baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command:
      'node ../../node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort',
    cwd: fileURLToPath(new URL('./apps/web', import.meta.url)),
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});
