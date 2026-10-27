/**
 * Test helper that observes the zero-delay timers other code schedules. Internal — not part of the
 * public package surface.
 */

/** The object whose `setTimeout` and `clearTimeout` are wrapped: `globalThis` or a happy-dom window. */
export interface TimerScope {
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}

/** The handle returned by {@link captureZeroDelayTimers}. */
export interface ZeroDelayTimerCapture {
  /** Resolves once every zero-delay timer scheduled since the capture began has run or been cleared. */
  settled: () => Promise<void>;
  /** Puts the original `setTimeout` and `clearTimeout` back. Call it after `settled`. */
  release: () => void;
}

/**
 * Wrap `scope.setTimeout` (default `globalThis`) so that every timer scheduled with a zero (or missing) delay is also
 * tracked as a promise. `settled()` then waits for exactly those timers, so a test that must observe
 * work a component or Svelte defers to the next task waits on that task itself instead of on a
 * guess about how long the event loop takes. Timers with a real delay are left alone, so a long
 * timer the test expects to be cleared is neither awaited nor fired.
 *
 * Install it after `trackTimers()` and release it before `trackTimers().release()`, because both
 * wrap the same globals.
 */
export function captureZeroDelayTimers(scope: TimerScope = globalThis): ZeroDelayTimerCapture {
  const originalSetTimeout = scope.setTimeout;
  const originalClearTimeout = scope.clearTimeout;
  const pending = new Map<unknown, () => void>();
  const settlements: Promise<void>[] = [];

  scope.setTimeout = new Proxy(originalSetTimeout, {
    apply(target, receiver, arguments_) {
      const handler: unknown = arguments_[0];
      const delay: unknown = arguments_[1];
      if (typeof handler !== 'function' || (delay !== undefined && delay !== 0)) {
        return Reflect.apply(target, receiver, arguments_);
      }
      let finish = (): void => {};
      settlements.push(new Promise<void>((resolve) => (finish = resolve)));
      let identifier: unknown;
      arguments_[0] = (...values: unknown[]) => {
        pending.delete(identifier);
        try {
          Reflect.apply(handler, receiver, values);
        } finally {
          finish();
        }
      };
      identifier = Reflect.apply(target, receiver, arguments_);
      pending.set(identifier, finish);
      return identifier;
    },
  });
  scope.clearTimeout = new Proxy(originalClearTimeout, {
    apply(target, receiver, arguments_) {
      pending.get(arguments_[0])?.();
      pending.delete(arguments_[0]);
      return Reflect.apply(target, receiver, arguments_);
    },
  });

  return {
    settled: async () => {
      // A timer that fires can schedule another, so keep going until a pass finds nothing new.
      for (let settledCount = 0; settledCount < settlements.length;) {
        const batch = settlements.slice(settledCount);
        settledCount += batch.length;
        await Promise.all(batch);
      }
    },
    release: () => {
      scope.setTimeout = originalSetTimeout;
      scope.clearTimeout = originalClearTimeout;
    },
  };
}
