/**
 * COR-1898 — `memory.embedder`: a write is refused for an embedder memory cannot switch to, or
 * while a switch runs; an accepted write starts the switch, every maintenance pass advances it,
 * and a switch that fails or is cancelled sets the setting back to the embedder memory still uses.
 * Governed memory's own outcome matrix for the switch is in
 * `packages/memory/test/governance/embedding-switch.test.ts`.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createEmbedderRegistry,
  createGovernedMemory,
  DEFAULT_MEMORY_VECTOR_KEY_PREFIX,
  createMemoryAuthority,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMemoryVectorStore,
  createWeftMemoryRecordStorage,
  type GovernedMemory,
  HASHING_EMBEDDER_ID,
  type MemoryEmbeddingProfile,
} from '@lostgradient/memory';
import { createAgent } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import type { Embedder } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog.ts';
import { createBureau } from './create-bureau.ts';
import type { Bureau } from './types.ts';

const BUREAU_ID = 'memory-embedder-setting';
const FAKE = 'fake';
const NEEDS_SETUP = 'needs-setup-embedder';
const DIMENSION = 8;

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

const alice = createMemoryAuthority({
  principal: { kind: 'user', id: 'alice' },
  tenantId: BUREAU_ID,
  ownerId: 'alice',
  purpose: 'test',
  capabilities: ['memory:write', 'memory:list', 'memory:get'],
  policyRevision: 'bureau:test',
  projection: 'bureau',
});

/** An 8-dimension embedder, one axis per word it knows, that fails every call once told to. */
function fakeEmbedder(): { readonly embed: Embedder; fail(): void } {
  let failing = false;
  return {
    embed: (texts) => {
      if (failing) throw new Error('The fake embedder is down.');
      return texts.map((text) =>
        Array.from({ length: DIMENSION }, (_, index) =>
          index === (text.includes('alpha') ? 0 : text.includes('beta') ? 1 : 7) ? 1 : 0,
        ),
      );
    },
    fail: () => {
      failing = true;
    },
  };
}

interface Harness {
  readonly bureau: Bureau<AgentDefinitions>;
  readonly memory: GovernedMemory;
  readonly durable: MemoryStorage;
  readonly fake: ReturnType<typeof fakeEmbedder>;
}

async function start(
  options: {
    durable?: MemoryStorage;
    withFake?: boolean;
    withMemory?: boolean;
    fakeAvailability?: () => 'available' | 'needs-setup';
  } = {},
): Promise<Harness> {
  const runtime = createManualRuntimeServices({ identifierSeed: BUREAU_ID });
  const durable = options.durable ?? new MemoryStorage();
  const fake = fakeEmbedder();
  const memory = createGovernedMemory({
    storage: createWeftMemoryRecordStorage(durable, { runtime }),
    ledger: createMemoryGovernanceLedger(durable),
    embedders: createEmbedderRegistry([
      ...(options.withFake === false
        ? []
        : [
            {
              id: FAKE,
              embedder: fake.embed,
              dimension: DIMENSION,
              ...(options.fakeAvailability === undefined
                ? {}
                : { availability: options.fakeAvailability }),
            },
          ]),
      {
        id: NEEDS_SETUP,
        embedder: fake.embed,
        dimension: DIMENSION,
        availability: () => 'needs-setup' as const,
      },
    ]),
    vectors: createMemoryVectorStore(durable),
    policy: createMemoryGovernancePolicy({ revision: 'governance:embedder-setting' }),
    runtime,
  });
  await memory.init();
  const bureau = await createBureau<AgentDefinitions>({
    id: BUREAU_ID,
    agents: { default: createAgent({ generate: async () => ({ content: 'ok', toolCalls: [] }) }) },
    // The settings record lives beside the memory, so a restarted Bureau reads what this one wrote.
    storage: durable,
    durable: false,
    maintenance: 'manual',
    ...(options.withMemory === false ? {} : { memory }),
    runtime,
  });
  bureaus.push(bureau);
  return { bureau, memory, durable, fake };
}

async function setEmbedder(bureau: Bureau<AgentDefinitions>, embedder: string) {
  const { revision } = await bureau.settings.get();
  return bureau.settings.update({ 'memory.embedder': embedder }, { expectedRevision: revision });
}

