import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { PackageSurfaceEntry } from './package-surface.ts';

/**
 * The source half of the mirror transform: corvidae's workspace source in, the same tree at the
 * target's own path out.
 *
 * Until COR-1221 the transform wrote manifests, exports maps and TypeScript configuration over a
 * target that still supplied every line of source itself, which is backwards from the premise
 * that corvidae is where the code lives. This emits the source, prunes what corvidae no longer
 * has, and answers three questions the write path could not previously ask.
 *
 * **What counts as source.** A workspace's `src/` tree, and nothing else. The build inputs
 * `package-surface.json` records — `scripts/build.ts`, `tsdown.config.ts`, `vite.config.ts` — are
 * emitted too when corvidae carries one, which it carries none of today; they stay target-owned
 * and `assertBuildInputsPresent` fails a sync whose clone is missing one. A workspace that turns
 * out to need anything else fails there, by name, rather than being patched in here.
 *
 * **Why files are read as bytes.** `packages/testing/src/helpers/__fixtures__` carries a PNG
 * baseline inside a source tree, so a plan typed as string-to-string could not carry it. Reading
 * every file as bytes removes the text-or-binary guess entirely; git compares bytes either way.
 *
 * **Why the non-source filter is here and not in the guard.** Corvidae's workspaces carry files
 * that match the target-owned globs — `coverage-ratchet.json`, `AGENTS.md`, `.gitignore`,
 * `CHANGELOG*` — and a plan containing one is a refusal, not a warning. Those must therefore
 * never enter the plan. The tempting shortcut is to filter the plan through the guard's own
 * matcher, which would quietly turn a refusal into a filter: the guard would stop being able to
 * fail. So the rule lives here, as a short enumerated list with its own reasons, and the guard
 * keeps its only job, which is to refuse.
 */

export class SourceEmissionError extends Error {}

/** One workspace the transform emits, in corvidae and in the target. */
export interface EmittedWorkspace {
  /** The `@corvidae/*` name. */
  workspace: string;
  /** Corvidae-relative directory, read from disk. */
  corvidaeDirectory: string;
  /** Target-relative directory, from `layout-map.json`. */
  targetDirectory: string;
  /** The published surface, when the workspace publishes; absent for a private workspace. */
  entry?: PackageSurfaceEntry | undefined;
}

/**
 * The directory holding a workspace's source, relative to the workspace.
 *
 * One tree, not a per-package `sourceRoot`: `package-surface.json` records `src/lib` for the two
 * SvelteKit packages, which is where their *published* entry points live, not the whole of what
 * they compile. Emitting `src/` covers both and keeps the prune scope the same shape as the
 * emission scope.
 */
export const sourceTree = 'src';

/**
 * Names that are repository-operating files rather than source, wherever they appear.
 *
 * Every one of these also matches a `**`-rooted glob in `target-owned.json`, which is the point:
 * the target owns its coverage floors, its agent instructions, its ignore rules and its release
 * history, and corvidae carries its own copies of the first three. The list is short because it is
 * exactly the target-owned globs that can match inside a source tree; the rest are rooted at the
 * repository or package root, where no source lives.
 */
export const nonSourceNames = [
  'AGENTS.md',
  'CLAUDE.md',
  '.gitignore',
  'coverage-ratchet.json',
] as const;

/** Release history, which the target generates from versions corvidae has no knowledge of. */
export const nonSourcePrefixes = ['CHANGELOG'] as const;

/**
 * Directory names never walked. An installed dependency tree is not source and cannot be, so a
 * stray one inside `src/` is skipped rather than mirrored a thousand files at a time.
 */
const skippedDirectories: readonly string[] = ['node_modules'];

/** Whether a file is source, judged by its name alone. */
export function isSourceFile(name: string): boolean {
  if ((nonSourceNames as readonly string[]).includes(name)) return false;
  return !nonSourcePrefixes.some((prefix) => name.startsWith(prefix));
}

export interface SourcePlan {
  /** Target-relative path to file contents. */
  files: Record<string, Uint8Array>;
  /** Target-relative paths whose corvidae counterpart is executable. */
  executable: string[];
  /**
   * Target-relative directory prefixes the transform owns, one per emitted workspace. Everything
   * beneath one of these is the transform's to write and to prune; everything outside is not.
   */
  ownedPrefixes: string[];
  /** Workspaces whose emitted source includes TypeScript, which is what makes a typecheck meaningful. */
  typeScriptWorkspaces: string[];
}

/**
 * Every source file beneath one directory, as `{ absolute, relative }` pairs in a stable order.
 *
 * One walker for both directions: the corvidae tree it emits and the target tree it prunes have
 * to agree on what a source file is, or a file would be written on one run and deleted on the
 * next. A directory that does not exist yields nothing, which is how a workspace with no `src/`
 * and a target that has not received one yet both read.
 */
async function walkSourceFiles(root: string): Promise<{ absolute: string; relative: string }[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(
    (error: NodeJS.ErrnoException) => {
      // Only "there is no such directory" is an empty tree. Any other failure — a permission
      // error, an I/O error — must not read as one: on the corvidae side it would plan zero
      // source for a workspace, and the prune would then delete the target's whole source tree
      // for exactly the reason a deletion must never be computed from a read that failed.
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const files: { absolute: string; relative: string }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isSourceFile(entry.name)) continue;
    const absolute = join(entry.parentPath, entry.name);
    const path = relativeTo(root, absolute);
    if (path.split('/').some((segment) => skippedDirectories.includes(segment))) continue;
    files.push({ absolute, relative: path });
  }
  return files.toSorted((left, right) => left.relative.localeCompare(right.relative));
}

