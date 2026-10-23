/**
 * COR-1546 — where a Bureau run's memory lives. An agent remembers across every chat its owner has
 * with it, so the collection is the agent's identifier; and what a run writes is partitioned by the
 * Bureau's identifier (the tenant) and the run's owner of record, the pair `bureau.memory.*` builds
 * its authority from, so a memory the owner's chat wrote is the owner's to list and nobody else's.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
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
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { waitForRunState } from './test';
import type { Bureau } from './types';

const BUREAU_ID = 'memory-partition-bureau';

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

function governedMemory(maxRecordsPerCollection?: number): GovernedMemory {
  const runtime = createManualRuntimeServices({ identifierSeed: 'run-memory-partition' });
  return createGovernedMemory({
    storage: createInMemoryMemoryRecordStorage({ now: () => runtime.clock.now() }),
    ledger: createMemoryGovernanceLedger(new MemoryStorage()),
    embedder: createMockEmbedder(64),
    policy: createMemoryGovernancePolicy({
      revision: 'governance:run-memory-partition',
      ...(maxRecordsPerCollection === undefined ? {} : { admission: { maxRecordsPerCollection } }),
    }),
    runtime,
  });
}

/** The owner's own authority over its own partition, as `bureau.memory.*` builds it. */
function ownerAuthority(ownerId: string, tenantId = BUREAU_ID): MemoryAuthority {
  return createMemoryAuthority({
    principal: { kind: 'user', id: ownerId },
    tenantId,
    ownerId,
    purpose: 'test',
    capabilities: ['memory:list', 'memory:get'],
    policyRevision: 'bureau:test',
    projection: 'bureau',
  });
}

/** An agent that answers `reply` and records whether recalled memory reached its conversation. */
function remembering(reply: string, recalled: string[][]) {
  const generate: GenerateFunction = async ({ conversation }) => {
    recalled.push(
      conversation
        .getMessages()
        .filter((message) => message.role === 'system')
        .map((message) => (typeof message.content === 'string' ? message.content : ''))
        .filter((content) => content.startsWith('<memory-evidence>')),
    );
    return { content: reply, toolCalls: [] };
  };
  return createAgent({ generate });
}

async function start(
  memory: GovernedMemory,
  agents: AgentDefinitions,
  onDiagnostic?: (diagnostic: { scope: string; message: string }) => void,
) {
  const bureau = await createBureau<AgentDefinitions>({
    id: BUREAU_ID,
    ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
    agents: { ...agents, default: createAgent({ stopWhen: stopWhen.noToolCalls() }) },
    memory,
    persistence: textValueStore(new MemoryStorage()),
  });
  bureaus.push(bureau);
  return bureau;
}

async function chat(
  bureau: Bureau<AgentDefinitions>,
  request: { agentName: string; sessionId: string; principal?: string; message: string },
): Promise<void> {
  const run = await bureau.createRun(request);
  await waitForRunState(bureau, run.id);
}

describe('a Bureau run’s memory (COR-1546)', () => {
  it('recalls in one chat what another chat with the same agent stored, and never across agents', async () => {
    const memory = governedMemory();
    const firstChat: string[][] = [];
    const otherAgent: string[][] = [];
    const bureau = await start(memory, {
      alpha: remembering('The user prefers aisle seats.', firstChat),
      beta: remembering('Beta has nothing to say.', otherAgent),
    });
    await chat(bureau, {
      agentName: 'alpha',
      sessionId: 'chat-1',
      principal: 'api-key:alice',
      message: 'Which seat do I like?',
    });
    expect(firstChat).toEqual([[]]);

    await chat(bureau, {
      agentName: 'alpha',
      sessionId: 'chat-2',
      principal: 'api-key:alice',
      message: 'Which seat do I like?',
    });
    // The second chat is another session of the same agent, and it recalls the first's answer.
    expect(firstChat).toHaveLength(2);
    expect(firstChat[1]).toHaveLength(1);
    expect(firstChat[1]![0]).toContain('The user prefers aisle seats.');

    // Another agent has its own collection, so the same owner's chat there recalls nothing.
    await chat(bureau, {
      agentName: 'beta',
      sessionId: 'chat-3',
      principal: 'api-key:alice',
      message: 'Which seat do I like?',
    });
    expect(otherAgent).toEqual([[]]);
  });

  it('writes a chat run’s memory into its owner’s partition, under the agent’s collection', async () => {
    const memory = governedMemory();
    const bureau = await start(memory, { alpha: remembering('Alice likes aisles.', []) });

    await chat(bureau, {
      agentName: 'alpha',
      sessionId: 'chat-1',
      principal: 'api-key:alice',
      message: 'Remember my seat.',
    });

    const owned = await memory.list(ownerAuthority('api-key:alice'), { collection: 'alpha' });
    expect(owned.map((record) => record.content)).toEqual(['Alice likes aisles.']);
    expect(owned[0]?.metadata['sessionId']).toBe('chat-1');
    // Another owner, the same agent: nothing. Another tenant: nothing.
    expect(await memory.list(ownerAuthority('api-key:bob'), { collection: 'alpha' })).toEqual([]);
    expect(
      await memory.list(ownerAuthority('api-key:alice', 'another-bureau'), { collection: 'alpha' }),
    ).toEqual([]);
    // The session is not a collection any more.
    expect(await memory.list(ownerAuthority('api-key:alice'), { collection: 'chat-1' })).toEqual(
      [],
    );
  });

  it('writes a run no principal started under anonymous:local', async () => {
    const memory = governedMemory();
    const bureau = await start(memory, { alpha: remembering('Local fact.', []) });

    await chat(bureau, { agentName: 'alpha', sessionId: 'chat-1', message: 'Remember this.' });

    const owned = await memory.list(ownerAuthority('anonymous:local'), { collection: 'alpha' });
    expect(owned.map((record) => record.content)).toEqual(['Local fact.']);
  });
});

describe('an answer governed memory rejects (COR-1546)', () => {
  it('is reported through the Bureau’s diagnostics, by reason and never by content', async () => {
    const diagnostics: Array<{ scope: string; message: string }> = [];
    const memory = governedMemory(1);
    const bureau = await start(
      memory,
      { alpha: remembering('A secret answer one.', []) },
      (diagnostic) => diagnostics.push(diagnostic),
    );

    await chat(bureau, {
      agentName: 'alpha',
      sessionId: 'chat-1',
      principal: 'api-key:alice',
      message: 'First.',
    });
    expect(diagnostics.filter((diagnostic) => diagnostic.scope === 'memory')).toEqual([]);
    await chat(bureau, {
      agentName: 'alpha',
      sessionId: 'chat-2',
      principal: 'api-key:alice',
      message: 'Second.',
    });

    const reported = diagnostics.filter((diagnostic) => diagnostic.scope === 'memory');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toContain('quota-exceeded');
    expect(reported[0]?.message).toContain('"alpha"');
    expect(reported[0]?.message).not.toContain('secret');
    // Only the first answer was stored.
    const stored = await memory.list(ownerAuthority('api-key:alice'), { collection: 'alpha' });
    expect(stored).toHaveLength(1);
  });
});
