#!/usr/bin/env bun
// Chef main health: the record of each batch validate's result, so a coordinator cannot merge into
// a red `main` by forgetting that the last batch failed. `gate-run.ts run` writes an entry when its
// command is the configured batch command; `merge-gate.ts` reads it and refuses to merge while
// `main`'s last batch validate failed, unless the pull request is declared the fix.
//
// The record is `<main checkout>/tmp/chef/main-health.json` (gitignored; the main checkout's `tmp/`
// outlives any worktree):
//   { "runs": [{ "head", "exitCode", "time", "command" }], "fixes": [{ "pr", "time", "blockedHead" }] }
// `runs` keeps the newest 50 entries. "Last" means the entry whose head is nearest the tip of
// `origin/<default>`'s first-parent history: a validate at a head that never reached `main` (a
// branch gate, a rewritten history) is ignored, and a green validate at a later head clears a red
// one at an earlier head.
//
// Usage:
//   bun scripts/chef/main-health.ts [--config <json>] [--health-file <path>] [--json]
//
// prints main's health. Exit codes: 0 healthy or no batch validate recorded, 1 the last batch
// validate on `main` failed, 2 invalid CLI usage.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

export interface HealthRun {
  head: string;
  exitCode: number;
  time: string;
  command: string;
}

export interface HealthFix {
  pr: number;
  time: string;
  blockedHead: string;
}

export interface HealthFile {
  runs: HealthRun[];
  fixes: HealthFix[];
}

const keptRuns = 50;
const keptFixes = 50;
const historyLimit = 5000;

/** `<main checkout>/tmp/chef/main-health.json`. */
export function healthFilePath(mainCheckout: string): string {
  return join(mainCheckout, 'tmp', 'chef', 'main-health.json');
}

/** The health file for the main checkout of `cwd`, or `undefined` when Git cannot say. */
export function resolveHealthFile(runner: Runner = defaultRunner, cwd = process.cwd()) {
  try {
    return healthFilePath(resolveMainCheckout(runner, cwd));
  } catch (error) {
    if (error instanceof UsageError) return undefined;
    throw error;
  }
}

function isRun(value: unknown): value is HealthRun {
  const record = value as Record<string, unknown> | null;
  return (
    record !== null &&
    typeof record === 'object' &&
    typeof record['head'] === 'string' &&
    Number.isInteger(record['exitCode']) &&
    typeof record['time'] === 'string' &&
    typeof record['command'] === 'string'
  );
}

function isFix(value: unknown): value is HealthFix {
  const record = value as Record<string, unknown> | null;
  return (
    record !== null &&
    typeof record === 'object' &&
    Number.isInteger(record['pr']) &&
    typeof record['time'] === 'string' &&
    typeof record['blockedHead'] === 'string'
  );
}

/** Read the file; a missing, unreadable or malformed file is an empty record, with bad entries dropped. */
export function readHealth(path: string): HealthFile {
  if (!existsSync(path)) return { runs: [], fixes: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return {
      runs: Array.isArray(parsed['runs']) ? parsed['runs'].filter(isRun) : [],
      fixes: Array.isArray(parsed['fixes']) ? parsed['fixes'].filter(isFix) : [],
    };
  } catch {
    return { runs: [], fixes: [] };
  }
}

function writeHealth(path: string, health: HealthFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(health, null, 2)}\n`);
  renameSync(temporary, path);
}

/** Append one batch validate result. */
export function recordBatchRun(path: string, entry: HealthRun): void {
  const health = readHealth(path);
  health.runs = [...health.runs, entry].slice(-keptRuns);
  writeHealth(path, health);
}

/** Append the use of `--fixes-main` by a pull request. */
export function recordFix(path: string, fix: HealthFix): void {
  const health = readHealth(path);
  health.fixes = [...health.fixes, fix].slice(-keptFixes);
  writeHealth(path, health);
}

/** `origin/<branch>`'s first-parent commits, newest first; `undefined` when Git cannot list them. */
export function firstParentHistory(
  runner: Runner,
  cwd: string,
  defaultBranch: string,
): string[] | undefined {
  const listed = runner(
    ['git', 'rev-list', '--first-parent', `--max-count=${historyLimit}`, `origin/${defaultBranch}`],
    { cwd },
  );
  if (listed.code !== 0) return undefined;
  return listed.stdout.split('\n').filter((line) => line !== '');
}

/**
 * The recorded run nearest the tip of `history`; later entries break a tie between runs at one
 * head. `undefined` when no run's head is on the history.
 */
export function lastRunOnMain(runs: HealthRun[], history: string[]): HealthRun | undefined {
  const position = new Map(history.map((commit, index) => [commit, index]));
  let best: { run: HealthRun; index: number } | undefined;
  for (const candidate of runs) {
    const index = position.get(candidate.head);
    if (index !== undefined && (best === undefined || index <= best.index))
      best = { run: candidate, index };
  }
  return best?.run;
}

export interface MainHealth {
  /** True when the last batch validate on `main` failed. */
  red: boolean;
  run: HealthRun | undefined;
  /** Why the state is unknown, when Git could not list `main`'s history. */
  problem?: string;
}

/** Main's health from the file at `healthFile` and `origin/<defaultBranch>` as last fetched. */
export function mainHealth(
  runner: Runner,
  cwd: string,
  defaultBranch: string,
  healthFile: string,
): MainHealth {
  const runs = readHealth(healthFile).runs;
  if (runs.length === 0) return { red: false, run: undefined };
  const history = firstParentHistory(runner, cwd, defaultBranch);
  if (history === undefined)
    return {
      red: false,
      run: undefined,
      problem: `could not list origin/${defaultBranch}'s first-parent history`,
    };
  const last = lastRunOnMain(runs, history);
  return { red: last !== undefined && last.exitCode !== 0, run: last };
}

export function renderMainHealth(health: MainHealth, defaultBranch: string): string {
  if (health.problem !== undefined) return `main health unknown: ${health.problem}.`;
  if (health.run === undefined) return `No batch validate on ${defaultBranch} is recorded.`;
  return `${defaultBranch} batch validate at ${health.run.head.slice(0, 12)}: exit ${health.run.exitCode} at ${health.run.time} (${health.red ? 'RED' : 'green'}).`;
}

export function run(
  argv: string[],
  runner: Runner = defaultRunner,
): { code: number; output: string } {
  const parsed = parseOptions(argv, { values: ['config', 'health-file'], flags: ['json'] });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const config = loadRepositoryConfig(parsed.values['config'] ?? DEFAULT_CONFIGURATION_PATH);
  const healthFile = parsed.values['health-file'] ?? resolveHealthFile(runner);
  if (healthFile === undefined) throw new UsageError('Cannot find the main checkout.');
  const health = mainHealth(runner, process.cwd(), config.defaultBranch, healthFile);
  return {
    code: health.red ? 1 : 0,
    output: parsed.flags.has('json')
      ? JSON.stringify(health)
      : renderMainHealth(health, config.defaultBranch),
  };
}

if (import.meta.main) {
  try {
    const { code, output } = run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
