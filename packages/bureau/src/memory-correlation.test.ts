/**
 * COR-768 — the governed-memory write a Bureau run's answer produces names the
 * run, its session, and, when the run seals effective-context epochs, the epoch
 * of the attempt that produced the answer.
 */
import {
  createGovernedMemory,
  createInMemoryMemoryRecordStorage,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMockEmbedder,
  type MemoryGovernanceNotification,
} from '@lostgradient/memory';
import {
  createAgent,
  createContextEpochSealer,
  type ContextEpochSealer,
  type GenerateFunction,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/weft';
import type { ToolRequestContext } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import { waitForTaskState } from './test';
import type { Bureau } from './types';

const requestContext: ToolRequestContext = {
  authority: {
    principalId: 'api-key:alice',
    tenantId: 'tenant-a',
    ownerId: 'owner-a',
    capabilities: ['tools:execute'],
    authorizationRevision: 'gateway:1',
  },
};

const bureaus: Bureau<AgentDefinitions>[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

async function answerOnce(createContextEpoch?: () => ContextEpochSealer) {
  const notifications: MemoryGovernanceNotification[] = [];
  const memory = createGovernedMemory({
    storage: createInMemoryMemoryRecordStorage(),
    ledger: createMemoryGovernanceLedger(new MemoryStorage()),
    embedder: createMockEmbedder(16),
    policy: createMemoryGovernancePolicy({ revision: 'governance:1' }),
    onEvent: (notification) => {
      notifications.push(notification);
    },
  });
  const generate: GenerateFunction = async () => ({
    content: 'The user prefers aisle seats.',
    toolCalls: [],
  });
  const bureau = await createBureau<AgentDefinitions>({
    id: 'tenant-a',
    agents: {
      scout: createAgent({
        generate,
        ...(createContextEpoch === undefined ? {} : { createContextEpoch }),
      }),
    },
    memory,
    requestAuthorityValidator: () => true,
  });
  bureaus.push(bureau);
  const run = await bureau.tasks.start('scout', 'Where does the user like to sit?', {
    contextId: 'session-7',
    principal: 'owner-a',
    requestContext,
  });
  await waitForTaskState(bureau, run.id);
  const written = notifications.find((item) => item.type === 'memory.write.admitted');
  return { runId: run.id, written };
}

describe('the correlation of a run’s memory write (COR-768)', () => {
  it('names the run, the session, and the epoch of the attempt that produced the answer', async () => {
    const sealers: ContextEpochSealer[] = [];
    const { runId, written } = await answerOnce(() => {
      const sealer = createContextEpochSealer();
      sealers.push(sealer);
      return sealer;
    });
    const epochId = sealers.at(-1)?.current()?.epochId;
    expect(epochId).toBeDefined();
    expect(written?.correlation).toEqual({
      runId,
      sessionId: 'session-7',
      contextEpochId: epochId,
    });
  });

  it('leaves the epoch out when the run seals none', async () => {
    const { runId, written } = await answerOnce();
    expect(written?.correlation).toEqual({ runId, sessionId: 'session-7' });
  });
});
