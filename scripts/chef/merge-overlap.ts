// Chef merge overlap: decides whether the commits that landed on the default branch after a pull
// request branched could change what that pull request's gate measured. `merge-gate.ts` uses it
// when the gated head does not contain `origin/<default>`: a clean merge is still accepted if no
// intervening commit lies in a workspace the pull request affects.
//
// Affected means every workspace the pull request changes, plus each workspace that depends on
// one of them and each workspace one of them depends on (both read from `dependencies`,
// `devDependencies` and `peerDependencies` entries on `workspace:` specifiers). The dependencies
// are included because a gate at the pull request's head ran against the old version of them.
// Some files touch every workspace: `bun.lock`, the root `package.json`, `turbo.json`, `tsconfig*.json`
// at the root, root `bunfig.toml`, anything in turbo.json `globalDependencies`, and every
// `$TURBO_ROOT$/...` path a task names in its `inputs` (read from turbo.json, not listed here). A file outside every workspace
// counts as the root package, which only a pull request that also changes root files affects.
//
// This module is a library; it has no command line.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceParentDirectories } from '../workspace-directories.ts';

/** The key of the root package, which owns every file outside a workspace. */
export const rootWorkspace = '.';

const browserFixturesDirectory = 'scripts/browser-fixtures';
const turboRootPrefix = '$TURBO_ROOT$/';
const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

export interface WorkspaceGraph {
  /** Workspace directories relative to the root. */
  directories: string[];
  /** Workspace directory to the directories of the workspaces it names with `workspace:`. */
  dependencies: Map<string, Set<string>>;
  /** Path patterns (exact paths or globs) that touch every workspace when changed. */
  everythingPatterns: string[];
}

/** Where a graph is read from: the worktree on disk, or a commit through Git. */
export interface GraphSource {
  /** The file's text, or `undefined` when it does not exist there. */
  read(path: string): string | undefined;
  /** The names of the entries directly under a directory. */
  list(directory: string): string[];
}

