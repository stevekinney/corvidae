import { describe, expect, test } from 'bun:test';

import { PLUGIN_PROBLEM_CODES } from './plugin-problem-codes.ts';

/** Codes that do not start with their identity kind, by name; the list only shrinks. */
const EXEMPT_CODES: ReadonlySet<string> = new Set([
  'name-clash',
  'setup-failed',
  'load-failed',
  'development-source',
  'secret-missing',
  'secret-refused',
  'reference-unresolved',
  'pinned-version-unavailable',
  'start-failed',
  'hook-invalid',
]);

/** The codes whose name does not start with their identity kind and are not exempt. */
function misnamedCodes(codes: Readonly<Record<string, string>>): string[] {
  return Object.entries(codes)
    .filter(([code, kind]) => !EXEMPT_CODES.has(code) && !code.startsWith(`${kind}-`))
    .map(([code]) => code);
}

describe('plugin problem codes', () => {
  test('every non-exempt code starts with its identity kind', () => {
    expect(misnamedCodes(PLUGIN_PROBLEM_CODES)).toEqual([]);
  });

  test('a code for another identity kind is caught', () => {
    expect(misnamedCodes({ ...PLUGIN_PROBLEM_CODES, 'foo-failed': 'bar' })).toEqual(['foo-failed']);
  });

  test('an exempt code is not checked', () => {
    expect(misnamedCodes({ 'setup-failed': 'plugin' })).toEqual([]);
  });
});
