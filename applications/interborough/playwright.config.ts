import { defineConfig, devices } from '@playwright/test';

import { TEST_TIMEOUT_MILLISECONDS } from '../../scripts/test-deadlines.ts';
import { HANG_GUARD_MILLISECONDS } from '../../testing/testing/src/hang-guard.ts';
import { isContinuousIntegration } from './scripts/environment-configuration.ts';
import { E2E_BASE_URL } from './tests/e2e/e2e-constants.ts';

const continuousIntegration = isContinuousIntegration();

export default defineConfig({
  testDir: './tests',
  testMatch: ['e2e/**/*.spec.ts', 'mcp-apps/**/*.spec.ts'],
  // The one deadline every blocking test shares (`scripts/test-deadlines.ts`): the hang guard for a
  // wait and twice that for a test, never a performance bound a busy host can overrun. A spec that
  // names a shorter one fails `scripts/check-load-sensitive-deadlines.ts`.
  timeout: TEST_TIMEOUT_MILLISECONDS,
  expect: { timeout: HANG_GUARD_MILLISECONDS },
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
    // Without this, Playwright SIGKILLs the server, so its SIGTERM handler never removes the
    // `interborough-e2e-*` scratch directory (a build and four homes) and every run leaks it.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
