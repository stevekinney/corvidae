/**
 * The prefixes the Scan panel offers (COR-1658): the first segment of every key in storage that is
 * not under a Weft-reserved prefix, such as `agent-session:` or `bureau-goal:`. The engine and its
 * host keep their own keys here, and a person who scans without knowing what is stored has to guess
 * a prefix. Reserved keys are left out: they are the engine's, and a scan that wants one can type it.
 *
 * Storage is ordered, so the prefixes are found by skipping rather than by reading every key: read
 * one key, name its group, jump past the whole group, and read the next. The cost is one request per
 * group of keys, not per key, and `MAXIMUM_STEPS` bounds it for a store with more groups than that.
 * The walk takes an `AbortSignal`, so a view that unmounts stops it between reads.
 */
import { matchedReservedPrefix } from './reserved-prefix.ts';
import { storageScan, type StorageConnection, type StorageScanOptions } from './storage-client.ts';

/** The most requests one discovery makes, so a store of many groups costs a bounded number of reads. */
export const MAXIMUM_STEPS = 200;

/** The smallest key above every key that starts with `prefix`. */
function endOfGroup(prefix: string): string {
  const last = prefix.at(-1);
  if (last === undefined) return prefix;
  return `${prefix.slice(0, -1)}${String.fromCodePoint(last.codePointAt(0)! + 1)}`;
}

/** The group a key belongs to: its reserved prefix, else everything up to and including its first `:`. Keys with no `:` stand alone. */
function groupOf(key: string): { readonly prefix: string; readonly reserved: boolean } | undefined {
  const reserved = matchedReservedPrefix(key);
  if (reserved !== undefined) return { prefix: reserved, reserved: true };
  const colon = key.indexOf(':');
  return colon === -1 ? undefined : { prefix: key.slice(0, colon + 1), reserved: false };
}

/** The non-reserved prefixes in storage, in key order. */
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
    const group = groupOf(key);
    if (group === undefined) {
      // A key with no prefix stands alone: the next key is the one just after it.
      after = { gt: key };
      continue;
    }
    if (!group.reserved) found.push(group.prefix);
    after = { gte: endOfGroup(group.prefix) };
  }
  return found;
}
