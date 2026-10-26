/**
 * Which test files a change can reach, decided from the import graph.
 *
 * A test file is selected when it is changed itself, or when its transitive imports (or the
 * file-path literals its code names) reach a changed file. Anything the graph cannot attribute
 * widens the selection to a whole workspace, or the whole repository, and never narrows it. The
 * rules are listed in `documentation/repository/test-lanes-and-checks.md`, and every selected
 * file carries the reason that selected it, which `bun scripts/affected-tests.ts --explain` prints.
 *
 * The function is pure: it takes the changed paths, a path set with file text, and the workspace
 * descriptions, so its tests build synthetic trees instead of reading the repository.
 */

import { posix } from 'node:path';

import {
  analyzeSource,
  CODE_EXTENSIONS,
  extensionOf,
  isCodeFile,
  isTestFile,
  isTestOrTooling,
  owningWorkspace,
  resolvePathLiteral,
  resolveSpecifier,
  type SourceAnalysis,
  type SourceTree,
  type WorkspaceDescription,
} from './affected-tests-graph.ts';

export type Reason =
  { kind: 'changed' } | { kind: 'imports'; chain: string[] } | { kind: 'fallback'; rule: string };

export type SelectionMode = 'none' | 'partial' | 'full';

export interface WorkspaceSelection {
  name: string;
  directory: string;
  /**
   * Where the workspace's tests run from: its own directory, or the repository root for the root
   * workspace and any workspace with no test script of its own (the browser fixtures).
   */
  runsFrom: 'workspace' | 'root';
  mode: SelectionMode;
  /** Every test file the workspace holds, including slow ones. */
  total: number;
  /** The selected test files, repository-relative, with the reason for each. */
  tests: Map<string, Reason>;
}

export interface Selection {
  /** The rule that widened the selection to the whole repository, when one did. */
  repositoryRule: string | null;
  /** Workspaces a package-level `--affected` run would run: the changed ones and their dependents. */
  affectedWorkspaces: string[];
  workspaces: WorkspaceSelection[];
}

export interface SelectionInput {
  /** Paths that differ from the base, including deleted files and both sides of a rename. */
  changed: readonly string[];
  tree: SourceTree;
  workspaces: readonly WorkspaceDescription[];
}

/** Root files that configure every lane. A change to one selects the whole repository. */
const ROOT_CONFIGURATION = new Set([
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'turbo.json',
  '.bun-version',
  'tsconfig.json',
]);

/** Data kinds that are documentation: unattributed, they reach scanners but not every test. */
const DOCUMENTATION_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.png', '.jpg', '.jpeg', '.gif']);
const FIXTURE_SEGMENT = /(?:^|\/)(?:__fixtures__|fixtures?|testdata|__snapshots__|tests?)(?:\/|$)/;

function isDocumentation(path: string): boolean {
  return DOCUMENTATION_EXTENSIONS.has(extensionOf(path)) && !FIXTURE_SEGMENT.test(path);
}

/** The workspaces a workspace reaches through its declared dependencies, itself included. */
function dependencyScope(
  start: WorkspaceDescription,
  workspaces: readonly WorkspaceDescription[],
): Set<string> {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const scope = new Set<string>();
  const pending = [start];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (scope.has(current.directory)) continue;
    scope.add(current.directory);
    for (const dependency of current.dependencies) {
      const next = byName.get(dependency);
      if (next !== undefined) pending.push(next);
    }
  }
  return scope;
}

/**
 * The files a lane's entrypoint runs: the entrypoint and what it imports from `scripts/`
 * directories. Library source it imports is not part of the lane's machinery, so a change there
 * reaches tests through the graph instead.
 */
function laneMachinery(entrypoint: string, edges: ReadonlyMap<string, Set<string>>): Set<string> {
  const seen = new Set<string>();
  const pending = [entrypoint];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of edges.get(current) ?? []) {
      if (/(?:^|\/)scripts\//.test(next) && !isTestFile(next)) pending.push(next);
    }
  }
  return seen;
}

