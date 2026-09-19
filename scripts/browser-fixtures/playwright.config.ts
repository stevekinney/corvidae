import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { environmentConfiguration } from './environment-configuration.ts';

// Playwright forces color in its workers and web servers. Remove the conflicting
// inherited opt-out in this test process before those children are created.
delete process.env['NO_COLOR'];

const isPreview = environmentConfiguration().fixtureHostMode === 'preview';
const port = isPreview ? 5578 : 5577;
process.env['BROWSER_FIXTURE_URL'] ??= `http://127.0.0.1:${port}`;
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
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  webServer: {
    command: isPreview
      ? 'bun scripts/build.ts && bun scripts/serve.ts --preview --port 5578'
      : 'bun --watch scripts/serve.ts --port 5577',
    cwd: import.meta.dirname,
    url: `http://127.0.0.1:${port}/ready`,
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
