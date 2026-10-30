/**
 * COR-1934 — the purge of a deleted chat's memories: the records its runs wrote are forgotten, by
 * the run that wrote them or, for a record with no run, by the chat; another chat's records, a
 * chat recreated under the same id, and a record under a legal hold are left.
 */
import {
  createGovernedMemory,
  createInMemoryMemoryRecordStorage,
  createMemoryAuthority,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMockEmbedder,
  type GovernedMemory,
  type MemoryAuthority,
} from '@lostgradient/memory';
import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import { purgeChatMemories } from './chat-memory-purge';

const TENANT = 'purge-bureau';
const OWNER = 'api-key:alice';

function memory(): GovernedMemory {
  return createGovernedMemory({
    storage: createInMemoryMemoryRecordStorage(),
    ledger: createMemoryGovernanceLedger(new MemoryStorage()),
    embedder: createMockEmbedder(64),
    policy: createMemoryGovernancePolicy({ revision: 'governance:purge' }),
    propagation: {
      caches: 'not-retained',
      'managed-asset-bytes': 'not-retained',
      'external-processors': 'not-retained',
    },
  });
}

function authority(kind: 'run' | 'governance', capabilities: string[]): MemoryAuthority {
  return createMemoryAuthority({
    principal: { kind, id: kind === 'run' ? 'run-1' : 'governor' },
    tenantId: TENANT,
    ownerId: OWNER,
    purpose: 'test',
    capabilities: capabilities as never,
    policyRevision: 'bureau:test',
    projection: 'bureau',
  });
}

const writer = authority('run', ['memory:write', 'memory:list', 'memory:delete', 'memory:inspect']);

async function remember(
  store: GovernedMemory,
  content: string,
  options: { runId?: string; sessionId?: string; collection?: string },
) {
  const receipt = await store.write(writer, content, {
    collection: options.collection ?? 'helper',
    source: 'conversation',
    memoryClass: 'episodic',
    metadata: { sessionId: options.sessionId },
    ...(options.runId === undefined ? {} : { runId: options.runId }),
  });
  return receipt.recordId!;
}

async function contents(store: GovernedMemory, collection = 'helper'): Promise<string[]> {
  const records = await store.list(writer, { collection, visibility: 'all' });
  return records.map((record) => record.content).toSorted();
}

function dependencies(store: GovernedMemory) {
  return {
    memory: store,
    tenantId: TENANT,
    placementOf: async (runId: string) =>
      runId === 'run-unknown' ? undefined : { agentName: 'helper', owner: OWNER },
  };
}

describe('purgeChatMemories', () => {
  it('forgets what the chat’s runs wrote, and leaves another chat’s and a recreated chat’s', async () => {
    const store = memory();
    await remember(store, 'doomed answer one', { runId: 'run-1', sessionId: 'chat-1' });
    await remember(store, 'doomed answer two', { runId: 'run-2', sessionId: 'chat-1' });
    await remember(store, 'other chat', { runId: 'run-3', sessionId: 'chat-2' });
    // The same chat id, recreated: another incarnation, whose runs are not the deleted chat's.
    await remember(store, 'recreated chat', { runId: 'run-9', sessionId: 'chat-1' });

    await purgeChatMemories(dependencies(store), {
      sessionId: 'chat-1',
      runIds: new Set(['run-1', 'run-2', 'run-unknown']),
    });

    expect(await contents(store)).toEqual(['other chat', 'recreated chat']);
  });

  it('forgets a record that names no run by its chat', async () => {
    const store = memory();
    await remember(store, 'written before records named a run', { sessionId: 'chat-1' });
    await remember(store, 'another chat’s', { sessionId: 'chat-2' });

    await purgeChatMemories(dependencies(store), {
      sessionId: 'chat-1',
      runIds: new Set(['run-1']),
    });

    expect(await contents(store)).toEqual(['another chat’s']);
  });

  it('keeps a record under a legal hold, as the hold requires, and does not fail the pass', async () => {
    const store = memory();
    const heldId = await remember(store, 'held answer', { runId: 'run-1', sessionId: 'chat-1' });
    await remember(store, 'free answer', { runId: 'run-1', sessionId: 'chat-1' });
    const governor = authority('governance', ['memory:legal-hold']);
    const held = await store.placeLegalHold(governor, {
      id: heldId,
      collection: 'helper',
      ownerId: OWNER,
    });
    expect(held.status).toBe('applied');

    await purgeChatMemories(dependencies(store), {
      sessionId: 'chat-1',
      runIds: new Set(['run-1']),
    });

    expect(await contents(store)).toEqual(['held answer']);
  });

  it('forgets a record that was superseded, which a plain listing no longer shows', async () => {
    const store = memory();
    const original = await remember(store, 'original answer', {
      runId: 'run-1',
      sessionId: 'chat-1',
    });
    await store.forget(writer, {
      mode: 'supersession',
      locator: { id: original, collection: 'helper' },
      successor: { content: 'corrected answer', collection: 'helper', source: 'operator' },
    });

    await purgeChatMemories(dependencies(store), {
      sessionId: 'chat-1',
      runIds: new Set(['run-1']),
    });

    const everything = await store.list(writer, { collection: 'helper', visibility: 'all' });
    expect(everything.map((record) => record.content)).not.toContain('original answer');
  });

  it('forgets from the placements the chat named before it was deleted when its runs left no record', async () => {
    const store = memory();
    await remember(store, 'orphaned answer', { runId: 'run-1', sessionId: 'chat-1' });
    await remember(store, 'another chat', { runId: 'run-3', sessionId: 'chat-2' });

    // The task records are gone: only what the chat named says whose memory, and under which agent.
    await purgeChatMemories(dependencies(store), {
      sessionId: 'chat-1',
      runIds: new Set(['run-unknown', 'run-1']),
      placements: [{ owner: OWNER, agentName: 'helper' }],
    });

    expect(await contents(store)).toEqual(['another chat']);
  });

  it('forgets nothing it cannot place, and rejects when a record cannot be forgotten', async () => {
    const store = memory();
    await remember(store, 'kept', { runId: 'run-1', sessionId: 'chat-1' });
    await purgeChatMemories(dependencies(store), {
      sessionId: 'chat-1',
      runIds: new Set(['run-unknown']),
    });
    expect(await contents(store)).toEqual(['kept']);

    const failing: GovernedMemory = {
      ...store,
      forget: async () => {
        throw new Error('injected: memory store down');
      },
    };
    const failure = await rejectionOf(
      purgeChatMemories(dependencies(failing), {
        sessionId: 'chat-1',
        runIds: new Set(['run-1']),
      }),
    );
    expect(String(failure)).toContain('could not be forgotten');
    expect(await contents(store)).toEqual(['kept']);
  });
});
