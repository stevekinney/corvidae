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
// its head is not on `main`'s first-parent history) one is due. It runs only while the one-minute
// load average is under `--max-load` (default 8), and never beside another run it started: a lock
// file in `<main checkout>/tmp/chef/` names the running process.
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
// Exit codes: 0 skipped (not due, load too high, or already running) or the validate passed,
// 1 the validate failed or could not start, 2 invalid CLI usage.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { dirname, join } from 'node:path';
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
export const defaultMaximumLoad = 8;

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
  maximumLoad: number;
}

export interface Due {
  due: boolean;
  reason: string;
}

/** Whether a batch validate should start now. Pure. */
export function decideDue(input: DueInput): Due {
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
  if (input.load >= input.maximumLoad)
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
  maximumLoad: number;
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
  const last = lastRunOnMain(readHealth(healthFile).runs, history);
  const mergesSince = last === undefined ? undefined : history.indexOf(last.head);
  const decision = decideDue({
    tip,
    last,
    mergesSince: mergesSince === undefined || mergesSince < 0 ? undefined : mergesSince,
    now: now(),
    minimumMerges: options.minimumMerges,
    maximumAgeHours: options.maximumAgeHours,
    load: (partial.load ?? (() => loadavg()[0] ?? 0))(),
    maximumLoad: options.maximumLoad,
  });
  if (!decision.due) return { ran: false, code: 0, reason: `not run: ${decision.reason}` };
  if (options.dryRun)
    return { ran: false, code: 0, reason: `would run: ${decision.reason}`, head: tip };

  const lockFile = join(mainCheckout, 'tmp', 'chef', 'batch-validate.lock');
  const alive = partial.alive ?? isAlive;
  if (existsSync(lockFile)) {
    const holder = Number(readFileSync(lockFile, 'utf8').trim());
    if (Number.isInteger(holder) && holder > 0 && alive(holder))
      return {
        ran: false,
        code: 0,
        reason: `not run: a batch validate is already running (pid ${holder})`,
      };
  }
  mkdirSync(dirname(lockFile), { recursive: true });
  writeFileSync(lockFile, `${partial.pid ?? process.pid}\n`);
  try {
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
      maximumLoad: numberOption(parsed.values, 'max-load', defaultMaximumLoad),
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
