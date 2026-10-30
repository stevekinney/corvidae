import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
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

function build(loaded: CatalogRunRecoveryLoad, childRunIds: readonly string[] = []) {
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
      abort: () => 'not-found',
      cancelChild: async () => 'not-found',
      cancelDurable: async () => ({ status: 'already-terminal' }),
      sleep: async () => undefined,
    },
    diagnose: () => undefined,
  });
  const settler = createCatalogTaskSettler({
    tasks: registry,
    loadRecoveryRecord: async () => loaded,
    durableCreatedAt: async () => '2026-10-17T12:00:00.000Z',
    isChildRun: async (runId) => childRunIds.includes(runId),
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
  it('writes no record for a recovered child run claimed before child runs were tasks', async () => {
    const { registry, settler } = build(found, ['agent-run-1']);

    await settler(settlement);

    expect(await registry.record('agent-run-1')).toBeUndefined();
    const listed = await registry.enumerate({ limit: 10, offset: 0 });
    expect(listed.tasks).toEqual([]);
  });

  it('writes no record for a recovered goal attempt or workflow step claimed before they were tasks', async () => {
    const goal = build({
      status: 'found',
      record: { ...found.record, goalAttempt: { goalRunId: 'goal-1', attemptIndex: 0 } },
    });
    const step = build({
      status: 'found',
      record: { ...found.record, workflowStep: { workflowId: 'run-1', step: 2 } },
    });

    await goal.settler(settlement);
    await step.settler(settlement);

    expect(await goal.registry.record('agent-run-1')).toBeUndefined();
    expect(await step.registry.record('agent-run-1')).toBeUndefined();
    const listed = await step.registry.enumerate({ limit: 10, offset: 0 });
    expect(listed.tasks).toEqual([]);
  });

  it.each([
    ['a child run', { kind: 'agent', parentRunId: 'run-p', agentName: 'planner' }],
    ['a goal attempt', { kind: 'goal', goalRunId: 'g1', attemptId: 'g1:a0' }],
    ['a workflow step', { kind: 'parent', parentRunId: 'instance-1' }],
    ['a run of a kind a newer release recorded', { kind: 'unheard-of', extra: 1 }],
  ] as const)(
    'writes the record of %s from the origin its claim stores, settles it, and writes it once',
    async (_label, taskOrigin) => {
      const claim: CatalogRunRecoveryLoad = {
        status: 'found',
        record: { ...found.record, taskOrigin },
      };
      // The topology holds the id, which used to exclude the run: the claim now decides.
      const { registry, settler } = build(claim, ['agent-run-1']);

      await settler(settlement);
      await settler(settlement);

      const record = await registry.record('agent-run-1');
      expect(record).toMatchObject({
        taskId: 'agent-run-1',
        contextId: 'agent-run-1',
        incarnation: '',
        origin: taskOrigin,
        settled: { status: 'completed', answer: { text: 'the answer' } },
      });
      expect(record?.history.map((message) => message.text)).toEqual(['which environment?']);
      const view = await registry.get('agent-run-1');
      expect(view?.origin).toEqual(taskOrigin.kind === 'unheard-of' ? null : taskOrigin);
      const listed = await registry.enumerate({ limit: 10, offset: 0 });
      expect(listed.tasks).toHaveLength(1);
    },
  );

  it('does not write a record from a claim for a fresh dispatch, whose own start admits it', async () => {
    const claim: CatalogRunRecoveryLoad = {
      status: 'found',
      record: { ...found.record, taskOrigin: { kind: 'parent', parentRunId: 'instance-1' } },
    };
    const { registry, settler } = build(claim);

    await settler({ ...settlement, recovered: false });

    expect(await registry.record('agent-run-1')).toBeUndefined();
  });

  it('puts a recovered run in the context its dispatch named, and in its own when it named none', async () => {
    const named = build({
      status: 'found',
      record: { ...found.record, contextId: 'named-context' },
    });
    const unnamed = build(found);

    await named.settler(settlement);
    await unnamed.settler(settlement);

    const namedRecord = await named.registry.record('agent-run-1');
    const unnamedRecord = await unnamed.registry.record('agent-run-1');
    expect(namedRecord?.contextId).toBe('named-context');
    expect(unnamedRecord?.contextId).toBe('agent-run-1');
  });

  it('writes the record of a recovered run that settles with none, dated from the durable run, and settles it', async () => {
    const { registry, settler } = build(found);

    await settler(settlement);

    const record = await registry.record('agent-run-1');
    expect(record).toMatchObject({
      taskId: 'agent-run-1',
      owner: 'api-key:alice',
      agentName: 'asker',
      // The original start is gone with its record, so nothing names a surface (COR-1867).
      origin: { kind: 'api' },
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
      origin: { kind: 'api' },
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
      origin: { kind: 'api' },
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
