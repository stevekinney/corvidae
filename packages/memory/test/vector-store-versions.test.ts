/**
 * COR-2184 — the embedding profile records the embedder's model, which makes the profile and job
 * records of the vector store a version 2 envelope. This file holds the persisted-format contract.
 *
 * The version 1 snapshots in `fixtures/vector-store-version-1.json` were written by the code on
 * main (`60eb049732df10c6577239fb4e134f6eaf1e3836`), through its encoder and the store's own API,
 * and are never edited by hand. Each row is a test below.
 *
 * | Record                        | Written by          | Required result                                                         |
 * | ----------------------------- | ------------------- | ----------------------------------------------------------------------- |
 * | any version 1 snapshot        | main                | opens: profiles and jobs decode with no model                            |
 * | any version 1 snapshot        | main                | reading rewrites nothing: every byte is as main wrote it                |
 * | version 1 active, running job | main                | the job completes, and a put into the target holds (bytes still match)  |
 * | version 1 failed job          | main                | a new switch starts over it (the stored bytes are what the swap expects)|
 * | free-text `error` of a job    | main                | read back as written, so a swap that expects it still matches           |
 * | profile without a model       | new code            | exactly the bytes main writes                                           |
 * | profile with a model          | new code            | `schemaVersion: 2`, with `model`                                        |
 * | job, a profile has a model    | new code            | `schemaVersion: 2`; a model-less `from` beside a target with a model    |
 * |                               |                     | still starts, takes a vector and completes                              |
 * | job, no profile has a model   | new code            | exactly the bytes main writes                                           |
 * | version 1 active, no job      | `adoptModel`        | active and its marker become version 2 in one swap; nothing else moves  |
 * | version 1 active, running job | `adoptModel`        | refused, nothing written                                                |
 * | version 1 active              | two `adoptModel`    | exactly one wins                                                        |
 * | version 1 active              | `adoptModel`, write fails | the store is as it was, and a later adoption succeeds             |
 * | an unknown version, a version 2 profile with no model | read | refused                                                          |
 * | a version 2 record            | the build on main   | refused (it reads `schemaVersion: 1` only): this is the one-way door    |
 */
import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';

import {
  createMemoryVectorStore,
  type MemoryEmbeddingJob,
  type MemoryEmbeddingProfile,
  MemoryVectorProfileMissingError,
} from '../src/memory-vector-store';
import {
  version1 as fixtures,
  intercepting,
  version1Scenario as scenario,
  snapshotVectorStore as snapshot,
  textAt as textOf,
} from './vector-store-version-1';

const PREFIX = fixtures.prefix;
const ACTIVE = `${PREFIX}active`;
const JOB = `${PREFIX}job`;
const encoder = new TextEncoder();

const LEGACY: MemoryEmbeddingProfile = { embedderId: 'legacy-embed', dimension: 8, generation: 1 };
const TARGET: MemoryEmbeddingProfile = { embedderId: 'ollama:embed', dimension: 8, generation: 2 };
const scope = { tenantId: 'tenant-a', namespace: 'agent:notes' };
const vector = (seed: number) =>
  new Float32Array(Array.from({ length: 8 }, (_, index) => (index + seed) / 16));

/** A storage holding exactly the bytes main wrote for `name`. */
async function seeded(name: string): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  for (const [key, text] of Object.entries(scenario(name))) {
    await storage.put(key, encoder.encode(text));
  }
  return storage;
}

const SCENARIOS = Object.keys(fixtures.scenarios);

