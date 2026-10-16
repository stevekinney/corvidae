import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { packagePayloadAlgorithm } from './package-payload.ts';
import { publicationContractAlgorithm, publicationSnapshotSchemaVersion } from './source-digest.ts';
import { workspaceDirectories as workspaceParentDirectories } from './target-definitions.ts';

/**
 * Every corvidae workspace's disposition when the mirror transform emits a public target.
 *
 * The transform reads this map to decide what a workspace becomes downstream, and refuses to
 * emit a workspace the map does not name — a silent skip would drop a package from a published
 * graph without anything failing, which is the one outcome this pipeline exists to prevent.
 * `coverageReport` compares the map against the workspaces actually on disk so that adding a
 * workspace without a disposition fails a test rather than surfacing during a release.
 */

const mapFile = new URL('./package-map.json', import.meta.url);

const workspaceDirectories = workspaceParentDirectories;

const npmName = z.string().min(1);
const reason = z.string().min(1);

const publishAsSchema = z.object({
  disposition: z.literal('publish-as'),
  name: npmName,
  basis: z.string().min(1),
  reason,
  /** `null` where the name has never been published, which the surface-parity gate must treat as a first publish. */
  lastPublishedVersion: z.string().min(1).nullable(),
  requiredBy: z.array(z.string().min(1)).min(1).optional(),
  publishedSnapshot: z
    .object({
      schemaVersion: z.literal(publicationSnapshotSchemaVersion),
      version: z.string().min(1),
      gitHead: z.string().regex(/^[0-9a-f]{40}$/),
      corvidaeCommit: z.string().regex(/^[0-9a-f]{40}$/),
      source: z.object({
        algorithm: z.literal('sha256-files-v1'),
        paths: z.array(z.string().min(1)),
        digest: z.string().regex(/^[0-9a-f]{64}$/),
      }),
      publicationInputContract: z.object({
        algorithm: z.literal(publicationContractAlgorithm),
        digest: z.string().regex(/^[0-9a-f]{64}$/),
      }),
      registryManifestContract: z.object({
        algorithm: z.literal(publicationContractAlgorithm),
        digest: z.string().regex(/^[0-9a-f]{64}$/),
      }),
      registryPayloadContract: z.object({
        algorithm: z.literal(packagePayloadAlgorithm),
        files: z.array(
          z.object({
            path: z.string().min(1),
            executable: z.boolean(),
          }),
        ),
        digest: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    })
    .optional(),
});

const privateWorkspaceSchema = z.object({
  disposition: z.literal('private-workspace'),
  basis: z.string().min(1),
  reason,
});

const excludeSchema = z.object({
  disposition: z.literal('exclude'),
  basis: z.string().min(1),
  reason,
  /**
   * A retired package's last registry release. The mirror never reads it; the Playground does,
   * because cinder.website still documents `@lostgradient/chat` and shows the version a reader
   * can install.
   */
  lastPublishedVersion: z.string().min(1).optional(),
});

const workspaceEntrySchema = z.discriminatedUnion('disposition', [
  publishAsSchema,
  privateWorkspaceSchema,
  excludeSchema,
]);

const publishedOnlyEntrySchema = z.object({
  name: npmName,
  disposition: z.enum(['keep', 'deprecate', 'orphan-untouched']),
  visibility: z.enum(['public', 'never-published']),
  reason,
  lastPublishedVersion: z.string().min(1).optional(),
});

const packageMapSchema = z.object({
  documentation: z.string().min(1),
  workspaces: z.record(z.string().min(1), workspaceEntrySchema),
  publishedOnly: z.object({
    policy: z.string().min(1),
    entries: z.array(publishedOnlyEntrySchema).min(1),
  }),
  openQuestions: z.array(z.string().min(1)),
});

export type PackageMap = z.infer<typeof packageMapSchema>;
export type WorkspaceDisposition = z.infer<typeof workspaceEntrySchema>;
export type PublishedOnlyEntry = z.infer<typeof publishedOnlyEntrySchema>;

/** Raised when the map is malformed or a workspace has no disposition. */
export class PackageMapError extends Error {}

let cached: PackageMap | undefined;

/** Parse and validate `package-map.json`. */
export async function loadPackageMap(): Promise<PackageMap> {
  if (cached) return cached;
  const parsed = packageMapSchema.safeParse(await Bun.file(mapFile).json());
  if (!parsed.success) {
    throw new PackageMapError(`package-map.json is malformed:\n${z.prettifyError(parsed.error)}`);
  }
  assertPublishedNamesUnique(parsed.data);
  cached = parsed.data;
  return cached;
}

/**
 * Two workspaces resolving to the same npm name would make one silently overwrite the other on
 * publish, so this is checked at load rather than left to the registry to reject.
 */
function assertPublishedNamesUnique(map: PackageMap): void {
  const seen = new Map<string, string>();
  for (const [workspace, entry] of Object.entries(map.workspaces)) {
    if (entry.disposition !== 'publish-as') continue;
    const previous = seen.get(entry.name);
    if (previous) {
      throw new PackageMapError(
        `${workspace} and ${previous} both publish as ${entry.name}; a published name must be unique`,
      );
    }
    seen.set(entry.name, workspace);
  }
}

/** Every workspace name discovered on disk, read from each manifest rather than its directory. */
export async function discoverWorkspaceNames(root: string): Promise<string[]> {
  const names: string[] = [];
  for (const directory of workspaceDirectories) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = Bun.file(join(root, directory, entry.name, 'package.json'));
      if (!(await manifest.exists())) continue;
      const { name } = (await manifest.json()) as { name?: string };
      if (typeof name === 'string' && name.length > 0) names.push(name);
    }
  }
  return names.toSorted();
}

