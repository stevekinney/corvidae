// Chef integration check: the pure pieces of `deliver.ts`'s fast check after it merges the default
// branch into a pull request's branch. A branch gated before the merge-in and a default branch that
// moved underneath it can each be green and still break each other; the full gate finds that an
// hour later. This module finds it first:
//
//   - `integrationWorkspaces` names the workspaces where the two sides could collide: a workspace
//     both sides changed, or one side changed that consumes (depends on, transitively) a workspace
//     the other side changed. A change that touches every workspace on one side (`bun.lock`, the
//     root manifest, `turbo.json`, a root `tsconfig*.json`) puts every workspace the other side
//     changed in play. The root package is never named: the root lint and type-check are not part
//     of the fast check.
//   - `expandFastCheck` turns the configuration's `fastCheckCommand` template into a command by
//     replacing `{filters}` with one `--filter=./<directory>` per workspace.
//   - `failingFilesFromOutput` reads the files a failed lint or type-check named.
//   - `parseRemovedNames` and `removedNameHits` implement `--removed-names`: names that this branch
//     removed, searched for in the source files that landed on the default branch since the
//     branch's previous base. `tsc` cannot see a fixture built with `Object.create`, a spread or
//     `as never`, so the name is searched for as text: a member access (`.name`, `?.name`), a quoted
//     key (`'name'`, `"name"`, `` `name` ``) or an object key (`name:`).
//
// This module is a library; it has no command line.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  rootWorkspace,
  touchesEverything,
  workspaceOf,
  type WorkspaceGraph,
} from './merge-overlap.ts';
import { UsageError } from './process-runner.ts';

export { UsageError };

/** The directories of `seeds` and every workspace that depends on one of them, transitively. */
function withDependents(seeds: Set<string>, graph: WorkspaceGraph): Set<string> {
  const reversed = new Map<string, string[]>();
  for (const [directory, edges] of graph.dependencies)
    for (const target of edges) reversed.set(target, [...(reversed.get(target) ?? []), directory]);
  const reached = new Set(seeds);
  const queue = [...seeds];
  for (let current = queue.pop(); current !== undefined; current = queue.pop())
    for (const dependent of reversed.get(current) ?? [])
      if (!reached.has(dependent)) {
        reached.add(dependent);
        queue.push(dependent);
      }
  return reached;
}

/**
 * The workspaces whose typecheck and lint the fast check runs, sorted: those the branch changed
 * that are, or consume, something `incomingFiles` changed on the default branch, and those the
 * default branch changed that consume something `branchFiles` changed. Only workspaces `graph`
 * (read from the merged tree) still has are named.
 */
export function integrationWorkspaces(
  branchFiles: string[],
  incomingFiles: string[],
  graph: WorkspaceGraph,
): string[] {
  const all = new Set(graph.directories);
  const direct = (files: string[]) => new Set(files.map((path) => workspaceOf(path, graph)));
  const reach = (files: string[]): Set<string> =>
    files.some((path) => touchesEverything(path, graph))
      ? all
      : withDependents(direct(files), graph);
  const branchDirect = direct(branchFiles);
  const incomingDirect = direct(incomingFiles);
  const branchReach = reach(branchFiles);
  const incomingReach = reach(incomingFiles);
  const chosen = new Set<string>();
  for (const directory of branchDirect) if (incomingReach.has(directory)) chosen.add(directory);
  for (const directory of incomingDirect) if (branchReach.has(directory)) chosen.add(directory);
  return [...chosen]
    .filter((directory) => directory !== rootWorkspace && all.has(directory))
    .toSorted();
}

/** `template` with `{filters}` replaced by one `--filter=./<directory>` per workspace. */
export function expandFastCheck(template: string, directories: string[]): string {
  for (const directory of directories)
    if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(directory))
      throw new UsageError(`"${directory}" is not a plain workspace path.`);
  return template.replace(
    '{filters}',
    directories.map((directory) => `--filter=./${directory}`).join(' '),
  );
}

