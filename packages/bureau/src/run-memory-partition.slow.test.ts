/**
 * COR-1546 — a schedule's fire writes memory into the schedule owner's partition, under the agent
 * the schedule names, and not under the scheduler's own identity. The engine's schedule poller runs
 * on real elapsed time, so this test is slow, like the other scheduled-fire tests.
 */
import {
  createGovernedMemory,
  createInMemoryMemoryRecordStorage,
  createMemoryAuthority,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMockEmbedder,
} from '@lostgradient/memory';
import { stopWhen, createAgent } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import type { AgentDefinitions } from './agent-catalog';
import { waitUntil } from '@lostgradient/testing/wait-until';

async function waitForReal(condition: () => Promise<boolean>): Promise<true> {
  await waitUntil(condition, { message: 'waitForReal' });
  return true;
}

describe('a scheduled fire’s memory (COR-1546)', () => {
  it('is written into the schedule owner’s partition', async () => {
    const memory = createGovernedMemory({
      storage: createInMemoryMemoryRecordStorage(),
      ledger: createMemoryGovernanceLedger(new MemoryStorage()),
      embedder: createMockEmbedder(64),
      policy: createMemoryGovernancePolicy({ revision: 'governance:scheduled-fire' }),
    });
    const bureau = await createBureau<AgentDefinitions>({
      id: 'scheduled-memory-bureau',
      agents: {
        default: createAgent({
          generate: async () => ({ content: 'The digest is ready.', toolCalls: [] }),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
      memory,
    });
    const as = (ownerId: string) =>
      createMemoryAuthority({
        principal: { kind: 'user', id: ownerId },
        tenantId: 'scheduled-memory-bureau',
        ownerId,
        purpose: 'test',
        capabilities: ['memory:list'],
        policyRevision: 'bureau:test',
        projection: 'bureau',
      });
    try {
      const schedule = await bureau.schedules.create({
        agentName: 'default',
        input: 'Write the digest.',
        spec: '1s',
        principal: 'api-key:alice',
      });
      expect(schedule).toBeDefined();

      const hasWritten = async (): Promise<boolean> => {
        const listed = await memory.list(as('api-key:alice'), { collection: 'default' });
        return listed.length > 0;
      };
      const written = await waitForReal(hasWritten);
      await bureau.schedules.cancel(schedule!.id);

      expect(written).toBe(true);
      const [stored] = await memory.list(as('api-key:alice'), { collection: 'default' });
      expect(stored?.content).toBe('The digest is ready.');
      // The fire's run acts for its owner, so the scheduler's own identity owns nothing.
      expect(await memory.list(as('system:scheduler'), { collection: 'default' })).toEqual([]);
      expect(await memory.list(as('default'), { collection: 'default' })).toEqual([]);
      expect(await memory.list(as('api-key:bob'), { collection: 'default' })).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });
});
