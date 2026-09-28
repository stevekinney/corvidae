export type MirrorTarget = 'weft' | 'cinder' | 'agent-bureau';

export class MirrorTargetError extends Error {}

/** The workspace roots shared by discovery and target manifests. */
export const workspaceDirectories = ['applications', 'components', 'packages', 'internal'] as const;

/**
 * Per-target facts that are not in `package-map.json`, which rules on what a workspace *becomes*
 * rather than on which repository it lands in.
 *
 * `rootName` and `workspaces` are read off the targets as they exist today (`weft-monorepo` with
 * `packages/*`, `cinder-workspace` with its explicit list, `agent-bureau` with `packages/*`)
 * rather than invented, so a sync does not rewrite a key that was already correct. `catalog`
 * records whether the target has a workspace root able to hold one: `agent-bureau`'s root declares
 * `workspaces` but no `catalog`, so its specifiers inline to concrete ranges the way weft's do.
 *
 * `members` is exhaustive as of COR-1287. It used to be a single list — weft's — with every other
 * workspace falling through to cinder, which was correct while there were two targets and stopped
 * being correct the moment a third one claimed ten of the workspaces that fell through. Every
 * non-excluded workspace in `package-map.json` is now named by exactly one list, enforced by
 * `manifests.test.ts` against the map rather than left to this comment.
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
      '@lostgradient/chat',
      '@lostgradient/editor',
      '@lostgradient/markdown',
      '@lostgradient/weft-ui',
      '@lostgradient/testing',
      '@lostgradient/typescript',
    ],
  },
  'agent-bureau': {
    rootName: 'agent-bureau',
    workspaces: ['packages/*'],
    catalog: false,
    members: [
      '@lostgradient/operative',
      'armorer',
      'conversationalist',
      '@lostgradient/cryptography',
      '@lostgradient/embeddings',
      '@lostgradient/tool-protocol',
      '@lostgradient/lifecycle',
      '@lostgradient/bureau',
      '@lostgradient/memory',
      '@lostgradient/skills',
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
 * it is exactly what a third target cannot have: an unlisted workspace silently joining whichever
 * target held the fallback is a package published from the wrong repository, which no downstream
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
 * and used to answer it with its own `options.target === 'cinder'`. Two literals, one fact: a
 * third target made the copy wrong rather than merely duplicated.
 */
export function targetHasCatalog(target: MirrorTarget): boolean {
  return targetDefinitions[target].catalog;
}

/** The member workspaces of one target, for the map-coverage test rather than for the transform. */
export function membersOf(target: MirrorTarget): readonly string[] {
  return targetDefinitions[target].members;
}
