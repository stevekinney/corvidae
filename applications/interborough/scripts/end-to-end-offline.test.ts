import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A browser spec that takes its context offline declares the failures that causes (COR-2001). Every
 * request the page starts while the context is offline fails with `ERR_INTERNET_DISCONNECTED`, and
 * which requests those are follows the page's own schedule (its health probe, a feed that connects
 * or reconnects, a list that refetches), so a test that cut the network with
 * `context.setOffline(true)` failed on whichever request happened to land in the window, and passed
 * when none did. `goOffline` in `tests/e2e/fixtures.ts` is the one way to do it: it declares the
 * failures, and a spec restores the network with `setOffline(false)`.
 */
const root = join(import.meta.dir, '..');
const OFFLINE = /\.setOffline\(\s*true\s*\)/;

/** The helper itself, and the spec that shows the fixture failing a cut nobody declared. */
const EXEMPT = new Set(['tests/e2e/fixtures.ts', 'tests/e2e/00-page-errors.spec.ts']);

function specFiles(): string[] {
  return ['tests/e2e/**/*.ts', 'tests/mcp-apps/**/*.ts'].flatMap((pattern) => [
    ...new Glob(pattern).scanSync({ cwd: root }),
  ]);
}

describe('the browser specs that cut the network', () => {
  test('find the files the rule reads', () => {
    expect(specFiles()).toContain('tests/e2e/fixtures.ts');
  });

  test('cut it through goOffline, which declares what the cut fails', () => {
    const direct = specFiles().filter(
      (path) => !EXEMPT.has(path) && OFFLINE.test(readFileSync(join(root, path), 'utf8')),
    );
    expect(direct).toEqual([]);
  });

  test('the rule matches the call it forbids', () => {
    expect(OFFLINE.test('await context.setOffline(true);')).toBe(true);
    expect(OFFLINE.test('await context.setOffline(false);')).toBe(false);
  });
});
