import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { type CleanupAcknowledgement, createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../test';
import {
  createTaskRegistry,
  type LiveTask,
  type TaskRegistry,
  type TaskRegistryHost,
} from '../../task-registry.ts';
import { type BureauHandlerSource, createBureauHandler } from '../create-bureau-handler.ts';
import {
  answering,
  authentication,
  OWNER,
  type OpenedBureau,
  openBureau,
  parkingUntilAborted,
  rpc,
} from './management-fixtures.test-support.ts';

async function withBureau<T>(
  options: Parameters<typeof openBureau>[0],
  body: (opened: OpenedBureau) => Promise<T>,
): Promise<T> {
  const opened = await openBureau(options);
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

type Task = {
  id: string;
  contextId: string;
  agentName: string | null;
  owner: string;
  status: string;
  cleanup: string | null;
};

function tasksOf(body: Awaited<ReturnType<typeof rpc>>): Task[] {
  return (body.result?.['tasks'] ?? []) as Task[];
}

async function startRun(
  opened: OpenedBureau,
  principal: string,
  options: { message?: string; sessionId?: string; agentName?: string } = {},
) {
  const run = await opened.bureau.createRun({
    agentName: 'bureau',
    message: options.message ?? 'work',
    principal,
    ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  });
  await waitForCondition(
    () => opened.bureau.getRun(run.id)?.status === 'running',
    `run ${run.id} never started`,
  );
  return run;
}

/** Writes task records straight to the registry, one millisecond apart: a listing reads only them. */
function createTaskRecords(opened: OpenedBureau) {
  let at = Date.parse('2026-10-22T00:00:00.000Z');
  return {
    async admit(taskId: string, owner: string): Promise<void> {
      at += 1;
      await opened.bureau.tasks.recordAdmission({
        taskId,
        contextId: `context-${taskId}`,
        incarnation: '',
        agentName: 'asker',
        owner,
        message: undefined,
        createdAt: new Date(at).toISOString(),
      });
    },
  };
}

describe('bureau.tasks.list', () => {
  it('lists only the caller’s own tasks without bureau.tasks:read, newest first', async () => {
    await withBureau({}, async (opened) => {
      const first = await startRun(opened, OWNER.alice);
      const second = await startRun(opened, OWNER.alice);
      await startRun(opened, OWNER.bob);

      const alice = await rpc(opened.handler, 'bureau.tasks.list', {}, 'alice-key');
      const writer = await rpc(opened.handler, 'bureau.tasks.list', {}, 'tasks-writer-key');

      expect(
        tasksOf(alice)
          .map((task) => task.id)
          .toSorted(),
      ).toEqual([first.id, second.id].toSorted());
      expect(tasksOf(alice).every((task) => task.owner === OWNER.alice)).toBe(true);
      expect(alice.result?.['nextPageToken']).toBeNull();
      // The write scope does not imply the read scope.
      expect(tasksOf(writer)).toEqual([]);
    });
  });

  it('lists every owner’s tasks with bureau.tasks:read', async () => {
    await withBureau({}, async (opened) => {
      await startRun(opened, OWNER.alice);
      await startRun(opened, OWNER.bob);

      const body = await rpc(opened.handler, 'bureau.tasks.list', {}, 'tasks-reader-key');

      expect(
        tasksOf(body)
          .map((task) => task.owner)
          .toSorted(),
      ).toEqual([OWNER.alice, OWNER.bob]);
    });
  });

  it('filters by agent name and status, and pages with nextPageToken', async () => {
    await withBureau(
      { agents: { asker: createAgent({ generate: parkingUntilAborted }) } },
      async (opened) => {
        const ids: string[] = [];
        for (let index = 0; index < 3; index += 1) {
          const started = await startRun(opened, OWNER.alice, { agentName: 'asker' });
          ids.push(started.id);
        }

        const firstPage = await rpc(opened.handler, 'bureau.tasks.list', { limit: 2 }, 'alice-key');
        const secondPage = await rpc(
          opened.handler,
          'bureau.tasks.list',
          { limit: 2, pageToken: firstPage.result?.['nextPageToken'] },
          'alice-key',
        );
        const working = await rpc(
          opened.handler,
          'bureau.tasks.list',
          { status: 'working' },
          'alice-key',
        );
        const completed = await rpc(
          opened.handler,
          'bureau.tasks.list',
          { status: 'completed' },
          'alice-key',
        );
        const named = await rpc(
          opened.handler,
          'bureau.tasks.list',
          { agentName: 'asker' },
          'alice-key',
        );
        const other = await rpc(
          opened.handler,
          'bureau.tasks.list',
          { agentName: 'someone-else' },
          'alice-key',
        );

        expect(tasksOf(firstPage)).toHaveLength(2);
        expect(typeof firstPage.result?.['nextPageToken']).toBe('string');
        expect(tasksOf(secondPage)).toHaveLength(1);
        expect(secondPage.result?.['nextPageToken']).toBeNull();
        expect([...tasksOf(firstPage), ...tasksOf(secondPage)].map((task) => task.id)).toEqual(
          ids.toReversed(),
        );
        expect(tasksOf(working)).toHaveLength(3);
        expect(tasksOf(completed)).toEqual([]);
        expect(tasksOf(named)).toHaveLength(3);
        expect(tasksOf(other)).toEqual([]);
      },
    );
  });

  it('answers at most 50 tasks when the limit is omitted, and never another principal’s', async () => {
    await withBureau(
      { agents: { asker: createAgent({ generate: parkingUntilAborted }) } },
      async (opened) => {
        const records = createTaskRecords(opened);
        for (let index = 0; index < 51; index += 1)
          await records.admit(`alice-${index}`, OWNER.alice);
        await records.admit('bob-0', OWNER.bob);

        const firstPage = await rpc(opened.handler, 'bureau.tasks.list', {}, 'alice-key');
        const secondPage = await rpc(
          opened.handler,
          'bureau.tasks.list',
          { pageToken: firstPage.result?.['nextPageToken'] },
          'alice-key',
        );

        expect(tasksOf(firstPage)).toHaveLength(50);
        expect(tasksOf(secondPage)).toHaveLength(1);
        expect(secondPage.result?.['nextPageToken']).toBeNull();
        const listed = [...tasksOf(firstPage), ...tasksOf(secondPage)];
        expect(listed.every((task) => task.owner === OWNER.alice)).toBe(true);
        expect(new Set(listed.map((task) => task.id)).size).toBe(51);
      },
    );
  });

  it('answers InvalidParams to an offset, a token that is not one, and another principal’s token', async () => {
    await withBureau(
      { agents: { asker: createAgent({ generate: parkingUntilAborted }) } },
      async (opened) => {
        const records = createTaskRecords(opened);
        for (let index = 0; index < 3; index += 1)
          await records.admit(`alice-${index}`, OWNER.alice);
        const firstPage = await rpc(opened.handler, 'bureau.tasks.list', { limit: 1 }, 'alice-key');
        const pageToken = firstPage.result?.['nextPageToken'];

        const offset = await rpc(opened.handler, 'bureau.tasks.list', { offset: 1 }, 'alice-key');
        const malformed = await rpc(
          opened.handler,
          'bureau.tasks.list',
          { pageToken: 'not-a-token' },
          'alice-key',
        );
        const stolen = await rpc(opened.handler, 'bureau.tasks.list', { pageToken }, 'bob-key');
        const otherFilter = await rpc(
          opened.handler,
          'bureau.tasks.list',
          { pageToken, status: 'working' },
          'alice-key',
        );

        for (const body of [offset, malformed, stolen, otherFilter]) {
          expect(body.error?.data?.httpStatus).toBe(400);
        }
        expect(JSON.stringify(otherFilter.error)).toContain('page-token-filters');
      },
    );
  });

  it('returns only the tasks of the named context, each carrying that contextId', async () => {
    await withBureau({}, async (opened) => {
      const first = await startRun(opened, OWNER.alice);
      const second = await startRun(opened, OWNER.alice, { sessionId: first.sessionId });
      await startRun(opened, OWNER.alice);

      const body = await rpc(
        opened.handler,
        'bureau.tasks.list',
        { contextId: first.sessionId },
        'alice-key',
      );

      expect(
        tasksOf(body)
          .map((task) => task.id)
          .toSorted(),
      ).toEqual([first.id, second.id].toSorted());
      expect(tasksOf(body).every((task) => task.contextId === first.sessionId)).toBe(true);
    });
  });

  it('returns only the current incarnation of a context after it is deleted and recreated', async () => {
    await withBureau({ generate: answering() }, async (opened) => {
      const before = await opened.bureau.createRun({
        agentName: 'bureau',
        message: 'before',
        principal: OWNER.alice,
        sessionId: 'reused-context',
      });
      await waitForCondition(
        () => opened.bureau.getRun(before.id)?.status === 'completed',
        'before',
      );
      await opened.bureau.deleteSession('reused-context');
      const after = await opened.bureau.createRun({
        agentName: 'bureau',
        message: 'after',
        principal: OWNER.alice,
        sessionId: 'reused-context',
      });
      await waitForCondition(() => opened.bureau.getRun(after.id)?.status === 'completed', 'after');

      const body = await rpc(
        opened.handler,
        'bureau.tasks.list',
        { contextId: 'reused-context' },
        'alice-key',
      );

      expect(tasksOf(body).map((task) => task.id)).toEqual([after.id]);
    });
  });

  it('returns exactly the two tasks of a session after two turns, each carrying the contextId', async () => {
    await withBureau({ generate: answering() }, async (opened) => {
      const first = await opened.bureau.createRun({
        agentName: 'bureau',
        message: 'one',
        principal: OWNER.alice,
      });
      await waitForCondition(() => opened.bureau.getRun(first.id)?.status === 'completed', 'one');
      const second = await opened.bureau.createRun({
        agentName: 'bureau',
        message: 'two',
        principal: OWNER.alice,
        sessionId: first.sessionId,
      });
      await waitForCondition(() => opened.bureau.getRun(second.id)?.status === 'completed', 'two');

      const body = await rpc(
        opened.handler,
        'bureau.tasks.list',
        { contextId: first.sessionId },
        'alice-key',
      );

      expect(tasksOf(body)).toHaveLength(2);
      expect(
        tasksOf(body)
          .map((task) => task.id)
          .toSorted(),
      ).toEqual([first.id, second.id].toSorted());
      expect(tasksOf(body).every((task) => task.contextId === first.sessionId)).toBe(true);
      // A task id is the run id, and no `RunRef.runId` of the form `${sessionId}:${sequence}` appears.
      expect(tasksOf(body).every((task) => !task.id.includes(':'))).toBe(true);
    });
  });
});

describe('bureau.tasks.get', () => {
  it('returns the caller’s own task, and any owner’s to bureau.tasks:read', async () => {
    await withBureau({}, async (opened) => {
      const run = await startRun(opened, OWNER.alice);

      const own = await rpc(opened.handler, 'bureau.tasks.get', { taskId: run.id }, 'alice-key');
      const operator = await rpc(
        opened.handler,
        'bureau.tasks.get',
        { taskId: run.id },
        'tasks-reader-key',
      );

      expect(own.result).toMatchObject({
        id: run.id,
        contextId: run.sessionId,
        owner: OWNER.alice,
        status: 'working',
        agentName: 'bureau',
        cleanup: null,
        openWaits: [],
      });
      expect(operator.result).toEqual(own.result);
    });
  });

  it('answers a task the caller may not see exactly as it answers one that does not exist', async () => {
    await withBureau({}, async (opened) => {
      const run = await startRun(opened, OWNER.alice);

      const denied = await rpc(opened.handler, 'bureau.tasks.get', { taskId: run.id }, 'bob-key');
      const missing = await rpc(
        opened.handler,
        'bureau.tasks.get',
        { taskId: 'run-no-such-task' },
        'bob-key',
      );
      const writerOnly = await rpc(
        opened.handler,
        'bureau.tasks.get',
        { taskId: run.id },
        'tasks-writer-key',
      );

      expect(denied.error?.data?.httpStatus).toBe(404);
      expect(JSON.stringify(denied).replaceAll(run.id, '<id>')).toBe(
        JSON.stringify(missing).replaceAll('run-no-such-task', '<id>'),
      );
      expect(writerOnly.error?.data?.httpStatus).toBe(404);
    });
  });

  it('never carries the originating message or any transcript content', async () => {
    await withBureau({}, async (opened) => {
      const run = await startRun(opened, OWNER.alice, { message: 'SECRET-ORIGINATING-TEXT' });

      const body = await rpc(opened.handler, 'bureau.tasks.get', { taskId: run.id }, 'alice-key');
      const list = await rpc(opened.handler, 'bureau.tasks.list', {}, 'alice-key');

      expect(JSON.stringify(body)).not.toContain('SECRET-ORIGINATING-TEXT');
      expect(JSON.stringify(list)).not.toContain('SECRET-ORIGINATING-TEXT');
      // The history is the task's own and is read through the registry, for a later A2A GetTask.
      const history = await opened.bureau.tasks.history(run.id);
      expect(history?.map((message) => message.text)).toEqual(['SECRET-ORIGINATING-TEXT']);
    });
  });
});

describe('bureau.tasks.cancel', () => {
  it('requires bureau.tasks:write for another owner’s task, and answers anyone else as a missing task', async () => {
    await withBureau({}, async (opened) => {
      const run = await startRun(opened, OWNER.alice);

      const bob = await rpc(opened.handler, 'bureau.tasks.cancel', { taskId: run.id }, 'bob-key');
      const reader = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: run.id },
        'tasks-reader-key',
      );
      expect(bob.error?.data?.httpStatus).toBe(404);
      expect(reader.error?.data?.httpStatus).toBe(404);
      expect(opened.bureau.getRun(run.id)?.status).toBe('running');

      const writer = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: run.id },
        'tasks-writer-key',
      );
      expect(writer.result).toMatchObject({ taskId: run.id });
      expect(writer.result?.['receipt']).not.toBe('rejected');
    });
  });

  it('answers a caller that can only write with the receipt alone, and one that can read with the task too', async () => {
    await withBureau({}, async (opened) => {
      const run = await startRun(opened, OWNER.alice);
      const writerOnly = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: run.id },
        'tasks-writer-key',
      );
      const repeat = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: run.id },
        'tasks-writer-key',
      );
      const owner = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: run.id },
        'alice-key',
      );
      const operator = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: run.id },
        'tasks-operator-key',
      );

      // Nothing the write scope alone could not read with `tasks.get`: no owner, context, agent or waits.
      for (const body of [writerOnly, repeat]) {
        expect(Object.keys(body.result ?? {}).toSorted()).toEqual(['receipt', 'taskId']);
        expect(JSON.stringify(body)).not.toContain(OWNER.alice);
        expect(JSON.stringify(body)).not.toContain(run.sessionId);
      }
      expect(owner.result).toHaveProperty('task');
      expect(operator.result).toHaveProperty('task');
    });
  });

  it('answers cancel-requested without waiting, and the settled cleanup state afterwards', async () => {
    await withBureau({}, async (opened) => {
      const run = await startRun(opened, OWNER.alice);

      const body = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: run.id },
        'alice-key',
      );

      expect(body.result).toMatchObject({
        taskId: run.id,
        receipt: 'cancel-requested',
        task: { id: run.id },
      });
      await waitForCondition(async () => {
        const task = await rpc(opened.handler, 'bureau.tasks.get', { taskId: run.id }, 'alice-key');
        return task.result?.['cleanup'] === 'cleaned-up';
      }, 'the cancellation never reported its cleanup');
      const task = await rpc(opened.handler, 'bureau.tasks.get', { taskId: run.id }, 'alice-key');
      expect(task.result).toMatchObject({ status: 'canceled', cleanup: 'cleaned-up' });
    });
  });

  it('answers cleaned-up when asked to wait for the acknowledgement, and the same on a repeat', async () => {
    await withBureau({}, async (opened) => {
      const run = await startRun(opened, OWNER.alice);

      const body = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: run.id, waitMilliseconds: 2_000 },
        'alice-key',
      );
      const repeat = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: run.id },
        'alice-key',
      );

      expect(body.result).toMatchObject({ receipt: 'cleaned-up' });
      expect(repeat.result).toMatchObject({ receipt: 'cleaned-up' });
    });
  });

  it('rejects a task that finished without being canceled, applying nothing', async () => {
    await withBureau({ generate: answering() }, async (opened) => {
      const run = await opened.bureau.createRun({
        agentName: 'bureau',
        message: 'quick',
        principal: OWNER.alice,
      });
      await waitForCondition(() => opened.bureau.getRun(run.id)?.status === 'completed', 'finish');
      await waitForCondition(async () => {
        const task = await rpc(opened.handler, 'bureau.tasks.get', { taskId: run.id }, 'alice-key');
        return task.result?.['status'] === 'completed';
      }, 'the task never settled');

      const body = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: run.id },
        'alice-key',
      );

      expect(body.error).toBeUndefined();
      expect(body.result).toMatchObject({
        receipt: 'rejected',
        reason: 'already-terminal',
        task: { status: 'completed' },
      });
    });
  });

  it('rejects an unknown wait window as InvalidParams', async () => {
    await withBureau({}, async (opened) => {
      const run = await startRun(opened, OWNER.alice);
      const body = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: run.id, waitMilliseconds: 600_000 },
        'alice-key',
      );
      expect(body.error?.data?.httpStatus).toBe(400);
    });
  });
});

