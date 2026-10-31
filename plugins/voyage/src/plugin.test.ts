import { createBureau, type AgentDefinitions, type Bureau } from '@lostgradient/bureau';
import { createPluginTestHost } from '@lostgradient/bureau/testing';
import { pluginContract } from '@lostgradient/interborough-plugin/testing';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createEmbedderRegistry,
  createGovernedMemory,
  createMemoryAuthority,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMemoryVectorStore,
  createWeftMemoryRecordStorage,
  HASHING_EMBEDDER_ID,
  type GovernedMemory,
} from '@lostgradient/memory';
import { createAgent } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import voyage from './plugin.ts';

const DIMENSION = 8;
const SECRET = 'test-voyage-key';
const BUREAU_ID = 'plugin-voyage-test';

pluginContract(voyage, { createHost: createPluginTestHost });

interface RecordedRequest {
  readonly authorization: string | null;
  readonly body: { model: string; input: string[] };
}

interface FakeVoyage {
  readonly endpoint: string;
  readonly requests: RecordedRequest[];
  readonly server: ReturnType<typeof Bun.serve>;
}

const servers: FakeVoyage['server'][] = [];
const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  for (const server of servers.splice(0)) await server.stop(true);
});

/** A Voyage embeddings endpoint on a loopback port: one axis per word it knows, no network. */
function startFakeVoyage(status = 200): FakeVoyage {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as RecordedRequest['body'];
      requests.push({ authorization: request.headers.get('authorization'), body });
      if (status !== 200) return new Response('quota exceeded', { status });
      return Response.json({
        data: body.input.map((text) => ({
          embedding: Array.from({ length: DIMENSION }, (_, index) =>
            index === (text.includes('alpha') ? 0 : text.includes('beta') ? 1 : 7) ? 1 : 0,
          ),
        })),
      });
    },
  });
  servers.push(server);
  return { endpoint: `http://127.0.0.1:${server.port}/v1/embeddings`, requests, server };
}

const alice = createMemoryAuthority({
  principal: { kind: 'user', id: 'alice' },
  tenantId: BUREAU_ID,
  ownerId: 'alice',
  purpose: 'test',
  capabilities: ['memory:write', 'memory:list', 'memory:get'],
  policyRevision: 'bureau:test',
  projection: 'bureau',
});

/** A Bureau whose memory registers every embedder the Voyage plugin contributes. */
async function startBureau(
  fake: FakeVoyage,
  options: { secret?: string | undefined } = { secret: SECRET },
): Promise<{ bureau: Bureau<AgentDefinitions>; memory: GovernedMemory }> {
  const runtime = createManualRuntimeServices({ identifierSeed: BUREAU_ID });
  const durable = new MemoryStorage();
  let memory: GovernedMemory | undefined;
  const bureau = await createBureau<AgentDefinitions>({
    id: BUREAU_ID,
    agents: { default: createAgent({ generate: async () => ({ content: 'ok', toolCalls: [] }) }) },
    storage: durable,
    durable: false,
    maintenance: 'manual',
    runtime,
    plugins: [{ descriptor: voyage, source: 'package', location: '@lostgradient/plugin-voyage' }],
    pluginSecrets: {
      get: async (key) => (key === 'voyage-api-key' ? options.secret : undefined),
      watch: () => () => {},
    },
    pluginConfiguration: {
      voyage: {
        enabled: true,
        configuration: { endpoint: fake.endpoint, dimensions: DIMENSION },
      },
    },
    memory: (contributions) => {
      memory = createGovernedMemory({
        storage: createWeftMemoryRecordStorage(durable, { runtime }),
        ledger: createMemoryGovernanceLedger(durable),
        embedders: createEmbedderRegistry([...contributions.embedders]),
        vectors: createMemoryVectorStore(durable),
        policy: createMemoryGovernancePolicy({ revision: 'governance:plugin-voyage' }),
        runtime,
      });
      return memory;
    },
  });
  bureaus.push(bureau);
  await memory!.init();
  return { bureau, memory: memory! };
}

async function setEmbedder(bureau: Bureau<AgentDefinitions>, embedder: string) {
  const { revision } = await bureau.settings.get();
  return bureau.settings.update({ 'memory.embedder': embedder }, { expectedRevision: revision });
}

async function remember(memory: GovernedMemory, content: string): Promise<void> {
  await memory.write(alice, content, { collection: 'assistant', source: 'conversation' });
}

describe('voyage plugin', () => {
  it('contributes one embedder, voyage:embed, and declares the Voyage key as its secret', () => {
    expect(voyage.name).toBe('voyage');
    expect(voyage.secrets).toEqual(['voyage-api-key']);
  });

  it('embeds memory through the Voyage endpoint once memory.embedder names voyage:embed', async () => {
    const fake = startFakeVoyage();
    const { bureau, memory } = await startBureau(fake);
    await remember(memory, 'alpha answer');
    await remember(memory, 'beta answer');
    expect(fake.requests).toEqual([]);

    const result = await setEmbedder(bureau, 'voyage:embed');
    expect(result).toMatchObject({ outcome: 'applied' });
    const before = await memory.embedding.status();
    expect(before.active.embedder).toBe(HASHING_EMBEDDER_ID);
    await bureau.maintain();

    expect(await memory.embedding.status()).toEqual({
      active: { embedder: 'voyage:embed', dimension: DIMENSION },
    });
    const inputs = fake.requests.flatMap((request) => request.body.input).toSorted();
    expect(inputs).toEqual(['alpha answer', 'beta answer']);
    for (const request of fake.requests) {
      expect(request.authorization).toBe(`Bearer ${SECRET}`);
      expect(request.body.model).toBe('voyage-3');
    }
    const snapshot = await bureau.settings.get();
    expect(snapshot.values['memory.embedder']).toBe('voyage:embed');
  });

  it('refuses the switch while the plugin needs its secret, and calls nothing', async () => {
    const fake = startFakeVoyage();
    const { bureau, memory } = await startBureau(fake, { secret: undefined });
    await remember(memory, 'alpha answer');

    const result = await setEmbedder(bureau, 'voyage:embed');

    expect(result).toMatchObject({ outcome: 'rejected', reason: 'invalid-value' });
    expect(result.outcome === 'rejected' && result.message).toContain('needs-setup');
    expect(fake.requests).toEqual([]);
    const after = await memory.embedding.status();
    expect(after.active.embedder).toBe(HASHING_EMBEDDER_ID);
  });

  it('fails the switch with the status Voyage answered, and memory keeps its embedder', async () => {
    const fake = startFakeVoyage(429);
    const { bureau, memory } = await startBureau(fake);
    await remember(memory, 'alpha answer');

    await setEmbedder(bureau, 'voyage:embed');
    await bureau.maintain();

    const status = await memory.embedding.status();
    expect(status.active.embedder).toBe(HASHING_EMBEDDER_ID);
    expect(status.job).toMatchObject({ target: 'voyage:embed', state: 'failed' });
    expect(fake.requests.length).toBeGreaterThan(0);
  });
});
