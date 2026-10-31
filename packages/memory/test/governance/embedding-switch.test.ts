/**
 * COR-1898 part 2: switching memory's embedder re-embeds every stored record into a new profile in
 * a durable job, which the host advances, and makes that profile active in one step.
 *
 * Outcome matrix, job state × event → required result (each row is a test below):
 *
 * | Job state            | Event                                   | Required result |
 * | -------------------- | --------------------------------------- | --------------- |
 * | none                 | switch to a loaded embedder             | running job filling a new profile; recall unchanged |
 * | none                 | switch to a missing or needs-setup one  | refused `not-loaded` / `needs-setup`; nothing stored |
 * | running              | advance                                 | `done` rises to `total`; recall unchanged until it completes, then the new profile serves |
 * | running              | admit                                   | embedded into both profiles; recalled through the new one after the switch |
 * | running              | admit, target embed errors              | admission succeeds; the job embeds the record before completing |
 * | running              | forget                                  | absent from both profiles |
 * | running, embed held  | forget, then release                    | absent from the target (the write checks the record) |
 * | running, embed held  | correct, then release                   | the target holds the corrected record's vector |
 * | running              | cancel                                  | `cancelled`; the target profile is deleted; recall keeps the previous one |
 * | cancelled            | forget, switch again, advance           | a new generation completes without the forgotten record |
 * | running              | the target embedder fails part-way      | `failed` with `error` and `done`; the target is deleted; recall keeps the previous one |
 * | running              | restart, advance                        | resumes the same profile; finished records are not embedded again |
 * | running              | restart with the target not loaded      | `failed`, `error: 'target-unavailable'`; the target is deleted |
 * | running              | second switch                           | refused `job-running`, naming the running switch |
 * | completed twice      | (retention)                             | the profile two switches back is deleted |
 * | none                 | hashing → fake → hashing                | three distinct profiles; a record forgotten while fake is active is absent from the last |
 * | crashed (no record)  | switch                                  | the leftover profile is deleted and never the target |
 * | none                 | a switch completes while another starts | the stale start is refused `already-active`; the completed profile stays active and stored |
 * | running              | the target embedder returns NaN         | `failed` with the error; the target is deleted; a new switch can start |
 * | completed            | admit, the embedder returns NaN         | the admission is refused and nothing is stored |
 * | running, embed held  | forget another pending record, release  | the forgotten record's content is not left in the target's cache |
 * | running, admission's target embed held | forget it, release | the forgotten record's content is not left in the target's cache |
 * | profile deletion stopped part-way | forget, then advance       | the forget removes the record's vector from it; the advance finishes the deletion |
 * | none, active embedder not loaded | status, recall, admit       | `problem: 'embedder-unavailable'`; recall is lexical; the admission is stored and queued |
 * | none, active embedder not loaded | advance                     | the queued admission stays queued |
 * | none, active embedder loaded again | restart, advance          | the queued admission is embedded into the active profile; the queue is empty |
 * | none, active embedder not loaded | switch to a loaded one, admit, advance | completes; every record, a queued one included, has a vector in the new profile; the problem clears |
 * | running, last survey done, completion held | admit, target embed errors, complete | the record is queued for the target; the next advance embeds it into the now-active profile |
 */
import { sha256Hex } from '@lostgradient/cryptography';
import { MemoryStorage } from '@lostgradient/storage';
import type { Embedder } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';

import {
  createEmbedderRegistry,
  type EmbedderRegistry,
  HASHING_EMBEDDER_ID,
} from '../../src/embedder-registry';
import { withEmbeddingCache } from '../../src/embedding-cache';
import type { GovernedMemory } from '../../src/governance/governed-memory-types';
import { collectionNamespace } from '../../src/governance/record-governance';
import {
  createMemoryVectorStore,
  DEFAULT_MEMORY_VECTOR_KEY_PREFIX,
  type MemoryEmbeddingJob,
  type MemoryEmbeddingProfile,
  type MemoryVectorReference,
  type MemoryVectorStore,
} from '../../src/memory-vector-store';
import {
  createGovernedFixture,
  type GovernedBackend,
  type GovernedFixture,
  principalA,
  recordIdOf,
} from './governed-memory-harness';

const FAKE = 'fake';
const NEEDS_SETUP = 'needs-setup-embedder';
const DIMENSION = 8;
const WORDS = ['alpha', 'beta', 'gamma', 'delta'];

/** One axis per word it knows, the last axis for any other text. */
function axis(text: string): number[] {
  const index = WORDS.findIndex((word) => text.includes(word));
  return Array.from({ length: DIMENSION }, (_, position) =>
    position === (index === -1 ? DIMENSION - 1 : index) ? 1 : 0,
  );
}

