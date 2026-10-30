/**
 * A2A reaches top-level tasks only (COR-1868): a child run, a goal attempt or a workflow step is a
 * subordinate task, and a peer can neither read, list, continue, cancel nor reference one, though
 * the native task API shows it. Most tests seed records of the three origins; the last one runs a
 * real child of a peer's own task.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, it } from 'bun:test';

import { call, message, send, taskOf, withA2A } from './a2a-mount.test-support.ts';
import { OWNER, rpc } from './management/management-fixtures.test-support.ts';
import type { OpenedBureau } from './management/management-fixtures.test-support.ts';
import type { TaskOrigin } from '../task-origin.ts';

const parked = () => new Promise<never>(() => {});

const SUBORDINATE: Record<string, TaskOrigin> = {
  'seeded-child': { kind: 'agent', parentRunId: 'run-p', agentName: 'asker' },
  'seeded-attempt': { kind: 'goal', goalRunId: 'goal-g', attemptId: 'attempt-0' },
  'seeded-step': { kind: 'parent', parentRunId: 'workflow-w' },
};

/** Seeds a settled task owned by alice and run by `asker`, with the origin given. */
async function seed(opened: OpenedBureau, taskId: string, origin: TaskOrigin | undefined) {
  await opened.bureau.internals.taskRegistry.recordAdmission({
    taskId,
    contextId: `context-of-${taskId}`,
    incarnation: '',
    agentName: 'asker',
    owner: OWNER.alice,
    origin,
    message: 'seeded',
  });
  await opened.bureau.internals.taskRegistry.recordSettled(taskId, {
    at: new Date().toISOString(),
    status: 'completed',
    finishReason: 'stop-condition',
    message: null,
  });
}

async function seedAll(opened: OpenedBureau) {
  await seed(opened, 'seeded-top', { kind: 'api' });
  await seed(opened, 'seeded-legacy', undefined);
  for (const [taskId, origin] of Object.entries(SUBORDINATE)) await seed(opened, taskId, origin);
}

describe('A2A and subordinate tasks', () => {
  it('lists, reads and references the top-level tasks as before', async () => {
    await withA2A({ asker: parked }, async (opened) => {
      await seedAll(opened);

      const listed = await call(opened, 'asker', 'ListTasks', { pageSize: 50 });
      const read = await call(opened, 'asker', 'GetTask', { id: 'seeded-top' });
      const legacy = await call(opened, 'asker', 'GetTask', { id: 'seeded-legacy' });

      expect(listed.body.error).toBeUndefined();
      expect(
        (listed.body.result.tasks as { id: string }[]).map((task) => task.id).toSorted(),
      ).toEqual(['seeded-legacy', 'seeded-top']);
      expect(read.body.error).toBeUndefined();
      expect(legacy.body.error).toBeUndefined();
    });
  });

  it('answers TaskNotFound to a read, a cancel and a continuation of a subordinate task', async () => {
    await withA2A({ asker: parked }, async (opened) => {
      await seedAll(opened);

      for (const taskId of Object.keys(SUBORDINATE)) {
        const read = await call(opened, 'asker', 'GetTask', { id: taskId });
        const cancel = await call(opened, 'asker', 'CancelTask', { id: taskId });
        const continued = await send(opened, 'asker', {
          message: message('continue', { taskId }),
        });

        for (const answer of [read, cancel, continued]) {
          expect(answer.body.error?.code, taskId).toBe(-32001);
        }
      }
    });
  });

  it('refuses a subordinate task named in referenceTaskIds, as it refuses an absent one', async () => {
    await withA2A({ asker: parked }, async (opened) => {
      await seedAll(opened);

      const referenced = await send(opened, 'asker', {
        message: message('new work', { referenceTaskIds: ['seeded-child'] }),
        configuration: { returnImmediately: true },
      });
      const absent = await send(opened, 'asker', {
        message: message('new work', { referenceTaskIds: ['no-such-task'] }),
        configuration: { returnImmediately: true },
      });
      const allowed = await send(opened, 'asker', {
        message: message('new work', { referenceTaskIds: ['seeded-top'] }),
        configuration: { returnImmediately: true },
      });

      expect(referenced.body.error?.message).toContain('referenceTaskIds');
      expect(absent.body.error?.message).toContain('referenceTaskIds');
      expect(referenced.body.error?.code).toBe(absent.body.error?.code);
      expect(allowed.body.error).toBeUndefined();
    });
  });

  it('still shows the subordinate tasks to the native task API', async () => {
    await withA2A({ asker: parked }, async (opened) => {
      await seedAll(opened);

      const listed = await rpc(opened.handler, 'bureau.tasks.list', { limit: 100 }, 'alice-key');
      const tasks = (listed.result?.['tasks'] ?? []) as { id: string }[];
      const ids = tasks.map((task) => task.id);

      expect(ids).toEqual(expect.arrayContaining(Object.keys(SUBORDINATE)));
    });
  });

  it('hides a real child of the peer’s own task, which the native task API shows', async () => {
    await withA2A({ asker: parked }, async (opened) => {
      const sent = await send(opened, 'asker', {
        message: message('start something'),
        configuration: { returnImmediately: true },
      });
      const parentId = String(taskOf(sent.body).id);
      // The same agent, owner and principal as the peer’s task: only the origin tells them apart.
      const dispatched = await opened.bureau.children.dispatch({
        parentRunId: parentId,
        agentName: 'asker',
        input: 'sub-task',
        principal: OWNER.alice,
        childRunId: 'real-child',
      });
      expect(dispatched).toMatchObject({ outcome: 'started' });
      await waitUntil(async () => (await opened.bureau.tasks.get('real-child')) !== undefined, {
        message: 'the child task is admitted',
      });
      expect(await opened.bureau.tasks.get('real-child')).toMatchObject({
        owner: OWNER.alice,
        agentName: 'asker',
        origin: { kind: 'agent', parentRunId: parentId },
      });

      const listed = await call(opened, 'asker', 'ListTasks', { pageSize: 50 });
      const read = await call(opened, 'asker', 'GetTask', { id: 'real-child' });
      const cancel = await call(opened, 'asker', 'CancelTask', { id: 'real-child' });
      const referenced = await send(opened, 'asker', {
        message: message('new work', { referenceTaskIds: ['real-child'] }),
        configuration: { returnImmediately: true },
      });

      expect((listed.body.result.tasks as { id: string }[]).map((task) => task.id)).toEqual([
        parentId,
      ]);
      expect(read.body.error?.code).toBe(-32001);
      expect(cancel.body.error?.code).toBe(-32001);
      expect(referenced.body.error?.message).toContain('referenceTaskIds');
      // The native API still shows it, and the peer's cancel left it running.
      const still = await opened.bureau.tasks.get('real-child');
      expect(still?.status).toBe('working');
    });
  });
});
