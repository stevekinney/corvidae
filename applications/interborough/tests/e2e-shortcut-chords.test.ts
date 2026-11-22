import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A `g` chord in a browser spec is typed through `shortcut-support.ts` (COR-2638). The shell
 * measures the chord window between the two keys' own event times, and `page.keyboard.press`
 * sends the second key only once the page has handled the first, so on a page still painting (an
 * open chat, the Storage table) the second key lands after the window and the shortcut goes
 * nowhere. Eight specs pressed chords that way and three failed on unrelated branches before the
 * helper took them all. These checks keep a spec from pressing the first key of a chord itself, or
 * from stamping key events anywhere but the helper.
 */
const TESTS = import.meta.dir;
const HELPER = join(TESTS, 'e2e', 'shortcut-support.ts');

/** Every TypeScript file under `directory`, at any depth. */
function sourcesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** A press or hold of `g` alone, the first key of a chord: `.press('g')`, `.down("G")`, … */
const CHORD_START = /\.(?:press|down)\(\s*(['"`])g\1/gi;
/** A key event sent through CDP, which only the helper stamps. */
const STAMPED_KEY = /Input\.dispatchKeyEvent/g;

/** Each line of `source` that `pattern` matches, as `file:line`. */
function linesMatching(file: string, source: string, pattern: RegExp): string[] {
  return source.split('\n').flatMap((line, index) => {
    pattern.lastIndex = 0;
    return pattern.test(line) ? [`${relative(TESTS, file)}:${String(index + 1)}`] : [];
  });
}

const browserSources = [join(TESTS, 'e2e'), join(TESTS, 'panels')].flatMap(sourcesUnder);

describe('g chords in browser specs', () => {
  test('no spec presses the first key of a chord itself', () => {
    const offenders = browserSources
      .filter((file) => file !== HELPER)
      .flatMap((file) => linesMatching(file, readFileSync(file, 'utf8'), CHORD_START));
    expect(offenders).toEqual([]);
  });

  test('only shortcut-support.ts sends stamped key events', () => {
    const offenders = browserSources
      .filter((file) => file !== HELPER)
      .flatMap((file) => linesMatching(file, readFileSync(file, 'utf8'), STAMPED_KEY));
    expect(offenders).toEqual([]);
  });

  test('reads the shapes a spec would press a chord with', () => {
    const sample = [
      "await page.keyboard.press('g');",
      'await page.keyboard.press("G");',
      'await page.keyboard.down(`g`);',
      "await page.keyboard.press('Control+k');",
      "await page.keyboard.press('?');",
      "await composer.press('Enter');",
    ].join('\n');
    expect(linesMatching(join(TESTS, 'sample.ts'), sample, CHORD_START)).toEqual([
      'sample.ts:1',
      'sample.ts:2',
      'sample.ts:3',
    ]);
  });
});
