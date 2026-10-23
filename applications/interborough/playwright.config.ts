import { defineConfig, devices } from '@playwright/test';

import { isContinuousIntegration } from './scripts/environment-configuration.ts';
import { E2E_BASE_URL } from './tests/e2e/e2e-constants.ts';

const continuousIntegration = isContinuousIntegration();

export default defineConfig({
  testDir: './tests',
  testMatch: ['e2e/**/*.spec.ts', 'mcp-apps/**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  reporter: continuousIntegration ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: E2E_BASE_URL, reducedMotion: 'reduce' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `bun ${new URL('./tests/e2e/e2e-server.ts', import.meta.url).pathname}`,
    // The host answers requests as soon as it listens, but `e2e-server.ts` seeds the ledger evidence
    // after that and prints this line only once every seed has settled. Readiness is that line
    // alone, not a URL that answers earlier, so a spec never reads a half-seeded server.
    wait: { stdout: /Interborough E2E host listening/ },
    reuseExistingServer: !continuousIntegration,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