function relativeTo(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

/** Read one workspace's source tree, or nothing when the workspace has none. */
async function readSourceTree(
  corvidaeRoot: string,
  workspace: EmittedWorkspace,
  plan: SourcePlan,
): Promise<void> {
  const root = join(corvidaeRoot, workspace.corvidaeDirectory, sourceTree);
  let carriesTypeScript = false;
  for (const { absolute, relative: path } of await walkSourceFiles(root)) {
    const target = `${workspace.targetDirectory}/${sourceTree}/${path}`;
    await readInto(plan, absolute, target);
    if (path.endsWith('.ts') || path.endsWith('.tsx')) carriesTypeScript = true;
  }
  if (carriesTypeScript) plan.typeScriptWorkspaces.push(workspace.workspace);
}

/**
 * Read one file into the plan, recording the executable bit.
 *
 * Preserved because corvidae's two `bin` entry points are executable in the source tree, and a
 * write path that dropped the mode would publish a binary nothing can run.
 */
async function readInto(plan: SourcePlan, absolute: string, path: string): Promise<void> {
  plan.files[path] = new Uint8Array(await Bun.file(absolute).arrayBuffer());
  const metadata = await stat(absolute);
  if ((metadata.mode & 0o111) !== 0) plan.executable.push(path);
}

/** Every build input the surface declares that corvidae actually carries, emitted with the source. */
async function readDeclaredBuildInputs(
  corvidaeRoot: string,
  workspace: EmittedWorkspace,
  plan: SourcePlan,
): Promise<void> {
  for (const input of workspace.entry?.build.requiredInputs ?? []) {
    const absolute = join(corvidaeRoot, workspace.corvidaeDirectory, input);
    const file = Bun.file(absolute);
    if (!(await file.exists())) continue;
    await readInto(plan, absolute, `${workspace.targetDirectory}/${input}`);
  }
}

/**
 * Plan every emitted workspace's source at its target path.
 *
 * `ownedPrefixes` is the same list the prune reads, so what the transform writes and what it is
 * allowed to delete are one decision rather than two that can drift.
 */
export async function planSource(
  corvidaeRoot: string,
  emitted: readonly EmittedWorkspace[],
): Promise<SourcePlan> {
  const plan: SourcePlan = {
    files: {},
    executable: [],
    ownedPrefixes: [],
    typeScriptWorkspaces: [],
  };
  for (const workspace of emitted) {
    plan.ownedPrefixes.push(`${workspace.targetDirectory}/${sourceTree}`);
    await readSourceTree(corvidaeRoot, workspace, plan);
    await readDeclaredBuildInputs(corvidaeRoot, workspace, plan);
  }
  plan.ownedPrefixes.sort();
  plan.executable.sort();
  plan.typeScriptWorkspaces.sort();
  return plan;
}

/**
 * Target files beneath a prefix the transform owns that this plan does not emit.
 *
 * This is the whole of what a sync deletes. A path outside every owned prefix is either the
 * target's own — its build scripts, its release notes, a working document nobody enumerated — or
 * something no one has ruled on, and both are left exactly as they are. The non-source filter is
 * applied here too, so a target that keeps its own `AGENTS.md` inside a source tree keeps it.
 */
export async function collectPrunablePaths(
  directory: string,
  plan: Pick<SourcePlan, 'ownedPrefixes'>,
  emittedPaths: Iterable<string>,
): Promise<string[]> {
  const emitted = new Set(emittedPaths);
  const prunable: string[] = [];
  for (const prefix of plan.ownedPrefixes) {
    for (const { relative: path } of await walkSourceFiles(join(directory, prefix))) {
      const target = `${prefix}/${path}`;
      if (!emitted.has(target)) prunable.push(target);
    }
  }
  return prunable.toSorted();
}

/** One producer's claim on a set of plan keys. */
export interface PlanOwnership {
  owner: string;
  paths: Iterable<string>;
}

/**
 * Refuse a plan whose keys are claimed by two producers.
 *
 * `planSurface` merges three file sets — the manifests, the TypeScript configuration and now the
 * source — with object spread, where the last writer wins and says nothing. Every one of them
 * emits paths under the same workspace directory, so a collision is a real possibility rather
 * than a theoretical one, and its symptom downstream would be a file that is silently the wrong
 * half of the transform.
 */
export function assertSingleOwner(claims: readonly PlanOwnership[]): void {
  const owners = new Map<string, string>();
  const conflicts: string[] = [];
  for (const claim of claims) {
    for (const path of claim.paths) {
      const previous = owners.get(path);
      if (previous !== undefined) {
        conflicts.push(`${path}: claimed by ${previous} and ${claim.owner}`);
        continue;
      }
      owners.set(path, claim.owner);
    }
  }
  if (conflicts.length > 0) {
    throw new SourceEmissionError(
      `Two halves of the transform claim the same plan key:\n${conflicts.map((line) => `  ${line}`).join('\n')}`,
    );
  }
}
