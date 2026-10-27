/**
 * The hand-off between `scripts/affected-tests.ts` and the test runners it drives.
 *
 * The selector writes the selection to `tmp/affected-tests/<digest>.json` and exports the digest as
 * `CORVIDAE_TEST_SELECTION`. A runner that finds the variable narrows its own `bun test` arguments
 * to the files selected for its workspace; one that does not runs everything, as before. The
 * variable is declared in `turbo.json` for the tasks that read it, so Turborepo both passes it
 * through its strict environment and puts it in those tasks' cache keys: a result cached for one
 * selection is never replayed for another.
 *
 * Narrowing only ever removes files. The selected files are intersected with the roots the
 * runner's own command line names and with its ignore patterns, so a lane keeps its own scope,
 * configuration, and conditions.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { Selection } from './affected-tests-selection.ts';

export const SELECTION_VARIABLE = 'CORVIDAE_TEST_SELECTION';

export type ManifestMode = 'partial' | 'full';

export interface Manifest {
  version: 1;
  /** Keyed by workspace directory, `.` for the root. Workspaces with nothing selected are absent. */
  workspaces: Record<string, { mode: ManifestMode; files: string[] }>;
}

export const repositoryRoot = join(import.meta.dir, '..');

export function manifestDirectory(root: string = repositoryRoot): string {
  return join(root, 'tmp', 'affected-tests');
}

function workspaceKey(directory: string): string {
  return directory === '' ? '.' : directory;
}

/**
 * The manifest for a selection: every workspace with at least one selected test file. Workspaces
 * whose lanes run from the repository root share the `.` entry, and their files stay relative to
 * the root, which is where those lanes run.
 */
export function buildManifest(selection: Selection): Manifest {
  const workspaces: Manifest['workspaces'] = {};
  for (const workspace of selection.workspaces) {
    if (workspace.mode === 'none') continue;
    const fromRoot = workspace.runsFrom === 'root';
    const files = [...workspace.tests.keys()].map((path) =>
      fromRoot ? path : path.slice(workspace.directory.length + 1),
    );
    const key = fromRoot ? '.' : workspace.directory;
    const existing = workspaces[key];
    const mode: ManifestMode =
      existing === undefined || (existing.mode === 'full' && workspace.mode === 'full')
        ? workspace.mode
        : 'partial';
    // The root entry always lists its files: the root lanes share it, and `all` would widen one.
    workspaces[key] = {
      mode: key === '.' ? 'partial' : mode,
      files: [...(existing?.files ?? []), ...files].toSorted(),
    };
  }
  return { version: 1, workspaces };
}

/** Write a manifest and return the digest that names it. */
export function writeManifest(manifest: Manifest, root: string = repositoryRoot): string {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
  mkdirSync(manifestDirectory(root), { recursive: true });
  writeFileSync(join(manifestDirectory(root), `${digest}.json`), text);
  return digest;
}

/** Read the manifest a digest names, failing loudly when it is missing or has been altered. */
export function readManifest(digest: string, root: string = repositoryRoot): Manifest {
  const path = join(manifestDirectory(root), `${digest}.json`);
  if (!existsSync(path)) {
    throw new Error(`${SELECTION_VARIABLE}=${digest} names no manifest at ${path}`);
  }
  const text = readFileSync(path, 'utf8');
  const actual = createHash('sha256').update(text).digest('hex').slice(0, 16);
  if (actual !== digest) {
    throw new Error(`${path} does not match its digest ${digest}; refusing to narrow by it`);
  }
  return JSON.parse(text) as Manifest;
}

/**
 * The test files selected for one workspace, relative to it, or `null` when no selection is in
 * force and the runner should run everything. `'all'` means the selector chose the whole workspace.
 */
export function selectedFilesFor(
  environment: Record<string, string | undefined>,
  workspaceDirectory: string,
  root: string = repositoryRoot,
): string[] | 'all' | null {
  const digest = environment[SELECTION_VARIABLE];
  if (digest === undefined || digest === '') return null;
  const entry = readManifest(digest, root).workspaces[workspaceKey(workspaceDirectory)];
  if (entry === undefined) return [];
  return entry.mode === 'full' ? 'all' : entry.files;
}

