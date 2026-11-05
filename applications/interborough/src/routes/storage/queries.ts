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
  /** The pages of the key table for one set of scan bounds (`scanBounds`), written as text. */
  keys: (bounds: string) => ['storage', 'keys', bounds] as const,
};
