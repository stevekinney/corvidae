#!/usr/bin/env bun
// Chef batch validate: runs the batch validate on `origin/<default>` when one is due, in a dedicated
// worktree, through `gate-run.ts`, so `main`'s health is measured on a schedule instead of when a
// coordinator remembers. The result lands in `<main checkout>/tmp/chef/main-health.json`
// (`main-health.ts`), which `merge-gate.ts` reads.
//
// Usage:
//   bun scripts/chef/batch-validate.ts [--config <json>] [--min-merges <n>] [--max-age-hours <h>]
//                                      [--max-load <n>] [--worktree <dir>] [--dry-run] [--json]
//
// A validate is due when `origin/<default>` has moved since the last recorded batch head AND either
// at least `--min-merges` (default 5) first-parent commits (merges) have landed since that head or
// at least `--max-age-hours` (default 2) have passed since it ran. With no usable record (none, or
// its head is not on `main`'s first-parent history) one is due. It is never due while the health
// file already holds a green record at the current `origin/<default>` head, even if a later run at
// that head failed: `main` is as healthy as it was measured to be at that commit.
//
// The load average is not consulted unless `--max-load <n>` is given, in which case a due validate
// waits while the one-minute load average is at or above `n`. It used to default to 8; `main` now
// enforces deterministic tests (`scripts/check-load-sensitive-deadlines.ts`), and on a host shared
// by several sessions that threshold never held, so the batch validate never ran.
//
// One run at a time on the host: a lock file in the Git common directory
// (`<common dir>/corvidae-batch-validate.lock`, JSON with the holder's `pid`, its process start
// time and the `head` being validated) is created exclusively before any work. A second coordinator
// that finds a live holder exits 0 with "already running by pid N" and touches nothing. A lock whose
// pid is dead, or is now another process (its start time differs), is reclaimed. Reclaiming a stale
// lock is a remove-then-create, so two coordinators that both find the same stale lock in the same
// instant can still race; the loser's exclusive create fails and it exits as a second coordinator.
// The decision is made again after the lock is held, so a run that finished while this one waited
// on nothing but the lock does not repeat.
//
// It fetches `origin/<default>`, makes or reuses the dedicated worktree `<claude worktree
// root>/batch-validate` at that commit (detached), installs with the configuration's
// `installCommand`, and runs `gate-run.ts`'s `runGate` with the configuration's `batchCommand`,
// logging to `<main checkout>/tmp/chef/batch-validate/<time>.log`. It runs in the foreground for as
// long as the validate takes, so a scheduler starts it as a background command.
//
// This script adds no scheduler. A coordinator schedules it with a Claude Code scheduled task or
// `/loop` (see `.agents/skills/chef/references/program-runs.md` "Batch validate on a timer").
//
// Exit codes: 0 skipped (not due, load over an explicit `--max-load`, or already running) or the validate passed,
// 1 the validate failed or could not start, 2 invalid CLI usage.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { processStartTime } from '../run-exclusively.ts';
import { fetchWithRetry } from './fetch-retry.ts';
import { runGate } from './gate-run.ts';
import {
  firstParentHistory,
  healthFilePath,
  type HealthRun,
  lastRunOnMain,
  readHealth,
} from './main-health.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  type Runner,
  UsageError,
} from './process-runner.ts';
import { DEFAULT_CONFIGURATION_PATH, loadRepositoryConfig } from './repository-config.ts';
import { resolveMainCheckout } from './repository-locations.ts';

export { UsageError };

export const defaultMinimumMerges = 5;
export const defaultMaximumAgeHours = 2;

export interface DueInput {
  /** The head of `origin/<default>`. */
  tip: string;
  /** The last recorded batch validate on `main`, if any. */
  last: HealthRun | undefined;
  /** First-parent commits on `origin/<default>` since `last.head`; `undefined` when `last` is unusable. */
  mergesSince: number | undefined;
  now: Date;
  minimumMerges: number;
  maximumAgeHours: number;
  load: number;
  /** Opt-in: the load average at or above which a due validate waits; `undefined` ignores the load. */
  maximumLoad?: number | undefined;
  /** Whether the health file holds a green record at `tip`, whatever ran there afterwards. */
  greenAtTip?: boolean | undefined;
}

export interface Due {
  due: boolean;
  reason: string;
}

/** Whether a batch validate should start now. Pure. */
export function decideDue(input: DueInput): Due {
  if (input.greenAtTip === true)
    return {
      due: false,
      reason: 'a green batch validate is already recorded at the current head of main',
    };
  if (input.last !== undefined && input.last.head === input.tip)
    return { due: false, reason: 'main has not moved since the last batch validate' };
  let reason: string;
  if (input.last === undefined || input.mergesSince === undefined) {
    reason = 'no usable batch validate is recorded on main';
  } else {
    const ageHours = (input.now.getTime() - Date.parse(input.last.time)) / 3_600_000;
    if (input.mergesSince >= input.minimumMerges)
      reason = `${input.mergesSince} merges since the last batch validate`;
    else if (Number.isFinite(ageHours) && ageHours >= input.maximumAgeHours)
      reason = `${ageHours.toFixed(1)} hours since the last batch validate`;
    else if (!Number.isFinite(ageHours)) reason = 'the last batch validate has no readable time';
    else
      return {
        due: false,
        reason: `${input.mergesSince} merges and ${ageHours.toFixed(1)} hours since the last batch validate`,
      };
  }
  if (input.maximumLoad !== undefined && input.load >= input.maximumLoad)
    return {
      due: false,
      reason: `${reason}, but the load is ${input.load.toFixed(1)} (limit ${input.maximumLoad})`,
    };
  return { due: true, reason };
}

