/**
 * Standalone reproduction for two Bun coverage defects behind COR-1513. It depends on nothing in
 * this workspace: run it with `bun testing/testing/scripts/bun-isolated-coverage-reproduction.ts`.
 *
 * A `Bun.plugin` `onLoad` hook returns generated JavaScript whose lines differ from the authored
 * file, the way the Svelte compiler's output does, and attaches a correct inline source map. Two
 * test files import the generated module, each covering a different branch.
 *
 * Defect 1: with `--parallel=1` (which implies `--isolate`), each test file gets its own module
 * instance, but the lcov report keeps the counts of only one instance instead of merging them.
 * Defect 2: lcov line numbers are generated-output lines. The inline `sourceMappingURL` that the
 * plugin returned (and an equivalent external one) is ignored, so `DA` lines exceed the file.
 *
 * The script exits 1 when either defect is present and 0 when Bun has fixed both.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_TIMEOUT_ARGUMENT } from '../../../scripts/test-deadlines.ts';

const PAD_LINES = 10;

const authoredModule = `export function pick(flag) {
  if (flag) {
    return 'yes';
  }
  return 'no';
}
`;

const preload = `
import { plugin } from 'bun';
plugin({
  name: 'generated-lines',
  setup(builder) {
    builder.onLoad({ filter: /\\.generated$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const lines = source.split('\\n');
      // Generated line N + ${PAD_LINES} maps to authored line N, column 0.
      const mappings = ';'.repeat(${PAD_LINES}) + lines.map((_, index) => (index === 0 ? 'AAAA' : 'AACA')).join(';');
      const map = { version: 3, sources: [path], sourcesContent: [source], names: [], mappings };
      const encoded = Buffer.from(JSON.stringify(map)).toString('base64');
      return {
        contents: '// generated\\n'.repeat(${PAD_LINES}) + source + '\\n//# sourceMappingURL=data:application/json;base64,' + encoded + '\\n',
        loader: 'js',
      };
    });
  },
});
`;

const testFile = (name: string, argument: string, expected: string) => `
import { expect, test } from 'bun:test';
import { pick } from './module.generated';
test('${name}', () => { expect(pick(${argument})).toBe('${expected}'); });
`;

async function coverageFor(directory: string, flags: string[]): Promise<Map<number, number>> {
  const process = Bun.spawn(
    [
      'bun',
      'test',
      TEST_TIMEOUT_ARGUMENT,
      ...flags,
      '--preload',
      './preload.ts',
      '--coverage',
      '--coverage-reporter=lcov',
      'a.test.ts',
      'b.test.ts',
    ],
    { cwd: directory, stdout: 'pipe', stderr: 'pipe' },
  );
  await process.exited;
  const lcov = await Bun.file(join(directory, 'coverage', 'lcov.info')).text();
  const record = lcov.split('end_of_record').find((entry) => entry.includes('module.generated'));
  const hits = new Map<number, number>();
  for (const line of (record ?? '').split('\n')) {
    const match = /^DA:(\d+),(\d+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined)
      hits.set(Number(match[1]), Number(match[2]));
  }
  return hits;
}

const directory = await mkdtemp(join(tmpdir(), 'bun-isolated-coverage-'));
try {
  await Bun.write(join(directory, 'module.generated'), authoredModule);
  await Bun.write(join(directory, 'preload.ts'), preload);
  // a.test.ts takes the `true` branch and b.test.ts takes the `false` branch.
  await Bun.write(join(directory, 'a.test.ts'), testFile('a', 'true', 'yes'));
  await Bun.write(join(directory, 'b.test.ts'), testFile('b', 'false', 'no'));

  const authoredLength = authoredModule.split('\n').length - 1;
  const returnYes = PAD_LINES + 3;
  const returnNo = PAD_LINES + 5;
  let defective = false;

  for (const [label, flags] of [
    ['shared module registry (no isolation)', []],
    ['--parallel=1 (isolated, one module instance per file)', ['--parallel=1']],
  ] as const) {
    const hits = await coverageFor(directory, [...flags]);
    const merged = (hits.get(returnYes) ?? 0) > 0 && (hits.get(returnNo) ?? 0) > 0;
    const beyondFile = [...hits.keys()].filter((line) => line > authoredLength);
    console.log(`${label}:`);
    console.log(`  both branches counted: ${merged}  (expected true)`);
    console.log(
      `  DA lines beyond the ${authoredLength}-line authored file: ${beyondFile.length}  (expected 0)`,
    );
    if (flags.length > 0 && !merged) defective = true;
    if (beyondFile.length > 0) defective = true;
  }

  console.log(
    defective ? 'Bun coverage defect reproduced.' : 'No defect: Bun merged and remapped.',
  );
  process.exitCode = defective ? 1 : 0;
} finally {
  await rm(directory, { recursive: true, force: true });
}
