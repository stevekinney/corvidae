import { describe, expect, test } from 'bun:test';

import { type StreamResponse, type Task, TaskState } from '@a2a-js/sdk';

import { MemoryStorage } from '../storage/memory.ts';
import { callContext } from './a2a-store.test-support.ts';
import { callerScope, encodeRecord, workflowTaskKey } from './store-support.ts';
import { createTaskEventLog, type TaskEventEntry } from './task-event-log.ts';
import { createWeftA2ATaskStore } from './task-store.ts';
import { statusUpdateEvent, withStatus } from './workflow-task-projection.ts';

const NAMESPACE = 'event-log';
const OWNER = { tenant: '', authenticated: true, userName: 'alice' };

function submitted(id = 'task-1'): Task {
  return {
    id,
    contextId: 'context-1',
    status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: undefined },
    artifacts: [],
    history: [],
    metadata: undefined,
  };
}

function moveTo(task: Task, state: TaskState): { task: Task; events: StreamResponse[] } {
  const status = { state, message: undefined, timestamp: undefined };
  const next = withStatus(task, status);
  return { task: next, events: [statusUpdateEvent(next, status)] };
}

function setup() {
  const storage = new MemoryStorage();
  let clock = 0;
  const log = createTaskEventLog({ storage, namespace: NAMESPACE, now: () => (clock += 1) });
  const scope = callerScope(NAMESPACE, callContext({ user: 'alice' }));
  return { storage, log, scope };
}

describe('the task event log', () => {
  test('creates a task once, with its owner record and first events', async () => {
    const { log, scope } = setup();

    const created = await log.create(scope, OWNER, { task: submitted(), events: [] });
    const again = await log.create(scope, OWNER, { task: submitted(), events: [] });

    expect(created).toMatchObject({ stored: { sequence: -1 } });
    expect(again).toBeUndefined();
    const otherScope = callerScope(NAMESPACE, callContext({ user: 'bob' }));
    const foreign = await log.create(
      otherScope,
      { ...OWNER, userName: 'bob' },
      {
        task: submitted(),
        events: [],
      },
    );
    expect(foreign).toBe('foreign');
    expect(await log.read(otherScope, 'task-1')).toBeUndefined();
    expect(await log.findOwner('task-1')).toEqual(OWNER);
    expect(await log.findOwner('task-2')).toBeUndefined();
    expect(await log.commit(scope, 'task-2', () => undefined)).toBeUndefined();
  });

  test('ignores an owner record it cannot read', async () => {
    const { storage, log, scope } = setup();
    await storage.put(workflowTaskKey(NAMESPACE, 'task-1'), encodeRecord({ tenant: 1 }));

    expect(await log.findOwner('task-1')).toBeUndefined();
    // Creating a task under it fails closed: no reader can say the caller owns it.
    expect(await log.create(scope, OWNER, { task: submitted(), events: [] })).toBe('foreign');
  });

  test('numbers events from zero and records the last one on the task', async () => {
    const { log, scope } = setup();
    await log.create(scope, OWNER, moveTo(submitted(), TaskState.TASK_STATE_SUBMITTED));

    const commit = await log.commit(scope, 'task-1', (stored) =>
      moveTo(stored.task, TaskState.TASK_STATE_WORKING),
    );
    const unchanged = await log.commit(scope, 'task-1', () => undefined);

    expect(commit?.appended.map((entry) => entry.cursor)).toEqual(['1']);
    expect(commit?.stored.sequence).toBe(1);
    expect(unchanged?.appended).toEqual([]);
    const read = await log.read(scope, 'task-1');
    expect(read?.sequence).toBe(1);
  });

  test('follows from a cursor through replay into live events, reading a gap back from storage', async () => {
    const { storage, log, scope } = setup();
    await log.create(scope, OWNER, moveTo(submitted(), TaskState.TASK_STATE_SUBMITTED));
    await log.commit(scope, 'task-1', (stored) =>
      moveTo(stored.task, TaskState.TASK_STATE_WORKING),
    );
    // A second log over the same storage commits without notifying the first one's followers.
    const other = createTaskEventLog({ storage, namespace: NAMESPACE, now: () => 0 });

    const followed: TaskEventEntry[] = [];
    const follower = log.follow(scope, 'task-1', 0);
    const replayed = await follower.next();
    followed.push(replayed.value as TaskEventEntry);
    const live = follower.next();
    await other.commit(scope, 'task-1', (stored) =>
      moveTo(stored.task, TaskState.TASK_STATE_INPUT_REQUIRED),
    );
    await log.commit(scope, 'task-1', (stored) =>
      moveTo(stored.task, TaskState.TASK_STATE_WORKING),
    );
    const notified = await live;
    const gapRead = await follower.next();
    followed.push(notified.value as TaskEventEntry, gapRead.value as TaskEventEntry);
    // The duplicate notification of event 3 is skipped; the next live event follows.
    const after = follower.next();
    await log.commit(scope, 'task-1', (stored) =>
      moveTo(stored.task, TaskState.TASK_STATE_COMPLETED),
    );
    const next = await after;
    followed.push(next.value as TaskEventEntry);
    await follower.return();

    expect(followed.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
  });

  test('is kept by a task store save and removed with its task by prune, but for its owner record', async () => {
    const { storage, log, scope } = setup();
    let now = 0;
    const taskStore = createWeftA2ATaskStore({
      storage,
      namespace: NAMESPACE,
      terminalRetentionMs: 10,
      now: () => now,
    });
    await log.create(scope, OWNER, moveTo(submitted(), TaskState.TASK_STATE_SUBMITTED));
    const done = await log.commit(scope, 'task-1', (stored) =>
      moveTo(stored.task, TaskState.TASK_STATE_COMPLETED),
    );
    await taskStore.save(done?.stored.task as Task, callContext({ user: 'alice' }));
    const read = await log.read(scope, 'task-1');
    expect(read?.sequence).toBe(1);

    now = 100;
    expect(await taskStore.prune()).toBe(1);

    expect(await log.read(scope, 'task-1')).toBeUndefined();
    // The owner record outlives the task, as the engine's start idempotency mapping does.
    expect(await log.findOwner('task-1')).toEqual(OWNER);
    const remaining: string[] = [];
    for await (const [key] of storage.scan('a2a:')) remaining.push(key);
    expect(remaining).toEqual([workflowTaskKey(NAMESPACE, 'task-1')]);
  });

  test('refuses another owner, and lets the same owner create again, once a task was pruned', async () => {
    const { storage, log, scope } = setup();
    let now = 0;
    const taskStore = createWeftA2ATaskStore({
      storage,
      namespace: NAMESPACE,
      terminalRetentionMs: 10,
      now: () => now,
    });
    await log.create(scope, OWNER, moveTo(submitted(), TaskState.TASK_STATE_COMPLETED));
    now = 100;
    expect(await taskStore.prune()).toBe(1);

    const westScope = callerScope(NAMESPACE, callContext({ user: 'alice', tenant: 'west' }));
    const foreign = await log.create(
      westScope,
      { ...OWNER, tenant: 'west' },
      moveTo(submitted(), TaskState.TASK_STATE_SUBMITTED),
    );
    const recreated = await log.create(
      scope,
      OWNER,
      moveTo(submitted(), TaskState.TASK_STATE_SUBMITTED),
    );

    expect(foreign).toBe('foreign');
    expect(await log.read(westScope, 'task-1')).toBeUndefined();
    expect(recreated).toMatchObject({ stored: { sequence: 0 } });
    const stored = await log.read(scope, 'task-1');
    expect(stored?.task.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(await log.findOwner('task-1')).toEqual(OWNER);
  });
});
