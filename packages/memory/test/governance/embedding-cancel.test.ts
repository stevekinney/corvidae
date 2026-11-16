/**
 * COR-2188 — cancelling the embedding switch is a state transition with races, so each state the
 * switch can be in is crossed with each event that can arrive in it.
 *
 * The fence on the write that records the cancellation: it is one compare-and-swap of the switch
 * record from the `running` record exactly as read (its progress counts included) to the same
 * record `cancelled`. A step that moves the record's progress first makes the swap miss, and the
 * cancel reads the record again while it still is `running` for the same target. A completion,
 * which swaps the same record away, and a second cancel, which swaps it to `cancelled`, make it
 * miss for good, and the cancel then reports `false`. The profile is deleted after the swap, never
 * before it, and the active profile is in none of the cancel's writes, so it is never touched.
 *
 * | State                          | Event                                    | Required result |
 * | ------------------------------ | ---------------------------------------- | --------------- |
 * | none                           | cancel                                   | `false`; nothing stored; recall unchanged |
 * | running, between steps         | cancel                                   | `true`; `cancelled` with its progress; the target and everything it held are gone; every record still has its vector in the source; recall is by the source; an advance after does nothing |
 * | running, a step embedding      | cancel, then the embed answers           | `true`; the step finds its profile gone and leaves the record `cancelled`, never `failed`; nothing of the target is left |
 * | running, completion about to swap | cancel arrives first                  | the cancel wins: `true`, the source stays active, the completion does not take effect |
 * | running, cancel about to swap  | the completion lands first               | the completion wins: the cancel reports `false`, the target is active and keeps every vector, nothing is deleted |
 * | running, cancel about to swap  | a second cancel lands first              | exactly one of the two reports `true` |
 * | running, cancel about to swap  | a step's progress write lands first      | the swap misses, the cancel reads the record again, and wins with the progress the step wrote |
 * | running                        | the cancel's write fails (a stop before it) | the switch is still `running` with its target; the steps go on and complete it |
 * | cancelled                      | cancel again                             | `false`; the record is as it was |
 * | failed                         | cancel                                   | `false`; the failed record and the source are as they were |
 * | completed                      | cancel                                   | `false`; the target is active |
 * | cancelling (the record swapped, the profile not deleted: a stop between the two) | restart | the record reads `cancelled`; the source is fully usable; the half-deleted target is neither active nor previous |
 * | cancelling                     | restart, switch again, advance           | the new target takes a generation no profile has had, starts with nothing done, deletes the leftover, and completes; no vector of the leftover is counted |
 * | cancelled                      | admit                                    | the record is embedded into the source and queued for no other profile |
 * | cancelled                      | switch again at once                     | `started` with a fresh generation; it embeds every record |
 */
import type { Storage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import type { Embedder } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createEmbedderRegistry, HASHING_EMBEDDER_ID } from '../../src/embedder-registry';
import type { GovernedMemory } from '../../src/governance/governed-memory-types';
import { collectionNamespace } from '../../src/governance/record-governance';
import {
  createMemoryVectorStore,
  DEFAULT_MEMORY_VECTOR_KEY_PREFIX,
  type MemoryEmbeddingProfile,
  type MemoryVectorStore,
} from '../../src/memory-vector-store';
import { type ConditionalSwap, intercepting } from '../vector-store-version-1';
import { createGovernedFixture, principalA, recordIdOf } from './governed-memory-harness';

const FAKE = 'fake';
const DIMENSION = 8;
const NOTES = {
  tenantId: principalA.tenantId,
  namespace: collectionNamespace('private', principalA.ownerId, 'notes'),
};

/** One axis per word it knows, the last axis for any other text. */
function axis(text: string): number[] {
  const words = ['alpha', 'beta', 'gamma', 'delta'];
  const index = words.findIndex((word) => text.includes(word));
  return Array.from({ length: DIMENSION }, (_, position) =>
    position === (index === -1 ? DIMENSION - 1 : index) ? 1 : 0,
  );
}

/** An embedder that answers at once, and holds the next call, or fails every call, when told to. */
class GatedEmbedder {
  failing = false;
  /** How many times the embedder was called. */
  calls = 0;
  private gate: { entered: boolean; released: Promise<void>; release(): void } | undefined;