describe('a store written by the code on main (version 1)', () => {
  it('was generated from the base commit', () => {
    expect(fixtures.generatedFrom).toBe('60eb049732df10c6577239fb4e134f6eaf1e3836');
    expect(SCENARIOS).toEqual([
      'fresh',
      'vectors-and-queue',
      'running-job',
      'failed-job',
      'failed-job-free-text',
      'cancelled-job',
      'completed-switch',
      'deletion-checkpoint',
    ]);
  });

  it('opens: profiles and jobs decode without a model', async () => {
    const running = createMemoryVectorStore(await seeded('running-job'));
    expect(await running.getActiveProfile()).toEqual(LEGACY);
    expect(await running.listProfiles()).toEqual([LEGACY, TARGET]);
    expect(await running.getJob()).toEqual({
      from: LEGACY,
      target: TARGET,
      state: 'running',
      done: 1,
      total: 3,
    });
    const completed = createMemoryVectorStore(await seeded('completed-switch'));
    expect(await completed.getActiveProfile()).toEqual(TARGET);
    expect(await completed.getPreviousProfile()).toEqual(LEGACY);
    for (const state of ['failed-job', 'cancelled-job'] as const) {
      const job = await createMemoryVectorStore(await seeded(state)).getJob();
      expect(job?.state).toBe(state === 'failed-job' ? 'failed' : 'cancelled');
      expect(job?.from).toEqual(LEGACY);
      expect(job?.target).toEqual(TARGET);
    }
    const held = createMemoryVectorStore(await seeded('vectors-and-queue'));
    expect(await held.getActiveProfile()).toEqual(LEGACY);
    const vectors = await held.getMany(LEGACY, scope, ['alpha', 'beta', 'gamma']);
    expect(vectors.size).toBe(3);
    const queued = await held.listQueuedEmbeds(LEGACY, 10);
    expect(queued.map((entry) => entry.reference.id)).toEqual(['gamma']);
  });

  it.each(SCENARIOS)('reading %s rewrites nothing', async (name) => {
    const storage = await seeded(name);
    const store = createMemoryVectorStore(storage);
    await store.getActiveProfile();
    await store.listProfiles();
    await store.getJob();
    await store.getPreviousProfile();
    await store.getMany(LEGACY, scope, ['alpha']);
    await store.listQueuedEmbeds(LEGACY, 10);
    expect(await snapshot(storage)).toEqual(scenario(name));
  });

  it('keeps swaps that expect main’s bytes working: a running switch completes and takes vectors', async () => {
    const storage = await seeded('running-job');
    const store = createMemoryVectorStore(storage);
    const job = (await store.getJob())!;
    await store.put(TARGET, { id: 'beta', scope }, { version: 1, vector: vector(7) });
    expect(await store.enqueueEmbed(TARGET, { id: 'gamma', scope }, 3_000)).toBe(true);
    const progressed: MemoryEmbeddingJob = { ...job, done: 2 };
    expect(await store.replaceJob(job, progressed)).toBe(true);
    expect(await store.completeJob(progressed)).toBe(true);
    expect(await store.getActiveProfile()).toEqual(TARGET);
    expect(await store.getPreviousProfile()).toEqual(LEGACY);
    expect(await store.getJob()).toBeUndefined();
  });

  it('starts a new switch over a failed or cancelled record, and over one with free text for its error', async () => {
    for (const name of ['failed-job', 'cancelled-job', 'failed-job-free-text']) {
      const store = createMemoryVectorStore(await seeded(name));
      const ended = (await store.getJob())!;
      const next: MemoryEmbeddingProfile = {
        ...TARGET,
        generation: await store.nextGeneration(),
      };
      expect(await store.createProfile(next)).toBe(true);
      expect(
        await store.startJob(ended, {
          from: LEGACY,
          target: next,
          state: 'running',
          done: 0,
          total: 0,
        }),
      ).toBe(true);
    }
    // The text main stored is what the record reads back as, byte for byte.
    const job = await createMemoryVectorStore(await seeded('failed-job-free-text')).getJob();
    expect(job?.error).toBe('Ollama API error: 500 model not found');
  });

  it('finishes a profile deletion main left part-way', async () => {
    const storage = await seeded('deletion-checkpoint');
    const store = createMemoryVectorStore(storage);
    await store.resumeProfileDeletions();
    expect(Object.keys(await snapshot(storage)).filter((key) => key.includes(':d:'))).toEqual([]);
  });

  it('writes the same bytes through the new encoder for a profile with no model', async () => {
    const storage = new MemoryStorage();
    const store = createMemoryVectorStore(storage);
    await store.activeProfile(LEGACY);
    for (const [index, id] of ['alpha', 'beta', 'gamma'].entries()) {
      await store.put(LEGACY, { id, scope }, { version: 1, vector: vector(index) });
    }
    await store.enqueueEmbed(LEGACY, { id: 'gamma', scope }, 1_000);
    expect(await snapshot(storage)).toEqual(scenario('vectors-and-queue'));

    const switching = new MemoryStorage();
    const next = createMemoryVectorStore(switching);
    await next.activeProfile(LEGACY);
    for (const [index, id] of ['alpha', 'beta', 'gamma'].entries()) {
      await next.put(LEGACY, { id, scope }, { version: 1, vector: vector(index) });
    }
    const job: MemoryEmbeddingJob = {
      from: LEGACY,
      target: TARGET,
      state: 'running',
      done: 1,
      total: 3,
    };
    expect(await next.nextGeneration()).toBe(TARGET.generation);
    await next.createProfile(TARGET);
    await next.startJob(undefined, job);
    await next.put(TARGET, { id: 'alpha', scope }, { version: 1, vector: vector(5) });
    await next.enqueueEmbed(TARGET, { id: 'beta', scope }, 2_000);
    expect(await snapshot(switching)).toEqual(scenario('running-job'));
  });
});

