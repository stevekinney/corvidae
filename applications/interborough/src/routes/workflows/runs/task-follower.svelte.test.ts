/**
 * Following one task (`task-follower.svelte.ts`): the stream's elements become the page's artifact
 * and its prompt to read the task again, and a stream that drops resumes from the last position the
 * Bureau gave, which is kept for a reload.
 */
import { waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { quietFor } from '@lostgradient/testing/wait-until';
import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import type { TaskEvent } from '../../../lib/bureau-tasks.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  snapshotElement,
  statusElement,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { TaskFollower, taskCursorKey } from './task-follower.svelte.ts';

let stub: BureauWorldStub | undefined;
let follower: TaskFollower | undefined;

/** An in-memory `Storage`, because the tests do not share a browser's. */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

/** A sleep the test releases, so no case waits on a clock. */
function controlledSleep() {
  const delays: number[] = [];
  const waiting: (() => void)[] = [];
  return {
    delays,
    sleep: (milliseconds: number) =>
      new Promise<void>((resolve) => {
        delays.push(milliseconds);
        waiting.push(resolve);
      }),
    release: () => waiting.splice(0).forEach((resolve) => resolve()),
    pending: () => waiting.length,
  };
}

beforeEach(() => {
  stub = installBureauWorld(emptyBureauWorld({ tasks: [taskFixture({ id: 'run-1' })] }));
});

afterEach(() => {
  follower?.dispose();
  follower = undefined;
  stub?.restore();
  stub = undefined;
});

function follow(
  options: Partial<ConstructorParameters<typeof TaskFollower>[0]> = {},
  elements: TaskEvent[] = [],
) {
  const sleeper = controlledSleep();
  const storage = options.storage ?? memoryStorage();
  follower = new TaskFollower({
    taskId: 'run-1',
    storage,
    sleep: sleeper.sleep,
    onElement: (element) => void elements.push(element),
    ...options,
  });
  follower.start();
  return { follower, sleeper, storage, elements };
}

describe('following a task', () => {
  test('starts from the snapshot, says it is live once the Bureau answers, and passes each element on', async () => {
    const { follower: current, elements } = follow();
    expect(current.state).toBe('connecting');
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    expect(stub?.streams[0]?.lastEventId).toBeNull();

    stub?.streams[0]?.push(snapshotElement('run-1', 'working'));
    await waitFor(() => expect(current.state).toBe('live'));
    stub?.streams[0]?.push(statusElement('run-1', '16', 'input-required'));
    await waitFor(() => expect(elements.map((element) => element.cursor)).toEqual(['-1', '16']));
    expect(current.lastStatus).toBe('input-required');
  });

  test('takes the artifact from the status that carries it, and keeps it', async () => {
    const { follower: current } = follow();
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    const artifact = {
      artifactId: 'run-1:result',
      text: 'Thanks, the release goes to staging.',
      truncated: false,
    };
    stub?.streams[0]?.push(statusElement('run-1', '20', 'completed', { artifact }));
    await waitFor(() => expect(current.artifact).toEqual(artifact));
    // A later status that carries no artifact does not take it away.
    stub?.streams[0]?.push(statusElement('run-1', '21', 'completed'));
    await waitFor(() => expect(current.lastCursor).toBe('21'));
    expect(current.artifact).toEqual(artifact);
  });

  test('applies a resync as a status: a repaired task settles and keeps its answer', async () => {
    const { follower: current, sleeper } = follow();
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    const artifact = { artifactId: 'run-1:result', text: 'Repaired answer', truncated: false };
    stub?.streams[0]?.push(
      statusElement('run-1', '40', 'completed', { kind: 'task.resynced', artifact, revision: 2 }),
    );
    stub?.streams[0]?.end();
    await waitFor(() => expect(current.state).toBe('ended'));
    expect(current.lastStatus).toBe('completed');
    expect(current.lastCursor).toBe('40');
    expect(current.artifact).toEqual(artifact);
    expect(sleeper.pending()).toBe(0);
    expect(stub?.streams.length).toBe(1);
  });

  test('takes the answer of a catalog task from its snapshot', async () => {
    const { follower: current } = follow();
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    const artifact = { artifactId: 'run-1:result', text: 'Catalog answer', truncated: true };
    stub?.streams[0]?.push(snapshotElement('run-1', 'completed', { artifact }));
    await waitFor(() => expect(current.artifact).toEqual(artifact));
  });
});

describe('a stream that drops', () => {
  test('reconnects from the last cursor it was given, after the first backoff', async () => {
    const { follower: current, sleeper } = follow();
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    stub?.streams[0]?.push(snapshotElement('run-1', 'working'));
    stub?.streams[0]?.push(statusElement('run-1', '16', 'working'));
    await waitFor(() => expect(current.lastCursor).toBe('16'));

    stub?.streams[0]?.drop();
    await waitFor(() => expect(current.state).toBe('reconnecting'));
    await waitFor(() => expect(sleeper.pending()).toBe(1));
    expect(sleeper.delays).toEqual([1_000]);
    sleeper.release();

    await waitFor(() => expect(stub?.streams.length).toBe(2));
    expect(stub?.streams[1]?.lastEventId).toBe('16');
    stub?.streams[1]?.push(statusElement('run-1', '17', 'working'));
    await waitFor(() => expect(current.lastCursor).toBe('17'));
    expect(current.state).toBe('live');
  });

  test('never resumes from a snapshot’s cursor, which names no position', async () => {
    const { follower: current, sleeper } = follow();
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    stub?.streams[0]?.push(snapshotElement('run-1', 'working'));
    await waitFor(() => expect(current.state).toBe('live'));
    stub?.streams[0]?.drop();
    await waitFor(() => expect(sleeper.pending()).toBe(1));
    sleeper.release();
    await waitFor(() => expect(stub?.streams.length).toBe(2));
    expect(stub?.streams[1]?.lastEventId).toBeNull();
  });

  test('backs off further while the connection stays down, and starts over once it holds', async () => {
    const { follower: current, sleeper } = follow();
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    stub?.streams[0]?.push(statusElement('run-1', '5', 'working'));
    await waitFor(() => expect(current.lastCursor).toBe('5'));

    stub?.refuseStreams('offline');
    stub?.streams[0]?.drop();
    // Two attempts fail to connect, and the third wait is the one the connection comes back in.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await waitFor(() => expect(sleeper.pending()).toBe(1));
      sleeper.release();
    }
    await waitFor(() => expect(sleeper.pending()).toBe(1));
    expect(sleeper.delays).toEqual([1_000, 2_000, 4_000]);

    stub?.refuseStreams(undefined);
    sleeper.release();
    await waitFor(() => expect(stub?.streams.length).toBe(2));
    expect(stub?.streams[1]?.lastEventId).toBe('5');
    stub?.streams[1]?.push(statusElement('run-1', '6', 'working'));
    await waitFor(() => expect(current.lastCursor).toBe('6'));
    stub?.streams[1]?.drop();
    await waitFor(() => expect(sleeper.pending()).toBe(1));
    expect(sleeper.delays.at(-1)).toBe(1_000);
  });

  test('reconnects at once when the browser says it is back online', async () => {
    const { follower: current, sleeper } = follow();
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    stub?.streams[0]?.push(statusElement('run-1', '5', 'working'));
    await waitFor(() => expect(current.lastCursor).toBe('5'));
    stub?.streams[0]?.drop();
    await waitFor(() => expect(sleeper.pending()).toBe(1));
    window.dispatchEvent(new window.Event('online'));
    await waitFor(() => expect(stub?.streams.length).toBe(2));
  });

  test('asks the page to read the task again when the Bureau reports a gap', async () => {
    const { follower: current, elements } = follow();
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    stub?.streams[0]?.push({
      taskId: 'run-1',
      cursor: '40',
      emittedAtMs: 1,
      kind: 'task.gap',
      requestedCursor: '3',
      firstRetainedCursor: '41',
    });
    await waitFor(() => expect(elements.map((element) => element.kind)).toEqual(['task.gap']));
    expect(current.lastCursor).toBe('40');
  });
});

