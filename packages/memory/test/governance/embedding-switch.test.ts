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
 * | running              | the target embedder fails part-way      | `failed` with `error` (a code, never the embedder's text) and `done`; the target is deleted; recall keeps the previous one |
 * | running              | a batch of 100 is refused, each record alone is accepted | the batch is tried again one record per call (COR-2188); every record embeds and the switch completes |
 * | running              | a record fails alone, or a batch of one fails | `failed`, `embedder-failed` |
 * | running              | a batch times out                       | `failed`, `embedder-timeout`; the batch is not tried again, so the bound is waited on once |
 * | running              | cancel while the single calls of a retried batch run | `cancelled`, not rewritten as `target-missing` |
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
 * | none, active embedder needs setup, record write held | setup completes, another process advances, release | the young entry stays queued; the next advance embeds the record |
 * | none, an entry whose record was never stored | advance; then past the grace, restart, advance | kept while young; dropped once older than an admission can take |
 * | none, two queued, the first's embed keeps failing | advance with limit 1, twice; it stops failing, advance | the second is embedded on the second step; the first once it stops failing |
 * | none, active embedder needs setup | recall with `stages: ['semantic']`, minimum score 0, then 0.5 | ranked by text, `semantic` reported `unavailable`; only the match clears the minimum |
 */
import { sha256Hex } from '@lostgradient/cryptography';
import { MemoryStorage } from '@lostgradient/storage';
import type { Embedder } from 'armorer/testing';
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';

import {
  createEmbedderRegistry,
  type EmbedderRegistry,
  HASHING_EMBEDDER_ID,
  HASHING_EMBEDDER_MODEL,
} from '../../src/embedder-registry';
import { withEmbeddingCache } from '../../src/embedding-cache';
import {
  DEFAULT_SWITCH_BATCH_SIZE,
  QUEUED_EMBED_GRACE_MILLISECONDS,
} from '../../src/governance/embedding-switch';
import type { GovernedMemory } from '../../src/governance/governed-memory-types';
import { collectionNamespace } from '../../src/governance/record-governance';
import {
  DEFAULT_SWITCH_BATCH_SIZE as PUBLIC_SWITCH_BATCH_SIZE,
  DEFAULT_SWITCH_STEP_LIMIT as PUBLIC_SWITCH_STEP_LIMIT,
} from '../../src/index';
import type { MemoryRecordStorage } from '../../src/memory-record-storage';
import {
  createMemoryVectorStore,
  DEFAULT_MEMORY_VECTOR_KEY_PREFIX,
  type MemoryEmbeddingJob,
  type MemoryEmbeddingProfile,
  MemoryVectorProfileMissingError,
  type MemoryVectorReference,
  type MemoryVectorStore,
} from '../../src/memory-vector-store';
import type { MemoryRecord } from '../../src/types';
import {
  createGovernedFixture,
  type GovernedBackend,
  type GovernedFixture,
  principalA,
  recordIdOf,
} from './governed-memory-harness';

const FAKE = 'fake';
const FAKE_MODEL = 'fake-model';
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

/**
 * An 8-dimension embedder that records every text it is asked for, and each invocation's texts
 * (`batches`), and can hold, hang or fail one.
 */
class FakeEmbedder {
  readonly calls: string[] = [];
  /** The texts of each invocation, in order: one entry per call of the embedder, not per text. */
  readonly batches: string[][] = [];
  private readonly holds = new Map<string, { hold: Hold; released: Promise<void> }>();
  private failAtCall: number | undefined;
  private readonly failing = new Set<string>();
  private readonly alwaysFailing = new Set<string>();
  private readonly poisoned = new Set<string>();
  private readonly hanging = new Set<string>();
  private shortChanges = 0;
  private largestBatch: number | undefined;
  private nextHold: { hold: Hold; released: Promise<void> } | undefined;

  /** How many times the embedder was invoked, whatever the number of texts each invocation held. */
  get invocations(): number {
    return this.batches.length;
  }

  readonly embed: Embedder = async (texts) => {
    this.batches.push([...texts]);
    if (this.largestBatch !== undefined && texts.length > this.largestBatch) {
      // A provider's per-request cap: no text of the call is embedded, though each is within it alone.
      throw new Error(`The fake embedder refuses a call of more than ${this.largestBatch} texts.`);
    }
    const invalid = new Set<string>();
    for (const text of texts) {
      this.calls.push(text);
      // Ignores its signal, so only the bound on the embed ends the wait.
      if (this.hanging.has(text)) await new Promise<never>(() => undefined);
      if (
        this.calls.length === this.failAtCall ||
        this.failing.delete(text) ||
        this.alwaysFailing.has(text)
      ) {
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
    const vectors = texts.map((text) =>
      invalid.has(text) ? Array.from({ length: DIMENSION }, () => Number.NaN) : axis(text),
    );
    // A misbehaving embedder: one vector fewer than texts, for the next call that gets one.
    if (this.shortChanges > 0 && vectors.length > 1) {
      this.shortChanges -= 1;
      return vectors.slice(0, -1);
    }
    return vectors;
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

  /** Never answers a call that holds `text`: the call hangs until the embed's bound ends the wait. */
  hangOn(text: string): void {
    this.hanging.add(text);
  }

  /** Refuses every call of more than `count` texts, as a provider with a per-request cap does. */
  refuseCallsLargerThan(count: number): void {
    this.largestBatch = count;
  }

  /** Answers the next call that holds more than one text with one vector fewer than texts. */
  answerShortOnce(): void {
    this.shortChanges += 1;
  }

  /** Fails the next call for `text`, once. */
  failOnce(text: string): void {
    this.failing.add(text);
  }

  /** Fails every call for `text` until {@link FakeEmbedder.stopFailing} is called for it. */
  failAlways(text: string): void {
    this.alwaysFailing.add(text);
  }

  stopFailing(text: string): void {
    this.alwaysFailing.delete(text);
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
    ...(withFake ? [{ id: FAKE, embedder, dimension: DIMENSION, model: FAKE_MODEL }] : []),
    {
      id: NEEDS_SETUP,
      embedder: fake.embed,
      dimension: DIMENSION,
      model: FAKE_MODEL,
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

/** A registry whose only contributed embedder is `fake`, with an availability the test sets. */
function togglingRegistry(fake: FakeEmbedder): {
  readonly embedders: EmbedderRegistry;
  setAvailability(availability: 'available' | 'needs-setup'): void;
} {
  let current: 'available' | 'needs-setup' = 'available';
  return {
    embedders: createEmbedderRegistry([
      {
        id: FAKE,
        embedder: fake.embed,
        dimension: DIMENSION,
        model: FAKE_MODEL,
        availability: () => current,
      },
    ]),
    setAvailability(availability) {
      current = availability;
    },
  };
}

/** `storage`, with its next `put` held until the returned hold is released. */
function holdingPut(storage: MemoryRecordStorage): {
  readonly storage: MemoryRecordStorage;
  readonly hold: Hold;
} {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hold: Hold = { entered: false, release: () => release() };
  return {
    hold,
    storage: new Proxy(storage, {
      get(target, key) {
        if (key === 'put') {
          return async (record: MemoryRecord) => {
            if (!hold.entered) {
              hold.entered = true;
              await released;
            }
            await target.put(record);
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
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
    async function fixtureWith(
      fake: FakeEmbedder,
      governed: { readonly embedTimeoutMilliseconds?: number } = {},
    ): Promise<GovernedFixture> {
      return createGovernedFixture(backend, {
        governed: {
          embedders: registryWith(fake),
          initialEmbedder: HASHING_EMBEDDER_ID,
          ...governed,
        },
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
      expect(target).toEqual({
        embedderId: FAKE,
        dimension: DIMENSION,
        generation: 2,
        model: FAKE_MODEL,
      });
      await advanceToEnd(fixture.memory);

      expect(await fixture.memory.embedding.status()).toEqual({
        active: { embedder: FAKE, dimension: DIMENSION, model: FAKE_MODEL },
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
        active: {
          embedder: HASHING_EMBEDDER_ID,
          dimension: previous.dimension,
          model: HASHING_EMBEDDER_MODEL,
        },
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
        active: { embedder: FAKE, dimension: DIMENSION, model: FAKE_MODEL },
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
      // Two records embed in one batch; the third is the next batch, which fails.
      await fixture.memory.embedding.advance({ limit: 2 });

      const status = await fixture.memory.embedding.advance();

      expect(status.active.embedder).toBe(HASHING_EMBEDDER_ID);
      expect(status.job).toMatchObject({ target: FAKE, state: 'failed', done: 2, total: 3 });
      // A code, never the text the embedder gave (COR-2188).
      expect(status.job?.error).toBe('embedder-failed');
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
        active: { embedder: FAKE, dimension: DIMENSION, model: FAKE_MODEL },
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
      expect(status.job?.error).toBe('embedder-failed');
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
        active: { embedder: FAKE, dimension: DIMENSION, model: FAKE_MODEL },
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
        active: { embedder: FAKE, dimension: DIMENSION, model: FAKE_MODEL },
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

    /** A fixture whose initial, active embedder is the fake, with an availability the test sets. */
    async function togglingFixture(
      fake: FakeEmbedder,
      governed: { readonly embedTimeoutMilliseconds?: number } = {},
    ) {
      const toggling = togglingRegistry(fake);
      const fixture = await createGovernedFixture(backend, {
        governed: { embedders: toggling.embedders, initialEmbedder: FAKE, ...governed },
      });
      const profile: MemoryEmbeddingProfile = {
        embedderId: FAKE,
        dimension: DIMENSION,
        generation: 1,
        model: FAKE_MODEL,
      };
      return { fixture, profile, setAvailability: toggling.setAvailability };
    }

    it('keeps the queue entry of an admission an advance read before its record was stored, and embeds it', async () => {
      const fake = new FakeEmbedder();
      const { fixture, profile, setAvailability } = await togglingFixture(fake);
      await writeNote(fixture.memory, 'alpha note');
      const { storage, hold } = holdingPut(fixture.storage);
      const admitting = fixture.restart({ storage });
      await admitting.init();

      setAvailability('needs-setup');
      const writing = writeNote(admitting, 'beta note');
      await waitUntil(() => hold.entered, {
        message: 'the admission queues its record and holds the record write',
      });
      setAvailability('available');
      // Another process advances while the record is queued and not yet stored.
      await fixture.memory.embedding.advance();
      hold.release();
      const beta = await writing;
      await fixture.memory.embedding.advance();

      expect(await vectorIn(fixture, profile, beta)).toEqual(axis('beta'));
      expect(await keysUnder(fixture.durable, 'q:')).toEqual([]);
    });

    it('drops the queue entry of an admission that stopped before storing its record, once it is older than an admission can take', async () => {
      const fake = new FakeEmbedder();
      const { fixture, profile } = await togglingFixture(fake);
      await writeNote(fixture.memory, 'alpha note');
      const queued = await vectorsOf(fixture).enqueueEmbed(
        profile,
        referenceTo('memory-never-stored'),
        fixture.runtime.clock.now(),
      );
      expect(queued).toBe(true);

      await fixture.memory.embedding.advance();
      expect(await keysUnder(fixture.durable, 'q:')).toHaveLength(1);

      await fixture.runtime.advance(QUEUED_EMBED_GRACE_MILLISECONDS + 1);
      const restarted = fixture.restart();
      await restarted.init();
      await restarted.embedding.advance();
      expect(await keysUnder(fixture.durable, 'q:')).toEqual([]);
    });

    it('attempts every queued embed in turn, so an entry whose embed keeps failing never holds back the next', async () => {
      const fake = new FakeEmbedder();
      const { fixture, profile, setAvailability } = await togglingFixture(fake);
      setAvailability('needs-setup');
      const written = [
        { id: await writeNote(fixture.memory, 'alpha note'), content: 'alpha note' },
        { id: await writeNote(fixture.memory, 'beta note'), content: 'beta note' },
      ];
      const queued = await keysUnder(fixture.durable, 'q:');
      expect(queued).toHaveLength(2);
      // Key order decides which entry a step reads first.
      const [front, back] = queued[0]!.endsWith(`:r:${written[0]!.id}`)
        ? [written[0]!, written[1]!]
        : [written[1]!, written[0]!];
      setAvailability('available');
      fake.failAlways(front.content);

      await fixture.memory.embedding.advance({ limit: 1 });
      await fixture.memory.embedding.advance({ limit: 1 });
      expect(await vectorIn(fixture, profile, back.id)).toEqual(axis(back.content));
      expect(await vectorIn(fixture, profile, front.id)).toBeUndefined();

      fake.stopFailing(front.content);
      await fixture.memory.embedding.advance({ limit: 1 });
      expect(await vectorIn(fixture, profile, front.id)).toEqual(axis(front.content));
      expect(await keysUnder(fixture.durable, 'q:')).toEqual([]);
    });

    /** COR-2187: a step embeds in batches of `DEFAULT_SWITCH_BATCH_SIZE`, never past its limit. */
    describe('in batches', () => {
      /** What an embed may take before its bound ends it; time is driven by hand to reach it. */
      const BOUND = 6000;

      async function writeNotes(memory: GovernedMemory, count: number): Promise<string[]> {
        const ids: string[] = [];
        for (let index = 0; index < count; index++) {
          ids.push(await writeNote(memory, `note ${index}`));
        }
        return ids;
      }

      const sizesOf = (fake: FakeEmbedder) => fake.batches.map((batch) => batch.length);

      /** What a promise has come to, read without waiting on it. */
      function observe<T>(promise: Promise<T>) {
        const outcome: { settled: boolean } = { settled: false };
        const settle = () => {
          outcome.settled = true;
        };
        promise.then(settle, settle);
        return outcome;
      }

      it('exports a batch size of 100, beside the step limit', () => {
        expect(DEFAULT_SWITCH_BATCH_SIZE).toBe(100);
        expect(PUBLIC_SWITCH_BATCH_SIZE).toBe(DEFAULT_SWITCH_BATCH_SIZE);
        expect(PUBLIC_SWITCH_STEP_LIMIT).toBe(500);
      });

      it('embeds 500 pending records in 5 calls of 100, whatever the step limit names', async () => {
        const fake = new FakeEmbedder();
        const fixture = await fixtureWith(fake);
        await writeNotes(fixture.memory, 500);
        await started(fixture.memory);

        const status = await fixture.memory.embedding.advance({ limit: 500 });

        expect(fake.invocations).toBe(5);
        expect(sizesOf(fake)).toEqual([100, 100, 100, 100, 100]);
        expect(status.job).toMatchObject({ state: 'running', done: 500, total: 500 });
        // The step used its limit, so completing is the next one's, and it embeds nothing.
        await advanceToEnd(fixture.memory);
        expect(fake.invocations).toBe(5);
        expect(await activeEmbedder(fixture.memory)).toBe(FAKE);
      });

      it('never takes a batch past the step limit, and the next step takes the rest', async () => {
        const fake = new FakeEmbedder();
        const fixture = await fixtureWith(fake);
        await writeNotes(fixture.memory, 250);
        await started(fixture.memory);

        const first = await fixture.memory.embedding.advance({ limit: 150 });
        expect(sizesOf(fake)).toEqual([100, 50]);
        expect(first.job).toMatchObject({ done: 150, total: 250 });

        const second = await fixture.memory.embedding.advance({ limit: 150 });
        expect(sizesOf(fake)).toEqual([100, 50, 100]);
        // The step did not use its limit, so it found nothing pending and completed the switch.
        expect(second.job).toBeUndefined();
        expect(second.active.embedder).toBe(FAKE);
        // Nothing was embedded twice.
        expect(new Set(fake.calls).size).toBe(250);
      });

      it('tries a batch the embedder refuses again one record per call, and every record then embeds (COR-2188)', async () => {
        const fake = new FakeEmbedder();
        const fixture = await fixtureWith(fake);
        const ids = await writeNotes(fixture.memory, DEFAULT_SWITCH_BATCH_SIZE);
        const target = await started(fixture.memory);
        // A provider's per-request cap: the batch of 100 is refused, though each text is within it.
        fake.refuseCallsLargerThan(1);

        const status = await fixture.memory.embedding.advance();

        // The refused batch, then each record alone, in the order the batch listed them.
        expect(sizesOf(fake)).toEqual([DEFAULT_SWITCH_BATCH_SIZE, ...ids.map(() => 1)]);
        expect(status.job).toBeUndefined();
        expect(status.active.embedder).toBe(FAKE);
        for (const id of ids) expect(await vectorIn(fixture, target, id)).toBeDefined();
      });

      it('counts the records its single calls held, so the switch resumes where it stopped', async () => {
        const fake = new FakeEmbedder();
        const fixture = await fixtureWith(fake);
        await writeNotes(fixture.memory, 3);
        await started(fixture.memory);
        fake.refuseCallsLargerThan(1);

        const first = await fixture.memory.embedding.advance({ limit: 3 });

        expect(first.job).toMatchObject({ state: 'running', done: 3, total: 3 });
        expect(await fixture.memory.embedding.advance()).toMatchObject({
          active: { embedder: FAKE },
        });
      });

      it('fails the switch when a record fails alone, as a batch of one does, naming a code', async () => {
        const fake = new FakeEmbedder();
        const fixture = await fixtureWith(fake);
        for (const word of ['alpha', 'beta', 'gamma'])
          await writeNote(fixture.memory, `${word} note`);
        const previous = (await vectorsOf(fixture).getActiveProfile())!;
        await started(fixture.memory);
        fake.failAlways('beta note');

        const status = await fixture.memory.embedding.advance();

        // The batch of three, then the records alone up to the one that fails alone.
        expect(sizesOf(fake)[0]).toBe(3);
        expect(
          sizesOf(fake)
            .slice(1)
            .every((size) => size === 1),
        ).toBe(true);
        expect(status.active.embedder).toBe(HASHING_EMBEDDER_ID);
        expect(status.job).toMatchObject({ target: FAKE, state: 'failed', done: 0, total: 3 });
        expect(status.job?.error).toBe('embedder-failed');
        expect(JSON.stringify(status)).not.toContain('refused');
        expect(await vectorsOf(fixture).listProfiles()).toEqual([previous]);
      });

      it('retries a failed switch by starting it again, which embeds every record', async () => {
        const fake = new FakeEmbedder();
        const fixture = await fixtureWith(fake);
        const ids: string[] = [];
        for (const word of ['alpha', 'beta', 'gamma']) {
          ids.push(await writeNote(fixture.memory, `${word} note`));
        }
        await started(fixture.memory);
        fake.failAlways('beta note');
        const failed = await fixture.memory.embedding.advance();
        expect(failed.job?.state).toBe('failed');
        fake.stopFailing('beta note');

        const target = await started(fixture.memory);
        await advanceToEnd(fixture.memory);

        expect(await activeEmbedder(fixture.memory)).toBe(FAKE);
        for (const id of ids) expect(await vectorIn(fixture, target, id)).toBeDefined();
      });

      it('tries a batch answered with the wrong number of vectors again one record per call, pairing each vector with its record', async () => {
        const fake = new FakeEmbedder();
        const fixture = await fixtureWith(fake);
        const ids: string[] = [];
        for (const word of ['alpha', 'beta', 'gamma']) {
          ids.push(await writeNote(fixture.memory, `${word} note`));
        }
        const target = await started(fixture.memory);
        fake.answerShortOnce();

        const status = await fixture.memory.embedding.advance();

        expect(sizesOf(fake)).toEqual([3, 1, 1, 1]);
        expect(status.job).toBeUndefined();
        expect(status.active.embedder).toBe(FAKE);
        expect(await vectorIn(fixture, target, ids[0]!)).toEqual(axis('alpha'));
        expect(await vectorIn(fixture, target, ids[1]!)).toEqual(axis('beta'));
        expect(await vectorIn(fixture, target, ids[2]!)).toEqual(axis('gamma'));
      });

      it('does not try a timed-out batch again one record per call, so the bound is waited on once', async () => {
        const fake = new FakeEmbedder();
        const fixture = await fixtureWith(fake, { embedTimeoutMilliseconds: BOUND });
        await writeNotes(fixture.memory, 5);
        await started(fixture.memory);
        for (let index = 0; index < 5; index++) fake.hangOn(`note ${index}`);

        const outcome = observe(fixture.memory.embedding.advance());
        await waitUntil(() => fake.invocations > 0, { message: 'the switch embeds its batch' });
        await fixture.runtime.advance(BOUND);
        await waitUntil(() => outcome.settled, { message: 'the advance to settle' });

        expect(fake.invocations).toBe(1);
        const status = await fixture.memory.embedding.status();
        expect(status.job).toMatchObject({ state: 'failed', error: 'embedder-timeout' });
      });

      it('leaves a switch cancelled while its single calls ran `cancelled`, not failed as `target-missing`', async () => {
        const fake = new FakeEmbedder();
        const fixture = await fixtureWith(fake);
        await writeNotes(fixture.memory, 3);
        const target = await started(fixture.memory);
        fake.refuseCallsLargerThan(1);
        // The first single call is held: the batch was refused and the retry is under way.
        const hold = fake.holdNext();

        const advancing = fixture.memory.embedding.advance();
        await waitUntil(() => hold.entered, { message: 'the retry embeds its first record' });
        expect(await fixture.memory.embedding.cancel()).toBe(true);
        hold.release();
        await advancing;

        const status = await fixture.memory.embedding.status();
        expect(status.job).toMatchObject({ target: FAKE, state: 'cancelled' });
        expect(await vectorsOf(fixture).listProfiles()).not.toContainEqual(target);
        expect(status.active.embedder).toBe(HASHING_EMBEDDER_ID);
      });

      it('withdraws the vector of a record deleted while its batch was in flight, and counts only the records held', async () => {
        const fake = new FakeEmbedder();
        const fixture = await fixtureWith(fake);
        const alpha = await writeNote(fixture.memory, 'alpha note');
        const beta = await writeNote(fixture.memory, 'beta note');
        const gamma = await writeNote(fixture.memory, 'gamma note');
        const target = await started(fixture.memory);
        const hold = fake.holdNext();

        const advancing = fixture.memory.embedding.advance({ limit: 3 });
        await waitUntil(() => hold.entered, { message: 'the switch embeds its batch' });
        await forgetNote(fixture.memory, beta);
        hold.release();
        const status = await advancing;

        expect(fake.invocations).toBe(1);
        expect(await vectorIn(fixture, target, beta)).toBeUndefined();
        expect(await vectorIn(fixture, target, alpha)).toEqual(axis('alpha'));
        expect(await vectorIn(fixture, target, gamma)).toEqual(axis('gamma'));
        expect(status.job).toMatchObject({ state: 'running', done: 2, total: 3 });
      });

      /** `store`, whose `put` number `failAt` throws `error` instead of storing, and the others store. */
      function failingPut(store: MemoryVectorStore, failAt: number, error: Error) {
        let puts = 0;
        return {
          ...store,
          async put(...entry: Parameters<MemoryVectorStore['put']>) {
            puts += 1;
            if (puts === failAt) throw error;
            return store.put(...entry);
          },
        } satisfies MemoryVectorStore;
      }

      it('keeps the records a batch stored before a write failed, and embeds only the others on the next step', async () => {
        const fake = new FakeEmbedder();
        const fixture = await fixtureWith(fake);
        for (const word of ['alpha', 'beta', 'gamma'])
          await writeNote(fixture.memory, `${word} note`);
        await started(fixture.memory);
        const flaky = fixture.restart({
          embedders: registryWith(fake),
          initialEmbedder: HASHING_EMBEDDER_ID,
          vectors: failingPut(
            createMemoryVectorStore(fixture.durable),
            2,
            new Error('The storage stopped while writing a vector.'),
          ),
        });
        await flaky.init();

        const failure = await rejectionOf(flaky.embedding.advance());

        // The batch embedded all three; the first write stored its vector and the second failed.
        expect(String(failure)).toContain('The storage stopped');
        expect(fake.batches).toHaveLength(1);
        const interrupted = await fixture.memory.embedding.status();
        expect(interrupted.job).toMatchObject({ state: 'running', done: 0, total: 3 });

        // The target profile is the checkpoint: the next step counts the vector that was stored and
        // embeds the two records that lack one, and no other.
        await advanceToEnd(fixture.memory);
        expect(await activeEmbedder(fixture.memory)).toBe(FAKE);
        expect(sizesOf(fake)).toEqual([3, 2]);
      });

      it('fails the switch when the target is deleted part-way through a batch’s writes', async () => {
        const fake = new FakeEmbedder();
        const fixture = await fixtureWith(fake);
        for (const word of ['alpha', 'beta', 'gamma'])
          await writeNote(fixture.memory, `${word} note`);
        const previous = (await vectorsOf(fixture).getActiveProfile())!;
        const target = await started(fixture.memory);
        const vanishing = fixture.restart({
          embedders: registryWith(fake),
          initialEmbedder: HASHING_EMBEDDER_ID,
          vectors: failingPut(
            createMemoryVectorStore(fixture.durable),
            2,
            new MemoryVectorProfileMissingError(target),
          ),
        });
        await vanishing.init();

        const status = await vanishing.embedding.advance();

        expect(status.job).toMatchObject({ state: 'failed', error: 'target-missing', done: 0 });
        expect(status.active.embedder).toBe(HASHING_EMBEDDER_ID);
        expect(await vectorsOf(fixture).listProfiles()).toEqual([previous]);
      });

      it('ends at the first batch that times out, failing the switch and leaving no timer behind', async () => {
        const fake = new FakeEmbedder();
        const fixture = await fixtureWith(fake, { embedTimeoutMilliseconds: BOUND });
        await writeNotes(fixture.memory, 150);
        await started(fixture.memory);
        // Records are batched in the order the store lists them, so any batch may come first.
        for (let index = 0; index < 150; index++) fake.hangOn(`note ${index}`);
        const timersBefore = fixture.runtime.pendingTimers().length;

        const outcome = observe(fixture.memory.embedding.advance());
        await waitUntil(() => fake.invocations > 0, { message: 'the switch embeds its batch' });
        expect(outcome.settled).toBe(false);
        await fixture.runtime.advance(BOUND);
        await waitUntil(() => outcome.settled, { message: 'the advance to settle' });

        const status = await fixture.memory.embedding.status();
        expect(status.job).toMatchObject({ target: FAKE, state: 'failed' });
        expect(status.job?.error).toBe('embedder-timeout');
        expect(fake.invocations).toBe(1);
        expect(fixture.runtime.pendingTimers().length).toBe(timersBefore);
      });

      describe('the queue drain', () => {
        /** `count` notes written while the active embedder needs setup, so each is queued. */
        async function queuedNotes(
          count: number,
          options: { readonly embedTimeoutMilliseconds?: number } = {},
        ) {
          const fake = new FakeEmbedder();
          const toggling = await togglingFixture(fake, options);
          toggling.setAvailability('needs-setup');
          const ids: string[] = [];
          for (let index = 0; index < count; index++) {
            ids.push(await writeNote(toggling.fixture.memory, `note ${index}`));
          }
          expect(await keysUnder(toggling.fixture.durable, 'q:')).toHaveLength(count);
          toggling.setAvailability('available');
          return { fake, ids, ...toggling };
        }

        it('embeds 250 queued records in 3 calls of 100, 100 and 50', async () => {
          const { fake, fixture, profile, ids } = await queuedNotes(250);

          await fixture.memory.embedding.advance({ limit: 250 });

          expect(sizesOf(fake)).toEqual([100, 100, 50]);
          expect(fake.invocations).toBe(3);
          for (const id of ids) expect(await vectorIn(fixture, profile, id)).toBeDefined();
          expect(await keysUnder(fixture.durable, 'q:')).toEqual([]);
        });

        it('embeds a queued record the step limit reaches and no other', async () => {
          const { fake, fixture } = await queuedNotes(150);

          await fixture.memory.embedding.advance({ limit: 120 });

          expect(sizesOf(fake)).toEqual([100, 20]);
          expect(await keysUnder(fixture.durable, 'q:')).toHaveLength(30);
        });

        it('retries a batch that failed one entry per call, so one bad entry holds back no other', async () => {
          const { fake, fixture, profile, ids } = await queuedNotes(3);
          fake.failAlways('note 1');

          await fixture.memory.embedding.advance();

          // The batch of three, then each entry alone: the entry that fails stays queued.
          expect(fake.batches[0]).toHaveLength(3);
          expect(
            fake.batches
              .slice(1)
              .map((batch) => batch.join())
              .toSorted(),
          ).toEqual(['note 0', 'note 1', 'note 2']);
          expect(await vectorIn(fixture, profile, ids[0]!)).toBeDefined();
          expect(await vectorIn(fixture, profile, ids[1]!)).toBeUndefined();
          expect(await vectorIn(fixture, profile, ids[2]!)).toBeDefined();
          const queued = await keysUnder(fixture.durable, 'q:');
          expect(queued).toHaveLength(1);
          expect(queued[0]).toEndWith(`:r:${ids[1]}`);

          // A later step embeds it once it stops failing, in a call of its own.
          fake.stopFailing('note 1');
          await fixture.memory.embedding.advance();
          expect(fake.batches.at(-1)).toEqual(['note 1']);
          expect(await vectorIn(fixture, profile, ids[1]!)).toBeDefined();
          expect(await keysUnder(fixture.durable, 'q:')).toEqual([]);
        });

        it('does not retry a batch of one, whose call already was the entry’s own', async () => {
          const { fake, fixture } = await queuedNotes(1);
          fake.failAlways('note 0');

          await fixture.memory.embedding.advance();

          expect(fake.invocations).toBe(1);
          expect(await keysUnder(fixture.durable, 'q:')).toHaveLength(1);
        });

        it('stops at the first batch that times out, keeping every entry queued and waiting on no other', async () => {
          const { fake, fixture, ids } = await queuedNotes(150, {
            embedTimeoutMilliseconds: BOUND,
          });
          for (let index = 0; index < 150; index++) fake.hangOn(`note ${index}`);
          const timersBefore = fixture.runtime.pendingTimers().length;

          const outcome = observe(fixture.memory.embedding.advance({ limit: 150 }));
          await waitUntil(() => fake.invocations > 0, { message: 'the drain embeds its batch' });
          expect(outcome.settled).toBe(false);
          await fixture.runtime.advance(BOUND);
          await waitUntil(() => outcome.settled, { message: 'the advance to settle' });

          expect(fake.invocations).toBe(1);
          expect(await keysUnder(fixture.durable, 'q:')).toHaveLength(ids.length);
          expect(fixture.runtime.pendingTimers().length).toBe(timersBefore);
        });

        it('does not retry a batch that timed out one entry per call', async () => {
          const { fake, fixture } = await queuedNotes(3, { embedTimeoutMilliseconds: BOUND });
          fake.hangOn('note 1');

          const outcome = observe(fixture.memory.embedding.advance());
          await waitUntil(() => fake.invocations > 0, { message: 'the drain embeds its batch' });
          await fixture.runtime.advance(BOUND);
          await waitUntil(() => outcome.settled, { message: 'the advance to settle' });

          expect(fake.invocations).toBe(1);
          expect(await keysUnder(fixture.durable, 'q:')).toHaveLength(3);
        });

        it('leaves every entry of a batch answered with the wrong number of vectors queued, then embeds them one at a time', async () => {
          const { fake, fixture, profile, ids } = await queuedNotes(3);
          fake.answerShortOnce();

          await fixture.memory.embedding.advance();

          // The short answer is a failed batch, so each entry is tried alone, and each succeeds.
          expect(fake.batches[0]).toHaveLength(3);
          expect(fake.invocations).toBe(4);
          for (const id of ids) expect(await vectorIn(fixture, profile, id)).toBeDefined();
          expect(await keysUnder(fixture.durable, 'q:')).toEqual([]);
        });
      });
    });

    it('scores a semantic-only recall by text while the active embedder is unavailable, and reports semantic unavailable', async () => {
      const fake = new FakeEmbedder();
      const { fixture, setAvailability } = await togglingFixture(fake);
      // Written oldest first, so a recall that ignored the query would rank beta last.
      const beta = await writeNote(fixture.memory, 'beta note');
      await fixture.runtime.advance(1_000);
      await writeNote(fixture.memory, 'alpha note');
      await fixture.runtime.advance(1_000);
      await writeNote(fixture.memory, 'gamma note');
      setAvailability('needs-setup');

      const ranked = await fixture.memory.recallForModel(principalA, 'beta', {
        collection: 'notes',
        plan: { stages: ['semantic'] },
      });
      expect(ranked.stopReason).not.toBe('failed');
      expect(ranked.evidence.map((evidence) => evidence.id)[0]).toBe(beta);
      expect(ranked.evidence).toHaveLength(3);
      expect(ranked.stages.find((report) => report.stage === 'semantic')?.status).toBe(
        'unavailable',
      );

      const thresholded = await fixture.memory.recallForModel(principalA, 'beta', {
        collection: 'notes',
        plan: { stages: ['semantic'], minimumScore: 0.5 },
      });
      expect(thresholded.stopReason).not.toBe('failed');
      expect(thresholded.evidence.map((evidence) => evidence.id)).toEqual([beta]);
    });
  });
}
