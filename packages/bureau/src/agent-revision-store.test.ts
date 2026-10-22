/**
 * COR-1584 — the persisted revision of a file agent: one conditional record per identifier,
 * `bureau-agent-revision:v1:<identifier>` = `{ revision, hash }`, raised whenever the file's
 * content hash differs from the stored one.
 */
import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
  type TextValueStoreBatchOperation,
  type TextValueStoreCondition,
} from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { AGENT_REVISION_KEY_PREFIX, createAgentRevisionStore } from './agent-revision-store';
import { rejectionOf } from './testing/promise-outcome.test-support';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_1 = '1'.repeat(64);
const HASH_2 = '2'.repeat(64);
const HASH_3 = '3'.repeat(64);

function memoryStore(): ConditionalTextValueStore {
  return textValueStore(new MemoryStorage());
}

/** A store whose first `held` reads of `key` wait until all of them have been issued. */
function barrierStore(
  inner: ConditionalTextValueStore,
  key: string,
  held: number,
): ConditionalTextValueStore {
  let arrived = 0;
  const release = Promise.withResolvers<void>();
  return {
    ...inner,
    async get(requested) {
      const value = await inner.get(requested);
      if (requested === key && arrived < held) {
        arrived += 1;
        if (arrived === held) release.resolve();
        await release.promise;
      }
      return value;
    },
    conditionalBatch: (
      conditions: TextValueStoreCondition[],
      operations: TextValueStoreBatchOperation[],
    ) => inner.conditionalBatch(conditions, operations),
  };
}

