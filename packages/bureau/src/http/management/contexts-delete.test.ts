import { type CleanupAcknowledgement, createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { BureauError } from '../../create-bureau.ts';
import { createMemoryStorageFixture } from '../../test/storage-fixtures';
import { rejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { waitForCondition } from '../../test';
import type { ContextDeletionReport } from '../../types.ts';
import { type BureauHandlerSource, createBureauHandler } from '../create-bureau-handler.ts';
import {
  answering,
  authentication,
  createStorageGate,
  openBureau,
  type OpenedBureau,
  OWNER,
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

async function startRun(
  opened: OpenedBureau,
  options: { principal?: string; sessionId?: string; message?: string } = {},
) {
  const run = await opened.bureau.createRun({
    message: options.message ?? 'work',
    principal: options.principal ?? OWNER.alice,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  });
  await waitForCondition(
    () => opened.bureau.getRun(run.id)?.status === 'running',
    `run ${run.id} never started`,
  );
  return run;
}

const deleteContext = (opened: OpenedBureau, contextId: string, key: string, wait?: number) =>
  rpc(
    opened.handler,
    'bureau.contexts.delete',
    { contextId, ...(wait === undefined ? {} : { waitMilliseconds: wait }) },
    key,
  );

describe('bureau.contexts.delete access', () => {
  it('deletes a context the caller owns, and any context for bureau.contexts:write', async () => {
    await withBureau({ generate: answering() }, async (opened) => {
      const mine = await opened.bureau.createRun({ message: 'mine', principal: OWNER.alice });
      const theirs = await opened.bureau.createRun({ message: 'theirs', principal: OWNER.bob });
      await waitForCondition(() => opened.bureau.getRun(mine.id)?.status === 'completed', 'mine');
      await waitForCondition(
        () => opened.bureau.getRun(theirs.id)?.status === 'completed',
        'theirs',
      );

      const own = await deleteContext(opened, mine.sessionId, 'alice-key');
      const operator = await deleteContext(opened, theirs.sessionId, 'contexts-writer-key');

      expect(own.result).toMatchObject({
        contextId: mine.sessionId,
        receipt: 'applied',
        tasks: [],
      });
      expect(operator.result).toMatchObject({ contextId: theirs.sessionId, receipt: 'applied' });
      expect(await opened.bureau.getSession(mine.sessionId)).toBeUndefined();
      expect(await opened.bureau.getSession(theirs.sessionId)).toBeUndefined();
    });
  });

  it('answers a context the caller may not delete exactly as it answers one that does not exist', async () => {
    await withBureau({ generate: answering() }, async (opened) => {
      const run = await opened.bureau.createRun({ message: 'mine', principal: OWNER.alice });
      await waitForCondition(() => opened.bureau.getRun(run.id)?.status === 'completed', 'finish');

      const stranger = await deleteContext(opened, run.sessionId, 'bob-key');
      const tasksScope = await deleteContext(opened, run.sessionId, 'tasks-writer-key');
      const missing = await deleteContext(opened, 'no-such-context', 'bob-key');

      expect(stranger.error?.data?.httpStatus).toBe(404);
      expect(tasksScope.error?.data?.httpStatus).toBe(404);
      expect(JSON.stringify(stranger).replaceAll(run.sessionId, '<id>')).toBe(
        JSON.stringify(missing).replaceAll('no-such-context', '<id>'),
      );
      expect(await opened.bureau.getSession(run.sessionId)).toBeDefined();
    });
  });

  it('answers the id of a bureau.run dispatch, which owns no session, as a missing context', async () => {
    const worker = createAgent({ name: 'worker', generate: parkingUntilAborted });
    await withBureau({ agents: { worker } }, async (opened) => {
      const run = opened.bureau.run('worker', 'catalog work', { principal: OWNER.alice });
      try {
        await waitForCondition(
          () => opened.bureau.getRun(run.id)?.status === 'running',
          'the dispatch never started',
        );

        const body = await deleteContext(opened, run.id, 'operator-key');

        expect(body.error?.data?.httpStatus).toBe(404);
        // It is a task, even though it is not a context.
        const task = await rpc(opened.handler, 'bureau.tasks.get', { taskId: run.id }, 'alice-key');
        expect(task.result).toMatchObject({ id: run.id, contextId: run.id, agentName: 'worker' });
      } finally {
        run.abort('test over');
        await run.closed();
      }
    });
  });
});

describe('bureau.contexts.delete receipts', () => {
  it('answers cleaned-up for a context with a live run once that run’s cleanup is acknowledged', async () => {
    await withBureau({}, async (opened) => {
      const run = await startRun(opened);

      const body = await deleteContext(opened, run.sessionId, 'alice-key', 2_000);

      expect(body.result).toMatchObject({
        receipt: 'cleaned-up',
        tasks: [{ taskId: run.id, cleanup: 'cleaned-up' }],
      });
      expect(opened.bureau.getRun(run.id)?.status).toBe('aborted');
      expect(await opened.bureau.getSession(run.sessionId)).toBeUndefined();
    });
  });

  it('rejects, applying nothing, once shutdown has closed admission', async () => {
    await withBureau({}, async (opened) => {
      const run = await startRun(opened);
      const shutdown = opened.bureau.shutdown({ policy: 'drain' });
      try {
        await waitForCondition(() => opened.bureau.lifecycle !== 'ready', 'admission never closed');

        const body = await deleteContext(opened, run.sessionId, 'alice-key');

        expect(body.result).toEqual({
          contextId: run.sessionId,
          receipt: 'rejected',
          reason: 'shutting-down',
          tasks: [],
        });
        expect(await opened.bureau.getSession(run.sessionId)).toBeDefined();
      } finally {
        opened.bureau.abortRun(run.id);
        await shutdown;
      }
    });
  });

  it('cancels and awaits every live task of a context, not only the latest, and neither persists session state afterwards', async () => {
    await withBureau({}, async (opened) => {
      const first = await startRun(opened, { message: 'first turn' });
      const second = await startRun(opened, { sessionId: first.sessionId, message: 'second turn' });
      expect(second.sessionId).toBe(first.sessionId);

      const body = await deleteContext(opened, first.sessionId, 'alice-key', 2_000);

      expect(body.result).toMatchObject({ receipt: 'cleaned-up' });
      const cancelled = (body.result?.['tasks'] ?? []) as Array<{
        taskId: string;
        cleanup: string;
      }>;
      const reported = cancelled.map((task) => task.taskId).toSorted();
      expect(reported).toEqual([first.id, second.id].toSorted());
      expect(opened.bureau.getRun(first.id)?.status).toBe('aborted');
      expect(opened.bureau.getRun(second.id)?.status).toBe('aborted');
      // Neither run saves the session it was cancelled in, then or later.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await opened.bureau.getSession(first.sessionId)).toBeUndefined();
    });
  });

  it('empties the originating messages of the deleted context’s tasks and keeps their status and cleanup', async () => {
    await withBureau({}, async (opened) => {
      const run = await startRun(opened, { message: 'REMEMBER-ME-NOT' });
      const before = await opened.bureau.tasks.history(run.id);
      expect(before?.map((message) => message.text)).toEqual(['REMEMBER-ME-NOT']);

      await deleteContext(opened, run.sessionId, 'alice-key', 2_000);

      expect(await opened.bureau.tasks.history(run.id)).toEqual([]);
      expect(JSON.stringify(await opened.bureau.tasks.record(run.id))).not.toContain(
        'REMEMBER-ME-NOT',
      );
      const task = await rpc(opened.handler, 'bureau.tasks.get', { taskId: run.id }, 'alice-key');
      expect(task.result).toMatchObject({ status: 'canceled', cleanup: 'cleaned-up' });
    });
  });
});

/**
 * Receipts that depend on how a run's cleanup ended, driven through the real handler
 * and the real registry over a Bureau whose deletion reports the acknowledgements a
 * test chooses.
 */
describe('bureau.contexts.delete receipts that depend on the cleanup acknowledgement', () => {
  async function withScriptedDeletion<T>(
    acknowledgements: readonly (CleanupAcknowledgement | 'never')[],
    body: (call: (wait?: number) => ReturnType<typeof rpc>) => Promise<T>,
  ): Promise<T> {
    const opened = await openBureau({});
    try {
      const report: ContextDeletionReport = {
        deleted: true,
        tasks: acknowledgements.map((acknowledgement, index) => ({
          taskId: `run-scripted-${index}`,
          closed:
            acknowledgement === 'never'
              ? new Promise<CleanupAcknowledgement>(() => undefined)
              : Promise.resolve(acknowledgement),
        })),
      };
      const source = Object.create(opened.bureau, {
        getOwner: { value: async () => OWNER.alice },
        getSession: { value: async () => ({ id: 'context-1' }) },
        deleteSession: { value: async () => report },
      }) as BureauHandlerSource;
      const handler = createBureauHandler(source, { authentication });
      return await body((wait) =>
        rpc(
          handler,
          'bureau.contexts.delete',
          { contextId: 'context-1', ...(wait === undefined ? {} : { waitMilliseconds: wait }) },
          'alice-key',
        ),
      );
    } finally {
      await opened.dispose();
    }
  }

  const settledCases: Array<[string, CleanupAcknowledgement]> = [
    ['cleaned-up', { status: 'completed' }],
    ['cleanup-failed', { status: 'failed', error: new Error('boom') }],
    ['cleanup-unresolved', { status: 'unresolved', reason: 'timed-out' }],
    ['cleanup-unresolved', { status: 'unresolved', reason: 'unreachable' }],
    ['cleanup-unresolved', { status: 'unresolved', reason: 'persistence-failed' }],
    ['unknown-outcome', { status: 'unresolved', reason: 'unknown-effect' }],
  ];

  it.each(settledCases)(
    'answers %s for an acknowledgement of %j',
    async (receipt, acknowledgement) => {
      await withScriptedDeletion([acknowledgement], async (call) => {
        const body = await call(1_000);
        expect(body.result).toMatchObject({ receipt });
      });
    },
  );

  it('answers cleanup-pending for a live run whose cleanup is still running', async () => {
    await withScriptedDeletion(['never'], async (call) => {
      const body = await call(20);
      expect(body.result).toMatchObject({
        receipt: 'cleanup-pending',
        tasks: [{ taskId: 'run-scripted-0', cleanup: 'cleanup-pending' }],
      });
    });
  });

  it('answers cleanup-pending without waiting when no acknowledgement has arrived', async () => {
    await withScriptedDeletion(['never'], async (call) => {
      const body = await call();
      expect(body.result).toMatchObject({ receipt: 'cleanup-pending' });
    });
  });

  it('lets a pending cleanup on either of two tasks decide the receipt, the least settled winning', async () => {
    await withScriptedDeletion([{ status: 'completed' }, 'never'], async (call) => {
      const body = await call(20);
      expect(body.result).toMatchObject({ receipt: 'cleanup-pending' });
      expect(body.result?.['tasks']).toEqual([
        { taskId: 'run-scripted-0', cleanup: 'cleaned-up' },
        { taskId: 'run-scripted-1', cleanup: 'cleanup-pending' },
      ]);
    });
    await withScriptedDeletion(['never', { status: 'completed' }], async (call) => {
      const body = await call(20);
      expect(body.result).toMatchObject({ receipt: 'cleanup-pending' });
    });
  });

  it('orders the settled states unresolved, unknown, failed, cleaned-up', async () => {
    const unresolved: CleanupAcknowledgement = { status: 'unresolved', reason: 'timed-out' };
    const unknown: CleanupAcknowledgement = { status: 'unresolved', reason: 'unknown-effect' };
    const failed: CleanupAcknowledgement = { status: 'failed', error: new Error('boom') };
    const completed: CleanupAcknowledgement = { status: 'completed' };
    const cases: Array<[CleanupAcknowledgement[], string]> = [
      [[completed, failed, unknown, unresolved], 'cleanup-unresolved'],
      [[completed, failed, unknown], 'unknown-outcome'],
      [[completed, failed], 'cleanup-failed'],
      [[completed, completed], 'cleaned-up'],
    ];
    for (const [acknowledgements, receipt] of cases) {
      await withScriptedDeletion(acknowledgements, async (call) => {
        const body = await call(1_000);
        expect(body.result).toMatchObject({ receipt });
      });
    }
  });
});

describe('the fence around a context being deleted', () => {
  it('refuses a new run on the context while its deletion is in flight, then allows the id as a new context', async () => {
    await withBureau({}, async (opened) => {
      const run = await startRun(opened);

      const deletion = opened.bureau.deleteSession(run.sessionId);
      const refused = await opened.bureau
        .createRun({ message: 'late', principal: OWNER.alice, sessionId: run.sessionId })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await deletion;

      expect(refused).toBeInstanceOf(BureauError);
      expect((refused as BureauError).code).toBe('NOT_FOUND');
      const again = await opened.bureau.createRun({
        message: 'fresh start',
        principal: OWNER.alice,
        sessionId: run.sessionId,
      });
      expect(again.sessionId).toBe(run.sessionId);
      // The new context holds only its own task: the old incarnation's are not its own.
      const listed = await rpc(
        opened.handler,
        'bureau.tasks.list',
        { contextId: run.sessionId },
        'alice-key',
      );
      const listedTasks = (listed.result?.['tasks'] ?? []) as Array<{ id: string }>;
      expect(listedTasks.map((task) => task.id)).toEqual([again.id]);
    });
  });

  /**
   * A Bureau whose deletion of a session is held at its first read of a session body: the
   * session and its run are still live, nothing is cancelled, and the fence is the only
   * thing standing between a continuation and the context.
   */
  async function withDeletionHeldAtTheFirstRead<T>(
    body: (context: {
      opened: OpenedBureau;
      run: Awaited<ReturnType<typeof startRun>>;
      deletion: Promise<unknown>;
    }) => Promise<T>,
  ): Promise<T> {
    const gate = createStorageGate(
      (verb, args) => verb === 'get' && String(args[0]).startsWith('agent-session'),
    );
    const fixture = createMemoryStorageFixture({ wrapStorage: (raw) => gate.wrap(raw) });
    const opened = await openBureau({ storage: fixture.configuration });
    try {
      const run = await startRun(opened);
      gate.arm();
      const deletion = opened.bureau.deleteSession(run.sessionId);
      await gate.reached;
      try {
        return await body({ opened, run, deletion });
      } finally {
        gate.release();
        await deletion;
      }
    } finally {
      await opened.dispose();
      await fixture.dispose();
    }
  }

  it('answers session input for the context as input to one that does not exist, and admits none', async () => {
    await withDeletionHeldAtTheFirstRead(async ({ opened, run }) => {
      const outcome = await opened.bureau.submitSessionInput(run.sessionId, {
        id: 'input-late',
        principal: OWNER.alice,
        deliveryMode: 'steer',
        payload: 'too late',
      });

      expect(outcome.outcome).toBe('not-found');
    });
  });

  it('refuses a signal to the context as a session that does not exist', async () => {
    await withDeletionHeldAtTheFirstRead(async ({ opened, run }) => {
      const refused = await rejectionOf(opened.bureau.signalSession(run.sessionId, 'wake', {}));

      expect(refused).toBeInstanceOf(BureauError);
      expect((refused as BureauError).code).toBe('NOT_FOUND');
      expect((refused as BureauError).message).toContain('Session not found');
    });
  });

  it('refuses a run whose admission a deletion overtakes between the session save and the run registering', async () => {
    // The task record is written after the session is saved as running and before the run
    // registers: hold it there, start the deletion in the gap, and hold the deletion too, so
    // it is in flight when the run reaches its registration.
    const admission = createStorageGate((_verb, args) =>
      JSON.stringify(args).includes('bureau-task:v1:'),
    );
    const deleting = createStorageGate(
      (verb, args) => verb === 'get' && String(args[0]).startsWith('agent-session'),
    );
    const fixture = createMemoryStorageFixture({
      wrapStorage: (raw) => admission.wrap(deleting.wrap(raw)),
    });
    const opened = await openBureau({ storage: fixture.configuration });
    try {
      admission.arm();
      const creating = rejectionOf(
        opened.bureau.createRun({
          message: 'overtaken',
          principal: OWNER.alice,
          sessionId: 'overtaken',
        }),
      );
      await admission.reached;
      deleting.arm();
      const deletion = opened.bureau.deleteSession('overtaken');
      await deleting.reached;
      admission.release();

      const refused = await creating;
      deleting.release();
      await deletion;

      expect(refused).toBeInstanceOf(BureauError);
      expect((refused as BureauError).code).toBe('NOT_FOUND');
      expect(opened.bureau.listRuns()).toEqual([]);
      expect(await opened.bureau.getSession('overtaken')).toBeUndefined();
      const tasks = await opened.bureau.tasks.list({ limit: 50, offset: 0 });
      expect(tasks.tasks).toEqual([]);
    } finally {
      await opened.dispose();
      await fixture.dispose();
    }
  });
});
