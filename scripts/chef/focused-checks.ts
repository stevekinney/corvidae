#!/usr/bin/env bun
// Chef focused checks: the per-pull-request gate (AGENTS.md "Gate on local checks") as one
// command, so a worker runs a single line before opening its pull request instead of
// reassembling the list from prose.
//
// Usage:
//   bun scripts/chef/focused-checks.ts [--base <rev>] [--json] [--dry-run]
//
// The changed set is every path that differs from the merge base with `--base` (default
// `origin/main`): committed, staged, unstaged and untracked. The plan, in order:
//   prettier        bunx prettier --check on the changed files that still exist
//   lint:root       bun run lint:root, always
//   typecheck:root  bun run typecheck:root, when a changed file is at the root or under scripts/
//   turbo           bunx turbo run lint typecheck, filtered to each changed workspace
//   tests           bun scripts/affected-tests.ts run (the quick tier)
//   tests:isolated  bun scripts/affected-tests.ts run --isolated, when the selection reaches a
//                   *.integration.test.ts or *.slow.test.ts file
// Steps run one after another and a failure does not stop the rest. A diff of more than 3,000 added
// and deleted lines outside test files, or of more than 60 files, prints a warning suggesting a
// split; it never fails the run.
//
// With --json the result is {ok, steps: [{name, command, exitCode}], warnings} on standard output
// and the steps' own output goes to standard error. --dry-run prints the plan and runs nothing.
//
// Exit codes: 0 every step passed, 1 a step failed or the changed set could not be read,
// 2 invalid usage.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISOLATED_SUFFIXES } from '../affected-tests.ts';
import { directoryGlob, workspaceParentDirectories } from '../workspace-directories.ts';
import {
  defaultRunner,
  describeError,
  emitResult,
  parseOptions,
  type Runner,
  UsageError,
} from './process-runner.ts';

export { UsageError };

/**
 * A diff above this many added plus deleted lines outside test files draws the split warning. Work
 * is sized by area at 500 to 2,000 changed lines, because tokens per changed line fall as a unit
 * grows (`.agents/skills/chef/references/planning-and-routing.md` "Sizing and splitting").
 */
export const LINE_LIMIT = 3000;
/** A diff above this many changed files draws the split warning. */
export const FILE_LIMIT = 60;

export interface WorkspaceReference {
  name: string;
  /** Repository-relative directory, without a trailing slash. */
  directory: string;
}

export interface PlannedStep {
  name: string;
  command: string[];
}

export interface PlanInput {
  changed: readonly string[];
  /** The changed files that still exist, which prettier can read. */
  existing: readonly string[];
  workspaces: readonly WorkspaceReference[];
  base: string;
  /** Whether the quick-tier selection reaches an integration or slow test file. */
  selectsIsolatedTest: boolean;
}

/** The workspace owning `path`: the one with the longest directory prefix, if any. */
export function workspaceOf(
  path: string,
  workspaces: readonly WorkspaceReference[],
): WorkspaceReference | undefined {
  let owner: WorkspaceReference | undefined;
  for (const workspace of workspaces) {
    if (!path.startsWith(`${workspace.directory}/`)) continue;
    if (owner === undefined || workspace.directory.length > owner.directory.length)
      owner = workspace;
  }
  return owner;
}

/** Whether `path` is a root file or lives under `scripts/`, which the root type-check covers. */
export function touchesRootTypecheck(path: string): boolean {
  return !path.includes('/') || path.startsWith('scripts/');
}

/** The focused-check steps for a change, in order. Pure. */
export function planSteps(input: PlanInput): PlannedStep[] {
  const steps: PlannedStep[] = [];
  if (input.existing.length > 0)
    steps.push({
      name: 'prettier',
      command: ['bunx', 'prettier', '--check', '--ignore-unknown', ...input.existing],
    });
  steps.push({ name: 'lint:root', command: ['bun', 'run', 'lint:root'] });
  if (input.changed.some(touchesRootTypecheck))
    steps.push({ name: 'typecheck:root', command: ['bun', 'run', 'typecheck:root'] });
  const names = [
    ...new Set(
      input.changed.flatMap((path) => {
        const owner = workspaceOf(path, input.workspaces);
        return owner === undefined ? [] : [owner.name];
      }),
    ),
  ].toSorted();
  if (names.length > 0)
    steps.push({
      name: 'turbo',
      command: ['bunx', 'turbo', 'run', 'lint', 'typecheck', ...names.map((n) => `--filter=${n}`)],
    });
  steps.push({
    name: 'tests',
    command: ['bun', 'scripts/affected-tests.ts', 'run', '--base', input.base],
  });
  if (input.selectsIsolatedTest)
    steps.push({
      name: 'tests:isolated',
      command: ['bun', 'scripts/affected-tests.ts', 'run', '--isolated', '--base', input.base],
    });
  return steps;
}