describe('a profile with a model (version 2)', () => {
  const MODELED: MemoryEmbeddingProfile = { ...LEGACY, model: 'legacy-model' };
  const MODELED_TARGET: MemoryEmbeddingProfile = { ...TARGET, model: 'target-model' };

  it('is stored as schemaVersion 2 with its model, in the active record and its marker', async () => {
    const storage = new MemoryStorage();
    const store = createMemoryVectorStore(storage);
    expect(await store.activeProfile(MODELED)).toEqual(MODELED);
    const expected =
      '{"schemaVersion":2,"embedderId":"legacy-embed","dimension":8,"generation":1,"model":"legacy-model"}';
    expect(await textOf(storage, ACTIVE)).toBe(expected);
    expect(await textOf(storage, `${PREFIX}p:legacy-embed:8:1`)).toBe(expected);
    const reopened = createMemoryVectorStore(storage);
    expect(await reopened.getActiveProfile()).toEqual(MODELED);
    expect(await reopened.listProfiles()).toEqual([MODELED]);
  });

  it('takes vectors and queue entries, which stay version 1 records', async () => {
    const storage = new MemoryStorage();
    const store = createMemoryVectorStore(storage);
    await store.activeProfile(MODELED);
    await store.put(MODELED, { id: 'alpha', scope }, { version: 1, vector: vector(1) });
    await store.enqueueEmbed(MODELED, { id: 'beta', scope }, 10);
    const keys = await snapshot(storage);
    const records = Object.entries(keys).filter(([key]) =>
      /:(v|q):/.test(key.slice(PREFIX.length - 1)),
    );
    expect(records).toHaveLength(2);
    for (const [, text] of records) expect(text.startsWith('{"schemaVersion":1,')).toBe(true);
  });

  it('is refused by put when the marker holds the same profile without its model', async () => {
    const storage = new MemoryStorage();
    const store = createMemoryVectorStore(storage);
    await store.activeProfile(LEGACY);
    const error = await rejectionOf(
      store.put(MODELED, { id: 'alpha', scope }, { version: 1, vector: vector(1) }),
    );
    expect(error).toBeInstanceOf(MemoryVectorProfileMissingError);
  });

  it('writes a job whose profiles have a model as schemaVersion 2, and reads it back', async () => {
    const storage = new MemoryStorage();
    const store = createMemoryVectorStore(storage);
    await store.activeProfile(MODELED);
    await store.createProfile(MODELED_TARGET);
    const job: MemoryEmbeddingJob = {
      from: MODELED,
      target: MODELED_TARGET,
      state: 'running',
      done: 0,
      total: 2,
    };
    expect(await store.startJob(undefined, job)).toBe(true);
    expect(await textOf(storage, JOB)).toBe(
      '{"schemaVersion":2,"from":{"schemaVersion":2,"embedderId":"legacy-embed","dimension":8,"generation":1,"model":"legacy-model"},"target":{"schemaVersion":2,"embedderId":"ollama:embed","dimension":8,"generation":2,"model":"target-model"},"state":"running","done":0,"total":2}',
    );
    expect(await store.getJob()).toEqual(job);
    const progressed = { ...job, done: 1 };
    expect(await store.replaceJob(job, progressed)).toBe(true);
    expect(await store.completeJob(progressed)).toBe(true);
    expect(await store.getActiveProfile()).toEqual(MODELED_TARGET);
    expect(await store.getPreviousProfile()).toEqual(MODELED);
  });

  it('holds a job from a profile with no model into a target with one: it starts, takes vectors and completes', async () => {
    // A legacy active profile no process adopted (its embedder was not registered), then a switch.
    const storage = await seeded('fresh');
    const store = createMemoryVectorStore(storage);
    await store.createProfile(MODELED_TARGET);
    const job: MemoryEmbeddingJob = {
      from: LEGACY,
      target: MODELED_TARGET,
      state: 'running',
      done: 0,
      total: 1,
    };
    expect(await store.startJob(undefined, job)).toBe(true);
    const stored = await textOf(storage, JOB);
    expect(stored?.startsWith('{"schemaVersion":2,')).toBe(true);
    // Neither profile's own form is lost: the target keeps its model, the source has none.
    expect(await store.getJob()).toEqual(job);
    await store.put(MODELED_TARGET, { id: 'alpha', scope }, { version: 1, vector: vector(1) });
    expect(await store.completeJob(job)).toBe(true);
    expect(await store.getActiveProfile()).toEqual(MODELED_TARGET);
    expect(await store.getPreviousProfile()).toEqual(LEGACY);
  });

  it('keeps main’s bytes for a job in which no profile has a model', async () => {
    const storage = new MemoryStorage();
    const store = createMemoryVectorStore(storage);
    await store.activeProfile(LEGACY);
    await store.createProfile(TARGET);
    await store.startJob(undefined, {
      from: LEGACY,
      target: TARGET,
      state: 'running',
      done: 0,
      total: 0,
    });
    expect(await textOf(storage, JOB)).toBe(
      '{"schemaVersion":1,"from":{"schemaVersion":1,"embedderId":"legacy-embed","dimension":8,"generation":1},"target":{"schemaVersion":1,"embedderId":"ollama:embed","dimension":8,"generation":2},"state":"running","done":0,"total":0}',
    );
  });

  it('reads a running job written before the model existed as a job with no model at all', async () => {
    const store = createMemoryVectorStore(await seeded('running-job'));
    const job = (await store.getJob())!;
    expect(job.from.model).toBeUndefined();
    expect(job.target.model).toBeUndefined();
  });
});

