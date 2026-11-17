/**
 * COR-2097 — `hook-plan.failed` is published once for a hook of a run's plan that threw, with the
 * registration, the hook point, who registered it and an error code, and no error text; and the
 * same failure is in the audit trail, which keeps the error for an authorized read. A chat run, a
 * goal attempt, a child run and a workflow `agent` step each raise it, and the published event is
 * the same for all four.
 */
import { HookRegistry } from '@lostgradient/lifecycle';
import {
  createAgent,
  type GenerateFunction,
  type OperativeHookMap,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import { createCheckValidator, goalRequest } from './testing/goal-fixtures.test-support';
import { startWorkflowBureau } from './testing/workflow-bureau.test-support';

const CANARY = 'CANARY-2097-HOOK-3f9a';

/** A plan whose agent-tier hook throws on every step, and lets the run go on. */
function throwingPlan(): HookRegistry<OperativeHookMap> {
  const hooks = new HookRegistry<OperativeHookMap>({ source: 'agent', onError: () => 'continue' });
  hooks.on(
    'onStep',
    async () => {
      throw new Error(`the hook failed: ${CANARY}`, { cause: new Error(`cause ${CANARY}`) });
    },
    { id: 'agent:boom', replay: 'safe' },
  );
  return hooks;
}

const answers: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });
const parked: GenerateFunction = ({ signal }) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

function hookedWorker() {
  return createAgent({
    name: 'worker',
    generate: answers,
    stopWhen: stopWhen.noToolCalls(),
    hooks: throwingPlan(),
  });
}

