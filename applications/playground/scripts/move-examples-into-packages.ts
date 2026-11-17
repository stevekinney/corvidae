/**
 * Moves the playground's examples into the component directories that own them (COR-2081),
 * re-runnably.
 *
 * ```sh
 * bun applications/playground/scripts/move-examples-into-packages.ts            # move
 * bun applications/playground/scripts/move-examples-into-packages.ts --dry-run  # print the plan
 * ```
 *
 * Each `<component>/` directory under the playground's old examples directory moves, file by file,
 * to `<component directory>/examples/`, where the component directory is the one directory in a
 * component workspace (`components/<package>/src/components/<component>` or
 * `components/<package>/src/lib/components/<component>`) that holds `<component>.svelte`. The
 * files directly under the old directory (the featured-example registry and its test) belong to no
 * component and move up into the playground's `src/`. Every move is a `git mv`, so a branch that
 * edits an example at its old path merges onto the new one.
 *
 * The run checks the whole plan before it moves anything, and stops when:
 *   - an example directory has no owning component directory, or more than one;
 *   - a destination already exists with different content (a file that exists at both paths with
 *     the same content loses its old copy);
 *   - a moved module imports a package the destination workspace does not declare (a Cinder
 *     example importing chat would be a dependency cycle).
 *
 * After the move, each workspace that holds examples gets the one test that mounts every one of
 * them (`ensureExampleMountTests` in the component tooling's `example-mount-tests.ts`).
 *
 * A run with nothing left to move prints `Nothing to move.`, so it can run again after a merge
 * brings in examples written at the old path.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { ensureExampleMountTests } from '@lostgradient/component-tooling/scripts/example-mount-tests.ts';

/** The old examples directory, built from segments so a path search does not find this script. */
const OLD_EXAMPLES = ['applications', 'playground', 'src', 'examples'].join('/');
const PLAYGROUND = 'applications/playground';
const PLAYGROUND_SOURCE = `${PLAYGROUND}/src`;
/** The directories, inside a component workspace, whose children are component directories. */
const COMPONENT_ROOTS = ['src/components', 'src/lib/components'];
const MODULE = /\.(?:svelte|ts)$/;
/** `import x from 'y'`, `export … from 'y'`, `import 'y'` and `import('y')`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"\n]+)\1/g;

type Workspace = { directory: string; name: string; declared: ReadonlySet<string> };
export type Move = { from: string; to: string; workspace: Workspace | null };
export type Plan = {
  moves: Move[];
  duplicates: string[];
  problems: string[];
  /** Development dependencies to add, by workspace directory: package name to specification. */
  additions: Map<string, Map<string, string>>;
};

/** Every dependency the playground declares, with its specification. */
function declaredSpecifications(manifest: Record<string, unknown>): Map<string, string> {
  const specifications = new Map<string, string>();
  for (const field of ['dependencies', 'devDependencies']) {
    const value = manifest[field];
    if (value === null || typeof value !== 'object') continue;
    for (const [name, specification] of Object.entries(value)) {
      if (typeof specification === 'string') specifications.set(name, specification);
    }
  }
  return specifications;
}

