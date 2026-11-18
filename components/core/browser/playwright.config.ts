import { packageSuiteConfiguration } from '@lostgradient/testing/browser/playwright-configuration';
import { devices } from '@playwright/test';

// Chromium is the gate; the other engines run only through `test:browser:engines`.
export default packageSuiteConfiguration({
  root: import.meta.dirname,
  projects: [
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
