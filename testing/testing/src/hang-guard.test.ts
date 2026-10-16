import { describe, expect, it } from 'bun:test';

import { afterAwakeTime, runWithHangGuard, spawnWithHangGuard } from './hang-guard.ts';
import { outcomeOf, rethrow } from './helpers/module-scope-outcome.ts';

/** Resolves with the real milliseconds until `afterAwakeTime` fired, or `undefined` if it had not by `within`. */
function firedWithin(
  milliseconds: number,
  within: number,
  options: Parameters<typeof afterAwakeTime>[2],
): Promise<number | undefined> {
  const started = performance.now();
  return new Promise((resolve) => {
    const cancel = afterAwakeTime(
      milliseconds,
      () => {
        clearTimeout(limit);
        resolve(performance.now() - started);
      },
      options,
    );
    const limit = setTimeout(() => {
      cancel();
      resolve(undefined);
    }, within);
  });
}

describe('afterAwakeTime', () => {
  it('fires once the budget of steady ticks is spent', async () => {
    const fired = await firedWithin(100, 2_000, { tickMilliseconds: 10 });
    expect(fired).toBeGreaterThanOrEqual(100);
  });

  it('credits a gap the process did not live through as one tick', async () => {
    // The injected clock jumps ten minutes on its second reading, as it does across a system
    // sleep. The budget is 200 ms of 10 ms ticks, so a clock-based guard would fire at the jump.
    let readings = 0;
    const now = (): number => performance.now() + (++readings >= 2 ? 600_000 : 0);
    expect(await firedWithin(200, 120, { tickMilliseconds: 10, now })).toBeUndefined();
    readings = 0;
    expect(await firedWithin(200, 2_000, { tickMilliseconds: 10, now })).toBeGreaterThanOrEqual(
      190,
    );
  });

  it('falls back to its real backstop at the full budget while fake timers are active', async () => {
    // Fake timers freeze the clock, so no tick can credit anything. The backstop still fires.
    const frozen = performance.now();
    const fired = await firedWithin(100, 2_000, {
      tickMilliseconds: 10,
      now: () => frozen,
      fakeTimersActive: () => true,
    });
    expect(fired).toBeGreaterThanOrEqual(100);
  });

  it('resumes ticking when fake timers end before the budget is spent', async () => {
    let fake = true;
    setTimeout(() => (fake = false), 30);
    const fired = await firedWithin(100, 2_000, {
      tickMilliseconds: 10,
      fakeTimersActive: () => fake,
    });
    expect(fired).toBeGreaterThanOrEqual(100);
  });

  it('keeps its ticks out of a leak tracker that wraps the global setTimeout', async () => {
    // Ventriloquist's conformance cells and `trackTimers` count what the global schedules while
    // the code under test runs; a guard ticking through it was reported as that code's leak.
    const original = globalThis.setTimeout;
    let scheduled = 0;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      scheduled += 1;
      return original(...args);
    }) as typeof setTimeout;
    try {
      let fired = false;
      afterAwakeTime(30, () => (fired = true), { tickMilliseconds: 5 });
      while (!fired) await Bun.sleep(5);
    } finally {
      globalThis.setTimeout = original;
    }
    expect(scheduled).toBe(0);
  });

  it('never fires once cancelled', async () => {
    let fired = false;
    const cancel = afterAwakeTime(20, () => (fired = true), { tickMilliseconds: 5 });
    cancel();
    await Bun.sleep(60);
    expect(fired).toBe(false);
  });
});

// Each process scenario runs once at module scope, off Bun's per-test clock.
const killsAHungChild = await outcomeOf(async () => {
  const child = spawnWithHangGuard(['sleep', '30'], { hangGuardMilliseconds: 200 });
  expect(await child.exited).not.toBe(0);
  expect(child.signalCode).toBe('SIGTERM');
});

const usesTheKillSignal = await outcomeOf(async () => {
  const child = spawnWithHangGuard(['sleep', '30'], {
    hangGuardMilliseconds: 200,
    killSignal: 'SIGKILL',
  });
  await child.exited;
  expect(child.signalCode).toBe('SIGKILL');
});

const leavesAFinishedChildAlone = await outcomeOf(async () => {
  const result = await runWithHangGuard(['sh', '-c', 'printf out; printf err >&2; exit 3']);
  expect(result).toMatchObject({ exitCode: 3, signalCode: null, success: false });
  expect(result.stdout.toString()).toBe('out');
  expect(result.stderr.toString()).toBe('err');
});

describe('spawnWithHangGuard', () => {
  it('kills a child that outlives its guard with SIGTERM', () => rethrow(killsAHungChild));
  it('kills with the given killSignal', () => rethrow(usesTheKillSignal));
});

describe('runWithHangGuard', () => {
  it('resolves with the exit status and both streams', () => rethrow(leavesAFinishedChildAlone));
});
