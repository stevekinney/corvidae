import type { Storage } from '@lostgradient/storage';

type WeftStorage = Storage;

/**
 * Holds the first commit that marks a run's workflow terminal until `release` is called. Every
 * checkpoint write for the run (transcript, step records, cursor) precedes that commit, so a
 * commit that is never released models a process that dies after a run's terminal result was
 * computed but before it was committed: the stored workflow stays running with its failing step
 * already memoized. Releasing it later lets a test attach a subscriber before a replay can settle.
 *
 * Bureau never disposes a `Storage` instance the caller built, so the test that opens one owns
 * closing it. `disposals` counts the closes the wrapper forwards, which lets that test assert it
 * released every handle it opened.
 */
export function holdFirstTerminalRunCommit(storage: WeftStorage): {
  storage: WeftStorage;
  reached: Promise<void>;
  release: () => void;
  disposals: () => number;
} {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markReached: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  let armed = true;
  let disposals = 0;
  const held = new Proxy(storage, {
    get(target, property, receiver) {
      if (property === Symbol.dispose) {
        return () => {
          disposals++;
          target[Symbol.dispose]();
        };
      }
      if (property === 'batch' || property === 'conditionalBatch') {
        const real = (target as unknown as Record<string, unknown>)[property] as (
          ...args: unknown[]
        ) => Promise<unknown>;
        return async (...args: unknown[]) => {
          const operations = (property === 'conditionalBatch' ? args[1] : args[0]) as {
            type: string;
            key: string;
          }[];
          const commitsTerminalRun = operations.some(
            (operation) =>
              operation.type === 'put' && /^wf-terminal:[^:]+:run-/.test(operation.key),
          );
          if (commitsTerminalRun && armed) {
            armed = false;
            markReached();
            await gate;
          }
          return real.apply(target, args);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { storage: held, reached, release, disposals: () => disposals };
}
