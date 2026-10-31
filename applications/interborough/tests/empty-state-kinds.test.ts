/**
 * Every `<EmptyState>` in `src` passes a C4 `kind` (`first-use`, `filtered` or `done`), except the
 * files `empty-state-pending.json` lists. The list names the issue that rewrites each file, and it
 * can only shrink: a listed file whose every `<EmptyState>` now passes a `kind` fails here, so it
 * must be removed. The same lint also fails an `<EmptyState>` with no `title`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { emptyStateUsages } from '../scripts/check-interface-rules.ts';

const PACKAGE_ROOT = join(import.meta.dir, '..');
const ISSUE = /^COR-\d+$/;

type Pending = { readonly file: string; readonly issue: string };

const pending = (
  JSON.parse(readFileSync(join(PACKAGE_ROOT, 'tests', 'empty-state-pending.json'), 'utf8')) as {
    entries: Pending[];
  }
).entries;
const usages = emptyStateUsages(PACKAGE_ROOT);
const withoutKind = [
  ...new Set(usages.filter((usage) => !usage.hasKind).map((usage) => usage.file)),
];

describe('the EmptyState kind', () => {
  test('is passed by every file that is not listed as pending', () => {
    const listed = new Set(pending.map((entry) => entry.file));
    expect(withoutKind.filter((file) => !listed.has(file)).toSorted()).toEqual([]);
  });

  test('is missing from every pending file, so a file that now passes one is removed', () => {
    const missing = new Set(withoutKind);
    expect(
      pending
        .map((entry) => entry.file)
        .filter((file) => !missing.has(file))
        .toSorted(),
    ).toEqual([]);
  });

  test('names an owning issue for every pending file, once each', () => {
    for (const entry of pending) expect(entry.issue).toMatch(ISSUE);
    expect(new Set(pending.map((entry) => entry.file)).size).toBe(pending.length);
  });

  test('is paired with a title in every EmptyState', () => {
    expect(
      usages
        .filter((usage) => !usage.hasTitle)
        .map((usage) => `${usage.file}:${String(usage.line)}`),
    ).toEqual([]);
  });
});