  readonly embed: Embedder = async (texts) => {
    this.calls += 1;
    const gate = this.gate;
    this.gate = undefined;
    if (gate !== undefined) {
      gate.entered = true;
      await gate.released;
    }
    if (this.failing) throw new Error('The fake embedder is down.');
    return texts.map((text) => axis(text));
  };

  /** Holds the next call until the returned hold is released. */
  holdNext(): { readonly entered: boolean; release(): void } {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = { entered: false, released, release: () => release() };
    this.gate = gate;
    return {
      get entered() {
        return gate.entered;
      },
      release: gate.release,
    };
  }
}

const NOTE_WORDS = ['alpha', 'beta', 'gamma'];

/** Memory with three notes embedded by the built-in hashing embedder, and `fake` registered. */
async function harness() {
  const embedder = new GatedEmbedder();
  const fixture = await createGovernedFixture('in-memory', {
    governed: {
      embedders: createEmbedderRegistry([
        { id: FAKE, embedder: embedder.embed, dimension: DIMENSION, model: 'fake-model' },
      ]),
      initialEmbedder: HASHING_EMBEDDER_ID,
    },
  });
  const ids: string[] = [];
  for (const word of NOTE_WORDS) ids.push(await writeNote(fixture.memory, `${word} note`));
  const vectors = createMemoryVectorStore(fixture.durable);
  const active = await vectors.getActiveProfile();
  // The profile memory started with, which a cancel must never touch.
  const source = active!;
  return { fixture, embedder, vectors, ids, source, durable: fixture.durable };
}

const writeNote = (memory: GovernedMemory, content: string) =>
  recordIdOf(memory.write(principalA, content, { collection: 'notes', source: 'conversation' }));

async function started(memory: GovernedMemory): Promise<MemoryEmbeddingProfile> {
  const result = await memory.embedding.switchTo(FAKE);
  if (result.outcome !== 'started') throw new Error(`The switch was ${result.reason}.`);
  return result.target;
}

async function advanceToEnd(memory: GovernedMemory): Promise<void> {
  for (;;) {
    const status = await memory.embedding.advance();
    if (status.job?.state !== 'running') return;
  }
}

/** How many of `ids` `profile` holds a vector for. */
async function heldCount(
  vectors: MemoryVectorStore,
  profile: MemoryEmbeddingProfile,
  ids: readonly string[],
) {
  const held = await vectors.getMany(profile, NOTES, ids);
  return held.size;
}

/** Every key the vector store holds that names `profile`: its marker, vectors, queue and checkpoint. */
async function keysOf(durable: Storage, profile: MemoryEmbeddingProfile): Promise<string[]> {
  const component = `${profile.embedderId}:${profile.dimension}:${profile.generation}`;
  const keys: string[] = [];
  for await (const [key] of durable.scan(DEFAULT_MEMORY_VECTOR_KEY_PREFIX)) {
    const rest = key.slice(DEFAULT_MEMORY_VECTOR_KEY_PREFIX.length);
    if (/^[pvqd]:/.test(rest) && rest.slice(2).startsWith(component)) keys.push(key);
  }
  return keys;
}

/** Whether recall still scores by the source profile's vectors. */
async function recallsBySource(memory: GovernedMemory): Promise<boolean> {
  const bundle = await memory.recallForModel(principalA, 'alpha', {
    collection: 'notes',
    plan: { stages: ['semantic'] },
  });
  const stage = bundle.stages.find((report) => report.stage === 'semantic');
  return stage?.status !== 'unavailable' && bundle.evidence.length === NOTE_WORDS.length;
}

async function profileCount(vectors: MemoryVectorStore): Promise<number> {
  const profiles = await vectors.listProfiles();
  return profiles.length;
}

/** The swap a cancel records: the switch record put with its state `cancelled`. */
function recordsCancellation(operations: ConditionalSwap[1]): boolean {
  return operations.some(
    (operation) =>
      operation.type === 'put' &&
      operation.key.endsWith(':job') &&
      new TextDecoder().decode(operation.value).includes('"state":"cancelled"'),
  );
}

/** The swap a completion makes: the switch record deleted. */
function recordsCompletion(operations: ConditionalSwap[1]): boolean {
  return operations.some(
    (operation) => operation.type === 'delete' && operation.key.endsWith(':job'),
  );
}

