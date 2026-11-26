#!/usr/bin/env bun
// Chef run closeout sweep: what a coordinator runs before it ends a run, so finished worktrees and
// worker scratch do not pile up between runs (#1168 removed the sweep `deliver.ts` ran after every
// delivery, and nothing replaced it).
//
// Usage:
//   bun scripts/chef/closeout-sweep.ts [--config <json>] [--retention-days <n>] [--dry-run] [--json]
//
// It runs two steps, in order:
//
// 1. `worktree.ts stale --remove` (`staleWorktrees`): removes the clean, idle worktrees whose tip
//    the delivery ledger, a merged pull request or `origin/<default>` shows delivered, keeping every
//    branch, and keeps any worktree a delivery request still owns (its closeout is not complete).
//    `--dry-run` lists without removing.
// 2. `pruneScratch`: removes each directory directly under the main checkout's `tmp/chef/scratch/`
//    (one per brief, created by `brief.ts`) when nothing inside it, at any depth, was modified in the
//    last `--retention-days` days (default 7) and no process has its working directory inside it.
//    Symbolic links are judged by themselves and never followed. When `lsof` cannot answer, nothing
//    is removed. It never touches anything else under `tmp/chef`: the execution state, delivery
//    requests, briefs, the delivery ledger and run notes are durable records, not scratch.
//
// Exit codes: 0 done, 1 the worktree sweep refused or failed, 2 invalid CLI usage.

import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  type Runner,
  UsageError,
} from './process-runner.ts';
import { DEFAULT_CONFIGURATION_PATH } from './repository-config.ts';
import { resolveMainCheckout } from './repository-locations.ts';
import { Refusal, type StaleResult, staleWorktrees } from './worktree.ts';

const DAY_MILLISECONDS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 7;

export interface PruneScratchOptions {
  /** The main checkout whose `tmp/chef/scratch` is pruned. */
  checkout: string;
  retentionDays: number;
  now: number;
  runner: Runner;
  dryRun?: boolean;
}

export interface PruneScratchResult {
  /** Removed, or with `dryRun` the directories that would be. */
  removed: string[];
  kept: { path: string; reason: string }[];
  notes: string[];
}

/** Whether `path` or anything below it, without following symbolic links, changed after `cutoff`. */
function modifiedSince(path: string, cutoff: number): boolean {
  const pending = [path];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(current);
    } catch {
      continue;
    }
    if (stats.mtimeMs > cutoff) return true;
    if (!stats.isDirectory()) continue;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      // An unreadable directory cannot be judged idle.
      return true;
    }
    for (const name of names) pending.push(join(current, name));
  }
  return false;
}

/** The working directories of the running user's processes, or `undefined` when `lsof` failed. */
function workingDirectories(runner: Runner): string[] | undefined {
  const listed = runner(['lsof', '-w', '-a', '-d', 'cwd', '-F', 'pcn']);
  if (listed.code !== 0 && listed.stdout.trim() === '') return undefined;
  return listed.stdout
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1));
}

/** Removes the idle per-brief scratch directories under `<checkout>/tmp/chef/scratch`. */
export function pruneScratch(options: PruneScratchOptions): PruneScratchResult {
  const result: PruneScratchResult = { removed: [], kept: [], notes: [] };
  const root = join(options.checkout, 'tmp', 'chef', 'scratch');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return result;
  }
  if (names.length === 0) return result;
  const directories = workingDirectories(options.runner);
  if (directories === undefined) {
    result.notes.push('processes could not be checked (lsof failed); no scratch was removed');
    return result;
  }
  const cutoff = options.now - options.retentionDays * DAY_MILLISECONDS;
  for (const name of names.toSorted()) {
    const path = join(root, name);
    if (directories.some((directory) => directory === path || directory.startsWith(path + sep))) {
      result.kept.push({ path, reason: 'a live process works in it' });
      continue;
    }
    if (modifiedSince(path, cutoff)) {
      result.kept.push({ path, reason: `used within ${options.retentionDays} days` });
      continue;
    }
    if (options.dryRun !== true) rmSync(path, { recursive: true, force: true });
    result.removed.push(path);
  }
  return result;
}

interface CloseoutSweepResult {
  worktrees: StaleResult;
  scratch: PruneScratchResult;
}

function render(result: CloseoutSweepResult, dryRun: boolean): string {
  const verb = dryRun ? 'would remove' : 'removed';
  const kept = result.worktrees.entries.filter((entry) => entry.keep.length > 0).length;
  const worktreeCount = dryRun
    ? result.worktrees.entries.length - kept
    : result.worktrees.removed.length;
  const lines = [
    `worktrees: ${verb} ${worktreeCount}, kept ${kept}, refused ${result.worktrees.refused.length}`,
    ...result.worktrees.refused.map((item) => `  refused ${item.path}: ${item.reason}`),
    `scratch: ${verb} ${result.scratch.removed.length}, kept ${result.scratch.kept.length}`,
    ...[...result.worktrees.notes, ...result.scratch.notes].map((note) => `note: ${note}`),
  ];
  return lines.join('\n');
}

function run(
  argv: string[],
  dependencies: { runner?: Runner; checkout?: string; now?: () => number } = {},
): { code: number; output: string } {
  const parsed = parseOptions(argv, {
    values: ['config', 'retention-days'],
    flags: ['dry-run', 'json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const retention = parsed.values['retention-days'] ?? String(DEFAULT_RETENTION_DAYS);
  if (!/^[1-9][0-9]*$/.test(retention))
    throw new UsageError('--retention-days must be a positive whole number of days.');
  const dryRun = parsed.flags.has('dry-run');
  const json = parsed.flags.has('json');
  const runner = dependencies.runner ?? defaultRunner;
  const checkout = dependencies.checkout ?? resolveMainCheckout(runner);
  const now = dependencies.now ?? Date.now;
  let worktrees: StaleResult;
  try {
    worktrees = staleWorktrees(
      { configPath: parsed.values['config'] ?? DEFAULT_CONFIGURATION_PATH, remove: !dryRun },
      { runner, checkout },
    );
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return {
      code: 1,
      output: json ? JSON.stringify({ ok: false, error: error.message }) : error.message,
    };
  }
  const scratch = pruneScratch({
    checkout,
    retentionDays: Number(retention),
    now: now(),
    runner,
    dryRun,
  });
  const result = { worktrees, scratch };
  return { code: 0, output: json ? JSON.stringify(result) : render(result, dryRun) };
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
