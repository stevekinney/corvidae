/**
 * What the explorer's key table reads, and one page of it. Storage can only be read in key order,
 * so both ways of narrowing the table are a range of that order, which the server does the work of:
 *
 * - **Starts with** is a prefix scan. The typed text and the chosen group are both prefixes of the
 *   key, so a key must start with each: the longer one wins when one extends the other, and two
 *   prefixes that part ways match no key (`effectivePrefix`).
 * - **Range** reads from a first key to a last, both included, so every key that starts with the
 *   last one is in it (`audit:2026-11-02` includes `audit:2026-11-02T16:33:08Z`). A chosen group
 *   narrows the range to the group's keys. A last key that sorts before the first is no range at
 *   all (`rangeProblem`).
 *
 * The table pages by the cursor a scan hands back (`gt=<last key>`), so scrolling to the end reads
 * on from the last key read.
 */
import { endOfGroup } from './prefix-discovery.ts';
import { storageScan, type StorageConnection, type StorageScanEntry } from './storage-client.ts';

/** How many keys one request to storage asks for. */
export const SCAN_PAGE_SIZE = 100;

/** What the table lists: the keys that start with some text, or the keys from one key to another. */
export type KeyFilter =
  | {
      readonly mode: 'prefix';
      /** The chosen group's prefix, or empty for every group. */
      readonly group: string;
      /** The text a key starts with, or empty for any. */
      readonly text: string;
    }
  | {
      readonly mode: 'range';
      /** The chosen group's prefix, or empty for every group. */
      readonly group: string;
      /** The first key, included, or empty for the first key in storage. */
      readonly start: string;
      /** The last key, included along with every key that starts with it, or empty for no end. */
      readonly end: string;
    };

/** The server's bounds for a filter, as `storageScan` takes them. */
export interface ScanBounds {
  readonly prefix?: string;
  readonly gte?: string;
  readonly lt?: string;
}

/**
 * The one prefix a key must start with to start with both `group` and `text`, or `undefined` when
 * no key can: the two disagree about how a key begins.
 */
export function effectivePrefix(group: string, text: string): string | undefined {
  if (text === '') return group;
  if (group === '') return text;
  if (text.startsWith(group)) return text;
  if (group.startsWith(text)) return group;
  return undefined;
}

/** The larger of two keys, in the order storage keeps them. */
const later = (first: string, second: string): string => (first >= second ? first : second);

/** The smaller of two keys, in the order storage keeps them. */
const earlier = (first: string, second: string): string => (first <= second ? first : second);

/**
 * Why a range is not one: its last key sorts before its first. The text is what the End field says
 * under it; `undefined` for a range that is fine, including one with either end open.
 */
export function rangeProblem(start: string, end: string): string | undefined {
  return start !== '' && end !== '' && end < start
    ? 'The end comes before the start. Swap them, or pick a later end.'
    : undefined;
}

/**
 * The bounds to ask storage for, or `undefined` when the filter matches nothing at all (a typed
 * prefix and a group that part ways, or a range whose ends are reversed, which has no result of its
 * own to read).
 */
export function scanBounds(filter: KeyFilter): ScanBounds | undefined {
  if (filter.mode === 'prefix') {
    const prefix = effectivePrefix(filter.group, filter.text);
    return prefix === undefined ? undefined : { prefix };
  }
  if (rangeProblem(filter.start, filter.end) !== undefined) return undefined;
  const from = later(filter.start, filter.group);
  const groupEnd = filter.group === '' ? undefined : endOfGroup(filter.group);
  const rangeEnd = filter.end === '' ? undefined : endOfGroup(filter.end);
  const until =
    groupEnd === undefined
      ? rangeEnd
      : rangeEnd === undefined
        ? groupEnd
        : earlier(groupEnd, rangeEnd);
  return {
    ...(from === '' ? {} : { gte: from }),
    ...(until === undefined ? {} : { lt: until }),
  };
}

/** The prefix whose keys a filter counts, when storage can count them: not a range. */
export function countedPrefix(filter: KeyFilter): string | undefined {
  return filter.mode === 'prefix' ? effectivePrefix(filter.group, filter.text) : undefined;
}

/** One page of keys: the keys, and the cursor to continue from (none on the last page). */
export interface KeyPage {
  readonly entries: readonly StorageScanEntry[];
  readonly nextCursor: string | undefined;
}

/** What to read: the bounds, and where to start after them. */
export interface KeyPageRequest {
  readonly bounds: ScanBounds | undefined;
  readonly after: string | undefined;
  readonly signal?: AbortSignal;
}

/** Reads the next page of the keys in `request.bounds`, none at all when the filter matches nothing. */
export async function scanKeyPage(
  connection: StorageConnection,
  request: KeyPageRequest,
): Promise<KeyPage> {
  const { bounds, after, signal } = request;
  if (bounds === undefined) return { entries: [], nextCursor: undefined };
  request.signal?.throwIfAborted();
  // A cursor replaces the lower bound: the next page starts just after the last key read.
  const { gte, ...rest } = bounds;
  return storageScan(
    connection,
    {
      ...rest,
      ...(after === undefined ? (gte === undefined ? {} : { gte }) : { gt: after }),
      limit: SCAN_PAGE_SIZE,
    },
    signal,
  );
}
