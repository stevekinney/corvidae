import { describe, expect, test } from 'bun:test';

import { ancestorChain, watchAncestors } from './exit-when-orphaned.ts';

/** A stand-in for the interval: the test runs each check itself. */
function manualChecks(): {
  every: (check: () => void) => () => void;
  run: () => void;
  stopped: () => boolean;
} {
  let current: (() => void) | undefined;
  let stopped = false;
  return {
    every: (check) => {
      current = check;
      return () => {
        stopped = true;
        current = undefined;
      };
    },
    run: () => current?.(),
    stopped: () => stopped,
  };
}

describe('ancestorChain', () => {
  test('lists the ancestors nearest first and stops before pid 1', () => {
    const parents = new Map([
      [40, 30],
      [30, 20],
      [20, 1],
      [1, 0],
    ]);
    expect(ancestorChain(40, parents)).toEqual([30, 20]);
  });

  test('is empty for a process whose parent is already pid 1', () => {
    expect(ancestorChain(40, new Map([[40, 1]]))).toEqual([]);
  });

  test('stops at a cycle in a table read while processes were changing', () => {
    const parents = new Map([
      [40, 30],
      [30, 40],
    ]);
    expect(ancestorChain(40, parents)).toEqual([30]);
  });
});

describe('watchAncestors', () => {
  test('calls onOrphaned once, with the ancestor that is gone, and stops watching', () => {
    const checks = manualChecks();
    const alive = new Set([30, 20]);
    const orphaned: number[] = [];
    watchAncestors({
      ancestors: [30, 20],
      isAlive: (pid) => alive.has(pid),
      every: checks.every,
      onOrphaned: (gone) => orphaned.push(gone),
    });
    checks.run();
    expect(orphaned).toEqual([]);
    // The grandparent: an intermediate shell can outlive the starter that was killed.
    alive.delete(20);
    checks.run();
    checks.run();
    expect(orphaned).toEqual([20]);
    expect(checks.stopped()).toBe(true);
  });

  test('watches nothing when there is no ancestor, as for a server started as a daemon', () => {
    let watching = false;
    const stop = watchAncestors({
      ancestors: [],
      every: () => {
        watching = true;
        return () => {};
      },
      onOrphaned: () => {
        throw new Error('nothing to be orphaned from');
      },
    });
    stop();
    expect(watching).toBe(false);
  });

  test('the returned function stops the watch', () => {
    const checks = manualChecks();
    const orphaned: number[] = [];
    const stop = watchAncestors({
      ancestors: [30],
      isAlive: () => false,
      every: checks.every,
      onOrphaned: (gone) => orphaned.push(gone),
    });
    stop();
    checks.run();
    expect(orphaned).toEqual([]);
  });
});
