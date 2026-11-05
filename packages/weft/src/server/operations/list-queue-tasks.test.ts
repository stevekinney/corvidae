/**
 * `weft.task.queues.tasks` (COR-2018, rows 78n, 78o, 79b and 79c): the waiting and failed-for-good
 * tasks of one queue, failed first, with the counts the queue holds and a page cursor.
 */
import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import {
  deadLetteredFixture,
  leasedFixture,
  putLedgerRecord,
  queuedFixture,
} from './get-task-diagnostics.test-support.ts';
import { collectQueueTasks, listQueueTasksOperation } from './list-queue-tasks.ts';

async function seed(): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  await putLedgerRecord(
    storage,
    queuedFixture({ operationId: 'w-3', queue: 'reports', firstQueuedAt: 300 }),
  );
  await putLedgerRecord(
    storage,
    queuedFixture({ operationId: 'w-1', queue: 'reports', firstQueuedAt: 100, attempt: 6 }),
  );
  await putLedgerRecord(
    storage,
    queuedFixture({ operationId: 'w-2', queue: 'reports', firstQueuedAt: 200 }),
  );
  await putLedgerRecord(
    storage,
    deadLetteredFixture({
      operationId: 'f-2',
      queue: 'reports',
      deadLetteredAt: 2_000,
      attempt: 5,
      error: 'The Slack channel is gone',
    }),
  );
  await putLedgerRecord(
    storage,
    deadLetteredFixture({ operationId: 'f-1', queue: 'reports', deadLetteredAt: 1_000 }),
  );
  await putLedgerRecord(storage, queuedFixture({ operationId: 'other', queue: 'payments' }));
  await putLedgerRecord(storage, leasedFixture({ operationId: 'running', queue: 'reports' }));
  return storage;
}

const input = { queue: 'reports', status: 'all', limit: 25 } as const;

describe('collectQueueTasks', () => {
  it('counts the waiting and failed tasks of the queue and no others', async () => {
    const result = await collectQueueTasks(await seed(), input);
    expect(result.counts).toEqual({ waiting: 3, failed: 2 });
    expect(result.nextCursor).toBeNull();
  });

  it('lists failed tasks first, then waiting ones in the order they arrived', async () => {
    const result = await collectQueueTasks(await seed(), input);
    expect(result.items.map((task) => `${task.status}:${task.operationId}`)).toEqual([
      'failed:f-1',
      'failed:f-2',
      'waiting:w-1',
      'waiting:w-2',
      'waiting:w-3',
    ]);
  });

  it('carries the attempt, the moment, and why a failed task failed', async () => {
    const result = await collectQueueTasks(await seed(), { ...input, status: 'failed' });
    expect(result.items[1]).toMatchObject({
      operationId: 'f-2',
      attempt: 5,
      at: 2_000,
      error: 'The Slack channel is gone',
    });
    expect(result.items[0]).toHaveProperty('persistenceFailureReason');
    expect(result.items[0]).not.toHaveProperty('error');
  });

  it('lists one status and still counts both', async () => {
    const waiting = await collectQueueTasks(await seed(), { ...input, status: 'waiting' });
    expect(waiting.items.map((task) => task.operationId)).toEqual(['w-1', 'w-2', 'w-3']);
    expect(waiting.items[0]).toMatchObject({ status: 'waiting', attempt: 6, at: 100 });
    expect(waiting.counts).toEqual({ waiting: 3, failed: 2 });
  });

  it('pages by cursor without repeating or skipping a task', async () => {
    const storage = await seed();
    const first = await collectQueueTasks(storage, { ...input, limit: 2 });
    expect(first.items.map((task) => task.operationId)).toEqual(['f-1', 'f-2']);
    expect(first.nextCursor).not.toBeNull();
    const second = await collectQueueTasks(storage, {
      ...input,
      limit: 2,
      cursor: first.nextCursor ?? '',
    });
    expect(second.items.map((task) => task.operationId)).toEqual(['w-1', 'w-2']);
    const third = await collectQueueTasks(storage, {
      ...input,
      limit: 2,
      cursor: second.nextCursor ?? '',
    });
    expect(third.items.map((task) => task.operationId)).toEqual(['w-3']);
    expect(third.nextCursor).toBeNull();
  });

  it('refuses a cursor it did not hand out', async () => {
    expect(
      await rejectionOf(collectQueueTasks(await seed(), { ...input, cursor: 'not-a-cursor' })),
    ).toMatchObject({ code: 'InvalidParams' });
  });

  it('is an empty queue when no task is waiting or failed there', async () => {
    const result = await collectQueueTasks(new MemoryStorage(), { ...input, queue: 'none' });
    expect(result).toEqual({
      queue: 'none',
      counts: { waiting: 0, failed: 0 },
      items: [],
      nextCursor: null,
    });
  });
});

describe('weft.task.queues.tasks', () => {
  it('needs only system:read and never changes anything', () => {
    expect(listQueueTasksOperation.destructive).toBe(false);
    expect(listQueueTasksOperation.access).toEqual({
      kind: 'scoped',
      scopes: { kind: 'anyOf', scopes: ['system:read'] },
    });
  });
});
