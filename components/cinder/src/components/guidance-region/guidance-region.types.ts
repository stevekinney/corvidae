import type { Snippet } from 'svelte';
import type { GuidanceClaim, GuidanceStorage } from '../../_internal/guidance-context.ts';
export type GuidanceRegionProps = {
  /**
   * Registered guidance claims available to descendants through
   * `useGuidance`. Defaults to `[]`. (`GuidanceClaim` is not expressible in
   * JSON Schema, so this default only appears here in prose.)
   */
  claims?: GuidanceClaim[];
  /** Version window claims are filtered against. */
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
