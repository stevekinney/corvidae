/**
 * A page of the key table: one request when there is no search, reads on while a search has found
 * too few, hands back the cursor it stopped at, and stops at the bound.
 */
import { rejectionOf } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  keyMatches,
  MAXIMUM_REQUESTS,
  SCAN_PAGE_SIZE,
  scanKeyPage,
  SEARCH_PAGE_TARGET,
} from './key-listing.ts';
import type { StorageConnection } from './storage-client.ts';
import { stubStorageFetch, type StubbedFetchCall } from './storage-fetch-stub.test-support.ts';

const connection: StorageConnection = { baseUrl: 'http://localhost:7233', headers: {} };

let stub: { calls: StubbedFetchCall[]; restore: () => void } | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

/** Answers a scan from an ordered list of keys, honoring `prefix`, `gt` and `limit` as the engine does. */
function storeOf(keys: readonly string[]) {
  const ordered = [...keys].toSorted();
  return (call: StubbedFetchCall): Response => {
    const params = new URL(call.url).searchParams;
    const prefix = params.get('prefix') ?? '';
    const gt = params.get('gt');
    const limit = Number(params.get('limit') ?? '100');
    const rows = ordered
      .filter((key) => key.startsWith(prefix) && (gt === null || key > gt))
      .slice(0, limit)
      .map((key) => JSON.stringify({ key, value: Buffer.from('v').toString('base64') }));
    return new Response(rows.length > 0 ? `${rows.join('\n')}\n` : '', {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  };
}

const numbered = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(5, '0')}`);

describe('keyMatches', () => {
  test('an empty search matches every key, and a search ignores case', () => {
    expect(keyMatches('Agent-Session:A', '')).toBe(true);
    expect(keyMatches('Agent-Session:A', 'session')).toBe(true);
    expect(keyMatches('Agent-Session:A', 'goal')).toBe(false);
  });
});

describe('scanKeyPage', () => {
  test('without a search, a page is one request, and its cursor is the last key when the page was full', async () => {
    stub = stubStorageFetch(storeOf(numbered('k:', SCAN_PAGE_SIZE + 20)));

    const page = await scanKeyPage(connection, { prefix: '', search: '', after: undefined });

    expect(stub.calls.length).toBe(1);
    expect(page.entries.length).toBe(SCAN_PAGE_SIZE);
    expect(page.nextCursor).toBe(page.entries.at(-1)?.key);
    expect(page.scanned).toBe(SCAN_PAGE_SIZE);
  });

  test('continues from the cursor, under the group it was given, and ends on a short page', async () => {
    stub = stubStorageFetch(storeOf([...numbered('a:', 5), ...numbered('b:', 3)]));

    const page = await scanKeyPage(connection, { prefix: 'a:', search: '', after: 'a:00002' });

    expect(page.entries.map((entry) => entry.key)).toEqual(['a:00003', 'a:00004']);
    expect(page.nextCursor).toBeUndefined();
    const url = new URL(stub.calls[0]?.url ?? '');
    expect(url.searchParams.get('prefix')).toBe('a:');
    expect(url.searchParams.get('gt')).toBe('a:00002');
  });

  test('a search reads on until a page of matches, then hands back where it stopped', async () => {
    // Every tenth key matches, so one request finds ten and the search must read on to a page of matches.
    const keys = numbered('k:', 2_000).map((key, index) => (index % 10 === 0 ? `${key}-hit` : key));
    stub = stubStorageFetch(storeOf(keys));

    const page = await scanKeyPage(connection, { prefix: '', search: 'HIT', after: undefined });

    expect(page.entries.length).toBeGreaterThanOrEqual(SEARCH_PAGE_TARGET);
    expect(page.entries.every((entry) => entry.key.endsWith('-hit'))).toBe(true);
    expect(stub.calls.length).toBeGreaterThan(1);
    expect(page.nextCursor).toBeDefined();
    expect(page.scanned).toBe(stub.calls.length * SCAN_PAGE_SIZE);
  });

  test('a search with no match stops at the bound and says how far it read', async () => {
    stub = stubStorageFetch(storeOf(numbered('k:', SCAN_PAGE_SIZE * (MAXIMUM_REQUESTS + 5))));

    const page = await scanKeyPage(connection, { prefix: '', search: 'nothing', after: undefined });

    expect(page.entries).toEqual([]);
    expect(stub.calls.length).toBe(MAXIMUM_REQUESTS);
    expect(page.scanned).toBe(SCAN_PAGE_SIZE * MAXIMUM_REQUESTS);
    expect(page.nextCursor).toBeDefined();
  });

  test('a search over a short store ends with no cursor', async () => {
    stub = stubStorageFetch(storeOf(['a:one', 'a:two', 'b:one']));

    const page = await scanKeyPage(connection, { prefix: '', search: 'one', after: undefined });

    expect(page.entries.map((entry) => entry.key)).toEqual(['a:one', 'b:one']);
    expect(page.nextCursor).toBeUndefined();
  });

  test('reads no more once the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('the view is gone'));
    stub = stubStorageFetch(storeOf(['a:one']));

    const outcome = await rejectionOf(
      scanKeyPage(connection, {
        prefix: '',
        search: '',
        after: undefined,
        signal: controller.signal,
      }),
    );

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('the view is gone');
    expect(stub.calls.length).toBe(0);
  });
});
