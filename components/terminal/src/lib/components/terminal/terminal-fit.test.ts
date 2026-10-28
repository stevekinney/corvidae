import { afterEach, describe, expect, test } from 'bun:test';

import { quietFor } from '@lostgradient/testing/wait-until';
import { SCROLLBACK_LINES } from './terminal-engine-adapter.ts';
import {
  MAXIMUM_RETAINED_TERMINAL_CELLS,
  createFitCoordinator,
  sameGeometry,
  scheduleFitOnNextFrame,
  validateGeometry,
  type FitScheduler,
} from './terminal-fit.ts';
import type { TerminalGeometry } from './terminal.types.ts';

/** A scheduler whose pending frame runs only when the test says so. */
function manualScheduler() {
  const pending: Array<() => void> = [];
  let scheduled = 0;
  let cancelled = 0;
  const schedule: FitScheduler = (callback) => {
    scheduled += 1;
    pending.push(callback);
    return () => {
      cancelled += 1;
      pending.splice(pending.indexOf(callback), 1);
    };
  };
  return {
    schedule,
    flush() {
      for (const callback of pending.splice(0)) callback();
    },
    get scheduled() {
      return scheduled;
    },
    get cancelled() {
      return cancelled;
    },
    get pending() {
      return pending.length;
    },
  };
}

function harness(measurements: Array<{ columns?: unknown; rows?: unknown } | undefined>) {
  const frames = manualScheduler();
  const applied: TerminalGeometry[] = [];
  const accepted: TerminalGeometry[] = [];
  let measured = 0;
  let next = 0;
  const coordinator = createFitCoordinator({
    schedule: frames.schedule,
    measure: () => {
      measured += 1;
      const measurement = measurements[Math.min(next, measurements.length - 1)];
      next += 1;
      return measurement;
    },
    apply: (geometry) => applied.push(geometry),
    accept: (geometry) => accepted.push(geometry),
  });
  return {
    coordinator,
    frames,
    applied,
    accepted,
    get measured() {
      return measured;
    },
  };
}

describe('the retained cell budget', () => {
  test('refuses a geometry whose retained buffer would exceed the budget, though each dimension is valid', () => {
    expect(validateGeometry({ columns: 65_535, rows: 65_535 })).toBeUndefined();
    expect(validateGeometry({ columns: 65_535, rows: 1 })).toBeUndefined();
    expect(validateGeometry({ columns: 5_000, rows: 5_000 })).toBeUndefined();
  });

  test('accepts the largest geometry that fits, and refuses one more column', () => {
    const rows = 24;
    const columns = Math.floor(MAXIMUM_RETAINED_TERMINAL_CELLS / (rows + SCROLLBACK_LINES));
    expect(validateGeometry({ columns, rows })).toEqual({ columns, rows });
    expect(validateGeometry({ columns: columns + 1, rows })).toBeUndefined();
  });

  test('never reaches the engine: an oversized measurement is neither applied nor reported', () => {
    const applied: TerminalGeometry[] = [];
    const accepted: TerminalGeometry[] = [];
    let flush: (() => void) | undefined;
    const coordinator = createFitCoordinator({
      measure: () => ({ columns: 65_535, rows: 65_535 }),
      apply: (geometry) => applied.push(geometry),
      accept: (geometry) => accepted.push(geometry),
      schedule: (callback) => {
        flush = callback;
        return () => {};
      },
    });
    coordinator.request();
    flush?.();
    expect(applied).toEqual([]);
    expect(accepted).toEqual([]);
  });
});

describe('validateGeometry', () => {
  test('keeps positive whole dimensions', () => {
    expect(validateGeometry({ columns: 80, rows: 24 })).toEqual({ columns: 80, rows: 24 });
    expect(validateGeometry({ columns: 1, rows: 65_535 })).toEqual({ columns: 1, rows: 65_535 });
  });

  test.each([
    ['nothing', undefined],
    ['zero columns', { columns: 0, rows: 24 }],
    ['zero rows', { columns: 80, rows: 0 }],
    ['negative', { columns: -1, rows: 24 }],
    ['fractional', { columns: 80.5, rows: 24 }],
    ['NaN', { columns: Number.NaN, rows: 24 }],
    ['infinite', { columns: 80, rows: Number.POSITIVE_INFINITY }],
    ['beyond the wire schema', { columns: 65_536, rows: 24 }],
    ['text', { columns: '80', rows: 24 }],
    ['missing rows', { columns: 80 }],
  ])('rejects %s without inventing a dimension', (_name, candidate) => {
    expect(validateGeometry(candidate)).toBeUndefined();
  });

  test('compares both dimensions', () => {
    expect(sameGeometry({ columns: 80, rows: 24 }, { columns: 80, rows: 24 })).toBe(true);
    expect(sameGeometry({ columns: 80, rows: 24 }, { columns: 81, rows: 24 })).toBe(false);
    expect(sameGeometry({ columns: 80, rows: 24 }, { columns: 80, rows: 25 })).toBe(false);
  });
});

