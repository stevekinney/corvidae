/**
 * COR-2184 — the active embedding records the embedder's model, so an embedder reconfigured to
 * another model under its own id is a different embedding, and a store written before the model
 * existed (version 1, written by the code on main) still opens, recalls and switches.
 *
 * Outcome matrix, stored profile × event → required result (each row is a test below):
 *
 * | Stored profile                         | Event                                         | Required result |
 * | -------------------------------------- | --------------------------------------------- | --------------- |
 * | model A, embedder registered with A    | status                                        | no problem; `active.model` is A |
 * | model A, embedder now registered with B| restart, status, recall, admit                | `problem: 'embedder-unavailable'`, recall by text with `semantic` unavailable, the admission queued, never embedded with B |
 * | model A, now registered with B         | `switchTo` the same id                        | `started`, the target carries B; advance completes into a profile with B |
 * | model A, still registered with A       | `switchTo` the same id                        | refused `already-active` |
 * | model A, same id registered at another dimension | `switchTo` the same id              | `started` (the id alone no longer decides) |
 * | version 1, embedder registered         | restart, recall, admit, then `init`           | opens and recalls with no model; `init` adopts the registered model; the vectors are still found |
 * | version 1, embedder registered         | switch without `init`                         | starts (a job from a profile with no model into one with a model), advances, completes |
 * | version 1, a switch running            | restart, advance                              | resumes and completes, not `target-unavailable` |
 * | version 1, embedder not registered     | `init`, status                                | nothing adopted; `embedder-unavailable`, no `model` |
 * | version 1, embedder at another dimension | `init`, status                              | nothing adopted; `embedder-unavailable`, no `model` |
 * | version 1, two processes               | `init` together                               | one swap wins; one consistent profile |
 * | version 1, the process stops before the write | `init`                                 | the store is as it was: readable; a later `init` adopts |
 * | version 1, a failed switch with the free text main stored | `switchTo`      | the record is read as written, so a new switch starts over it |
 */
import type { Embedder } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';

import { createEmbedderRegistry, HASHING_EMBEDDER_ID } from '../../src/embedder-registry';
import type {
  CreateGovernedMemoryOptions,
  GovernedMemory,
} from '../../src/governance/governed-memory-types';
import { collectionNamespace } from '../../src/governance/record-governance';
import {
  createMemoryVectorStore,
  type MemoryEmbeddingProfile,
  type MemoryVectorStore,
} from '../../src/memory-vector-store';
import {
  intercepting,
  seedVersion1,
  snapshotVectorStore,
  textAt,
  version1,
} from '../vector-store-version-1';
import {
  createGovernedFixture,
  type GovernedFixture,
  principalA,
  recordIdOf,
} from './governed-memory-harness';

const DIMENSION = 8;
const OLLAMA = 'ollama:embed';
const LEGACY_ID = 'legacy-embed';
const ONE_HOT = Array.from({ length: DIMENSION }, (_, index) => (index === 0 ? 1 : 0));
const embed: Embedder = (texts) => texts.map(() => ONE_HOT);
const ACTIVE = `${version1.prefix}active`;
const NOTES_SCOPE = {
  tenantId: principalA.tenantId,
  namespace: collectionNamespace('private', principalA.ownerId, 'notes'),
};

type Options = Pick<CreateGovernedMemoryOptions, 'embedders' | 'initialEmbedder'>;

/** One embedder registered as `id`, which memory starts with. */
function registered(id: string, model: string, dimension = DIMENSION): Options {
  return {
    embedders: createEmbedderRegistry([{ id, embedder: embed, dimension, model }]),
    initialEmbedder: id,
  };
}

/** The profile records (`active` and the `p:` markers) of the vector store, in key order. */
const profileRecordsOf = (snapshot: Record<string, string>) =>
  Object.entries(snapshot).filter(
    ([key]) => key === ACTIVE || key.startsWith(`${version1.prefix}p:`),
  );

const profileRecords = async (fixture: GovernedFixture) =>
  profileRecordsOf(await snapshotVectorStore(fixture.durable));

const write = (memory: GovernedMemory, content: string) =>
  memory.write(principalA, content, { collection: 'notes', source: 'conversation' });

/** Whether the semantic stage of a recall ran or was `unavailable`. */
async function semantic(memory: GovernedMemory) {
  const bundle = await memory.recallForModel(principalA, 'seat', {
    collection: 'notes',
    plan: { stages: ['semantic'] },
  });
  return bundle.stages.find((report) => report.stage === 'semantic')?.status;
}

