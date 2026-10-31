/**
 * The groups the explorer's Group select offers: the first segment of every key in storage, such as
 * `agent-session:` or `bureau-goal:`, with each Weft-reserved prefix as one group. The engine and its
 * host keep their own keys here, and a person who looks without knowing what is stored has to guess
 * a prefix. A group is a place to look, so a managed one is listed too; whether its keys can be
 * changed is the key's to say (`reserved-prefix.ts`).
 *
 * Storage is ordered, so the prefixes are found by skipping rather than by reading every key: read
 * one key, name its group, jump past the whole group, and read the next. The cost is one request per
 * group of keys, not per key, and `MAXIMUM_STEPS` bounds it for a store with more groups than that.
 * The walk takes an `AbortSignal`, so a view that unmounts stops it between reads.
 */
import { WEFT_RESERVED_KEY_PREFIXES } from './reserved-prefix.ts';
import { storageScan, type StorageConnection, type StorageScanOptions } from './storage-client.ts';

/** The most requests one discovery makes, so a store of many groups costs a bounded number of reads. */
export const MAXIMUM_STEPS = 200;

/** The smallest key above every key that starts with `prefix`. */
function endOfGroup(prefix: string): string {
  const last = prefix.at(-1);
  if (last === undefined) return prefix;
  return `${prefix.slice(0, -1)}${String.fromCodePoint(last.codePointAt(0)! + 1)}`;
}

/**
 * The group a key belongs to: its Weft-reserved prefix, else everything up to and including its
 * first `:`. A key with no `:` and no reserved prefix stands alone, in no group.
 */
export function keyGroup(key: string): string | undefined {
  const reserved = WEFT_RESERVED_KEY_PREFIXES.find((prefix) => key.startsWith(prefix));
  if (reserved !== undefined) return reserved;
  const colon = key.indexOf(':');
  return colon === -1 ? undefined : key.slice(0, colon + 1);
}

/** The groups in storage, in key order. */
export async function discoverPrefixes(
  connection: StorageConnection,
  options: { readonly maximumSteps?: number; readonly signal?: AbortSignal } = {},
): Promise<string[]> {
  const found: string[] = [];
  let after: Pick<StorageScanOptions, 'gt' | 'gte'> = {};
  for (let step = 0; step < (options.maximumSteps ?? MAXIMUM_STEPS); step += 1) {
    // An aborted signal ends the walk before its next read, and a read in flight is cancelled by the
    // signal itself, so a view that has gone reads no more.
    options.signal?.throwIfAborted();
    const page = await storageScan(connection, { limit: 1, ...after }, options.signal);
    const key = page.entries[0]?.key;
    if (key === undefined) break;
    const group = keyGroup(key);
    if (group === undefined) {
      // A key with no prefix stands alone: the next key is the one just after it.
      after = { gt: key };
      continue;
    }
    found.push(group);
    after = { gte: endOfGroup(group) };
  }
  return found;
}
