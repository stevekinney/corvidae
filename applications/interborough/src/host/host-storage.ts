/**
 * What the host tells the storage explorer about the keys the application manages. The browser
 * cannot import the Bureau (its entry point reaches the Node and Bun storage packages), so the host
 * reads `BUREAU_RESERVED_KEY_PREFIXES` and serves it at `/host/storage`, together with the families
 * the Bureau shares with the engine and the session store (`SHARED_KEY_FAMILIES_OF_A_CHAT`:
 * `agent-session`, `durable-run:`, `weft:`, the governed-memory keys); the Weft prefixes are already
 * public to the browser and are read there.
 */
import { BUREAU_RESERVED_KEY_PREFIXES, SHARED_KEY_FAMILIES_OF_A_CHAT } from '@lostgradient/bureau';

import type { HostStorage } from '../lib/host-storage.ts';

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

/** The report `/host/storage` serves: every key prefix the Bureau and the stores it shares write. */
export function hostStorageReport(): HostStorage {
  return { bureauKeyPrefixes: [...MANAGED_KEY_PREFIXES] };
}
