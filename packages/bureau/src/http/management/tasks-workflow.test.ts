/**
 * COR-2423: a task view says which workflow ran it, `bureau.tasks.list` filters by that, and the
 * Bureau's own runs (the schedule tick and the instances of workflow files) are listed as tasks
 * with the schedule they belong to, what a tick recorded, how far an instance got, and the signal it
 * waits for. The Runs list names, groups and filters rows by these.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { startScheduleTick } from '../../schedule-tick.ts';
import { waitForCondition } from '../../test';
import { AGENT_STEP } from '../../testing/workflow-file-fixtures.test-support.ts';
import { TASK_RECORD_KEY_PREFIX } from '../../task-registry.ts';
import { ownerRpc, serveWorkflows } from './workflows-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

type ListedTask = {
  id: string;
  status: string;
  origin: { kind: string } | null;
  workflow: {
    type: string;
    scheduleId: string | null;
    scheduleName: string | null;
    tick: { event: string; missedRuns: number | null; whileStopped: boolean } | null;
    steps: { total: number; at: number | null } | null;
    awaitingSignal: string | null;
  };
};

async function listTasks(
  served: Awaited<ReturnType<typeof serveWorkflows>>,
  params: Record<string, unknown> = {},
): Promise<{ tasks: ListedTask[]; nextPageToken: string | null; error: unknown }> {
  const body = await ownerRpc(served.owner, 'bureau.tasks.list', params);
  return {
    tasks: (body.result?.['tasks'] ?? []) as ListedTask[],
    nextPageToken: (body.result?.['nextPageToken'] as string | null | undefined) ?? null,
    error: body.error,
  };
}

const SIGNAL_TRIGGER = { kind: 'signal', name: 'start-notes' } as const;

describe('a task view’s workflow', () => {
  it('names the workflow type of every task, and bureau.tasks.list filters by it', async () => {
    const served = await serveWorkflows(cleanups);
    // Three records a Bureau can hold: a chat's run, a goal's attempt and a run recorded before
    // origins were kept.
    const kv = served.bureau.internals.kv!;
    const record = (taskId: string, origin?: Record<string, unknown>) =>
      kv.set(
        `${TASK_RECORD_KEY_PREFIX}${taskId}`,
        JSON.stringify({
          schemaVersion: 1,
          taskId,
          contextId: taskId,
          incarnation: '',
          agentName: 'writer',
          owner: served.bureau.workflows!.owner,
          ...(origin === undefined ? {} : { origin }),
          createdAt: '2026-11-02T10:00:00.000Z',
          history: [],
        }),
      );
    await record('chat-run', { kind: 'chat', contextId: 'c', agentName: 'writer', principal: 'p' });
    await record('goal-run', { kind: 'goal', goalRunId: 'g', attemptId: 'a' });
    await record('old-run');

    const all = await listTasks(served);
    expect(all.error).toBeUndefined();
    const typeOf = (id: string) => all.tasks.find((task) => task.id === id)?.workflow.type;
    expect(typeOf('chat-run')).toBe('agentRun');
    expect(typeOf('goal-run')).toBe('goalRun');
    expect(typeOf('old-run')).toBe('agentRun');

    const goals = await listTasks(served, { workflow: 'goalRun' });
    expect(goals.tasks.map((task) => task.id)).toEqual(['goal-run']);
    const agents = await listTasks(served, { workflow: 'agentRun' });
    expect(agents.tasks.map((task) => task.id).toSorted()).toEqual(['chat-run', 'old-run']);
    expect((await listTasks(served, { workflow: 'no-such-workflow' })).tasks).toEqual([]);
  });

  it('refuses a page token under another workflow filter', async () => {
    const served = await serveWorkflows(cleanups);
    const kv = served.bureau.internals.kv!;
    for (const taskId of ['one', 'two', 'three']) {
      await kv.set(
        `${TASK_RECORD_KEY_PREFIX}${taskId}`,
        JSON.stringify({
          schemaVersion: 1,
          taskId,
          contextId: taskId,
          incarnation: '',
          agentName: 'writer',
          owner: served.bureau.workflows!.owner,
          createdAt: '2026-11-02T10:00:00.000Z',
          history: [],
        }),
      );
    }
    const first = await listTasks(served, { workflow: 'agentRun', limit: 2 });
    expect(first.nextPageToken).not.toBeNull();
    const second = await ownerRpc(served.owner, 'bureau.tasks.list', {
      workflow: 'goalRun',
      limit: 2,
      pageToken: first.nextPageToken,
    });
    expect(JSON.stringify(second.error)).toContain('page-token-filters');
    const same = await listTasks(served, {
      workflow: 'agentRun',
      limit: 2,
      pageToken: first.nextPageToken,
    });
    expect(same.tasks).toHaveLength(1);
  });
});

describe('the Bureau’s own runs, listed as tasks', () => {
  it('lists the schedule tick with what it recorded, owned by its schedule’s owner', async () => {
    const served = await serveWorkflows(cleanups);
    const engine = served.bureau.durableEngine()!;
    await startScheduleTick(engine, {
      event: 'missed-runs',
      scheduleId: 'daily-summary',
      scheduleName: 'Daily summary',
      missedRuns: 4,
      reason: 'late',
      since: Date.UTC(2026, 9, 30, 8),
      until: Date.UTC(2026, 10, 2, 15),
      whileStopped: true,
    });

    const listed = await listTasks(served, { origin: 'system' });
    expect(listed.error).toBeUndefined();
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]).toMatchObject({
      origin: { kind: 'system' },
      workflow: {
        type: 'scheduleTick',
        scheduleId: 'daily-summary',
        scheduleName: 'Daily summary',
        tick: { event: 'missed-runs', missedRuns: 4, whileStopped: true },
        steps: null,
        awaitingSignal: null,
      },
    });
    const byWorkflow = await listTasks(served, { workflow: 'scheduleTick' });
    expect(byWorkflow.tasks.map((task) => task.id)).toEqual(listed.tasks.map((task) => task.id));
    expect((await listTasks(served, { workflow: 'agentRun' })).tasks).toEqual([]);
  });

  it('lists an instance of a workflow file by its workflow, the steps it has and the signal it waits for', async () => {
    const served = await serveWorkflows(cleanups);
    await served.bureau.workflows!.create('release-notes', {
      trigger: SIGNAL_TRIGGER,
      steps: [{ kind: 'await-signal', signal: 'notes-approved' }, AGENT_STEP],
    });
    const run = await served.bureau.durableEngine()!.start('release-notes', null, {
      id: 'release-notes-run',
    });
    void run;
    // The instance parks at its first step, which is when it waits for the signal.
    await waitForCondition(async () => {
      const [parked] = (await listTasks(served, { workflow: 'release-notes' })).tasks;
      return parked?.workflow.awaitingSignal === 'notes-approved';
    }, 'the instance never waited for its signal');

    const listed = await listTasks(served, { workflow: 'release-notes' });
    expect(listed.error).toBeUndefined();
    expect(listed.tasks).toHaveLength(1);
    const [task] = listed.tasks;
    expect(task?.id).toBe('release-notes-run');
    expect(task?.workflow.type).toBe('release-notes');
    expect(task?.workflow.steps?.total).toBe(2);
    expect(task?.status).toBe('working');
    expect(task?.workflow.awaitingSignal).toBe('notes-approved');
    // It reached its first step, and has not finished.
    expect(task?.workflow.steps?.at).toBe(1);
  });

  it('keeps a page token for engine runs across pages and drops a run the engine purged', async () => {
    const served = await serveWorkflows(cleanups);
    for (const tick of ['a', 'b', 'c']) {
      await startScheduleTick(served.bureau.durableEngine()!, {
        event: 'came-due',
        scheduleId: `schedule-${tick}`,
        scheduleName: null,
        fireRunId: `fire-${tick}`,
      });
    }
    const first = await listTasks(served, { workflow: 'scheduleTick', limit: 2 });
    expect(first.tasks).toHaveLength(2);
    expect(first.nextPageToken).not.toBeNull();
    const rest = await listTasks(served, {
      workflow: 'scheduleTick',
      limit: 2,
      pageToken: first.nextPageToken,
    });
    expect(rest.tasks).toHaveLength(1);
    expect(rest.nextPageToken).toBeNull();
  });

  it('answers bureau.tasks.get with NotFound, since an engine run has no task record', async () => {
    const served = await serveWorkflows(cleanups);
    await startScheduleTick(served.bureau.durableEngine()!, {
      event: 'came-due',
      scheduleId: 'schedule-a',
      scheduleName: null,
      fireRunId: 'fire-a',
    });
    const [tick] = (await listTasks(served, { origin: 'system' })).tasks;
    const read = await ownerRpc(served.owner, 'bureau.tasks.get', { taskId: tick!.id });
    expect(read.error?.data?.httpStatus).toBe(404);
  });
});
