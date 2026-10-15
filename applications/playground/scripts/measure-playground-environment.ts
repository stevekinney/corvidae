/**
 * The pinned environment and host-load record for `measure-playground.ts` (CIN-585).
 *
 * The host these measurements run on is shared with other agent sessions, so every sample carries
 * the load averages and logical processor count observed when it started, and the decision
 * document reads each variability band against them.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { arch, availableParallelism, cpus, loadavg, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';

import { readEnvironmentConfiguration } from '../src/environment-configuration.ts';
import { captureMemoryPressure, type MemoryPressure } from './measure-playground-memory.ts';

export type LoadAverages = { oneMinute: number; fiveMinutes: number; fifteenMinutes: number };

/** Parse the load averages from macOS (`load averages: a b c`) or Linux (`load average: a, b, c`) `uptime`. */
export function parseLoadAverages(uptimeOutput: string): LoadAverages | null {
  const match = /load averages?:\s*([\d.]+),?\s+([\d.]+),?\s+([\d.]+)/u.exec(uptimeOutput);
  if (match === null) return null;
  return {
    oneMinute: Number(match[1]),
    fiveMinutes: Number(match[2]),
    fifteenMinutes: Number(match[3]),
  };
}

/**
 * Interpret a cgroup v2 `memory.max` value. `max` means the container sets no limit; a number is
 * the limit in bytes.
 */
export function parseContainerMemoryLimit(
  value: string,
): { limited: false } | { limited: true; bytes: number } {
  const trimmed = value.trim();
  if (trimmed === 'max' || trimmed === '') return { limited: false };
  const bytes = Number(trimmed);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new RangeError(`Unrecognized cgroup memory.max value: ${JSON.stringify(trimmed)}`);
  }
  return { limited: true, bytes };
}

export type HostLoad = {
  capturedAt: string;
  uptime: string;
  loadAverages: LoadAverages;
  logicalProcessors: number;
  /** Host memory pressure at the same moment; absent from results recorded before it existed. */
  memory?: MemoryPressure;
};

/** Run `uptime` and record its load averages next to the logical processor count. */
export function captureHostLoad(): HostLoad {
  const result = Bun.spawnSync(['uptime'], { stdout: 'pipe', stderr: 'ignore' });
  const uptime = result.stdout.toString().trim();
  const parsed = parseLoadAverages(uptime);
  const [oneMinute, fiveMinutes, fifteenMinutes] = loadavg();
  return {
    capturedAt: new Date().toISOString(),
    uptime,
    loadAverages: parsed ?? {
      oneMinute: oneMinute ?? 0,
      fiveMinutes: fiveMinutes ?? 0,
      fifteenMinutes: fifteenMinutes ?? 0,
    },
    logicalProcessors: availableParallelism(),
    memory: captureMemoryPressure(),
  };
}

/**
 * Forced on every measured child, so the parent's environment cannot change what is measured.
 * Every variable the Playground's configuration reader registers is listed: the harness removes
 * them all (undefined), then sets the ones a phase needs explicitly (the export's base URL, the
 * server's port and port file). `NODE_ENV` selects development or production Svelte compilation
 * (`playground-svelte-plugin.ts`); removing it is how `bun run build` runs from a clean shell.
 * `CINDER_TEST_COMPONENTS` is set empty, the server's every-component default, so an inherited value
 * cannot narrow the eager prebuild. A test fails if the reader registers a variable missing here.
 */
export const NORMALIZED_CHILD_ENVIRONMENT: Readonly<Record<string, string | undefined>> = {
  CINDER_TEST_COMPONENTS: '',
  NODE_ENV: undefined,
  PLAYGROUND_BASE_URL: undefined,
  PLAYGROUND_LIFECYCLE_REQUIRE_REAPED: undefined,
  PLAYGROUND_PORT_FILE: undefined,
  PLAYGROUND_STATIC_BASE_URL: undefined,
  PLAYGROUND_STATIC_CASES: undefined,
  PLAYGROUND_STATIC_RESULTS: undefined,
  PLAYGROUND_STATIC_SCRATCH: undefined,
  PLAYGROUND_STATIC_SCREENSHOTS: undefined,
  PORT: undefined,
  VERCEL_GIT_COMMIT_SHA: undefined,
};

