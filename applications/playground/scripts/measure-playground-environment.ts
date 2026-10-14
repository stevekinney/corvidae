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
  };
}

/** Whether the one-minute load is above `factor` times the logical processor count. */
export function loadExceedsLimit(load: HostLoad, factor: number): boolean {
  return load.loadAverages.oneMinute > factor * load.logicalProcessors;
}

export type LoadWait = {
  /** The one-minute load average a sample may start under: factor x logical processors. */
  thresholdOneMinute: number;
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
  factor: number,
  options: LoadWaitOptions = {},
): Promise<LoadWait> {
  const capture = options.capture ?? captureHostLoad;
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
  /** Untracked paths, which cannot change what HEAD's sources build. */
  untrackedPaths: string[];
  /** SHA-256 of `git diff HEAD`, so a sample names the exact patch it ran against. */
  workingTreeDiffSha256: string | null;
};

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

export function captureSourceState(repositoryRoot: string): SourceState {
  const diff = git(repositoryRoot, ['diff', 'HEAD']);
  return {
    sourceSha: git(repositoryRoot, ['rev-parse', 'HEAD']).trim(),
    ...partitionPorcelainStatus(git(repositoryRoot, ['status', '--porcelain'])),
    workingTreeDiffSha256: diff === '' ? null : createHash('sha256').update(diff).digest('hex'),
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
};

export function capturePinnedEnvironment(
  repositoryRoot: string,
  playgroundRoot: string,
): PinnedEnvironment {
  return {
    ...captureSourceState(repositoryRoot),
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
  };
}
