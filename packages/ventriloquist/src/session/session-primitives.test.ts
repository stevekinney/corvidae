import { describe, expect, test } from 'bun:test';

import { createDeferred } from './fixtures/deferred.ts';
import { ManualClock } from './fixtures/manual-clock.ts';
import { OperationQueue } from './operation-queue.ts';
import { OutputBudget } from './output-budget.ts';
import { systemClock } from './session-clock.ts';
import { combineOutcomes, settleToOutcome, settleWithin } from './settle.ts';

describe('OperationQueue', () => {
  test('refuses user operations past its limit and keeps order', () => {
    const queue = new OperationQueue<number>(2, 1);
    expect(queue.offerUser(1)).toBe(true);
    expect(queue.offerUser(2)).toBe(true);
    expect(queue.offerUser(3)).toBe(false);
    expect(queue.userSize).toBe(2);
    expect(queue.take()).toBe(1);
    expect(queue.drain()).toEqual([2]);
    expect(queue.take()).toBeUndefined();
  });

  test('a full user queue never consumes the reserved control capacity', () => {
    const queue = new OperationQueue<number>(1, 2);
    queue.offerUser(1);
    expect(queue.offerUser(2)).toBe(false);
    const first = queue.admitControl();
    const second = queue.admitControl();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(queue.controlAdmitted).toBe(2);
    expect(queue.admitControl()).toBeUndefined();
    first?.();
    first?.();
    expect(queue.controlAdmitted).toBe(1);
    expect(queue.admitControl()).toBeDefined();
  });
});

describe('OutputBudget', () => {
  test('reserves up to its limit and refuses what does not fit without counting it', () => {
    const budget = new OutputBudget(10);
    expect(budget.reserve(6)).toBe(1);
    expect(budget.reserve(5)).toBeUndefined();
    expect(budget.pendingBytes).toBe(6);
    expect(budget.reserve(4)).toBe(2);
    expect(budget.pendingChunks).toBe(2);
  });

  test('accepts empty chunks, which are legal data', () => {
    const budget = new OutputBudget(1);
    expect(budget.reserve(0)).toBe(1);
    expect(budget.release(1)).toBe(true);
  });

  test('releases a chunk once, by identifier', () => {
    const budget = new OutputBudget(10);
    const chunk = budget.reserve(6);
    expect(budget.release(99)).toBe(false);
    expect(budget.release(chunk!)).toBe(true);
    expect(budget.release(chunk!)).toBe(false);
    expect(budget.pendingBytes).toBe(0);
  });

  test('a cumulative count releases only whole chunks it reaches', () => {
    const budget = new OutputBudget(100);
    budget.reserve(10);
    budget.reserve(10);
    budget.reserve(10);
    expect(budget.releaseThrough(9)).toBe(0);
    expect(budget.releaseThrough(20)).toBe(2);
    expect(budget.releaseThrough(20)).toBe(0);
    expect(budget.pendingBytes).toBe(10);
    expect(budget.releaseThrough(30)).toBe(1);
  });

  test('offsets keep counting accepted bytes after a chunk was released by identifier', () => {
    const budget = new OutputBudget(100);
    budget.reserve(10);
    const second = budget.reserve(10);
    budget.reserve(10);
    budget.release(second!);
    expect(budget.releaseThrough(30)).toBe(2);
  });
});

describe('settleWithin', () => {
  test('reports a value and clears its timer', async () => {
    const clock = new ManualClock();
    const settled = await settleWithin(clock, 100, () => 7).outcome;
    expect(settled).toEqual({ kind: 'value', value: 7 });
    expect(clock.pendingTimers).toBe(0);
  });

  test('reports a rejection and a synchronous throw as rejected', async () => {
    const clock = new ManualClock();
    const rejected = await settleWithin(clock, 100, () => Promise.reject(new Error('no'))).outcome;
    expect(rejected.kind).toBe('rejected');
    const thrown = await settleWithin(clock, 100, () => {
      throw new Error('sync');
    }).outcome;
    expect(thrown.kind).toBe('rejected');
    expect(clock.pendingTimers).toBe(0);
  });

  test('times out at the deadline and ignores a result that arrives later', async () => {
    const clock = new ManualClock();
    const barrier = createDeferred<number>();
    const settling = settleWithin(clock, 100, () => barrier.promise);
    clock.advance(99);
    clock.advance(1);
    expect(await settling.outcome).toEqual({ kind: 'timeout' });
    barrier.resolve(1);
    expect(await settling.outcome).toEqual({ kind: 'timeout' });
  });

  test('cancel stops waiting and clears the timer', async () => {
    const clock = new ManualClock();
    const settling = settleWithin(clock, 100, () => new Promise<void>(() => undefined));
    settling.cancel();
    expect(await settling.outcome).toEqual({ kind: 'canceled' });
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('cleanup outcomes', () => {
  test('a release step maps finish, rejection and a missed deadline', async () => {
    const clock = new ManualClock();
    expect(await settleToOutcome(clock, 10, () => undefined)).toBe('complete');
    expect(await settleToOutcome(clock, 10, () => Promise.reject(new Error('x')))).toBe(
      'incomplete',
    );
    const hanging = settleToOutcome(clock, 10, () => new Promise(() => undefined));
    clock.advance(10);
    expect(await hanging).toBe('unknown');
  });

  test('the least certain outcome wins', () => {
    expect(combineOutcomes([])).toBe('complete');
    expect(combineOutcomes(['complete', 'incomplete'])).toBe('incomplete');
    expect(combineOutcomes(['incomplete', 'unknown', 'complete'])).toBe('unknown');
    expect(combineOutcomes(['unknown', 'incomplete'])).toBe('unknown');
  });
});

describe('ManualClock', () => {
  test('runs due timers in time then schedule order, including ones scheduled meanwhile', () => {
    const clock = new ManualClock();
    const order: string[] = [];
    clock.schedule(() => order.push('b'), 20);
    clock.schedule(() => {
      order.push('a');
      clock.schedule(() => order.push('a2'), 5);
    }, 10);
    clock.schedule(() => order.push('b2'), 20);
    clock.advance(10);
    expect(order).toEqual(['a']);
    expect(clock.now).toBe(10);
    clock.advance(10);
    expect(order).toEqual(['a', 'a2', 'b', 'b2']);
    expect(clock.pendingTimers).toBe(0);
  });

  test('a canceled timer never runs', () => {
    const clock = new ManualClock();
    let ran = false;
    const cancel = clock.schedule(() => {
      ran = true;
    }, 5);
    cancel();
    clock.advance(10);
    expect(ran).toBe(false);
  });
});

describe('systemClock', () => {
  test('runs a scheduled callback and does not run a canceled one', async () => {
    const fired = createDeferred<void>();
    systemClock.schedule(() => fired.resolve(), 0);
    let canceledRan = false;
    const cancel = systemClock.schedule(() => {
      canceledRan = true;
    }, 0);
    cancel();
    await fired.promise;
    expect(canceledRan).toBe(false);
  });
});
