/**
 * COR-1546 — governed memory runs nothing on a timer, so a deletion's bounded-async targets settle
 * only when something calls `processDeletionPropagation()`. Bureau's maintenance pass, the manual
 * `maintain()` and the automatic timer both, is that caller.
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
  type MemoryDeletionPropagator,
  type MemoryDeletionReceipt,
} from '@lostgradient/memory';
import { stopWhen, waitForCondition, createAgent } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import type { Bureau } from './types';
import type { AgentDefinitions } from './agent-catalog';

const bureaus: Bureau[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

const owner = createMemoryAuthority({
  principal: { kind: 'user', id: 'owner-a' },
  tenantId: 'deletion-bureau',
  ownerId: 'owner-a',
  purpose: 'test',
  capabilities: ['memory:write', 'memory:delete', 'memory:list'],
  policyRevision: 'bureau:test',
  projection: 'bureau',
});

/** A processor that reports pending on its first attempt and completed on every later one. */
function slowProcessor(): MemoryDeletionPropagator & { readonly attempts: () => number } {
  let attempts = 0;
  return {
    attempts: () => attempts,
    propagate: async () => (++attempts === 1 ? { status: 'pending' } : { status: 'completed' }),
  };
}

function fixture(overrides: { wrap?: (memory: GovernedMemory) => GovernedMemory } = {}) {
  const runtime = createManualRuntimeServices({ identifierSeed: 'memory-deletion' });
  const processor = slowProcessor();
  const memory = createGovernedMemory({
    storage: createInMemoryMemoryRecordStorage({ now: () => runtime.clock.now() }),
    ledger: createMemoryGovernanceLedger(new MemoryStorage()),
    embedder: createMockEmbedder(64),
    policy: createMemoryGovernancePolicy({ revision: 'governance:deletion' }),
    propagation: {
      caches: 'not-retained',
      'managed-asset-bytes': 'not-retained',
      'external-processors': processor,
    },
    runtime,
  });
  return { runtime, processor, memory, served: overrides.wrap?.(memory) ?? memory };
}

async function forgetOne(memory: GovernedMemory): Promise<MemoryDeletionReceipt> {
  const written = await memory.write(owner, 'The user prefers aisle seats.', {
    collection: 'agent',
    source: 'conversation',
  });
  const forgotten = await memory.forget(owner, {
    mode: 'source-deletion',
    locator: { id: written.recordId!, collection: 'agent' },
  });
  expect(forgotten.deletion).toBe('completed');
  return forgotten.receipt!;
}

async function statusOf(
  memory: GovernedMemory,
  receipt: MemoryDeletionReceipt,
  target: string,
): Promise<string | undefined> {
  const current = await memory.getDeletionReceipt(owner, receipt.deletionId);
  return current?.targets.find((row) => row.target === target)?.status;
}

async function start(
  memory: GovernedMemory,
  runtime: ReturnType<typeof createManualRuntimeServices>,
) {
  const diagnostics: string[] = [];
  const bureau = await createBureau<AgentDefinitions>({
    id: 'deletion-bureau',
    agents: {
      default: createAgent({
        generate: async () => ({ content: 'ok', toolCalls: [] }),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    memory,
    runtime,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
  });
  bureaus.push(bureau);
  return { bureau, diagnostics };
}

describe('a memory deletion across Bureau maintenance (COR-1546)', () => {
  it('settles a pending target when the maintenance pass runs, and reports durable snapshots as retained', async () => {
    const { runtime, processor, memory } = fixture();
    const { bureau } = await start(memory, runtime);
    const receipt = await forgetOne(memory);
    // The record is gone, and the targets that wait on something else are still pending.
    expect(await statusOf(memory, receipt, 'source-evidence')).toBe('completed');
    expect(await statusOf(memory, receipt, 'external-processors')).toBe('pending');
    expect(await statusOf(memory, receipt, 'durable-snapshots')).toBe('pending');

    expect(await bureau.maintain()).toBe(true);

    expect(processor.attempts()).toBe(2);
    expect(await statusOf(memory, receipt, 'external-processors')).toBe('completed');
    // Recalled text is appended to the conversation and persisted with it, so scrubbing it is out of
    // scope: the target stays pending until its deadline, and then fails.
    expect(await statusOf(memory, receipt, 'durable-snapshots')).toBe('pending');
  });

  it('settles a pending target on the automatic maintenance timer', async () => {
    const { runtime, processor, memory } = fixture();
    await start(memory, runtime);
    const receipt = await forgetOne(memory);
    expect(await statusOf(memory, receipt, 'external-processors')).toBe('pending');

    await runtime.advance(300_000);
    await waitForCondition(
      async () => (await statusOf(memory, receipt, 'external-processors')) === 'completed',
      'expected the automatic maintenance timer to propagate the deletion',
    );
    expect(processor.attempts()).toBe(2);
  });

  it('diagnoses a failed propagation pass without failing the maintenance call', async () => {
    const { runtime, memory, served } = fixture({
      wrap: (inner) => ({
        ...inner,
        init: () => inner.init(),
        close: () => inner.close(),
        processDeletionPropagation: () => Promise.reject(new Error('ledger unavailable')),
      }),
    });
    const { bureau, diagnostics } = await start(served, runtime);
    expect(memory).not.toBe(served);

    expect(await bureau.maintain()).toBe(true);

    expect(
      diagnostics.some(
        (message) =>
          message.includes('memory deletion propagation pass failed') &&
          message.includes('ledger unavailable'),
      ),
    ).toBe(true);
  });
});
