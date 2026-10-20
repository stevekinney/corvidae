/**
 * A route that joins the pages of an infinite query must do it through `combinePages`
 * (`combine-pages.ts`): the Bureau pages by offset, a list that shifts while it is read gives the
 * next page a row the last one already gave, and a keyed `{#each}` over the repeat throws and takes
 * the route down. This pins every file that reads `.pages`, and fails on a new one that does not
 * go through the helper unless it argues in `KEYED_BY_OCCURRENCE` why it cannot throw.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SOURCE_ROOT = join(import.meta.dir, '..');

/** Files that read the pages of an infinite query but key their rows without a repeat risk, with why. */
const KEYED_BY_OCCURRENCE: Readonly<Record<string, string>> = {
  'routes/goals/index.svelte': 'keys each row through keyedByOccurrence, which cannot repeat a key',
  'routes/audit/index.svelte':
    'keys each record through keyedByOccurrence, which cannot repeat a key',
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const source = /\.(svelte|ts)$/.test(entry.name);
    const test = /\.test(-support|-harness)?\.|\.test-(support|harness)\./.test(entry.name);
    return source && !test ? [path] : [];
  });
}

describe('lists that join the pages of an infinite query', () => {
  const readers = sourceFiles(SOURCE_ROOT)
    .map((path) => ({ file: relative(SOURCE_ROOT, path), source: readFileSync(path, 'utf8') }))
    .filter(({ source }) => /\.data\??\.pages\b/.test(source));

  test('are found, so the guard is not vacuous', () => {
    expect(readers.length).toBeGreaterThanOrEqual(5);
  });

  test('every one goes through combinePages unless it keys by occurrence', () => {
    const offenders = readers
      .filter(({ file, source }) => {
        if (file in KEYED_BY_OCCURRENCE) return !/keyedByOccurrence\(/.test(source);
        return !/combinePages\(/.test(source);
      })
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
