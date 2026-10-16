/** The immutable Cinder base a new theme embeds, taken from the token runtime's bundled corpus. */

import { CINDER_BASE } from '@lostgradient/cinder/tokens/runtime';

import type { JsonValue, ThemeBase } from './theme-draft-types.ts';

/**
 * The base is shared by reference: it is immutable, storage copies it on write, and keeping
 * the runtime's own document objects lets its validation memo recognize them.
 */
export function cinderThemeBase(): ThemeBase {
  return {
    packageVersion: CINDER_BASE.packageVersion,
    sourceDigest: CINDER_BASE.sourceDigest,
    resolver: CINDER_BASE.resolver,
    documents: CINDER_BASE.documents as Record<string, JsonValue>,
  };
}

/**
 * True when an embedded base is the one this build of Cinder ships. The source digest is the
 * identity: it hashes the resolver and documents only, while the package version is a label that
 * read `workspace` before the Playground stamped the published one, and that a published package
 * can carry from an earlier release with the same corpus.
 */
export function isShippedBase(base: ThemeBase): boolean {
  return base.sourceDigest === CINDER_BASE.sourceDigest;
}
