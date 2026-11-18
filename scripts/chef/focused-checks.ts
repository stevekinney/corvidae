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
//                   (typecheck:root and turbo run under `scripts/host-slots.ts`, one and two pool
//                   slots, waiting at most five minutes for them, then `not run locally: pool busy`)
//   tests           the direct tests only (owner decision, 2026-11-16): each changed
//                   `*.test.ts` file, and the test files beside each changed source file (same
//                   directory, same stem). Never `affected-tests.ts`'s dependency graph, which
//                   hung over 60 minutes per run on the shared pool. The selection is written as a
//                   manifest that narrows each workspace's own `test` lane (`tests`) and the root
//                   `test:self` lane (`tests:root`).
//   tests:isolated  the same set through the `test:slow` lanes (`tests:isolated`,
//                   `tests:root:isolated`), when it holds a *.integration.test.ts or
//                   *.slow.test.ts file
// The full test evidence is CI on the pushed branch, run once per batch and never waited on.
// A change to a governed process document (AGENTS.md, .agents/skills, .claude/agents,
// .codex/agents) also selects every `*.test.ts` under `scripts/` whose source names that
// document's path or its directory prefix (the word budgets, moved rules, references, command
// spellings, charter), because no sibling test sits beside a Markdown file. An integration test
// that names it joins the isolated set.
// Tests under `scripts/browser-fixtures` are left to CI: their lane builds a curated site.
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
// When the direct set holds one, no lane runs it, and a warning line names it and
// `gh workflow run main.yml --ref <branch>`, to run after the push.
//
// Each step runs in a process group of its own. The hang guard, SIGTERM and SIGINT end the whole
// group (SIGTERM, then SIGKILL after a grace), so no turbo or `bun test` worker outlives its step
// holding a pool slot; a signal to this command also names the step it interrupted.
//
// A change to a Cinder, Chat or Editor component also prints a warning naming the Chromium fixture
// specs (`scripts/browser-fixtures/tests`) that cover it and the command that runs them, for
// whoever runs the design-review capture to run before dispatching the reviewer. A change to
// Cinder's styles, tokens or shared code, or one more than `FIXTURE_SPEC_LIMIT` specs name, gets
// the whole suite's command instead. No step runs them.
//
// Exit codes: 0 every step passed, 1 a step failed or the changed set could not be read,
// 2 invalid usage, 3 a step was killed by a signal, 4 a step hung. 3 and 4 outrank 1: a step that
// gave no verdict is not a test failure, and the run is incomplete.

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { SELECTION_VARIABLE, writeManifest, type Manifest } from '../affected-tests-manifest.ts';
import { ISOLATED_SUFFIXES } from '../affected-tests.ts';
import {
  poolAdmissionErrorExitCode,
  poolBusyExitCode,
  poolWaitVariable,
} from '../bun-test-pool.ts';
import { terminateProcessGroup } from '../run-exclusively.ts';
import { directoryGlob, workspaceParentDirectories } from '../workspace-directories.ts';
import {
  defaultRunner,
  describeError,
  emitResult,
  parseOptions,
  UsageError,
  type Runner,
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
  /** The direct tests' manifest, written by the caller; absent when no test is selected. */
  direct?: DirectSelection | undefined;
}

/** The direct tests as the lanes see them: a written manifest and the lanes it reaches. */
export interface DirectSelection {
  /** The digest naming the manifest, which the lanes read from `CORVIDAE_TEST_SELECTION`. */
  digest: string;
  /** The `--filter` names of the workspaces holding a selected test. */
  filters: string[];
  /** Whether a selected test belongs to the root `test:self` lane. */
  root: boolean;
  /** Whether a selected test is an integration or slow test, which the isolated lanes run. */
  isolated: boolean;
}

const testSuffix = /\.test\.[cm]?[jt]sx?$/;
const browserFixtures = 'scripts/browser-fixtures/';

