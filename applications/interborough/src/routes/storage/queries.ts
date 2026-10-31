/**
 * TanStack Query keys for the Storage page's reads: what the backend can do
 * (`weft.storage.capabilities`, parameterless and safe to cache for the session), the groups of keys
 * (`prefix-discovery.ts`), and the pages of the key table. A save or a delete invalidates `keys` and
 * `prefixes`, so the table and the Group select follow what is stored.
 */
export const storageQueryKeys = {
  capabilities: () => ['storage', 'capabilities'] as const,
  /** The groups in storage, which the Group select offers (`prefix-discovery.ts`). */
  prefixes: () => ['storage', 'prefixes'] as const,
  /** Every page of the key table, to invalidate after a write. */
  allKeys: () => ['storage', 'keys'] as const,
  /** The pages of the key table for one group and one search. */
  keys: (group: string, search: string) => ['storage', 'keys', group, search] as const,
};
