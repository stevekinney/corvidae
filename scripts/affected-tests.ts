#!/usr/bin/env bun
/**
 * Run only the tests a change can reach.
 *
 * `bun run check` calls `bun scripts/affected-tests.ts run`. This script finds the files that
 * differ from the merge base with `origin/main` (committed, staged, unstaged, and untracked),
 * selects the test files whose import graph reaches them (`affected-tests-selection.ts`), and runs
 * each workspace's own lanes through Turborepo:
 *
 * - A workspace selected whole (a fallback rule fired, or every test file was reached) runs
 *   `test:gate`, the unchanged lane that keeps its coverage floor.
 * - A workspace selected in part runs `test` with `CORVIDAE_TEST_SELECTION` set, so its runner
 *   narrows to the selected files and no floor is judged on a partial file set.
 * - A workspace with nothing selected runs nothing.
 *
 * Usage:
 *   bun scripts/affected-tests.ts run [--base <rev>] [--changed <path>...]
 *   bun scripts/affected-tests.ts --explain [--base <rev>] [--changed <path>...]
 *   bun scripts/affected-tests.ts --json [--base <rev>] [--changed <path>...]
 *
 * `--changed` replaces the Git-derived changed set, which is how a dry run answers "what would a
 * change to this file select?". Exit codes: 0 success, 1 a lane failed, 2 invalid usage.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type SourceTree, type WorkspaceDescription } from './affected-tests-graph.ts';
import {
  buildManifest,
  repositoryRoot,
  SELECTION_VARIABLE,
  writeManifest,
} from './affected-tests-manifest.ts';
import {
  selectTests,
  type Reason,
  type Selection,
  type WorkspaceSelection,
} from './affected-tests-selection.ts';

// --- Workspace discovery ----------------------------------------------------------------------

interface PackageManifest {
  name?: string;
  workspaces?: string[];
  exports?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** The scripts `check` and `validate` run, whose entrypoints are lane machinery. */
const LANE_SCRIPTS = new Set([
  'test',
  'test:slow',
  'test:coverage',
  'test:host',
  'test:gate',
  'test:self',
  'test:self:slow',
  'test:browser-fixtures',
]);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function stringExports(exportsField: unknown): Record<string, string> | null {
  if (typeof exportsField !== 'object' || exportsField === null || Array.isArray(exportsField)) {
    return null;
  }
  const entries = Object.entries(exportsField);
  if (!entries.every(([, target]) => typeof target === 'string')) return null;
  return Object.fromEntries(entries);
}

