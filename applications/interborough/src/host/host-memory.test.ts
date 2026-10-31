/**
 * COR-1546: the host composes governed memory for the Bureau, over Bungalow's database, with an
 * embedder that needs no model provider. Every test starts the real host on an installation that
 * has configured no provider at all, and talks to it over its own HTTP surface.
 */
import {
  collectionNamespace,
  createHashingEmbedder,
  createMemoryVectorStore,
  createWeftMemoryRecordStorage,
  DEFAULT_MEMORY_VECTOR_KEY_PREFIX,
  HASHING_EMBEDDER_DIMENSION,
  HASHING_EMBEDDER_ID,
} from '@lostgradient/memory';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enableDemoPlugin } from './demo-plugin.test-support.ts';
import { startHost, type Host } from './host.ts';
import { MEMORY_DELETION_PROPAGATION } from './memory.ts';

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
