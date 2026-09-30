import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { collectTestFiles, findWallClockAssertionViolations } from './check-wall-clock-assertions';

function inspect(source: string): string[] {
  const parsed = ts.createSourceFile('fixture.test.ts', source, ts.ScriptTarget.Latest, true);
  return findWallClockAssertionViolations(parsed).map((violation) => violation.matcher);
}

describe('upper bounds on a duration', () => {
  test.each([
    ['a direct duration expression', 'expect(Date.now() - Date.now()).toBeLessThan(5);'],
    ['a reading offset by a numeric literal', 'expect(Date.now() + 5_000).toBeLessThan(limit);'],
    [
      'a const binding',
      'const start = performance.now();\nawait work();\nconst elapsed = performance.now() - start;\nexpect(elapsed).toBeLessThan(50);',
    ],
    [
      'a readable startedAt binding subtracted from a later reading',
      'const startedAt = performance.now();\nawait work();\nexpect(performance.now() - startedAt).toBeLessThan(30_000);',
    ],
    [
      'a let reassigned inside a loop through Math.min',
      'let fastest = Infinity;\nfor (let run = 0; run < 3; run += 1) {\n  const startedAt = performance.now();\n  await work();\n  fastest = Math.min(fastest, performance.now() - startedAt);\n}\nexpect(fastest).toBeLessThan(30_000);',
    ],
    [
      'a let accumulated with a compound assignment',
      'let total = 0;\nconst start = performance.now();\ntotal += performance.now() - start;\nexpect(total).toBeLessThanOrEqual(100);',
    ],
    [
      'a duration scaled by a numeric literal',
      'const start = performance.now();\nconst elapsed = performance.now() - start;\nconst seconds = elapsed / 1000;\nexpect(seconds).toBeLessThan(2);',
    ],
    [
      'a duration multiplied by a numeric literal',
      'const start = performance.now();\nexpect((performance.now() - start) * 1000).toBeLessThan(2);',
    ],
    [
      'a duration through parentheses and Number',
      'const start = performance.now();\nexpect(Number((performance.now() - start))).toBeLessThan(2);',
    ],
    [
      'a duration through a ternary',
      'const start = performance.now();\nconst elapsed = flag ? performance.now() - start : 0;\nexpect(elapsed).toBeLessThan(2);',
    ],
    [
      'a duration through Math.max, Math.abs, Math.round, Math.floor, Math.ceil and Math.trunc',
      'const start = performance.now();\nconst d = performance.now() - start;\nexpect(Math.max(d, 1)).toBeLessThan(2);\nexpect(Math.abs(d)).toBeLessThan(2);\nexpect(Math.round(d)).toBeLessThan(2);\nexpect(Math.floor(d)).toBeLessThan(2);\nexpect(Math.ceil(d)).toBeLessThan(2);\nexpect(Math.trunc(d)).toBeLessThan(2);',
    ],
    [
      'a globalThis-qualified reading',
      'const start = globalThis.performance.now();\nexpect(globalThis.performance.now() - start).toBeLessThan(2);',
    ],
  ])('reports %s', (_name, source) => {
    expect(inspect(source).length).toBeGreaterThan(0);
  });

  test.each([
    ['performance.now()', 'const start = performance.now();\nconst end = performance.now();'],
    ['Date.now()', 'const start = Date.now();\nconst end = Date.now();'],
    ['Bun.nanoseconds()', 'const start = Bun.nanoseconds();\nconst end = Bun.nanoseconds();'],
    ['process.hrtime()', 'const start = process.hrtime();\nconst end = process.hrtime();'],
    [
      'process.hrtime.bigint()',
      'const start = process.hrtime.bigint();\nconst end = process.hrtime.bigint();',
    ],
  ])('reports a duration measured with %s', (_name, declarations) => {
    expect(inspect(`${declarations}\nexpect(end - start).toBeLessThan(5);`)).toEqual([
      'toBeLessThan',
    ]);
  });

  test('reports the .not lower-bound matcher on a duration as an upper bound', () => {
    expect(
      inspect(
        'const start = Date.now();\nexpect(Date.now() - start).not.toBeGreaterThan(5);\nexpect(Date.now() - start).not.toBeGreaterThanOrEqual(5);',
      ),
    ).toEqual(['.not.toBeGreaterThan', '.not.toBeGreaterThanOrEqual']);
  });

  test('reports the matcher name and line of every finding', () => {
    const parsed = ts.createSourceFile(
      'fixture.test.ts',
      'const start = Date.now();\n\nexpect(Date.now() - start).toBeLessThanOrEqual(5);',
      ts.ScriptTarget.Latest,
      true,
    );
    expect(findWallClockAssertionViolations(parsed)).toEqual([
      {
        line: 3,
        matcher: 'toBeLessThanOrEqual',
        text: 'expect(Date.now() - start).toBeLessThanOrEqual(5)',
      },
    ]);
  });

  test('shares taint across tests that reuse a name, ignoring scope', () => {
    const source =
      "test('measures', () => {\n  const start = Date.now();\n  const elapsed = Date.now() - start;\n  expect(elapsed).toBeGreaterThan(-1);\n});\n" +
      "test('reuses the name for an unrelated count', () => {\n  const elapsed = countRows();\n  expect(elapsed).toBeLessThan(10);\n});";
    expect(inspect(source)).toEqual(['toBeLessThan']);
  });
});