/** The normalized environment as a result file records it: null means removed. */
export function recordedChildEnvironment(): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(NORMALIZED_CHILD_ENVIRONMENT).map(([name, value]) => [name, value ?? null]),
  );
}

/** Whether the one-minute load is above `factor` times the logical processor count. */
export function loadExceedsLimit(load: HostLoad, factor: number): boolean {
  return load.loadAverages.oneMinute > factor * load.logicalProcessors;
}

export type LoadWait = {
  /** The one-minute load average a sample may start under: factor x logical processors. */
  /** The one-minute load a sample was held below, or null when the gate only records. */
  thresholdOneMinute: number | null;
  waitedMilliseconds: number;
  checks: number;
  loadAtStart: HostLoad;
};

export type LoadWaitOptions = {
  capture?: () => HostLoad;
  sleep?: (milliseconds: number) => Promise<unknown>;
  now?: () => number;
  intervalMilliseconds?: number;
  report?: (load: HostLoad, threshold: number) => void;
};

/**
 * Hold a sample until the one-minute load is at or below `factor` times the logical processors.
 * There is no deadline: a sample is never recorded into extreme load, and the wait is recorded.
 */
export async function waitForSettledLoad(
  factor: number | undefined,
  options: LoadWaitOptions = {},
): Promise<LoadWait> {
  const capture = options.capture ?? captureHostLoad;
  // Record-only by default: host load never blocks a measurement. The load, logical processors,
  // and memory pressure are recorded with the sample instead (CIN-588).
  if (factor === undefined) {
    return { thresholdOneMinute: null, waitedMilliseconds: 0, checks: 1, loadAtStart: capture() };
  }
  const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const now = options.now ?? (() => performance.now());
  const intervalMilliseconds = options.intervalMilliseconds ?? 30_000;
  const startedAt = now();
  let checks = 1;
  let load = capture();
  while (loadExceedsLimit(load, factor)) {
    options.report?.(load, factor * load.logicalProcessors);
    await sleep(intervalMilliseconds);
    checks += 1;
    load = capture();
  }
  return {
    thresholdOneMinute: factor * load.logicalProcessors,
    waitedMilliseconds: now() - startedAt,
    checks,
    loadAtStart: load,
  };
}

function git(repositoryRoot: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', repositoryRoot, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

export type SourceState = {
  sourceSha: string;
  /** Tracked paths that differ from HEAD; non-empty while a candidate patch is applied. */
  dirtyPaths: string[];
  /** Untracked, non-ignored paths. They can change what is built (a new example, for one). */
  untrackedPaths: string[];
  /** SHA-256 of `git diff HEAD`, so a sample names the exact patch it ran against. */
  workingTreeDiffSha256: string | null;
  /**
   * SHA-256 over the path and contents of every untracked, non-ignored file, or null when there
   * are none. Absent from results recorded before it existed.
   */
  untrackedSha256?: string | null;
};

/** Hash the path and contents of every untracked, non-ignored file in sorted order. */
export function untrackedContentSha256(
  repositoryRoot: string,
  excludedPaths: readonly string[] = [],
): string | null {
  const paths = git(repositoryRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    ...pathspec(excludedPaths),
  ])
    .split('\0')
    .filter((path) => path !== '')
    .toSorted();
  if (paths.length === 0) return null;
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path).update('\0');
    hash.update(readFileSync(join(repositoryRoot, path))).update('\0');
  }
  return hash.digest('hex');
}

