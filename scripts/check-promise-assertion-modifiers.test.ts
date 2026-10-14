import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import {
  CANONICAL_PROMISE_OUTCOME,
  collectScannedFiles,
  findDriftedCopies,
  findPromiseAssertionModifierViolations,
  mayContainPromiseAssertionModifier,
  PROMISE_OUTCOME_COPIES,
} from './check-promise-assertion-modifiers';

function inspect(source: string): string[] {
  const parsed = ts.createSourceFile('fixture.test.ts', source, ts.ScriptTarget.Latest, true);
  return findPromiseAssertionModifierViolations(parsed).map((violation) => violation.text);
}

describe('promise assertion modifiers', () => {
  test.each([
    'expect(promise).resolves.toBe(1);',
    'await expect(promise).resolves.toEqual({ ok: true });',
    'expect(promise).resolves.not.toBe(1);',
    "expect(promise).rejects.toThrow('boom');",
    'expect(promise).rejects.not.toThrow(TypeError);',
    'expect(run(), label).rejects.toBeInstanceOf(Error);',
    'const rejection = expect(promise).rejects;',
    "expect(promise)['resolves'].toBe(1);",
    "import { expect as check } from 'bun:test';\ncheck(promise).rejects.toThrow();",
    'expect(\n  engine.start(\n    input,\n  ),\n)\n  .rejects.toThrow();',
  ])('rejects %s', (source) => {
    expect(inspect(source)).toHaveLength(1);
  });

  test.each([
    'expect(await promise).toBe(1);',
    'expect(await rejectionOf(promise)).toBeInstanceOf(Error);',
    "expect(await throwingRejectionOf(promise)).toThrow('boom');",
    'const { promise, resolve } = Promise.withResolvers();',
    'handle.resolves;',
    'expect(value).toBe(outcome.rejects);',
    "import { expect as check } from 'bun:test';\nexpect(await promise).toBe(check);",
    "import { check } from './local';\ncheck(promise).resolves;",
  ])('accepts %s', (source) => {
    expect(inspect(source)).toEqual([]);
  });

  test.each([
    'expect(promise).resolves.toBe(1);',
    "expect(promise)['rejects'].toThrow();",
    'expect(promise)[`resolves`].toBe(1);',
  ])('the text prefilter lets %s reach the AST check', (source) => {
    expect(mayContainPromiseAssertionModifier(source)).toBe(true);
    expect(inspect(source)).toHaveLength(1);
  });

  test('reports the line of the modifier in a multi-line chain', () => {
    const parsed = ts.createSourceFile(
      'fixture.test.ts',
      'const a = 1;\nexpect(\n  promise,\n).rejects.toThrow();\n',
      ts.ScriptTarget.Latest,
      true,
    );
    expect(
      findPromiseAssertionModifierViolations(parsed).map((violation) => violation.line),
    ).toEqual([4]);
  });
});

describe('scanned files', () => {
  test('collects TypeScript sources and skips declarations, dependencies and dot directories', () => {
    const directory = mkdtempSync(join(tmpdir(), 'promise-assertion-scan-'));
    try {
      for (const file of [
        'src/a.test.ts',
        'src/b.test.tsx',
        'src/c.test-support.ts',
        'src/d.ts',
        'src/types.d.ts',
        'test/harness.ts',
        'src/readme.md',
        'node_modules/e.test.ts',
        '.turbo/f.test.ts',
        'dist/g.test.ts',
      ]) {
        const path = join(directory, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '');
      }
      const paths: string[] = [];
      collectScannedFiles(directory, paths);
      expect(paths.map((path) => relative(directory, path)).toSorted()).toEqual([
        'src/a.test.ts',
        'src/b.test.tsx',
        'src/c.test-support.ts',
        'src/d.ts',
        'test/harness.ts',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('promise-outcome copies', () => {
  function repositoryWith(files: Record<string, string>): string {
    const directory = mkdtempSync(join(tmpdir(), 'promise-outcome-copies-'));
    for (const [file, contents] of Object.entries(files)) {
      const path = join(directory, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    return directory;
  }

  test('reports nothing when every copy matches the canonical module', async () => {
    const files = Object.fromEntries(
      [CANONICAL_PROMISE_OUTCOME, ...PROMISE_OUTCOME_COPIES].map((file): [string, string] => [
        file,
        'same\n',
      ]),
    );
    const directory = repositoryWith(files);
    try {
      expect(await findDriftedCopies(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('reports a copy that differs or is missing', async () => {
    // The first copy differs and the second is missing.
    const [drifted, , ...rest] = PROMISE_OUTCOME_COPIES;
    const files = Object.fromEntries(
      [CANONICAL_PROMISE_OUTCOME, ...rest].map((file): [string, string] => [file, 'same\n']),
    );
    files[drifted!] = 'different\n';
    const directory = repositoryWith(files);
    try {
      expect(await findDriftedCopies(directory)).toEqual(PROMISE_OUTCOME_COPIES.slice(0, 2));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