describe('rates and ratios', () => {
  test.each([
    ['a rate with a lower bound', 'expect((count / elapsed) * 1000).toBeGreaterThan(50);'],
    [
      'a rate with toBeGreaterThanOrEqual',
      'expect((count / elapsed) * 1000).toBeGreaterThanOrEqual(50);',
    ],
    ['a rate with an upper bound', 'expect(count / elapsed).toBeLessThan(50);'],
    ['a rate with a negated lower bound', 'expect(count / elapsed).not.toBeGreaterThan(50);'],
    ['a numeric literal divided by a duration', 'expect(1000 / elapsed).toBeGreaterThan(50);'],
    ['a rate on the argument side', 'expect(50).toBeLessThan((count / elapsed) * 1000);'],
    ['a ratio of two durations', 'expect(timeAtDoubled / timeAtBaseline).toBeLessThan(4);'],
    ['a rate scaled by a numeric literal', 'expect((count / elapsed) / 1000).toBeGreaterThan(5);'],
  ])('reports %s', (_name, source) => {
    const declarations =
      'const started = Date.now();\nconst elapsed = Date.now() - started;\nconst timeAtBaseline = Date.now() - started;\nconst timeAtDoubled = Date.now() - started;\n';
    expect(inspect(declarations + source)).toHaveLength(1);
  });

  test('reports a rate held in a const', () => {
    expect(
      inspect(
        'const started = Date.now();\nconst elapsed = Date.now() - started;\nconst perSecond = (10 / elapsed) * 1000;\nexpect(perSecond).toBeGreaterThan(5);',
      ),
    ).toEqual(['toBeGreaterThan']);
  });
});

describe('two durations on either side of the matcher', () => {
  const declarations =
    'const started = Date.now();\nconst timeAtBaseline = Date.now() - started;\nconst timeAtDoubled = Date.now() - started;\n';

  test.each([
    'expect(timeAtDoubled).toBeLessThan(timeAtBaseline * 4);',
    'expect(timeAtBaseline * 4).toBeGreaterThan(timeAtDoubled);',
    'expect(timeAtDoubled).toBeGreaterThan(timeAtBaseline);',
    'expect(timeAtDoubled).not.toBeLessThan(timeAtBaseline);',
  ])('reports %s', (source) => {
    expect(inspect(declarations + source)).toHaveLength(1);
  });
});