describe('a stream that ends', () => {
  test('is over after the terminal status, and is not opened again', async () => {
    const { follower: current, sleeper } = follow();
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    stub?.streams[0]?.push(statusElement('run-1', '30', 'completed'));
    stub?.streams[0]?.end();
    await waitFor(() => expect(current.state).toBe('ended'));
    expect(sleeper.pending()).toBe(0);
    expect(stub?.streams.length).toBe(1);
  });

  test('is over when the task was removed', async () => {
    const { follower: current } = follow();
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    stub?.streams[0]?.push({ taskId: 'run-1', cursor: '31', emittedAtMs: 1, kind: 'task.removed' });
    stub?.streams[0]?.end();
    await waitFor(() => expect(current.state).toBe('ended'));
  });

  test('with only a snapshot and no cursor is the end of the stream, to be collected once the task is over', async () => {
    const { follower: current, sleeper } = follow();
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    stub?.streams[0]?.push(snapshotElement('run-1', 'working'));
    await waitFor(() => expect(current.state).toBe('live'));
    stub?.streams[0]?.end();
    await waitFor(() => expect(current.state).toBe('ended'));
    // A task started with `bureau.run()` streams its snapshot alone: nothing here is a drop.
    expect(sleeper.pending()).toBe(0);
    expect(stub?.streams.length).toBe(1);

    // Once the page knows the task is over, one more stream collects the answer.
    current.collect();
    await waitFor(() => expect(stub?.streams.length).toBe(2));
    expect(stub?.streams[1]?.lastEventId).toBeNull();
    stub?.streams[1]?.push(
      snapshotElement('run-1', 'completed', {
        artifact: { artifactId: 'run-1:result', text: 'The answer.', truncated: false },
      }),
    );
    stub?.streams[1]?.end();
    await waitFor(() => expect(current.state).toBe('ended'));
    expect(current.artifact?.text).toBe('The answer.');
    // It is asked for once: it does not become a loop.
    current.collect();
    await quietFor(20);
    expect(stub?.streams.length).toBe(2);
  });

  test('with a cursor, still going, resumes from it after the first backoff step, without a drop', async () => {
    const { follower: current, sleeper } = follow();
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    stub?.streams[0]?.push(snapshotElement('run-1', 'input-required'));
    stub?.streams[0]?.push(statusElement('run-1', '8', 'input-required'));
    await waitFor(() => expect(current.lastCursor).toBe('8'));
    // The Bureau ends every stream at its maximum duration, expecting the client to come back.
    stub?.streams[0]?.end();
    await waitFor(() => expect(sleeper.pending()).toBe(1));
    expect(sleeper.delays).toEqual([1_000]);
    expect(current.state).toBe('live');
    sleeper.release();
    await waitFor(() => expect(stub?.streams.length).toBe(2));
    expect(stub?.streams[1]?.lastEventId).toBe('8');
  });

  test('with a cursor, once it has ended on a terminal status, is not opened again', async () => {
    const { follower: current, sleeper } = follow();
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    stub?.streams[0]?.push(statusElement('run-1', '8', 'working'));
    stub?.streams[0]?.push(statusElement('run-1', '9', 'completed'));
    stub?.streams[0]?.end();
    await waitFor(() => expect(current.state).toBe('ended'));
    expect(sleeper.pending()).toBe(0);
    expect(stub?.streams.length).toBe(1);
  });

  test('says the task was removed, which the page shows as a task that is not there', async () => {
    const { follower: current } = follow();
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    expect(current.removed).toBe(false);
    stub?.streams[0]?.push({ taskId: 'run-1', cursor: '31', emittedAtMs: 1, kind: 'task.removed' });
    await waitFor(() => expect(current.removed).toBe(true));
  });

  test('stops for good when a task is disposed, even while it waits to reconnect', async () => {
    const { follower: current, sleeper } = follow();
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    stub?.streams[0]?.push(statusElement('run-1', '8', 'working'));
    await waitFor(() => expect(current.lastCursor).toBe('8'));
    stub?.streams[0]?.drop();
    await waitFor(() => expect(sleeper.pending()).toBe(1));
    current.dispose();
    sleeper.release();
    await quietFor(20);
    expect(stub?.streams.length).toBe(1);
  });
});

