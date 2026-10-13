import { defineConfig, devices } from '@playwright/test';

// Playwright forces color in its workers and web servers. Remove the conflicting
// inherited opt-out in this test process before those children are created.
delete process.env['NO_COLOR'];

// A fixed port: the repository's environment-configuration policy allows
// environment reads only through a registered `environment-configuration.ts`,
// and a busy port fails this run loudly rather than drifting.
const port = 5597;
const origin = `http://localhost:${port}`;

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.playwright.ts',
  // The static production gate's spec needs the case list and static server that
  // `scripts/check-static-playground.ts` provides, so only `test:production` runs it.
  testIgnore: 'playground-production.playwright.ts',
  timeout: 60_000,
  use: { baseURL: origin, trace: 'retain-on-failure' },
  webServer: {
    command: 'bun src/playground-server.ts',
    cwd: import.meta.dirname,
    env: { PORT: String(port) },
    url: `${origin}/ready`,
    reuseExistingServer: false,
    timeout: 300_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
