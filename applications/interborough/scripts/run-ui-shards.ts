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
  currentWorkspaceDirectory,
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

function removeStaleReports(): void {
  if (!existsSync(JUNIT_DIRECTORY)) return;
  for (const name of readdirSync(JUNIT_DIRECTORY)) {
    // `ui.xml` is the single-process report this script replaced.
    if (name === 'ui.xml' || /^ui-\d+\.xml$/.test(name)) {
      rmSync(join(JUNIT_DIRECTORY, name), { force: true });
    }
  }
}

async function main(argumentsList: readonly string[]): Promise<number> {
  const { flags, roots, ignorePatterns } = splitBunTestArguments(argumentsList);
  const environment = rootScriptEnvironment();
  const discovered = discoverTestFiles(PACKAGE_ROOT, roots, ignorePatterns);
  const files = narrowToSelection(
    discovered,
    selectedFilesFor(environment, currentWorkspaceDirectory(), REPOSITORY_ROOT),
  );
  mkdirSync(JUNIT_DIRECTORY, { recursive: true });
  removeStaleReports();
  if (files.length === 0) {
    process.stdout.write(
      'run-ui-shards: no UI test file is reachable from the change; nothing to run.\n',
    );
    return 0;
  }

  // Each shard has its own list already; a second narrowing by the selection would only repeat it.
  const shardEnvironment: Record<string, string | undefined> = { ...environment };
  delete shardEnvironment[SELECTION_VARIABLE];

  const wrapper = join(REPOSITORY_ROOT, 'scripts', 'bun-test-junit.ts');
  const shards = partitionIntoShards(files);
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      for (const child of children) child.kill(signal);
    });
  }

  const runs = shards.flatMap((shardFiles, index) => {
    if (shardFiles.length === 0) return [];
    const label = `ui shard ${index + 1}/${shards.length}`;
    const child = Bun.spawn(
      [
        'bun',
        wrapper,
        `--report-name=${shardReportName(index + 1)}`,
        ...flags,
        ...shardFiles.map((file) => `./${file}`),
      ],
      { cwd: PACKAGE_ROOT, env: shardEnvironment, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
    );
    children.add(child);
    // A shard's output is held until it finishes, so four concurrent runs never interleave lines.
    return [
      (async () => {
        const [standardOutput, standardError, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        children.delete(child);
        process.stdout.write(`\n--- ${label}: ${shardFiles.length} files, exit ${exitCode} ---\n`);
        process.stdout.write(standardOutput);
        process.stderr.write(standardError);
        return exitCode;
      })(),
    ];
  });
  const exitCodes = await Promise.all(runs);
  return exitCodes.find((code) => code !== 0) ?? 0;
}

if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
