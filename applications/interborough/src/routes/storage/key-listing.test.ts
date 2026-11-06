/**
 * What the key table reads. "Starts with" is a prefix scan and "Range" a span of the key order, so
 * both are bounds the server applies; a page is one request, its cursor is the last key read, and a
 * reversed range is not a range at all.
 */
import { rejectionOf } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  countedPrefix,
  effectivePrefix,
  rangeProblem,
  SCAN_PAGE_SIZE,
  scanBounds,
  scanKeyPage,
  type KeyFilter,
} from './key-listing.ts';
import type { StorageConnection } from './storage-client.ts';
import { stubStorageFetch, type StubbedFetchCall } from './storage-fetch-stub.test-support.ts';

const connection: StorageConnection = { baseUrl: 'http://localhost:7233', headers: {} };

let stub: { calls: StubbedFetchCall[]; restore: () => void } | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

/** Answers a scan from an ordered list of keys, honoring the prefix, the bounds and `limit` as the engine does. */
function storeOf(keys: readonly string[]) {
  const ordered = [...keys].toSorted();
  return (call: StubbedFetchCall): Response => {
    const params = new URL(call.url).searchParams;
    const prefix = params.get('prefix') ?? '';
    const gt = params.get('gt');
    const gte = params.get('gte');
    const lt = params.get('lt');
    const limit = Number(params.get('limit') ?? '100');
    const rows = ordered
      .filter(
        (key) =>
          key.startsWith(prefix) &&
          (gt === null || key > gt) &&
          (gte === null || key >= gte) &&
          (lt === null || key < lt),
      )
      .slice(0, limit)
      .map((key) => JSON.stringify({ key, value: Buffer.from('v').toString('base64') }));
    return new Response(rows.length > 0 ? `${rows.join('\n')}\n` : '', {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  };
}

const numbered = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(5, '0')}`);

describe('effectivePrefix', () => {
  test('either one alone is the prefix', () => {
    expect(effectivePrefix('', '')).toBe('');
    expect(effectivePrefix('agent-session:', '')).toBe('agent-session:');
    expect(effectivePrefix('', 'audit:2026')).toBe('audit:2026');
  });

  test('text that extends the group, or a group that extends the text, reads the longer', () => {
    expect(effectivePrefix('audit:', 'audit:2026-11')).toBe('audit:2026-11');
    expect(effectivePrefix('audit:', 'aud')).toBe('audit:');
    expect(effectivePrefix('audit:', 'audit:')).toBe('audit:');
  });

  test('a group and text that part ways match no key', () => {
    expect(effectivePrefix('audit:', 'goal:')).toBeUndefined();
    expect(effectivePrefix('audit:', 'audio')).toBeUndefined();
  });
});

describe('rangeProblem', () => {
  test('an end that sorts before the start says so, in the words the End field shows', () => {
    expect(rangeProblem('audit:2026-11-02', 'audit:2026-11-01')).toBe(
      'The end comes before the start. Swap them, or pick a later end.',
    );
  });

  test('equal ends, ordered ends and an open end are fine', () => {
    expect(rangeProblem('audit:2026-11-01', 'audit:2026-11-01')).toBeUndefined();
    expect(rangeProblem('audit:2026-11-01', 'audit:2026-11-02')).toBeUndefined();
    expect(rangeProblem('', 'audit:2026-11-02')).toBeUndefined();
    expect(rangeProblem('audit:2026-11-01', '')).toBeUndefined();
    expect(rangeProblem('', '')).toBeUndefined();
  });
});

describe('scanBounds', () => {
  const prefix = (group: string, text: string): KeyFilter => ({ mode: 'prefix', group, text });
  const range = (group: string, start: string, end: string): KeyFilter => ({
    mode: 'range',
    group,
    start,
    end,
  });

  test('a prefix filter is the one prefix, and none when the two part ways', () => {
    expect(scanBounds(prefix('', ''))).toEqual({ prefix: '' });
    expect(scanBounds(prefix('audit:', 'audit:2026'))).toEqual({ prefix: 'audit:2026' });
    expect(scanBounds(prefix('audit:', 'goal:'))).toBeUndefined();
  });

  test('a range reads from its start up to just past every key that starts with its end', () => {
    // `audit:2026-11-02` is followed by `audit:2026-11-03`, so every key starting with the end is below it.
    expect(scanBounds(range('', 'audit:2026-11-01', 'audit:2026-11-02'))).toEqual({
      gte: 'audit:2026-11-01',
      lt: 'audit:2026-11-03',
    });
  });

  test('an open end leaves that side of the range open', () => {
    expect(scanBounds(range('', '', ''))).toEqual({});
    expect(scanBounds(range('', 'audit:', ''))).toEqual({ gte: 'audit:' });
    expect(scanBounds(range('', '', 'audit:2026-11-02'))).toEqual({ lt: 'audit:2026-11-03' });
  });

  test('a chosen group narrows the range to the group, whichever bound is tighter', () => {
    expect(scanBounds(range('goal:', 'audit:', 'zzz'))).toEqual({ gte: 'goal:', lt: 'goal;' });
    expect(scanBounds(range('audit:', 'audit:2026-11-01', 'audit:2026-11-02'))).toEqual({
      gte: 'audit:2026-11-01',
      lt: 'audit:2026-11-03',
    });
    expect(scanBounds(range('audit:', '', ''))).toEqual({ gte: 'audit:', lt: 'audit;' });
  });

  test('a reversed range has no bounds of its own', () => {
    expect(scanBounds(range('', 'audit:2026-11-02', 'audit:2026-11-01'))).toBeUndefined();
  });
});

describe('countedPrefix', () => {
  test('storage counts a prefix, and a range it cannot', () => {
    expect(countedPrefix({ mode: 'prefix', group: 'audit:', text: '' })).toBe('audit:');
    expect(countedPrefix({ mode: 'prefix', group: 'audit:', text: 'goal:' })).toBeUndefined();
    expect(countedPrefix({ mode: 'range', group: '', start: 'a', end: 'b' })).toBeUndefined();
  });
});

describe('scanKeyPage', () => {
  test('a page is one request, and its cursor is the last key when the page was full', async () => {
    stub = stubStorageFetch(storeOf(numbered('k:', SCAN_PAGE_SIZE + 20)));

    const page = await scanKeyPage(connection, { bounds: { prefix: '' }, after: undefined });

    expect(stub.calls.length).toBe(1);
    expect(page.entries.length).toBe(SCAN_PAGE_SIZE);
    expect(page.nextCursor).toBe(page.entries.at(-1)?.key);
  });

  test('continues from the cursor, under the prefix it was given, and ends on a short page', async () => {
    stub = stubStorageFetch(storeOf([...numbered('a:', 5), ...numbered('b:', 3)]));

    const page = await scanKeyPage(connection, { bounds: { prefix: 'a:' }, after: 'a:00002' });

    expect(page.entries.map((entry) => entry.key)).toEqual(['a:00003', 'a:00004']);
    expect(page.nextCursor).toBeUndefined();
    const url = new URL(stub.calls[0]?.url ?? '');
    expect(url.searchParams.get('prefix')).toBe('a:');
    expect(url.searchParams.get('gt')).toBe('a:00002');
  });

  test('a range starts at its first key, and a cursor takes the place of that lower bound', async () => {
    stub = stubStorageFetch(storeOf(['a', 'b', 'c', 'd', 'e']));
    const bounds = { gte: 'b', lt: 'e' };

    const first = await scanKeyPage(connection, { bounds, after: undefined });
    expect(first.entries.map((entry) => entry.key)).toEqual(['b', 'c', 'd']);
    const firstUrl = new URL(stub.calls[0]?.url ?? '');
    expect(firstUrl.searchParams.get('gte')).toBe('b');
    expect(firstUrl.searchParams.get('gt')).toBeNull();
    expect(firstUrl.searchParams.get('lt')).toBe('e');

    await scanKeyPage(connection, { bounds, after: 'c' });
    const nextUrl = new URL(stub.calls[1]?.url ?? '');
    expect(nextUrl.searchParams.get('gt')).toBe('c');
    expect(nextUrl.searchParams.get('gte')).toBeNull();
    expect(nextUrl.searchParams.get('lt')).toBe('e');
  });

  test('a filter that matches nothing reads nothing', async () => {
    stub = stubStorageFetch(storeOf(['a:one']));

    const page = await scanKeyPage(connection, { bounds: undefined, after: undefined });

    expect(page).toEqual({ entries: [], nextCursor: undefined });
    expect(stub.calls.length).toBe(0);
  });

  test('reads no more once the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('the view is gone'));
    stub = stubStorageFetch(storeOf(['a:one']));

    const outcome = await rejectionOf(
      scanKeyPage(connection, {
        bounds: { prefix: '' },
        after: undefined,
        signal: controller.signal,
      }),
    );

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('the view is gone');
    expect(stub.calls.length).toBe(0);
  });
});
