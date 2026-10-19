import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { CatalogRunSettlement } from './catalog-run-settlement';
import { createCatalogTaskSettler } from './catalog-task-settlement';
import { createTaskRegistry } from './task-registry';
import type { CatalogRunRecoveryLoad } from './runtime-composition';

const settlement: CatalogRunSettlement = {
  runId: 'agent-run-1',
  agentName: 'asker',
  status: 'completed',
  finishReason: 'stop-condition',
  message: null,
  content: 'the answer',
  recovered: true,
};

function build(loaded: CatalogRunRecoveryLoad) {
  const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
  const registry = createTaskRegistry({
    kv: textValueStore(new MemoryStorage()),
    clock: runtime.clock,
    identifiers: runtime.identifiers,
    host: {
      liveTask: () => undefined,
      liveTasksOfContexts: () => new Map(),
      pendingReviews: () => [],
      currentIncarnation: async () => undefined,
      abort: () => false,
      cancelDurable: async () => ({ status: 'already-terminal' }),
      sleep: async () => undefined,
    },
    diagnose: () => undefined,
  });
  const settler = createCatalogTaskSettler({
    tasks: registry,
    loadRecoveryRecord: async () => loaded,
    durableCreatedAt: async () => '2026-10-17T12:00:00.000Z',
    now: runtime.clock.nowISO,
    ownerOf: (principal) => principal ?? 'anonymous:local',
    originatingMessage: (input) => (typeof input === 'string' ? input : undefined),
  });
  return { registry, settler };
}

const found: CatalogRunRecoveryLoad = {
  status: 'found',
  record: {
    schemaVersion: 1,
    agentName: 'asker',
    definitionRevision: 0,
    input: 'which environment?',
    principal: 'api-key:alice',
  },
};

describe('settling a catalog task from the hook', () => {
  it('writes the record of a recovered run that settles with none, dated from the durable run, and settles it', async () => {
    const { registry, settler } = build(found);

    await settler(settlement);

    const record = await registry.record('agent-run-1');
    expect(record).toMatchObject({
      taskId: 'agent-run-1',
      owner: 'api-key:alice',
      agentName: 'asker',
      createdAt: '2026-10-17T12:00:00.000Z',
      settled: { status: 'completed', answer: { text: 'the answer' } },
    });
    expect(record?.history.map((message) => message.text)).toEqual(['which environment?']);
  });

  it('leaves the settled record alone when reconcile writes its admission afterwards', async () => {
    const { registry, settler } = build(found);
    await settler(settlement);

    await registry.recordAdmission({
      taskId: 'agent-run-1',
      contextId: 'agent-run-1',
      incarnation: '',
      agentName: 'asker',
      owner: 'api-key:alice',
      message: 'which environment?',
    });

    const record = await registry.record('agent-run-1');
    expect(record?.settled?.status).toBe('completed');
  });

  it('settles the record a reconcile wrote first, and is idempotent for a second delivery', async () => {
    const { registry, settler } = build(found);
    await registry.recordAdmission({
      taskId: 'agent-run-1',
      contextId: 'agent-run-1',
      incarnation: '',
      agentName: 'asker',
      owner: 'api-key:alice',
      message: 'which environment?',
    });

    await settler(settlement);
    const once = await registry.record('agent-run-1');
    await settler(settlement);
    const twice = await registry.record('agent-run-1');

    expect(once?.settled).toMatchObject({ status: 'completed', answer: { text: 'the answer' } });
    expect(twice?.settled?.status).toBe('completed');
    expect(twice?.history).toEqual(once?.history);
  });

  it('writes nothing for a run it has no recovery record for, or for a fresh dispatch with no task record', async () => {
    const missing = build({ status: 'missing' });
    await missing.settler(settlement);
    const fresh = build(found);
    await fresh.settler({ ...settlement, recovered: false });

    expect(await missing.registry.record('agent-run-1')).toBeUndefined();
    expect(await fresh.registry.record('agent-run-1')).toBeUndefined();
  });
});