/** The model `memory` reports for its active embedding. */
async function modelOf(memory: GovernedMemory) {
  const { active } = await memory.embedding.status();
  return active.model;
}

/** The problem `memory` reports with its active embedding, if any. */
async function problemOf(memory: GovernedMemory) {
  const { problem } = await memory.embedding.status();
  return problem;
}

/** How many of `ids` the profile holds a vector for. */
async function heldCount(
  vectors: MemoryVectorStore,
  profile: MemoryEmbeddingProfile,
  ids: readonly string[],
) {
  const found = await vectors.getMany(profile, NOTES_SCOPE, ids);
  return found.size;
}

/** The ids of the records queued for `profile`. */
async function queuedIds(vectors: MemoryVectorStore, profile: MemoryEmbeddingProfile) {
  const queued = await vectors.listQueuedEmbeds(profile, 10);
  return queued.map((entry) => entry.reference.id);
}

/** The vectors the active profile holds for `ids`. */
async function heldByActive(vectors: MemoryVectorStore, ids: readonly string[]) {
  const profile = await vectors.getActiveProfile();
  return heldCount(vectors, profile!, ids);
}

/** Advances until the switch is no longer running, which takes one step for a store this small. */
async function finishSwitch(memory: GovernedMemory) {
  for (;;) {
    const status = await memory.embedding.advance();
    if (status.job?.state !== 'running') return status;
  }
}

describe('an embedder reconfigured to another model under its own id (COR-2184)', () => {
  /** Memory with a record embedded by model A, and the same memory restarted on model B. */
  async function afterModelChange() {
    const fixture = await createGovernedFixture('in-memory', {
      governed: registered(OLLAMA, 'model-a'),
    });
    const stored = await recordIdOf(write(fixture.memory, 'The user prefers an aisle seat.'));
    const restarted = fixture.restart(registered(OLLAMA, 'model-b'));
    await restarted.init();
    return { fixture, restarted, stored };
  }

  it('reports the model the profile was made with, and no problem while the embedder still runs it', async () => {
    const fixture = await createGovernedFixture('in-memory', {
      governed: registered(OLLAMA, 'model-a'),
    });
    expect(await fixture.memory.embedding.status()).toEqual({
      active: { embedder: OLLAMA, dimension: DIMENSION, model: 'model-a' },
    });
    expect(await semantic(fixture.memory)).not.toBe('unavailable');
  });

  it('is `embedder-unavailable`: recall is by text, and an admission waits in the queue (AC3)', async () => {
    const { fixture, restarted, stored } = await afterModelChange();

    expect(await restarted.embedding.status()).toEqual({
      active: { embedder: OLLAMA, dimension: DIMENSION, model: 'model-a' },
      problem: 'embedder-unavailable',
    });
    expect(await semantic(restarted)).toBe('unavailable');

    const receipt = await write(restarted, 'Another note about the seat.');
    expect(receipt.status).toBe('admitted');
    // Never embedded with model B into model A's profile: the entry is queued for a later switch.
    const vectors = createMemoryVectorStore(fixture.durable);
    const profile = (await vectors.getActiveProfile())!;
    expect(await queuedIds(vectors, profile)).toEqual([receipt.recordId!]);
    expect(await heldCount(vectors, profile, [receipt.recordId!])).toBe(0);
    // The record embedded under model A is still there, and still not served.
    expect(await heldCount(vectors, profile, [stored])).toBe(1);
  });

  it('switches to the same id: `started`, and an advance completes into a profile with model B (AC4)', async () => {
    const { fixture, restarted, stored } = await afterModelChange();

    const result = await restarted.embedding.switchTo(OLLAMA);
    expect(result).toMatchObject({
      outcome: 'started',
      target: { embedderId: OLLAMA, dimension: DIMENSION, model: 'model-b', generation: 2 },
    });
    const status = await finishSwitch(restarted);
    expect(status).toEqual({
      active: { embedder: OLLAMA, dimension: DIMENSION, model: 'model-b' },
    });

    const vectors = createMemoryVectorStore(fixture.durable);
    const profile = (await vectors.getActiveProfile())!;
    expect(profile).toEqual({
      embedderId: OLLAMA,
      dimension: DIMENSION,
      generation: 2,
      model: 'model-b',
    });
    expect(await heldCount(vectors, profile, [stored])).toBe(1);
    expect(await semantic(restarted)).not.toBe('unavailable');
    // Model A's profile is the previous one and stays until the next switch completes.
    expect(await vectors.getPreviousProfile()).toMatchObject({ model: 'model-a', generation: 1 });
  });

  it('refuses `already-active` while id, dimension and model all equal the registered ones (AC4)', async () => {
    const fixture = await createGovernedFixture('in-memory', {
      governed: registered(OLLAMA, 'model-a'),
    });
    expect(await fixture.memory.embedding.switchTo(OLLAMA)).toMatchObject({
      outcome: 'refused',
      reason: 'already-active',
    });
  });

  it('starts a switch to the same id registered at another dimension', async () => {
    const fixture = await createGovernedFixture('in-memory', {
      governed: registered(OLLAMA, 'model-a'),
    });
    await write(fixture.memory, 'The user prefers an aisle seat.');
    const wider = fixture.restart(registered(OLLAMA, 'model-a', DIMENSION * 2));
    await wider.init();
    expect(await problemOf(wider)).toBe('embedder-unavailable');
    expect(await wider.embedding.switchTo(OLLAMA)).toMatchObject({
      outcome: 'started',
      target: { dimension: DIMENSION * 2, model: 'model-a' },
    });
  });
});

