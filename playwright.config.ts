// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['iPhone 15'], defaultBrowserType: 'chromium' } }],
  webServer: {
    command: 'npm run build && python3 -m http.server 4173 --bind 127.0.0.1',
    url: 'http://127.0.0.1:4173/dist-pwa/', reuseExistingServer: !process.env.CI, timeout: 120_000,
  },
});