export interface BatchValidateOptions {
  configPath: string;
  minimumMerges: number;
  maximumAgeHours: number;
  /** Opt-in load limit (`--max-load`); `undefined` ignores the load average. */
  maximumLoad: number | undefined;
  worktree: string | undefined;
  dryRun: boolean;
}

export interface BatchValidateResult {
  ran: boolean;
  code: number;
  reason: string;
  head?: string;
  log?: string;
  worktree?: string;
}

export interface BatchValidateDependencies {
  runner: Runner;
  now: () => Date;
  load: () => number;
  /** Whether a process is alive; defaults to `process.kill(pid, 0)`. */
  alive: (pid: number) => boolean;
  /** A process's start time as `ps` prints it, or `undefined` when it is gone; guards pid reuse. */
  processStart: (pid: number) => string | undefined;
  gate: typeof runGate;
  pid: number;
  /** Blocks between fetch retries; defaults to `Bun.sleepSync`. */
  sleep: (milliseconds: number) => void;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 200);
}

/** What the lock file records about the run that holds it. */
export interface BatchLockRecord {
  pid: number;
  /** `ps -o lstart` for `pid` when the lock was taken, so a recycled pid is not mistaken for it. */
  startedAt?: string;
  /** The `origin/<default>` commit being validated. */
  head: string;
  acquiredAt: string;
}

function readLock(path: string): BatchLockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BatchLockRecord>;
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? (parsed as BatchLockRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Take the host-wide batch-validate lock at `path`, or say who holds it. The file is created with
 * `wx`, so only one creator wins. A lock whose holder is dead, or whose pid now has another start
 * time, is removed and taken again (at most three tries); an unreadable file counts as stale.
 */
export function acquireBatchLock(
  path: string,
  record: BatchLockRecord,
  alive: (pid: number) => boolean,
  processStart: (pid: number) => string | undefined,
): { acquired: true } | { acquired: false; holder: BatchLockRecord } {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const descriptor = openSync(path, 'wx');
      try {
        writeSync(descriptor, `${JSON.stringify(record)}\n`);
      } finally {
        closeSync(descriptor);
      }
      return { acquired: true };
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
    const holder = readLock(path);
    if (
      holder !== undefined &&
      alive(holder.pid) &&
      (holder.startedAt === undefined || processStart(holder.pid) === holder.startedAt)
    )
      return { acquired: false, holder };
    rmSync(path, { force: true });
  }
  // Three creators in a row lost the race to someone else's fresh lock; report that holder.
  const holder = readLock(path);
  return { acquired: false, holder: holder ?? { pid: 0, head: '', acquiredAt: '' } };
}

