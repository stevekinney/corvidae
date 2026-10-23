// Test support for `gate-run.ts`: fake gate children, signal sources and timers, so a test drives
// the interrupt path without starting a real process.

import type { GateChild, GateSignal, SignalSource } from './gate-run.ts';

/** A gate child that has already exited with `code`. */
export function finishedGate(code: number): GateChild {
  return { pid: 4242, exited: Promise.resolve(code) };
}

/** A gate child that exits only when `finish(code)` is called, like a long-running gate. */
export function pendingGate(pid = 4242): GateChild & { finish: (code: number) => void } {
  let finish: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  return { pid, exited, finish };
}

/** A signal source the test can fire by hand. */
export function fakeSignals(): SignalSource & {
  emit: (signal: GateSignal) => void;
  registered: () => number;
} {
  const handlers = new Map<GateSignal, Set<() => void>>();
  return {
    on(signal, handler) {
      const set = handlers.get(signal) ?? new Set<() => void>();
      set.add(handler);
      handlers.set(signal, set);
    },
    off(signal, handler) {
      handlers.get(signal)?.delete(handler);
    },
    emit(signal) {
      for (const handler of handlers.get(signal) ?? []) handler();
    },
    registered() {
      return [...handlers.values()].reduce((total, set) => total + set.size, 0);
    },
  };
}

/** A timer the test fires by hand; `cancelled` says whether the armed callback was cancelled. */
export function manualTimer() {
  const state = {
    armed: undefined as undefined | (() => void),
    milliseconds: undefined as undefined | number,
    cancelled: false,
  };
  return {
    schedule: (callback: () => void, milliseconds: number) => {
      state.armed = callback;
      state.milliseconds = milliseconds;
      return () => {
        state.cancelled = true;
        state.armed = undefined;
      };
    },
    fire: () => state.armed?.(),
    state,
  };
}
