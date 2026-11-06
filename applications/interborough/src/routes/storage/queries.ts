/**
 * TanStack Query keys for the Storage page's reads: what the backend can do
 * (`weft.storage.capabilities`, parameterless and safe to cache for the session), the groups of keys
 * (`prefix-discovery.ts`), the value of the key that is open, and the pages of the key table. A save or a delete invalidates `keys` and
 * `prefixes`, so the table and the Group select follow what is stored (and the key counts, which are
 * the host's: `queryKeys.hostStorageSummaries`).
 */
export const storageQueryKeys = {
  capabilities: () => ['storage', 'capabilities'] as const,
  /** The groups in storage, which the Group select offers (`prefix-discovery.ts`). */
  prefixes: () => ['storage', 'prefixes'] as const,
  /** Every page of the key table, to invalidate after a write. */
  allKeys: () => ['storage', 'keys'] as const,
  /** The value of every key the pane has read, to invalidate after a write. */
  allValues: () => ['storage', 'value'] as const,
  /** The value of one key, which the pane reads when a row is opened. */
  value: (key: string) => ['storage', 'value', key] as const,
  /** The key the editor is open on, read again while it is open to see whether the app rewrote it. */
  watch: (key: string) => ['storage', 'watch', key] as const,
  /** The pages of the key table for one set of scan bounds (`scanBounds`), written as text. */
  keys: (bounds: string) => ['storage', 'keys', bounds] as const,
};

/**
 * The Svelte context key for how often the open editor reads its key again, in milliseconds, or
 * `false` for never. The pane reads {@link DEFAULT_WATCH_INTERVAL_MILLISECONDS} when nothing provides one;
 * a test provides its own so a poll never lands between two of its steps.
 */
export const STORAGE_WATCH_INTERVAL = Symbol('storage-watch-interval');

/** How often the open editor reads its key again unless a context says otherwise. */
export const DEFAULT_WATCH_INTERVAL_MILLISECONDS = 3000;
