import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowlistRaises, collectFiles, judgeCounts, lineOf } from './owner-rule-guard-support';

describe('owner rule guard support', () => {
  test('a file with more sites than its allowlist entry fails, and a file with none listed fails', () => {
    const found = new Map([
      ['a.svelte', ['1 - x', '2 - y']],
      ['b.svelte', ['3 - z']],
    ]);
    const verdict = judgeCounts(found, { 'a.svelte': 1 });
    expect(verdict.problems).toEqual(['a.svelte:2 - y', 'b.svelte:3 - z']);
    expect(verdict.stale).toEqual([]);
  });

  test('an entry that names more sites than remain is stale', () => {
    const verdict = judgeCounts(new Map([['a.svelte', ['1 - x']]]), {
      'a.svelte': 2,
      'gone.svelte': 1,
    });
    expect(verdict.problems).toEqual([]);
    expect(verdict.stale).toEqual([
      'a.svelte - lists 2 but holds 1',
      'gone.svelte - lists 1 but holds 0',
    ]);
  });

  test('an inherited key is not an allowlist entry', () => {
    expect(judgeCounts(new Map([['constructor', ['1 - x']]]), {}).problems).toEqual([
      'constructor:1 - x',
    ]);
  });

  test('an allowlist count above origin/main fails, and a missing baseline refuses nothing', () => {
    expect(allowlistRaises({ a: 2, b: 1 }, { a: 1, b: 1 })).toHaveLength(1);
    expect(allowlistRaises({ a: 2, c: 1 }, { a: 2 })).toHaveLength(1);
    expect(allowlistRaises({ a: 1 }, { a: 2 })).toEqual([]);
    expect(allowlistRaises({ a: 9 }, null)).toEqual([]);
  });

  test('collects files by extension and skips dot directories, dependencies and excluded names', () => {
    const directory = mkdtempSync(join(tmpdir(), 'owner-rule-support-'));
    try {
      mkdirSync(join(directory, 'src'));
      mkdirSync(join(directory, 'node_modules'));
      mkdirSync(join(directory, '.svelte-kit'));
      for (const path of [
        'src/a.svelte',
        'src/a.test-harness.svelte',
        'src/b.ts',
        'node_modules/c.svelte',
        '.svelte-kit/d.svelte',
      ]) {
        writeFileSync(join(directory, path), '');
      }
      const paths: string[] = [];
      collectFiles(directory, new Set(['.svelte']), paths, /\.test-harness\.svelte$/);
      expect(paths).toEqual([join(directory, 'src/a.svelte')]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('numbers lines from one', () => {
    expect(lineOf('a\nb\nc', 0)).toBe(1);
    expect(lineOf('a\nb\nc', 2)).toBe(2);
    expect(lineOf('a\nb\nc', 4)).toBe(3);
  });
});
