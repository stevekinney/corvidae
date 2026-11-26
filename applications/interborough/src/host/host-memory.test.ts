/**
 * COR-1546: the host composes governed memory for the Bureau, over Bungalow's database, with an
 * embedder that needs no model provider. Every test starts the real host on an installation that
 * has configured no provider at all, and talks to it over its own HTTP surface.
 */
import { createMemoryRecallHook, type PluginMemoryContributions } from '@lostgradient/bureau';
import {
  collectionNamespace,
  createHashingEmbedder,
  createMemoryAuthority,
  createMemoryVectorStore,
  createWeftMemoryRecordStorage,
  DEFAULT_MEMORY_VECTOR_KEY_PREFIX,
  HASHING_EMBEDDER_DIMENSION,
  HASHING_EMBEDDER_ID,
  HASHING_EMBEDDER_MODEL,
} from '@lostgradient/memory/testing';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { Conversation } from 'conversationalist/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enableDemoPlugin } from './demo-plugin-home.ts';
import { startHost, type Host } from './host.ts';
import {
  createHostMemory,
  MEMORY_DELETION_PROPAGATION,
  MEMORY_POLICY_REVISION,
  memoryPolicyRevision,
} from './memory.ts';

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** An agent that says whether recalled memory reached its conversation, which only a host with memory can. */
function recalling(name: string) {
  return createAgent({
    name,
    generate: async ({ conversation }) => {
      const recalled = conversation
        .getMessages()
        .some(
          (message) =>
            message.role === 'system' &&
            typeof message.content === 'string' &&
            message.content.startsWith('<memory-evidence>'),
        );
      return {
        content: recalled ? 'I recall that you prefer aisle seats.' : 'You prefer aisle seats.',
        toolCalls: [],
      };
    },
    stopWhen: stopWhen.noToolCalls(),
  });
}

async function start(home?: string): Promise<{ host: Host; home: string }> {
  const directory = home ?? (await mkdtemp(join(tmpdir(), 'interborough-memory-')));
  if (home === undefined) directories.push(directory);
  await enableDemoPlugin(directory);
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: directory },
    port: 0,
    extraAgents: {
      agents: { alpha: recalling('alpha'), beta: recalling('beta') },
    },
  });
  hosts.push(host);
  return { host, home: directory };
}

