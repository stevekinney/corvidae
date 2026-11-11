import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  collectScannedFiles,
  findHiddenLabels,
  judgeHiddenLabels,
  type HiddenLabelAllowlistEntry,
} from './check-hidden-labels';

describe('hidden control labels', () => {
  test.each([
    ['a Toggle in markup', '<Toggle id="on" label="On" labelVisible={false} />'],
    ['an Input in markup', '<Input id="agent" label="Agent" labelVisible={false} />'],
    ['a spaced expression', '<Select labelVisible={ false } />'],
    ['a quoted attribute', '<Input labelVisible="false" />'],
    ['an object literal', 'const props = { label: "Message", labelVisible: false };'],
  ])('reports %s', (_name, source) => {
    expect(findHiddenLabels(`first line\n${source}`).map((violation) => violation.line)).toEqual([
      2,
    ]);
  });

  test('reports each line that holds one', () => {
    const source = '<Input labelVisible={false} />\nclean\n<Select labelVisible={false} />';
    expect(findHiddenLabels(source).map((violation) => violation.line)).toEqual([1, 3]);
  });

  test('accepts a visible label, the default, and a longer property name', () => {
    expect(
      findHiddenLabels(
        '<Input labelVisible />\n<Input labelVisible={true} />\n<Input label="Agent" />\nconst notLabelVisible = false;',
      ),
    ).toEqual([]);
  });

  test('accepts a line with an allow marker and a reason, on the line or the one above', () => {
    const reason = 'hidden-label-allowed: the group above draws the one visible label';
    expect(findHiddenLabels(`<Input labelVisible={false} /> <!-- ${reason} -->`)).toEqual([]);
    expect(findHiddenLabels(`<!-- ${reason} -->\n<Input labelVisible={false} />`)).toEqual([]);
  });

  test('reports a line whose allow marker has no real reason', () => {
    expect(
      findHiddenLabels('<Input labelVisible={false} /> <!-- hidden-label-allowed: ok -->'),
    ).toHaveLength(1);
  });
});

describe('the allowlist of pages that hid a label before the guard', () => {
  const entry = (file: string, count: number): HiddenLabelAllowlistEntry => ({
    file,
    count,
    reason: 'Predates the guard, so it stays until the page is redesigned.',
  });
  const sites = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ line: index + 1, text: '<Input />' }));

  test('accepts a file that holds no more sites than its entry', () => {
    const verdict = judgeHiddenLabels(new Map([['a.svelte', sites(2)]]), [entry('a.svelte', 2)]);
    expect(verdict).toEqual({ problems: [], stale: [] });
  });

  test('reports a site beyond the entry, and every site of a file with no entry', () => {
    const verdict = judgeHiddenLabels(
      new Map([
        ['a.svelte', sites(3)],
        ['b.svelte', sites(1)],
      ]),
      [entry('a.svelte', 2)],
    );
    expect(verdict.problems).toEqual(['a.svelte:3 - <Input />', 'b.svelte:1 - <Input />']);
  });

  test('reports an entry that names more sites than remain as stale, and does not fail', () => {
    const verdict = judgeHiddenLabels(new Map([['a.svelte', sites(1)]]), [
      entry('a.svelte', 2),
      entry('gone.svelte', 1),
    ]);
    expect(verdict.problems).toEqual([]);
    expect(verdict.stale).toEqual([
      'a.svelte - lists 2 but holds 1',
      'gone.svelte - lists 1 but holds 0',
    ]);
  });
});

describe('scanned file discovery', () => {
  test('collects source files, skips other files, dependencies and dot directories', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hidden-label-scan-'));
    try {
      for (const path of [
        'src/page.svelte',
        'src/copy.ts',
        'src/styles.css',
        'README.md',
        'node_modules/dependency/index.js',
        '.svelte-kit/generated.ts',
      ]) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), 'x');
      }
      const paths: string[] = [];
      collectScannedFiles(directory, paths);
      expect(paths.map((path) => relative(directory, path)).toSorted()).toEqual([
        'src/copy.ts',
        'src/page.svelte',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
