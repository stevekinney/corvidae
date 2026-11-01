/**
 * COR-1868 (part B) — the management plane over the tasks of child runs, goal attempts and workflow
 * steps: the same owner rule as every task (the owner, or a holder of the scope), `events` and
 * `inspect` reach a child by it, and `cancel` answers the owned-by reasons on the wire.
 */
import { createAgent } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, it } from 'bun:test';

import { CHECK, createCheckValidator, goalRequest } from '../../testing/goal-fixtures.test-support';
import {
  openBureau,
  type OpenedBureau,
  OWNER,
  parkingUntilAborted,
  rpc,
  subscribeRequest,
} from './management-fixtures.test-support.ts';

async function withChild<T>(
  body: (opened: OpenedBureau, childId: string) => Promise<T>,
): Promise<T> {
  const opened = await openBureau({
    durableHistory: true,
    agents: { worker: createAgent({ generate: parkingUntilAborted }) },
    validators: [createCheckValidator()],
  });
  try {
    const parent = await opened.bureau.tasks.start('default', 'plan', { principal: OWNER.alice });
    const dispatched = await opened.bureau.children.dispatch({
      parentRunId: parent.id,
      agentName: 'worker',
      input: 'work',
      principal: OWNER.alice,
      childRunId: 'managed-child',
    });
    if (dispatched.outcome !== 'started') throw new Error('expected a started child');
    await waitUntil(async () => (await opened.bureau.tasks.get('managed-child')) !== undefined, {
      message: 'the child task exists',
    });
    return await body(opened, 'managed-child');
  } finally {
    await opened.dispose();
  }
}

describe('a child’s task over the management plane', () => {
  it('is read, inspected and listed by its owner and by a tasks reader, and not by another owner', async () => {
    await withChild(async (opened, childId) => {
      const answer = async (method: string, key: string, params: Record<string, unknown> = {}) =>
        rpc(opened.handler, method, { taskId: childId, ...params }, key);

      for (const method of ['bureau.tasks.get', 'bureau.tasks.inspect']) {
        const owner = await answer(method, 'alice-key');
        const reader = await answer(method, 'tasks-reader-key');
        const stranger = await answer(method, 'bob-key');
        expect(owner.error, method).toBeUndefined();
        expect(reader.error, method).toBeUndefined();
        expect(stranger.error?.['message'], method).toContain('No task with id');
      }
      // `events` is a subscription: the owner and the scope reach it, a stranger gets not found.
      const subscribe = async (key: string) => {
        const response = await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: childId }, key),
        );
        await response.body?.cancel();
        return response.status;
      };
      expect(await subscribe('alice-key')).toBe(200);
      expect(await subscribe('tasks-reader-key')).toBe(200);
      expect(await subscribe('bob-key')).toBe(404);
      const listed = await rpc(
        opened.handler,
        'bureau.tasks.list',
        { origin: 'agent' },
        'alice-key',
      );
      expect(((listed.result?.['tasks'] ?? []) as { id: string }[]).map((task) => task.id)).toEqual(
        [childId],
      );
    });
  });

  it('is cancelled by its owner like the child, and a stranger cannot', async () => {
    await withChild(async (opened, childId) => {
      const stranger = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: childId },
        'bob-key',
      );
      const owner = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: childId },
        'alice-key',
      );

      expect(stranger.error?.['message']).toContain('No task with id');
      expect(owner.error).toBeUndefined();
      expect(owner.result?.['receipt']).not.toBe('rejected');
      await waitUntil(
        async () => {
          const task = await opened.bureau.tasks.get(childId);
          return task?.status === 'canceled';
        },
        {
          message: 'the child task is canceled',
        },
      );
    });
  });
});

describe('a goal attempt’s task over the management plane', () => {
  it('answers a cancel as owned by the goal', async () => {
    const opened = await openBureau({
      agents: { worker: createAgent({ name: 'worker', generate: parkingUntilAborted }) },
      validators: [createCheckValidator()],
    });
    try {
      await opened.bureau.goals.create(goalRequest({ goalRunId: 'g-wire', validator: CHECK }));
      await waitUntil(async () => (await opened.bureau.tasks.get('goal-g-wire-a0')) !== undefined, {
        message: 'the attempt task exists',
      });

      const cancelled = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: 'goal-g-wire-a0' },
        'operator-key',
      );

      expect(cancelled.error).toBeUndefined();
      expect(cancelled.result).toMatchObject({ receipt: 'rejected', reason: 'owned-by-goal' });
    } finally {
      await opened.dispose();
    }
  });
});

describe('the children of a run and of its thread over the management plane (COR-1987)', () => {
  it('lists a dispatched child by its parent run and by its parent’s context, the task id being the child run id', async () => {
    const opened = await openBureau({
      durableHistory: true,
      agents: { worker: createAgent({ generate: parkingUntilAborted }) },
    });
    try {
      const parent = await opened.bureau.tasks.start('default', 'plan', {
        principal: OWNER.alice,
      });
      const dispatched = await opened.bureau.children.dispatch({
        parentRunId: parent.id,
        agentName: 'worker',
        input: 'work',
        principal: OWNER.alice,
        childRunId: 'thread-child',
      });
      if (dispatched.outcome !== 'started') throw new Error('expected a started child');
      await waitUntil(async () => (await opened.bureau.tasks.get('thread-child')) !== undefined, {
        message: 'the child task exists',
      });

      const byParent = await rpc(
        opened.handler,
        'bureau.tasks.list',
        { parentRunId: parent.id },
        'alice-key',
      );
      const byContext = await rpc(
        opened.handler,
        'bureau.tasks.list',
        { parentContextId: parent.contextId },
        'alice-key',
      );

      type Child = {
        id: string;
        agentName: string | null;
        origin: { kind: string; parentRunId?: string; parentContextId?: string } | null;
      };
      for (const body of [byParent, byContext]) {
        const children = (body.result?.['tasks'] ?? []) as Child[];
        expect(children.map((child) => child.id)).toEqual(['thread-child']);
        expect(children[0]).toMatchObject({
          // The task id is the child run's own id: a chat joins its card to the live announcement on it.
          id: dispatched.child.childRunId,
          agentName: 'worker',
          origin: { kind: 'agent', parentRunId: parent.id, parentContextId: parent.contextId },
        });
      }
    } finally {
      await opened.dispose();
    }
  });
});
