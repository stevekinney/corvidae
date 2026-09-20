import type { Snippet } from 'svelte';
import type { GuidanceClaim, GuidanceStorage } from '../../_internal/guidance-context.ts';
export type GuidanceRegionProps = {
  /**
   * Registered guidance claims available to descendants through
   * `useGuidance`. Defaults to `[]`. (`GuidanceClaim` is not expressible in
   * JSON Schema, so this default only appears here in prose.)
   */
  claims?: GuidanceClaim[];
  /**
   * Version window claims are filtered against. When omitted, every claim
   * is relevant and neither claim's `relevantFrom` nor `relevantUntil` is
   * validated. When supplied, it must be SemVer-shaped
   * (`major.minor.patch`, each numeric with no leading zero, an optional
   * `-prerelease`/`+build` suffix)—a shortened form like `'1.2'` fails to
   * parse. The parser is looser than strict SemVer in one respect: it
   * doesn't reject an empty dot-separated identifier inside a
   * `-prerelease`/`+build` suffix (e.g. `'1.0.0-alpha..1'` still parses).
   * A claim's `relevantFrom`/`relevantUntil` are parsed the same way; if
   * either fails to parse, that claim is filtered out silently rather than
   * erroring.
   */
  version?: string;
  /** Adapter used to persist which claims a user has dismissed, so dismissal survives a reload. */
  storage?: GuidanceStorage;
  /**
   * Key used to namespace dismissal state in the storage adapter. Defaults
   * to `'cinder-guidance'`—regions sharing one storage adapter without an
   * explicit `storageKey` collide in that namespace.
   * @default 'cinder-guidance'
   */
  storageKey?: string;
  /** Resolves a claim anchor using consumer-owned DOM knowledge. */
  anchorResolver?: (anchor: string) => HTMLElement | null;
  /** Descendant application surface that consumes guidance through `useGuidance`. */
  children?: Snippet;
};
