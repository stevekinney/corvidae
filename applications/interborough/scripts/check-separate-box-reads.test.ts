import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { ALLOWED_INSTANCES, findSeparateBoxReadViolations, scan } from './check-separate-box-reads';

function inspect(source: string): number[] {
  const parsed = ts.createSourceFile('fixture.spec.ts', source, ts.ScriptTarget.Latest, true);
  return findSeparateBoxReadViolations(parsed).map((violation) => violation.line);
}

describe('comparisons across separate box reads', () => {
  test.each([
    [
      'two reads, one comparison',
      'const a = await first.boundingBox();\nconst b = await second.boundingBox();\nexpect(a!.y).toBe(b!.y);',
    ],
    [
      'two reads in one expression',
      'expect((await first.boundingBox())!.y).toBe((await second.boundingBox())!.y);',
    ],
    [
      'reads gathered by Promise.all and compared',
      'const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()]);\nexpect(a!.y).toBe(b!.y);',
    ],
    [
      'rects read by separate evaluates',
      'const a = await first.evaluate((e) => e.getBoundingClientRect());\nconst b = await second.evaluate((e) => e.getBoundingClientRect());\nexpect(a.y).toBe(b.y);',
    ],
  ])('flags %s', (_name, body) => {
    const lines = inspect(`test('x', async () => {\n${body}\n});`);
    expect(lines).toHaveLength(1);
  });

  test('names the line of the comparison', () => {
    const lines = inspect(
      "test('x', async () => {\nconst a = await first.boundingBox();\nconst b = await second.boundingBox();\nexpect(a!.y).toBe(b!.y);\n});",
    );
    expect(lines).toEqual([4]);
  });

  test('flags a derived value once, at its declaration', () => {
    const lines = inspect(
      "test('x', async () => {\nconst a = await first.boundingBox();\nconst b = await second.boundingBox();\nconst gap = b!.y - a!.y;\nexpect(gap).toBeLessThan(4);\nexpect(gap).toBeGreaterThan(0);\n});",
    );
    expect(lines).toEqual([4]);
  });

  test.each([
    [
      'reads made by a map callback and compared',
      'const tops = await Promise.all([a, b].map(async (l) => (await l.boundingBox())!.y));\nexpect(tops[0]).toBeLessThan(tops[1]!);',
    ],
    [
      'a return that compares two reads',
      'const a = await first.boundingBox();\nconst b = await second.boundingBox();\nreturn a!.y >= b!.y;',
    ],
  ])('flags %s', (_name, body) => {
    expect(inspect(`test('x', async () => {\n${body}\n});`)).toHaveLength(1);
  });

  test.each([
    [
      'one box of a Promise.all pair on its own',
      'const [a, b] = await Promise.all([first.boundingBox(), second.boundingBox()]);\nexpect(a!.width).toBeGreaterThan(10);\nexpect(b!.width).toBeGreaterThan(10);',
    ],
    [
      'a null check of two reads',
      'const a = await first.boundingBox();\nconst b = await second.boundingBox();\nif (a === null || b === null) throw new Error("missing");',
    ],
    [
      'one readBoxes call',
      'await expect(row).toBeFocused();\nconst { deny, approve } = await readBoxes(page, { deny: first, approve: second });\nexpect(deny.y).toBe(approve.y);',
    ],
    [
      'two reads that are never compared',
      'const a = await first.boundingBox();\nconst b = await second.boundingBox();\nexpect(a!.width).toBeGreaterThan(10);\nexpect(b!.width).toBeGreaterThan(10);',
    ],
    [
      'one read compared with a constant',
      'const a = await first.boundingBox();\nexpect(a!.y + a!.height).toBeLessThan(800);',
    ],
    [
      'the same name reused in another test',
      "test('one', async () => {\nconst box = await first.boundingBox();\nexpect(box!.y).toBe(1);\n});\ntest('two', async () => {\nconst box = await second.boundingBox();\nexpect(box!.y).toBe(2);\n});",
    ],
  ])('accepts %s', (_name, body) => {
    expect(inspect(`test('x', async () => {\n${body}\n});`)).toEqual([]);
  });
});

describe('the allowlist', () => {
  test('is exactly what the specs hold, so it only shrinks', async () => {
    const results = await scan();
    const found = Object.fromEntries(
      results.map(({ file, violations }) => [file, violations.length]),
    );
    const allowed = Object.fromEntries(
      Object.entries(ALLOWED_INSTANCES).map(([file, { count }]) => [file, count]),
    );
    expect(found).toEqual(allowed);
  });

  test('gives every entry a reason', () => {
    for (const entry of Object.values(ALLOWED_INSTANCES)) expect(entry.reason).not.toBe('');
  });
});