describe('a store written by the code on main (version 1)', () => {
  const LEGACY: MemoryEmbeddingProfile = {
    embedderId: LEGACY_ID,
    dimension: DIMENSION,
    generation: 1,
  };

  /** Both embedders registered, the legacy one first, with the models they run now. */
  const both = (): Options => ({
    embedders: createEmbedderRegistry([
      { id: LEGACY_ID, embedder: embed, dimension: DIMENSION, model: 'legacy-model' },
      { id: OLLAMA, embedder: embed, dimension: DIMENSION, model: 'ollama-model' },
    ]),
    initialEmbedder: LEGACY_ID,
  });

  /** A memory over the bytes main wrote for `scenario`, not yet initialized. */
  async function openedOver(scenario: string, options: Options = both()) {
    const fixture = await createGovernedFixture('in-memory', { governed: both() });
    await seedVersion1(fixture.durable, scenario);
    return { fixture, memory: fixture.restart(options) };
  }

  it('opens, recalls, and then adopts the registered model at `init`, keeping its vectors (AC6)', async () => {
    const { fixture, memory } = await openedOver('fresh');
    expect(await memory.embedding.status()).toEqual({
      active: { embedder: LEGACY_ID, dimension: DIMENSION },
    });

    // A profile with no model takes vectors, and its marker is the bytes main wrote.
    const stored = await recordIdOf(write(memory, 'The user prefers an aisle seat.'));
    expect(await semantic(memory)).not.toBe('unavailable');
    const vectors = createMemoryVectorStore(fixture.durable);
    expect(await heldCount(vectors, LEGACY, [stored])).toBe(1);
    expect(await textAt(fixture.durable, ACTIVE)).toBe(version1.scenarios['fresh']![ACTIVE]);

    await memory.init();
    expect(await memory.embedding.status()).toEqual({
      active: { embedder: LEGACY_ID, dimension: DIMENSION, model: 'legacy-model' },
    });
    expect(await vectors.getActiveProfile()).toEqual({ ...LEGACY, model: 'legacy-model' });
    expect(await heldCount(vectors, LEGACY, [stored])).toBe(1);
    expect(await semantic(memory)).not.toBe('unavailable');
    // And it takes vectors afterwards, through the version 2 marker.
    const later = await recordIdOf(write(memory, 'A second note about the seat.'));
    expect(await heldCount(vectors, LEGACY, [later])).toBe(1);
  });

  it('switches, with or without `init`, to a profile that has a model', async () => {
    for (const initialize of [false, true]) {
      const { fixture, memory } = await openedOver('fresh');
      if (initialize) await memory.init();
      const stored = await recordIdOf(write(memory, 'The user prefers an aisle seat.'));
      expect(await memory.embedding.switchTo(OLLAMA)).toMatchObject({ outcome: 'started' });
      const status = await finishSwitch(memory);
      expect(status.active).toEqual({
        embedder: OLLAMA,
        dimension: DIMENSION,
        model: 'ollama-model',
      });
      const vectors = createMemoryVectorStore(fixture.durable);
      expect(await vectors.getPreviousProfile()).toMatchObject({ embedderId: LEGACY_ID });
      expect(await heldByActive(vectors, [stored])).toBe(1);
    }
  });

  it('resumes a switch that was running when the build changed, and completes it', async () => {
    const { fixture, memory } = await openedOver('running-job');
    const stored = await recordIdOf(write(memory, 'The user prefers an aisle seat.'));
    const before = await memory.embedding.status();
    expect(before.job).toMatchObject({ target: OLLAMA, state: 'running' });
    expect(before.problem).toBeUndefined();

    const status = await finishSwitch(memory);
    // Not failed as `target-unavailable`: a profile with no model is made by whatever its embedder runs.
    expect(status).toEqual({ active: { embedder: OLLAMA, dimension: DIMENSION } });
    const vectors = createMemoryVectorStore(fixture.durable);
    expect(await heldByActive(vectors, [stored])).toBe(1);
    // The next start adopts the model the new active profile's embedder runs.
    await memory.init();
    expect(await modelOf(memory)).toBe('ollama-model');
  });

  it('reads the record of a switch that failed with free text as written, and starts a switch over it', async () => {
    const { memory } = await openedOver('failed-job-free-text');
    const status = await memory.embedding.status();
    expect(status.job).toMatchObject({ state: 'failed', target: OLLAMA });
    expect(await memory.embedding.switchTo(OLLAMA)).toMatchObject({ outcome: 'started' });
  });

  it('adopts nothing while its embedder is not registered, and says so without a model (AC8)', async () => {
    const { fixture, memory } = await openedOver('fresh', registered(OLLAMA, 'ollama-model'));
    await memory.init();
    expect(await memory.embedding.status()).toEqual({
      active: { embedder: LEGACY_ID, dimension: DIMENSION },
      problem: 'embedder-unavailable',
    });
    expect(await profileRecords(fixture)).toEqual(profileRecordsOf(version1.scenarios['fresh']!));
  });

  it('adopts nothing while its embedder is registered at another dimension', async () => {
    const { fixture, memory } = await openedOver(
      'fresh',
      registered(LEGACY_ID, 'legacy-model', DIMENSION * 2),
    );
    await memory.init();
    expect(await problemOf(memory)).toBe('embedder-unavailable');
    expect(await modelOf(memory)).toBeUndefined();
    expect(await profileRecords(fixture)).toEqual(profileRecordsOf(version1.scenarios['fresh']!));
  });

  it('leaves one consistent profile when two processes initialize at once', async () => {
    const { fixture } = await openedOver('vectors-and-queue');
    let arrived = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Each process's swap waits until the other's is about to run: both read the version 1 profile.
    const barrier = (run: () => Promise<boolean>) => {
      arrived += 1;
      if (arrived === 2) release();
      return together.then(run);
    };
    const processes = [0, 1].map(() =>
      fixture.restart({
        ...both(),
        vectors: createMemoryVectorStore(intercepting(fixture.durable, barrier)),
      }),
    );
    await Promise.all(processes.map((process) => process.init()));
    expect(arrived).toBe(2);

    const vectors = createMemoryVectorStore(fixture.durable);
    expect(await vectors.listProfiles()).toEqual([{ ...LEGACY, model: 'legacy-model' }]);
    expect(await textAt(fixture.durable, ACTIVE)).toBe(
      await textAt(fixture.durable, `${version1.prefix}p:legacy-embed:8:1`),
    );
    for (const process of processes) {
      expect(await modelOf(process)).toBe('legacy-model');
    }
  });

  it('is readable when the process stops between the read and the write, and the next start adopts', async () => {
    const { fixture, memory } = await openedOver('vectors-and-queue');
    const before = await snapshotVectorStore(fixture.durable);
    const crashing = fixture.restart({
      ...both(),
      vectors: createMemoryVectorStore(
        intercepting(fixture.durable, () => Promise.reject(new Error('the process stopped'))),
      ),
    });
    expect(await rejectionOf(crashing.init())).toBeInstanceOf(Error);
    expect(await snapshotVectorStore(fixture.durable)).toEqual(before);

    // Readable: it opens and recalls as it did.
    expect(await memory.embedding.status()).toEqual({
      active: { embedder: LEGACY_ID, dimension: DIMENSION },
    });
    await memory.init();
    expect(await modelOf(memory)).toBe('legacy-model');
  });
});

describe('a store the built-in hashing embedder started (COR-2184)', () => {
  it('records the model "hashing" in its profile', async () => {
    const fixture: GovernedFixture = await createGovernedFixture('in-memory', {
      governed: { embedders: createEmbedderRegistry(), initialEmbedder: HASHING_EMBEDDER_ID },
    });
    expect(await modelOf(fixture.memory)).toBe('hashing');
  });
});
