/**
 * Run Weft's measurement benchmarks: every `*.bench.ts` file directly under `scripts/benchmarks/`.
 *
 * `bun run --filter=@lostgradient/weft test:benchmarks` is this script. A benchmark is told apart
 * from a test by its file name alone: Bun's default discovery never picks up a `*.bench.ts`, so
 * `bun run test` (and the coverage shard) cannot run one, and this script is the only place that
 * does. There is no list to keep in step. Adding `scripts/benchmarks/<name>.bench.ts` adds it to
 * this run, and naming a measurement `<name>.test.ts` puts it in the gate, where
 * `scripts/check-wall-clock-assertions.ts` scans it.
 *
 * Usage: `bun scripts/run-benchmarks.ts`
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEFT_ROOT = join(import.meta.dir, '..');
const BENCHMARKS_DIRECTORY = join(import.meta.dir, 'benchmarks');
const BUN_TEST_WRAPPER = join(WEFT_ROOT, '..', '..', 'scripts', 'bun-test.ts');

/** The benchmark files, as `./`-prefixed paths relative to the package root, in sorted order. */
export function listBenchmarkFiles(directory: string = BENCHMARKS_DIRECTORY): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.bench.ts'))
    .map((entry) => `./${relative(WEFT_ROOT, join(directory, entry.name))}`)
    .toSorted();
}

/** Spawns the `bun` child that runs the benchmark files, and resolves to its exit code. */
export type SpawnBenchmarkRun = (command: string[]) => Promise<number>;

/** The default {@link SpawnBenchmarkRun}: run `command` in the Weft root and return its exit code. */
export const spawnBunTest: SpawnBenchmarkRun = async (command) => {
  const child = Bun.spawn(command, {
    cwd: WEFT_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  return await child.exited;
};

/**
 * Run every benchmark file through the shared `bun test` wrapper and return the exit code: the
 * child's, or 1 when the directory holds no `*.bench.ts` (a glob that matches nothing must fail
 * rather than pass without running a measurement).
 */
export async function runBenchmarks(
  spawn: SpawnBenchmarkRun = spawnBunTest,
  directory: string = BENCHMARKS_DIRECTORY,
): Promise<number> {
  const files = listBenchmarkFiles(directory);
  if (files.length === 0) {
    process.stderr.write(`run-benchmarks: no *.bench.ts files found in ${directory}.\n`);
    return 1;
  }
  return await spawn(['bun', BUN_TEST_WRAPPER, ...files]);
}

if (import.meta.main) process.exitCode = await runBenchmarks();
