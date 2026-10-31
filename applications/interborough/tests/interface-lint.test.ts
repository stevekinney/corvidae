/**
 * The interface lint (`scripts/check-interface-rules.ts`) over the real source tree, and the shape
 * of the two lists it reads. A violation passes only through `interface-lint-allowlist.json` (with
 * a reason) or `interface-lint-pending.json` (with the issue that rewrites the panel), and a listed
 * entry that no longer violates fails, so both lists can only shrink.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  ALLOWLIST_PATH,
  checkInterfaceRules,
  collectViolations,
  PENDING_PATH,
  readEntries,
} from '../scripts/check-interface-rules.ts';

const PACKAGE_ROOT = join(import.meta.dir, '..');
const ISSUE = /^COR-\d+$/;
/** The rules whose breach can sit in a panel a page issue rewrites. */
const PENDING_RULES = new Set(['app-header-class', 'cinder-selector']);

describe('the interface lint over the source tree', () => {
  test('has no unlisted violation and no stale entry', () => {
    const { unlisted, stale } = checkInterfaceRules(PACKAGE_ROOT);
    expect(
      unlisted.map(({ file, line, rule, subject }) => `${file}:${String(line)} ${rule} ${subject}`),
    ).toEqual([]);
    expect(
      stale.map(({ list, rule, file, subject }) => `${list} ${rule} ${file} ${subject}`),
    ).toEqual([]);
  });

  test('has no copy violation at all: only header and Cinder selectors may wait for a page issue', () => {
    const copy = collectViolations(PACKAGE_ROOT).filter(
      (violation) => !PENDING_RULES.has(violation.rule) && violation.rule !== 'uppercase-label',
    );
    expect(copy).toEqual([]);
  });
});

describe('interface-lint-pending.json', () => {
  const entries = readEntries(PACKAGE_ROOT, PENDING_PATH);

  test('names the owning issue of every entry', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.issue ?? '').toMatch(ISSUE);
  });

  test('holds only header-class and Cinder-selector entries, each once', () => {
    for (const entry of entries) expect(PENDING_RULES.has(entry.rule)).toBe(true);
    const keys = entries.map((entry) => `${entry.rule} ${entry.file} ${entry.subject}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('interface-lint-allowlist.json', () => {
  const entries = readEntries(PACKAGE_ROOT, ALLOWLIST_PATH);

  test('gives every entry a reason', () => {
    for (const entry of entries) expect((entry.reason ?? '').length).toBeGreaterThan(20);
  });

  test('does not list an entry the pending list also lists', () => {
    const pending = new Set(
      readEntries(PACKAGE_ROOT, PENDING_PATH).map(
        (entry) => `${entry.rule} ${entry.file} ${entry.subject}`,
      ),
    );
    for (const entry of entries)
      expect(pending.has(`${entry.rule} ${entry.file} ${entry.subject}`)).toBe(false);
  });
});
