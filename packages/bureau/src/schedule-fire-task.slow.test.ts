/**
 * COR-1482 — each schedule fire is a task owned by the schedule's owner, with the scheduler's
 * service principal recorded as the actor. A fire is driven by Weft's poller on real elapsed time
 * (the schedule's own one-second interval), which is why this file is a slow lane.
 */
import { createAgent } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  answering,
  openBureau,
  type OpenedBureau,
  OWNER,
  parkingUntilAborted,
  readFrames,
  rpc,
  type RpcBody,
  subscribeRequest,
} from './http/management/management-fixtures.test-support.ts';
import type { GenerateFunction } from '@lostgradient/operative';
import { awakeTurns } from '@lostgradient/testing/wait-until';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function waitForReal<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for await (const _turn of awakeTurns()) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function serve(generate: GenerateFunction): Promise<OpenedBureau> {
  const opened = await openBureau({
    agents: { writer: createAgent({ name: 'writer', generate }) },
    generate,
    durableHistory: true,
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

type TaskView = {
  id: string;
  contextId: string;
  owner: string;
  actor: string | null;
  agentName: string | null;
  status: string;
};

const tasksOf = (body: RpcBody) => (body.result?.['tasks'] ?? []) as TaskView[];

async function scheduleAs(opened: OpenedBureau, key: string): Promise<string> {
  const created = await rpc(
    opened.handler,
    'bureau.schedules.create',
    { agentName: 'writer', spec: '1s', input: 'tick' },
    key,
  );
  expect(created.error).toBeUndefined();
  return created.result!['id'] as string;
}

describe('a schedule fire is a task of the schedule’s owner', () => {
  it('lets the owner list, read, observe, and cancel it with no operator scope, and records the scheduler as the actor', async () => {
    const opened = await serve(parkingUntilAborted);
    const scheduleId = await scheduleAs(opened, 'alice-key');

    // List.
    const task = await waitForReal(async () => {
      const listed = await rpc(opened.handler, 'bureau.tasks.list', {}, 'alice-key');
      return tasksOf(listed)[0];
    }, 'the first fire to appear in the owner’s task list');
    // One fire is enough; stop the schedule before it can fire again.
    await rpc(opened.handler, 'bureau.schedules.cancel', { scheduleId }, 'alice-key');

    expect(task).toMatchObject({
      owner: OWNER.alice,
      actor: 'system:scheduler',
      agentName: 'writer',
    });
    const awaited6 = await opened.bureau.internals.taskRegistry.record(task.id);
    expect(awaited6?.actor).toBe('system:scheduler');
    // COR-1867: the fire says which schedule it is a fire of, and is its own run id.
    expect(awaited6?.origin).toEqual({ kind: 'schedule', scheduleId, fireId: task.id });
    const byOrigin = await rpc(
      opened.handler,
      'bureau.tasks.list',
      { origin: 'schedule' },
      'alice-key',
    );
    expect(tasksOf(byOrigin).map((entry) => entry.id)).toContain(task.id);
    const notChat = await rpc(opened.handler, 'bureau.tasks.list', { origin: 'chat' }, 'alice-key');
    expect(tasksOf(notChat)).toEqual([]);
    expect(await opened.bureau.ownerOf({ kind: 'run', id: task.id })).toBe(OWNER.alice);

    // Read.
    const read = await rpc(opened.handler, 'bureau.tasks.get', { taskId: task.id }, 'alice-key');
    expect(read.result).toMatchObject({ id: task.id, owner: OWNER.alice });
    // Anyone else answers as if there were no such task.
    const other = await rpc(opened.handler, 'bureau.tasks.get', { taskId: task.id }, 'bob-key');
    expect(other.error?.data?.httpStatus).toBe(404);
    expect(tasksOf(await rpc(opened.handler, 'bureau.tasks.list', {}, 'bob-key'))).toEqual([]);

    // Observe.
    const eventsResponse = await opened.handler(
      subscribeRequest('bureau.tasks.events', { taskId: task.id }, 'alice-key'),
    );
    const frames = await readFrames(eventsResponse, {
      stop: (seen) => seen.length >= 1,
    });
    expect(frames[0]).toMatchObject({
      event: 'task.snapshot',
      data: { taskId: task.id, status: 'working' },
    });

    // Cancel.
    const canceled = await rpc(
      opened.handler,
      'bureau.tasks.cancel',
      { taskId: task.id },
      'alice-key',
    );
    expect(canceled.error).toBeUndefined();
    const ended = await waitForReal(async () => {
      const view = await rpc(opened.handler, 'bureau.tasks.get', { taskId: task.id }, 'alice-key');
      return view.result?.['status'] === 'canceled' ? view : undefined;
    }, 'the fire’s task to read as canceled');
    expect(ended.result).toMatchObject({ actor: 'system:scheduler' });
  });

  it('is found by its context, with the incarnation of the session it ran in, and settles with its answer', async () => {
    const opened = await serve(answering('digest ready'));
    const scheduleId = await scheduleAs(opened, 'alice-key');

    const done = await waitForReal(async () => {
      const listed = await rpc(opened.handler, 'bureau.tasks.list', {}, 'alice-key');
      return tasksOf(listed).find((task) => task.status === 'completed');
    }, 'a fire to complete');
    await rpc(opened.handler, 'bureau.schedules.cancel', { scheduleId }, 'alice-key');

    // Without the filter, and with it.
    const filtered = await waitForReal(async () => {
      const listed = await rpc(
        opened.handler,
        'bureau.tasks.list',
        { contextId: done.contextId },
        'alice-key',
      );
      return tasksOf(listed).length > 0 ? listed : undefined;
    }, 'the fire to be found by its context');
    expect(tasksOf(filtered).map((task) => task.id)).toContain(done.id);
    const session = await opened.bureau.contexts.get(done.contextId);
    const awaited7 = await opened.bureau.internals.taskRegistry.record(done.id);
    expect(awaited7?.incarnation).toBe(session?.incarnation);
    expect(session?.incarnation).toBeTruthy();
    expect(
      tasksOf(
        await rpc(opened.handler, 'bureau.tasks.list', { contextId: done.contextId }, 'bob-key'),
      ),
    ).toEqual([]);

    // The scheduler is the actor on the fire's audit entry, as on its task.
    const fired = await opened.bureau.internals.auditTrail?.query({
      runId: done.id,
      type: 'schedule.fired',
    });
    expect(fired?.map((entry) => entry.principal)).toEqual(['system:scheduler']);
  });
});