/**
 * The receipt states that depend on how a run's cleanup ended. A real run's cleanup
 * ends `completed` here, so these drive the real handler and the real registry over a
 * Bureau whose runs report the acknowledgement a test chooses, and the receipt each
 * produces is asserted at the wire.
 */
describe('bureau.tasks.cancel receipts that depend on the cleanup acknowledgement', () => {
  async function withScriptedCleanup<T>(
    scripted: { durable?: 'requested' | 'already-terminal' },
    body: (context: {
      call: (
        acknowledgement: CleanupAcknowledgement | 'never' | 'durable-only',
        waitMilliseconds?: number,
      ) => Promise<Awaited<ReturnType<typeof rpc>>>;
    }) => Promise<T>,
  ): Promise<T> {
    const opened = await openBureau({});
    try {
      const runtime = createDefaultRuntimeServices();
      const live = new Map<string, LiveTask>();
      const closing = new Map<string, Promise<CleanupAcknowledgement>>();
      // eslint-disable-next-line prefer-const -- the host closes over the registry it is passed to
      let registry!: TaskRegistry;
      const host: TaskRegistryHost = {
        liveTask: (taskId) => live.get(taskId),
        liveTasksOfContexts: () => new Map(),
        pendingReviews: () => [],
        currentIncarnation: async () => '',
        abort: (taskId) => {
          const acknowledgement = closing.get(taskId);
          if (acknowledgement === undefined) return 'not-found';
          void registry.watchCleanup(taskId, acknowledgement);
          live.set(taskId, {
            phase: 'aborted',
            finishReason: 'aborted',
            error: undefined,
            updatedAt: undefined,
          });
          return 'requested';
        },
        cancelDurable: async () => ({ status: scripted.durable ?? 'requested' }),
        sleep: (milliseconds) =>
          new Promise<void>((resolve) => {
            runtime.timers.setTimeout(resolve, milliseconds);
          }),
      };
      registry = createTaskRegistry({
        kv: undefined,
        clock: runtime.clock,
        identifiers: runtime.identifiers,
        host,
        diagnose: () => undefined,
      });
      const source = Object.create(opened.bureau, {
        tasks: { value: registry },
      }) as BureauHandlerSource;
      const handler = createBureauHandler(source, { authentication });
      let sequence = 0;
      return await body({
        call: async (acknowledgement, waitMilliseconds = 0) => {
          sequence += 1;
          const taskId = `run-scripted-${sequence}`;
          await registry.recordAdmission({
            taskId,
            contextId: `context-${sequence}`,
            incarnation: '',
            agentName: 'bureau',
            owner: OWNER.alice,
            message: 'work',
          });
          if (acknowledgement !== 'durable-only') {
            live.set(taskId, {
              phase: 'running',
              finishReason: undefined,
              error: undefined,
              updatedAt: undefined,
            });
            closing.set(
              taskId,
              acknowledgement === 'never'
                ? new Promise<CleanupAcknowledgement>(() => undefined)
                : Promise.resolve(acknowledgement),
            );
          }
          return rpc(handler, 'bureau.tasks.cancel', { taskId, waitMilliseconds }, 'alice-key');
        },
      });
    } finally {
      await opened.dispose();
    }
  }

  const settledCases: Array<[string, CleanupAcknowledgement]> = [
    ['cleaned-up', { status: 'completed' }],
    ['cleaned-up', { status: 'not-required' }],
    ['cleanup-failed', { status: 'failed', error: new Error('boom') }],
    ['cleanup-unresolved', { status: 'unresolved', reason: 'timed-out' }],
    ['cleanup-unresolved', { status: 'unresolved', reason: 'unreachable' }],
    ['cleanup-unresolved', { status: 'unresolved', reason: 'persistence-failed' }],
    ['unknown-outcome', { status: 'unresolved', reason: 'unknown-effect' }],
  ];

  it.each(settledCases)(
    'answers %s for an acknowledgement of %j',
    async (receipt, acknowledgement) => {
      await withScriptedCleanup({}, async ({ call }) => {
        const body = await call(acknowledgement, 1_000);
        expect(body.result).toMatchObject({ receipt });
      });
    },
  );

  it('answers cleanup-pending when the acknowledgement has not arrived by the end of the wait', async () => {
    await withScriptedCleanup({}, async ({ call }) => {
      const body = await call('never', 20);
      expect(body.result).toMatchObject({ receipt: 'cleanup-pending' });
    });
  });

  it('answers canceled, which claims the stop and no cleanup, for a durable run this process holds no handle for', async () => {
    await withScriptedCleanup({ durable: 'requested' }, async ({ call }) => {
      const body = await call('durable-only');
      expect(body.result).toMatchObject({ receipt: 'canceled', task: { status: 'canceled' } });
    });
  });

  it('rejects a durable run that is already over', async () => {
    await withScriptedCleanup({ durable: 'already-terminal' }, async ({ call }) => {
      const body = await call('durable-only');
      expect(body.result).toMatchObject({ receipt: 'rejected', reason: 'already-terminal' });
    });
  });
});
