/**
 * How large the storage is, as Health says it in more than one place: the latest size the engine
 * reported (it reports when it tidies up), else the size a firing `storage.size` alert last
 * measured, else what the host's backend says of its own file or database. The first two are what
 * the Overview's Storage use card and the warning are built from, so the numbers agree; a fresh
 * installation, which has reported nothing and has no rule, falls to the backend.
 */
import type { StorageSample } from '../health/storage-sizes.svelte.ts';

/** The storage's size in bytes, or `undefined` when none of the three sources can say. */
export function latestStorageBytes(sources: {
  /** The sizes the engine reported in the last 24 hours, oldest first. */
  readonly samples: readonly StorageSample[];
  /** What a firing `storage.size` alert last measured. */
  readonly alertBytes: number | undefined;
  /** What the host's backend says its storage holds; `null` when the backend cannot say. */
  readonly hostBytes: number | null | undefined;
}): number | undefined {
  return sources.samples.at(-1)?.bytes ?? sources.alertBytes ?? sources.hostBytes ?? undefined;
}
