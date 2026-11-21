#!/usr/bin/env bun
// Chef landing queue: decides, under the merge lock, whether a branch whose evidence was taken at
// commit E may land after `main` moved, or needs a new evidence run.
//
// Every repair on `main` used to force a re-merge and a new run on every open branch, overlapping
// or not (review Cause E). Here the rule is mechanical:
//   1. the commits on `main` since the merge-base of E and `main` are listed, with their files;
//   2. their files are intersected with the plan's scope: the plan's changed files, plus everything
//      its selection reaches: each unit-test workspace and every workspace it depends on,
//      transitively (the whole folder); for the root lane, the modules its tests import,
//      transitively (any `scripts/` file when a test cannot be read); each fixture and
//      end-to-end spec; each fixture slug's source; and the global inputs (`bun.lock`,
//      `turbo.json`, the root `package.json`, any `tsconfig*.json`, `.github/`, `internal/`);
//   3. a commit main's own CI already verified is not counted (owner decision, 2026-11-21): a
//      `main.yml` run triggered by a push to `main` that completed successfully at a commit verifies
//      that commit and every commit before it on `main`. Only the commits after the newest verified
//      one, and any commit no green run covers yet, are intersected with the scope. When the
//      provider cannot be read nothing is verified and the verdict is a REDISPATCH naming why;
//   4. no overlap: LAND, with no new run (the verified commits and their run ids are reported);
//      overlap: REDISPATCH, naming the overlapping files.
// A plan with `requires_full_run` covers the whole tree, so any unverified commit on `main`
// overlaps it.
//
// Usage:
//   bun scripts/chef/land-queue.ts --evidence <sha> --plan <plan.json> [--base origin/main]
//                                  [--worktree <path>] [--lock-directory <path>] [--json]
//
// `--plan` is the JSON of `evidence-plan.ts --json` for the evidence's head. The command is
// ADVISORY: its merge lock and fetch cover only the read, so a merge by another session after it
// returns can still make its answer stale. The binding decision is `direct-merge.ts` step 3b, which
// calls `landQueueVerdict` inside the merge lock the push holds, so the decision and the push are
// one critical section. Exit codes: 0 LAND, 3 REDISPATCH, 2 invalid input.

import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

import { discoverWorkspaces } from '../affected-tests.ts';
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

/** One `main.yml` run triggered by a push to `main`, as the provider reports it. */
export interface MainRun {
  /** The commit the run built. */
  sha: string;
  id: string;
  /** `completed` once the run has finished. */
  status: string;
  /** `success` when every job passed; `null` while the run is in progress. */
  conclusion: string | null;
}

/**
 * Reads the recent `main.yml` push runs on the default branch. It throws when the provider cannot
 * be read: the queue then verifies nothing and fails closed.
 */
export type MainRunReader = () => readonly MainRun[];

/** A commit on `main` that main's own CI already verified, and the run that covers it. */
export interface VerifiedCommit {
  sha: string;
  /** The `main.yml` push run that succeeded at `runSha`. */
  runId: string;
  /** The commit that run built: this one, or a later one on `main`. */
  runSha: string;
}

export interface LandQueueResult {
  verdict: LandVerdict;
  evidence: string;
  mergeBase: string;
  mainHead: string;
  commits: MainCommit[];
  /**
   * The files of `main`'s unverified commits that fall inside the plan's scope, sorted. Empty on
   * LAND.
   */
  overlapping: string[];
  /**
   * The commits since the merge base that main's own CI verified, oldest first, each with the run
   * that covers it. Empty unless some commit overlapped the plan and a green run covered it.
   */
  verified: VerifiedCommit[];
  /** Why the queue could not verify `main` (the provider read failed); absent otherwise. */
  refusal?: string;
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
  /** Any file under `scripts/` is in scope: the root lane's imports could not be computed. */
  anyRootScript: boolean;
}

/**
 * Files that change every task's result whatever the plan selected: the lockfile, the Turborepo and
 * root manifests, any TypeScript configuration, the workflows, and the repository configuration.
 */
