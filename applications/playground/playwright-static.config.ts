/**
 * Browser configuration for the static production gate.
 *
 * `scripts/check-static-playground.ts` is the only caller. It serves `build/`, writes this run's
 * case list, and passes every location below through the environment, so this file never starts a
 * server of its own. Timeouts are Playwright's defaults and retries are zero on purpose: a case
 * that needs either is a defect to fix, not a budget to raise.
 */
import { defineConfig, devices } from '@playwright/test';

import { readEnvironmentConfiguration } from './src/environment-configuration.ts';

const environment = readEnvironmentConfiguration();

export default defineConfig({
  testDir: './tests',
  testMatch: 'playground-production.playwright.ts',
  outputDir: environment.playgroundStaticScratch ?? './production-gate-results/scratch',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['./tests/static-playground-reporter.ts']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: environment.playgroundStaticBaseUrl,
    trace: 'off',
    screenshot: 'off',
  },
});
