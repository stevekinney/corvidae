/**
 * One page of the explorer's key table. Storage can only be read in key order, from a prefix, so
 * the explorer pages by the cursor a scan hands back (`gt=<last key>`). A search over keys has no
 * server side, so it reads on: a request that finds fewer matches than a page holds asks for the
 * next one, up to `MAXIMUM_REQUESTS`, and hands back the cursor it stopped at, so Load more picks up
 * where the search left off and a store with no match costs a bounded number of reads.
 */
import { storageScan, type StorageConnection, type StorageScanEntry } from './storage-client.ts';

/** How many keys one request to storage asks for. */
export const SCAN_PAGE_SIZE = 100;

/** How many matches a page of search results aims for before it stops reading. */
export const SEARCH_PAGE_TARGET = 50;

/** The most requests one page of results makes while it looks for matches. */
export const MAXIMUM_REQUESTS = 10;

/** One page of keys: the matches, the cursor to continue from (none on the last), and how many keys were read. */
export interface KeyPage {
  readonly entries: readonly StorageScanEntry[];
  readonly nextCursor: string | undefined;
  readonly scanned: number;
}

/** What to read: the group's prefix, the text a key must contain, and where to start. */
export interface KeyPageRequest {
  readonly prefix: string;
  readonly search: string;
  readonly after: string | undefined;
  readonly signal?: AbortSignal;
}

/** Whether `key` holds `search`, ignoring case. An empty search matches every key. */
export function keyMatches(key: string, search: string): boolean {
  return search === '' || key.toLowerCase().includes(search.toLowerCase());
}

/** Reads the next page of keys under `prefix` that contain `search`. */
export async function scanKeyPage(
  connection: StorageConnection,
  request: KeyPageRequest,
): Promise<KeyPage> {
  const search = request.search.trim();
  const entries: StorageScanEntry[] = [];
  let cursor = request.after;
  let scanned = 0;
  for (let requests = 0; requests < MAXIMUM_REQUESTS; requests += 1) {
    request.signal?.throwIfAborted();
    const page = await storageScan(
      connection,
      {
        prefix: request.prefix,
        limit: SCAN_PAGE_SIZE,
        ...(cursor === undefined ? {} : { gt: cursor }),
      },
      request.signal,
    );
    scanned += page.entries.length;
    entries.push(...page.entries.filter((entry) => keyMatches(entry.key, search)));
    cursor = page.nextCursor;
    // Without a search a page is a request; with one, read on until a page's worth has matched.
    if (cursor === undefined || search === '' || entries.length >= SEARCH_PAGE_TARGET) break;
  }
  return { entries, nextCursor: cursor, scanned };
}
