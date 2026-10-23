/**
 * Prefix discovery over an ordered store: one read per group of keys, reserved keys left out, and a
 * bound on the number of reads.
 */
import { rejectionOf } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';

import { discoverPrefixes } from './prefix-discovery.ts';
import type { StorageConnection } from './storage-client.ts';
import { stubStorageFetch, type StubbedFetchCall } from './storage-fetch-stub.test-support.ts';

const connection: StorageConnection = { baseUrl: 'http://localhost:7233', headers: {} };

let stub: { calls: StubbedFetchCall[]; restore: () => void } | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

/** Answers a scan from an ordered list of keys, honoring `gt`, `gte`, and `limit` as the engine does. */
function storeOf(keys: readonly string[]) {
  const ordered = [...keys].toSorted();
  return (call: StubbedFetchCall): Response => {
    const params = new URL(call.url).searchParams;
    const gt = params.get('gt');
    const gte = params.get('gte');
    const limit = Number(params.get('limit') ?? '100');
    const rows = ordered
      .filter((key) => (gt === null || key > gt) && (gte === null || key >= gte))
      .slice(0, limit)
      .map((key) => JSON.stringify({ key, value: Buffer.from('v').toString('base64') }));
    return new Response(rows.length > 0 ? `${rows.join('\n')}\n` : '', {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  };
}

describe('discoverPrefixes', () => {
  test('names each group of non-reserved keys once, and leaves the reserved ones out', async () => {
    stub = stubStorageFetch(
      storeOf([
        'agent-session:a',
        'agent-session:b',
        'agent-session:c',
        'bureau-goal:g1',
        'wf:one',
        'wf:two',
        'memory:m1',
        'zeta:z',
      ]),
    );

    expect(await discoverPrefixes(connection)).toEqual([
      'agent-session:',
      'bureau-goal:',
      'memory:',
      'zeta:',
    ]);
  });

  test('reads one key per group, not one per key', async () => {
    stub = stubStorageFetch(
      storeOf([...Array.from({ length: 50 }, (_, index) => `agent-session:${index}`), 'wf:one']),
    );

    await discoverPrefixes(connection);

    // The group of fifty, the reserved group, and the read that finds nothing after it.
    expect(stub.calls.length).toBe(3);
  });

  test('looks past a reserved prefix that shares its first segment with a prefix that is not', async () => {
    // `audit:bulk:` is reserved and `audit:` is not, so the reserved keys come first and must not hide it.
    stub = stubStorageFetch(storeOf(['audit:bulk:1', 'audit:bulk:2', 'audit:record-1']));

    expect(await discoverPrefixes(connection)).toEqual(['audit:']);
  });

  test('steps over a key with no prefix, which is no group of its own', async () => {
    stub = stubStorageFetch(storeOf(['alpha:1', 'lonely-key', 'omega:1']));

    expect(await discoverPrefixes(connection)).toEqual(['alpha:', 'omega:']);
  });

  test('is empty for an empty store, and stops at the bound for a store of more groups than it reads', async () => {
    stub = stubStorageFetch(storeOf([]));
    expect(await discoverPrefixes(connection)).toEqual([]);
    stub.restore();

    stub = stubStorageFetch(storeOf(['a:1', 'b:1', 'c:1', 'd:1']));
    expect(await discoverPrefixes(connection, { maximumSteps: 2 })).toEqual(['a:', 'b:']);
    expect(stub.calls.length).toBe(2);
  });

  test('says a failed read, and does not guess at the prefixes', async () => {
    stub = stubStorageFetch(
      () =>
        new Response(JSON.stringify({ error: 'Raw storage access requires storage:admin.' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    expect(await rejectionOf(discoverPrefixes(connection))).toBeInstanceOf(Error);
  });
});
