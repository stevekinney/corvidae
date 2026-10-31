/**
 * COR-1809 — `retention.memory` is the window the maintenance pass sweeps governed memory under, in
 * place of the policy's 90-day episodic rule. The sweep is audited by governed memory's
 * `memory.retention.swept` ledger event, which reaches the Bureau's emitter and event feed as a
 * `memory.governance` event whose `type` is `memory.retention.swept`. Every test moves the manual
 * clock; none waits on wall time.
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
  createMemoryVectorStore,
  createTestEmbedders,
} from '@lostgradient/memory';
import { createAgent } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog.ts';
import { projectBureauEvent } from './bureau-event-feed.ts';
import { createBureau } from './create-bureau.ts';
import { MemoryGovernanceEvent } from './events.ts';
import type { Bureau, BureauOptions } from './types.ts';

const BUREAU_ID = 'memory-retention-setting';
const DAY = 86_400_000;

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

const counsel = createMemoryAuthority({
  principal: { kind: 'governance', id: 'governance:counsel' },
  tenantId: BUREAU_ID,
  ownerId: 'governance-office',
  purpose: 'legal-hold',
  capabilities: ['memory:legal-hold'],
  policyRevision: 'bureau:test',
  projection: 'administrative',
});

async function start(retention?: BureauOptions<AgentDefinitions>['retention']) {
  const runtime = createManualRuntimeServices({ identifierSeed: 'memory-retention-setting' });
  const memory: GovernedMemory = createGovernedMemory({
    storage: createInMemoryMemoryRecordStorage({ now: () => runtime.clock.now() }),
    ledger: createMemoryGovernanceLedger(new MemoryStorage()),
    ...createTestEmbedders(createMockEmbedder(64), 64),
    vectors: createMemoryVectorStore(new MemoryStorage()),
    policy: createMemoryGovernancePolicy({ revision: 'governance:retention-setting' }),
    runtime,
  });
  const heard: MemoryGovernanceEvent[] = [];
  const bureau = await createBureau<AgentDefinitions>({
    id: BUREAU_ID,
    agents: { default: createAgent({ generate: async () => ({ content: 'ok', toolCalls: [] }) }) },
    storage: new MemoryStorage(),
    durable: false,
    maintenance: 'manual',
    memory,
    runtime,
    ...(retention === undefined ? {} : { retention }),
    onEvent: (event) => {
      if (event instanceof MemoryGovernanceEvent) heard.push(event);
    },
  });
  bureaus.push(bureau);
  return { bureau, memory, runtime, heard };
}

async function remember(memory: GovernedMemory, content: string): Promise<string> {
  const receipt = await memory.write(alice, content, {
    collection: 'assistant',
    source: 'conversation',
    memoryClass: 'episodic',
  });
  return receipt.recordId!;
}

async function contents(memory: GovernedMemory): Promise<string[]> {
  const records = await memory.list(alice, { collection: 'assistant' });
  return records.map((record) => record.content);
}

describe('retention.memory', () => {
  it('sweeps an expired memory on maintain and emits memory.retention.swept', async () => {
    const { bureau, memory, runtime, heard } = await start({ memory: { olderThan: 7 * DAY } });
    const recordId = await remember(memory, 'An old answer.');
    await runtime.advance(8 * DAY);
    expect(await contents(memory)).toEqual(['An old answer.']);

    expect(await bureau.maintain()).toBe(true);

    expect(await contents(memory)).toEqual([]);
    const swept = heard.filter((event) => event.notificationType === 'memory.retention.swept');
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({
      outcome: 'applied',
      tenantId: BUREAU_ID,
      recordIds: [recordId],
    });
    // The feed publishes it with identifiers only, never the memory's text.
    const projection = projectBureauEvent(swept[0]);
    expect(projection).toMatchObject({
      kind: 'memory.governance',
      payload: { type: 'memory.retention.swept', recordIds: [recordId] },
    });
    expect(JSON.stringify(projection)).not.toContain('An old answer.');
  });

  it('keeps a memory under legal hold, and one the window has not reached', async () => {
    const { bureau, memory, runtime } = await start({ memory: { olderThan: 7 * DAY } });
    const heldId = await remember(memory, 'Held.');
    await memory.placeLegalHold(counsel, { id: heldId, collection: 'assistant', ownerId: 'alice' });
    await runtime.advance(6 * DAY);
    await remember(memory, 'Recent.');
    await runtime.advance(2 * DAY);

    await bureau.maintain();

    const remaining = await contents(memory);
    expect(remaining.toSorted()).toEqual(['Held.', 'Recent.']);
  });

  it('leaves the memory policy’s 90 days in force when it is unset', async () => {
    const { bureau, memory, runtime, heard } = await start();
    await remember(memory, 'An old answer.');
    await runtime.advance(8 * DAY);

    await bureau.maintain();

    expect(await contents(memory)).toEqual(['An old answer.']);
    expect(heard.filter((event) => event.notificationType === 'memory.retention.swept')).toEqual(
      [],
    );
  });

  it('is read by the next pass when it is changed through bureau.settings', async () => {
    const { bureau, memory, runtime } = await start();
    await remember(memory, 'An old answer.');
    await runtime.advance(8 * DAY);
    await bureau.maintain();
    expect(await contents(memory)).toEqual(['An old answer.']);

    const { revision } = await bureau.settings.get();
    const result = await bureau.settings.update(
      { 'retention.memory': { olderThan: 7 * DAY } },
      { expectedRevision: revision },
    );
    expect(result.outcome).toBe('applied');
    await bureau.maintain();

    expect(await contents(memory)).toEqual([]);
  });

  it('refuses a window that is not a positive integer at construction', async () => {
    for (const bad of [0, -1, 1.5, '7d']) {
      const failure = await createBureau<AgentDefinitions>({
        agents: {},
        retention: { memory: { olderThan: bad as number } },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
      expect((failure as Error).message).toContain('options.retention.memory');
    }
  });
});