/** Whether `path` is a test file `bun test` would pick up. */
export function isTestFile(path: string): boolean {
  return testSuffix.test(path);
}

/**
 * The governed process documents, as the path or directory prefix a test names when it guards them.
 * No sibling test sits beside a Markdown file, so a change to one selects the tests that name it.
 */
export const governedPrefixes = [
  'AGENTS.md',
  '.agents/skills',
  '.claude/agents',
  '.codex/agents',
] as const;

/** The governed prefix a changed path falls under, if any. */
function governedPrefix(path: string): string | undefined {
  return governedPrefixes.find((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * The tests that guard the changed governed documents, derived from the tests themselves: every
 * `*.test.ts` under `scripts/` (`scriptTests` maps path to source) whose source names a changed
 * document's path or its governed prefix. Pure.
 */
export function documentGuardTests(
  changed: readonly string[],
  scriptTests: ReadonlyMap<string, string>,
): string[] {
  const named = new Set<string>();
  for (const path of changed) {
    const prefix = governedPrefix(path);
    if (prefix !== undefined) named.add(path).add(prefix);
  }
  if (named.size === 0) return [];
  return [...scriptTests]
    .filter(([, source]) => [...named].some((name) => source.includes(name)))
    .map(([path]) => path)
    .toSorted();
}

/**
 * The direct tests of a change (owner decision, 2026-11-16): each changed test file itself, plus
 * the test files beside each changed source file, in its directory and with its stem
 * (`a.ts` selects `a.test.ts`, `a.slow.test.ts` and `a.integration.test.ts`). The import graph is
 * never read. A changed governed document also selects the `scriptTests` that name it
 * (`documentGuardTests`). A path that no longer exists selects nothing. Pure given its inputs.
 */
export function directTests(
  changed: readonly string[],
  exists: (path: string) => boolean,
  scriptTests: ReadonlyMap<string, string> = new Map(),
): string[] {
  const selected = new Set<string>();
  for (const test of documentGuardTests(changed.filter(exists), scriptTests))
    if (exists(test)) selected.add(test);
  for (const path of changed) {
    if (!exists(path) || path.endsWith('.md') || path.endsWith('.json')) continue;
    if (isTestFile(path)) {
      selected.add(path);
      continue;
    }
    const slash = path.lastIndexOf('/');
    const name = path.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    if (dot <= 0) continue;
    const stem = path.slice(0, slash + 1) + name.slice(0, dot);
    for (const kind of ['test', 'slow.test', 'integration.test'])
      for (const extension of new Set(['.ts', name.slice(dot)])) {
        const candidate = `${stem}.${kind}${extension}`;
        if (isTestFile(candidate) && exists(candidate)) selected.add(candidate);
      }
  }
  return [...selected].toSorted();
}

/**
 * The manifest that narrows the lanes to `tests`, with the lanes it reaches. A test inside a
 * package workspace is listed relative to it; every other test is a root test, relative to the
 * repository root. Tests under `scripts/browser-fixtures` are left to CI.
 */
export function directManifest(
  tests: readonly string[],
  workspaces: readonly WorkspaceReference[],
): { manifest: Manifest; filters: string[]; root: boolean; isolated: boolean } | undefined {
  const manifest: Manifest = { version: 1, workspaces: {} };
  const filters: string[] = [];
  let root = false;
  let isolated = false;
  for (const test of tests) {
    if (test.startsWith(browserFixtures)) continue;
    const owner = workspaceOf(test, workspaces);
    const packaged = owner !== undefined && !owner.directory.startsWith('scripts/');
    const key = packaged ? owner.directory : '.';
    const file = packaged ? test.slice(owner.directory.length + 1) : test;
    const entry = (manifest.workspaces[key] ??= { mode: 'partial', files: [] });
    entry.files.push(file);
    if (packaged) {
      if (!filters.includes(owner.name)) filters.push(owner.name);
    } else root = true;
    if (ISOLATED_SUFFIXES.some((suffix) => test.endsWith(suffix))) isolated = true;
  }
  if (Object.keys(manifest.workspaces).length === 0) return undefined;
  for (const entry of Object.values(manifest.workspaces)) entry.files.sort();
  return { manifest, filters: filters.toSorted(), root, isolated };
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

/** The slots the turbo lint and type-check step holds: its task concurrency, one slot per task. */
const TURBO_SLOTS = 2;

/**
 * The prefix that runs a type-check under host slots from the pool `bun test` uses, one slot per
 * task kept busy, with the same bounded wait as the direct tests. Several sessions' `svelte-check`
 * runs filled the host's swap, and one focused-checks run sat for over an hour on a 33-second
 * type-check; past the bound the step reports `not run locally: pool busy`, as the tests do.
 */
function pooled(slots: number): string[] {
  return [
    'env',
    `${poolWaitVariable}=300`,
    'bun',
    'scripts/host-slots.ts',
    `--slots=${slots}`,
    '--',
  ];
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
    steps.push({
      name: 'typecheck:root',
      command: [...pooled(1), 'bun', 'run', 'typecheck:root'],
    });
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
      command: [
        ...pooled(TURBO_SLOTS),
        'bunx',
        'turbo',
        'run',
        'lint',
        'typecheck',
        `--concurrency=${TURBO_SLOTS}`,
        ...names.map((n) => `--filter=${n}`),
      ],
    });
  const direct = input.direct;
  if (direct === undefined) return steps;
  const filters = direct.filters.map((name) => `--filter=${name}`);
  const lanes = (isolated: boolean) => {
    const suffix = isolated ? ':isolated' : '';
    const extra = isolated ? ['--concurrency=1'] : [];
    // A worker's direct tests wait at most five minutes for a pool slot, then run without one.
    const select = [
      'env',
      `${SELECTION_VARIABLE}=${direct.digest}`,
      `${poolWaitVariable}=300`,
      'bunx',
      'turbo',
      'run',
    ];
    if (filters.length > 0)
      steps.push({
        name: `tests${suffix}`,
        command: [...select, isolated ? 'test:slow' : 'test', ...filters, ...extra],
      });
    if (direct.root)
      steps.push({
        name: `tests:root${suffix}`,
        command: [...select, isolated ? 'test:self:slow' : 'test:self', '--filter=//', ...extra],
      });
  };
  lanes(false);
  if (direct.isolated) lanes(true);
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

/** Above this many fixture specs for one change, the advice is the whole Chromium suite. */
export const FIXTURE_SPEC_LIMIT = 8;
/** Runs the whole Chromium fixture suite. */
export const FIXTURE_SUITE_COMMAND = 'bun run test:browser:chromium';
/** Runs the named Chromium fixture specs, which follow it. */
export const FIXTURE_SPECS_COMMAND =
  'bun scripts/browser-fixtures/scripts/prepare-manifest.ts && bun scripts/host-slots.ts --slots=1 -- bun --bun playwright test --config scripts/browser-fixtures/playwright.config.ts --project=chromium';
/**
 * The sweep that mounts every Cinder component from the manifest. It takes about 20 minutes on one
 * slot, so the named specs leave it out; the whole suite runs it.
 */
export const FIXTURE_SWEEP_SPEC = 'components.playwright.ts';

const cinderSource = 'components/cinder/src/';
const cinderComponent = /^components\/cinder\/src\/components\/([^/]+)\//;
const editorComponent = /^components\/editor\/src\/lib\/components\/([^/]+)\//;

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a spec's file name carries `name` as whole hyphen-separated words. */
function fileNames(spec: string, name: string): boolean {
  return new RegExp(`(?:^|-)${escaped(name)}(?:-|\\.)`).test(spec);
}

/** Whether a spec's source names a Cinder component, as `citation` or `Citation`. */
function sourceNames(source: string, name: string): boolean {
  const pascal = name
    .split('-')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join('');
  return new RegExp(`(?<![\\w-])(?:${escaped(name)}|${pascal})(?![\\w-])`).test(source);
}

/**
 * The warning that names the Chromium fixture specs covering a change to a Cinder, Chat or Editor
 * component, or the whole suite for a change no component name bounds. Undefined when the change
 * touches none of them. `specs` maps each spec's file name to its source. Pure.
 */
export function fixtureSpecAdvice(
  changed: readonly string[],
  specs: ReadonlyMap<string, string>,
): string | undefined {
  const cinder = new Set<string>();
  const others = new Set<string>();
  let shared = false;
  for (const path of changed) {
    if (testFile.test(path) || path.endsWith('.md')) continue;
    const cinderName = cinderComponent.exec(path)?.[1];
    const editorName = editorComponent.exec(path)?.[1];
    if (cinderName !== undefined) cinder.add(cinderName);
    else if (path.startsWith(cinderSource)) shared = true;
    else if (editorName !== undefined) others.add(editorName);
    else if (path.startsWith('components/editor/src/')) others.add('editor');
    else if (path.startsWith('components/chat/src/')) others.add('chat');
  }
  if (!shared && cinder.size + others.size === 0) return undefined;
  const reason = 'workers never run a browser on the host';
  const whole = (why: string) =>
    `${why}; ${reason}, so whoever runs the design-review capture runs the whole Chromium fixture suite first: \`${FIXTURE_SUITE_COMMAND}\`.`;
  if (shared) return whole("the change touches Cinder's styles, tokens or shared code");
  const names = [...cinder, ...others].toSorted();
  const selected = new Set<string>();
  for (const [spec, source] of specs) {
    if (spec === FIXTURE_SWEEP_SPEC) continue;
    if (names.some((name) => fileNames(spec, name))) selected.add(spec);
    else if ([...cinder].some((name) => sourceNames(source, name))) selected.add(spec);
  }
  const subject = `the change touches ${names.join(', ')}`;
  if (selected.size === 0) return whole(`${subject}, which no fixture spec names`);
  if (selected.size > FIXTURE_SPEC_LIMIT)
    return whole(`${subject}, which ${selected.size} fixture specs name`);
  return `${subject}; ${reason}, so whoever runs the design-review capture runs these fixture specs first: \`${FIXTURE_SPECS_COMMAND} ${[...selected].toSorted().join(' ')}\`.`;
}

/** Each Chromium fixture spec's file name and source; empty where the directory is missing. */
export function readFixtureSpecs(root: string): Map<string, string> {
  const directory = join(root, 'scripts/browser-fixtures/tests');
  const specs = new Map<string, string>();
  if (!existsSync(directory)) return specs;
  for (const name of new Bun.Glob('*.playwright.ts').scanSync({ cwd: directory }))
    specs.set(name, readFileSync(join(directory, name), 'utf8'));
  return specs;
}

/** Every `*.test.ts` file under `scripts/` and its source. */
export function readScriptTests(root: string): Map<string, string> {
  const tests = new Map<string, string>();
  for (const path of new Bun.Glob('scripts/**/*.test.ts').scanSync({ cwd: root }))
    if (!path.includes('node_modules/')) tests.set(path, readFileSync(join(root, path), 'utf8'));
  return tests;
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
  /** The test pool did not admit this step, so it did not start tests. */
  pending?: true;
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
  /** Writes the direct tests' manifest and returns its digest. */
  writeSelection?: (manifest: Manifest, root: string) => string;
  /** Each Chromium fixture spec's file name and source. */
  fixtureSpecs?: (root: string) => ReadonlyMap<string, string>;
  /** Each `*.test.ts` file under `scripts/` and its source, which a governed document change reads. */
  scriptTests?: (root: string) => ReadonlyMap<string, string>;
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

/** Work deliberately left to the provider's full-suite audit, never counted as a local pass. */
export function broaderObligations(browserTests: readonly string[]): string[] {
  const obligations = [
    'Full CI remains required for transitive consumers, dynamic entrypoints, browser fixtures, and isolated tests not selected directly.',
  ];
  if (browserTests.length > 0)
    obligations.push(
      `${browserTests.join(', ')} require provider browser execution: ${BROWSER_CI_COMMAND}.`,
    );
  return obligations;
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
  const fixtureAdvice = fixtureSpecAdvice(
    changed,
    (dependencies.fixtureSpecs ?? readFixtureSpecs)(root),
  );
  if (fixtureAdvice !== undefined) warnings.push(fixtureAdvice);

  const candidates = directTests(
    changed,
    exists,
    (dependencies.scriptTests ?? readScriptTests)(root),
  );
  const browserTests = candidates.filter(
    (path) =>
      ISOLATED_SUFFIXES.some((suffix) => path.endsWith(suffix)) &&
      launchesBrowser(readText(path) ?? ''),
  );
  const selected = directManifest(
    candidates.filter((path) => !browserTests.includes(path)),
    workspaces,
  );
  const direct: DirectSelection | undefined =
    selected === undefined
      ? undefined
      : {
          digest: (dependencies.writeSelection ?? writeManifest)(selected.manifest, root),
          filters: selected.filters,
          root: selected.root,
          isolated: selected.isolated,
        };

  const steps = planSteps({
    changed,
    existing: changed.filter(exists),
    workspaces,
    base,
    direct,
  });
  if (browserTests.length > 0)
    warnings.push(
      `${browserTests.join(', ')} launch a browser, which workers never run on the host, so no lane runs them; after pushing, run \`${BROWSER_CI_COMMAND}\`.`,
    );
  const broader = broaderObligations(browserTests);
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
        ? {
            name: step.name,
            command,
            exitCode: ended,
            ...(ended === poolBusyExitCode || ended === poolAdmissionErrorExitCode
              ? { pending: true as const }
              : {}),
          }
        : { name: step.name, command, exitCode: null, ...ended },
    );
  }
  const pending = results.filter((step) => step.pending === true);
  const failed = results.filter(
    (step) => step.exitCode !== null && step.exitCode !== 0 && step.pending !== true,
  );
  const killed = results.filter((step) => step.signal !== undefined);
  const hung = results.filter((step) => step.hung === true);
  const ok = failed.length + killed.length + hung.length + pending.length === 0;
  // A signal or a hang means a step gave no verdict, so it outranks a failure that did.
  const code =
    killed.length > 0 ? 3 : hung.length > 0 ? 4 : failed.length + pending.length > 0 ? 1 : 0;
  if (options.json)
    return {
      code,
      output: JSON.stringify({ ok, steps: results, warnings, broaderObligations: broader }),
    };
  const named = (group: StepResult[]) => group.map((step) => step.name).join(', ');
  const summary = options.dryRun
    ? `focused-checks: dry run, ${results.length} steps planned`
    : `focused-checks: ${results.length - failed.length - killed.length - hung.length - pending.length} passed, ${failed.length} failed${
        failed.length > 0 ? ` (${named(failed)})` : ''
      }${pending.length > 0 ? `, ${pending.length} pending (${named(pending)})` : ''}${
        killed.length > 0 ? `, ${killed.length} killed by a signal` : ''
      }${hung.length > 0 ? `, ${hung.length} hung` : ''}`;
  const lines = [
    ...warnings.map((warning) => `focused-checks: warning: ${warning}`),
    ...(options.dryRun ? results.map((step) => `  ${step.name}: ${step.command}`) : []),
    ...killed.map((step) => `focused-checks: ${step.name}: killed by ${step.signal}`),
    ...hung.map(
      (step) =>
        `focused-checks: ${step.name}: hung (no result within ${STEP_HANG_GUARD_MILLISECONDS / 60_000} minutes; stopped)`,
    ),
    ...broader.map((obligation) => `focused-checks: pending broader obligation: ${obligation}`),
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
