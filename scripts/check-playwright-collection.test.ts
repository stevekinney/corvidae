import { describe, expect, test } from 'bun:test';

import { collectionResult, playwrightConfigurations } from './check-playwright-collection.ts';

describe('collectionResult', () => {
  test('passes a listing that collected tests and exited cleanly', () => {
    const output =
      'Listing tests:\n  [chromium] › a.playwright.ts:3:1 › a\nTotal: 1 test in 1 file\n';
    expect(collectionResult(0, output)).toEqual({ ok: true, summary: 'Total: 1 test in 1 file' });
  });

  test('fails a spec whose import does not resolve, naming the module', () => {
    const output = [
      "ResolveMessage: Cannot find module './overlay-fixture.ts' imported from /x/tests/a.playwright.ts",
      '',
      'Error: No tests found',
      'Listing tests:',
      'Total: 0 tests in 0 files',
    ].join('\n');
    const result = collectionResult(1, output);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('./overlay-fixture.ts');
  });

  test('fails a load error even when the process exits zero', () => {
    const output = 'Error: boom\nTotal: 3 tests in 1 file\n';
    expect(collectionResult(0, output).ok).toBe(false);
  });

  test('fails a non-zero exit with no recognisable error', () => {
    expect(collectionResult(1, 'Total: 3 tests in 1 file\n').ok).toBe(false);
  });
});

describe('playwrightConfigurations', () => {
  test('lists the root fixture configuration and each component package configuration', () => {
    const configurations = playwrightConfigurations();
    expect(configurations[0]).toBe('scripts/browser-fixtures/playwright.config.ts');
    expect(configurations).toContain('components/chat/browser/playwright.config.ts');
    expect(configurations).toContain('components/editor/browser/playwright.config.ts');
    expect(configurations).toContain('components/terminal/browser/playwright.config.ts');
  });
});