/** Decide, and when due, run the batch validate. Never throws for a failed step; the result names it. */
export async function batchValidate(
  options: BatchValidateOptions,
  partial: Partial<BatchValidateDependencies> = {},
): Promise<BatchValidateResult> {
  const runner = partial.runner ?? defaultRunner;
  const now = partial.now ?? (() => new Date());
  const config = loadRepositoryConfig(options.configPath);
  if (config.batchCommand === undefined)
    throw new UsageError(`${options.configPath} names no "batchCommand".`);
  const mainCheckout = resolveMainCheckout(runner);
  const fail = (reason: string): BatchValidateResult => ({ ran: false, code: 1, reason });

  const fetched = fetchWithRetry(
    () => runner(['git', 'fetch', 'origin', config.defaultBranch], { cwd: mainCheckout }),
    { sleep: partial.sleep },
  );
  if (fetched.code !== 0)
    return fail(`git fetch origin ${config.defaultBranch} failed: ${firstLine(fetched.stderr)}`);
  const tipResult = runner(['git', 'rev-parse', `origin/${config.defaultBranch}`], {
    cwd: mainCheckout,
  });
  const tip = tipResult.stdout.trim();
  if (tipResult.code !== 0 || tip === '')
    return fail(`could not read origin/${config.defaultBranch}`);

  const history = firstParentHistory(runner, mainCheckout, config.defaultBranch);
  if (history === undefined) return fail(`could not list origin/${config.defaultBranch}'s history`);
  const healthFile = healthFilePath(mainCheckout);
  const load = partial.load ?? (() => loadavg()[0] ?? 0);
  /** Read the health file afresh, so a run that finished meanwhile is seen. */
  const decide = (): Due => {
    const runs = readHealth(healthFile).runs;
    const last = lastRunOnMain(runs, history);
    const mergesSince = last === undefined ? undefined : history.indexOf(last.head);
    return decideDue({
      tip,
      last,
      mergesSince: mergesSince === undefined || mergesSince < 0 ? undefined : mergesSince,
      now: now(),
      minimumMerges: options.minimumMerges,
      maximumAgeHours: options.maximumAgeHours,
      load: options.maximumLoad === undefined ? 0 : load(),
      maximumLoad: options.maximumLoad,
      greenAtTip: runs.some((entry) => entry.head === tip && entry.exitCode === 0),
    });
  };
  const decision = decide();
  if (!decision.due) return { ran: false, code: 0, reason: `not run: ${decision.reason}` };
  if (options.dryRun)
    return { ran: false, code: 0, reason: `would run: ${decision.reason}`, head: tip };

  const common = runner(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: mainCheckout,
  });
  if (common.code !== 0 || common.stdout.trim() === '')
    return fail(`could not find the Git common directory: ${firstLine(common.stderr)}`);
  const lockFile = join(common.stdout.trim(), 'corvidae-batch-validate.lock');
  const pid = partial.pid ?? process.pid;
  const processStart = partial.processStart ?? processStartTime;
  const startedAt = processStart(pid);
  const lock = acquireBatchLock(
    lockFile,
    {
      pid,
      ...(startedAt === undefined ? {} : { startedAt }),
      head: tip,
      acquiredAt: now().toISOString(),
    },
    partial.alive ?? isAlive,
    processStart,
  );
  if (!lock.acquired)
    return {
      ran: false,
      code: 0,
      reason: `not run: a batch validate is already running by pid ${lock.holder.pid}${lock.holder.head === '' ? '' : ` at ${lock.holder.head.slice(0, 12)}`}`,
    };
  try {
    // Another coordinator may have finished a run between the first decision and the lock.
    const recheck = decide();
    if (!recheck.due) return { ran: false, code: 0, reason: `not run: ${recheck.reason}` };
    const worktree = options.worktree ?? join(config.worktreeRoots.claude, 'batch-validate');
    const git = (...args: string[]) => runner(['git', ...args], { cwd: worktree });
    if (!existsSync(worktree)) {
      mkdirSync(dirname(worktree), { recursive: true });
      const added = runner(['git', 'worktree', 'add', '--detach', worktree, tip], {
        cwd: mainCheckout,
      });
      if (added.code !== 0)
        return fail(`git worktree add ${worktree} failed: ${firstLine(added.stderr)}`);
    } else {
      const moved = git('checkout', '--detach', tip);
      if (moved.code !== 0)
        return fail(
          `could not move ${worktree} to ${tip.slice(0, 12)}: ${firstLine(moved.stderr)}`,
        );
    }
    const install = runner(['sh', '-c', config.installCommand], { cwd: worktree });
    if (install.code !== 0)
      return fail(`${config.installCommand} failed in ${worktree}: ${firstLine(install.stderr)}`);
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const log = join(mainCheckout, 'tmp', 'chef', 'batch-validate', `${stamp}.log`);
    const result = await (partial.gate ?? runGate)(
      { configPath: options.configPath, worktree, log, command: config.batchCommand },
      { runner, now },
    );
    return {
      ran: true,
      code: result.code === 0 ? 0 : 1,
      reason: `${decision.reason}; the batch validate ${result.code === 0 ? 'passed' : `failed (exit ${result.code})`}`,
      head: result.head,
      log,
      worktree,
    };
  } finally {
    rmSync(lockFile, { force: true });
  }
}

function numberOption(parsed: Record<string, string>, name: string, fallback: number): number {
  const value = parsed[name];
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new UsageError(`--${name} takes a number.`);
  return number;
}

export async function run(
  argv: string[],
  dependencies: Partial<BatchValidateDependencies> = {},
): Promise<{ code: number; output: string }> {
  const parsed = parseOptions(argv, {
    values: ['config', 'min-merges', 'max-age-hours', 'max-load', 'worktree'],
    flags: ['dry-run', 'json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const result = await batchValidate(
    {
      configPath: parsed.values['config'] ?? DEFAULT_CONFIGURATION_PATH,
      minimumMerges: numberOption(parsed.values, 'min-merges', defaultMinimumMerges),
      maximumAgeHours: numberOption(parsed.values, 'max-age-hours', defaultMaximumAgeHours),
      maximumLoad:
        parsed.values['max-load'] === undefined
          ? undefined
          : numberOption(parsed.values, 'max-load', 0),
      worktree: parsed.values['worktree'],
      dryRun: parsed.flags.has('dry-run'),
    },
    dependencies,
  );
  return {
    code: result.code,
    output: parsed.flags.has('json')
      ? JSON.stringify(result)
      : [result.reason, ...(result.log === undefined ? [] : [`log ${result.log}`])].join('\n'),
  };
}

if (import.meta.main) {
  try {
    const { code, output } = await run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
