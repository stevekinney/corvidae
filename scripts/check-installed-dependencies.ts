/**
 * Fail when the installed `node_modules` no longer matches `bun.lock`.
 *
 * The catalog and the lockfile decide which versions the workspace resolves, but they cannot update
 * a checkout whose packages were installed before a version changed. On 2026-11-21 a checkout's
 * root still linked `svelte` 5.57.0 after the catalog moved to 5.57.1, while Cinder linked 5.57.1,
 * so an app that bundled Cinder carried two Svelte runtimes and crashed on load. `bun install
 * --frozen-lockfile --dry-run` cannot catch this: it lists every package and exits 0 either way.
 *
 * With Bun's isolated linker every installed package is a symlink from a workspace's
 * `node_modules` into the store under `node_modules/.bun`. This guard reads each link's installed
 * version and reports one that `bun.lock` no longer resolves, a link into a store folder that is
 * gone, and a declared dependency that is not linked at all. It does not prove the install is
 * byte-for-byte the lockfile's: two versions that `bun.lock` both resolve are accepted wherever
 * either is linked. Runs from `lint:root` and `preflight`.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export type Lockfile = {
  /** Workspace paths, with `''` for the repository root. */
  readonly workspaces: readonly string[];
  /** Every version `bun.lock` resolves for each installed package name, across all workspaces. */
  readonly versions: ReadonlyMap<string, ReadonlySet<string>>;
  /** The registry dependencies each workspace declares, by workspace path. */
  readonly declared: ReadonlyMap<string, readonly string[]>;
};

export type StaleInstall = {
  readonly workspace: string;
  readonly name: string;
  readonly problem: string;
};

type RawLockfile = {
  workspaces?: Record<
    string,
    { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  >;
  packages?: Record<string, [string, ...unknown[]]>;
};

/** The installed name a `bun.lock` package key ends with, such as `svelte-check` in `@a/b/svelte-check`. */
function installedName(key: string): string {
  const segments = key.split('/');
  const last = segments.at(-1) ?? key;
  const scope = segments.at(-2);
  return scope?.startsWith('@') ? `${scope}/${last}` : last;
}

/** Split `name@version` at the version's `@`, which follows any scope's leading `@`. */
function splitResolution(resolution: string): { name: string; version: string } {
  const at = resolution.lastIndexOf('@');
  return { name: resolution.slice(0, at), version: resolution.slice(at + 1) };
}

/** Parse the parts of `bun.lock` this guard compares the install against. */
export function readLockfile(text: string): Lockfile {
  const lock = Bun.JSONC.parse(text) as RawLockfile;
  const versions = new Map<string, Set<string>>();
  const local = new Set<string>();
  for (const [key, [resolution]] of Object.entries(lock.packages ?? {})) {
    const { version } = splitResolution(resolution);
    const name = installedName(key);
    // Workspace, link, file and git resolutions have no registry version to compare.
    if (version.includes(':')) {
      local.add(name);
      continue;
    }
    const known = versions.get(name) ?? new Set<string>();
    known.add(version);
    versions.set(name, known);
  }
  const declared = new Map<string, string[]>();
  for (const [path, workspace] of Object.entries(lock.workspaces ?? {})) {
    const names = Object.keys({ ...workspace.dependencies, ...workspace.devDependencies });
    declared.set(
      path,
      names.filter((name) => versions.has(name) && !local.has(name)),
    );
  }
  return { workspaces: Object.keys(lock.workspaces ?? {}), versions, declared };
}

/** The package names linked directly in one `node_modules`, with scoped packages as `@scope/name`. */
function linkedNames(modules: string): string[] {
  if (!existsSync(modules)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      const scope = join(modules, entry);
      if (!lstatSync(scope).isDirectory()) continue;
      for (const child of readdirSync(scope)) names.push(`${entry}/${child}`);
    } else names.push(entry);
  }
  return names;
}

function installedVersion(path: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as {
    version?: string;
  };
  return manifest.version;
}

/** Every way the install under `root` disagrees with `lock`, sorted by workspace and name. */
export function staleInstalls(root: string, lock: Lockfile): StaleInstall[] {
  const found: StaleInstall[] = [];
  for (const workspace of lock.workspaces) {
    const label = workspace === '' ? '.' : workspace;
    const modules = join(root, workspace, 'node_modules');
    const linked = new Set(linkedNames(modules));
    for (const name of lock.declared.get(workspace) ?? []) {
      if (!linked.has(name))
        found.push({ workspace: label, name, problem: 'declared in bun.lock but not installed' });
    }
    for (const name of linked) {
      const path = join(modules, name);
      if (!lstatSync(path).isSymbolicLink() || !readlinkSync(path).includes('.bun')) continue;
      const locked = lock.versions.get(name);
      if (!locked) continue;
      if (!existsSync(path)) {
        found.push({
          workspace: label,
          name,
          problem: 'linked to a store folder that no longer exists',
        });
        continue;
      }
      const version = installedVersion(path);
      if (version === undefined || !locked.has(version))
        found.push({
          workspace: label,
          name,
          problem: `installed ${version ?? 'an unversioned package'}, but bun.lock resolves ${[...locked].join(', ')}`,
        });
    }
  }
  return found.toSorted(
    (left, right) =>
      left.workspace.localeCompare(right.workspace) || left.name.localeCompare(right.name),
  );
}

function main(): void {
  const root = join(import.meta.dir, '..');
  const lock = readLockfile(readFileSync(join(root, 'bun.lock'), 'utf8'));
  const stale = staleInstalls(root, lock);
  for (const { workspace, name, problem } of stale)
    process.stderr.write(`check-installed-dependencies — ${workspace}: ${name} ${problem}.\n`);
  if (stale.length > 0) {
    process.stderr.write(
      'Run `bun install --frozen-lockfile` to bring node_modules back in line with bun.lock.\n',
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