describe('adoptModel (COR-2184)', () => {
  it('rewrites the active profile and its marker as version 2 in one swap, and nothing else', async () => {
    const storage = await seeded('vectors-and-queue');
    const before = await snapshot(storage);
    const store = createMemoryVectorStore(storage);
    expect(await store.adoptModel(LEGACY, 'adopted-model')).toBe(true);

    const adopted =
      '{"schemaVersion":2,"embedderId":"legacy-embed","dimension":8,"generation":1,"model":"adopted-model"}';
    const after = await snapshot(storage);
    expect(after[ACTIVE]).toBe(adopted);
    expect(after[`${PREFIX}p:legacy-embed:8:1`]).toBe(adopted);
    for (const key of Object.keys(before)) {
      if (key !== ACTIVE && key !== `${PREFIX}p:legacy-embed:8:1`)
        expect(after[key]).toBe(before[key]);
    }
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(await store.getActiveProfile()).toEqual({ ...LEGACY, model: 'adopted-model' });
    // The vectors the profile holds are still found, and a put with the adopted profile holds.
    const held = await store.getMany(LEGACY, scope, ['alpha']);
    expect(held.size).toBe(1);
    await store.put(
      { ...LEGACY, model: 'adopted-model' },
      { id: 'delta', scope },
      { version: 1, vector: vector(2) },
    );
  });

  it('refuses a profile that already has a model, and one that is not the active profile', async () => {
    const store = createMemoryVectorStore(await seeded('fresh'));
    expect(await store.adoptModel({ ...LEGACY, model: 'already' }, 'other')).toBe(false);
    expect(await store.adoptModel({ ...LEGACY, generation: 9 }, 'other')).toBe(false);
    expect(await store.getActiveProfile()).toEqual(LEGACY);
  });

  it('refuses while a switch is running, which a swap on the active profile alone would miss', async () => {
    const storage = await seeded('running-job');
    const before = await snapshot(storage);
    const store = createMemoryVectorStore(storage);
    expect(await store.adoptModel(LEGACY, 'adopted-model')).toBe(false);
    expect(await snapshot(storage)).toEqual(before);
  });

  it('refuses when a switch starts between its read and its write', async () => {
    const storage = await seeded('fresh');
    const racing = createMemoryVectorStore(
      intercepting(storage, async (run) => {
        // Another process starts a switch: the active profile and its marker are untouched, the job is new.
        const other = createMemoryVectorStore(storage);
        await other.createProfile(TARGET);
        await other.startJob(undefined, {
          from: LEGACY,
          target: TARGET,
          state: 'running',
          done: 0,
          total: 0,
        });
        return run();
      }),
    );
    expect(await racing.adoptModel(LEGACY, 'adopted-model')).toBe(false);
    expect(await textOf(storage, ACTIVE)).toBe(scenario('fresh')[ACTIVE]);
    // The switch can still complete: its `from` is the bytes the active key still holds.
    const job = (await createMemoryVectorStore(storage).getJob())!;
    expect(await createMemoryVectorStore(storage).completeJob(job)).toBe(true);
  });

  it('lets exactly one of two processes adopt, and leaves one consistent profile', async () => {
    const storage = await seeded('fresh');
    const arrived: (() => void)[] = [];
    let release!: () => void;
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = (run: () => Promise<boolean>) => {
      arrived.push(() => undefined);
      if (arrived.length === 2) release();
      return together.then(run);
    };
    const first = createMemoryVectorStore(intercepting(storage, barrier));
    const second = createMemoryVectorStore(intercepting(storage, barrier));
    const results = await Promise.all([
      first.adoptModel(LEGACY, 'adopted-model'),
      second.adoptModel(LEGACY, 'adopted-model'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const profiles = await createMemoryVectorStore(storage).listProfiles();
    expect(profiles).toEqual([{ ...LEGACY, model: 'adopted-model' }]);
    expect(await textOf(storage, ACTIVE)).toBe(
      await textOf(storage, `${PREFIX}p:legacy-embed:8:1`),
    );
  });

  it('leaves a readable store when the write never lands, and a later adoption succeeds', async () => {
    const storage = await seeded('vectors-and-queue');
    const before = await snapshot(storage);
    let crash = true;
    const store = createMemoryVectorStore(
      intercepting(storage, async (run) => {
        if (crash) throw new Error('the process stopped between the read and the write');
        return run();
      }),
    );
    const error = await rejectionOf(store.adoptModel(LEGACY, 'adopted-model'));
    expect(error).toBeInstanceOf(Error);
    expect(await snapshot(storage)).toEqual(before);
    expect(await store.getActiveProfile()).toEqual(LEGACY);
    crash = false;
    expect(await store.adoptModel(LEGACY, 'adopted-model')).toBe(true);
    const adopted = await store.getActiveProfile();
    expect(adopted?.model).toBe('adopted-model');
  });
});

describe('records no reader accepts', () => {
  async function opening(text: string) {
    const storage = await seeded('fresh');
    await storage.put(ACTIVE, encoder.encode(text));
    return createMemoryVectorStore(storage);
  }

  it('refuses an unknown version', async () => {
    const store = await opening(
      '{"schemaVersion":3,"embedderId":"legacy-embed","dimension":8,"generation":1,"model":"m"}',
    );
    expect(await rejectionOf(store.getActiveProfile())).toBeInstanceOf(Error);
  });

  it('refuses a version 2 profile with no model, or a blank one, and a version 1 profile with one', async () => {
    for (const text of [
      '{"schemaVersion":2,"embedderId":"legacy-embed","dimension":8,"generation":1}',
      '{"schemaVersion":2,"embedderId":"legacy-embed","dimension":8,"generation":1,"model":""}',
      '{"schemaVersion":1,"embedderId":"legacy-embed","dimension":8,"generation":1,"model":"m"}',
    ]) {
      const store = await opening(text);
      expect(await rejectionOf(store.getActiveProfile())).toBeInstanceOf(Error);
    }
  });

  it('is what the build on main does with every version 2 profile: it throws (the one-way door)', async () => {
    // The schema on main, copied from `memory-vector-store.ts` at the base commit.
    const profileOnMain = z
      .object({
        schemaVersion: z.literal(1),
        embedderId: z.string().min(1),
        dimension: z.number().int().positive(),
        generation: z.number().int().positive(),
      })
      .strict();
    const storage = new MemoryStorage();
    await createMemoryVectorStore(storage).activeProfile({ ...LEGACY, model: 'legacy-model' });
    const written = JSON.parse((await textOf(storage, ACTIVE))!) as unknown;
    expect(profileOnMain.safeParse(written).success).toBe(false);
    // A version 1 profile, which is what the new code writes without a model, still parses there.
    const bare = new MemoryStorage();
    await createMemoryVectorStore(bare).activeProfile(LEGACY);
    expect(profileOnMain.safeParse(JSON.parse((await textOf(bare, ACTIVE))!)).success).toBe(true);
  });
});