/** Split `git status --porcelain` lines into tracked changes and untracked paths. */
export function partitionPorcelainStatus(porcelain: string): {
  dirtyPaths: string[];
  untrackedPaths: string[];
} {
  const lines = porcelain.split('\n').filter((line) => line.trim() !== '');
  return {
    dirtyPaths: lines.filter((line) => !line.startsWith('?? ')).map((line) => line.slice(3)),
    untrackedPaths: lines.filter((line) => line.startsWith('?? ')).map((line) => line.slice(3)),
  };
}

/**
 * A pathspec for the whole repository minus `excludedPaths` (repository-relative), so a run's own
 * results never become part of the source it measured.
 */
function pathspec(excludedPaths: readonly string[]): string[] {
  return ['--', '.', ...excludedPaths.map((path) => `:(exclude)${path}`)];
}

/**
 * Fingerprint the working tree: HEAD, tracked changes, and untracked content, all without
 * `excludedPaths` (repository-relative) — the run's own output and the directory it writes.
 */
export function captureSourceState(
  repositoryRoot: string,
  excludedPaths: readonly string[] = [],
): SourceState {
  const diff = git(repositoryRoot, ['diff', 'HEAD', ...pathspec(excludedPaths)]);
  return {
    sourceSha: git(repositoryRoot, ['rev-parse', 'HEAD']).trim(),
    ...partitionPorcelainStatus(
      git(repositoryRoot, [
        'status',
        '--porcelain',
        '--untracked-files=all',
        ...pathspec(excludedPaths),
      ]),
    ),
    workingTreeDiffSha256: diff === '' ? null : createHash('sha256').update(diff).digest('hex'),
    untrackedSha256: untrackedContentSha256(repositoryRoot, excludedPaths),
  };
}

function packageVersion(packageName: string, fromDirectory: string): string {
  const manifestPath = Bun.resolveSync(`${packageName}/package.json`, fromDirectory);
  return (JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }).version;
}

function containerMemoryLimit(): string {
  const path = '/sys/fs/cgroup/memory.max';
  if (!existsSync(path)) return `none detected (no ${path} on ${platform()})`;
  const limit = parseContainerMemoryLimit(readFileSync(path, 'utf8'));
  return limit.limited ? `${limit.bytes} bytes` : 'cgroup memory.max is max (no limit)';
}

export type PinnedEnvironment = SourceState & {
  lockfileSha256: string;
  versions: { bun: string; svelte: string; playwright: string };
  operatingSystem: { platform: string; release: string; architecture: string; cpuModel: string };
  logicalProcessors: number;
  totalMemoryBytes: number;
  containerMemoryLimit: string;
  /**
   * The Playground's own configuration as its registered reader sees it in the measuring process
   * (`CINDER_TEST_COMPONENTS`, `PLAYGROUND_*`, `PORT`, `NODE_ENV`). Children override the base URL,
   * port, port file, and component scope explicitly, so none of these can change a measured child.
   */
  playgroundEnvironment: Record<string, string | undefined>;
  /**
   * The variables `measure-playground.ts` forces on every measured child, with null meaning removed.
   * Required from schema version 2 on.
   */
  childEnvironment: Record<string, string | null>;
};

export function capturePinnedEnvironment(
  repositoryRoot: string,
  playgroundRoot: string,
  excludedPaths: readonly string[] = [],
): PinnedEnvironment {
  return {
    ...captureSourceState(repositoryRoot, excludedPaths),
    lockfileSha256: createHash('sha256')
      .update(readFileSync(join(repositoryRoot, 'bun.lock')))
      .digest('hex'),
    versions: {
      bun: Bun.version,
      svelte: packageVersion('svelte', playgroundRoot),
      playwright: packageVersion('@playwright/test', playgroundRoot),
    },
    operatingSystem: {
      platform: platform(),
      release: release(),
      architecture: arch(),
      cpuModel: cpus()[0]?.model ?? 'unknown',
    },
    logicalProcessors: availableParallelism(),
    totalMemoryBytes: totalmem(),
    containerMemoryLimit: containerMemoryLimit(),
    playgroundEnvironment: { ...readEnvironmentConfiguration() },
    childEnvironment: recordedChildEnvironment(),
  };
}