export interface CoverageReport {
  /** Workspaces on disk with no entry in the map. The transform must refuse to run while this is non-empty. */
  missing: string[];
  /** Entries in the map naming a workspace that no longer exists on disk. */
  extra: string[];
}

/** Compare the map against the workspaces actually present, in both directions. */
export async function coverageReport(root: string): Promise<CoverageReport> {
  const map = await loadPackageMap();
  const onDisk = new Set(await discoverWorkspaceNames(root));
  const mapped = new Set(Object.keys(map.workspaces));
  return {
    missing: [...onDisk].filter((name) => !mapped.has(name)).toSorted(),
    extra: [...mapped].filter((name) => !onDisk.has(name)).toSorted(),
  };
}

/**
 * Resolve one workspace's disposition, hard-erroring when it has none.
 *
 * This is the call the transform makes per workspace. It names the offending workspace so the
 * failure is actionable without reading the map.
 *
 * `map` is an optional override, the same shape `loadTargetOwnedPolicy` and `loadPackageSurface`
 * already accept for the two sibling documents — every production call omits it and reads the
 * committed file. `committed-plans.ts` and `manifests.test.ts`'s `planFor` helper pass one that
 * overlays a freshly computed `publishedSnapshot` onto every `publish-as` entry, so the many tests that
 * build a full plan for an unrelated assertion are not incidentally testing
 * `assertEdgeNotStale`'s refusal against the committed map — that refusal is
 * tested directly, against the real map, in `source-digest.test.ts`.
 */
export async function dispositionFor(
  workspace: string,
  map?: PackageMap,
): Promise<WorkspaceDisposition> {
  const resolved = map ?? (await loadPackageMap());
  const entry = resolved.workspaces[workspace];
  if (!entry) {
    throw new PackageMapError(
      `${workspace} has no disposition in package-map.json; add one of publish-as, private-workspace, or exclude before syncing`,
    );
  }
  return entry;
}

/** The npm names this map would publish, sorted. */
export async function publishableNames(): Promise<string[]> {
  const map = await loadPackageMap();
  return Object.values(map.workspaces)
    .filter((entry) => entry.disposition === 'publish-as')
    .map((entry) => entry.name)
    .toSorted();
}
