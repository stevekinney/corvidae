import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';

import { compileSafePattern } from './safe-regexp.ts';

describe('safe patterns', () => {
  test('compiles JavaScript syntax and rejects what needs backtracking', () => {
    expect(compileSafePattern('^[a-z]+$')?.test('abc')).toBe(true);
    expect(compileSafePattern('^\\u0041$')?.test('A')).toBe(true);
    expect(compileSafePattern('(')).toBeUndefined();
    expect(compileSafePattern('(?<=a)b')).toBeUndefined();
  });

  test('no renderer source builds a RegExp from a string, so agent patterns stay on RE2', async () => {
    const directory = new URL('./', import.meta.url);
    const names = await readdir(directory);
    const sources = names.filter(
      (name) => /\.(ts|svelte)$/.test(name) && !name.endsWith('.test.ts'),
    );
    const offenders: string[] = [];
    for (const name of sources) {
      const source = await Bun.file(new URL(name, directory)).text();
      if (/\bRegExp\s*\(/.test(source.replaceAll('translateRegExp(', ''))) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
