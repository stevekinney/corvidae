import { defineConfig, devices } from '@playwright/test';

import { isContinuousIntegration } from './scripts/environment-configuration.ts';
import { E2E_BASE_URL } from './tests/e2e/e2e-constants.ts';

const continuousIntegration = isContinuousIntegration();

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: continuousIntegration ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: E2E_BASE_URL, reducedMotion: 'reduce' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `bun ${new URL('./tests/e2e/e2e-server.ts', import.meta.url).pathname}`,
    url: E2E_BASE_URL,
    reuseExistingServer: !continuousIntegration,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
