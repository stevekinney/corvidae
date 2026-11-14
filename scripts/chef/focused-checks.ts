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
// With --json the result is {ok, steps: [{name, command, exitCode, signal?, hung?}], warnings} on
// standard output and the steps' own output goes to standard error. --dry-run prints the plan and
// runs nothing.
//
// A step a signal ends is reported as `<step>: killed by SIGTERM`, not as a failed test; a step with
// no result after an hour (`STEP_HANG_GUARD_MILLISECONDS`) is stopped and reported as hung.
//
// Workers never run a browser suite on the host (owner decision, 2026-11-13). The planned tiers
// never run the Playwright suites (`test:browser`), and the real-browser smoke tests skip unless
// `WEFT_BROWSER_SMOKE=1`, but a few `*.integration.test.ts` files launch Chromium unconditionally.
// When the selection reaches one, the `tests:isolated` step runs with `--exclude <file>` for each,
// and a warning line names them and `gh workflow run main.yml --ref <branch>`, to run after the push.
//
// Each step runs in a process group of its own. The hang guard, SIGTERM and SIGINT end the whole
// group (SIGTERM, then SIGKILL after a grace), so no turbo or `bun test` worker outlives its step
// holding a pool slot; a signal to this command also names the step it interrupted.
//
// Exit codes: 0 every step passed, 1 a step failed or the changed set could not be read,
// 2 invalid usage, 3 a step was killed by a signal, 4 a step hung. 3 and 4 outrank 1: a step that
// gave no verdict is not a test failure, and the run is incomplete.

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { ISOLATED_SUFFIXES } from '../affected-tests.ts';
import { terminateProcessGroup } from '../run-exclusively.ts';
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

/**
 * Whether prettier can check `path`: it still exists and is not a symbolic link, which prettier
 * refuses when named explicitly (a skill linked into `.claude/skills` and `.codex/skills`).
 */
export function prettierReadable(root: string, path: string): boolean {
  const full = join(root, path);
  return existsSync(full) && !lstatSync(full).isSymbolicLink();
}

export interface PlanInput {
  changed: readonly string[];
  /** The changed files that still exist and are not symbolic links, which prettier can read. */
  existing: readonly string[];
  workspaces: readonly WorkspaceReference[];
  base: string;
  /** Whether the quick-tier selection reaches an integration or slow test file. */
  selectsIsolatedTest: boolean;
  /** The selected isolated test files that launch a browser; the isolated lane excludes them. */
  browserTests?: readonly string[];
}

/** The CI command a skipped browser lane points to, named in the line printed in its place. */
export const BROWSER_CI_COMMAND = 'gh workflow run main.yml --ref <branch>';

/** Whether a test's source launches a browser itself, with no environment gate in front of it. */
export function launchesBrowser(source: string): boolean {
  return (
    /\b(?:chromium|firefox|webkit)\.launch(?:PersistentContext)?\(/.test(source) &&
    !/\bskipIf\(/.test(source)
  );
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
      command: [
        'bun',
        'scripts/affected-tests.ts',
        'run',
        '--isolated',
        ...(input.browserTests ?? []).flatMap((path) => ['--exclude', path]),
        '--base',
        input.base,
      ],
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
  /** Null for a dry run, a step killed by a signal, and a step that produced no result. */
  exitCode: number | null;
  /** The signal that ended the step, such as `SIGTERM`. */
  signal?: string;
  /** Set when the step produced no result within the hang guard and was stopped. */
  hung?: true;
}

/** How a step ended without an exit code: by a signal, or by outliving the hang guard. */
export type StepEnd = { signal: string } | { hung: true };

/**
 * How long one step may run before it counts as hung. The heaviest step is a full test tier, which
 * takes tens of minutes on a loaded host, so the guard sits well above that.
 */
export const STEP_HANG_GUARD_MILLISECONDS = 60 * 60_000;

export interface FocusedDependencies {
  /** Runs the read-only git and selection commands. */
  runner?: Runner;
  /**
   * Runs one step's command with its output visible and returns its exit code, or how it ended
   * without one.
   */
  execute?: (
    command: string[],
    cwd: string,
    json: boolean,
  ) => number | StepEnd | Promise<number | StepEnd>;
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
    'scripts/groom/package.json',
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

/**
 * Runs one step to its end. A step the hang guard stopped is hung, and a step a signal ended is
 * that signal; only a step that exited has an exit code.
 */
export async function executeStep(
  command: string[],
  cwd: string,
  json: boolean,
  timeout: number = STEP_HANG_GUARD_MILLISECONDS,
): Promise<number | StepEnd> {
  const [program = '', ...rest] = command;
  // A process group of its own, so the guard and a signal end turbo and `bun test` workers too.
  const child = spawn(program, rest, {
    cwd,
    detached: true,
    stdio: ['ignore', json ? 2 : 'inherit', 'inherit'],
  });
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve([code, signal]));
    child.once('error', reject);
  });
  const group = child.pid;
  if (group === undefined) {
    await exited.catch(() => undefined);
    return 127;
  }
  activeStep.group = group;
  let hung = false;
  const timer = setTimeout(() => {
    hung = true;
    void terminateProcessGroup(group);
  }, timeout);
  try {
    const [code, signal] = await exited;
    if (hung) return { hung: true };
    if (signal !== null) return { signal };
    return code ?? 1;
  } finally {
    clearTimeout(timer);
    activeStep.group = undefined;
    // What the step leaked (a worker still holding a pool slot) ends with it.
    await terminateProcessGroup(group);
  }
}