describe('the persisted revision of a file agent', () => {
  it('keeps one record per identifier under bureau-agent-revision:v1:<identifier>', async () => {
    const store = memoryStore();
    const revisions = createAgentRevisionStore({ store });
    await revisions.advance('researcher', HASH_A);
    expect(AGENT_REVISION_KEY_PREFIX).toBe('bureau-agent-revision:v1:');
    expect(await store.list(AGENT_REVISION_KEY_PREFIX)).toEqual([
      'bureau-agent-revision:v1:researcher',
    ]);
    expect(JSON.parse((await store.get('bureau-agent-revision:v1:researcher')) ?? 'null')).toEqual({
      revision: 1,
      hash: HASH_A,
    });
  });

  it('reads a store with no record as a first sighting: revision 1, written conditionally on absence', async () => {
    const store = memoryStore();
    const revisions = createAgentRevisionStore({ store });
    expect(await revisions.read('researcher')).toBeUndefined();
    expect(await revisions.advance('researcher', HASH_A)).toEqual({
      revision: 1,
      hash: HASH_A,
    });
    expect(await revisions.read('researcher')).toEqual({ revision: 1, hash: HASH_A });
  });

  it('raises the revision when the hash differs, and not when it is the same', async () => {
    const store = memoryStore();
    const revisions = createAgentRevisionStore({ store });
    await revisions.advance('researcher', HASH_A);
    expect(await revisions.advance('researcher', HASH_B)).toEqual({
      revision: 2,
      hash: HASH_B,
    });
    expect(await revisions.advance('researcher', HASH_B)).toEqual({
      revision: 2,
      hash: HASH_B,
    });
  });

  it('raises the revision when the content returns to an earlier hash', async () => {
    const revisions = createAgentRevisionStore({ store: memoryStore() });
    await revisions.advance('researcher', HASH_A);
    await revisions.advance('researcher', HASH_B);
    expect(await revisions.advance('researcher', HASH_A)).toEqual({
      revision: 3,
      hash: HASH_A,
    });
  });

  it('does not write when the stored hash already matches', async () => {
    const inner = memoryStore();
    const revisions = createAgentRevisionStore({ store: inner });
    await revisions.advance('researcher', HASH_A);
    let writes = 0;
    const counting: ConditionalTextValueStore = {
      ...inner,
      conditionalBatch: (conditions, operations) => {
        writes += 1;
        return inner.conditionalBatch(conditions, operations);
      },
    };
    await createAgentRevisionStore({ store: counting }).advance('researcher', HASH_A);
    expect(writes).toBe(0);
  });

  it('keeps each identifier’s record apart', async () => {
    const revisions = createAgentRevisionStore({ store: memoryStore() });
    await revisions.advance('alpha', HASH_A);
    await revisions.advance('alpha', HASH_B);
    expect(await revisions.advance('bravo', HASH_A)).toEqual({ revision: 1, hash: HASH_A });
  });

  it('is conditional on the record it read: a writer that lost the race reads again and raises from the winner', async () => {
    const inner = memoryStore();
    await createAgentRevisionStore({ store: inner }).advance('researcher', HASH_1);
    const racing = barrierStore(inner, 'bureau-agent-revision:v1:researcher', 2);
    const first = createAgentRevisionStore({ store: racing });
    const second = createAgentRevisionStore({ store: racing });
    // Both read { 1, hash-1 } before either writes, and they hold different hashes.
    const [winner, loser] = await Promise.all([
      first.advance('researcher', HASH_2),
      second.advance('researcher', HASH_3),
    ]);
    expect(winner).toEqual({ revision: 2, hash: HASH_2 });
    expect(loser).toEqual({ revision: 3, hash: HASH_3 });
    expect(await createAgentRevisionStore({ store: inner }).read('researcher')).toEqual({
      revision: 3,
      hash: HASH_3,
    });
  });

  it('gives two writers of the same new hash one increment and the same revision', async () => {
    const inner = memoryStore();
    await createAgentRevisionStore({ store: inner }).advance('researcher', HASH_1);
    const racing = barrierStore(inner, 'bureau-agent-revision:v1:researcher', 2);
    const [left, right] = await Promise.all([
      createAgentRevisionStore({ store: racing }).advance('researcher', HASH_2),
      createAgentRevisionStore({ store: racing }).advance('researcher', HASH_2),
    ]);
    expect(left).toEqual({ revision: 2, hash: HASH_2 });
    expect(right).toEqual({ revision: 2, hash: HASH_2 });
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a record with no hash', JSON.stringify({ revision: 2 })],
    ['a record with a zero revision', JSON.stringify({ revision: 0, hash: 'h' })],
    ['a record with a fractional revision', JSON.stringify({ revision: 1.5, hash: 'h' })],
    ['a record with a negative revision', JSON.stringify({ revision: -1, hash: 'h' })],
    ['a record with an empty hash', JSON.stringify({ revision: 1, hash: '' })],
    ['a JSON array', '[]'],
    [
      'a record with a hash that is not a SHA-256 in lowercase hex',
      JSON.stringify({ revision: 1, hash: 'hash-a' }),
    ],
    ['a record with an uppercase hash', JSON.stringify({ revision: 1, hash: 'A'.repeat(64) })],
  ])('refuses to read or advance %s, and leaves it as it was', async (_name, stored) => {
    const store = memoryStore();
    await store.set('bureau-agent-revision:v1:researcher', stored);
    const revisions = createAgentRevisionStore({ store });
    // Reading it as absent would write revision 1 over it, which is going backwards.
    expect(String(await rejectionOf(revisions.read('researcher')))).toMatch(/researcher/u);
    expect(String(await rejectionOf(revisions.advance('researcher', HASH_A)))).toMatch(
      /researcher/u,
    );
    expect(await store.get('bureau-agent-revision:v1:researcher')).toBe(stored);
  });

  it('refuses to advance for a hash that is not a SHA-256 in lowercase hex, and writes nothing', async () => {
    const store = memoryStore();
    const revisions = createAgentRevisionStore({ store });
    expect(String(await rejectionOf(revisions.advance('researcher', 'not-a-hash')))).toMatch(
      /researcher/u,
    );
    expect(await store.list(AGENT_REVISION_KEY_PREFIX)).toEqual([]);
  });

  it('rejects when the store cannot be read or written', async () => {
    const inner = memoryStore();
    const unreadable: ConditionalTextValueStore = {
      ...inner,
      get: () => Promise.reject(new Error('disk gone')),
    };
    expect(
      String(
        await rejectionOf(
          createAgentRevisionStore({ store: unreadable }).advance('researcher', HASH_A),
        ),
      ),
    ).toContain('disk gone');
    const unwritable: ConditionalTextValueStore = {
      ...inner,
      conditionalBatch: () => Promise.reject(new Error('read only')),
    };
    expect(
      String(
        await rejectionOf(
          createAgentRevisionStore({ store: unwritable }).advance('researcher', HASH_A),
        ),
      ),
    ).toContain('read only');
  });
});