const GLOBAL_INPUT =
  /^(?:bun\.lock|turbo\.json|package\.json|\.github\/|internal\/)|(?:^|\/)tsconfig[^/]*\.json$/;

/** The workspaces the plan's tests belong to, with every workspace they depend on, transitively. */
export function reachedDirectories(
  plan: EvidencePlan,
  workspaces: readonly WorkspaceGraphNode[],
): string[] {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const start = new Set<string>(
    plan.unit_tests.filter((lane) => lane.workspace !== '').map((lane) => lane.workspace),
  );
  for (const path of plan.changed)
    for (const workspace of workspaces)
      if (workspace.directory !== '' && path.startsWith(`${workspace.directory}/`))
        start.add(workspace.directory);
  const reached = new Set<string>();
  const pending = workspaces.filter((workspace) => start.has(workspace.directory));
  while (pending.length > 0) {
    const workspace = pending.pop() as WorkspaceGraphNode;
    if (reached.has(workspace.directory)) continue;
    reached.add(workspace.directory);
    for (const name of workspace.dependencies) {
      const dependency = byName.get(name);
      if (dependency !== undefined && dependency.directory !== '') pending.push(dependency);
    }
  }
  return [...reached].toSorted();
}

export interface WorkspaceGraphNode {
  name: string;
  /** Repository-relative, '' for the root. */
  directory: string;
  dependencies: readonly string[];
}

export interface PlanScopeInputs {
  workspaces?: readonly WorkspaceGraphNode[];
  /** Files the root lane's tests import, transitively, as computed by {@link rootImportClosure}. */
  rootImports?: ReadonlySet<string>;
  /** The root lane's imports could not be computed: any `scripts/` file counts. */
  anyRootScript?: boolean;
}

export function planScope(plan: EvidencePlan, inputs: PlanScopeInputs = {}): PlanScope {
  const files = new Set<string>([...plan.changed, ...(inputs.rootImports ?? [])]);
  const directories = reachedDirectories(plan, inputs.workspaces ?? []).map(
    (directory) => `${directory}/`,
  );
  for (const lane of plan.unit_tests) {
    if (lane.workspace === '') {
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
    directories: [...new Set(directories)],
    slugs: new Set(plan.fixture_slugs),
    anyRootScript: inputs.anyRootScript === true,
  };
}

const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * The files the root lane's tests import through relative paths, transitively, read at the evidence
 * commit. A test file that cannot be read makes the closure unknowable, so the caller then treats
 * any `scripts/` change as overlapping.
 */
export function rootImportClosure(
  tests: readonly string[],
  read: (path: string) => string | undefined,
): { files: Set<string>; complete: boolean } {
  const files = new Set<string>();
  let complete = true;
  const pending = [...tests];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    const text = read(path);
    if (text === undefined) {
      if (tests.includes(path)) complete = false;
      continue;
    }
    files.add(path);
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      const target = posix.normalize(posix.join(posix.dirname(path), match[1] ?? ''));
      for (const candidate of [target, `${target}.ts`, `${target}/index.ts`])
        if (read(candidate) !== undefined) {
          pending.push(candidate);
          break;
        }
    }
  }
  return { files, complete };
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
  if (scope.everything || scope.files.has(path) || GLOBAL_INPUT.test(path)) return true;
  if (scope.anyRootScript && path.startsWith('scripts/')) return true;
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
  /** The workspace graph; the repository's own (`affected-tests.ts`) by default. */
  workspaces?: readonly WorkspaceGraphNode[];
  /**
   * Reads main's own `main.yml` push runs. A commit that a successful run built, or that sits
   * before one on `main`, is verified and does not make the evidence stale. Absent, nothing is
   * verified, as before.
   */
  mainRuns?: MainRunReader | undefined;
}

/**
 * The commits main's own CI has verified: a `main.yml` push run that completed successfully at a
 * commit verifies it and every commit before it on `main`. Returns the verified prefix of
 * `commits` (oldest first), each with the earliest successful run at or after it.
 */
