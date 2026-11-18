import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { collectionResult, collectionSteps } from './check-playwright-collection.ts';

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

describe('collectionSteps', () => {
  // The package browser suites replaced the root fixture suite (COR-2092): the repository lists
  // each component package's configuration and no root one.
  test('lists each component package configuration, and no root suite once it is gone', () => {
    const configurations = collectionSteps().map((step) => step.configuration);
    expect(configurations).not.toContain('scripts/browser-fixtures/playwright.config.ts');
    for (const name of ['cinder', 'chat', 'editor', 'terminal']) {
      expect(configurations).toContain(`components/${name}/browser/playwright.config.ts`);
    }
  });

  test('lists the root fixture suite first while a tree still has its configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'playwright-collection-'));
    try {
      for (const path of [
        'scripts/browser-fixtures/playwright.config.ts',
        'components/chat/browser/playwright.config.ts',
      ]) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), '');
      }
      expect(collectionSteps(root)).toEqual([
        {
          configuration: 'scripts/browser-fixtures/playwright.config.ts',
          prepare: ['bun', 'scripts/browser-fixtures/scripts/prepare-manifest.ts'],
        },
        {
          configuration: 'components/chat/browser/playwright.config.ts',
          prepare: ['bun', 'components/chat/browser/harness.ts', 'prepare'],
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A fresh checkout has none of the ignored manifests the specs read at module scope, and
  // `--list` starts no web server to write them, so every configuration prepares its own first.
  test('prepares each suite with the step that writes its manifest', () => {
    const prepareBy = new Map(collectionSteps().map((step) => [step.configuration, step.prepare]));
    for (const name of ['cinder', 'chat', 'editor', 'terminal']) {
      const prepare = prepareBy.get(`components/${name}/browser/playwright.config.ts`);
      expect(prepare).toEqual(['bun', `components/${name}/browser/harness.ts`, 'prepare']);
      expect(existsSync(join(import.meta.dir, '..', prepare?.[1] ?? ''))).toBe(true);
    }
  });
});