describe('a refused stream', () => {
  test('is not found when the Bureau has no such task, and is not retried', async () => {
    stub?.restore();
    stub = installBureauWorld(emptyBureauWorld({ tasks: [] }));
    const { follower: current, sleeper } = follow();
    await waitFor(() => expect(current.state).toBe('not-found'));
    expect(sleeper.delays).toEqual([]);
  });

  test('is unavailable when the Bureau keeps no history to follow, and is not retried', async () => {
    stub?.refuseStreams(501);
    const { follower: current, sleeper } = follow();
    await waitFor(() => expect(current.state).toBe('unavailable'));
    expect(sleeper.delays).toEqual([]);
  });

  test('is tried again when the Bureau breaks', async () => {
    stub?.refuseStreams(500);
    const { follower: current, sleeper } = follow();
    await waitFor(() => expect(sleeper.pending()).toBe(1));
    expect(current.state).toBe('reconnecting');
  });
});

describe('a reload', () => {
  test('resumes from the cursor the last page kept, and shows the artifact it kept', async () => {
    const storage = memoryStorage();
    const artifact = { artifactId: 'run-1:result', text: 'The answer.', truncated: false };
    const first = follow({ storage });
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    stub?.streams[0]?.push(snapshotElement('run-1', 'working'));
    stub?.streams[0]?.push(statusElement('run-1', '30', 'completed', { artifact }));
    await waitFor(() => expect(first.follower.lastCursor).toBe('30'));
    expect(JSON.parse(storage.getItem(taskCursorKey('run-1')) ?? 'null')).toEqual({
      cursor: '30',
      artifact,
    });
    first.follower.dispose();

    const second = follow({ storage });
    expect(second.follower.lastCursor).toBe('30');
    expect(second.follower.artifact).toEqual(artifact);
    await waitFor(() => expect(stub?.streams.length).toBe(2));
    expect(stub?.streams[1]?.lastEventId).toBe('30');
  });

  test('keeps one task’s cursor apart from another’s', async () => {
    const storage = memoryStorage();
    storage.setItem(taskCursorKey('run-2'), JSON.stringify({ cursor: '99', artifact: null }));
    follow({ storage });
    await waitFor(() => expect(stub?.streams.length).toBe(1));
    expect(stub?.streams[0]?.lastEventId).toBeNull();
  });

  test('ignores what storage holds when it is not a cursor, and when storage cannot be read', async () => {
    const storage = memoryStorage();
    storage.setItem(taskCursorKey('run-1'), '{not json');
    const first = follow({ storage });
    expect(first.follower.lastCursor).toBeUndefined();
    first.follower.dispose();

    const blocked = (): never => {
      throw new Error('blocked');
    };
    const broken: Storage = {
      length: 0,
      clear: blocked,
      getItem: blocked,
      key: blocked,
      removeItem: blocked,
      setItem: blocked,
    };
    const second = follow({ storage: broken });
    await waitFor(() => expect(stub?.streams.length).toBeGreaterThan(1));
    stub?.streams.at(-1)?.push(statusElement('run-1', '4', 'working'));
    await waitFor(() => expect(second.follower.lastCursor).toBe('4'));
  });
});
