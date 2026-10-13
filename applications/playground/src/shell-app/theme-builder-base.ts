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
    resolver: CINDER_BASE.resolver as unknown as JsonValue,
    documents: CINDER_BASE.documents as unknown as Record<string, JsonValue>,
  };
}

/** True when an embedded base is the one this build of Cinder ships. */
export function isShippedBase(base: ThemeBase): boolean {
  return base.sourceDigest === CINDER_BASE.sourceDigest;
}
