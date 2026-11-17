import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  collectScannedFiles,
  findMiddleDotSeparators,
  SCANNED_DIRECTORIES,
} from './check-middle-dot-separators';

// The planted cases spell the character `DOT` and `plant` writes it out, so this file holds no
// literal middle dot for the guard's own scan to find.
function plant(source: string): string {
  return source.replaceAll('DOT', '\u00b7');
}

describe('middle-dot separators', () => {
  test.each([
    ['a string literal', "const label = 'Waiting on you DOT Chat';"],
    ['a template literal', 'const label = `${agent} DOT ${time}`;'],
    ['markup text', '<span>Chat DOT Tool runner</span>'],
    ['a lone separator element', '<span aria-hidden="true">DOT</span>'],
    ['a stylesheet content value', ".meta::before { content: 'DOT'; }"],
    ['a comment', '// "Done DOT refund not issued"'],
    ['a regular expression', 'expect(text).toMatch(/Chat\\s*DOT\\s*Tool/);'],
  ])('reports %s', (_name, source) => {
    expect(findMiddleDotSeparators(plant(`first line\n${source}`)).map((v) => v.line)).toEqual([2]);
  });

  test('reports each line that holds one', () => {
    const source = plant('a DOT b\nclean\nc DOT d DOT e');
    expect(findMiddleDotSeparators(source).map((violation) => violation.line)).toEqual([1, 3]);
  });

  test.each([
    ['a JavaScript escape', "const label = 'Chat \\u00b7 Tool runner';"],
    ['a braced JavaScript escape', "const label = 'Chat \\u{b7} Tool runner';"],
    ['a hexadecimal escape', "const label = 'Chat \\xb7 Tool runner';"],
    ['a CSS escape', ".meta::before { content: '\\00b7'; }"],
    ['a named HTML entity', '<span>Chat &middot; Tool runner</span>'],
    ['a decimal HTML entity', '<span>Chat &#183; Tool runner</span>'],
    ['a hexadecimal HTML entity', '<span>Chat &#xB7; Tool runner</span>'],
  ])('reports %s, which draws the same glyph', (_name, source) => {
    expect(findMiddleDotSeparators(source)).toHaveLength(1);
  });

  test('accepts a code point lookup, a comma, a bullet and a regular expression boundary', () => {
    expect(
      findMiddleDotSeparators(
        'expect(text).not.toContain(String.fromCodePoint(0xb7));\nChat, Tool runner\n• item\nconst pattern = /\\b7 days/;',
      ),
    ).toEqual([]);
  });

  test('accepts a line with an allow marker and a reason, on the line or the one above', () => {
    const reason = 'middle-dot-allowed: a quoted third-party fixture we must reproduce';
    expect(findMiddleDotSeparators(plant(`a DOT b // ${reason}`))).toEqual([]);
    expect(findMiddleDotSeparators(plant(`// ${reason}\na DOT b`))).toEqual([]);
  });

  test('reports a line whose allow marker has no real reason', () => {
    expect(findMiddleDotSeparators(plant('a DOT b // middle-dot-allowed: ok'))).toHaveLength(1);
  });
});

describe('scanned file discovery', () => {
  test('collects text files, skips binaries, dependencies and dot directories', () => {
    const directory = mkdtempSync(join(tmpdir(), 'middle-dot-scan-'));
    try {
      for (const path of [
        'src/component.svelte',
        'src/copy.ts',
        'README.md',
        'src/assets/social.png',
        'node_modules/dependency/index.js',
        '.svelte-kit/generated.ts',
      ]) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), 'x');
      }
      const paths: string[] = [];
      collectScannedFiles(directory, paths);
      expect(paths.map((path) => relative(directory, path)).toSorted()).toEqual([
        'README.md',
        'src/component.svelte',
        'src/copy.ts',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('scan roots', () => {
  // Chat draws the composer hint, the queued label and the held answer line Interborough shows, so
  // a separator written there reaches the person exactly as one written in Cinder would.
  test('cover both component libraries and the applications that write copy', () => {
    expect(SCANNED_DIRECTORIES).toEqual(
      expect.arrayContaining([
        'components/cinder',
        'components/chat',
        'applications/playground',
        'applications/interborough',
      ]),
    );
  });
});
