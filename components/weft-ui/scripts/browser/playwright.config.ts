import { defineConfig, devices } from '@playwright/test';
import { environmentConfiguration } from './environment-configuration.ts';
import { E2E_BASE_URL, E2E_CONSOLE_PORT, E2E_SERVER_PORT } from './tests/e2e/e2e-constants.ts';

const configuration = environmentConfiguration();

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: configuration.ci ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: E2E_BASE_URL, reducedMotion: 'reduce' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `bun run ${new URL('./tests/e2e/e2e-server.ts', import.meta.url).pathname}`,
      port: E2E_SERVER_PORT,
      reuseExistingServer: !configuration.ci,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `bun run ${new URL('./server.ts', import.meta.url).pathname}`,
      url: E2E_BASE_URL,
      reuseExistingServer: !configuration.ci,
      env: {
        WEFT_API_BASE_URL: `http://localhost:${E2E_SERVER_PORT}`,
        WEFT_UI_PORT: String(E2E_CONSOLE_PORT),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
