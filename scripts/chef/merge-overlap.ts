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
// at the root, and anything in turbo.json `globalDependencies`. A file outside every workspace
// counts as the root package, which only a pull request that also changes root files affects.
//
// This module is a library; it has no command line.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceParentDirectories } from '../workspace-directories.ts';

/** The key of the root package, which owns every file outside a workspace. */
export const rootWorkspace = '.';

const browserFixturesDirectory = 'scripts/browser-fixtures';
const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

export interface WorkspaceGraph {
  /** Workspace directories relative to the root. */
  directories: string[];
  /** Workspace directory to the directories of the workspaces it names with `workspace:`. */
  dependencies: Map<string, Set<string>>;
  /** Files that touch every workspace when changed. */
  everythingFiles: Set<string>;
}

interface Manifest {
  name?: unknown;
  [field: string]: unknown;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Reads the workspaces, their internal dependency edges and the global files under `root`. */
export function readWorkspaceGraph(root: string): WorkspaceGraph {
  const directories: string[] = [];
  for (const parent of workspaceParentDirectories) {
    const parentPath = join(root, parent);
    if (!existsSync(parentPath)) continue;
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      const directory = `${parent}/${entry.name}`;
      if (entry.isDirectory() && existsSync(join(root, directory, 'package.json')))
        directories.push(directory);
    }
  }
  if (existsSync(join(root, browserFixturesDirectory, 'package.json')))
    directories.push(browserFixturesDirectory);

  const manifests = new Map<string, Manifest>();
  const directoryByName = new Map<string, string>();
  for (const directory of directories) {
    const manifest = readJson(join(root, directory, 'package.json')) ?? {};
    manifests.set(directory, manifest);
    if (typeof manifest.name === 'string') directoryByName.set(manifest.name, directory);
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

  const everythingFiles = new Set(['bun.lock', 'package.json', 'turbo.json']);
  const turbo = readJson(join(root, 'turbo.json'));
  const globals = turbo?.['globalDependencies'];
  if (Array.isArray(globals))
    for (const entry of globals) if (typeof entry === 'string') everythingFiles.add(entry);
  return { directories, dependencies, everythingFiles };
}

/** Whether a change to `path` touches every workspace. */
export function touchesEverything(path: string, graph: WorkspaceGraph): boolean {
  return graph.everythingFiles.has(path) || /^tsconfig[^/]*\.json$/.test(path);
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
  const changed = [...affected];
  visit(changed, reversed);
  visit(changed, graph.dependencies);
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