describe('assertions the guard accepts', () => {
  test.each([
    ['a property operand', 'expect(Date.now() - record.startedAt).toBeLessThan(100);'],
    [
      'a lower bound on a duration',
      'const start = Date.now();\nexpect(Date.now() - start).toBeGreaterThan(9);\nexpect(Date.now() - start).toBeGreaterThanOrEqual(9);',
    ],
    [
      'a negated upper-bound matcher on a duration',
      'const start = Date.now();\nexpect(Date.now() - start).not.toBeLessThan(9);\nexpect(Date.now() - start).not.toBeLessThanOrEqual(9);',
    ],
    ['a single reading against a stored timestamp', 'expect(Date.now()).toBeLessThan(deadline);'],
    [
      'a duration passed through an unlisted function call',
      'const start = performance.now();\nconst wrapped = wrap(performance.now() - start);\nexpect(wrapped).toBeLessThan(5);\nexpect(wrap(performance.now() - start)).toBeLessThan(5);',
    ],
    [
      'a duration stored in an object property',
      'const start = performance.now();\nconst result = { elapsed: performance.now() - start };\nexpect(result.elapsed).toBeLessThan(5);',
    ],
    [
      'a duration stored in an array element',
      'const start = performance.now();\nconst samples = [performance.now() - start];\nexpect(samples[0]).toBeLessThan(5);',
    ],
    [
      'a parameter that would hold a duration',
      'function check(elapsed: number) {\n  expect(elapsed).toBeLessThan(5);\n}',
    ],
    [
      'a destructured binding',
      'const start = performance.now();\nconst { elapsed } = await measure(performance.now() - start);\nexpect(elapsed).toBeLessThan(5);',
    ],
    [
      'an array destructured binding',
      'const start = performance.now();\nconst [elapsed] = [performance.now() - start];\nexpect(elapsed).toBeLessThan(5);',
    ],
    [
      'a for binding',
      'const start = performance.now();\nfor (const elapsed of [performance.now() - start]) {\n  expect(elapsed).toBeLessThan(5);\n}',
    ],
    [
      'a duration compared through toBeCloseTo',
      'const start = performance.now();\nexpect(performance.now() - start).toBeCloseTo(5, 0);',
    ],
    [
      'a duration compared through a boolean',
      'const start = performance.now();\nexpect(performance.now() - start <= budget).toBe(true);',
    ],
    [
      'a duration compared through assert',
      'const start = performance.now();\nassert(performance.now() - start < 5);',
    ],
    [
      'a duration asserted with an exact matcher on a faked clock',
      'const start = Date.now();\nvi.advance(50);\nexpect(Date.now() - start).toBe(50);',
    ],
    [
      'a non-timing subtraction',
      'const remaining = total - used;\nexpect(remaining).toBeLessThan(10);',
    ],
  ])('accepts %s', (_name, source) => {
    expect(inspect(source)).toEqual([]);
  });
});

describe('test file discovery', () => {
  test('scans test files, and skips benchmark directories, bench files and generated output', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wall-clock-scan-'));
    try {
      for (const path of [
        'packages/weft/src/worker/index.test.ts',
        'packages/weft/src/worker/helper.ts',
        'components/cinder/scripts/stylelint/z-index-scale.test.ts',
        'components/cinder/scripts/benchmarks/z-index-scale.bench.ts',
        'packages/markdown/src/render.bench.ts',
        'packages/weft/scripts/benchmarks/cold-start.test.ts',
        'packages/weft/scripts/benchmarks/nested/deep.test.ts',
        'scripts/benchmarks/root.test.ts',
        'scripts/root-check.test.ts',
        'packages/markdown/src/benchmarks/not-a-scripts-directory.test.ts',
        'components/chat/node_modules/dependency/index.test.ts',
        'components/chat/.svelte-kit/generated.test.ts',
        'applications/desktop/build/bundled.test.ts',
        'packages/weft/coverage/report.test.ts',
      ]) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), '');
      }
      const paths: string[] = [];
      collectTestFiles(directory, paths);
      expect(paths.map((path) => relative(directory, path)).toSorted()).toEqual([
        'components/cinder/scripts/stylelint/z-index-scale.test.ts',
        'packages/markdown/src/benchmarks/not-a-scripts-directory.test.ts',
        'packages/weft/src/worker/index.test.ts',
        'scripts/root-check.test.ts',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
