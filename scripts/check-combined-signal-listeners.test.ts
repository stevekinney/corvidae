import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import {
  collectScannedFiles,
  findCombinedSignalListeners,
  mayCombineSignals,
} from './check-combined-signal-listeners';

function inspect(source: string): number {
  const parsed = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  return findCombinedSignalListeners(parsed).length;
}

describe('combined signal listeners', () => {
  test.each([
    'target.addEventListener("x", fn, { signal: AbortSignal.any([a, b]) });',
    'const combined = AbortSignal.any([a, b]);\ntarget.addEventListener("x", fn, { signal: combined });',
    'const combined = a ? AbortSignal.any([a, b]) : b;\ntarget.addEventListener("x", fn, { once: true, signal: combined });',
    'const options = { ...rest, signal: a ? AbortSignal.any([a, b]) : b };\ntarget.addEventListener("x", fn, options);',
    'function merge(a, b) { return AbortSignal.any([a, b]); }\ntarget.addEventListener("x", fn, { signal: merge(a, b) });',
    'const signal = AbortSignal.any([a, b]);\ntarget.addEventListener("x", fn, { signal });',
    'const first = AbortSignal.any([a, b]);\nconst second = first;\nemitter.on("x", fn, { signal: second });',
    'emitter.once("x", fn, { signal: AbortSignal.any([a, b]) });',
  ])('rejects %s', (source) => {
    expect(inspect(source)).toBe(1);
  });

  test.each([
    'const combined = AbortSignal.any([a, b]);\nawait fetch(url, { signal: combined });',
    'const combined = AbortSignal.any([a, b]);\ncombined.addEventListener("abort", stop, { once: true });',
    'target.addEventListener("x", fn, { signal: controller.signal });',
    'const options = { signal: controller.signal };\ntarget.addEventListener("x", fn, options);',
    'function own() { return new AbortController().signal; }\ntarget.addEventListener("x", fn, { signal: own() });',
    'const combined = AbortSignal.any([a, b]);\nsource.addEventListener("x", fn, { signal: other });',
  ])('accepts %s', (source) => {
    expect(inspect(source)).toBe(0);
  });

  test('prefilters on the combinator', () => {
    expect(mayCombineSignals('AbortSignal.any([a])')).toBe(true);
    expect(mayCombineSignals('AbortSignal.timeout(1)')).toBe(false);
  });

  test('scans production sources and skips tests', () => {
    const directory = mkdtempSync(join(tmpdir(), 'combined-signal-'));
    try {
      for (const file of ['src/a.ts', 'src/a.test.ts', 'test/b.ts', 'src/c.d.ts', 'src/d.tsx']) {
        mkdirSync(dirname(join(directory, file)), { recursive: true });
        writeFileSync(join(directory, file), '');
      }
      const paths: string[] = [];
      collectScannedFiles(directory, paths);
      expect(paths.map((path) => relative(directory, path)).toSorted()).toEqual([
        'src/a.ts',
        'src/d.tsx',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
