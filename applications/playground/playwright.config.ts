import { defineConfig, devices } from '@playwright/test';

import { environmentConfiguration } from './scripts/environment-configuration.ts';

// Playwright forces color in its workers and web servers. Remove the conflicting inherited
// opt-out in this test process before those children are created.
delete process.env['NO_COLOR'];

/**
 * Browser tests for the playground. The playground owns this toolchain; it is an explicit
 * command (`bun run test:browser`), not part of the turbo `test` or `validate` graph.
 *
 * The dev server (`src/playground-server.ts`) is the default target. It warms every
 * documentation bundle before it answers `/ready`, which takes minutes on a cold start, so
 * its start-up timeout is measured, not arbitrary. `PLAYGROUND_BROWSER_REUSE=1` reuses a
 * server that is already running on the port. `PLAYGROUND_BROWSER_STATIC=1` adds a second
 * project that exports the site and serves the exported files.
 */
const environment = environmentConfiguration();
const devPort = Number(environment.browserPort ?? 54231);
const staticPort = Number(environment.browserStaticPort ?? 54232);
const devOrigin = `http://127.0.0.1:${devPort}`;
const staticOrigin = `http://127.0.0.1:${staticPort}`;
const includeStatic = environment.browserStatic;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.playwright.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'bun src/playground-server.ts',
      cwd: import.meta.dirname,
      env: { PORT: String(devPort) },
      url: `${devOrigin}/ready`,
      reuseExistingServer: environment.browserReuse,
      timeout: 360_000,
    },
    ...(includeStatic
      ? [
          {
            command: `PLAYGROUND_BASE_URL=https://playground.test bun scripts/static-export.ts && bun scripts/serve-static-export.ts --port ${staticPort}`,
            cwd: import.meta.dirname,
            url: `${staticOrigin}/ping`,
            reuseExistingServer: environment.browserReuse,
            timeout: 900_000,
          },
        ]
      : []),
  ],
  projects: [
    {
      name: 'dev',
      use: { ...devices['Desktop Chrome'], baseURL: devOrigin },
    },
    ...(includeStatic
      ? [
          {
            name: 'static',
            testMatch: '**/theme-builder-preview.playwright.ts',
            use: { ...devices['Desktop Chrome'], baseURL: staticOrigin },
          },
        ]
      : []),
  ],
});
