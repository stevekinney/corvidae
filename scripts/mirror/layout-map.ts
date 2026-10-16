import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { workspaceDirectories as workspaceParentDirectories } from './target-definitions.ts';

/**
 * Where a corvidae workspace lands inside the target that receives it.
 *
 * Corvidae's directory layout is not the targets'. `components/cinder` is cinder's
 * `packages/components` and `components/editor` is cinder's `packages/editor`, so a transform that reused corvidae's
 * own directory would write a second tree beside the target's real one. Under COR-1221's deletion
 * rule that duplicate is permanent: the transform prunes only paths it owns, and `packages/**` is
 * not one of them once `components/**` is what it emits.
 *
 * The table is explicit rather than derived. `package-surface.json` carries a `provenance.path`
 * that looks like it would answer this and does not: it records where a published surface was
 * vendored from, which is the upstream repository's directory at the commit it was copied from
 * rather than where the mirror writes the package today.
 */

const layoutFile = new URL('./layout-map.json', import.meta.url);

const directorySchema = z
  .string()
  .min(1)
  .regex(/^[^/]+(\/[^/]+)*$/, 'a directory is a relative path with no leading or trailing slash');

const emitSchema = z.object({
  disposition: z.literal('emit'),
  corvidaeDirectory: directorySchema,
  targetDirectory: directorySchema,
  reason: z.string().min(1),
});

const deferredSchema = z.object({
  disposition: z.literal('deferred'),
  corvidaeDirectory: directorySchema,
  issue: z
    .string()
    .regex(/^[A-Z]+-\d+$/, 'issue must be a Linear identifier, for example COR-1221'),
  reason: z.string().min(1),
});

const workspaceLayoutSchema = z.discriminatedUnion('disposition', [emitSchema, deferredSchema]);

const layoutMapSchema = z.object({
  documentation: z.string().min(1),
  workspaces: z.record(z.string().min(1), workspaceLayoutSchema),
  openQuestions: z.array(z.string().min(1)),
});

export type LayoutMap = z.infer<typeof layoutMapSchema>;
export type WorkspaceLayout = z.infer<typeof workspaceLayoutSchema>;
export type EmittedLayout = z.infer<typeof emitSchema>;
export type DeferredLayout = z.infer<typeof deferredSchema>;

/** Raised when the table is malformed, incomplete, or names two workspaces for one directory. */
export class LayoutMapError extends Error {}

/** Refusal to emit a workspace whose placement in the target is deliberately unresolved. */
export class DeferredWorkspaceError extends Error {
  readonly workspaces: readonly string[];

  constructor(entries: readonly { workspace: string; layout: DeferredLayout }[]) {
    super(
      `These workspaces have no target layout, so the sync cannot run:\n${entries
        .map(
          ({ workspace, layout }) =>
            `  ${workspace} (${layout.corvidaeDirectory}), deferred by ${layout.issue}: ${layout.reason}`,
        )
        .join('\n')}`,
    );
    this.name = 'DeferredWorkspaceError';
    this.workspaces = entries.map((entry) => entry.workspace);
  }
}

let cached: LayoutMap | undefined;

/** Parse and validate `layout-map.json`. */
export async function loadLayoutMap(source: URL | string = layoutFile): Promise<LayoutMap> {
  if (cached && source === layoutFile) return cached;
  const parsed = layoutMapSchema.safeParse(await Bun.file(source).json());
  if (!parsed.success) {
    throw new LayoutMapError(`layout-map.json is malformed:\n${z.prettifyError(parsed.error)}`);
  }
  assertTargetDirectoriesUnique(parsed.data);
  if (source === layoutFile) cached = parsed.data;
  return parsed.data;
}

/**
 * Two workspaces landing in one target directory would make the second overwrite the first, and
 * the overwrite would look like an ordinary sync rather than a collision.
 */
function assertTargetDirectoriesUnique(map: LayoutMap): void {
  const seen = new Map<string, string>();
  for (const [workspace, layout] of Object.entries(map.workspaces)) {
    if (layout.disposition !== 'emit') continue;
    const previous = seen.get(layout.targetDirectory);
    if (previous) {
      throw new LayoutMapError(
        `${workspace} and ${previous} both map to ${layout.targetDirectory}; a target directory holds one workspace`,
      );
    }
    seen.set(layout.targetDirectory, workspace);
  }
}

/**
 * One workspace's layout, hard-erroring when the table has none.
 *
 * A workspace with no entry stops the transform for the same reason `package-map.json` stops it
 * for a workspace with no disposition: guessing the directory is how a package silently lands in
 * the wrong place.
 */
export async function layoutFor(workspace: string): Promise<WorkspaceLayout> {
  const map = await loadLayoutMap();
  const layout = map.workspaces[workspace];
  if (!layout) {
    throw new LayoutMapError(
      `${workspace} has no entry in layout-map.json; record where it lands in the target before syncing`,
    );
  }
  return layout;
}

/** The target-relative directory a workspace is emitted into, or a refusal when it is deferred. */
export async function targetDirectoryFor(workspace: string): Promise<string> {
  const layout = await layoutFor(workspace);
  if (layout.disposition === 'deferred') throw new DeferredWorkspaceError([{ workspace, layout }]);
  return layout.targetDirectory;
}

const parentDirectories = workspaceParentDirectories;

export interface LayoutCoverage {
  /** Workspaces on disk with no entry. The transform must refuse to run while this is non-empty. */
  missing: string[];
  /** Entries naming a workspace that no longer exists on disk. */
  extra: string[];
  /** Entries whose recorded corvidae directory is not where the workspace actually is. */
  misplaced: string[];
}

/**
 * Compare the table against the workspaces actually present, in both directions, and check that
 * each entry still names the directory the workspace occupies. A workspace that moves inside
 * corvidae fails here rather than being mirrored from a directory that no longer exists.
 */
export async function layoutCoverage(root: string): Promise<LayoutCoverage> {
  const map = await loadLayoutMap();
  const locations = await discoverWorkspaceLocations(root);
  const onDisk = new Map(locations.map(({ name, directory: found }) => [name, found]));
  const mapped = new Set(Object.keys(map.workspaces));
  const misplaced: string[] = [];
  for (const [workspace, layout] of Object.entries(map.workspaces)) {
    const found = onDisk.get(workspace);
    if (found === undefined || found === layout.corvidaeDirectory) continue;
    misplaced.push(`${workspace}: recorded ${layout.corvidaeDirectory}, found ${found}`);
  }
  return {
    missing: [...onDisk.keys()].filter((name) => !mapped.has(name)).toSorted(),
    extra: [...mapped].filter((name) => !onDisk.has(name)).toSorted(),
    misplaced: misplaced.toSorted(),
  };
}

/** Every workspace on disk with the directory holding it, read in one pass. */
export async function discoverWorkspaceLocations(
  root: string,
): Promise<{ name: string; directory: string }[]> {
  const located: { name: string; directory: string }[] = [];
  for (const parent of parentDirectories) {
    const entries = await readdir(join(root, parent), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      const workspaceDirectory = `${parent}/${entry.name}`;
      const manifest = Bun.file(join(root, workspaceDirectory, 'package.json'));
      if (!(await manifest.exists())) continue;
      const { name } = (await manifest.json()) as { name?: string };
      if (typeof name === 'string' && name.length > 0)
        located.push({ name, directory: workspaceDirectory });
    }
  }
  return located;
}
