/**
 * What the host knows about its storage. The Bureau's key prefixes are only known to the host (the
 * browser cannot import the Bureau), so the host serves them at `/host/storage`; the storage
 * explorer joins them with Weft's own (`WEFT_RESERVED_KEY_PREFIXES`) and refuses to edit or delete a
 * key under either. It also serves how much space the storage uses, which Settings › Data and
 * retention shows when no alert rule is watching it.
 */
import { z } from 'zod';

import type { Fetcher } from './bureau-client.ts';

/** The route the host answers with {@link HostStorage}. */
export const HOST_STORAGE_ROUTE = '/host/storage';

const hostStorageSchema = z.object({
  /** Every storage key prefix the Bureau writes. A key that starts with one is the application's. */
  bureauKeyPrefixes: z.array(z.string().min(1)),
  /** The bytes the storage holds now, or `null` when the backend cannot say. */
  sizeBytes: z.number().nonnegative().nullable(),
});

/** The key prefixes the host reports as the Bureau's, and the size of its storage. */
export type HostStorage = z.infer<typeof hostStorageSchema>;

/** Asks the host which key prefixes the Bureau writes and how large its storage is. */
export async function getHostStorage(options?: {
  readonly signal?: AbortSignal;
  readonly fetch?: Fetcher;
}): Promise<HostStorage> {
  const send = options?.fetch ?? fetch;
  const response = await send(
    HOST_STORAGE_ROUTE,
    options?.signal === undefined ? undefined : { signal: options.signal },
  );
  if (!response.ok) throw new Error(`The host answered ${response.status}.`);
  return hostStorageSchema.parse(await response.json());
}
