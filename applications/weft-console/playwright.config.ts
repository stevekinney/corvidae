import { defineConfig, devices } from '@playwright/test';

import { E2E_BASE_URL, E2E_CONSOLE_PORT, E2E_SERVER_PORT } from './tests/e2e/e2e-constants.ts';

// Playwright sets FORCE_COLOR for children; remove the conflicting inherited opt-out.
delete process.env['NO_COLOR'];

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: process.env['CI'] ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: E2E_BASE_URL,
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'bun tests/e2e/e2e-server.ts',
      port: E2E_SERVER_PORT,
      reuseExistingServer: !process.env['CI'],
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `bun run dev -- --port ${E2E_CONSOLE_PORT}`,
      url: E2E_BASE_URL,
      reuseExistingServer: !process.env['CI'],
      env: { WEFT_API_BASE_URL: `http://localhost:${E2E_SERVER_PORT}` },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
