/**
 * Runs the UI half of `test` as four serial `bun test` processes at once.
 *
 * The UI suite cannot use `bun test --parallel`: Bun 1.4.2's workers load the default `bunfig.toml`
 * preload on top of the one `--config` names, so the tests would run under both (see
 * `bunfig.ui.toml`). It also has to stay in one process per file group, because Svelte components
 * that two files share would otherwise be instrumented twice. Sharding by process keeps both
 * properties: each shard is an ordinary serial run under `bunfig.ui.toml`, and the shards overlap.
 *
 * `package.json` passes this script the same arguments the single run took, and the script reads
 * them the way `scripts/affected-tests-manifest.ts` does: the positional arguments are the roots to
 * search, `--path-ignore-patterns` removes files, and every other flag goes to each shard. It
 * discovers the matching test files, narrows them to the files `CORVIDAE_TEST_SELECTION` selected
 * for this workspace (an empty selection runs nothing), sorts them, and gives file `i` to shard
 * `i % 4`. Every file therefore runs in exactly one shard. Each shard goes through
 * `scripts/bun-test-junit.ts`, so it carries the shared per-test deadline and writes
 * `test-output/junit/ui-<n>.xml`, which `scripts/check-test-durations.ts` reads with every other
 * report in that directory.
 *
 * The coverage run (`scripts/run-coverage.ts`) deliberately stays one process, in a fixed order.
 *
 * Usage: `bun scripts/run-ui-shards.ts <bun test arguments>`
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  rootAdmits,
  selectedFilesFor,
  SELECTION_VARIABLE,
  splitBunTestArguments,
} from '../../../scripts/affected-tests-manifest.ts';
import { rootScriptEnvironment } from '../../../scripts/environment-configuration.ts';

/** How many `bun test` processes the UI suite is spread over. */
export const SHARD_COUNT = 4;

const PACKAGE_ROOT = join(import.meta.dir, '..');
const REPOSITORY_ROOT = join(PACKAGE_ROOT, '..', '..');
const JUNIT_DIRECTORY = join('test-output', 'junit');
const BUN_TEST_FILE_PATTERN = /(?:\.test|_test|\.spec|_spec)\.(?:[cm]?[jt]s|[jt]sx)$/;

/** The report a shard writes, relative to the package root. */
export function shardReportName(shardNumber: number): string {
  return `ui-${shardNumber}`;
}

/**
 * Every test file under the roots a `bun test` command line names, relative to `directory`, sorted,
 * minus the files its ignore patterns match. A positional argument that names neither a directory
 * nor a file in `directory` is a filter, and `rootAdmits` applies it to the files found.
 */
export function discoverTestFiles(
  directory: string,
  roots: readonly string[],
  ignorePatterns: readonly string[],
): string[] {
  const ignored = ignorePatterns.map((pattern) => new Bun.Glob(pattern));
  const found = new Set<string>();
  const searched = roots.length === 0 ? ['.'] : roots;
  for (const root of searched) {
    const path = join(directory, root);
    if (!existsSync(path)) continue;
    const files = statSync(path).isDirectory()
      ? readdirSync(path, { recursive: true, encoding: 'utf8' }).map((entry) =>
          relative(directory, join(path, entry)),
        )
      : [relative(directory, path)];
    for (const file of files) {
      if (file.split('/').includes('node_modules')) continue;
      if (!BUN_TEST_FILE_PATTERN.test(file)) continue;
      if (!statSync(join(directory, file)).isFile()) continue;
      if (!rootAdmits(root, file)) continue;
      if (ignored.some((glob) => glob.match(file))) continue;
      found.add(file);
    }
  }
  return [...found].toSorted();
}

/**
 * The files to run: every discovered file when no selection is in force or the selector chose the
 * whole workspace, otherwise only the discovered files the selection lists.
 */
