/**
 * COR-808 — portable scheduling adapters for background compaction.
 *
 * An adapter decides only *when* a queued compaction runs. The portable
 * default rides a zero-delay timer, which Bun, Node, and browsers all have.
 * `requestIdleCallback` is an optional browser adapter: it passes a
 * starvation `timeout` so a never-idle page still runs the task, and on a
 * host without it (Bun and Node today) it falls back to a timer.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, it } from 'bun:test';

import {
  createIdleCompactionSchedule,
  createTimerCompactionSchedule,
  type CompactionScheduleAdapter,
  type IdleCallbackHost,
} from '../src/index';

/** Resolves once the adapter runs a task, so a real-timer test never sleeps a fixed time. */
function ranBy(adapter: CompactionScheduleAdapter): Promise<void> {
  return new Promise<void>((resolve) => {
    adapter.schedule(resolve);
  });
}

type IdleRequest = { readonly callback: () => void; readonly timeout: number | undefined };

function createIdleHost() {
  const requests = new Map<number, IdleRequest>();
  const cancelled: number[] = [];
  let nextHandle = 0;
  const host: IdleCallbackHost = {
    requestIdleCallback(callback, options) {
      nextHandle += 1;
      requests.set(nextHandle, { callback, timeout: options?.timeout });
      return nextHandle;
    },
    cancelIdleCallback(handle) {
      cancelled.push(handle);
      requests.delete(handle);
    },
  };
  return { host, requests, cancelled };
}

describe('createTimerCompactionSchedule', () => {
  it('queues a task behind an injected timer and cancels it by clearing that timer', async () => {
    const runtime = createManualRuntimeServices();
    const adapter = createTimerCompactionSchedule({ timers: runtime.timers, delayMs: 25 });
    const ran: string[] = [];

    adapter.schedule(() => ran.push('first'));
    const cancel = adapter.schedule(() => ran.push('cancelled'));
    expect(runtime.pendingTimers()).toHaveLength(2);

    cancel();
    expect(runtime.pendingTimers()).toHaveLength(1);
    await runtime.advance(24);
    expect(ran).toEqual([]);
    await runtime.advance(1);
    expect(ran).toEqual(['first']);
  });

  it('defaults to a zero-delay timer on the real runtime', async () => {
    const adapter = createTimerCompactionSchedule();
    let ran = false;
    const done = ranBy(adapter).then(() => {
      ran = true;
      return undefined;
    });
    // Never synchronous: the task always waits for a later macrotask.
    expect(ran).toBe(false);
    await done;
    expect(ran).toBe(true);
  });
});

describe('createIdleCompactionSchedule', () => {
  it('asks the host for idle time with a starvation timeout and cancels through the host', () => {
    const { host, requests, cancelled } = createIdleHost();
    const adapter = createIdleCompactionSchedule({ host, timeoutMs: 500 });
    const ran: string[] = [];

    const cancel = adapter.schedule(() => ran.push('idle'));
    expect([...requests.values()].map((request) => request.timeout)).toEqual([500]);

    requests.get(1)!.callback();
    expect(ran).toEqual(['idle']);

    cancel();
    expect(cancelled).toEqual([1]);
  });

  it('bounds idle starvation with a default timeout', () => {
    const { host, requests } = createIdleHost();
    createIdleCompactionSchedule({ host }).schedule(() => undefined);
    expect(requests.get(1)!.timeout).toBe(1000);
  });

  it('falls back to the supplied adapter when the host has no requestIdleCallback', () => {
    const fallbackTasks: (() => void)[] = [];
    const fallback: CompactionScheduleAdapter = {
      schedule(task) {
        fallbackTasks.push(task);
        return () => undefined;
      },
    };
    const partialHost: IdleCallbackHost = { requestIdleCallback: () => 1 };
    const adapter = createIdleCompactionSchedule({ host: partialHost, fallback });
    const ran: string[] = [];

    adapter.schedule(() => ran.push('fallback'));
    expect(fallbackTasks).toHaveLength(1);
    fallbackTasks[0]!();
    expect(ran).toEqual(['fallback']);
  });

  it('falls back to a zero-delay timer on Bun and Node, which have no requestIdleCallback', async () => {
    expect(typeof (globalThis as IdleCallbackHost).requestIdleCallback).toBe('undefined');
    await ranBy(createIdleCompactionSchedule());
  });
});