const testFile = /\.(?:test|spec|bench|playwright)\.[cm]?[jt]sx?$|(?:^|\/)tests?\//;

/** The size of a change as the warning judges it. */
export interface DiffSize {
  files: number;
  codeLines: number;
}

/**
 * The size of a change from `git diff --numstat` rows and the line counts of untracked files:
 * its file count and its added plus deleted lines outside test files.
 */
export function diffSize(numstat: string, untracked: Map<string, number>): DiffSize {
  const files = new Set<string>();
  let codeLines = 0;
  for (const row of numstat.split('\n')) {
    const [added, deleted, ...rest] = row.split('\t');
    const path = rest.join('\t');
    if (path === '') continue;
    files.add(path);
    if (!testFile.test(path)) codeLines += (Number(added) || 0) + (Number(deleted) || 0);
  }
  for (const [path, lines] of untracked) {
    files.add(path);
    if (!testFile.test(path)) codeLines += lines;
  }
  return { files: files.size, codeLines };
}

/** The split warnings for a change of `size`, none when it is within both limits. */
export function sizeWarnings(size: DiffSize): string[] {
  const warnings: string[] = [];
  if (size.codeLines > LINE_LIMIT)
    warnings.push(
      `diff is ${size.codeLines} added and deleted lines outside test files (over ${LINE_LIMIT}); consider splitting this pull request.`,
    );
  if (size.files > FILE_LIMIT)
    warnings.push(
      `diff touches ${size.files} files (over ${FILE_LIMIT}); consider splitting this pull request.`,
    );
  return warnings;
}

export interface StepResult {
  name: string;
  command: string;
  exitCode: number | null;
}

export interface FocusedDependencies {
  /** Runs the read-only git and selection commands. */
  runner?: Runner;
  /** Runs one step's command with its output visible and returns its exit code. */
  execute?: (command: string[], cwd: string, json: boolean) => number;
  exists?: (path: string) => boolean;
  readText?: (path: string) => string | undefined;
  workspaces?: (root: string) => WorkspaceReference[];
  /** Progress lines; standard error by default. */
  log?: (line: string) => void;
}

/** Every workspace below `root`, named by its `package.json`. The root package is not one. */
export function discoverWorkspaceReferences(root: string): WorkspaceReference[] {
  const patterns = [
    `${directoryGlob(workspaceParentDirectories)}/*/package.json`,
    'scripts/browser-fixtures/package.json',
  ];
  const found: WorkspaceReference[] = [];
  for (const pattern of patterns) {
    for (const match of new Bun.Glob(pattern).scanSync({ cwd: root })) {
      const directory = match.slice(0, -'/package.json'.length);
      try {
        const manifest = JSON.parse(readFileSync(join(root, match), 'utf8')) as { name?: string };
        if (manifest.name !== undefined) found.push({ name: manifest.name, directory });
      } catch {
        // A package.json that does not parse names no workspace; the root lint reports it.
      }
    }
  }
  return found;
}

function defaultExecute(command: string[], cwd: string, json: boolean): number {
  const result = Bun.spawnSync(command, {
    cwd,
    stdin: 'inherit',
    stdout: json ? 2 : 'inherit',
    stderr: 'inherit',
  });
  return result.exitCode ?? 1;
}