/** The graph source for a directory on disk. */
export function filesystemSource(root: string): GraphSource {
  return {
    read: (path) => {
      try {
        return readFileSync(join(root, path), 'utf8');
      } catch {
        return undefined;
      }
    },
    list: (directory) => {
      const path = join(root, directory);
      return existsSync(path)
        ? readdirSync(path, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
        : [];
    },
  };
}

interface Manifest {
  name?: unknown;
  [field: string]: unknown;
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Reads the workspaces, their internal dependency edges and the global files from `source`. */
export function readWorkspaceGraph(source: GraphSource): WorkspaceGraph {
  const directories: string[] = [];
  for (const parent of workspaceParentDirectories)
    for (const name of source.list(parent)) {
      const directory = `${parent}/${name}`;
      if (source.read(`${directory}/package.json`) !== undefined) directories.push(directory);
    }
  if (source.read(`${browserFixturesDirectory}/package.json`) !== undefined)
    directories.push(browserFixturesDirectory);

  const manifests = new Map<string, Manifest>();
  const directoryByName = new Map<string, string>();
  for (const directory of directories) {
    const manifest = parseJson(source.read(`${directory}/package.json`)) ?? {};
    manifests.set(directory, manifest);
    if (typeof manifest['name'] === 'string') directoryByName.set(manifest['name'], directory);
  }
  const dependencies = new Map<string, Set<string>>();
  for (const [directory, manifest] of manifests) {
    const edges = new Set<string>();
    for (const field of dependencyFields) {
      const entries = manifest[field];
      if (typeof entries !== 'object' || entries === null) continue;
      for (const [name, specifier] of Object.entries(entries)) {
        const target = directoryByName.get(name);
        if (
          target !== undefined &&
          typeof specifier === 'string' &&
          specifier.startsWith('workspace:')
        )
          edges.add(target);
      }
    }
    dependencies.set(directory, edges);
  }

  const everythingPatterns = new Set(['bun.lock', 'package.json', 'turbo.json', 'bunfig.toml']);
  const turbo = parseJson(source.read('turbo.json'));
  const globals = turbo?.['globalDependencies'];
  if (Array.isArray(globals))
    for (const entry of globals) if (typeof entry === 'string') everythingPatterns.add(entry);
  const tasks = turbo?.['tasks'];
  if (typeof tasks === 'object' && tasks !== null)
    for (const task of Object.values(tasks)) {
      const inputs = (task as { inputs?: unknown } | null)?.inputs;
      if (!Array.isArray(inputs)) continue;
      for (const input of inputs)
        if (typeof input === 'string' && input.startsWith(turboRootPrefix))
          everythingPatterns.add(input.slice(turboRootPrefix.length));
    }
  return { directories, dependencies, everythingPatterns: [...everythingPatterns] };
}

/** The union of two graphs: every workspace and edge either one has, and every global pattern. */
export function unionGraphs(first: WorkspaceGraph, second: WorkspaceGraph): WorkspaceGraph {
  const dependencies = new Map<string, Set<string>>();
  for (const graph of [first, second])
    for (const [directory, edges] of graph.dependencies)
      dependencies.set(directory, new Set([...(dependencies.get(directory) ?? []), ...edges]));
  return {
    directories: [...new Set([...first.directories, ...second.directories])],
    dependencies,
    everythingPatterns: [...new Set([...first.everythingPatterns, ...second.everythingPatterns])],
  };
}

/** Whether a change to `path` touches every workspace. */
export function touchesEverything(path: string, graph: WorkspaceGraph): boolean {
  return (
    /^tsconfig[^/]*\.json$/.test(path) ||
    graph.everythingPatterns.some(
      (pattern) => pattern === path || new Bun.Glob(pattern).match(path),
    )
  );
}

/** The workspace directory that owns `path`, or the root package. */
export function workspaceOf(path: string, graph: WorkspaceGraph): string {
  for (const directory of graph.directories) if (path.startsWith(`${directory}/`)) return directory;
  // A workspace the graph does not know, such as one added on the default branch since.
  for (const parent of workspaceParentDirectories) {
    if (path.startsWith(`${parent}/`)) {
      const name = path.slice(parent.length + 1).split('/')[0];
      if (name !== undefined && path.length > parent.length + 1 + name.length)
        return `${parent}/${name}`;
    }
  }
  return path.startsWith(`${browserFixturesDirectory}/`) ? browserFixturesDirectory : rootWorkspace;
}

/** The workspaces a set of changed files affects, or `'everything'`. */
export function affectedWorkspaces(
  changedFiles: string[],
  graph: WorkspaceGraph,
): Set<string> | 'everything' {
  if (changedFiles.some((path) => touchesEverything(path, graph))) return 'everything';
  const affected = new Set(changedFiles.map((path) => workspaceOf(path, graph)));
  const reversed = new Map<string, Set<string>>();
  for (const [directory, edges] of graph.dependencies)
    for (const target of edges) {
      const dependents = reversed.get(target) ?? new Set<string>();
      dependents.add(directory);
      reversed.set(target, dependents);
    }
  const visit = (start: string[], edges: Map<string, Set<string>>): void => {
    const queue = [...start];
    for (let directory = queue.pop(); directory !== undefined; directory = queue.pop())
      for (const next of edges.get(directory) ?? []) {
        if (affected.has(next)) continue;
        affected.add(next);
        queue.push(next);
      }
  };
  visit([...affected], reversed);
  // Seeded after the dependent expansion, so a dependent's own dependencies count too.
  visit([...affected], graph.dependencies);
  return affected;
}

/**
 * The files in `baseFiles` (changed on the default branch since the merge base) that lie in a
 * workspace the pull request affects, given the pull request's own changed files.
 */
export function overlappingFiles(
  pullRequestFiles: string[],
  baseFiles: string[],
  graph: WorkspaceGraph,
): string[] {
  const everythingOnBase = baseFiles.filter((path) => touchesEverything(path, graph));
  if (everythingOnBase.length > 0) return everythingOnBase;
  const affected = affectedWorkspaces(pullRequestFiles, graph);
  if (affected === 'everything') return baseFiles;
  return baseFiles.filter((path) => affected.has(workspaceOf(path, graph)));
}