describe('cancelling the embedding switch (COR-2188)', () => {
  it('none: reports false and changes nothing', async () => {
    const { fixture, vectors, ids, source } = await harness();

    expect(await fixture.memory.embedding.cancel()).toBe(false);

    const status = await fixture.memory.embedding.status();
    expect(status.job).toBeUndefined();
    expect(await vectors.listProfiles()).toEqual([source]);
    expect(await heldCount(vectors, source, ids)).toBe(ids.length);
    expect(await recallsBySource(fixture.memory)).toBe(true);
  });

  it('running, between steps: cancels, deletes the target, and leaves the source fully usable', async () => {
    const { fixture, embedder, vectors, durable, ids, source } = await harness();
    const target = await started(fixture.memory);
    await fixture.memory.embedding.advance({ limit: 1 });
    const mid = await fixture.memory.embedding.status();
    expect(mid.job).toMatchObject({ state: 'running', done: 1, total: 3 });
    expect(await heldCount(vectors, target, ids)).toBe(1);

    expect(await fixture.memory.embedding.cancel()).toBe(true);

    const status = await fixture.memory.embedding.status();
    expect(status.job).toMatchObject({ target: FAKE, state: 'cancelled', done: 1, total: 3 });
    expect(status.active.embedder).toBe(HASHING_EMBEDDER_ID);
    expect(await vectors.listProfiles()).toEqual([source]);
    expect(await keysOf(durable, target)).toEqual([]);
    expect(await heldCount(vectors, source, ids)).toBe(ids.length);
    expect(await recallsBySource(fixture.memory)).toBe(true);

    // An advance after does nothing: the cancelled record is not resumed.
    const calls = embedder.calls;
    const after = await fixture.memory.embedding.advance();
    expect(after.job?.state).toBe('cancelled');
    expect(embedder.calls).toBe(calls);
  });

  it('running, a step embedding: the step finds its profile gone and leaves the record cancelled', async () => {
    const { fixture, embedder, vectors, durable, source } = await harness();
    const target = await started(fixture.memory);
    const hold = embedder.holdNext();

    const advancing = fixture.memory.embedding.advance();
    await waitUntil(() => hold.entered, { message: 'the step embeds its batch' });
    expect(await fixture.memory.embedding.cancel()).toBe(true);
    hold.release();
    const after = await advancing;

    // Not rewritten as `failed` with `target-missing`: the record was already `cancelled`.
    expect(after.job).toMatchObject({ state: 'cancelled' });
    expect(after.job?.error).toBeUndefined();
    expect(await vectors.listProfiles()).toEqual([source]);
    expect(await keysOf(durable, target)).toEqual([]);
  });

  it('running, a completion about to swap: a cancel that arrives first wins, and the source stays active', async () => {
    const { fixture, vectors, durable, ids, source } = await harness();
    const canceller = fixture.restart();
    // The completing process holds its swap until the other process has cancelled.
    let cancelled: Promise<boolean> | undefined;
    const completing = fixture.restart({
      vectors: createMemoryVectorStore(
        intercepting(durable, (run, _conditions, operations) => {
          if (!recordsCompletion(operations)) return run();
          cancelled = canceller.embedding.cancel();
          return cancelled.then(run);
        }),
      ),
    });
    const target = await started(completing);
    await completing.embedding.advance({ limit: ids.length });
    const full = await completing.embedding.status();
    expect(full.job).toMatchObject({ done: 3, total: 3 });

    await completing.embedding.advance();

    expect(await cancelled).toBe(true);
    const status = await fixture.memory.embedding.status();
    expect(status.job).toMatchObject({ state: 'cancelled' });
    expect(status.active.embedder).toBe(HASHING_EMBEDDER_ID);
    expect(await vectors.listProfiles()).toEqual([source]);
    expect(await keysOf(durable, target)).toEqual([]);
    expect(await heldCount(vectors, source, ids)).toBe(ids.length);
  });

  it('running, a cancel about to swap: a completion that lands first wins, and nothing is deleted', async () => {
    const { fixture, vectors, durable, ids } = await harness();
    const completer = fixture.restart();
    let completed: Promise<unknown> | undefined;
    const cancelling = fixture.restart({
      vectors: createMemoryVectorStore(
        intercepting(durable, (run, _conditions, operations) => {
          if (!recordsCancellation(operations)) return run();
          completed = completer.embedding.advance();
          return completed.then(run);
        }),
      ),
    });
    const target = await started(cancelling);
    await cancelling.embedding.advance({ limit: ids.length });

    const result = await cancelling.embedding.cancel();

    expect(result).toBe(false);
    await completed;
    const status = await fixture.memory.embedding.status();
    expect(status.job).toBeUndefined();
    expect(status.active.embedder).toBe(FAKE);
    expect(await vectors.getActiveProfile()).toEqual(target);
    expect(await heldCount(vectors, target, ids)).toBe(ids.length);
  });

  it('running, a cancel about to swap: a second cancel that lands first wins, and exactly one reports true', async () => {
    const { fixture, durable } = await harness();
    let arrived = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Both processes read the running record before either swaps it.
    const cancelling = () =>
      fixture.restart({
        vectors: createMemoryVectorStore(
          intercepting(durable, (run, _conditions, operations) => {
            if (!recordsCancellation(operations)) return run();
            arrived += 1;
            if (arrived === 2) release();
            return together.then(run);
          }),
        ),
      });
    const first = cancelling();
    const second = cancelling();
    await started(fixture.memory);

    const results = await Promise.all([first.embedding.cancel(), second.embedding.cancel()]);

    expect(arrived).toBe(2);
    expect(results.filter(Boolean)).toHaveLength(1);
    const status = await fixture.memory.embedding.status();
    expect(status.job?.state).toBe('cancelled');
  });

  it('running, a step moves the record’s progress between the cancel’s read and its swap: the cancel reads again and still wins', async () => {
    const { fixture, vectors, durable, ids, source } = await harness();
    const stepper = fixture.restart();
    let moved = false;
    const cancelling = fixture.restart({
      vectors: createMemoryVectorStore(
        intercepting(durable, async (run, _conditions, operations) => {
          if (!moved && recordsCancellation(operations)) {
            // The step's progress write lands first, so the cancel's swap, which expects the record it read, misses.
            moved = true;
            await stepper.embedding.advance({ limit: 1 });
          }
          return run();
        }),
      ),
    });
    const target = await started(cancelling);

    expect(await cancelling.embedding.cancel()).toBe(true);

    expect(moved).toBe(true);
    const status = await fixture.memory.embedding.status();
    // The record is the one the step wrote, cancelled: its progress is kept.
    expect(status.job).toMatchObject({ state: 'cancelled', done: 1, total: 3 });
    expect(await vectors.listProfiles()).toEqual([source]);
    expect(await keysOf(durable, target)).toEqual([]);
    expect(await heldCount(vectors, source, ids)).toBe(ids.length);
  });

  it('running, the cancel’s write fails: the switch is still running with its target, and the steps complete it', async () => {
    const { fixture, vectors, durable, ids, source } = await harness();
    const stopping = fixture.restart({
      vectors: createMemoryVectorStore(
        intercepting(durable, (run, _conditions, operations) => {
          if (recordsCancellation(operations)) {
            return Promise.reject(new Error('the process stopped before the write'));
          }
          return run();
        }),
      ),
    });
    const target = await started(stopping);
    await stopping.embedding.advance({ limit: 1 });

    expect(await rejectionOf(stopping.embedding.cancel())).toBeInstanceOf(Error);

    const status = await fixture.memory.embedding.status();
    expect(status.job).toMatchObject({ state: 'running', done: 1, total: 3 });
    expect(await vectors.listProfiles()).toContainEqual(target);
    expect(await heldCount(vectors, target, ids)).toBe(1);
    await advanceToEnd(fixture.memory);
    const done = await fixture.memory.embedding.status();
    expect(done.active.embedder).toBe(FAKE);
    expect(await vectors.getPreviousProfile()).toEqual(source);
  });

  it('cancelled: a second cancel reports false and changes nothing', async () => {
    const { fixture, vectors, source } = await harness();
    await started(fixture.memory);
    expect(await fixture.memory.embedding.cancel()).toBe(true);
    const before = await fixture.memory.embedding.status();

    expect(await fixture.memory.embedding.cancel()).toBe(false);

    expect(await fixture.memory.embedding.status()).toEqual(before);
    expect(await vectors.listProfiles()).toEqual([source]);
  });

  it('failed: cancel reports false, and the failed record and the source are as they were', async () => {
    const { fixture, embedder, vectors, ids, source } = await harness();
    await started(fixture.memory);
    embedder.failing = true;
    const failed = await fixture.memory.embedding.advance();
    expect(failed.job).toMatchObject({ state: 'failed', error: 'embedder-failed' });

    expect(await fixture.memory.embedding.cancel()).toBe(false);

    expect(await fixture.memory.embedding.status()).toEqual(failed);
    expect(await vectors.listProfiles()).toEqual([source]);
    expect(await heldCount(vectors, source, ids)).toBe(ids.length);
  });

  it('completed: cancel reports false, and the target stays active', async () => {
    const { fixture, vectors, ids } = await harness();
    const target = await started(fixture.memory);
    await advanceToEnd(fixture.memory);

    expect(await fixture.memory.embedding.cancel()).toBe(false);

    expect(await vectors.getActiveProfile()).toEqual(target);
    expect(await heldCount(vectors, target, ids)).toBe(ids.length);
  });

  describe('a stop between the swap and the deletion of the profile (cancelling)', () => {
    /** A memory whose first `deleteProfile` stops, as a process that stopped after the swap would. */
    async function stoppedWhileCancelling() {
      const context = await harness();
      const { fixture, vectors } = context;
      let stops = 1;
      const stopping: MemoryVectorStore = {
        ...vectors,
        async deleteProfile(profile) {
          if (stops > 0) {
            stops -= 1;
            throw new Error('the process stopped after the swap');
          }
          await vectors.deleteProfile(profile);
        },
      };
      const memory = fixture.restart({ vectors: stopping });
      const target = await started(memory);
      await memory.embedding.advance({ limit: 1 });
      expect(await rejectionOf(memory.embedding.cancel())).toBeInstanceOf(Error);
      return { ...context, target, restarted: fixture.restart() };
    }

    it('restart: the record reads cancelled and the source is fully usable', async () => {
      const { restarted, vectors, ids, source, target } = await stoppedWhileCancelling();

      const status = await restarted.embedding.status();
      expect(status.job).toMatchObject({ target: FAKE, state: 'cancelled' });
      expect(status.active.embedder).toBe(HASHING_EMBEDDER_ID);
      expect(await vectors.getActiveProfile()).toEqual(source);
      expect(await vectors.getPreviousProfile()).toBeUndefined();
      expect(await heldCount(vectors, source, ids)).toBe(ids.length);
      expect(await recallsBySource(restarted)).toBe(true);
      // The profile the stop left is neither active nor previous, and no step embeds into it.
      expect(await vectors.listProfiles()).toContainEqual(target);
      expect(await restarted.embedding.cancel()).toBe(false);
    });

    it('restart, switch again, advance: the leftover is deleted and never counted as progress', async () => {
      const { restarted, vectors, durable, ids, target } = await stoppedWhileCancelling();
      expect(await heldCount(vectors, target, ids)).toBe(1);

      const second = await started(restarted);

      expect(second.generation).toBeGreaterThan(target.generation);
      const fresh = await restarted.embedding.status();
      // Nothing is done yet: what the leftover held is not this switch's progress.
      expect(fresh.job).toMatchObject({ state: 'running', done: 0 });
      expect(await vectors.listProfiles()).not.toContainEqual(target);
      expect(await keysOf(durable, target)).toEqual([]);
      await advanceToEnd(restarted);
      expect(await vectors.getActiveProfile()).toEqual(second);
      expect(await heldCount(vectors, second, ids)).toBe(ids.length);
      expect(await profileCount(vectors)).toBe(2);
    });
  });

  it('cancelled: an admission is embedded into the source and queued for no other profile', async () => {
    const { fixture, vectors, durable, source } = await harness();
    const target = await started(fixture.memory);
    expect(await fixture.memory.embedding.cancel()).toBe(true);

    const added = await writeNote(fixture.memory, 'delta note');

    expect(await heldCount(vectors, source, [added])).toBe(1);
    expect(await vectors.listQueuedEmbeds(source, 10)).toEqual([]);
    expect(await keysOf(durable, target)).toEqual([]);
  });

  it('cancelled: a switch started at once takes a fresh generation and embeds every record', async () => {
    const { fixture, vectors, ids } = await harness();
    const first = await started(fixture.memory);
    await fixture.memory.embedding.advance({ limit: 1 });
    expect(await fixture.memory.embedding.cancel()).toBe(true);

    const second = await started(fixture.memory);

    expect(second.generation).toBeGreaterThan(first.generation);
    const fresh = await fixture.memory.embedding.status();
    expect(fresh.job).toMatchObject({ done: 0, state: 'running' });
    await advanceToEnd(fixture.memory);
    expect(await vectors.getActiveProfile()).toEqual(second);
    expect(await heldCount(vectors, second, ids)).toBe(ids.length);
  });
});
