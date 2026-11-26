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
import { freemem } from 'node:os';
import { join, relative } from 'node:path';

import {
  rootAdmits,
  selectedFilesFor,
  SELECTION_VARIABLE,
  splitBunTestArguments,
} from '../../../scripts/affected-tests-manifest.ts';
import { rootScriptEnvironment } from '../../../scripts/environment-configuration.ts';
import { readMemory } from '../../../scripts/run-exclusively.ts';

/** How many `bun test` processes the UI suite is spread over. */
export const SHARD_COUNT = 4;

/**
 * How long a shard may write nothing before the run is treated as hung. Every test already has the
 * 120-second awake-time hang guard, so ten silent minutes means something outside any one test's
 * deadline has stopped, such as a synchronous loop that starves the guard's timer. This is a hang
 * detector, not a performance bound: a healthy shard writes a result line for every file it runs.
 */
export const SHARD_SILENCE_LIMIT_MS = 10 * 60_000;

/**
 * The available memory below which the run writes one snapshot of every shard, and keeps running. On
 * 2026-11-25 the CI runner was lost after about 46 minutes in four of nine runs, leaving no log, so a
 * snapshot written while there is still memory says which shard was where if the runner then dies.
 * Low memory alone is not a failure: a healthy run on 2026-11-26 dipped to 250 MiB available and
 * passed every test, so stopping at this floor failed a good run.
 */
export const MINIMUM_FREE_MEMORY_BYTES = 512 * 1024 * 1024;

/**
 * The memory the kernel can hand out without swapping, in bytes: `MemAvailable` on Linux, through
 * the reader the host lock uses, not `os.freemem()`, which leaves out the page cache the kernel
 * reclaims on demand. Where no reading is possible it falls back to `os.freemem()`.
 */
function availableMemory(): number {
  return readMemory()?.availableBytes ?? freemem();
}

/**
 * How often the watchdog checks each shard's silence and the free memory. Silence is counted in
 * awake time, the way the repository's hang guard counts it: each check credits at most this much,
 * so a laptop that sleeps through the suite resumes with one interval credited, not the whole nap.
 */
export const WATCH_INTERVAL_MS = 15_000;

/**
 * How long, in awake time, a stopped shard has to end after SIGTERM before it is sent SIGKILL. The
 * shard is `scripts/bun-test-junit.ts`, which runs its tests in their own process group and forwards
 * SIGTERM to that group, then ends what is left of it; SIGKILL skips that, so it comes only when
 * SIGTERM did not end the wrapper.
 */
export const STOP_GRACE_MS = 2 * WATCH_INTERVAL_MS;

/** How many of a shard's last output lines a hang report quotes. */
const REPORT_TAIL_LINES = 40;

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
  /** The clock the watchdog reads, in milliseconds. Each check credits at most one interval. */
  now?: () => number;
  /** Runs `check` every `milliseconds` until the returned function is called. */
  every?: (milliseconds: number, check: () => void) => () => void;
  /** The host's free memory in bytes. */
  freeMemory?: () => number;
}

/** A running shard's output as it arrives, and how much awake time it has been silent. */
export interface ShardWatch {
  readonly number: number;
  readonly child: ShardProcess;
  output: string;
  silentFor: number;
  finished: boolean;
}

/** One stream's text so far, kept so a stopped shard's partial output can still be written. */
interface StreamText {
  text: string;
}

/** Reads a stream to its end, appending each chunk to the shard's output as it arrives. */
async function collect(
  stream: ReadableStream<Uint8Array>,
  watch: ShardWatch,
  into: StreamText,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const piece = decoder.decode(chunk, { stream: true });
    into.text += piece;
    watch.output += piece;
    watch.silentFor = 0;
  }
  const rest = decoder.decode();
  into.text += rest;
  watch.output += rest;
}

/**
 * The report a stopped run, or a low-memory snapshot, writes: why, what it does next, the free memory,
 * and each unfinished shard's silence and last lines, so a hang names the file it was in.
 */
