/**
 * COR-2423: a task view says which workflow ran it, `bureau.tasks.list` filters by that, and the
 * Bureau's own runs (the schedule tick and the instances of workflow files) are listed as tasks
 * with the schedule they belong to, what a tick recorded, how far an instance got, and the signal it
 * waits for. The Runs list names, groups and filters rows by these.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent } from '@lostgradient/operative';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { startScheduleTick } from '../../schedule-tick.ts';
import { waitForCondition } from '../../test';
import { AGENT_STEP, FAST_SCHEDULE } from '../../testing/workflow-file-fixtures.test-support.ts';
import { rpc } from './management-fixtures.test-support.ts';
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

/** The tasks of a listing, without its page token. */
async function tasksOf(
  served: Awaited<ReturnType<typeof serveWorkflows>>,
  params: Record<string, unknown> = {},
): Promise<ListedTask[]> {
  const listed = await listTasks(served, params);
  return listed.tasks;
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
    expect(await tasksOf(served, { workflow: 'no-such-workflow' })).toEqual([]);
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
    expect(await tasksOf(served, { workflow: 'agentRun' })).toEqual([]);
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
      const [parked] = await tasksOf(served, { workflow: 'release-notes' });
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

  it('lists an instance a schedule fired with that schedule, and the response passes its schema (rows 09r, 52i)', async () => {
    const runtime = createManualRuntimeServices();
    const served = await serveWorkflows(cleanups, { runtime, maintenance: 'manual' });
    await served.bureau.workflows!.create('digest-flow', {
      trigger: FAST_SCHEDULE,
      steps: [{ kind: 'await-signal', signal: 'never-sent' }],
    });
    await runtime.advance(1_000);
    await served.bureau.maintain();
    let fired: ListedTask | undefined;
    await waitForCondition(async () => {
      const listed = await listTasks(served, { workflow: 'digest-flow' });
      expect(listed.error).toBeUndefined();
      fired = listed.tasks.find((task) => task.workflow.scheduleId !== null);
      return fired !== undefined;
    }, 'the schedule never fired an instance');
    expect(fired?.origin).toMatchObject({ kind: 'schedule', fireId: fired?.id });
    // The schedule is the one `bureau.schedules.list` names, which the Runs list names it by.
    const schedules = await ownerRpc(served.owner, 'bureau.schedules.list', {});
    const ids = ((schedules.result?.['schedules'] ?? []) as { id: string }[]).map(
      (schedule) => schedule.id,
    );
    expect(ids).toContain(fired?.workflow.scheduleId ?? '');
  });

  it('lists an instance that failed, with the step it failed at and why', async () => {
    const served = await serveWorkflows(cleanups, {
      agents: {
        writer: createAgent({
          name: 'writer',
          generate: async () => {
            throw new Error('GitHub did not answer (HTTP 503)');
          },
        }),
      },
    });
    await served.bureau.workflows!.create('flaky', {
      trigger: SIGNAL_TRIGGER,
      steps: [{ kind: 'await-signal', signal: 'go' }, AGENT_STEP],
    });
    await served.bureau.durableEngine()!.start('flaky', null, { id: 'flaky-run' });
    await waitForCondition(async () => {
      const [parked] = await tasksOf(served, { workflow: 'flaky' });
      return parked?.workflow.awaitingSignal === 'go';
    }, 'the instance never waited for its signal');
    await served.bureau.workflows!.signal('go', null);
    let failed: ListedTask | undefined;
    await waitForCondition(async () => {
      [failed] = await tasksOf(served, { workflow: 'flaky' });
      return failed?.status === 'failed';
    }, 'the instance never failed');
    expect(failed?.workflow.steps).toEqual({ total: 2, at: 2 });
    expect(failed?.workflow.awaitingSignal).toBeNull();
    expect((failed as unknown as { statusMessage: string | null }).statusMessage).not.toBeNull();
  });

  it('lists the engine’s runs to a caller that may read the workflows, and to no one else', async () => {
    const served = await serveWorkflows(cleanups);
    await startScheduleTick(served.bureau.durableEngine()!, {
      event: 'came-due',
      scheduleId: 'schedule-a',
      scheduleName: null,
      fireRunId: 'fire-a',
    });
    const asKey = async (key: string): Promise<string[]> => {
      const body = await rpc(served.keyed, 'bureau.tasks.list', {}, key);
      const tasks = (body.result?.['tasks'] ?? []) as ListedTask[];
      return tasks.map((task) => task.workflow.type);
    };
    // Bob owns nothing here, and `bureau.tasks:read` alone is not the workflows' (the owner's).
    expect(await asKey('bob-key')).toEqual([]);
    expect(await asKey('tasks-reader-key')).toEqual([]);
    // The owner, and an operator who may read the workflows as well as every owner's tasks, see it.
    const ownerTasks = await tasksOf(served);
    expect(ownerTasks.map((task) => task.workflow.type)).toContain('scheduleTick');
    expect(await asKey('operator-key')).toContain('scheduleTick');
  });

  it('does not read the engine for a workflow filter no engine run can match (COR-2424)', async () => {
    const served = await serveWorkflows(cleanups);
    const engine = served.bureau.durableEngine()!;
    await startScheduleTick(engine, {
      event: 'came-due',
      scheduleId: 'schedule-a',
      scheduleName: null,
      fireRunId: 'fire-a',
    });
    const listing = spyOn(engine, 'list');
    // The types the engine was asked to list runs of; other reads of the engine are not the listing's.
    const typesAsked = (): unknown[] =>
      listing.mock.calls.map(([query]) => (query as { type?: unknown } | undefined)?.type);
    try {
      for (const workflow of ['agentRun', 'goalRun']) {
        expect(await tasksOf(served, { workflow })).toEqual([]);
      }
      expect(await tasksOf(served, { engineRuns: false })).toEqual([]);
      expect(typesAsked()).not.toContain('scheduleTick');
      // A type an engine run can have still reads the engine.
      const ticks = await tasksOf(served, { workflow: 'scheduleTick' });
      expect(ticks).toHaveLength(1);
      expect(typesAsked()).toContain('scheduleTick');
    } finally {
      listing.mockRestore();
    }
  });

  it('leaves the engine’s runs out of a listing that asks for engineRuns: false (COR-2424)', async () => {
    const served = await serveWorkflows(cleanups);
    const kv = served.bureau.internals.kv!;
    await kv.set(
      `${TASK_RECORD_KEY_PREFIX}chat-run`,
      JSON.stringify({
        schemaVersion: 1,
        taskId: 'chat-run',
        contextId: 'chat-run',
        incarnation: '',
        agentName: 'writer',
        owner: served.bureau.workflows!.owner,
        createdAt: '2026-11-02T10:00:00.000Z',
        history: [],
      }),
    );
    for (const fireRunId of ['fire-a', 'fire-b']) {
      await startScheduleTick(served.bureau.durableEngine()!, {
        event: 'came-due',
        scheduleId: 'schedule-a',
        scheduleName: null,
        fireRunId,
      });
    }
    // Asked for, the engine's runs fill the page; the task with a record is still there.
    const all = await tasksOf(served);
    expect(all.map((task) => task.workflow.type)).toContain('scheduleTick');
    expect(all.map((task) => task.id)).toContain('chat-run');
    // A page of one holds the engine's newest run, so a reader that keeps only a page of the
    // listing loses the chat's run behind it: the slots it asked for went to the engine.
    const crowded = await tasksOf(served, { limit: 1 });
    expect(crowded.map((task) => task.id)).not.toEqual(['chat-run']);
    // `engineRuns: false` gives the slots back: the same page of one is the task with a record.
    const only = await tasksOf(served, { limit: 1, engineRuns: false });
    expect(only.map((task) => task.id)).toEqual(['chat-run']);
    const unfiltered = await tasksOf(served, { engineRuns: false });
    expect(unfiltered.map((task) => task.workflow.type)).not.toContain('scheduleTick');
    // `true` is the default, and still lists nothing for a caller who may not read the workflows.
    const explicit = await tasksOf(served, { engineRuns: true });
    expect(explicit.map((task) => task.workflow.type)).toContain('scheduleTick');
    const body = await rpc(served.keyed, 'bureau.tasks.list', { engineRuns: true }, 'bob-key');
    expect((body.result?.['tasks'] ?? []) as ListedTask[]).toEqual([]);
  });

  it('lists a tick under manual maintenance, where the engine’s type index is not refreshed', async () => {
    const served = await serveWorkflows(cleanups, { maintenance: 'manual' });
    await startScheduleTick(served.bureau.durableEngine()!, {
      event: 'came-due',
      scheduleId: 'schedule-a',
      scheduleName: null,
      fireRunId: 'fire-a',
    });
    expect(await tasksOf(served, { origin: 'system' })).toHaveLength(1);
  });

  it('still lists the tasks that have records when the engine will not list its runs', async () => {
    const diagnostics: string[] = [];
    const served = await serveWorkflows(cleanups, {
      onDiagnostic: (event) => diagnostics.push(`${event.level}: ${event.message}`),
    });
    const kv = served.bureau.internals.kv!;
    await kv.set(
      `${TASK_RECORD_KEY_PREFIX}chat-run`,
      JSON.stringify({
        schemaVersion: 1,
        taskId: 'chat-run',
        contextId: 'chat-run',
        incarnation: '',
        agentName: 'writer',
        owner: served.bureau.workflows!.owner,
        createdAt: '2026-11-02T10:00:00.000Z',
        history: [],
      }),
    );
    const engine = served.bureau.durableEngine()!;
    const failing = spyOn(engine, 'list').mockRejectedValue(new Error('engine unavailable'));
    try {
      const listed = await listTasks(served);
      expect(listed.error).toBeUndefined();
      expect(listed.tasks.map((task) => task.id)).toEqual(['chat-run']);
      // The refusal is reported, not swallowed.
      expect(diagnostics.some((line) => line.includes('as tasks'))).toBe(true);
    } finally {
      failing.mockRestore();
    }
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
    const [tick] = await tasksOf(served, { origin: 'system' });
    const read = await ownerRpc(served.owner, 'bureau.tasks.get', { taskId: tick!.id });
    expect(read.error?.data?.httpStatus).toBe(404);
  });
});
