/**
 * The development host's rebuild queue (`rebuild-scheduler.ts`): one build at a time, a change
 * during a build queues one follow-up, a failed intermediate build is repaired by the follow-up,
 * and closing cancels a pending rebuild.
 */
import { expect, test } from 'bun:test';

import { quietFor } from '@lostgradient/testing/wait-until';
import { createRebuildScheduler } from './rebuild-scheduler.ts';

function deferred() {
  let settle!: () => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, resolve: settle, reject: fail };
}

async function rejection(promise: Promise<void>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject.');
}

test('a rebuild requested during a build queues one follow-up compilation', async () => {
  const first = deferred();
  let builds = 0;
  const scheduler = createRebuildScheduler({
    delayMilliseconds: 0,
    build: async () => {
      builds += 1;
      if (builds === 1) await first.promise;
    },
  });

  const active = scheduler.run();
  expect(builds).toBe(1);
  const queued = scheduler.run();
  const queuedAgain = scheduler.run();
  expect(builds).toBe(1);
  first.resolve();
  await active;
  await queued;
  await queuedAgain;

  expect(builds).toBe(2);
});

test('a queued compilation repairs a build that failed while the tree was changing', async () => {
  const first = deferred();
  let builds = 0;
  const scheduler = createRebuildScheduler({
    delayMilliseconds: 0,
    build: async () => {
      builds += 1;
      if (builds === 1) await first.promise;
    },
  });

  const active = scheduler.run();
  const queued = scheduler.run();
  first.reject(new Error('intermediate build failed'));
  await active;
  await queued;

  expect(builds).toBe(2);
});

test('the newest failure is the one reported when the repair also fails', async () => {
  const first = deferred();
  const newest = new Error('newest build failed');
  let builds = 0;
  const scheduler = createRebuildScheduler({
    delayMilliseconds: 0,
    build: async () => {
      builds += 1;
      if (builds === 1) await first.promise;
      else throw newest;
    },
  });

  const active = scheduler.run();
  const queued = scheduler.run();
  first.reject(new Error('intermediate build failed'));

  expect(await rejection(active)).toBe(newest);
  expect(await rejection(queued)).toBe(newest);
  expect(builds).toBe(2);
});

test('a failed build leaves the scheduler able to build again', async () => {
  let builds = 0;
  const scheduler = createRebuildScheduler({
    delayMilliseconds: 0,
    build: async () => {
      builds += 1;
      if (builds === 1) throw new Error('first build failed');
    },
  });

  await rejection(scheduler.run());
  await scheduler.run();

  expect(builds).toBe(2);
});

test('closing clears a pending debounced rebuild before it can run', async () => {
  let builds = 0;
  const scheduler = createRebuildScheduler({
    delayMilliseconds: 10,
    build: async () => {
      builds += 1;
    },
  });

  scheduler.schedule();
  scheduler.close();
  await quietFor(60);

  expect(builds).toBe(0);
});

test('one save is one build, and a failed scheduled rebuild is reported', async () => {
  const failures: unknown[] = [];
  const failure = new Error('rebuild failed');
  const reported = deferred();
  let builds = 0;
  const scheduler = createRebuildScheduler({
    delayMilliseconds: 10,
    build: async () => {
      builds += 1;
      throw failure;
    },
    onFailure: (error) => {
      failures.push(error);
      reported.resolve();
    },
  });

  scheduler.schedule();
  scheduler.schedule();
  scheduler.schedule();
  await reported.promise;
  scheduler.close();

  expect(builds).toBe(1);
  expect(failures).toEqual([failure]);
});

test('a successful scheduled rebuild is announced', async () => {
  const announced = deferred();
  const scheduler = createRebuildScheduler({
    delayMilliseconds: 0,
    build: async () => {},
    onRebuilt: announced.resolve,
  });

  scheduler.schedule();
  await announced.promise;
  scheduler.close();
});
