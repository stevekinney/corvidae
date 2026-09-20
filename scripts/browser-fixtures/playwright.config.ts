import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { environmentConfiguration } from './environment-configuration.ts';
import { FIXTURE_ORIGIN, FIXTURE_PORT } from './scripts/fixture-port.ts';

// Playwright forces color in its workers and web servers. Remove the conflicting
// inherited opt-out in this test process before those children are created.
delete process.env['NO_COLOR'];

const isPreview = environmentConfiguration().fixtureHostMode === 'preview';
process.env['BROWSER_FIXTURE_URL'] = FIXTURE_ORIGIN;
process.env['BROWSER_FIXTURE_MANIFEST'] ??= resolve(
  import.meta.dirname,
  '.playwright',
  'manifest.json',
);

export default defineConfig({
  testDir: './tests',
  snapshotPathTemplate: '{testDir}/../snapshots/{projectName}/{platform}/{arg}{ext}',
  testMatch: '**/*.{spec,playwright}.ts',
  timeout: 30_000,
  use: { baseURL: FIXTURE_ORIGIN, trace: 'retain-on-failure' },
  webServer: {
    command: isPreview
      ? `bun scripts/build.ts && bun scripts/serve.ts --preview --port ${FIXTURE_PORT}`
      : `bun --watch scripts/serve.ts --port ${FIXTURE_PORT}`,
    cwd: import.meta.dirname,
    url: `${FIXTURE_ORIGIN}/ready`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'firefox-keyboard',
      testMatch: '**/keyboard-scroll.playwright.ts',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit-keyboard',
      testMatch: '**/keyboard-scroll.playwright.ts',
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