/** The step running now: its name for the interruption line, and the group to end. */
export const activeStep: { name?: string | undefined; group?: number | undefined } = {};

/**
 * Ends the running step's process group after a signal to this command and says which step it
 * interrupted. Resolves to the exit code this command takes: 128 plus the signal number.
 */
export async function interruptActiveStep(
  signal: NodeJS.Signals,
  log: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
): Promise<number> {
  const { name, group } = activeStep;
  log(
    `focused-checks: interrupted by ${signal} during ${name === undefined ? 'no step' : `step ${name}`}`,
  );
  if (group !== undefined) await terminateProcessGroup(group);
  return 128 + (constants.signals[signal] ?? 0);
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
export async function runChecks(
  root: string,
  options: { base: string; json: boolean; dryRun: boolean },
  dependencies: FocusedDependencies = {},
): Promise<FocusedResult> {
  const runner = dependencies.runner ?? defaultRunner;
  const execute = dependencies.execute ?? executeStep;
  const exists = dependencies.exists ?? ((path: string) => prettierReadable(root, path));
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
  const browserTests: string[] = [];
  const selection = runner(['bun', 'scripts/affected-tests.ts', '--json', '--base', base], {
    cwd: root,
  });
  if (selection.code === 0) {
    try {
      const parsed = JSON.parse(selection.stdout) as { view: { tests: string[] }[] };
      const isolated = parsed.view
        .flatMap((workspace) => workspace.tests)
        .filter((path) => ISOLATED_SUFFIXES.some((suffix) => path.endsWith(suffix)));
      selectsIsolatedTest = isolated.length > 0;
      browserTests.push(...isolated.filter((path) => launchesBrowser(readText(path) ?? '')));
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
    browserTests,
  });
  if (selectsIsolatedTest && browserTests.length > 0)
    warnings.push(
      `tests:isolated excludes ${browserTests.join(', ')}: they launch a browser, which workers never run on the host; after pushing, run \`${BROWSER_CI_COMMAND}\`.`,
    );
  const results: StepResult[] = [];
  for (const step of steps) {
    const command = step.command.join(' ');
    if (options.dryRun) {
      results.push({ name: step.name, command, exitCode: null });
      continue;
    }
    log(`focused-checks: ${step.name}: ${command}`);
    activeStep.name = step.name;
    const ended = await execute(step.command, root, options.json);
    activeStep.name = undefined;
    results.push(
      typeof ended === 'number'
        ? { name: step.name, command, exitCode: ended }
        : { name: step.name, command, exitCode: null, ...ended },
    );
  }
  const failed = results.filter((step) => step.exitCode !== null && step.exitCode !== 0);
  const killed = results.filter((step) => step.signal !== undefined);
  const hung = results.filter((step) => step.hung === true);
  const ok = failed.length + killed.length + hung.length === 0;
  // A signal or a hang means a step gave no verdict, so it outranks a failure that did.
  const code = killed.length > 0 ? 3 : hung.length > 0 ? 4 : failed.length > 0 ? 1 : 0;
  if (options.json) return { code, output: JSON.stringify({ ok, steps: results, warnings }) };
  const named = (group: StepResult[]) => group.map((step) => step.name).join(', ');
  const summary = options.dryRun
    ? `focused-checks: dry run, ${results.length} steps planned`
    : `focused-checks: ${results.length - failed.length - killed.length - hung.length} passed, ${failed.length} failed${
        failed.length > 0 ? ` (${named(failed)})` : ''
      }${killed.length > 0 ? `, ${killed.length} killed by a signal` : ''}${
        hung.length > 0 ? `, ${hung.length} hung` : ''
      }`;
  const lines = [
    ...warnings.map((warning) => `focused-checks: warning: ${warning}`),
    ...(options.dryRun ? results.map((step) => `  ${step.name}: ${step.command}`) : []),
    ...killed.map((step) => `focused-checks: ${step.name}: killed by ${step.signal}`),
    ...hung.map(
      (step) =>
        `focused-checks: ${step.name}: hung (no result within ${STEP_HANG_GUARD_MILLISECONDS / 60_000} minutes; stopped)`,
    ),
    summary,
  ];
  return { code, output: lines.join('\n') };
}

function worktreeRoot(runner: Runner): string {
  const result = runner(['git', 'rev-parse', '--show-toplevel']);
  if (result.code !== 0) throw new UsageError('focused-checks.ts must run inside a Git checkout.');
  return result.stdout.trim();
}

export async function run(
  argv: string[],
  dependencies: FocusedDependencies = {},
  root?: string,
): Promise<FocusedResult> {
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
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, () => {
      void interruptActiveStep(signal).then((code) => process.exit(code));
    });
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