/** One chat turn: the stream's text once the run has ended. */
async function chat(host: Host, agent: string, threadId: string): Promise<string> {
  const response = await fetch(new URL(`/bureau/ag-ui/agents/${agent}/run`, host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      threadId,
      runId: `run-${crypto.randomUUID()}`,
      messages: [{ id: 'user-1', role: 'user', content: 'Which seats do I like?' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  return response.text();
}

const byText = (left: string, right: string) => left.localeCompare(right);

type Row = { id: string; content: string; sessionId: string | null };

async function call(host: Host, method: string, params: unknown) {
  const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await response.json()) as {
    result?: Record<string, any>;
    error?: { data?: { httpStatus?: number } };
  };
}

async function memoriesOf(host: Host, agentId: string): Promise<Row[]> {
  const body = await call(host, 'bureau.memory.list', { agentId });
  if (body.result === undefined) throw new Error(`The list answered ${JSON.stringify(body.error)}`);
  return body.result['memories'] as Row[];
}

describe('the host’s governed memory', () => {
  test('composes memory with no model provider configured, and an agent recalls across its chats', async () => {
    const { host } = await start();
    expect(host.bureau.memory).toBeDefined();

    const first = await chat(host, 'alpha', 'thread-1');
    expect(first).toContain('You prefer aisle seats.');
    expect(first).not.toContain('I recall');
    // A second chat with the same agent recalls the first's answer.
    expect(await chat(host, 'alpha', 'thread-2')).toContain(
      'I recall that you prefer aisle seats.',
    );
    // Another agent has memory of its own: its first chat recalls nothing.
    expect(await chat(host, 'beta', 'thread-3')).not.toContain('I recall');

    const alpha = await memoriesOf(host, 'alpha');
    expect(alpha.map((memory) => String(memory.sessionId)).toSorted(byText)).toEqual([
      'thread-1',
      'thread-2',
    ]);
    const beta = await memoriesOf(host, 'beta');
    expect(beta.map((memory) => memory.sessionId)).toEqual(['thread-3']);
  });

  test('embeds with the hashing embedder, and makes no network call to do it', async () => {
    const { host } = await start();
    const origin = host.url.origin;
    const external: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(origin)) {
        external.push(url);
        throw new Error(`Unexpected network call to ${url}`);
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      await chat(host, 'alpha', 'thread-1');
      const found = await call(host, 'bureau.memory.search', {
        agentId: 'alpha',
        query: 'aisle seats',
      });
      expect(found.result?.['hits']).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(external).toEqual([]);

    // The vector that was stored is the hashing embedder's, not another 256-dimension embedder's.
    const { deploymentId, database } = host;
    if (database.kind !== 'sqlite') throw new Error('Expected the host to run on SQLite.');
    await host.close();
    const storage = new BunSQLiteStorage(database.path);
    try {
      const scope = {
        tenantId: deploymentId,
        namespace: collectionNamespace('private', 'anonymous:local', 'alpha'),
      };
      const [record] = await createWeftMemoryRecordStorage(storage).list(scope);
      const [expected] = await createHashingEmbedder()([record?.content ?? '']);
      // COR-1898: the vector lives in the vector store, under the hashing embedder's profile.
      expect(record?.vector).toHaveLength(0);
      const vectors = createMemoryVectorStore(storage);
      const profile = {
        embedderId: HASHING_EMBEDDER_ID,
        dimension: HASHING_EMBEDDER_DIMENSION,
        generation: 1,
        model: HASHING_EMBEDDER_MODEL,
      };
      expect(await vectors.listProfiles()).toEqual([profile]);
      const stored = await vectors.getMany(profile, scope, [record?.id ?? '']);
      expect(Array.from(stored.get(record?.id ?? '')?.vector ?? [])).toEqual(
        (expected ?? []).map((entry) => Math.fround(entry)),
      );
    } finally {
      storage[Symbol.dispose]();
    }
  });

  test('copies the vector a memory saved before embedding profiles held inline, when it starts', async () => {
    const { host, home } = await start();
    await chat(host, 'alpha', 'thread-1');
    const { deploymentId, database } = host;
    if (database.kind !== 'sqlite') throw new Error('Expected the host to run on SQLite.');
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    const scope = {
      tenantId: deploymentId,
      namespace: collectionNamespace('private', 'anonymous:local', 'alpha'),
    };
    const profile = {
      embedderId: HASHING_EMBEDDER_ID,
      dimension: HASHING_EMBEDDER_DIMENSION,
      generation: 1,
      model: HASHING_EMBEDDER_MODEL,
    };
    // Back to the shape an installation had before COR-1898: the vector on the record, none in
    // the vector store, and no mark that inline vectors were copied.
    const before = new BunSQLiteStorage(database.path);
    let inline: Float32Array;
    let id: string;
    try {
      const records = createWeftMemoryRecordStorage(before);
      const [record] = await records.list(scope);
      id = record!.id;
      const [embedded] = await createHashingEmbedder()([record!.content]);
      inline = new Float32Array(embedded!);
      await records.put({ ...record!, vector: inline });
      await createMemoryVectorStore(before).deleteMany([{ id, scope }]);
      await before.delete(`${DEFAULT_MEMORY_VECTOR_KEY_PREFIX}inline-vectors-copied`);
    } finally {
      before[Symbol.dispose]();
    }

    const restarted = await start(home);
    await restarted.host.close();
    hosts.splice(hosts.indexOf(restarted.host), 1);

    const after = new BunSQLiteStorage(database.path);
    try {
      const stored = await createMemoryVectorStore(after).getMany(profile, scope, [id]);
      expect(Array.from(stored.get(id)?.vector ?? [])).toEqual(Array.from(inline));
    } finally {
      after[Symbol.dispose]();
    }
  });

  test('keeps the seeded agents’ memory too, owned by the one local caller', async () => {
    const { host } = await start();
    await chat(host, 'demo:assistant', 'thread-1');

    const [memory] = await memoriesOf(host, 'demo:assistant');
    expect(memory?.content).toContain('Hello from the assistant');
    expect(memory?.sessionId).toBe('thread-1');
  });

  test('remembers across a restart, because the records and the ledger live in the database', async () => {
    const { host, home } = await start();
    await chat(host, 'alpha', 'thread-1');
    const [before] = await memoriesOf(host, 'alpha');
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);

    const restarted = await start(home);

    const [after] = await memoriesOf(restarted.host, 'alpha');
    expect(after).toEqual(before);
    // The ledger survived too: the memory's lineage still names the run that wrote it.
    const read = await call(restarted.host, 'bureau.memory.get', {
      agentId: 'alpha',
      id: before!.id,
    });
    expect(typeof read.result?.['lineage'].runId).toBe('string');
  });

  test('forgets a memory, and its receipt names what this host does not scrub', async () => {
    const { host } = await start();
    await chat(host, 'alpha', 'thread-1');
    const [memory] = await memoriesOf(host, 'alpha');

    const forgotten = await call(host, 'bureau.memory.forget', {
      agentId: 'alpha',
      id: memory!.id,
    });

    expect(forgotten.result?.['deletion']).toBe('completed');
    expect(await memoriesOf(host, 'alpha')).toEqual([]);
    const receipt = forgotten.result?.['receipt'] as { targets: Array<{ target: string }> };
    const status = (target: string) => receipt.targets.find((row) => row.target === target);
    // This host keeps no cache, asset bytes or external processor, so those completed at once; the
    // conversation it persists recalled text in is out of scope, so that target is still pending.
    expect(status('source-evidence')).toMatchObject({ status: 'completed' });
    expect(status('caches')).toMatchObject({ status: 'completed' });
    expect(status('durable-snapshots')).toMatchObject({ status: 'pending' });
  });

  test('declares not-retained only for the targets it keeps nothing in', () => {
    expect(Object.keys(MEMORY_DELETION_PROPAGATION).toSorted()).toEqual([
      'caches',
      'external-processors',
      'managed-asset-bytes',
    ]);
    expect(
      Object.values(MEMORY_DELETION_PROPAGATION).every((value) => value === 'not-retained'),
    ).toBe(true);
  });
});

type GuardrailSource = PluginMemoryContributions['guardrails']['sources'][number];

/** One contributed memory guardrail, as Bureau describes it: `plugin:memory/name` at a plugin version. */
function source(
  name: string,
  version = '1.0.0',
  gates: GuardrailSource['gates'] = ['admission', 'recall'],
): GuardrailSource {
  return { id: `kit:memory/${name}`, plugin: 'kit', version, gates };
}

/** What Bureau hands the memory factory for these guardrails: a detector that never trips per source. */
function contributing(...sources: GuardrailSource[]): PluginMemoryContributions {
  const detectors = (gate: 'admission' | 'recall') =>
    sources
      .filter((contributed) => contributed.gates.includes(gate))
      .map((contributed) => ({
        name: contributed.id,
        detect: async () => ({ triggered: false, confidence: 0, category: 'none' }),
      }));
  return {
    guardrails: { admission: detectors('admission'), recall: detectors('recall'), sources },
    embedders: [],
  };
}

const revisionOf = (...sources: GuardrailSource[]): string =>
  createHostMemory(new MemoryStorage(), contributing(...sources)).policyRevision;

describe('the host’s memory policy revision (COR-2192)', () => {
  test('is the base revision, byte for byte, when no plugin contributes a guardrail', () => {
    expect(revisionOf()).toBe('interborough:1');
    expect(MEMORY_POLICY_REVISION).toBe('interborough:1');
    expect(memoryPolicyRevision([])).toBe('interborough:1');
  });

  test('is the base revision and a SHA-256 digest of the ordered guardrails otherwise', () => {
    expect(revisionOf(source('pii'))).toMatch(/^interborough:1:sha256:[0-9a-f]{64}$/);
    // Pinned: the digest of [["kit:memory/pii","1.0.0",["admission","recall"]]], so a change to what
    // is hashed, or how, is a deliberate edit of this value and not an accident.
    expect(revisionOf(source('pii'))).toBe(
      'interborough:1:sha256:b86dfe6b14ca067043a0d1b8d10de8a801437de5dea94978520e2d2d4e7d0e70',
    );
  });

  test('is the same for the same guardrails', () => {
    expect(revisionOf(source('pii'), source('secrets'))).toBe(
      revisionOf(source('pii'), source('secrets')),
    );
  });

  test('changes when a guardrail is added', () => {
    expect(revisionOf(source('pii'), source('secrets'))).not.toBe(revisionOf(source('pii')));
    expect(revisionOf(source('pii'))).not.toBe(revisionOf());
  });

  test('changes when a guardrail is removed', () => {
    expect(revisionOf(source('pii'))).not.toBe(revisionOf(source('pii'), source('secrets')));
  });

  test('changes when the guardrails are reordered', () => {
    expect(revisionOf(source('secrets'), source('pii'))).not.toBe(
      revisionOf(source('pii'), source('secrets')),
    );
  });

  test('changes when a guardrail’s plugin is upgraded', () => {
    expect(revisionOf(source('pii', '1.1.0'))).not.toBe(revisionOf(source('pii', '1.0.0')));
  });

  test('changes when a guardrail moves to other gates', () => {
    expect(revisionOf(source('pii', '1.0.0', ['recall']))).not.toBe(
      revisionOf(source('pii', '1.0.0', ['admission', 'recall'])),
    );
  });

  test('withdraws evidence recalled under the guardrail set it replaced', async () => {
    // One database under two hosts: the second started with a guardrail the first lacked.
    const storage = new MemoryStorage();
    const before = createHostMemory(storage, contributing());
    const after = createHostMemory(storage, contributing(source('pii')));
    await before.init();
    await after.init();
    expect(after.policyRevision).not.toBe(before.policyRevision);

    const seeder = createMemoryAuthority({
      principal: { kind: 'user', id: 'owner:seed' },
      tenantId: 'tenant',
      ownerId: 'owner',
      purpose: 'conversation-memory',
      capabilities: ['memory:write'],
      policyRevision: 'authorization:1',
      projection: 'bureau',
    });
    await before.write(seeder, 'The user prefers aisle seats.', {
      collection: 'chat',
      source: 'conversation',
    });
    const reader = createMemoryAuthority({
      principal: { kind: 'user', id: 'owner:reader' },
      tenantId: 'tenant',
      ownerId: 'owner',
      purpose: 'conversation-memory',
      capabilities: ['memory:search'],
      policyRevision: 'authorization:1',
      projection: 'bureau',
    });
    const target = { collection: 'chat', sessionId: 'session-1' };

    const conversation = new Conversation();
    conversation.appendUserMessage('Which seats does the user prefer?');
    await createMemoryRecallHook(before, reader, target)({ step: 0, conversation });
    const recalled = () =>
      conversation
        .getMessages()
        .filter((message) => message.metadata?.['memoryEvidence'] !== undefined)
        .map((message) => message.content);
    expect(recalled()).toHaveLength(1);
    expect(recalled()[0]).toContain('<memory-evidence>');

    // The next step runs under the host with the new guardrail set: the old row is withdrawn.
    await createMemoryRecallHook(after, reader, target)({ step: 1, conversation });
    expect(recalled()[0]).toContain('withdrawn');
    await before.close();
    await after.close();
  });
});
