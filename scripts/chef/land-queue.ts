#!/usr/bin/env bun
// Chef landing queue: decides, under the merge lock, whether a branch whose evidence was taken at
// commit E may land after `main` moved, or needs a new evidence run.
//
// Every repair on `main` used to force a re-merge and a new run on every open branch, overlapping
// or not (review Cause E). Here the rule is mechanical:
//   1. the commits on `main` since the merge-base of E and `main` are listed, with their files;
//   2. their files are intersected with the plan's scope: the plan's changed files, plus everything
//      its selection reaches, meaning each unit-test workspace (the whole folder, or the exact test
//      paths for the root), each fixture and end-to-end spec, and each fixture slug's source
//      (`scripts/browser-fixtures/src/fixtures/<slug>.svelte` and the component folder of that name);
//   3. no overlap: LAND, with no new run; overlap: REDISPATCH, naming the overlapping files.
// A plan with `requires_full_run` covers the whole tree, so any commit on `main` overlaps it.
//
// Usage:
//   bun scripts/chef/land-queue.ts --evidence <sha> --plan <plan.json> [--base origin/main]
//                                  [--worktree <path>] [--lock-directory <path>] [--json]
//
// `--plan` is the JSON of `evidence-plan.ts --json` for the evidence's head. The command holds the
// merge lock (`merge-gate.ts` `withMergeLock`) while it reads `main`, so the answer cannot go stale
// between a merge by another session and this one. `deliver.ts` calls `landQueueVerdict` inside the
// lock it already holds. Exit codes: 0 LAND, 3 REDISPATCH, 2 invalid input.

import { readFileSync } from 'node:fs';

import { withMergeLock } from './merge-gate.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  requireOption,
  type Runner,
  UsageError,
} from './process-runner.ts';
import { COMPONENT_DIRECTORIES, type EvidencePlan } from './verification-plan.ts';

export { UsageError };

export type LandVerdict = 'LAND' | 'REDISPATCH';

export interface MainCommit {
  sha: string;
  files: string[];
}

export interface LandQueueResult {
  verdict: LandVerdict;
  evidence: string;
  mergeBase: string;
  mainHead: string;
  commits: MainCommit[];
  /** The files of `main`'s commits that fall inside the plan's scope, sorted. Empty on LAND. */
  overlapping: string[];
}

const FIXTURE_SOURCE = /^scripts\/browser-fixtures\/src\/fixtures\/([\w-]+)\.svelte$/;
const INTERBOROUGH = 'applications/interborough/';

/** A path predicate for everything the plan's selection reaches. */
export interface PlanScope {
  /** Every path is in scope: a full run covers the whole tree. */
  everything: boolean;
  files: ReadonlySet<string>;
  /** Workspace folders, each with a trailing slash. */
  directories: readonly string[];
  slugs: ReadonlySet<string>;
}

export function planScope(plan: EvidencePlan): PlanScope {
  const files = new Set<string>(plan.changed);
  const directories: string[] = [];
  for (const lane of plan.unit_tests) {
    if (lane.workspace === '') {
      // The root has no folder of its own to claim: only the tests the selection names.
      for (const path of lane.paths) files.add(path);
    } else {
      directories.push(`${lane.workspace.replace(/\/+$/, '')}/`);
      for (const path of lane.paths) files.add(`${lane.workspace.replace(/\/+$/, '')}/${path}`);
    }
  }
  for (const spec of plan.fixture_specs) files.add(spec);
  for (const spec of plan.e2e_specs) files.add(`${INTERBOROUGH}${spec}`);
  return {
    everything: plan.requires_full_run,
    files,
    directories,
    slugs: new Set(plan.fixture_slugs),
  };
}

function slugOf(path: string): string | undefined {
  const fixture = FIXTURE_SOURCE.exec(path)?.[1];
  if (fixture !== undefined) return fixture;
  for (const pattern of COMPONENT_DIRECTORIES) {
    const match = pattern.exec(path)?.[1];
    if (match !== undefined) return match;
  }
  return undefined;
}

export function inScope(scope: PlanScope, path: string): boolean {
  if (scope.everything || scope.files.has(path)) return true;
  if (scope.directories.some((directory) => path.startsWith(directory))) return true;
  const slug = slugOf(path);
  return slug !== undefined && scope.slugs.has(slug);
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
  plan: EvidencePlan;
  /** The default branch as a ref, normally `origin/main`, fetched by the caller. */
  base?: string;
  cwd?: string | undefined;
}

/**
 * The verdict for one branch. Fakeable through `runner`: it only reads (`rev-parse`, `merge-base`,
 * `rev-list`, `diff-tree`), and callers hold the merge lock and have fetched `base`.
 */
export function landQueueVerdict(options: LandQueueOptions): LandQueueResult {
  const { runner, cwd, plan } = options;
  const base = options.base ?? 'origin/main';
  const evidence = git(runner, ['rev-parse', '--verify', `${options.evidence}^{commit}`], cwd);
  const mainHead = git(runner, ['rev-parse', '--verify', `${base}^{commit}`], cwd);
  const mergeBase = git(runner, ['merge-base', evidence, mainHead], cwd);
  const shas = git(runner, ['rev-list', '--reverse', `${mergeBase}..${mainHead}`], cwd)
    .split('\n')
    .filter(Boolean);
  const scope = planScope(plan);
  const commits: MainCommit[] = shas.map((sha) => ({
    sha,
    files: git(
      runner,
      ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-m', sha],
      cwd,
    )
      .split('\n')
      .filter(Boolean),
  }));
  const overlapping = [
    ...new Set(commits.flatMap((commit) => commit.files.filter((path) => inScope(scope, path)))),
  ].toSorted();
  return {
    verdict: overlapping.length === 0 ? 'LAND' : 'REDISPATCH',
    evidence,
    mergeBase,
    mainHead,
    commits,
    overlapping,
  };
}

export function formatVerdict(result: LandQueueResult): string {
  const lines = [
    result.verdict,
    `evidence: ${result.evidence}`,
    `merge base: ${result.mergeBase}`,
    `main: ${result.mainHead} (${result.commits.length} commits since the merge base)`,
  ];
  if (result.verdict === 'LAND')
    lines.push('no commit on main touches the plan scope: land without a new run');
  else {
    lines.push('commits on main overlap the plan scope: a new evidence run is required');
    for (const path of result.overlapping) lines.push(`  ${path}`);
  }
  return lines.join('\n');
}

export interface LandQueueDependencies {
  runner: Runner;
  readPlan: (path: string) => EvidencePlan;
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
    readPlan: (path) => JSON.parse(readFileSync(path, 'utf8')) as EvidencePlan,
    withLock: (options, action) =>
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
    values: ['evidence', 'plan', 'base', 'worktree', 'lock-directory'],
    flags: ['json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError('land-queue.ts takes options only; see its header.');
  const evidence = requireOption(parsed, 'evidence');
  const plan = dependencies.readPlan(requireOption(parsed, 'plan'));
  const worktree = parsed.values['worktree'] ?? process.cwd();
  const result = await dependencies.withLock(
    { worktree, lockDirectory: parsed.values['lock-directory'] },
    () =>
      landQueueVerdict({
        runner: dependencies.runner,
        evidence,
        plan,
        base: parsed.values['base'] ?? 'origin/main',
        cwd: worktree,
      }),
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