function gitLines(runner: Runner, root: string, args: string[]): string[] {
  const result = runner(['git', ...args], { cwd: root });
  if (result.code !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim().split('\n').at(-1)}`);
  return result.stdout.split('\n').filter((line) => line !== '');
}

export interface FocusedResult {
  code: number;
  output: string;
}

/** Plan, and unless `dryRun`, run the focused checks for the change at `root`. */
export function runChecks(
  root: string,
  options: { base: string; json: boolean; dryRun: boolean },
  dependencies: FocusedDependencies = {},
): FocusedResult {
  const runner = dependencies.runner ?? defaultRunner;
  const execute = dependencies.execute ?? defaultExecute;
  const exists = dependencies.exists ?? ((path: string) => existsSync(join(root, path)));
  const readText =
    dependencies.readText ??
    ((path: string) => {
      try {
        return readFileSync(join(root, path), 'utf8');
      } catch {
        return undefined;
      }
    });
  const workspaces = (dependencies.workspaces ?? discoverWorkspaceReferences)(root);
  const log = dependencies.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const warnings: string[] = [];
  const failure = (message: string): FocusedResult => ({
    code: 1,
    output: options.json
      ? JSON.stringify({ ok: false, steps: [], warnings, error: message })
      : message,
  });

  let changed: string[];
  let base: string;
  let size: DiffSize;
  try {
    base = gitLines(runner, root, ['merge-base', options.base, 'HEAD'])[0] ?? '';
    if (base === '')
      return failure(`focused-checks: no merge base between ${options.base} and HEAD.`);
    const tracked = gitLines(runner, root, ['diff', '--name-only', '--no-renames', base]);
    const untracked = gitLines(runner, root, ['ls-files', '--others', '--exclude-standard']);
    changed = [...new Set([...tracked, ...untracked])].toSorted();
    const untrackedLines = new Map(
      untracked.map((path) => [path, (readText(path) ?? '').split('\n').length] as const),
    );
    size = diffSize(
      gitLines(runner, root, ['diff', '--numstat', '--no-renames', base]).join('\n'),
      untrackedLines,
    );
  } catch (error) {
    return failure(`focused-checks: could not read the changed files (${describeError(error)}).`);
  }
  warnings.push(...sizeWarnings(size));

  let selectsIsolatedTest = false;
  const selection = runner(['bun', 'scripts/affected-tests.ts', '--json', '--base', base], {
    cwd: root,
  });
  if (selection.code === 0) {
    try {
      const parsed = JSON.parse(selection.stdout) as { view: { tests: string[] }[] };
      selectsIsolatedTest = parsed.view.some((workspace) =>
        workspace.tests.some((path) => ISOLATED_SUFFIXES.some((suffix) => path.endsWith(suffix))),
      );
    } catch {
      warnings.push('could not read the affected-tests selection; the isolated lane is skipped.');
    }
  } else {
    warnings.push(`affected-tests --json exited ${selection.code}; the isolated lane is skipped.`);
  }

  const steps = planSteps({
    changed,
    existing: changed.filter(exists),
    workspaces,
    base,
    selectsIsolatedTest,
  });
  const results: StepResult[] = [];
  for (const step of steps) {
    const command = step.command.join(' ');
    if (options.dryRun) {
      results.push({ name: step.name, command, exitCode: null });
      continue;
    }
    log(`focused-checks: ${step.name}: ${command}`);
    results.push({ name: step.name, command, exitCode: execute(step.command, root, options.json) });
  }
  const failed = results.filter((step) => step.exitCode !== null && step.exitCode !== 0);
  const ok = failed.length === 0;
  if (options.json)
    return { code: ok ? 0 : 1, output: JSON.stringify({ ok, steps: results, warnings }) };
  const summary = options.dryRun
    ? `focused-checks: dry run, ${results.length} steps planned`
    : `focused-checks: ${results.length - failed.length} passed, ${failed.length} failed${
        failed.length > 0 ? ` (${failed.map((step) => step.name).join(', ')})` : ''
      }`;
  const lines = [
    ...warnings.map((warning) => `focused-checks: warning: ${warning}`),
    ...(options.dryRun ? results.map((step) => `  ${step.name}: ${step.command}`) : []),
    summary,
  ];
  return { code: ok ? 0 : 1, output: lines.join('\n') };
}

function worktreeRoot(runner: Runner): string {
  const result = runner(['git', 'rev-parse', '--show-toplevel']);
  if (result.code !== 0) throw new UsageError('focused-checks.ts must run inside a Git checkout.');
  return result.stdout.trim();
}

export function run(
  argv: string[],
  dependencies: FocusedDependencies = {},
  root?: string,
): FocusedResult {
  const parsed = parseOptions(argv, { values: ['base'], flags: ['json', 'dry-run'] });
  if (parsed.positionals.length > 0)
    throw new UsageError('Usage: focused-checks.ts [--base <rev>] [--json] [--dry-run]');
  return runChecks(
    root ?? worktreeRoot(dependencies.runner ?? defaultRunner),
    {
      base: parsed.values['base'] ?? 'origin/main',
      json: parsed.flags.has('json'),
      dryRun: parsed.flags.has('dry-run'),
    },
    dependencies,
  );
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
