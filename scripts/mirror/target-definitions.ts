export type MirrorTarget = 'weft' | 'cinder';

export class MirrorTargetError extends Error {}

/** The workspace roots shared by discovery and target manifests. */
export const workspaceDirectories = ['applications', 'components', 'packages', 'internal'] as const;

/**
 * Per-target facts that are not in `package-map.json`, which rules on what a workspace *becomes*
 * rather than on which repository it lands in.
 *
 * `rootName` and `workspaces` are read off the targets as they exist today (`weft-monorepo` with
 * `packages/*`, `cinder-workspace` with its explicit list) rather than invented, so a sync does not
 * rewrite a key that was already correct. `catalog` records whether the target has a workspace root
 * able to hold one: weft's root has none, so its specifiers inline to concrete ranges.
 *
 * `members` is exhaustive as of COR-1287: every non-excluded workspace in `package-map.json` is
 * named by exactly one list, enforced by `manifests.test.ts` against the map rather than left to
 * this comment. A third target, `agent-bureau`, was retired on 2026-10-14 when the owner stopped
 * publishing everything except Weft and Cinder's packages; its former members are `exclude`d.
 */
export const targetDefinitions = {
  weft: {
    rootName: 'weft-monorepo',
    workspaces: ['packages/*'],
    catalog: false,
    /** The weft target is a single-package repository; every other workspace ships elsewhere. */
    members: ['@lostgradient/weft'],
  },
  cinder: {
    rootName: 'cinder-workspace',
    workspaces: workspaceDirectories.map((directory) => `${directory}/*`),
    catalog: true,
    members: [
      '@lostgradient/cinder',
      '@lostgradient/editor',
      '@lostgradient/markdown',
      '@lostgradient/testing',
      '@lostgradient/typescript',
    ],
  },
} as const satisfies Record<
  MirrorTarget,
  {
    rootName: string;
    workspaces: readonly string[];
    catalog: boolean;
    members: readonly string[];
  }
>;

export const mirrorTargets = Object.keys(targetDefinitions) as readonly MirrorTarget[];

/**
 * Which target a workspace ships from.
 *
 * Throws rather than defaulting. A default was what made the two-target version read cleanly, and
 * it is exactly what the member lists exist to prevent: an unlisted workspace silently joining
 * whichever target held the fallback is a package published from the wrong repository, which no downstream
 * check would notice. Every caller here filters `exclude` first, so a workspace reaching this
 * function is one the mirror emits and therefore one that must have a home.
 */
export function targetFor(workspace: string): MirrorTarget {
  for (const target of mirrorTargets) {
    if ((targetDefinitions[target].members as readonly string[]).includes(workspace)) return target;
  }
  throw new MirrorTargetError(
    `${workspace} is not a member of any mirror target; add it to one of targetDefinitions' member lists or exclude it in package-map.json`,
  );
}

/** Registry range after the mirror's workspace rewrite and packing. */
export function publishedVersionRange(version: string, crossTarget: boolean): string {
  return crossTarget ? `^${version}` : version;
}

/**
 * Whether the target's root can hold a Bun catalog, which decides whether a `catalog:` specifier
 * survives into it or is inlined to the concrete range corvidae's root catalog declares.
 *
 * Exported because `surface.ts` asks the same question about the toolchain dependencies it adds
 * and used to answer it with its own `options.target === 'cinder'`. Two literals, one fact, kept in
 * one place.
 */
export function targetHasCatalog(target: MirrorTarget): boolean {
  return targetDefinitions[target].catalog;
}

/** The member workspaces of one target, for the map-coverage test rather than for the transform. */
export function membersOf(target: MirrorTarget): readonly string[] {
  return targetDefinitions[target].members;
}