function git(root: string, ...arguments_: string[]): string {
  const result = Bun.spawnSync(['git', ...arguments_], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${arguments_.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function dependencyNames(manifest: Record<string, unknown>): string[] {
  return ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((field) => {
    const value = manifest[field];
    return value !== null && typeof value === 'object' ? Object.keys(value) : [];
  });
}

/** Every component directory in a component workspace, by component name. */
export function componentDirectories(
  root: string,
): Map<string, { directory: string; workspace: Workspace }[]> {
  const owners = new Map<string, { directory: string; workspace: Workspace }[]>();
  const componentsDirectory = join(root, 'components');
  if (!existsSync(componentsDirectory)) return owners;
  for (const entry of readdirSync(componentsDirectory, { withFileTypes: true })) {
    const manifestPath = join(componentsDirectory, entry.name, 'package.json');
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    if (typeof manifest['name'] !== 'string') continue;
    const workspace: Workspace = {
      directory: `components/${entry.name}`,
      name: manifest['name'],
      declared: new Set(dependencyNames(manifest)),
    };
    for (const componentRoot of COMPONENT_ROOTS) {
      const absoluteRoot = join(componentsDirectory, entry.name, componentRoot);
      if (!existsSync(absoluteRoot)) continue;
      for (const component of readdirSync(absoluteRoot, { withFileTypes: true })) {
        if (!component.isDirectory()) continue;
        if (!existsSync(join(absoluteRoot, component.name, `${component.name}.svelte`))) continue;
        const list = owners.get(component.name) ?? [];
        list.push({
          directory: `${workspace.directory}/${componentRoot}/${component.name}`,
          workspace,
        });
        owners.set(component.name, list);
      }
    }
  }
  return owners;
}

/** The package a bare specifier names (`@scope/name/sub` → `@scope/name`), or null for a built-in. */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:') || specifier.startsWith('bun:')) return null;
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? null);
}

/** The bare packages a module imports that `workspace` neither is nor declares. */
export function undeclaredImports(source: string, workspace: Workspace): string[] {
  const undeclared = new Set<string>();
  for (const match of source.matchAll(SPECIFIER)) {
    const name = packageOf(match[2] ?? '');
    if (name === null || name === workspace.name || workspace.declared.has(name)) continue;
    undeclared.add(name);
  }
  return [...undeclared].toSorted();
}

/** Plan every move of the tracked files still under the old examples directory. */
export function planMoves(root: string, tracked: readonly string[]): Plan {
  const owners = componentDirectories(root);
  const playgroundDependencies = declaredSpecifications(
    readJson(join(root, PLAYGROUND, 'package.json')),
  );
  const moves: Move[] = [];
  const duplicates: string[] = [];
  const problems: string[] = [];
  const additions: Plan['additions'] = new Map();
  for (const file of tracked) {
    if (!file.startsWith(`${OLD_EXAMPLES}/`)) continue;
    const rest = file.slice(OLD_EXAMPLES.length + 1);
    const [component, ...below] = rest.split('/');
    let to: string;
    let workspace: Workspace | null = null;
    if (below.length === 0) {
      to = `${PLAYGROUND_SOURCE}/${rest}`;
    } else {
      const candidates = owners.get(component ?? '') ?? [];
      if (candidates.length !== 1) {
        problems.push(
          `${file}: ${candidates.length === 0 ? 'no' : String(candidates.length)} component directories hold ${component}/${component}.svelte${candidates.length > 1 ? ` (${candidates.map((candidate) => candidate.directory).join(', ')})` : ''}`,
        );
        continue;
      }
      const [owner] = candidates;
      if (owner === undefined) continue;
      to = `${owner.directory}/examples/${below.join('/')}`;
      workspace = owner.workspace;
    }
    const source = readFileSync(join(root, file), 'utf8');
    if (existsSync(join(root, to))) {
      if (readFileSync(join(root, to), 'utf8') === source) duplicates.push(file);
      else problems.push(`${file}: ${to} already exists with different content`);
      continue;
    }
    if (workspace !== null && MODULE.test(file)) {
      for (const name of undeclaredImports(source, workspace)) {
        // The playground resolved the import before; a registry package it declares becomes a
        // development dependency of the destination. A workspace package does not: a Cinder
        // example importing chat would make a dependency cycle, so the run stops instead.
        const specification = playgroundDependencies.get(name);
        if (specification === undefined || specification.startsWith('workspace:')) {
          problems.push(`${file}: ${workspace.name} does not declare ${name}`);
          continue;
        }
        const added = additions.get(workspace.directory) ?? new Map<string, string>();
        added.set(name, specification);
        additions.set(workspace.directory, added);
      }
    }
    moves.push({ from: file, to, workspace });
  }
  return { moves, duplicates, problems, additions };
}

/**
 * Add each planned development dependency to its workspace manifest. Each name goes before the
 * first existing key that sorts after it, and the existing order stays, so the diff is one line
 * per dependency.
 */
function addDevelopmentDependencies(root: string, additions: Plan['additions']): string[] {
  const log: string[] = [];
  for (const [directory, added] of additions) {
    const path = join(root, directory, 'package.json');
    const manifest = readJson(path);
    const current = manifest['devDependencies'];
    const entries = Object.entries(
      current !== null && typeof current === 'object' ? (current as Record<string, string>) : {},
    );
    for (const [name, specification] of added) {
      if (entries.some(([existing]) => existing === name)) continue;
      const index = entries.findIndex(([existing]) => existing.localeCompare(name) > 0);
      entries.splice(index === -1 ? entries.length : index, 0, [name, specification]);
    }
    manifest['devDependencies'] = Object.fromEntries(entries);
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    for (const name of added.keys()) log.push(`depend ${directory} -> ${name}`);
  }
  return log;
}

/** Remove every empty directory at or below `directory`, deepest first. */
function removeEmptyDirectories(absolute: string): void {
  if (!existsSync(absolute)) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(join(absolute, entry.name));
  }
  if (readdirSync(absolute).length === 0) rmdirSync(absolute);
}

export function run(root: string, dryRun: boolean): string[] {
  const tracked = git(root, 'ls-files', '--', OLD_EXAMPLES).split('\n').filter(Boolean);
  const plan = planMoves(root, tracked);
  if (plan.problems.length > 0) {
    throw new Error(
      `The examples move stopped before moving anything:\n${plan.problems.join('\n')}`,
    );
  }
  const log = [
    ...plan.moves.map((move) => `move ${move.from} -> ${move.to}`),
    ...plan.duplicates.map((file) => `drop ${file} (already at its destination)`),
  ];
  if (dryRun) {
    for (const [directory, added] of plan.additions) {
      for (const name of added.keys()) log.push(`depend ${directory} -> ${name}`);
    }
    return log;
  }
  for (const move of plan.moves) {
    mkdirSync(dirname(join(root, move.to)), { recursive: true });
    git(root, 'mv', move.from, move.to);
  }
  for (const file of plan.duplicates) git(root, 'rm', '--quiet', file);
  removeEmptyDirectories(join(root, OLD_EXAMPLES));
  log.push(...addDevelopmentDependencies(root, plan.additions));
  // Every workspace that now holds examples runs the test that mounts each of them.
  log.push(...ensureExampleMountTests(root));
  return log;
}

if (import.meta.main) {
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const dryRun = process.argv.includes('--dry-run');
  const log = run(root, dryRun);
  if (log.length === 0) {
    process.stdout.write('Nothing to move.\n');
  } else {
    const moved = log.filter((line) => line.startsWith('move ')).length;
    if (!dryRun && log.some((line) => line.startsWith('depend '))) {
      process.stdout.write(
        'A manifest gained a dependency: run `bun install` and commit bun.lock.\n',
      );
    }
    process.stdout.write(`${log.join('\n')}\n${dryRun ? 'Would move' : 'Moved'} ${moved} files.\n`);
  }
}
