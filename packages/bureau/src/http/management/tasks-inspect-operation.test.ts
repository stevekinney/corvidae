/**
 * COR-1810 — the reply details `bureau.tasks.inspect` returns for a run's steps: why each ran on its
 * model (`planReason`) and what that model saw (`effectiveContext`, read one step at a time), each
 * `null` for a step that kept none.
 */
import {
  createAgent,
  createContextEpochSealer,
  createModelCatalog,
  createSelectionGate,
  stopWhen,
} from '@lostgradient/operative';
import { createToolbox, type Toolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  answering,
  openBureau,
  type OpenedBureau,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const QUESTION = 'PRIVATE-QUESTION-91d4';
const NOW = '2026-09-02T12:00:00.000Z';

type InspectedStep = {
  step: number;
  messageId: string | null;
  contextEpochId: string | null;
  planReason: {
    code: string;
    detail: string;
    rejected: Array<{ provider: string; model: string; code: string }>;
  } | null;
  hasEffectiveContext: boolean;
  effectiveContext: {
    epochId?: string;
    messages: Array<{ id: string; role: string; digest: string }>;
    sources: Array<{ sourceId: string; disposition: string }>;
    messageCount: number;
    truncated: boolean;
  } | null;
};

const stepsOf = (body: RpcBody): InspectedStep[] => body.result!['steps'] as InspectedStep[];

async function open(): Promise<OpenedBureau> {
  const catalog = createModelCatalog({ now: () => NOW });
  const anthropic = catalog.descriptors.find((row) => row.provider === 'anthropic')!;
  const gate = createSelectionGate({
    request: () => ({
      agentName: 'planned',
      catalogRevision: 1,
      policyRevision: 1,
      availabilitySnapshotRevision: 1,
    }),
    options: () => ({
      catalog: {
        revision: 1,
        descriptors: [anthropic],
        generatedAt: NOW,
        stale: false,
        projection: 'privileged',
      },
      now: () => NOW,
      newPlanId: () => 'plan-1',
    }),
  });
  gate.revalidate();
  let epoch = 0;
  // `selection` is a run option an agent carries through to its runs (`session-agent-options.ts`
  // classifies it as the agent's) that `createAgent`'s own options do not name, so the options are
  // built apart from the call, which only checks an object literal for extra keys.
  const plannedOptions = {
    generate: answering('Planned answer.'),
    toolbox: createToolbox([]) as unknown as Toolbox,
    stopWhen: stopWhen.noToolCalls(),
    selection: gate,
    createContextEpoch: () => createContextEpochSealer({ newEpochId: () => `epoch-${++epoch}` }),
  };
  const opened = await openBureau({
    generate: answering('Plain answer.'),
    agents: {
      planned: createAgent(plannedOptions),
    },
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

describe('bureau.tasks.inspect reply details', () => {
  it('returns the plan reason and the effective context of a planned run’s step', async () => {
    const opened = await open();
    const task = await opened.bureau.tasks.start('planned', QUESTION, {
      principal: 'api-key:alice',
    });
    await task.result();

    // The list form is polled, so it carries a marker; the record comes with a read of one step.
    const listed = await rpc(
      opened.handler,
      'bureau.tasks.inspect',
      { taskId: task.id },
      'alice-key',
    );
    expect(stepsOf(listed).every((entry) => entry.effectiveContext === null)).toBe(true);
    expect(stepsOf(listed).every((entry) => entry.hasEffectiveContext)).toBe(true);

    const body = await rpc(
      opened.handler,
      'bureau.tasks.inspect',
      { taskId: task.id, step: 0 },
      'alice-key',
    );

    expect(body.error).toBeUndefined();
    const [step] = stepsOf(body);
    expect(step?.planReason).toMatchObject({ code: 'policy', rejected: [] });
    expect(step?.contextEpochId).toBe('epoch-1');
    expect(step?.effectiveContext?.epochId).toBe('epoch-1');
    expect(step?.effectiveContext?.truncated).toBe(false);
    expect(step?.effectiveContext?.messages.map((message) => message.role)).toContain('user');
    expect(
      step?.effectiveContext?.sources.find((source) => source.sourceId === 'selection-plan')
        ?.disposition,
    ).toBe('included');
    // Ids and digests only: the question never leaves the run.
    expect(JSON.stringify(body)).not.toContain(QUESTION);
  });

  it('reads pinned and an epoch-less context for a default agent that names its own model', async () => {
    const opened = await open();
    const task = await opened.bureau.tasks.start('default', QUESTION, {
      principal: 'api-key:alice',
    });
    await task.result();

    const body = await rpc(
      opened.handler,
      'bureau.tasks.inspect',
      { taskId: task.id, step: 0 },
      'alice-key',
    );

    expect(body.error).toBeUndefined();
    const [step] = stepsOf(body);
    expect(step?.planReason).toMatchObject({ code: 'pinned', rejected: [] });
    expect(step?.contextEpochId).toBeNull();
    expect(step?.hasEffectiveContext).toBe(true);
    expect(step?.effectiveContext?.epochId).toBeUndefined();
    expect(step?.effectiveContext?.messages.map((message) => message.role)).toContain('user');
    expect(JSON.stringify(body)).not.toContain(QUESTION);
  });

  it('returns only the step asked for', async () => {
    const opened = await open();
    const task = await opened.bureau.tasks.start('planned', QUESTION, {
      principal: 'api-key:alice',
    });
    await task.result();

    const asked = await rpc(
      opened.handler,
      'bureau.tasks.inspect',
      { taskId: task.id, step: 0 },
      'alice-key',
    );
    const missing = await rpc(
      opened.handler,
      'bureau.tasks.inspect',
      { taskId: task.id, step: 99 },
      'alice-key',
    );

    expect(stepsOf(asked).map((step) => step.step)).toEqual([0]);
    expect(stepsOf(missing)).toEqual([]);
  });

  it('shows another owner’s task as a missing one, reply details included', async () => {
    const opened = await open();
    const task = await opened.bureau.tasks.start('planned', QUESTION, {
      principal: 'api-key:alice',
    });
    await task.result();

    const body = await rpc(opened.handler, 'bureau.tasks.inspect', { taskId: task.id }, 'bob-key');

    expect(body.result).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('epoch-1');
  });
});