interface Hold {
  entered: boolean;
  release(): void;
}

/** An 8-dimension embedder that records every text it is asked for, and can hold or fail one. */
class FakeEmbedder {
  readonly calls: string[] = [];
  private readonly holds = new Map<string, { hold: Hold; released: Promise<void> }>();
  private failAtCall: number | undefined;
  private readonly failing = new Set<string>();
  private readonly poisoned = new Set<string>();
  private nextHold: { hold: Hold; released: Promise<void> } | undefined;

  readonly embed: Embedder = async (texts) => {
    const invalid = new Set<string>();
    for (const text of texts) {
      this.calls.push(text);
      if (this.calls.length === this.failAtCall || this.failing.delete(text)) {
        throw new Error(`The fake embedder refused "${text}".`);
      }
      if (this.poisoned.delete(text)) invalid.add(text);
      const held = this.holds.get(text) ?? this.nextHold;
      if (held !== undefined) {
        if (held === this.nextHold) this.nextHold = undefined;
        else this.holds.delete(text);
        held.hold.entered = true;
        await held.released;
      }
    }
    return texts.map((text) =>
      invalid.has(text) ? Array.from({ length: DIMENSION }, () => Number.NaN) : axis(text),
    );
  };

  private gate(): { hold: Hold; released: Promise<void> } {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { hold: { entered: false, release: () => release() }, released };
  }

  /** Holds the next call for `text` until the returned hold is released. */
  hold(text: string): Hold {
    const gate = this.gate();
    this.holds.set(text, gate);
    return gate.hold;
  }

  /** Holds the next call, whatever its text, until the returned hold is released. */
  holdNext(): Hold {
    this.nextHold = this.gate();
    return this.nextHold.hold;
  }

  /** Answers the next call for `text`, once, with a vector of the right length holding `NaN`. */
  poison(text: string): void {
    this.poisoned.add(text);
  }

  /** Fails the next call for `text`, once. */
  failOnce(text: string): void {
    this.failing.add(text);
  }

  /** Fails the `call`th call, counting from the first this embedder received. */
  failAt(call: number): void {
    this.failAtCall = call;
  }

  countOf(text: string): number {
    return this.calls.filter((call) => call === text).length;
  }
}

function registryWith(
  fake: FakeEmbedder,
  withFake = true,
  embedder: Embedder = fake.embed,
): EmbedderRegistry {
  return createEmbedderRegistry([
    ...(withFake ? [{ id: FAKE, embedder, dimension: DIMENSION }] : []),
    {
      id: NEEDS_SETUP,
      embedder: fake.embed,
      dimension: DIMENSION,
      availability: () => 'needs-setup' as const,
    },
  ]);
}

const notes = {
  tenantId: principalA.tenantId,
  namespace: collectionNamespace('private', principalA.ownerId, 'notes'),
};

function referenceTo(id: string): MemoryVectorReference {
  return { id, scope: notes };
}

/** The propagation a host with a content-evicting cache configures: `caches` is left to memory. */
const evictingCaches = {
  'managed-asset-bytes': 'not-retained',
  'durable-snapshots': 'not-retained',
  'external-processors': 'not-retained',
} as const;

/** `store`, with its next call of `method` held until the returned hold is released. */
function holding(
  store: MemoryVectorStore,
  method: 'createProfile' | 'completeJob',
): {
  readonly store: MemoryVectorStore;
  readonly hold: Hold;
} {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hold: Hold = { entered: false, release: () => release() };
  async function gate(): Promise<void> {
    if (hold.entered) return;
    hold.entered = true;
    await released;
  }
  return {
    hold,
    store: {
      ...store,
      ...(method === 'createProfile'
        ? {
            async createProfile(profile: MemoryEmbeddingProfile) {
              await gate();
              return store.createProfile(profile);
            },
          }
        : {
            async completeJob(expected: MemoryEmbeddingJob) {
              await gate();
              return store.completeJob(expected);
            },
          }),
    },
  };
}

