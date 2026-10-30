/**
 * COR-1868 (part B) — a child run, a goal attempt and a workflow `agent` step are tasks of their
 * own: each is admitted after its start committed, with the origin its claim stores, listed under
 * its parent, settled from its own run's end, and cancelled by the owner of the run.
 *
 * Over a real `createBureau`; the crash and restart cases are in
 * `subordinate-tasks-recovery.test.ts`.
 */
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import {
  CHECK,
  cancelUntilSettled,
  createCheckValidator,
  goalRequest,
  hangUntilAborted,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import {
  IMMEDIATE_TASK_RETENTION,
  retireSettledTasksOnRealClock,
} from './testing/run-retirement.test-support';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import { taskOriginParentTag } from './task-origin';
import type { TaskView } from './task-registry';
import type { Bureau } from './types';

const bureaus: Bureau<AgentDefinitions>[] = [];
const harnesses: WorkflowBureauHarness[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

const completes =
  (content = 'child done'): GenerateFunction =>
  async () => ({
    content,
    toolCalls: [],
  });

function agentOf(name: string, generate: GenerateFunction) {
  return createAgent({ name, generate, stopWhen: stopWhen.noToolCalls() });
}

async function open(
  agents: Record<string, ReturnType<typeof agentOf>>,
  extra: Partial<Parameters<typeof createBureau>[0]> = {},
) {
  const bureau = await createBureau<AgentDefinitions>({
    agents,
    storage: new MemoryStorage(),
    durable: true,
    onDiagnostic: () => undefined,
    ...extra,
  });
  bureaus.push(bureau);
  return bureau;
}

async function statusOf(bureau: Bureau, id: string) {
  const task = await bureau.tasks.get(id);
  return task?.status;
}

async function taskOf(bureau: Bureau, id: string) {
  await waitUntil(async () => (await bureau.tasks.get(id)) !== undefined, {
    message: `task ${id} exists`,
  });
  return (await bureau.tasks.get(id))!;
}

async function statusReaches(bureau: Bureau, id: string, status: string) {
  await waitUntil(async () => (await statusOf(bureau, id)) === status, {
    message: `task ${id} is ${status}`,
  });
}

/** A parent task that stays running, and a child of it. */
async function parentWithChild(
  worker: GenerateFunction,
  dispatch: { readonly childRunId?: string; readonly toolCallId?: string } = {},
  extra: Partial<Parameters<typeof createBureau>[0]> = {},
) {
  const bureau = await open(
    { planner: agentOf('planner', hangUntilAborted), worker: agentOf('worker', worker) },
    extra,
  );
  const parent = await bureau.tasks.start('planner', 'plan the work', { principal: 'alice' });
  const dispatched = await bureau.children.dispatch({
    parentRunId: parent.id,
    agentName: 'worker',
    input: 'do the work',
    principal: 'alice',
    childRunId: dispatch.childRunId ?? 'child-1',
    ...(dispatch.toolCallId === undefined ? {} : { toolCallId: dispatch.toolCallId }),
  });
  if (dispatched.outcome !== 'started') throw new Error('expected a started child');
  return { bureau, parent, childId: dispatched.child.childRunId };
}

describe('a child run', () => {
  it('reads back as a task with an agent origin, owned by its parent’s owner', async () => {
    const { bureau, parent, childId } = await parentWithChild(hangUntilAborted, {
      toolCallId: 'call-7',
    });

    const task = await taskOf(bureau, childId);

    expect(task).toMatchObject({
      id: childId,
      kind: 'catalog',
      contextId: childId,
      agentName: 'worker',
      owner: 'alice',
      status: 'working',
      origin: {
        kind: 'agent',
        parentRunId: parent.id,
        parentContextId: parent.contextId,
        agentName: 'planner',
        toolCallId: 'call-7',
      },
    });
  });

  it('records no tool call and no parent session when the parent has neither', async () => {
    const { bureau, parent, childId } = await parentWithChild(hangUntilAborted);

    const task = await taskOf(bureau, childId);

    expect(task.origin).toEqual({
      kind: 'agent',
      parentRunId: parent.id,
      parentContextId: parent.contextId,
      agentName: 'planner',
    });
  });

  it('tags the workflow with its origin and its parent', async () => {
    const { bureau, parent, childId } = await parentWithChild(hangUntilAborted);
    await taskOf(bureau, childId);

    const state = await bureau.durableEngine()!.get(childId);
    const listed = await bureau.durableEngine()!.list({
      type: 'agentRun',
      tags: [taskOriginParentTag(parent.id)],
    });

    expect(state?.tags).toEqual(
      expect.arrayContaining(['origin:agent', `origin-parent:${parent.id}`]),
    );
    expect(listed.items.map((item) => item.id)).toEqual([childId]);
  });

  it('is listed by parentRunId and by siblingsOf, across pages', async () => {
    const { bureau, parent } = await parentWithChild(hangUntilAborted, { childRunId: 'child-a' });
    for (const childRunId of ['child-b', 'child-c']) {
      await bureau.children.dispatch({
        parentRunId: parent.id,
        agentName: 'worker',
        input: 'more',
        principal: 'alice',
        childRunId,
      });
    }
    for (const id of ['child-a', 'child-b', 'child-c']) await taskOf(bureau, id);
    const registry = bureau.internals.taskRegistry;

    const ids = async (query: { parentRunId?: string; siblingsOf?: string; origin?: 'agent' }) => {
      const found: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await registry.list<TaskView>({
          principal: 'alice',
          limit: 1,
          ...query,
          pageToken,
        });
        found.push(...page.tasks.map((task) => task.id));
        pageToken = page.nextPageToken ?? undefined;
      } while (pageToken !== undefined);
      return found.toSorted();
    };

    expect(await ids({ parentRunId: parent.id })).toEqual(['child-a', 'child-b', 'child-c']);
    expect(await ids({ siblingsOf: 'child-a' })).toEqual(['child-b', 'child-c']);
    expect(await ids({ origin: 'agent' })).toEqual(['child-a', 'child-b', 'child-c']);
    expect(await ids({ parentRunId: 'nobody' })).toEqual([]);
    // The default listing holds them beside the parent (the owner’s one runs list).
    expect(await ids({})).toEqual([parent.id, 'child-a', 'child-b', 'child-c'].toSorted());
  });

  it('settles its task from its own end, and the topology keeps its own record', async () => {
    const { bureau, parent, childId } = await parentWithChild(completes('child answer'));

    await statusReaches(bureau, childId, 'completed');

    const task = (await bureau.tasks.get(childId))!;
    expect(task).toMatchObject({ status: 'completed', finishReason: 'stop-condition' });
    expect(
      await bureau.children.get({ parentRunId: parent.id, childRunId: childId }),
    ).toMatchObject({
      status: 'completed',
      outcome: { content: 'child answer' },
    });
    // The parent is untouched by its child’s end.
    expect(await statusOf(bureau, parent.id)).toBe('working');
  });

  it('is stopped by tasks.cancel exactly as children.cancel stops it', async () => {
    const { bureau, parent, childId } = await parentWithChild(hangUntilAborted);
    await taskOf(bureau, childId);

    const outcome = await bureau.tasks.cancel(childId);

    expect(outcome.receipt).not.toBe('rejected');
    await statusReaches(bureau, childId, 'canceled');
    expect(
      await bureau.children.get({ parentRunId: parent.id, childRunId: childId }),
    ).toMatchObject({
      status: 'aborted',
    });
    // A second cancel finds it over, and applies nothing.
    const again = await bureau.tasks.cancel(childId);
    expect(again.receipt === 'rejected' ? again.reason : 'canceled').toBe(
      again.receipt === 'rejected' ? 'already-terminal' : 'canceled',
    );
  });

  it('settles canceled when its parent’s cancellation cascades to it', async () => {
    const { bureau, parent, childId } = await parentWithChild(hangUntilAborted);
    await taskOf(bureau, childId);

    await bureau.tasks.cancel(parent.id);

    await statusReaches(bureau, childId, 'canceled');
  });

  it('is no task when its start never committed', async () => {
    const bureau = await open({
      planner: agentOf('planner', hangUntilAborted),
      worker: agentOf('worker', completes()),
    });
    const parent = await bureau.tasks.start('planner', 'plan', { principal: 'alice' });
    // The same id as the parent’s own run: the start is refused, and nothing is recorded for it.
    const refused = await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'worker',
      input: 'x',
      principal: 'alice',
      childRunId: parent.id,
    });

    expect(refused).toMatchObject({ outcome: 'rejected', code: 'child-run-id-conflict' });
    const registry = bureau.internals.taskRegistry;
    const parentRecord = await registry.record(parent.id);
    expect(parentRecord?.origin).toMatchObject({ kind: 'api' });
    const children = await registry.enumerate({ parentRunId: parent.id, limit: 10, offset: 0 });
    expect(children.tasks).toEqual([]);
  });

  it('is a task of a Bureau with no durable engine too, and settles', async () => {
    const bureau = await open(
      { planner: agentOf('planner', hangUntilAborted), worker: agentOf('worker', completes()) },
      { durable: false },
    );
    const parent = await bureau.tasks.start('planner', 'plan', { principal: 'alice' });
    const dispatched = await bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'worker',
      input: 'x',
      principal: 'alice',
      childRunId: 'local-child',
    });
    expect(dispatched).toMatchObject({ outcome: 'started' });

    await statusReaches(bureau, 'local-child', 'completed');

    const local = await bureau.tasks.get('local-child');
    expect(local?.origin).toMatchObject({
      kind: 'agent',
      parentRunId: parent.id,
    });
  });

  it('refuses a tool call identifier that is empty or too long', async () => {
    const bureau = await open({
      planner: agentOf('planner', hangUntilAborted),
      worker: agentOf('worker', completes()),
    });
    const parent = await bureau.tasks.start('planner', 'plan', { principal: 'alice' });

    for (const toolCallId of ['', 'x'.repeat(257)]) {
      const refusal = await rejectionOf(
        bureau.children.dispatch({
          parentRunId: parent.id,
          agentName: 'worker',
          input: 'x',
          principal: 'alice',
          toolCallId,
        }),
      );
      expect(refusal).toMatchObject({ code: 'BAD_REQUEST' });
    }
  });
});