/** The current workspace's directory relative to the repository root, `''` for the root. */
export function currentWorkspaceDirectory(
  cwd: string = process.cwd(),
  root: string = repositoryRoot,
) {
  return relative(root, cwd);
}

// --- `bun test` argument narrowing -------------------------------------------------------------

/** Flags that `bun test` reads a separate argument for. Every other flag is a single token. */
const SPACE_VALUE_FLAGS = new Set([
  '--conditions',
  '--preload',
  '--timeout',
  '--config',
  '--reporter',
  '--reporter-outfile',
  '--rerun-each',
  '--coverage-reporter',
  '--coverage-dir',
  '--test-name-pattern',
  '--define',
  '--loader',
  '--tsconfig-override',
  '--cwd',
  '--max-concurrency',
  '--env-file',
  '--path-ignore-patterns',
  '-t',
  '-c',
  '-r',
]);

export interface SplitArguments {
  /** Every token that is a flag or a flag's value, in order. */
  flags: string[];
  /** The positional filters: files, directories, or substrings. */
  roots: string[];
  ignorePatterns: string[];
  /** The `--config` file, when the command names one. */
  configuration: string | null;
}

export function splitBunTestArguments(argumentsList: readonly string[]): SplitArguments {
  const flags: string[] = [];
  const roots: string[] = [];
  const ignorePatterns: string[] = [];
  let configuration: string | null = null;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index] as string;
    if (!token.startsWith('-')) {
      roots.push(token);
      continue;
    }
    flags.push(token);
    const equals = token.indexOf('=');
    const name = equals === -1 ? token : token.slice(0, equals);
    let value = equals === -1 ? undefined : token.slice(equals + 1);
    const next = argumentsList[index + 1];
    if (equals === -1 && SPACE_VALUE_FLAGS.has(name) && next !== undefined) {
      value = next;
      flags.push(next);
      index += 1;
    }
    if (name === '--path-ignore-patterns' && value !== undefined) ignorePatterns.push(value);
    if ((name === '--config' || name === '-c') && value !== undefined) configuration = value;
  }
  return { flags, roots, ignorePatterns, configuration };
}

function normalizeRoot(root: string): string {
  return root.replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Whether a positional filter admits a workspace-relative file, the way `bun test` filters. */
export function rootAdmits(root: string, file: string): boolean {
  const path = normalizeRoot(root);
  if (path === '' || path === '.') return true;
  if (root.startsWith('./') || root.startsWith('/')) {
    return file === path || file.startsWith(`${path}/`);
  }
  return file.includes(path);
}

function bunfigIgnorePatterns(directory: string, configuration: string | null): string[] {
  const path = join(directory, configuration ?? 'bunfig.toml');
  if (!existsSync(path)) return [];
  try {
    const parsed = Bun.TOML.parse(readFileSync(path, 'utf8')) as {
      test?: { pathIgnorePatterns?: string | string[] };
    };
    const patterns = parsed.test?.pathIgnorePatterns ?? [];
    return typeof patterns === 'string' ? [patterns] : patterns;
  } catch {
    return [];
  }
}

/**
 * The `bun test` arguments that run only the selected files this invocation would have run, or
 * `null` when none are left. `selected` is relative to `directory`, the workspace root.
 */
export function narrowBunTestArguments(
  argumentsList: readonly string[],
  selected: readonly string[] | 'all',
  directory: string,
): string[] | null {
  if (selected === 'all') return [...argumentsList];
  const { flags, roots, ignorePatterns, configuration } = splitBunTestArguments(argumentsList);
  const ignored = [...ignorePatterns, ...bunfigIgnorePatterns(directory, configuration)].map(
    (pattern) => new Bun.Glob(pattern),
  );
  const files = selected.filter(
    (file) =>
      (roots.length === 0 || roots.some((root) => rootAdmits(root, file))) &&
      !ignored.some((glob) => glob.match(file)),
  );
  return files.length === 0 ? null : [...flags, ...files.map((file) => `./${file}`)];
}