export function narrowToSelection(
  discovered: readonly string[],
  selected: readonly string[] | 'all' | null,
): string[] {
  if (selected === null || selected === 'all') return [...discovered];
  const chosen = new Set(selected.map((file) => file.replace(/^\.\//, '')));
  return discovered.filter((file) => chosen.has(file));
}

/**
 * Deal the sorted files out round-robin: file `i` goes to shard `i % shardCount`. The result always
 * has `shardCount` entries, some of them empty, and every file appears in exactly one.
 */
export function partitionIntoShards(
  files: readonly string[],
  shardCount: number = SHARD_COUNT,
): string[][] {
  const shards: string[][] = Array.from({ length: shardCount }, () => []);
  for (const [index, file] of files.toSorted().entries()) {
    shards[index % shardCount]?.push(file);
  }
  return shards;
}

function removeStaleReports(reportDirectory: string): void {
  if (!existsSync(reportDirectory)) return;
  for (const name of readdirSync(reportDirectory)) {
    // `ui.xml` is the single-process report this script replaced.
    if (name === 'ui.xml' || /^ui-\d+\.xml$/.test(name)) {
      rmSync(join(reportDirectory, name), { force: true });
    }
  }
}

/** The part of a `Bun.spawn` child this script reads, so a test can stand in for the process. */
export interface ShardProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

/** `Bun.spawn`, as far as this script uses it. */
export type SpawnShard = (
  command: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stdout: 'pipe';
    stderr: 'pipe';
    stdin: 'ignore';
  },
) => ShardProcess;

/**
 * What {@link runUiShards} touches outside its arguments: the package, the environment, the
 * process table, and output. Each defaults to the real thing; a test supplies its own.
 */
export interface ShardRunDependencies {
  packageRoot?: string;
  repositoryRoot?: string;
  environment?: Record<string, string | undefined>;
  spawn?: SpawnShard;
  /** `process.on`: how the run learns that it is being stopped. */
  subscribe?: (signal: NodeJS.Signals, handler: () => void) => unknown;
  writeStandardOutput?: (text: string) => unknown;
  writeStandardError?: (text: string) => unknown;
}

/** Stop every running shard when the run is interrupted or terminated, so none is orphaned. */
export function forwardStopSignals(
  children: ReadonlySet<ShardProcess>,
  subscribe: NonNullable<ShardRunDependencies['subscribe']>,
): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    subscribe(signal, () => {
      for (const child of children) child.kill(signal);
    });
  }
}

/**
 * Discover, narrow, partition, and run the UI test files, and return the exit code: the first
 * nonzero code a shard returned, or zero.
 */
export async function runUiShards(
  argumentsList: readonly string[],
  dependencies: ShardRunDependencies = {},
): Promise<number> {
  const {
    packageRoot = PACKAGE_ROOT,
    repositoryRoot = REPOSITORY_ROOT,
    environment = rootScriptEnvironment(),
    spawn = Bun.spawn as unknown as SpawnShard,
    subscribe = process.on.bind(process),
    writeStandardOutput = process.stdout.write.bind(process.stdout),
    writeStandardError = process.stderr.write.bind(process.stderr),
  } = dependencies;
  const { flags, roots, ignorePatterns } = splitBunTestArguments(argumentsList);
  const files = narrowToSelection(
    discoverTestFiles(packageRoot, roots, ignorePatterns),
    selectedFilesFor(environment, relative(repositoryRoot, packageRoot), repositoryRoot),
  );
  const reportDirectory = join(packageRoot, JUNIT_DIRECTORY);
  mkdirSync(reportDirectory, { recursive: true });
  removeStaleReports(reportDirectory);
  if (files.length === 0) {
    writeStandardOutput(
      'run-ui-shards: no UI test file is reachable from the change; nothing to run.\n',
    );
    return 0;
  }

  // Each shard has its own list already; a second narrowing by the selection would only repeat it.
  const shardEnvironment: Record<string, string | undefined> = { ...environment };
  delete shardEnvironment[SELECTION_VARIABLE];

  const wrapper = join(repositoryRoot, 'scripts', 'bun-test-junit.ts');
  const shards = partitionIntoShards(files);
  const children = new Set<ShardProcess>();
  forwardStopSignals(children, subscribe);

  const runs = shards.flatMap((shardFiles, index) => {
    if (shardFiles.length === 0) return [];
    const child = spawn(
      [
        'bun',
        wrapper,
        `--report-name=${shardReportName(index + 1)}`,
        ...flags,
        ...shardFiles.map((file) => `./${file}`),
      ],
      { cwd: packageRoot, env: shardEnvironment, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
    );
    children.add(child);
    // A shard's output is held until it finishes, so concurrent runs never interleave lines.
    return [
      (async () => {
        const [standardOutput, standardError, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        children.delete(child);
        writeStandardOutput(
          `\n--- ui shard ${index + 1}/${shards.length}: ${shardFiles.length} files, exit ${exitCode} ---\n${standardOutput}`,
        );
        writeStandardError(standardError);
        return exitCode;
      })(),
    ];
  });
  const exitCodes = await Promise.all(runs);
  return exitCodes.find((code) => code !== 0) ?? 0;
}

// `exitCode` rather than `process.exit()`, so a failing run's output reaches a pipe in full.
if (import.meta.main) process.exitCode = await runUiShards(Bun.argv.slice(2));
