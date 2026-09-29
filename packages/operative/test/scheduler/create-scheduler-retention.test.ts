import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTestToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createScheduler } from '../../src/scheduler/create-scheduler';
import { TaskRetentionCleanedEvent } from '../../src/scheduler/events';
import { SchedulerTaskLookupError } from '../../src/scheduler/task-lookup-error';
import type { SchedulerPriority, SchedulerTask } from '../../src/scheduler/types';
import { createMockGenerate } from '../../src/test/index';
import type { GenerateFunction, GenerateResponse } from '../../src/types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

let nextTaskId = 0;

function makeTask(
  overrides: Partial<SchedulerTask> & { priority: SchedulerPriority },
): SchedulerTask {
  return {
    id: `retention-task-${(nextTaskId++).toString(36)}`,
    createRun: () => ({
      generate: createMockGenerate([textResponse('done')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
    }),
    ...overrides,
  };
}

/** A generate function that blocks until the test releases it. */
function createGate(): { generate: GenerateFunction; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const generate: GenerateFunction = async () => {
    await gate;
    return textResponse('gated');
  };
  return { generate, release };
}

function gatedTask(
  gate: ReturnType<typeof createGate>,
  overrides: Partial<SchedulerTask> = {},
): SchedulerTask {
  return makeTask({
    priority: 'immediate',
    createRun: () => ({
      generate: gate.generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      maximumSteps: 1,
    }),
    ...overrides,
  });
}

function failingTask(error: Error): SchedulerTask {
  return makeTask({
    priority: 'immediate',
    createRun: () => {
      throw error;
    },
  });
}

async function drain(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) {
    await yieldToPortableEventLoop();
  }
}

const EVENT_LOOP_POLL_MAX_ATTEMPTS = 200;
async function waitForEventLoop(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < EVENT_LOOP_POLL_MAX_ATTEMPTS; attempt++) {
    if (predicate()) return;
    await yieldToPortableEventLoop();
  }
  throw new Error('waitForEventLoop exceeded its attempt bound before the condition held');
}

function createTrackedScheduler(retentionWindowMs?: number) {
  const runtime = createManualRuntimeServices();
  const scheduler = createScheduler({
    generate: createMockGenerate([textResponse('default')]),
    toolbox: createTestToolbox([]),
    idleDelay: 5,
    runtime,
    ...(retentionWindowMs === undefined ? {} : { retentionWindowMs }),
  });
  const cleaned: { taskId: string; outcome: string }[] = [];
  scheduler.addEventListener(TaskRetentionCleanedEvent.type, (event) => {
    cleaned.push({ taskId: event.taskId, outcome: event.outcome });
  });
  return { runtime, scheduler, cleaned };
}

/** Retains a terminal `null` outcome on a never-started scheduler. */
function retainByCancelling(scheduler: ReturnType<typeof createScheduler>, id: string): void {
  void scheduler.submit(makeTask({ priority: 'background', id }));
  expect(scheduler.cancel(id)).toBe(true);
}

function trackSettled(promise: Promise<unknown>): { settled: boolean } {
  const flag = { settled: false };
  void promise.then(
    () => {
      flag.settled = true;
    },
    () => {
      flag.settled = true;
    },
  );
  return flag;
}