function verifiedPrefix(
  commits: readonly MainCommit[],
  runs: readonly MainRun[],
): VerifiedCommit[] {
  const green = new Map<string, string>();
  for (const candidate of runs) {
    if (candidate.status !== 'completed' || candidate.conclusion !== 'success') continue;
    const known = green.get(candidate.sha);
    if (known === undefined || Number(candidate.id) > Number(known))
      green.set(candidate.sha, candidate.id);
  }
  let newest = -1;
  for (let index = commits.length - 1; index >= 0; index -= 1)
    if (green.has(commits[index]?.sha ?? '')) {
      newest = index;
      break;
    }
  const verified: VerifiedCommit[] = [];
  let cover: { runSha: string; runId: string } | undefined;
  for (let index = newest; index >= 0; index -= 1) {
    const sha = commits[index]?.sha ?? '';
    const runId = green.get(sha);
    if (runId !== undefined) cover = { runSha: sha, runId };
    if (cover !== undefined) verified.unshift({ sha, ...cover });
  }
  return verified;
}

/**
 * The verdict for one branch. Fakeable through `runner`: it only reads (`rev-parse`, `merge-base`,
 * `rev-list`, `diff-tree`, `show`), and callers hold the merge lock and have fetched `base`.
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
  const rootTests = plan.unit_tests
    .filter((lane) => lane.workspace === '')
    .flatMap((lane) => lane.paths);
  const closure = rootImportClosure(rootTests, (path) => {
    const result = runner(
      ['git', 'show', `${evidence}:${path}`],
      cwd === undefined ? undefined : { cwd },
    );
    return result.code === 0 ? result.stdout : undefined;
  });
  const scope = planScope(plan, {
    workspaces: options.workspaces ?? discoverWorkspaces(),
    rootImports: closure.files,
    anyRootScript: !closure.complete,
  });
  const commits: MainCommit[] = shas.map((sha) => ({
    sha,
    files: git(
      runner,
      ['diff-tree', '-z', '--no-commit-id', '--name-only', '-r', '--root', '-m', sha],
      cwd,
    )
      // NUL-separated, so a path Git would quote (a non-ASCII or special name) arrives verbatim.
      .split('\0')
      .filter(Boolean),
  }));
  const overlapOf = (candidates: readonly MainCommit[]): string[] => [
    ...new Set(candidates.flatMap((commit) => commit.files.filter((path) => inScope(scope, path)))),
  ];
  let unverified: readonly MainCommit[] = commits;
  let verified: VerifiedCommit[] = [];
  let refusal: string | undefined;
  // Main's own CI is read only when something on main reaches the plan: a commit outside the plan
  // needs no verification, and a quiet main costs no provider call.
  if (overlapOf(commits).length > 0 && options.mainRuns !== undefined) {
    try {
      verified = verifiedPrefix(commits, options.mainRuns());
      unverified = commits.slice(verified.length);
    } catch (error) {
      // Fails closed: with the provider unreadable nothing is verified.
      refusal = `the queue could not verify main: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
  }
  const overlapping = overlapOf(unverified).toSorted();
  return {
    verdict: overlapping.length === 0 ? 'LAND' : 'REDISPATCH',
    evidence,
    mergeBase,
    mainHead,
    commits,
    overlapping,
    verified,
    ...(refusal === undefined ? {} : { refusal }),
  };
}

const MAIN_RUN_LIMIT = 200;

/**
 * The reader for GitHub: `gh run list` for `main.yml` runs triggered by a push to `branch`. It
 * throws on a failed or unreadable response, so the queue verifies nothing.
 */