const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const sourceExtension = '(?:tsx?|svelte|[cm]?jsx?|json)';
// `src/a.ts(12,5): error TS...` (tsc), then `src/a.ts:12:5` and `[src/a.ts:12:5]` (oxlint, svelte-check).
const locationPatterns = [
  new RegExp(`([^\\s()\\[\\]:]+\\.${sourceExtension})\\(\\d+,\\d+\\)`, 'g'),
  new RegExp(`([^\\s()\\[\\]:]+\\.${sourceExtension}):\\d+:\\d+`, 'g'),
];
const turboPrefix = /^(\S+?):([A-Za-z][\w:.-]*): /;
const failingFileLimit = 20;

/**
 * The distinct files a failed type-check or lint named, in the order they appear, at most 20. A
 * line Turborepo prefixed with `<package>:<task>: ` names a path relative to that package, so it
 * is joined to the package's directory from `directoryByPackage`; any other path is kept as given.
 */
export function failingFilesFromOutput(
  output: string,
  directoryByPackage: Map<string, string>,
): string[] {
  const files: string[] = [];
  for (const raw of output.replace(ansiPattern, '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const prefix = turboPrefix.exec(line);
    const directory = prefix?.[1] === undefined ? undefined : directoryByPackage.get(prefix[1]);
    for (const pattern of locationPatterns)
      for (const match of line.matchAll(pattern)) {
        const path = match[1] as string;
        const full =
          directory === undefined || path.startsWith('/') || path.startsWith(`${directory}/`)
            ? path
            : `${directory}/${path}`;
        if (!files.includes(full)) files.push(full);
      }
  }
  return files.slice(0, failingFileLimit);
}

/** The identifiers in a `--removed-names` file: one per line, blank lines and `#` comments skipped. */
export function parseRemovedNames(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!/^[A-Za-z_$][\w$]*$/.test(line))
      throw new UsageError(`"${line}" in the removed-names file is not a single identifier.`);
    if (!names.includes(line)) names.push(line);
  }
  return names;
}

export interface RemovedNameHit {
  path: string;
  line: number;
  name: string;
  /** The matching line, trimmed and cut to 160 characters. */
  text: string;
}

const searchedFile = /\.(?:tsx?|svelte|[cm]?jsx?)$/;
const largestSearchedFile = 1_000_000;

function escapePattern(name: string): string {
  return name.replace(/[$]/g, '\\$');
}

/** One pattern per name: a member access, a quoted key, or an object key. */
function namePattern(name: string): RegExp {
  const escaped = escapePattern(name);
  return new RegExp(
    [
      `(?:\\.|\\?\\.)${escaped}(?![\\w$])`,
      `['"\`]${escaped}['"\`]`,
      `(?<![\\w$.])${escaped}\\s*\\??:(?!:)`,
    ].join('|'),
  );
}

/**
 * Where `names` appear in `files` (paths relative to `root`) as a member access, a quoted key or an
 * object key. A file that is missing, is not TypeScript, JavaScript or Svelte source, or is over a
 * megabyte is skipped. Hits come in file order, then line order.
 */
export function removedNameHits(root: string, files: string[], names: string[]): RemovedNameHit[] {
  if (names.length === 0) return [];
  const patterns = names.map((name) => ({ name, pattern: namePattern(name) }));
  const hits: RemovedNameHit[] = [];
  for (const path of files) {
    if (!searchedFile.test(path)) continue;
    const absolute = join(root, path);
    if (!existsSync(absolute) || statSync(absolute).size > largestSearchedFile) continue;
    const lines = readFileSync(absolute, 'utf8').split('\n');
    lines.forEach((text, index) => {
      for (const { name, pattern } of patterns)
        if (pattern.test(text)) {
          hits.push({ path, line: index + 1, name, text: text.trim().slice(0, 160) });
          break;
        }
    });
  }
  return hits;
}