describe('createFitCoordinator', () => {
  test('collapses a resize storm into one measurement and one effective resize', () => {
    const fit = harness([{ columns: 100, rows: 30 }]);
    for (let signal = 0; signal < 500; signal += 1) fit.coordinator.request();
    expect(fit.frames.scheduled).toBe(1);
    expect(fit.measured).toBe(0);
    fit.frames.flush();
    expect(fit.measured).toBe(1);
    expect(fit.applied).toEqual([{ columns: 100, rows: 30 }]);
    expect(fit.accepted).toEqual([{ columns: 100, rows: 30 }]);
    expect(fit.coordinator.accepted).toEqual({ columns: 100, rows: 30 });
  });

  test('reports a repeated geometry once however often it is measured', () => {
    const { coordinator, frames, accepted } = harness([{ columns: 100, rows: 30 }]);
    for (let round = 0; round < 5; round += 1) {
      coordinator.request();
      frames.flush();
    }
    expect(accepted).toHaveLength(1);
  });

  test('reports each new geometry once and never a stale one', () => {
    const { coordinator, frames, accepted } = harness([
      { columns: 100, rows: 30 },
      { columns: 120, rows: 30 },
      { columns: 120, rows: 30 },
      { columns: 100, rows: 30 },
    ]);
    for (let round = 0; round < 4; round += 1) {
      coordinator.request();
      frames.flush();
    }
    expect(accepted).toEqual([
      { columns: 100, rows: 30 },
      { columns: 120, rows: 30 },
      { columns: 100, rows: 30 },
    ]);
  });

  test('a hidden or zero-size container pauses fitting and sends nothing', () => {
    const { coordinator, frames, applied, accepted } = harness([
      undefined,
      { columns: 0, rows: 0 },
      { columns: Number.NaN, rows: Number.NaN },
    ]);
    for (let round = 0; round < 3; round += 1) {
      coordinator.request();
      frames.flush();
    }
    expect(applied).toEqual([]);
    expect(accepted).toEqual([]);
    expect(coordinator.accepted).toBeUndefined();
  });

  test('keeps the last accepted geometry through a hidden stretch and does not repeat it on return', () => {
    const { coordinator, frames, accepted } = harness([
      { columns: 100, rows: 30 },
      undefined,
      { columns: 100, rows: 30 },
      { columns: 90, rows: 30 },
    ]);
    for (let round = 0; round < 4; round += 1) {
      coordinator.request();
      frames.flush();
    }
    expect(accepted).toEqual([
      { columns: 100, rows: 30 },
      { columns: 90, rows: 30 },
    ]);
  });

  test('applies the engine resize before reporting to the host', () => {
    const order: string[] = [];
    const frames = manualScheduler();
    const coordinator = createFitCoordinator({
      schedule: frames.schedule,
      measure: () => ({ columns: 10, rows: 5 }),
      apply: () => order.push('apply'),
      accept: () => order.push('accept'),
    });
    coordinator.request();
    frames.flush();
    expect(order).toEqual(['apply', 'accept']);
  });

  test('dispose cancels the pending measurement and ignores later requests', () => {
    const { coordinator, frames, accepted } = harness([{ columns: 100, rows: 30 }]);
    coordinator.request();
    coordinator.dispose();
    expect(frames.cancelled).toBe(1);
    expect(frames.pending).toBe(0);
    coordinator.request();
    frames.flush();
    expect(frames.scheduled).toBe(1);
    expect(accepted).toEqual([]);
  });

  test('dispose is safe with nothing pending, and twice', () => {
    const { coordinator, frames } = harness([{ columns: 1, rows: 1 }]);
    coordinator.dispose();
    coordinator.dispose();
    expect(frames.cancelled).toBe(0);
  });
});

describe('scheduleFitOnNextFrame', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  test('uses the animation frame when one exists, and cancels it', () => {
    const callbacks = new Map<number, () => void>();
    let handle = 0;
    globalThis.requestAnimationFrame = ((callback: () => void) => {
      handle += 1;
      callbacks.set(handle, callback);
      return handle;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (id: number) => {
      callbacks.delete(id);
    };
    let ran = 0;
    const cancel = scheduleFitOnNextFrame(() => {
      ran += 1;
    });
    expect(callbacks.size).toBe(1);
    cancel();
    expect(callbacks.size).toBe(0);
    scheduleFitOnNextFrame(() => {
      ran += 1;
    });
    for (const callback of callbacks.values()) callback();
    expect(ran).toBe(1);
  });

  test('falls back to a task where animation frames do not exist', async () => {
    // @ts-expect-error -- simulate a runtime without animation frames
    globalThis.requestAnimationFrame = undefined;
    let ran = 0;
    scheduleFitOnNextFrame(() => {
      ran += 1;
    });
    const cancel = scheduleFitOnNextFrame(() => {
      ran += 100;
    });
    cancel();
    await quietFor(5);
    expect(ran).toBe(1);
  });
});

describe('FitCoordinator.invalidate', () => {
  test('makes the next valid measurement apply and report again, even when equal', () => {
    const { coordinator, frames, applied, accepted } = harness([{ columns: 100, rows: 30 }]);
    coordinator.request();
    frames.flush();
    coordinator.invalidate();
    expect(coordinator.accepted).toBeUndefined();
    coordinator.request();
    frames.flush();
    expect(applied).toHaveLength(2);
    expect(accepted).toHaveLength(2);
  });
});
