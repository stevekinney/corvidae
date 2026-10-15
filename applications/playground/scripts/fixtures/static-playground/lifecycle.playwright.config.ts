/**
 * Playwright configuration for the real-Chromium lifecycle check
 * (`scripts/static-playground-browser-lifecycle.check.ts`). It runs one test that keeps a browser
 * page open until the runner is interrupted. Timeouts are Playwright's defaults; retries are zero.
 */
import { defineConfig, devices } from '@playwright/test';

import { readEnvironmentConfiguration } from '../../../src/environment-configuration.ts';

const environment = readEnvironmentConfiguration();

export default defineConfig({
  testDir: '.',
  testMatch: 'lifecycle.playwright.ts',
  outputDir: environment.playgroundStaticScratch ?? './lifecycle-output',
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], baseURL: environment.playgroundStaticBaseUrl },
});