/** The preload files a workspace's `bunfig*.toml` files and `--preload` flags name. */
function preloadFiles(root: string, directory: string, testScripts: readonly string[]): string[] {
  const absolute = join(root, directory);
  const found = new Set<string>();
  const add = (base: string, path: string) => {
    found.add(join(base, path).replace(/^\.\//, '').split('\\').join('/'));
  };
  for (const entry of readdirSync(absolute)) {
    if (!/^bunfig.*\.toml$/.test(entry)) continue;
    try {
      const parsed = Bun.TOML.parse(readFileSync(join(absolute, entry), 'utf8')) as {
        test?: { preload?: string | string[] };
        preload?: string | string[];
      };
      const listed = parsed.test?.preload ?? parsed.preload ?? [];
      for (const path of typeof listed === 'string' ? [listed] : listed) add(directory, path);
    } catch {
      // A bunfig that does not parse cannot name a preload; Bun itself rejects it when it runs.
    }
  }
  for (const script of testScripts) {
    for (const match of script.matchAll(/--preload[= ]\s*['"]?([^\s'"]+)/g)) {
      if (match[1] !== undefined) add(directory, match[1]);
    }
  }
  return [...found].filter((path) => existsSync(join(root, path)));
}

export function discoverWorkspaces(root: string = repositoryRoot): WorkspaceDescription[] {
  const rootManifest = readJson<PackageManifest>(join(root, 'package.json'));
  const directories = new Set<string>(['']);
  for (const pattern of rootManifest.workspaces ?? []) {
    for (const match of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })) {
      directories.add(match.slice(0, -'/package.json'.length));
    }
  }
  const manifests = [...directories].map((directory) => ({
    directory,
    manifest: readJson<PackageManifest>(join(root, directory, 'package.json')),
  }));
  const names = new Set(manifests.map(({ manifest }) => manifest.name));
  return manifests.map(({ directory, manifest }) => {
    const testScripts = Object.entries(manifest.scripts ?? {})
      .filter(([name]) => LANE_SCRIPTS.has(name))
      .map(([, script]) => script);
    const declared = [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ].flatMap((group) => Object.keys(group ?? {}));
    return {
      name: manifest.name ?? directory,
      directory,
      dependencies: declared.filter((name) => names.has(name)),
      exports: stringExports(manifest.exports),
      preloads: preloadFiles(root, directory, testScripts),
      testScripts,
    };
  });
}

// --- Git ---------------------------------------------------------------------------------------

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', root, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}

/** The merge base with `origin/main`, which is the base `--affected` compares against too. */
export function mergeBase(root: string, base: string = 'origin/main'): string {
  return git(root, ['merge-base', base, 'HEAD']).trim();
}

/**
 * Every path that differs from `base` in the working tree: committed, staged, and unstaged edits
 * (a rename counts as a deletion and an addition) plus untracked files that are not ignored.
 */
export function changedFiles(root: string, base: string): string[] {
  const tracked = lines(git(root, ['diff', '--name-only', '--no-renames', base]));
  const untracked = lines(git(root, ['ls-files', '--others', '--exclude-standard']));
  return [...new Set([...tracked, ...untracked])].toSorted();
}

/** Every tracked or untracked-but-not-ignored file that exists in the working tree. */
export function listTree(root: string): SourceTree {
  const listed = lines(git(root, ['ls-files', '--cached', '--others', '--exclude-standard']));
  const paths = new Set(listed.filter((path) => existsSync(join(root, path))));
  return {
    paths,
    read(path) {
      try {
        return readFileSync(join(root, path), 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

// --- Reporting ---------------------------------------------------------------------------------

function describeReason(reason: Reason): string {
  if (reason.kind === 'changed') return 'changed';
  if (reason.kind === 'fallback') return `fallback: ${reason.rule}`;
  const [, ...path] = reason.chain;
  return `imports ${path.join(' <- ')}`;
}

/** The test files a package-level `--affected` run would have run, for comparison. */
export function packageLevelTestCount(selection: Selection): {
  workspaces: string[];
  tests: number;
} {
  const affected = new Set(selection.affectedWorkspaces);
  const counted = selection.workspaces.filter((workspace) => affected.has(workspace.name));
  return {
    workspaces: counted.map((workspace) => workspace.name),
    tests: counted.reduce((sum, workspace) => sum + workspace.total, 0),
  };
}

export function explain(selection: Selection, changed: readonly string[]): string {
  const output: string[] = [`changed files (${changed.length}):`, ...changed.map((p) => `  ${p}`)];
  if (selection.repositoryRule !== null) {
    output.push('', `repository-wide fallback: ${selection.repositoryRule}`);
  }
  let selected = 0;
  let total = 0;
  for (const workspace of selection.workspaces) {
    selected += workspace.tests.size;
    total += workspace.total;
    if (workspace.mode === 'none') continue;
    output.push(
      '',
      `${workspace.name} (${workspace.directory === '' ? '.' : workspace.directory}): ${workspace.mode}, ${workspace.tests.size} of ${workspace.total} test files`,
    );
    const shown = [...workspace.tests].slice(0, workspace.mode === 'full' ? 3 : 60);
    for (const [path, reason] of shown) output.push(`  ${path}  [${describeReason(reason)}]`);
    if (shown.length < workspace.tests.size) {
      output.push(`  ... and ${workspace.tests.size - shown.length} more with the same reasons`);
    }
  }
  const before = packageLevelTestCount(selection);
  output.push(
    '',
    `selected ${selected} of ${total} test files`,
    `package-level --affected would run ${before.tests} test files across ${before.workspaces.length} workspaces`,
  );
  return output.join('\n');
}

// --- Running -----------------------------------------------------------------------------------

function turbo(
  args: string[],
  environment: Record<string, string | undefined>,
  root: string,
): number {
  const result = Bun.spawnSync([join(root, 'node_modules/.bin/turbo'), 'run', ...args], {
    cwd: root,
    env: environment,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return result.exitCode ?? 1;
}

export interface Invocation {
  tasks: string[];
  filters: string[];
  /** Whether the runners narrow themselves by the manifest. */
  narrowed: boolean;
  extra: string[];
}

/**
 * The turbo invocations that run a selection, fast lanes first, then the serial slow lanes.
 *
 * Workspaces selected whole run `test:gate`, the lane that keeps their coverage floor; workspaces
 * selected in part run `test` narrowed by the manifest, which never measures coverage. The root
 * lanes (`test:self`, and the browser fixtures' `test:browser-fixtures`) always run narrowed, since
 * `--filter=//` is the one filter that reaches root tasks.
 */
export function planInvocations(selection: Selection): Invocation[] {
  const packages = selection.workspaces.filter(
    (workspace) => workspace.runsFrom === 'workspace' && workspace.mode !== 'none',
  );
  const rootSelected = selection.workspaces.some(
    (workspace) => workspace.directory === '' && workspace.mode !== 'none',
  );
  const fixturesNeeded = selection.workspaces.some(
    (workspace) =>
      workspace.runsFrom === 'root' &&
      workspace.directory !== '' &&
      (workspace.mode !== 'none' || selection.affectedWorkspaces.includes(workspace.name)),
  );
  const filters = (group: WorkspaceSelection[]) =>
    group.map((workspace) => `--filter=${workspace.name}`);
  const full = packages.filter((workspace) => workspace.mode === 'full');
  const partial = packages.filter((workspace) => workspace.mode === 'partial');

  const fast: Invocation[] = [];
  const slow: Invocation[] = [];
  if (full.length > 0) {
    fast.push({ tasks: ['test:gate'], filters: filters(full), narrowed: false, extra: [] });
    slow.push({
      tasks: ['test:slow'],
      filters: filters(full),
      narrowed: false,
      extra: ['--concurrency=1'],
    });
  }
  if (partial.length > 0) {
    fast.push({ tasks: ['test'], filters: filters(partial), narrowed: true, extra: [] });
    slow.push({
      tasks: ['test:slow'],
      filters: filters(partial),
      narrowed: true,
      extra: ['--concurrency=1'],
    });
  }
  if (rootSelected || fixturesNeeded) {
    fast.push({
      tasks: [
        ...(rootSelected ? ['test:self'] : []),
        ...(fixturesNeeded ? ['test:browser-fixtures'] : []),
      ],
      filters: ['--filter=//'],
      narrowed: true,
      extra: [],
    });
  }
  if (rootSelected) {
    slow.push({
      tasks: ['test:self:slow'],
      filters: ['--filter=//'],
      narrowed: true,
      extra: ['--concurrency=1'],
    });
  }
  return [...fast, ...slow];
}

async function run(root: string, selection: Selection): Promise<number> {
  const plan = planInvocations(selection);
  if (plan.length === 0) {
    console.log(
      'affected-tests: no test file is reachable from the changed files; nothing to run.',
    );
    return 0;
  }
  const digest = writeManifest(buildManifest(selection), root);
  for (const step of plan) {
    const environment = { ...process.env };
    delete environment[SELECTION_VARIABLE];
    if (step.narrowed) environment[SELECTION_VARIABLE] = digest;
    const label = step.narrowed ? `narrowed by selection ${digest}` : 'whole workspaces';
    console.log(
      `\naffected-tests: turbo run ${[...step.tasks, ...step.filters, ...step.extra].join(' ')} (${label})`,
    );
    const exitCode = turbo([...step.tasks, ...step.filters, ...step.extra], environment, root);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

// --- Command line ------------------------------------------------------------------------------

function parseArguments(argumentsList: readonly string[]) {
  const options = { command: 'run', base: null as string | null, changed: null as string[] | null };
  let mode: string | null = null;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index] as string;
    if (token === 'run') mode = 'run';
    else if (token === '--explain') mode = 'explain';
    else if (token === '--json') mode = 'json';
    else if (token === '--base') options.base = argumentsList[++index] ?? null;
    else if (token === '--changed') {
      options.changed = [];
      while (index + 1 < argumentsList.length && !argumentsList[index + 1]!.startsWith('--')) {
        options.changed.push(argumentsList[++index] as string);
      }
    } else throw new Error(`unknown argument: ${token}`);
  }
  options.command = mode ?? 'explain';
  return options;
}

async function main(): Promise<number> {
  let options: ReturnType<typeof parseArguments>;
  try {
    options = parseArguments(Bun.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const root = repositoryRoot;
  const workspaces = discoverWorkspaces(root);
  const changed =
    options.changed ?? changedFiles(root, mergeBase(root, options.base ?? 'origin/main'));
  const selection = selectTests({ changed, tree: listTree(root), workspaces });

  if (options.command === 'json') {
    const view = selection.workspaces.map((workspace) => ({
      name: workspace.name,
      mode: workspace.mode,
      total: workspace.total,
      tests: [...workspace.tests.keys()],
    }));
    console.log(JSON.stringify({ repositoryRule: selection.repositoryRule, view }, null, 2));
    return 0;
  }
  if (options.command === 'explain') {
    console.log(explain(selection, changed));
    return 0;
  }
  console.log(explain(selection, changed));
  return run(root, selection);
}

if (import.meta.main) process.exitCode = await main();
