#!/usr/bin/env bun
// Chef landing queue: says, under the merge lock, whether a branch whose evidence was taken at
// commit E lands on the current `main`.
//
// Owner decision, 2026-11-21: a change with green evidence that merges into current `main` without
// a conflict lands; `main` moving while the evidence ran is not a reason to refuse it, and it never
// needs a new evidence run. The only reason a moved base refuses a landing is a merge conflict. So
// the rule is one `git merge-tree --write-tree` (`moved-base.ts`):
//   LAND      E merges into `main` cleanly: the tree that would land, and the commits `main` gained
//             since E's merge-base with it, which the head is merged onto;
//   CONFLICT  E conflicts with `main`: the conflicting paths. The worker merges `main` in and
//             returns a new head.
//
// Usage:
//   bun scripts/chef/land-queue.ts --evidence <sha> [--base origin/main] [--worktree <path>]
//                                  [--lock-directory <path>] [--json]
//
// The command is ADVISORY: its merge lock and fetch cover only the read, so a merge by another
// session after it returns can still make its answer stale. The binding decision is `direct-merge.ts`
// step 3, which merges the head into the base inside the merge lock the push holds, so the decision
// and the push are one critical section. Exit codes: 0 LAND, 3 CONFLICT, 2 invalid input.

import { withMergeLock } from './merge-gate.ts';
import { describeConflicts, mergeHeadOnto } from './moved-base.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  requireOption,
  type Runner,
  UsageError,
} from './process-runner.ts';

export { UsageError };

export type LandVerdict = 'LAND' | 'CONFLICT';

export interface LandQueueResult {
  verdict: LandVerdict;
  evidence: string;
  mergeBase: string;
  mainHead: string;
  /** The commits `main` gained since the merge base, oldest first: what the head lands on top of. */
  mergedIn: string[];
  /** The tree that lands; present on LAND. */
  tree?: string;
  /** The conflicting paths, sorted; empty on LAND. */
  conflicts: string[];
}

function git(runner: Runner, args: string[], cwd: string | undefined): string {
  const result = runner(['git', ...args], cwd === undefined ? undefined : { cwd });
  if (result.code !== 0)
    throw new UsageError(
      `git ${args.join(' ')} failed: ${result.stderr.trim().split('\n')[0] ?? ''}`,
    );
  return result.stdout.trim();
}

export interface LandQueueOptions {
  runner: Runner;
  /** The commit the evidence was taken at. */
  evidence: string;
  /** The default branch as a ref, normally `origin/main`, fetched by the caller. */
  base?: string;
  cwd?: string | undefined;
}

/**
 * The verdict for one branch. Fakeable through `runner`: it only reads (`rev-parse`, `merge-base`,
 * `rev-list`, `merge-tree`), and callers hold the merge lock and have fetched `base`.
 */
export function landQueueVerdict(options: LandQueueOptions): LandQueueResult {
  const { runner, cwd } = options;
  const base = options.base ?? 'origin/main';
  const evidence = git(runner, ['rev-parse', '--verify', `${options.evidence}^{commit}`], cwd);
  const mainHead = git(runner, ['rev-parse', '--verify', `${base}^{commit}`], cwd);
  const mergeBase = git(runner, ['merge-base', evidence, mainHead], cwd);
  const mergedIn = git(runner, ['rev-list', '--reverse', `${mergeBase}..${mainHead}`], cwd)
    .split('\n')
    .filter(Boolean);
  const merged = mergeHeadOnto(
    (...args: string[]) => runner(['git', ...args], cwd === undefined ? undefined : { cwd }),
    mainHead,
    evidence,
  );
  if ('failure' in merged) throw new UsageError(merged.failure);
  const result = { evidence, mergeBase, mainHead, mergedIn };
  return 'conflicts' in merged
    ? { verdict: 'CONFLICT', ...result, conflicts: merged.conflicts.toSorted() }
    : { verdict: 'LAND', ...result, tree: merged.tree, conflicts: [] };
}

export function formatVerdict(result: LandQueueResult): string {
  const lines = [
    result.verdict,
    `evidence: ${result.evidence}`,
    `merge base: ${result.mergeBase}`,
    `main: ${result.mainHead} (${result.mergedIn.length} commits since the merge base)`,
  ];
  if (result.verdict === 'LAND') {
    lines.push('the head merges into main without a conflict: land without a new evidence run');
  } else {
    lines.push(
      `the head conflicts with main${describeConflicts(result.conflicts)}: merge main in and return a new head`,
    );
    for (const path of result.conflicts) lines.push(`  ${path}`);
  }
  return lines.join('\n');
}

export interface LandQueueDependencies {
  runner: Runner;
  /** Runs `action` holding the merge lock. */
  withLock: <T>(
    options: { worktree: string; lockDirectory: string | undefined },
    action: () => T,
  ) => Promise<T>;
}

export async function run(
  argv: string[],
  dependencies: LandQueueDependencies = {
    runner: defaultRunner,
    withLock: async (options, action) =>
      withMergeLock(
        {
          worktree: options.worktree,
          command: 'land-queue',
          lockDirectory: options.lockDirectory,
        },
        action,
      ),
  },
): Promise<{ code: number; output: string }> {
  const parsed = parseOptions(argv, {
    values: ['evidence', 'base', 'worktree', 'lock-directory'],
    flags: ['json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError('land-queue.ts takes options only; see its header.');
  const evidence = requireOption(parsed, 'evidence');
  const worktree = parsed.values['worktree'] ?? process.cwd();
  const result = await dependencies.withLock(
    { worktree, lockDirectory: parsed.values['lock-directory'] },
    () => {
      const base = parsed.values['base'] ?? 'origin/main';
      // Fetch inside the lock: a commit another session landed a moment ago must be visible, or
      // the verdict is a wrong LAND.
      const remote = /^([\w.-]+)\/(.+)$/.exec(base);
      if (remote !== null)
        git(dependencies.runner, ['fetch', remote[1] ?? '', remote[2] ?? ''], worktree);
      return landQueueVerdict({ runner: dependencies.runner, evidence, base, cwd: worktree });
    },
  );
  return {
    code: result.verdict === 'LAND' ? 0 : 3,
    output: parsed.flags.has('json') ? JSON.stringify(result) : formatVerdict(result),
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