describe('retention of a child’s task', () => {
  it('announces run.removed and releases the child’s peer call records', async () => {
    const { bureau, childId } = await parentWithChild(completes(), {}, IMMEDIATE_TASK_RETENTION);
    await statusReaches(bureau, childId, 'completed');
    const key = { parentRunId: childId, operationKey: 'op-1' };
    await bureau.peerCalls.write(key, { taskId: 'peer-task', contextId: 'c', requestDigest: 'd' });
    const removed: string[] = [];
    bureau.addEventListener('run.removed', (event) => void removed.push(event.runId));

    await retireSettledTasksOnRealClock(bureau);

    await waitUntil(async () => (await bureau.peerCalls.read(key)) === undefined, {
      message: 'the child’s peer call records are released',
    });
    expect(removed).toContain(childId);
    expect(await bureau.tasks.get(childId)).toBeUndefined();
  });
});

describe('a goal attempt', () => {
  async function bootGoal() {
    const bureau = await open(
      { worker: workerAgent(hangUntilAborted) },
      { validators: [createCheckValidator()] },
    );
    expect(await bureau.goals.create(goalRequest({ goalRunId: 'g1' }))).toMatchObject({
      outcome: 'created',
    });
    const attempt = await taskOf(bureau, 'goal-g1-a0');
    return { bureau, attempt };
  }

  it('reads back as a task with a goal origin', async () => {
    const { bureau, attempt } = await bootGoal();

    expect(attempt).toMatchObject({
      id: 'goal-g1-a0',
      kind: 'catalog',
      agentName: 'worker',
      status: 'working',
      origin: { kind: 'goal', goalRunId: 'g1', attemptId: 'g1:a0' },
    });
    const registry = bureau.internals.taskRegistry;
    const listed = await registry.enumerate({ parentRunId: 'g1', limit: 10, offset: 0 });
    expect(listed.tasks.map((task) => task.id)).toEqual(['goal-g1-a0']);
    const state = await bureau.durableEngine()!.get('goal-g1-a0');
    expect(state?.tags).toEqual(expect.arrayContaining(['origin:goal', 'origin-parent:g1']));
    expect(CHECK.name).toBe('check');
  });

  it('refuses tasks.cancel as owned by the goal, and never reaches the engine', async () => {
    const { bureau } = await bootGoal();

    const outcome = await bureau.tasks.cancel('goal-g1-a0');

    expect(outcome).toEqual({ receipt: 'rejected', reason: 'owned-by-goal' });
    const run = await bureau.durableEngine()!.get('goal-g1-a0');
    expect(run?.status).not.toBe('cancelled');
    expect(await statusOf(bureau, 'goal-g1-a0')).toBe('working');
  });

  it('settles canceled when the goal is cancelled, through the goal’s own order', async () => {
    const { bureau } = await bootGoal();

    await cancelUntilSettled(bureau, 'g1');

    await statusReaches(bureau, 'goal-g1-a0', 'canceled');
    const goal = await bureau.goals.get('g1');
    expect(goal?.status).toBe('canceled');
  });

  it('settles from the run’s end, not from the validator’s verdict', async () => {
    const bureau = await open(
      { worker: workerAgent(completes('not yet')) },
      { validators: [createCheckValidator()] },
    );
    await bureau.goals.create(goalRequest({ goalRunId: 'g2' }));

    await statusReaches(bureau, 'goal-g2-a0', 'completed');

    // The validator failed this attempt retryably; the attempt’s task still says its run completed.
    const attempt = await bureau.tasks.get('goal-g2-a0');
    expect(attempt?.finishReason).toBe('stop-condition');
  });
});

