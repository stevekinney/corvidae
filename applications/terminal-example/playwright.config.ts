import { defineConfig, devices } from '@playwright/test';

import { EXAMPLE_ORIGIN, EXAMPLE_PORT, START_TOKEN } from './tests/origin.ts';

// Playwright forces color in its workers and web servers. Remove the conflicting inherited opt-out
// in this test process before those children are created.
delete process.env['NO_COLOR'];

/**
 * Browser checks for the terminal example. They run against the built application served from
 * loopback by the real server, so they need `bun run build` first; `bun run test:browser` does
 * both. The port and the start token are chosen when this file first loads (see `tests/environment-configuration.ts`), so concurrent runs do not collide.
 *
 * The server runs with `SHELL=/bin/sh` so the login-shell profile is the same on every host and a
 * personal shell configuration cannot change what the checks see.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.playwright.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { baseURL: EXAMPLE_ORIGIN, trace: 'retain-on-failure' },
  webServer: {
    command: `SHELL=/bin/sh bun src/server/main.ts --port ${EXAMPLE_PORT} --start-token ${START_TOKEN} --browsers 128`,
    cwd: import.meta.dirname,
    url: EXAMPLE_ORIGIN,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
