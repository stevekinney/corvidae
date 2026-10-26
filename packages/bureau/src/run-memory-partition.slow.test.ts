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
import { MemoryStorage } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import type { AgentDefinitions } from './agent-catalog';

/** The test's own timeout, which is the same as the other scheduled-fire tests'. */
const FIRE_TIMEOUT_MS = 20_000;
/** How long the test waits for the fire. Shorter than the test's timeout, so a fire that never writes fails `expect(written)` rather than the clock. */
const FIRE_WAIT_MS = 15_000;

async function waitForReal(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

describe('a scheduled fire’s memory (COR-1546)', () => {
  it(
    'is written into the schedule owner’s partition',
    async () => {
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
        storage: { type: 'memory' },
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
        const schedule = await bureau.createSchedule({
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
        const written = await waitForReal(hasWritten, FIRE_WAIT_MS);
        await bureau.cancelSchedule(schedule!.id);

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
    },
    FIRE_TIMEOUT_MS,
  );
});