export function hangReport(
  reason: string,
  watches: readonly ShardWatch[],
  freeBytes: number,
  action = 'stopping every shard',
): string {
  const lines = [
    `run-ui-shards: ${reason}; ${action}. Free memory: ${Math.round(freeBytes / 1024 / 1024)} MiB.`,
  ];
  for (const watch of watches) {
    if (watch.finished) continue;
    const silentSeconds = Math.round(watch.silentFor / 1000);
    const tail = watch.output.trimEnd().split('\n').slice(-REPORT_TAIL_LINES).join('\n');
    lines.push(
      `--- ui shard ${watch.number}: still running, silent for ${silentSeconds} s; its last output ---`,
      tail === '' ? '(no output yet)' : tail,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** `setInterval`, returning its own cancel. */
function everyWithInterval(milliseconds: number, check: () => void): () => void {
  const handle = setInterval(check, milliseconds);
  return () => clearInterval(handle);
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
    now = () => performance.now(),
    every = everyWithInterval,
    freeMemory = availableMemory,
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

  const watches: ShardWatch[] = [];
  let markStopped: () => void = () => undefined;
  const whenStopped = new Promise<void>((resolve) => (markStopped = resolve));
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
    const watch: ShardWatch = {
      number: index + 1,
      child,
      output: '',
      silentFor: 0,
      finished: false,
    };
    watches.push(watch);
    // A shard's output is held until it finishes, so concurrent runs never interleave lines; the
    // watchdog reads it as it arrives.
    return [
      (async () => {
        const standardOutput: StreamText = { text: '' };
        const standardError: StreamText = { text: '' };
        const streams = Promise.all([
          collect(child.stdout, watch, standardOutput),
          collect(child.stderr, watch, standardError),
        ]);
        const exitCode = await child.exited;
        // A stopped shard's tests may outlive it and hold its pipes open, so once the run is
        // stopped, the shard's exit is the end of its output.
        await Promise.race([streams, whenStopped]);
        watch.finished = true;
        children.delete(child);
        writeStandardOutput(
          `\n--- ui shard ${index + 1}/${shards.length}: ${shardFiles.length} files, exit ${exitCode} ---\n${standardOutput.text}`,
        );
        writeStandardError(standardError.text);
        return exitCode;
      })(),
    ];
  });

  // A hang stops the run with a report instead of running until the host gives out: SIGTERM first,
  // which each shard forwards to its tests' process group, and SIGKILL once the grace has passed.
  let stopped = false;
  let sinceStop = 0;
  const stop = (reason: string) => {
    if (stopped) return;
    stopped = true;
    markStopped();
    writeStandardError(hangReport(reason, watches, freeMemory()));
    for (const child of children) child.kill('SIGTERM');
  };
  let snapshotWritten = false;
  let lastCheck = now();
  const cancel = every(WATCH_INTERVAL_MS, () => {
    const at = now();
    const credit = Math.min(Math.max(0, at - lastCheck), WATCH_INTERVAL_MS);
    lastCheck = at;
    if (stopped) {
      sinceStop += credit;
      if (sinceStop >= STOP_GRACE_MS) for (const child of children) child.kill('SIGKILL');
      return;
    }
    for (const watch of watches) if (!watch.finished) watch.silentFor += credit;
    const silent = watches.find(
      (watch) => !watch.finished && watch.silentFor >= SHARD_SILENCE_LIMIT_MS,
    );
    if (silent !== undefined) {
      stop(
        `ui shard ${silent.number} wrote nothing for ${Math.round(SHARD_SILENCE_LIMIT_MS / 60_000)} minutes`,
      );
      return;
    }
    const freeBytes = freeMemory();
    if (snapshotWritten || freeBytes >= MINIMUM_FREE_MEMORY_BYTES) return;
    snapshotWritten = true;
    writeStandardError(
      hangReport(
        `free memory fell to ${Math.round(freeBytes / 1024 / 1024)} MiB`,
        watches,
        freeBytes,
        'still running, this is where each shard was',
      ),
    );
  });
  const exitCodes = await Promise.all(runs);
  cancel();
  if (stopped) return 1;
  return exitCodes.find((code) => code !== 0) ?? 0;
}

// `exitCode` rather than `process.exit()`, so a failing run's output reaches a pipe in full.
if (import.meta.main) process.exitCode = await runUiShards(Bun.argv.slice(2));
