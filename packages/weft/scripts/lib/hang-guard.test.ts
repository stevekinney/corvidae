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
  const child = spawnWithHangGuard(['sleep', '30'], { hangGuardMilliseconds: 100 });
  await child.exited;
  expect(child.signalCode).toBe('SIGTERM');
});
describe('the hang guard in Weft’s copy', () => {
  it('kills a child that outlives its guard', () => rethrow(killsAHungChild));

  it('resumes ticking when fake timers end before the budget is spent', async () => {
    let fake = true;
    const started = performance.now();
    // The first tick, at 10 ms, finds fake timers and stops. They end at 20 ms, so the backstop
    // at 40 ms finds real timers and no tick running, and resumes ticking until the budget is spent.
    const fired = new Promise<number>((resolve) =>
      afterAwakeTime(40, () => resolve(performance.now() - started), {
        tickMilliseconds: 10,
        fakeTimersActive: () => fake,
      }),
    );
    await Bun.sleep(20);
    fake = false;
    // Resumed ticks credit nothing for the stopped stretch, so the budget is spent after the backstop.
    expect(await fired).toBeGreaterThan(40);
  });
});
