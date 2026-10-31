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
 */
import type { Embedder } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';

import {
  createEmbedderRegistry,
  type EmbedderRegistry,
  HASHING_EMBEDDER_ID,
} from '../../src/embedder-registry';
import type { GovernedMemory } from '../../src/governance/governed-memory-types';
import { collectionNamespace } from '../../src/governance/record-governance';
import {
  createMemoryVectorStore,
  DEFAULT_MEMORY_VECTOR_KEY_PREFIX,
  type MemoryEmbeddingProfile,
  type MemoryVectorReference,
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

  readonly embed: Embedder = async (texts) => {
    for (const text of texts) {
      this.calls.push(text);
      if (this.calls.length === this.failAtCall || this.failing.delete(text)) {
        throw new Error(`The fake embedder refused "${text}".`);
      }
      const held = this.holds.get(text);
      if (held !== undefined) {
        this.holds.delete(text);
        held.hold.entered = true;
        await held.released;
      }
    }
    return texts.map(axis);
  };

  /** Holds the next call for `text` until the returned hold is released. */
  hold(text: string): Hold {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold: Hold = { entered: false, release: () => release() };
    this.holds.set(text, { hold, released });
    return hold;
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

function registryWith(fake: FakeEmbedder, withFake = true): EmbedderRegistry {
  return createEmbedderRegistry([
    ...(withFake ? [{ id: FAKE, embedder: fake.embed, dimension: DIMENSION }] : []),
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
  });
}
