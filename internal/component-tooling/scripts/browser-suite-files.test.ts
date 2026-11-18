import { describe, expect, test } from 'bun:test';

import { HARNESS_SOURCE, playwrightConfigSource, SWEEP_SOURCE } from './browser-suite-files.ts';

describe('browser suite templates', () => {
  // `extract-families.ts` re-points every relative path a package file names, comments included, so
  // a template that named one would change on its next run, and that run would no longer be a no-op.
  test('name no relative path', () => {
    const firefox = {
      name: 'firefox-keyboard',
      device: 'Desktop Firefox',
      testMatch: '**/keyboard.playwright.ts',
    } as const;
    for (const source of [HARNESS_SOURCE, SWEEP_SOURCE, playwrightConfigSource([firefox])]) {
      expect(source).not.toMatch(/\.\.\//);
    }
  });
});