const bureaus: Bureau[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

async function published(bureau: Bureau, kind: string, runId: string) {
  await bureau.internals.taskRegistry.flush();
  const found: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  for await (const envelope of bureau.internals.eventFeed.feed.replay()) {
    const entry = envelope as unknown as (typeof found)[number];
    if (entry.kind === kind && entry.payload['runId'] === runId) found.push(entry);
  }
  return found;
}

async function terminal(bureau: Bureau, taskId: string): Promise<void> {
  await waitUntil(
    async () => {
      const task = await bureau.tasks.get(taskId);
      return task !== undefined && ['completed', 'failed', 'canceled'].includes(task.status);
    },
    { message: `task ${taskId} is terminal` },
  );
}

/** What the event carries: the run, the registration, the hook point, the registrant and a code. */
const FAILED_HOOK = {
  hookId: 'agent:boom',
  hookName: 'onStep',
  source: 'agent',
  errorCode: 'INTERNAL_ERROR',
} as const;

async function open(agents: AgentDefinitions, goals: boolean) {
  const bureau = await createBureau<AgentDefinitions>({
    agents,
    storage: new MemoryStorage(),
    ...(goals ? { durable: true, validators: [createCheckValidator()] } : {}),
    onDiagnostic: () => undefined,
  });
  bureaus.push(bureau);
  return bureau;
}

describe('hook-plan.failed on the feed (COR-2097)', () => {
  it('is published once, with exactly its fields, for a chat run, and the audit trail keeps the failure', async () => {
    const bureau = await open({ worker: hookedWorker() }, false);
    const run = await bureau.tasks.start('worker', 'go', { principal: 'alice' });
    await terminal(bureau, run.id);

    const events = await published(bureau, 'hook-plan.failed', run.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ runId: run.id, ...FAILED_HOOK });
    expect(JSON.stringify(events)).not.toContain(CANARY);

    await bureau.internals.taskRegistry.flush();
    const records = await bureau.internals.auditTrail!.query({ runId: run.id });
    const audited = records.filter((record) => record.type === 'hook-plan.failed');
    expect(audited).toHaveLength(1);
    expect(audited[0]?.detail).toMatchObject({
      hookId: 'agent:boom',
      hookName: 'onStep',
      source: 'agent',
    });
    // The text is on the audit record, for an authorized read, and nowhere that is pushed.
    expect(JSON.stringify(audited[0]?.detail)).toContain(CANARY);
  });

  it('is published once, with exactly its fields, for a goal attempt, and the audit trail keeps the failure', async () => {
    const bureau = await open({ worker: hookedWorker() }, true);
    await bureau.goals.create(goalRequest({ goalRunId: 'g1' }));
    await terminal(bureau, 'goal-g1-a0');

    const events = await published(bureau, 'hook-plan.failed', 'goal-g1-a0');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ runId: 'goal-g1-a0', ...FAILED_HOOK });
    expect(JSON.stringify(events)).not.toContain(CANARY);

    // A goal attempt is not on the run store, so only its own event could have reached the trail.
    await bureau.internals.taskRegistry.flush();
    expect(bureau.internals.store.getRun('goal-g1-a0')).toBeUndefined();
    const records = await bureau.internals.auditTrail!.query({ runId: 'goal-g1-a0' });
    const audited = records.filter((record) => record.type === 'hook-plan.failed');
    expect(audited).toHaveLength(1);
    expect(audited[0]?.detail).toMatchObject({
      hookId: 'agent:boom',
      hookName: 'onStep',
      source: 'agent',
    });
  });

  it('is published once, with exactly its fields, for a child run', async () => {
    const bureau = await open(
      {
        planner: createAgent({
          name: 'planner',
          generate: parked,
          stopWhen: stopWhen.noToolCalls(),
        }),
        worker: hookedWorker(),
      },
      false,
    );
    const parent = await bureau.tasks.start('planner', 'plan', { principal: 'alice' });
    const dispatched = await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'worker',
      input: 'go',
      principal: 'alice',
      childRunId: 'child-1',
    });
    expect(dispatched).toMatchObject({ outcome: 'started' });
    await terminal(bureau, 'child-1');

    const events = await published(bureau, 'hook-plan.failed', 'child-1');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ runId: 'child-1', ...FAILED_HOOK });
    expect(JSON.stringify(events)).not.toContain(CANARY);
  });

  it('is published once, with exactly its fields, for a workflow agent step', async () => {
    const harness = await startWorkflowBureau({
      agentNames: [],
      overrides: { agents: { writer: hookedWorker() } },
    });
    bureaus.push(harness.bureau);
    await harness.putWorkflow('digest', {
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [
        {
          kind: 'activity',
          handler: 'agent',
          input: { agent: 'writer', message: 'Write' },
        },
      ],
    });
    const run = await harness.bureau.durableEngine()?.start('digest', null, { id: 'instance-1' });
    let stepId = '';
    await waitUntil(
      async () => {
        const runs = await harness.bureau.durableEngine()?.list({ type: 'agentRun' });
        stepId = runs?.items[0]?.id ?? '';
        return stepId !== '' && (await harness.bureau.tasks.get(stepId)) !== undefined;
      },
      { message: 'the step run is a task' },
    );
    await run?.result().catch(() => undefined);
    await terminal(harness.bureau, stepId);

    const events = await published(harness.bureau, 'hook-plan.failed', stepId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ runId: stepId, ...FAILED_HOOK });
    expect(JSON.stringify(events)).not.toContain(CANARY);
  });

  it('omits the registrant when no one named one, and an error with no code is INTERNAL_ERROR', async () => {
    const hooks = new HookRegistry<OperativeHookMap>({ onError: () => 'continue' });
    hooks.on(
      'onStep',
      async () => {
        throw new Error(CANARY);
      },
      { id: 'anonymous', replay: 'safe' },
    );
    const bureau = await open(
      {
        worker: createAgent({
          name: 'worker',
          generate: answers,
          stopWhen: stopWhen.noToolCalls(),
          hooks,
        }),
      },
      false,
    );
    const run = await bureau.tasks.start('worker', 'go', { principal: 'alice' });
    await terminal(bureau, run.id);

    const [event] = await published(bureau, 'hook-plan.failed', run.id);
    expect(event?.payload).toEqual({
      runId: run.id,
      hookId: 'anonymous',
      hookName: 'onStep',
      errorCode: 'INTERNAL_ERROR',
    });
  });
});