/** Every file reachable from `roots` along `edges`, not following into test files. */
function forwardClosure(roots: readonly string[], edges: ReadonlyMap<string, Set<string>>) {
  const seen = new Set<string>();
  const pending = [...roots];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (seen.has(current)) continue;
    seen.add(current);
    if (isTestFile(current) && !roots.includes(current)) continue;
    for (const next of edges.get(current) ?? []) pending.push(next);
  }
  return seen;
}

/** The `.ts` and `.js` files a `package.json` test script runs, resolved from the workspace. */
function scriptEntrypoints(workspace: WorkspaceDescription, paths: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const script of workspace.testScripts) {
    for (const token of script.split(/[\s&|;'"]+/)) {
      if (!/\.(?:ts|mts|js|mjs)$/.test(token) || token.includes('*') || isTestFile(token)) continue;
      const resolved = posix.normalize(posix.join(workspace.directory, token));
      if (paths.has(resolved)) found.add(resolved);
    }
  }
  return [...found];
}

interface Analysis {
  edges: Map<string, Set<string>>;
  importers: Map<string, Set<string>>;
  /** Files that something imports for its types only, which makes them used, not orphans. */
  typeImported: Set<string>;
  analyses: Map<string, SourceAnalysis>;
}

function buildGraph(
  tree: SourceTree,
  paths: ReadonlySet<string>,
  workspaces: readonly WorkspaceDescription[],
): Analysis {
  const edges = new Map<string, Set<string>>();
  const importers = new Map<string, Set<string>>();
  const analyses = new Map<string, SourceAnalysis>();
  const typeImported = new Set<string>();
  for (const path of tree.paths) {
    const extension = extensionOf(path);
    if (!CODE_EXTENSIONS.has(extension) && extension !== '.css') continue;
    const source = tree.read(path);
    if (source === undefined) continue;
    const analysis = analyzeSource(path, source);
    analyses.set(path, analysis);
    const workspace = owningWorkspace(path, workspaces);
    const dependencies = new Set<string>();
    for (const specifier of analysis.typeSpecifiers) {
      const target = resolveSpecifier(path, specifier, paths, workspaces);
      if (target !== null && target !== path) typeImported.add(target);
    }
    for (const specifier of analysis.specifiers) {
      const target = resolveSpecifier(path, specifier, paths, workspaces);
      if (target !== null && target !== path) dependencies.add(target);
    }
    for (const literal of analysis.pathLiterals) {
      const target = resolvePathLiteral(path, literal, workspace.directory, paths);
      if (target !== null && target !== path) dependencies.add(target);
    }
    edges.set(path, dependencies);
    for (const target of dependencies) {
      let set = importers.get(target);
      if (set === undefined) importers.set(target, (set = new Set()));
      set.add(path);
    }
  }
  return { edges, importers, analyses, typeImported };
}

/** The workspaces a package-level `--affected` run would run: changed ones and their dependents. */
export function affectedWorkspaces(
  changed: readonly string[],
  workspaces: readonly WorkspaceDescription[],
): string[] {
  const affected = new Set(changed.map((path) => owningWorkspace(path, workspaces).name));
  for (let grew = true; grew;) {
    grew = false;
    for (const workspace of workspaces) {
      if (affected.has(workspace.name)) continue;
      if (workspace.dependencies.some((dependency) => affected.has(dependency))) {
        affected.add(workspace.name);
        grew = true;
      }
    }
  }
  return [...affected].toSorted();
}

/** Compute which test files each workspace must run for the changed paths. */
export function selectTests(input: SelectionInput): Selection {
  const { workspaces, tree } = input;
  const paths = new Set(tree.paths);
  for (const path of input.changed) paths.add(path);
  const changed = [...new Set(input.changed)];
  const { edges, importers, analyses, typeImported } = buildGraph(tree, paths, workspaces);

  const seeds = new Map<string, Reason>();
  const workspaceRules = new Map<string, string>();
  let repositoryRule: string | null = null;
  const widenRepository = (rule: string) => (repositoryRule ??= rule);
  const widenWorkspace = (directory: string, rule: string) => {
    if (!workspaceRules.has(directory)) workspaceRules.set(directory, rule);
  };
  const seed = (path: string, reason: Reason) => {
    if (!seeds.has(path)) seeds.set(path, reason);
  };

  // Files that run the lanes themselves: a change reaches every workspace that runs through them.
  const entrypointClosures = new Map<string, { scope: string; closure: Set<string> }>();
  for (const workspace of workspaces) {
    for (const entrypoint of scriptEntrypoints(workspace, paths)) {
      const owner = owningWorkspace(entrypoint, workspaces);
      // The root runs other workspaces' lane entrypoints for them, so those stay with their owner.
      const scope =
        owner.directory === workspace.directory || workspace.directory === ''
          ? owner.directory
          : '*';
      const existing = entrypointClosures.get(entrypoint);
      if (existing === undefined || scope === '*') {
        entrypointClosures.set(entrypoint, { scope, closure: laneMachinery(entrypoint, edges) });
      }
    }
  }
  const preloadClosures = workspaces
    .filter((workspace) => workspace.preloads.length > 0)
    .map((workspace) => ({
      directory: workspace.directory,
      closure: forwardClosure(workspace.preloads, edges),
    }));

  const changedWorkspaces = new Set<string>();
  let documentationChanged = false;

  // Literals name files by a trailing path or a bare name (`join(root, 'documentation', 'a.md')`),
  // so a data file is also attributed to the code whose literal is its name or a tail of its path.
  const literalsByName = new Map<string, { literal: string; file: string }[]>();
  const workspacesWithCode = new Set<string>();
  for (const [file, analysis] of analyses) {
    if (isCodeFile(file)) workspacesWithCode.add(owningWorkspace(file, workspaces).directory);
    for (const literal of analysis.pathLiterals) {
      const tail = literal.replace(/^(?:\.{1,2}\/)+/, '');
      const key = posix.basename(tail);
      const list = literalsByName.get(key) ?? [];
      list.push({ literal: tail, file });
      literalsByName.set(key, list);
    }
  }
  const filesNaming = (path: string): string[] =>
    (literalsByName.get(posix.basename(path)) ?? [])
      .filter(({ literal }) => path === literal || path.endsWith(`/${literal}`))
      .map(({ file }) => file);
  for (const path of changed) {
    const workspace = owningWorkspace(path, workspaces);
    const rootLevel = workspace.directory === '';
    const name = posix.basename(path);
    changedWorkspaces.add(workspace.directory);
    seed(path, { kind: 'changed' });

    if (rootLevel && ROOT_CONFIGURATION.has(path)) widenRepository(`root configuration ${path}`);
    if (!rootLevel && !workspacesWithCode.has(workspace.directory)) {
      // Configuration every other workspace extends (the shared TypeScript bases) has no code and
      // no tests of its own, so only the whole repository can observe it.
      widenRepository(`${path} is in ${workspace.name}, which holds no code`);
    }
    for (const [entrypoint, { scope, closure }] of entrypointClosures) {
      if (!closure.has(path)) continue;
      const via =
        path === entrypoint ? 'test script entrypoint' : `imported by test script ${entrypoint}`;
      if (scope === '*') widenRepository(`${via}: ${path}`);
      else widenWorkspace(scope, `${via}: ${path}`);
    }
    for (const { directory, closure } of preloadClosures) {
      if (closure.has(path)) widenWorkspace(directory, `test preload or setup file ${path}`);
    }

    if (name === 'package.json') {
      if (rootLevel) widenRepository('root package.json');
      else {
        widenWorkspace(workspace.directory, `${path} changed`);
        for (const file of tree.paths) {
          if (isCodeFile(file) && owningWorkspace(file, workspaces) === workspace) {
            seed(file, { kind: 'fallback', rule: `${path} changed` });
          }
        }
      }
    } else if (/^bunfig.*\.toml$/.test(name) || /^tsconfig.*\.json$/.test(name)) {
      if (rootLevel && !path.includes('/')) widenRepository(`root configuration ${path}`);
      else widenWorkspace(workspace.directory, `${name} changed`);
    } else if (!isCodeFile(path)) {
      classifyDataFile(path, workspace);
    } else if (!isTestFile(path) && !(importers.get(path)?.size ?? 0) && !typeImported.has(path)) {
      // A code file nothing imports or names is an entrypoint run by a process the graph cannot
      // see, so its effect cannot be attributed to a test.
      if (rootLevel) widenWorkspace('', `${path} is imported by nothing`);
      else widenWorkspace(workspace.directory, `${path} is imported by nothing`);
    }
  }

  function classifyDataFile(path: string, workspace: WorkspaceDescription) {
    if (path.endsWith('.snap')) {
      const test = path.replace(/__snapshots__\//, '').replace(/\.snap$/, '');
      seed(test, { kind: 'fallback', rule: `snapshot ${path}` });
      return;
    }
    if ((importers.get(path)?.size ?? 0) > 0) return;
    const namedBy = filesNaming(path);
    if (namedBy.length > 0) {
      for (const file of namedBy) seed(file, { kind: 'fallback', rule: `${file} names ${path}` });
      return;
    }
    if (isDocumentation(path)) {
      documentationChanged = true;
      return;
    }
    const rule = `${path} is data the graph cannot attribute to an importer`;
    if (workspace.directory === '') widenRepository(rule);
    else widenWorkspace(workspace.directory, rule);
  }

  // Code that reads the tree or loads code the graph cannot see depends on changes in its scope.
  const everyChange = changed.length > 0;
  for (const [path, analysis] of analyses) {
    const workspace = owningWorkspace(path, workspaces);
    const eligible = isTestOrTooling(path);
    const unseen =
      analysis.bundlesCode || (eligible && analysis.importsDynamically)
        ? 'loads code the import graph cannot see'
        : null;
    let reason: string | null = null;
    if (analysis.scansRepository && everyChange) reason = 'scans the workspaces';
    else if (
      eligible &&
      analysis.scansFileSystem &&
      (changedWorkspaces.has(workspace.directory) ||
        (documentationChanged && (isTestFile(path) || /(?:^|\/)scripts\//.test(path))))
    ) {
      reason = 'reads the file system by glob or directory listing';
    } else if (unseen !== null) {
      const scope = dependencyScope(workspace, workspaces);
      const touched = [...changedWorkspaces].some((directory) => scope.has(directory));
      if (touched || (documentationChanged && isTestFile(path))) reason = unseen;
    }
    if (reason !== null) seed(path, { kind: 'fallback', rule: `${path} ${reason}` });
  }

  // Walk importers outward from every seed, remembering the first way each file was reached.
  const reached = new Map<string, { parent: string | null }>();
  const queue: string[] = [];
  for (const path of seeds.keys()) {
    reached.set(path, { parent: null });
    queue.push(path);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index] as string;
    for (const importer of importers.get(current) ?? []) {
      if (reached.has(importer)) continue;
      reached.set(importer, { parent: current });
      queue.push(importer);
    }
  }

  const chainFor = (path: string): string[] => {
    const chain = [path];
    for (let step = reached.get(path)?.parent; step; step = reached.get(step)?.parent) {
      chain.push(step);
    }
    return chain;
  };

  const testsByWorkspace = new Map<string, string[]>();
  for (const path of tree.paths) {
    if (!isTestFile(path)) continue;
    const directory = owningWorkspace(path, workspaces).directory;
    const list = testsByWorkspace.get(directory) ?? [];
    list.push(path);
    testsByWorkspace.set(directory, list);
  }

  const results: WorkspaceSelection[] = [];
  for (const workspace of workspaces) {
    const all = (testsByWorkspace.get(workspace.directory) ?? []).toSorted();
    const rule = repositoryRule ?? workspaceRules.get(workspace.directory) ?? null;
    const tests = new Map<string, Reason>();
    if (rule !== null) {
      for (const path of all) tests.set(path, { kind: 'fallback', rule });
    } else {
      for (const path of all) {
        if (!reached.has(path)) continue;
        const seedReason = seeds.get(path);
        tests.set(path, seedReason ?? { kind: 'imports', chain: chainFor(path) });
      }
    }
    const mode: SelectionMode =
      tests.size === 0 ? 'none' : tests.size === all.length ? 'full' : 'partial';
    results.push({
      name: workspace.name,
      directory: workspace.directory,
      runsFrom:
        workspace.directory === '' || workspace.testScripts.length === 0 ? 'root' : 'workspace',
      mode,
      total: all.length,
      tests,
    });
  }
  return {
    repositoryRule,
    affectedWorkspaces: affectedWorkspaces(changed, workspaces),
    workspaces: results,
  };
}
