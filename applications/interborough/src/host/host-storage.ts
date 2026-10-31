/**
 * What the host tells the storage explorer about the keys the application manages. The browser
 * cannot import the Bureau (its entry point reaches the Node and Bun storage packages), so the host
 * reads `BUREAU_RESERVED_KEY_PREFIXES` and serves it at `/host/storage`; the Weft prefixes are
 * already public to the browser and are read there.
 */
import { BUREAU_RESERVED_KEY_PREFIXES } from '@lostgradient/bureau';

import type { HostStorage } from '../lib/host-storage.ts';

/** The report `/host/storage` serves: every key prefix the Bureau writes. */
export function hostStorageReport(): HostStorage {
  return { bureauKeyPrefixes: [...BUREAU_RESERVED_KEY_PREFIXES] };
}
