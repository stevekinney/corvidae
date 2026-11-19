import { packageSuiteConfiguration } from '@lostgradient/testing/browser/playwright-configuration';
import { devices } from '@playwright/test';

// The terminal proof runs in all three engines; the baselines belong to Chromium alone. The
// Firefox and WebKit projects run only through `test:browser:engines`, outside every gate.
export default packageSuiteConfiguration({
  root: import.meta.dirname,
  projects: [
    {
      name: 'firefox-terminal',
      testMatch: '**/terminal-*.playwright.ts',
      testIgnore: '**/terminal-visual.playwright.ts',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit-terminal',
      testMatch: '**/terminal-*.playwright.ts',
      testIgnore: '**/terminal-visual.playwright.ts',
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