describe('a workflow agent step', () => {
  async function runStep(reply: () => Promise<string> | string = () => 'written') {
    const harness = await startWorkflowBureau({ replies: { writer: reply } });
    harnesses.push(harness);
    await harness.putWorkflow('digest', { trigger: { kind: 'schedule', spec: '1h' } });
    const run = await harness.bureau.durableEngine()?.start('digest', null, { id: 'instance-1' });
    return { harness, run };
  }

  async function stepRunId(harness: WorkflowBureauHarness): Promise<string> {
    let found = '';
    await waitUntil(
      async () => {
        const runs = await harness.bureau.durableEngine()?.list({ type: 'agentRun' });
        found = runs?.items[0]?.id ?? '';
        return found !== '';
      },
      { message: 'the step run exists' },
    );
    return found;
  }

  it('reads back as a task with a parent origin, owned by anonymous:local, and has no session', async () => {
    const { harness, run } = await runStep();
    await run?.result();
    const id = await stepRunId(harness);

    const task = await taskOf(harness.bureau, id);

    expect(task).toMatchObject({
      owner: 'anonymous:local',
      agentName: 'writer',
      origin: { kind: 'parent', parentRunId: 'instance-1' },
    });
    await statusReaches(harness.bureau, id, 'completed');
    expect(await harness.bureau.contexts.get(id)).toBeUndefined();
    const state = await harness.bureau.durableEngine()!.get(id);
    expect(state?.tags).toEqual(
      expect.arrayContaining(['origin:parent', 'origin-parent:instance-1']),
    );
    // The workflow-file instance is still no task; it is the parent of its steps’ tasks.
    expect(await harness.bureau.tasks.get('instance-1')).toBeUndefined();
    const listed = await harness.bureau.internals.taskRegistry.enumerate({
      parentRunId: 'instance-1',
      limit: 10,
      offset: 0,
    });
    expect(listed.tasks.map((entry) => entry.id)).toEqual([id]);
  });

  it('refuses tasks.cancel as owned by the workflow, while the step runs and after it ended', async () => {
    const release = Promise.withResolvers<string>();
    const { harness, run } = await runStep(() => release.promise);
    const id = await stepRunId(harness);
    await taskOf(harness.bureau, id);

    const running = await harness.bureau.tasks.cancel(id);
    release.resolve('written');
    await run?.result();
    await statusReaches(harness.bureau, id, 'completed');
    const ended = await harness.bureau.tasks.cancel(id);

    expect(running).toEqual({ receipt: 'rejected', reason: 'owned-by-workflow' });
    expect(ended).toEqual({ receipt: 'rejected', reason: 'owned-by-workflow' });
    expect(await statusOf(harness.bureau, id)).toBe('completed');
  });

  it('hashes a parent tag that would pass Weft’s limit', async () => {
    const harness = await startWorkflowBureau();
    harnesses.push(harness);
    await harness.putWorkflow('digest', { trigger: { kind: 'schedule', spec: '1h' } });
    const long = `instance-${'x'.repeat(110)}`;
    const run = await harness.bureau.durableEngine()?.start('digest', null, { id: long });
    await run?.result();
    const id = await stepRunId(harness);
    await taskOf(harness.bureau, id);

    const state = await harness.bureau.durableEngine()!.get(id);

    expect(taskOriginParentTag(long)).toStartWith('origin-parent-sha256:');
    expect(state?.tags).toEqual(
      expect.arrayContaining(['origin:parent', taskOriginParentTag(long)]),
    );
  });
});