describe('createScheduler retention', () => {
  it('retains outcomes indefinitely when retentionWindowMs is unset', async () => {
    const { runtime, scheduler, cleaned } = createTrackedScheduler();
    retainByCancelling(scheduler, 'unset-window');

    expect(runtime.pendingTimers()).toEqual([]);
    await runtime.advance(1e12);

    expect(scheduler.locateTask('unset-window')).toEqual({
      status: 'terminal',
      outcome: { status: 'fulfilled', value: null },
    });
    expect(runtime.pendingTimers()).toEqual([]);
    expect(cleaned).toEqual([]);
  });

  it('arms at most one timer per retained id across the entry and tombstone lifetimes', async () => {
    const window = 100;
    const { runtime, scheduler } = createTrackedScheduler(window);
    const ids = ['a', 'b', 'c', 'd'];
    const expectedDueAt: number[] = [];
    for (const id of ids) {
      retainByCancelling(scheduler, id);
      expectedDueAt.push(runtime.monotonic.now() + window);
      await runtime.advance(1);
    }

    expect(runtime.pendingTimers().map((timer) => timer.dueAt)).toEqual(expectedDueAt);

    // Resubmitting a retained id cancels its old timer.
    void scheduler.submit(makeTask({ priority: 'background', id: 'a' }));
    expect(runtime.pendingTimers()).toHaveLength(ids.length - 1);
    expect(scheduler.locateTask('a')).toEqual({ status: 'in-progress' });

    await runtime.advance(window);
    const tombstoneTimers = runtime.pendingTimers();
    expect(tombstoneTimers).toHaveLength(ids.length - 1);
    expect(tombstoneTimers.map((timer) => timer.dueAt)).toEqual(
      expectedDueAt.slice(1).map((dueAt) => dueAt + window),
    );

    await runtime.advance(window);
    expect(runtime.pendingTimers()).toEqual([]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects retentionWindowMs of %p',
    (value) => {
      expect(() =>
        createScheduler({
          generate: createMockGenerate([textResponse('x')]),
          toolbox: createTestToolbox([]),
          retentionWindowMs: value,
        }),
      ).toThrow('retentionWindowMs');
    },
  );

  it('accepts a positive finite retentionWindowMs', () => {
    expect(() =>
      createScheduler({
        generate: createMockGenerate([textResponse('x')]),
        toolbox: createTestToolbox([]),
        retentionWindowMs: 1,
      }),
    ).not.toThrow();
  });

  describe('locateTask', () => {
    it('reports in-progress while queued and running, then terminal', async () => {
      const { scheduler } = createTrackedScheduler();
      const gate = createGate();
      const task = gatedTask(gate);
      const promise = scheduler.submit(task);
      expect(scheduler.locateTask(task.id)).toEqual({ status: 'in-progress' });

      scheduler.start();
      await waitForEventLoop(() => scheduler.getState().activeTask?.id === task.id);
      expect(scheduler.locateTask(task.id)).toEqual({ status: 'in-progress' });

      gate.release();
      const result = await promise;
      expect(scheduler.locateTask(task.id)).toEqual({
        status: 'terminal',
        outcome: { status: 'fulfilled', value: result },
      });
      await scheduler.stop();
    });

    it('reports in-progress for a task requeued after preemption', async () => {
      // Real runtime: the requeued task waits out idleDelay before redispatch.
      const scheduler = createScheduler({
        generate: createMockGenerate([textResponse('default')]),
        toolbox: createTestToolbox([]),
        idleDelay: 1,
      });
      const gate = createGate();
      let calls = 0;
      const background = makeTask({
        priority: 'background',
        requeue: true,
        createRun: () => {
          calls++;
          return {
            generate: calls === 1 ? gate.generate : createMockGenerate([textResponse('again')]),
            toolbox: createTestToolbox([]),
            conversation: new Conversation(),
            maximumSteps: 1,
          };
        },
      });
      scheduler.start();
      const backgroundPromise = scheduler.submit(background);
      await waitForEventLoop(() => scheduler.getState().activeTask?.id === background.id);

      const immediate = scheduler.submitImmediate(() => ({
        generate: createMockGenerate([textResponse('imm')]),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        maximumSteps: 1,
      }));
      gate.release();
      await immediate;
      expect(scheduler.locateTask(background.id)).toEqual({ status: 'in-progress' });

      const result = await backgroundPromise;
      expect(result?.content).toBe('again');
      expect(scheduler.locateTask(background.id)).toEqual({
        status: 'terminal',
        outcome: { status: 'fulfilled', value: result },
      });
      await scheduler.stop();
    });

    it('records cancelled and stop-discarded tasks as fulfilled null', async () => {
      const { scheduler } = createTrackedScheduler();
      retainByCancelling(scheduler, 'cancelled');
      expect(scheduler.locateTask('cancelled')).toEqual({
        status: 'terminal',
        outcome: { status: 'fulfilled', value: null },
      });

      const started = createTrackedScheduler();
      const gate = createGate();
      started.scheduler.start();
      const running = gatedTask(gate);
      void started.scheduler.submit(running);
      await waitForEventLoop(() => started.scheduler.getState().activeTask?.id === running.id);
      const queued = makeTask({ priority: 'background' });
      const queuedPromise = started.scheduler.submit(queued);
      const stopPromise = started.scheduler.stop();
      gate.release();
      await stopPromise;
      expect(await queuedPromise).toBeNull();
    });

    it('records a rejected outcome with the original reason when createRun throws', async () => {
      const { scheduler } = createTrackedScheduler();
      scheduler.start();
      const boom = new Error('factory failed');
      const task = failingTask(boom);
      await scheduler.submit(task).catch(() => undefined);

      expect(scheduler.locateTask(task.id)).toEqual({
        status: 'terminal',
        outcome: { status: 'rejected', reason: boom },
      });
      await scheduler.stop();
    });

    it('reports not-found for unknown ids and dispatch() ids', async () => {
      const { runtime, scheduler } = createTrackedScheduler();
      scheduler.start();
      expect(scheduler.locateTask('never-submitted')).toEqual({ status: 'not-found' });

      // dispatch() mints its id from the runtime's `task` counter.
      const dispatchedId = `${runtime.identifierPrefix}-task-1`;
      const { result } = scheduler.dispatch(() => ({
        generate: createMockGenerate([textResponse('dispatched')]),
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        maximumSteps: 1,
      }));
      await result;
      expect(scheduler.locateTask(dispatchedId)).toEqual({ status: 'not-found' });
      await scheduler.stop();
    });
  });

  describe('awaitTask', () => {
    it('waits for an in-progress task through its taskId alone', async () => {
      const { scheduler } = createTrackedScheduler();
      scheduler.start();
      const gate = createGate();
      const task = gatedTask(gate);
      void scheduler.submit(task);

      const waiter = scheduler.awaitTask(task.id);
      const flag = trackSettled(waiter);
      await drain();
      expect(flag.settled).toBe(false);

      gate.release();
      const result = await waiter;
      expect(result?.content).toBe('gated');
      await scheduler.stop();
    });

    it('settles immediately for a retained terminal id', async () => {
      const { scheduler } = createTrackedScheduler();
      scheduler.start();
      const task = makeTask({ priority: 'immediate' });
      const result = await scheduler.submit(task);
      expect(await scheduler.awaitTask(task.id)).toBe(result);
      await scheduler.stop();
    });

    it('rejects with the original error for a failed task, before and after settlement', async () => {
      const { scheduler } = createTrackedScheduler();
      scheduler.start();
      const boom = new Error('factory failed');
      const gate = createGate();
      const task = gatedTask(gate, {
        createRun: () => {
          throw boom;
        },
      });
      const submitted = scheduler.submit(task);
      const early = scheduler.awaitTask(task.id);
      await submitted.catch(() => undefined);
      await expect(early).rejects.toBe(boom);
      await expect(scheduler.awaitTask(task.id)).rejects.toBe(boom);
      await scheduler.stop();
    });

    it('rejects with SchedulerTaskLookupError for expired and never-submitted ids', async () => {
      const { runtime, scheduler } = createTrackedScheduler(50);
      retainByCancelling(scheduler, 'soon-expired');
      await runtime.advance(50);

      const expired = await scheduler.awaitTask('soon-expired').catch((error: unknown) => error);
      expect(expired).toBeInstanceOf(SchedulerTaskLookupError);
      expect(expired).toMatchObject({ taskId: 'soon-expired', reason: 'expired' });

      const missing = await scheduler.awaitTask('nope').catch((error: unknown) => error);
      expect(missing).toBeInstanceOf(SchedulerTaskLookupError);
      expect(missing).toMatchObject({ taskId: 'nope', reason: 'not-found' });
    });

    it('delivers the outcome to a waiter before the retention window elapses', async () => {
      const { runtime, scheduler } = createTrackedScheduler(50);
      scheduler.start();
      const gate = createGate();
      const task = gatedTask(gate);
      void scheduler.submit(task);
      const waiter = scheduler.awaitTask(task.id);
      gate.release();
      const result = await waiter;
      expect(result?.content).toBe('gated');

      await runtime.advance(50);
      expect(scheduler.locateTask(task.id)).toEqual({ status: 'expired' });
      await scheduler.stop();
    });
  });

  it('walks terminal, expired, and not-found on the manual clock with an inclusive boundary', async () => {
    const window = 100;
    const { runtime, scheduler, cleaned } = createTrackedScheduler(window);
    retainByCancelling(scheduler, 'lifetime');

    await runtime.advance(window - 1);
    expect(scheduler.locateTask('lifetime').status).toBe('terminal');
    expect(cleaned).toEqual([]);

    await runtime.advance(1);
    expect(cleaned).toEqual([{ taskId: 'lifetime', outcome: 'completed' }]);
    expect(scheduler.locateTask('lifetime')).toEqual({ status: 'expired' });
    expect(scheduler.locateTask('other')).toEqual({ status: 'not-found' });

    await runtime.advance(window);
    expect(scheduler.locateTask('lifetime')).toEqual({ status: 'not-found' });
    expect(cleaned).toHaveLength(1);
  });

  it('replaces a retained entry or tombstone on resubmission without the old timer evicting it', async () => {
    const window = 100;
    const { runtime, scheduler, cleaned } = createTrackedScheduler(window);
    retainByCancelling(scheduler, 'tomb');
    await runtime.advance(window);
    expect(scheduler.locateTask('tomb')).toEqual({ status: 'expired' });
    retainByCancelling(scheduler, 'entry');
    expect(scheduler.locateTask('entry').status).toBe('terminal');

    void scheduler.submit(makeTask({ priority: 'background', id: 'tomb' }));
    void scheduler.submit(makeTask({ priority: 'background', id: 'entry' }));
    expect(scheduler.locateTask('tomb')).toEqual({ status: 'in-progress' });
    expect(scheduler.locateTask('entry')).toEqual({ status: 'in-progress' });

    await runtime.advance(window * 3);
    expect(scheduler.locateTask('tomb')).toEqual({ status: 'in-progress' });
    expect(scheduler.locateTask('entry')).toEqual({ status: 'in-progress' });
    expect(cleaned.map((event) => event.taskId)).toEqual(['tomb']);
  });

  it('settles both waiters with the one settlement when a duplicate active id is submitted', async () => {
    const { scheduler } = createTrackedScheduler();
    scheduler.start();
    const gate = createGate();
    const first = gatedTask(gate, { id: 'duplicate' });
    const firstPromise = scheduler.submit(first);
    const firstFlag = trackSettled(firstPromise);
    const before = scheduler.awaitTask('duplicate');
    const second = gatedTask(gate, { id: 'duplicate' });
    void scheduler.submit(second);
    const after = scheduler.awaitTask('duplicate');

    gate.release();
    const [beforeResult, afterResult] = await Promise.all([before, after]);
    expect(beforeResult?.content).toBe('gated');
    expect(afterResult).toBe(beforeResult);
    expect(scheduler.locateTask('duplicate')).toEqual({
      status: 'terminal',
      outcome: { status: 'fulfilled', value: beforeResult },
    });
    await drain();
    expect(firstFlag.settled).toBe(false);
    await scheduler.stop();
  });

  describe('stop()', () => {
    it('purges retention state on a started scheduler and settles pending waiters with null', async () => {
      const { runtime, scheduler, cleaned } = createTrackedScheduler(50);
      scheduler.start();
      const done = makeTask({ priority: 'immediate' });
      await scheduler.submit(done);
      const gate = createGate();
      const blocked = gatedTask(gate);
      void scheduler.submit(blocked);
      await waitForEventLoop(() => scheduler.getState().activeTask?.id === blocked.id);
      retainByCancelling(scheduler, 'to-expire');
      await runtime.advance(50);
      expect(scheduler.locateTask('to-expire').status).toBe('expired');
      expect(scheduler.locateTask(done.id).status).toBe('expired');
      retainByCancelling(scheduler, 'still-terminal');
      expect(scheduler.locateTask('still-terminal').status).toBe('terminal');
      const cleanedBeforeStop = cleaned.length;
      const waiter = scheduler.awaitTask(blocked.id);

      const stopPromise = scheduler.stop();
      gate.release();
      await stopPromise;

      expect(await waiter).toBeNull();
      expect(runtime.pendingTimers()).toEqual([]);
      for (const id of [done.id, 'to-expire', 'still-terminal', blocked.id]) {
        expect(scheduler.locateTask(id)).toEqual({ status: 'not-found' });
      }
      expect(cleaned).toHaveLength(cleanedBeforeStop);
    });

    it('purges only retention state on a never-started scheduler', async () => {
      const { runtime, scheduler, cleaned } = createTrackedScheduler(50);
      retainByCancelling(scheduler, 'cancelled');
      expect(runtime.pendingTimers()).toHaveLength(1);
      const queued = makeTask({ priority: 'background', id: 'still-queued' });
      const queuedPromise = scheduler.submit(queued);
      const queuedFlag = trackSettled(queuedPromise);
      const waiter = scheduler.awaitTask('still-queued');
      const waiterFlag = trackSettled(waiter);

      await scheduler.stop();
      await drain();

      expect(runtime.pendingTimers()).toEqual([]);
      expect(scheduler.locateTask('cancelled')).toEqual({ status: 'not-found' });
      expect(cleaned).toEqual([]);
      expect(scheduler.locateTask('still-queued')).toEqual({ status: 'in-progress' });
      expect(queuedFlag.settled).toBe(false);
      expect(waiterFlag.settled).toBe(false);
    });
  });

  describe('unhandled rejections', () => {
    async function collectUnhandled(body: () => Promise<void>): Promise<unknown[]> {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        await body();
        await drain();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
      return unhandled;
    }

    it('does not raise when a swallowed rejected submit is never located or awaited', async () => {
      const { scheduler } = createTrackedScheduler();
      scheduler.start();
      const task = failingTask(new Error('swallowed'));
      const unhandled = await collectUnhandled(async () => {
        scheduler.submit(task).catch(() => undefined);
        await waitForEventLoop(() => scheduler.locateTask(task.id).status === 'terminal');
      });
      expect(unhandled).toEqual([]);
      expect(scheduler.locateTask(task.id)).toMatchObject({
        status: 'terminal',
        outcome: { status: 'rejected' },
      });
      await scheduler.stop();
    });

    it('does not raise for unobserved awaitTask promises on rejected and expired ids', async () => {
      const { runtime, scheduler } = createTrackedScheduler(50);
      scheduler.start();
      const task = failingTask(new Error('unobserved'));
      retainByCancelling(scheduler, 'expiring');
      await runtime.advance(50);
      const unhandled = await collectUnhandled(async () => {
        scheduler.submit(task).catch(() => undefined);
        await waitForEventLoop(() => scheduler.locateTask(task.id).status === 'terminal');
        void scheduler.awaitTask(task.id);
        void scheduler.awaitTask('expiring');
        void scheduler.awaitTask('unknown');
      });
      expect(unhandled).toEqual([]);
      await scheduler.stop();
    });
  });
});