export function githubMainRuns(
  runner: Runner,
  options: { branch: string; cwd?: string | undefined; repository?: string | undefined },
): MainRunReader {
  return () => {
    const result = runner(
      [
        'gh',
        'run',
        'list',
        ...(options.repository === undefined ? [] : ['--repo', options.repository]),
        '--workflow',
        'main.yml',
        '--branch',
        options.branch,
        '--event',
        'push',
        '--limit',
        String(MAIN_RUN_LIMIT),
        '--json',
        'databaseId,headSha,status,conclusion',
      ],
      options.cwd === undefined ? undefined : { cwd: options.cwd },
    );
    if (result.code !== 0)
      throw new UsageError(
        `gh run list failed: ${result.stderr.trim().split('\n')[0] ?? `exit ${result.code}`}`,
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new UsageError('gh run list did not return JSON');
    }
    if (!Array.isArray(parsed)) throw new UsageError('gh run list did not return a list');
    return parsed.map((entry: unknown): MainRun => {
      if (typeof entry !== 'object' || entry === null)
        throw new UsageError('gh run list returned an entry that is not a run');
      const headSha = 'headSha' in entry ? entry.headSha : undefined;
      const status = 'status' in entry ? entry.status : undefined;
      const databaseId = 'databaseId' in entry ? entry.databaseId : undefined;
      const conclusion = 'conclusion' in entry ? entry.conclusion : undefined;
      if (typeof headSha !== 'string' || typeof status !== 'string')
        throw new UsageError('gh run list returned a run without a head or a status');
      return {
        sha: headSha,
        id:
          typeof databaseId === 'number' || typeof databaseId === 'string'
            ? String(databaseId)
            : '',
        status,
        conclusion: typeof conclusion === 'string' && conclusion !== '' ? conclusion : null,
      };
    });
  };
}

export function formatVerdict(result: LandQueueResult): string {
  const lines = [
    result.verdict,
    `evidence: ${result.evidence}`,
    `merge base: ${result.mergeBase}`,
    `main: ${result.mainHead} (${result.commits.length} commits since the merge base)`,
  ];
  if (result.verdict === 'LAND') {
    lines.push(
      result.verified.length === 0
        ? 'no commit on main touches the plan scope: land without a new run'
        : 'every commit on main that touches the plan scope was verified by main CI: land without a new run',
    );
  } else {
    if (result.refusal !== undefined) lines.push(result.refusal);
    lines.push('commits on main overlap the plan scope: a new evidence run is required');
    for (const path of result.overlapping) lines.push(`  ${path}`);
  }
  lines.push(...describeVerified(result.verified));
  return lines.join('\n');
}

/** One line per `main.yml` run that verified commits, for the refusal and the landing comment. */
export function describeVerified(verified: readonly VerifiedCommit[]): string[] {
  const byRun = new Map<string, VerifiedCommit[]>();
  for (const commit of verified) {
    const group = byRun.get(commit.runId) ?? [];
    group.push(commit);
    byRun.set(commit.runId, group);
  }
  return [...byRun].map(
    ([runId, commits]) =>
      `verified by main.yml run ${runId} (green at ${commits[0]?.runSha.slice(0, 12) ?? ''}): ${commits
        .map((commit) => commit.sha.slice(0, 12))
        .join(', ')}`,
  );
}

export interface LandQueueDependencies {
  runner: Runner;
  /** Main's `main.yml` push runs; the command reads them with `gh` by default. */
  mainRuns?: MainRunReader | undefined;
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
    () => {
      const base = parsed.values['base'] ?? 'origin/main';
      // Fetch inside the lock: a commit another session landed a moment ago must be visible, or
      // the verdict is a wrong LAND.
      const remote = /^([\w.-]+)\/(.+)$/.exec(base);
      if (remote !== null)
        git(dependencies.runner, ['fetch', remote[1] ?? '', remote[2] ?? ''], worktree);
      return landQueueVerdict({
        runner: dependencies.runner,
        evidence,
        plan,
        base,
        cwd: worktree,
        mainRuns:
          dependencies.mainRuns ??
          githubMainRuns(dependencies.runner, {
            branch: remote?.[2] ?? base,
            cwd: worktree,
          }),
      });
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
