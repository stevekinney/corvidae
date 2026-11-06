/**
 * What the host tells the storage explorer about the keys the application manages. The browser
 * cannot import the Bureau (its entry point reaches the Node and Bun storage packages), so the host
 * reads `BUREAU_RESERVED_KEY_PREFIXES` and serves it at `/host/storage`, together with the families
 * the Bureau shares with the engine and the session store (`SHARED_KEY_FAMILIES_OF_A_CHAT`:
 * `agent-session`, `durable-run:`, `weft:`, the governed-memory keys); the Weft prefixes are already
 * public to the browser and are read there.
 */
import { BUREAU_RESERVED_KEY_PREFIXES, SHARED_KEY_FAMILIES_OF_A_CHAT } from '@lostgradient/bureau';

import { storageCount, type Storage } from '@lostgradient/storage';

import type { HostStorage, HostStorageSummary } from '../lib/host-storage.ts';

/**
 * Every key prefix the application manages beyond Weft's own: the Bureau's families, then the ones
 * its chats' runs write into the same storage through the session store and governed memory.
 */
export const MANAGED_KEY_PREFIXES: readonly string[] = [
  ...new Set([
    ...BUREAU_RESERVED_KEY_PREFIXES,
    ...SHARED_KEY_FAMILIES_OF_A_CHAT.map((family) => family.prefix),
  ]),
];

/**
 * The report `/host/storage` serves: every key prefix the Bureau and the stores it shares write,
 * and how many bytes the storage holds (`null` for a backend that cannot say, or one that fails).
 */
export async function hostStorageReport(storage: Pick<Storage, 'sizeBytes'>): Promise<HostStorage> {
  let sizeBytes: number | null = null;
  try {
    sizeBytes = (await storage.sizeBytes?.()) ?? null;
  } catch {
    sizeBytes = null;
  }
  return { bureauKeyPrefixes: [...MANAGED_KEY_PREFIXES], sizeBytes };
}

/**
 * The report `/host/storage/summary` serves: how many keys of `storage` start with `prefix`, and the
 * size of the storage when its backend knows it (`Storage.sizeBytes`; a backend that cannot says
 * `null`, never zero).
 */
export async function hostStorageSummary(
  storage: Storage,
  prefix: string,
): Promise<HostStorageSummary> {
  const [keyCount, sizeBytes] = await Promise.all([
    storageCount(storage, prefix),
    storage.sizeBytes?.() ?? Promise.resolve(null),
  ]);
  return { keyCount, sizeBytes };
}