/** `storage`, whose first `deletePrefix` fails, as a process that stops part-way would. */
function stoppingOnFirstDeletePrefix(storage: MemoryStorage): MemoryStorage {
  let stopped = false;
  return new Proxy(storage, {
    get(target, key) {
      if (key === 'deletePrefix' && !stopped) {
        return async () => {
          stopped = true;
          throw new Error('The storage stopped while deleting a profile.');
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The stored keys under `prefix` in the vector store's key space. */
async function keysUnder(storage: MemoryStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan(`${DEFAULT_MEMORY_VECTOR_KEY_PREFIX}${prefix}`)) {
    keys.push(key);
  }
  return keys;
}

async function writeNote(memory: GovernedMemory, content: string): Promise<string> {
  return recordIdOf(
    memory.write(principalA, content, { collection: 'notes', source: 'conversation' }),
  );
}

async function forgetNote(memory: GovernedMemory, id: string): Promise<void> {
  const deleted = await memory.delete(principalA, { id, collection: 'notes' });
  expect(deleted.status).toBe('applied');
}

/** Each recalled record's semantic score for `query`, by id. */
async function semanticScores(
  memory: GovernedMemory,
  query: string,
): Promise<Map<string, number | undefined>> {
  const bundle = await memory.recallForModel(principalA, query, { collection: 'notes' });
  return new Map(
    bundle.candidates.map((candidate) => [candidate.recordId, candidate.scores?.semantic]),
  );
}

async function activeEmbedder(memory: GovernedMemory): Promise<string> {
  const status = await memory.embedding.status();
  return status.active.embedder;
}

async function advanceToEnd(memory: GovernedMemory): Promise<void> {
  for (;;) {
    const status = await memory.embedding.advance();
    if (status.job?.state !== 'running') return;
  }
}

async function started(memory: GovernedMemory, id = FAKE): Promise<MemoryEmbeddingProfile> {
  const result = await memory.embedding.switchTo(id);
  if (result.outcome !== 'started') throw new Error(`switch refused: ${result.message}`);
  return result.target;
}

for (const backend of ['in-memory', 'weft'] as const satisfies readonly GovernedBackend[]) {
  describe(`switching the embedder (${backend})`, () => {
    async function fixtureWith(fake: FakeEmbedder): Promise<GovernedFixture> {
      return createGovernedFixture(backend, {
        governed: { embedders: registryWith(fake), initialEmbedder: HASHING_EMBEDDER_ID },
      });
    }

    function vectorsOf(fixture: GovernedFixture) {
      return createMemoryVectorStore(fixture.durable);
    }

    async function vectorIn(
      fixture: GovernedFixture,
      profile: MemoryEmbeddingProfile,
      id: string,
    ): Promise<number[] | undefined> {
      const found = await vectorsOf(fixture).getMany(profile, notes, [id]);
      const vector = found.get(id)?.vector;
      return vector === undefined ? undefined : Array.from(vector);
    }

    it('re-embeds every stored record into a new profile, then recalls through it', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      const alpha = await writeNote(fixture.memory, 'alpha note');
      const beta = await writeNote(fixture.memory, 'beta note');
      const before = await vectorsOf(fixture).getActiveProfile();

      const target = await started(fixture.memory);
      expect(target).toEqual({ embedderId: FAKE, dimension: DIMENSION, generation: 2 });
      await advanceToEnd(fixture.memory);

      expect(await fixture.memory.embedding.status()).toEqual({
        active: { embedder: FAKE, dimension: DIMENSION },
      });
      expect(fake.calls.toSorted()).toEqual(['alpha note', 'beta note']);
      expect(await vectorIn(fixture, target, alpha)).toEqual(axis('alpha'));
      expect(await vectorIn(fixture, target, beta)).toEqual(axis('beta'));
      const scores = await semanticScores(fixture.memory, 'alpha');
      expect(scores.get(alpha)).toBeCloseTo(1);
      expect(scores.get(beta)).toBeCloseTo(0);
      // The replaced profile is kept until a later switch completes.
      expect(await vectorsOf(fixture).getPreviousProfile()).toEqual(before);
    });

    it('counts done up to total while recall keeps the previous profile', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      for (const word of WORDS) await writeNote(fixture.memory, `${word} note`);
      const recalled = await semanticScores(fixture.memory, 'alpha');

      await started(fixture.memory);
      const seen: number[] = [];
      for (;;) {
        const status = await fixture.memory.embedding.advance({ limit: 1 });
        if (status.job === undefined) break;
        expect(status.job.total).toBe(4);
        expect(status.active.embedder).toBe(HASHING_EMBEDDER_ID);
        expect(await semanticScores(fixture.memory, 'alpha')).toEqual(recalled);
        seen.push(status.job.done);
      }
      expect(seen).toEqual([1, 2, 3, 4]);
      expect(await activeEmbedder(fixture.memory)).toBe(FAKE);
    });

    it('embeds a record admitted during the switch into both profiles, and drops a forgotten one from both', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      const alpha = await writeNote(fixture.memory, 'alpha note');
      const previous = (await vectorsOf(fixture).getActiveProfile())!;
      const target = await started(fixture.memory);

      const gamma = await writeNote(fixture.memory, 'gamma note');
      expect(await vectorIn(fixture, target, gamma)).toEqual(axis('gamma'));
      expect(await vectorIn(fixture, previous, gamma)).toBeDefined();
      await forgetNote(fixture.memory, alpha);
      expect(await vectorIn(fixture, target, alpha)).toBeUndefined();
      expect(await vectorIn(fixture, previous, alpha)).toBeUndefined();

      await advanceToEnd(fixture.memory);
      // The admission's own embed counts: the job did not embed it again.
      expect(fake.countOf('gamma note')).toBe(1);
      expect(fake.countOf('alpha note')).toBe(0);
      const gammaScores = await semanticScores(fixture.memory, 'gamma');
      expect(gammaScores.get(gamma)).toBeCloseTo(1);
      expect(await vectorIn(fixture, target, alpha)).toBeUndefined();
    });

    it('keeps a record forgotten while the switch embedded it out of the target', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      const alpha = await writeNote(fixture.memory, 'alpha note');
      await writeNote(fixture.memory, 'beta note');
      const target = await started(fixture.memory);
      const hold = fake.hold('alpha note');

      const advancing = fixture.memory.embedding.advance();
      await waitUntil(() => hold.entered, { message: 'the switch embeds the alpha note' });
      await forgetNote(fixture.memory, alpha);
      hold.release();
      const status = await advancing;

      expect(status.active.embedder).toBe(FAKE);
      expect(await vectorIn(fixture, target, alpha)).toBeUndefined();
      const keys: string[] = [];
      for await (const [key] of fixture.durable.scan(`${DEFAULT_MEMORY_VECTOR_KEY_PREFIX}v:`)) {
        keys.push(key);
      }
      expect(keys.some((key) => key.endsWith(`:r:${alpha}`))).toBe(false);
    });

    it('keeps the corrected record’s vector in the target when a correction lands while the switch embeds', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      const alpha = await writeNote(fixture.memory, 'alpha note');
      const target = await started(fixture.memory);
      const hold = fake.hold('alpha note');

      const advancing = fixture.memory.embedding.advance();
      await waitUntil(() => hold.entered, { message: 'the switch embeds the alpha note' });
      const corrected = await fixture.memory.forget(principalA, {
        mode: 'supersession',
        locator: { id: alpha, collection: 'notes' },
        successor: { content: 'beta correction', collection: 'notes', source: 'conversation' },
      });
      expect(corrected.status).toBe('applied');
      hold.release();
      await advancing;
      await advanceToEnd(fixture.memory);

      const successor = corrected.write!.recordId!;
      expect(await activeEmbedder(fixture.memory)).toBe(FAKE);
      expect(await vectorIn(fixture, target, successor)).toEqual(axis('beta'));
      // The original changed while it was embedded, so its vector was withdrawn and embedded again
      // at the version it has now.
      const original = await fixture.storage.get(alpha, notes);
      const held = await vectorsOf(fixture).getMany(target, notes, [alpha]);
      expect(held.get(alpha)?.version).toBe(original!.version);
      expect(original!.version).toBeGreaterThan(1);
      expect(fake.countOf('alpha note')).toBe(2);
    });

    it('admits a record whose embed into the target errors, and embeds it before completing', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      await writeNote(fixture.memory, 'alpha note');
      const target = await started(fixture.memory);
      fake.failOnce('delta note');

      const delta = await writeNote(fixture.memory, 'delta note');
      expect(await vectorIn(fixture, target, delta)).toBeUndefined();
      await advanceToEnd(fixture.memory);

      expect(await activeEmbedder(fixture.memory)).toBe(FAKE);
      expect(await vectorIn(fixture, target, delta)).toEqual(axis('delta'));
      expect(fake.countOf('delta note')).toBe(2);
    });

    it('cancels the switch, deleting its profile and keeping recall on the previous one', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      await writeNote(fixture.memory, 'alpha note');
      await writeNote(fixture.memory, 'beta note');
      const previous = (await vectorsOf(fixture).getActiveProfile())!;
      const target = await started(fixture.memory);
      await fixture.memory.embedding.advance({ limit: 1 });

      expect(await fixture.memory.embedding.cancel()).toBe(true);
      expect(await fixture.memory.embedding.cancel()).toBe(false);
      expect(await fixture.memory.embedding.status()).toEqual({
        active: { embedder: HASHING_EMBEDDER_ID, dimension: previous.dimension },
        job: { target: FAKE, state: 'cancelled', done: 1, total: 2 },
      });
      expect(await vectorsOf(fixture).listProfiles()).toEqual([previous]);
      expect(target.generation).toBe(2);
      // Advancing a cancelled switch does nothing.
      await fixture.memory.embedding.advance();
      const after = await fixture.memory.embedding.status();
      expect(after.job?.state).toBe('cancelled');
    });

    it('starts again from the beginning after a cancel, without a record forgotten meanwhile', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      await writeNote(fixture.memory, 'alpha note');
      const beta = await writeNote(fixture.memory, 'beta note');
      const first = await started(fixture.memory);
      await fixture.memory.embedding.advance({ limit: 2 });
      // Both are embedded, and the next step would complete it.
      expect(await vectorIn(fixture, first, beta)).toEqual(axis('beta'));
      await fixture.memory.embedding.cancel();
      await forgetNote(fixture.memory, beta);

      const second = await started(fixture.memory);
      expect(second.generation).toBeGreaterThan(first.generation);
      await advanceToEnd(fixture.memory);

      expect(await fixture.memory.embedding.status()).toEqual({
        active: { embedder: FAKE, dimension: DIMENSION },
      });
      expect(await vectorIn(fixture, second, beta)).toBeUndefined();
      expect(await vectorIn(fixture, first, beta)).toBeUndefined();
    });

    it('fails part-way, keeping recall on the previous profile with the state, error and progress', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      for (const word of ['alpha', 'beta', 'gamma'])
        await writeNote(fixture.memory, `${word} note`);
      const recalled = await semanticScores(fixture.memory, 'alpha');
      const previous = (await vectorsOf(fixture).getActiveProfile())!;
      await started(fixture.memory);
      fake.failAt(3);

      const status = await fixture.memory.embedding.advance();

      expect(status.active.embedder).toBe(HASHING_EMBEDDER_ID);
      expect(status.job).toMatchObject({ target: FAKE, state: 'failed', done: 2, total: 3 });
      expect(status.job?.error).toContain('The fake embedder refused');
      expect(await vectorsOf(fixture).listProfiles()).toEqual([previous]);
      expect(await semanticScores(fixture.memory, 'alpha')).toEqual(recalled);
    });

    it('resumes after a restart without embedding a finished record again', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      for (const word of WORDS) await writeNote(fixture.memory, `${word} note`);
      const target = await started(fixture.memory);
      await fixture.memory.embedding.advance({ limit: 2 });
      expect(fake.calls).toHaveLength(2);

      const resumed = new FakeEmbedder();
      const restarted = fixture.restart({
        embedders: registryWith(resumed),
        initialEmbedder: HASHING_EMBEDDER_ID,
      });
      await restarted.init();
      // Dual writes are still in force after the restart.
      await writeNote(restarted, 'gamma again');
      await advanceToEnd(restarted);

      expect(await restarted.embedding.status()).toEqual({
        active: { embedder: FAKE, dimension: DIMENSION },
      });
      expect(resumed.calls.toSorted()).toEqual(
        [
          ...WORDS.map((word) => `${word} note`).filter((text) => !fake.calls.includes(text)),
          'gamma again',
        ].toSorted(),
      );
      expect(await vectorsOf(fixture).getActiveProfile()).toEqual(target);
    });

    it('fails as target-unavailable when a restart no longer loads the target embedder', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      await writeNote(fixture.memory, 'alpha note');
      const previous = (await vectorsOf(fixture).getActiveProfile())!;
      await started(fixture.memory);

      const restarted = fixture.restart({
        embedders: registryWith(fake, false),
        initialEmbedder: HASHING_EMBEDDER_ID,
      });
      const status = await restarted.embedding.advance();

      expect(status.job).toEqual({
        target: FAKE,
        state: 'failed',
        done: 0,
        total: 0,
        error: 'target-unavailable',
      });
      expect(await vectorsOf(fixture).listProfiles()).toEqual([previous]);
    });

    it('refuses a second switch while one runs, naming it', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      await started(fixture.memory);

      const second = await fixture.memory.embedding.switchTo(HASHING_EMBEDDER_ID);
      expect(second).toMatchObject({ outcome: 'refused', reason: 'job-running' });
      expect(second.outcome === 'refused' && second.message).toContain(`"${FAKE}"`);
      expect(await vectorsOf(fixture).listProfiles()).toHaveLength(2);
    });

    it('refuses an embedder that is not loaded or needs setup, and the active one', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);

      expect(await fixture.memory.embedding.switchTo('missing')).toMatchObject({
        outcome: 'refused',
        reason: 'not-loaded',
      });
      expect(await fixture.memory.embedding.switchTo(NEEDS_SETUP)).toMatchObject({
        outcome: 'refused',
        reason: 'needs-setup',
      });
      expect(await fixture.memory.embedding.switchTo(HASHING_EMBEDDER_ID)).toMatchObject({
        outcome: 'refused',
        reason: 'already-active',
      });
      expect(await vectorsOf(fixture).getJob()).toBeUndefined();
      expect(await vectorsOf(fixture).listProfiles()).toHaveLength(1);
    });

    it('deletes the profile two switches back once a later switch completes', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      await writeNote(fixture.memory, 'alpha note');
      const first = (await vectorsOf(fixture).getActiveProfile())!;
      const second = await started(fixture.memory);
      await advanceToEnd(fixture.memory);
      expect(await vectorsOf(fixture).listProfiles()).toHaveLength(2);

      const third = await started(fixture.memory, HASHING_EMBEDDER_ID);
      // Kept while the third switch runs.
      expect(await vectorsOf(fixture).listProfiles()).toHaveLength(3);
      await advanceToEnd(fixture.memory);

      const profiles = await vectorsOf(fixture).listProfiles();
      expect(profiles.toSorted((left, right) => left.generation - right.generation)).toEqual([
        second,
        third,
      ]);
      expect(profiles).not.toContainEqual(first);
    });

    it('switches hashing → fake → hashing through three distinct profiles', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      const alpha = await writeNote(fixture.memory, 'alpha note');
      await writeNote(fixture.memory, 'beta note');
      const first = (await vectorsOf(fixture).getActiveProfile())!;
      const second = await started(fixture.memory);
      await advanceToEnd(fixture.memory);
      await forgetNote(fixture.memory, alpha);

      const third = await started(fixture.memory, HASHING_EMBEDDER_ID);
      await advanceToEnd(fixture.memory);

      expect(new Set([first, second, third].map((profile) => JSON.stringify(profile))).size).toBe(
        3,
      );
      expect(third.embedderId).toBe(HASHING_EMBEDDER_ID);
      expect(await vectorsOf(fixture).getActiveProfile()).toEqual(third);
      expect(await vectorIn(fixture, third, alpha)).toBeUndefined();
    });

    it('keeps a profile newer than the switch it completes, and refuses a limit below one', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      await writeNote(fixture.memory, 'alpha note');
      await started(fixture.memory);
      const vectors = vectorsOf(fixture);
      // A profile another process created after this switch started, as a later switch would.
      const newer: MemoryEmbeddingProfile = {
        embedderId: FAKE,
        dimension: DIMENSION,
        generation: await vectors.nextGeneration(),
      };
      expect(await vectors.createProfile(newer)).toBe(true);

      expect(await rejectionOf(fixture.memory.embedding.advance({ limit: 0 }))).toBeInstanceOf(
        RangeError,
      );
      await advanceToEnd(fixture.memory);

      expect(await vectors.listProfiles()).toContainEqual(newer);
    });

    it('never targets a profile a crashed switch left, and deletes it when the next one starts', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      const alpha = await writeNote(fixture.memory, 'alpha note');
      const vectors = vectorsOf(fixture);
      // A switch that crashed after creating its profile, before it stored its record.
      const leftover: MemoryEmbeddingProfile = {
        embedderId: FAKE,
        dimension: DIMENSION,
        generation: await vectors.nextGeneration(),
      };
      expect(await vectors.createProfile(leftover)).toBe(true);
      await vectors.put(leftover, referenceTo(alpha), {
        version: 1,
        vector: new Float32Array(axis('alpha')),
      });

      const target = await started(fixture.memory);

      expect(target.generation).toBeGreaterThan(leftover.generation);
      expect(await vectors.listProfiles()).not.toContainEqual(leftover);
      expect(await vectorIn(fixture, leftover, alpha)).toBeUndefined();
      await advanceToEnd(fixture.memory);
      expect(await vectors.getActiveProfile()).toEqual(target);
    });

    it('refuses a start that read an active profile a switch replaced meanwhile', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      const alpha = await writeNote(fixture.memory, 'alpha note');
      const { store, hold } = holding(createMemoryVectorStore(fixture.durable), 'createProfile');
      const other = fixture.restart({
        embedders: registryWith(fake),
        initialEmbedder: HASHING_EMBEDDER_ID,
        vectors: store,
      });
      await other.init();

      // This start reads no switch and the hashing profile as active, then waits.
      const stale = other.embedding.switchTo(FAKE);
      await waitUntil(() => hold.entered, { message: 'the stale start creates its profile' });
      const completed = await started(fixture.memory);
      await advanceToEnd(fixture.memory);
      hold.release();

      expect(await stale).toMatchObject({ outcome: 'refused', reason: 'already-active' });
      const vectors = vectorsOf(fixture);
      expect(await vectors.getActiveProfile()).toEqual(completed);
      expect(await vectors.listProfiles()).toContainEqual(completed);
      expect(await vectors.getJob()).toBeUndefined();
      expect(await vectorIn(fixture, completed, alpha)).toEqual(axis('alpha'));
    });

    it('fails the switch when its embedder returns a vector that is not finite', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      await writeNote(fixture.memory, 'alpha note');
      const previous = (await vectorsOf(fixture).getActiveProfile())!;
      await started(fixture.memory);
      fake.poison('alpha note');

      const status = await fixture.memory.embedding.advance();

      expect(status.job).toMatchObject({ target: FAKE, state: 'failed', done: 0, total: 1 });
      expect(status.job?.error).toContain('not a finite number');
      expect(await vectorsOf(fixture).listProfiles()).toEqual([previous]);
      expect(await fixture.memory.embedding.switchTo(FAKE)).toMatchObject({ outcome: 'started' });
    });

    it('refuses an admission whose embedder returns a vector that is not finite, storing nothing', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      await writeNote(fixture.memory, 'alpha note');
      await started(fixture.memory);
      await advanceToEnd(fixture.memory);
      fake.poison('beta note');

      const refused = await rejectionOf(writeNote(fixture.memory, 'beta note'));

      expect(String(refused)).toContain('not a finite number');
      const stored = await fixture.storage.list(notes);
      expect(stored.map((record) => record.content)).toEqual(['alpha note']);
    });

    it('leaves no cached embedding of a record forgotten while the switch embedded another', async () => {
      const fake = new FakeEmbedder();
      const cached = withEmbeddingCache(fake.embed);
      const fixture = await createGovernedFixture(backend, {
        governed: {
          embedders: registryWith(fake, true, cached),
          initialEmbedder: HASHING_EMBEDDER_ID,
          propagation: evictingCaches,
        },
      });
      const alpha = await writeNote(fixture.memory, 'alpha note');
      const beta = await writeNote(fixture.memory, 'beta note');
      await started(fixture.memory);
      const hold = fake.holdNext();

      // The step has read both records; whichever it embeds first waits, and the other is forgotten.
      const advancing = fixture.memory.embedding.advance();
      await waitUntil(() => hold.entered, { message: 'the switch embeds its first record' });
      const heldText = fake.calls.at(-1)!;
      const [forgotten, forgottenText] =
        heldText === 'alpha note' ? [beta, 'beta note'] : [alpha, 'alpha note'];
      const deleted = await fixture.memory.delete(principalA, {
        id: forgotten,
        collection: 'notes',
      });
      expect(deleted.receipt?.targets.find((target) => target.target === 'caches')).toMatchObject({
        status: 'completed',
      });
      hold.release();
      await advancing;

      expect(cached.cache.has(await sha256Hex(forgottenText))).toBe(false);
      expect(cached.cache.has(await sha256Hex(heldText))).toBe(true);
      expect(await activeEmbedder(fixture.memory)).toBe(FAKE);
    });

    it('leaves no cached embedding of a record forgotten while its admission embedded it into the target', async () => {
      const fake = new FakeEmbedder();
      const cached = withEmbeddingCache(fake.embed);
      const fixture = await createGovernedFixture(backend, {
        governed: {
          embedders: registryWith(fake, true, cached),
          initialEmbedder: HASHING_EMBEDDER_ID,
          propagation: evictingCaches,
        },
      });
      await writeNote(fixture.memory, 'alpha note');
      const target = await started(fixture.memory);
      const hold = fake.hold('gamma note');

      const writing = writeNote(fixture.memory, 'gamma note');
      await waitUntil(() => hold.entered, { message: 'the admission embeds into the target' });
      const stored = await fixture.storage.list(notes);
      const gamma = stored.find((record) => record.content === 'gamma note')!.id;
      await forgetNote(fixture.memory, gamma);
      hold.release();

      expect(await writing).toBe(gamma);
      expect(cached.cache.has(await sha256Hex('gamma note'))).toBe(false);
      expect(await vectorIn(fixture, target, gamma)).toBeUndefined();
    });

    it('removes a forgotten record from a profile whose deletion stopped part-way, and finishes the deletion on the next advance', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      const alpha = await writeNote(fixture.memory, 'alpha note');
      const beta = await writeNote(fixture.memory, 'beta note');
      const stopping = createMemoryVectorStore(stoppingOnFirstDeletePrefix(fixture.durable));
      const leftover: MemoryEmbeddingProfile = {
        embedderId: FAKE,
        dimension: DIMENSION,
        generation: await stopping.nextGeneration(),
      };
      expect(await stopping.createProfile(leftover)).toBe(true);
      for (const [id, word] of [
        [alpha, 'alpha'],
        [beta, 'beta'],
      ] as const) {
        await stopping.put(leftover, referenceTo(id), {
          version: 1,
          vector: new Float32Array(axis(word)),
        });
      }
      const leftoverVectors = `v:${FAKE}:${DIMENSION}:${leftover.generation}:`;

      expect(await rejectionOf(stopping.deleteProfile(leftover))).toBeInstanceOf(Error);
      expect(await stopping.listProfiles()).not.toContainEqual(leftover);
      expect(await keysUnder(fixture.durable, leftoverVectors)).toHaveLength(2);

      await forgetNote(fixture.memory, alpha);
      const remaining = await keysUnder(fixture.durable, leftoverVectors);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.endsWith(`:r:${beta}`)).toBe(true);

      await fixture.memory.embedding.advance();
      expect(await keysUnder(fixture.durable, leftoverVectors)).toEqual([]);
      expect(await keysUnder(fixture.durable, 'd:')).toEqual([]);
    });

    it('recalls lexically while the active embedder is not loaded, and embeds what it admitted once it is loaded again', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      const alpha = await writeNote(fixture.memory, 'alpha note');
      const active = await started(fixture.memory);
      await advanceToEnd(fixture.memory);

      const unloaded = fixture.restart({
        embedders: registryWith(fake, false),
        initialEmbedder: HASHING_EMBEDDER_ID,
      });
      await unloaded.init();
      expect(await unloaded.embedding.status()).toEqual({
        active: { embedder: FAKE, dimension: DIMENSION },
        problem: 'embedder-unavailable',
      });
      const beta = await writeNote(unloaded, 'beta note');
      const bundle = await unloaded.recallForModel(principalA, 'beta', { collection: 'notes' });
      expect(bundle.stopReason).not.toBe('failed');
      expect(bundle.candidates.map((candidate) => candidate.recordId)).toContain(beta);
      const hits = await unloaded.search(principalA, 'beta', { collection: 'notes' });
      expect(hits.map((hit) => hit.record.id)).toContain(beta);
      // An advance while the embedder is not loaded leaves the admission queued.
      await unloaded.embedding.advance();
      expect(await vectorIn(fixture, active, beta)).toBeUndefined();
      expect(await keysUnder(fixture.durable, 'q:')).toHaveLength(1);

      // A restart between the admission and its embedding keeps it queued.
      const reloaded = fixture.restart({
        embedders: registryWith(fake),
        initialEmbedder: HASHING_EMBEDDER_ID,
      });
      await reloaded.init();
      expect(await reloaded.embedding.status()).toEqual({
        active: { embedder: FAKE, dimension: DIMENSION },
      });
      await reloaded.embedding.advance();

      expect(await vectorIn(fixture, active, beta)).toEqual(axis('beta'));
      expect(await keysUnder(fixture.durable, 'q:')).toEqual([]);
      const scores = await semanticScores(reloaded, 'beta');
      expect(scores.get(beta)).toBeCloseTo(1);
      expect(scores.get(alpha)).toBeCloseTo(0);
    });

    it('switches away from an active embedder that is not loaded, embedding every record into the new profile', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      const alpha = await writeNote(fixture.memory, 'alpha note');
      await started(fixture.memory);
      await advanceToEnd(fixture.memory);
      const unloaded = fixture.restart({
        embedders: registryWith(fake, false),
        initialEmbedder: HASHING_EMBEDDER_ID,
      });
      await unloaded.init();
      const beta = await writeNote(unloaded, 'beta note');

      const target = await started(unloaded, HASHING_EMBEDDER_ID);
      const gamma = await writeNote(unloaded, 'gamma note');
      await advanceToEnd(unloaded);

      const status = await unloaded.embedding.status();
      expect(status.active.embedder).toBe(HASHING_EMBEDDER_ID);
      expect(status.problem).toBeUndefined();
      expect(status.job).toBeUndefined();
      for (const id of [alpha, beta, gamma]) {
        expect(await vectorIn(fixture, target, id)).toHaveLength(target.dimension);
      }
    });

    it('embeds into the new active profile a record whose target embed failed after the last survey and before completion', async () => {
      const fake = new FakeEmbedder();
      const fixture = await fixtureWith(fake);
      await writeNote(fixture.memory, 'alpha note');
      const { store, hold } = holding(createMemoryVectorStore(fixture.durable), 'completeJob');
      const switching = fixture.restart({
        embedders: registryWith(fake),
        initialEmbedder: HASHING_EMBEDDER_ID,
        vectors: store,
      });
      await switching.init();
      const target = await started(fixture.memory);

      const advancing = switching.embedding.advance();
      await waitUntil(() => hold.entered, { message: 'the switch surveys and completes' });
      fake.failOnce('gamma note');
      const gamma = await writeNote(fixture.memory, 'gamma note');
      hold.release();
      await advancing;

      expect(await activeEmbedder(fixture.memory)).toBe(FAKE);
      expect(await vectorIn(fixture, target, gamma)).toBeUndefined();
      await fixture.memory.embedding.advance();

      expect(await vectorIn(fixture, target, gamma)).toEqual(axis('gamma'));
      expect(await keysUnder(fixture.durable, 'q:')).toEqual([]);
      const scores = await semanticScores(fixture.memory, 'gamma');
      expect(scores.get(gamma)).toBeCloseTo(1);
    });
  });
}
