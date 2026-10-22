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
    await revisions.advance('researcher', 'hash-a');
    expect(AGENT_REVISION_KEY_PREFIX).toBe('bureau-agent-revision:v1:');
    expect(await store.list(AGENT_REVISION_KEY_PREFIX)).toEqual([
      'bureau-agent-revision:v1:researcher',
    ]);
    expect(JSON.parse((await store.get('bureau-agent-revision:v1:researcher')) ?? 'null')).toEqual({
      revision: 1,
      hash: 'hash-a',
    });
  });

  it('reads a store with no record as a first sighting: revision 1, written conditionally on absence', async () => {
    const store = memoryStore();
    const revisions = createAgentRevisionStore({ store });
    expect(await revisions.read('researcher')).toBeUndefined();
    expect(await revisions.advance('researcher', 'hash-a')).toEqual({
      revision: 1,
      hash: 'hash-a',
    });
    expect(await revisions.read('researcher')).toEqual({ revision: 1, hash: 'hash-a' });
  });

  it('raises the revision when the hash differs, and not when it is the same', async () => {
    const store = memoryStore();
    const revisions = createAgentRevisionStore({ store });
    await revisions.advance('researcher', 'hash-a');
    expect(await revisions.advance('researcher', 'hash-b')).toEqual({
      revision: 2,
      hash: 'hash-b',
    });
    expect(await revisions.advance('researcher', 'hash-b')).toEqual({
      revision: 2,
      hash: 'hash-b',
    });
  });

  it('raises the revision when the content returns to an earlier hash', async () => {
    const revisions = createAgentRevisionStore({ store: memoryStore() });
    await revisions.advance('researcher', 'hash-a');
    await revisions.advance('researcher', 'hash-b');
    expect(await revisions.advance('researcher', 'hash-a')).toEqual({
      revision: 3,
      hash: 'hash-a',
    });
  });

  it('does not write when the stored hash already matches', async () => {
    const inner = memoryStore();
    const revisions = createAgentRevisionStore({ store: inner });
    await revisions.advance('researcher', 'hash-a');
    let writes = 0;
    const counting: ConditionalTextValueStore = {
      ...inner,
      conditionalBatch: (conditions, operations) => {
        writes += 1;
        return inner.conditionalBatch(conditions, operations);
      },
    };
    await createAgentRevisionStore({ store: counting }).advance('researcher', 'hash-a');
    expect(writes).toBe(0);
  });

  it('keeps each identifier’s record apart', async () => {
    const revisions = createAgentRevisionStore({ store: memoryStore() });
    await revisions.advance('alpha', 'hash-a');
    await revisions.advance('alpha', 'hash-b');
    expect(await revisions.advance('bravo', 'hash-a')).toEqual({ revision: 1, hash: 'hash-a' });
  });

  it('is conditional on the record it read: a writer that lost the race reads again and raises from the winner', async () => {
    const inner = memoryStore();
    await createAgentRevisionStore({ store: inner }).advance('researcher', 'hash-1');
    const racing = barrierStore(inner, 'bureau-agent-revision:v1:researcher', 2);
    const first = createAgentRevisionStore({ store: racing });
    const second = createAgentRevisionStore({ store: racing });
    // Both read { 1, hash-1 } before either writes, and they hold different hashes.
    const [winner, loser] = await Promise.all([
      first.advance('researcher', 'hash-2'),
      second.advance('researcher', 'hash-3'),
    ]);
    expect(winner).toEqual({ revision: 2, hash: 'hash-2' });
    expect(loser).toEqual({ revision: 3, hash: 'hash-3' });
    expect(await createAgentRevisionStore({ store: inner }).read('researcher')).toEqual({
      revision: 3,
      hash: 'hash-3',
    });
  });

  it('gives two writers of the same new hash one increment and the same revision', async () => {
    const inner = memoryStore();
    await createAgentRevisionStore({ store: inner }).advance('researcher', 'hash-1');
    const racing = barrierStore(inner, 'bureau-agent-revision:v1:researcher', 2);
    const [left, right] = await Promise.all([
      createAgentRevisionStore({ store: racing }).advance('researcher', 'hash-2'),
      createAgentRevisionStore({ store: racing }).advance('researcher', 'hash-2'),
    ]);
    expect(left).toEqual({ revision: 2, hash: 'hash-2' });
    expect(right).toEqual({ revision: 2, hash: 'hash-2' });
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a record with no hash', JSON.stringify({ revision: 2 })],
    ['a record with a zero revision', JSON.stringify({ revision: 0, hash: 'h' })],
    ['a record with a fractional revision', JSON.stringify({ revision: 1.5, hash: 'h' })],
    ['a record with a negative revision', JSON.stringify({ revision: -1, hash: 'h' })],
    ['a record with an empty hash', JSON.stringify({ revision: 1, hash: '' })],
    ['a JSON array', '[]'],
  ])('refuses to read or advance %s, and leaves it as it was', async (_name, stored) => {
    const store = memoryStore();
    await store.set('bureau-agent-revision:v1:researcher', stored);
    const revisions = createAgentRevisionStore({ store });
    // Reading it as absent would write revision 1 over it, which is going backwards.
    expect(String(await rejectionOf(revisions.read('researcher')))).toMatch(/researcher/u);
    expect(String(await rejectionOf(revisions.advance('researcher', 'hash-a')))).toMatch(
      /researcher/u,
    );
    expect(await store.get('bureau-agent-revision:v1:researcher')).toBe(stored);
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
          createAgentRevisionStore({ store: unreadable }).advance('researcher', 'a'),
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
          createAgentRevisionStore({ store: unwritable }).advance('researcher', 'a'),
        ),
      ),
    ).toContain('read only');
  });
});
