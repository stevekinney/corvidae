import { describe, expect, it } from 'bun:test';

import { outcomeOf, rethrow } from '../../src/testing/module-scope-scenario.test-support.ts';
import { afterAwakeTime, spawnWithHangGuard } from './hang-guard.ts';

/**
 * Weft runs its own copy of `@lostgradient/testing`'s hang guard (`scripts/check-test-support-copies.ts`
 * keeps them equal), and Weft's coverage gate measures the copy, so the two paths Weft's own tests
 * never take are exercised here: a child that outlives its guard is killed, and fake timers that stop
 * the ticks end before the budget is spent, so the real backstop resumes ticking instead of reporting
 * a hang. The package's own suite covers the rest.
 */

// A real child process, so it runs once at module scope, off Bun's per-test clock.
const killsAHungChild = await outcomeOf(async () => {
  // hang-guard-self-test: the guard under test is the thing being proven to fire, so its budget is the subject
  const child = spawnWithHangGuard(['sleep', '30'], { hangGuardMilliseconds: 100 });
  await child.exited;
  expect(child.signalCode).toBe('SIGTERM');
});
describe('the hang guard in Weft’s copy', () => {
  it('kills a child that outlives its guard', () => rethrow(killsAHungChild));

  it('resumes ticking when fake timers end before the budget is spent', async () => {
    // Fake timers are reported on the first look only: the first tick, at 10 ms, finds them and
    // stops, so the backstop at 40 ms finds real timers and no tick running, and resumes ticking
    // until the budget is spent. Counting looks, not milliseconds, keeps the order of the two
    // independent of how late a loaded host runs either timer.
    let looks = 0;
    const started = performance.now();
    // hang-guard-self-test: the guard under test is the thing being proven to fire, so its budget is the subject
    const fired = new Promise<number>((resolve) =>
      afterAwakeTime(40, () => resolve(performance.now() - started), {
        tickMilliseconds: 10,
        fakeTimersActive: () => ++looks === 1,
      }),
    );
    // Resumed ticks credit nothing for the stopped stretch, so the budget is spent after the backstop.
    expect(await fired).toBeGreaterThan(40);
  });
});