async function embedderSetting(bureau: Bureau<AgentDefinitions>): Promise<unknown> {
  const snapshot = await bureau.settings.get();
  return snapshot.values['memory.embedder'];
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

/** The stored keys under `prefix` in the memory vector store's key space. */
async function vectorStoreKeys(storage: MemoryStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan(`${DEFAULT_MEMORY_VECTOR_KEY_PREFIX}${prefix}`)) {
    keys.push(key);
  }
  return keys;
}

async function remember(memory: GovernedMemory, content: string): Promise<string> {
  const receipt = await memory.write(alice, content, {
    collection: 'assistant',
    source: 'conversation',
  });
  return receipt.recordId!;
}

describe('memory.embedder', () => {
  it('refuses an embedder that is not loaded, or whose plugin needs setup', async () => {
    const { bureau } = await start();

    const missing = await setEmbedder(bureau, 'missing');
    expect(missing).toMatchObject({ outcome: 'rejected', reason: 'invalid-value' });
    expect(missing.outcome === 'rejected' && missing.message).toContain('not-loaded');
    const unset = await setEmbedder(bureau, NEEDS_SETUP);
    expect(unset).toMatchObject({ outcome: 'rejected', reason: 'invalid-value' });
    expect(unset.outcome === 'rejected' && unset.message).toContain('needs-setup');
    expect(await embedderSetting(bureau)).toBeUndefined();
  });

  it('refuses any embedder on a Bureau without governed memory', async () => {
    const { bureau } = await start({ withMemory: false });

    const result = await setEmbedder(bureau, HASHING_EMBEDDER_ID);
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'invalid-value' });
  });

  it('starts the switch on write, and the maintenance pass completes it', async () => {
    const { bureau, memory } = await start();
    await remember(memory, 'alpha answer');
    await remember(memory, 'beta answer');

    expect(await setEmbedder(bureau, FAKE)).toMatchObject({ outcome: 'applied' });
    const running = await memory.embedding.status();
    expect(running.job).toMatchObject({ target: FAKE, state: 'running' });
    expect(running.active.embedder).toBe(HASHING_EMBEDDER_ID);

    await bureau.maintain();

    expect(await memory.embedding.status()).toEqual({
      active: { embedder: FAKE, dimension: DIMENSION },
    });
    expect(await embedderSetting(bureau)).toBe(FAKE);
  });

  it('refuses a second switch while one runs, naming the running switch', async () => {
    const { bureau, memory } = await start();
    await remember(memory, 'alpha answer');
    await setEmbedder(bureau, FAKE);

    const second = await setEmbedder(bureau, HASHING_EMBEDDER_ID);
    expect(second).toMatchObject({ outcome: 'rejected', reason: 'invalid-value' });
    expect(second.outcome === 'rejected' && second.message).toContain(
      `A switch to the embedder "${FAKE}" is running`,
    );
    expect(await embedderSetting(bureau)).toBe(FAKE);
  });

  it('sets the embedder back and deletes the partial profile when the switch is cancelled', async () => {
    const { bureau, memory, durable } = await start();
    await remember(memory, 'alpha answer');
    await setEmbedder(bureau, FAKE);
    const vectors = createMemoryVectorStore(durable);
    expect(await vectors.listProfiles()).toHaveLength(2);

    expect(await memory.embedding.cancel()).toBe(true);
    await bureau.maintain();

    expect(await embedderSetting(bureau)).toBe(HASHING_EMBEDDER_ID);
    expect(await vectors.listProfiles()).toEqual([(await vectors.getActiveProfile())!]);
    const status = await memory.embedding.status();
    expect(status.job?.state).toBe('cancelled');
    expect(status.active.embedder).toBe(HASHING_EMBEDDER_ID);
  });

  it('starts again after a cancel and completes without a memory forgotten meanwhile', async () => {
    const { bureau, memory, durable } = await start();
    await remember(memory, 'alpha answer');
    const beta = await remember(memory, 'beta answer');
    await setEmbedder(bureau, FAKE);
    await memory.embedding.cancel();
    await bureau.maintain();
    const deleted = await memory.delete(
      createMemoryAuthority({
        principal: { kind: 'user', id: 'alice' },
        tenantId: BUREAU_ID,
        ownerId: 'alice',
        purpose: 'test',
        capabilities: ['memory:delete'],
        policyRevision: 'bureau:test',
        projection: 'bureau',
      }),
      { id: beta, collection: 'assistant' },
    );
    expect(deleted.status).toBe('applied');

    expect(await setEmbedder(bureau, FAKE)).toMatchObject({ outcome: 'applied' });
    await bureau.maintain();

    const vectors = createMemoryVectorStore(durable);
    const active = (await vectors.getActiveProfile())!;
    expect(active).toMatchObject({ embedderId: FAKE, generation: 3 });
    const listed = await memory.list(alice, { collection: 'assistant' });
    expect(listed.map((record) => record.content)).toEqual(['alpha answer']);
    const scope = { tenantId: BUREAU_ID, namespace: 'private:alice:assistant' };
    expect(await vectors.getMany(active, scope, [beta])).toEqual(new Map());
    const kept = await vectors.getMany(active, scope, [listed[0]!.id]);
    expect(kept.size).toBe(1);
  });

  it('sets the embedder back when the switch fails, leaving recall on the previous embedding', async () => {
    const { bureau, memory, fake } = await start();
    await remember(memory, 'alpha answer');
    await setEmbedder(bureau, FAKE);
    fake.fail();

    await bureau.maintain();

    const status = await memory.embedding.status();
    expect(status.active.embedder).toBe(HASHING_EMBEDDER_ID);
    expect(status.job).toMatchObject({ target: FAKE, state: 'failed', done: 0, total: 1 });
    expect(status.job?.error).toBe('The fake embedder is down.');
    expect(await embedderSetting(bureau)).toBe(HASHING_EMBEDDER_ID);
  });

  it('sets the embedder back on the next pass when its plugin needed setup by the time the switch started', async () => {
    // Available when the write is checked, needing setup from then on.
    let asked = 0;
    const { bureau, memory } = await start({
      fakeAvailability: () => (++asked === 1 ? 'available' : 'needs-setup'),
    });
    await remember(memory, 'alpha answer');

    expect(await setEmbedder(bureau, FAKE)).toMatchObject({ outcome: 'applied' });
    const status = await memory.embedding.status();
    expect(status.job).toBeUndefined();
    await bureau.maintain();

    expect(await embedderSetting(bureau)).toBe(HASHING_EMBEDDER_ID);
    const after = await memory.embedding.status();
    expect(after).toEqual({ active: { embedder: HASHING_EMBEDDER_ID, dimension: 256 } });
  });

  it('fails a switch whose embedder a restart no longer loads, and sets the embedder back', async () => {
    const first = await start();
    await remember(first.memory, 'alpha answer');
    await setEmbedder(first.bureau, FAKE);
    // A second process over the same store, built as a restart builds it; the first one stays idle.

    const { bureau, memory } = await start({ durable: first.durable, withFake: false });
    expect(await embedderSetting(bureau)).toBe(FAKE);
    await bureau.maintain();

    const status = await memory.embedding.status();
    expect(status.job).toMatchObject({ state: 'failed', error: 'target-unavailable' });
    expect(await embedderSetting(bureau)).toBe(HASHING_EMBEDDER_ID);
  });

  it('finishes a profile deletion that stopped part-way on the next maintenance pass, with no switch running', async () => {
    const { bureau, memory, durable } = await start();
    const stopping = createMemoryVectorStore(stoppingOnFirstDeletePrefix(durable));
    const leftover: MemoryEmbeddingProfile = {
      embedderId: FAKE,
      dimension: DIMENSION,
      generation: await stopping.nextGeneration(),
    };
    expect(await stopping.createProfile(leftover)).toBe(true);
    await stopping.put(
      leftover,
      { id: 'orphan', scope: { tenantId: BUREAU_ID, namespace: 'leftover' } },
      { version: 1, vector: new Float32Array(DIMENSION).fill(1) },
    );
    expect(await throwingRejectionOf(stopping.deleteProfile(leftover))).toThrow('stopped');
    expect(await vectorStoreKeys(durable, 'v:')).toHaveLength(1);
    const idle = await memory.embedding.status();
    expect(idle.job).toBeUndefined();

    await bureau.maintain();

    expect(await vectorStoreKeys(durable, 'v:')).toEqual([]);
    expect(await vectorStoreKeys(durable, 'd:')).toEqual([]);
  });
});
