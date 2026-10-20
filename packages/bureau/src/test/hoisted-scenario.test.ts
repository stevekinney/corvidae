import { expect, it } from 'bun:test';

import { createBureau } from '../create-bureau';
import { settleScenario, waitForBureauState } from './hoisted-scenario';

it('releases what a hung scenario registered, last first, before it returns', async () => {
  const released: string[] = [];

  const outcome = await settleScenario(async (scope) => {
    scope.onHang(() => released.push('first registered'));
    scope.onHang(async () => {
      released.push('last registered');
      throw new Error('a failing release must not hide the hang');
    });
    await new Promise<never>(() => {});
  }, 10);

  expect(outcome.failed).toBe(true);
  expect((outcome.error as Error).message).toContain('hang guard');
  expect(released).toEqual(['last registered', 'first registered']);
});

it('does not run the releases of a scenario that finishes', async () => {
  let released = false;

  const outcome = await settleScenario(async (scope) => {
    scope.onHang(() => {
      released = true;
    });
  }, 1000);

  expect(outcome.failed).toBe(false);
  expect(released).toBe(false);
});

it('returns after a hang even when a release never settles', async () => {
  let otherReleaseStarted = false;

  const outcome = await settleScenario(async (scope) => {
    scope.onHang(() => {
      otherReleaseStarted = true;
    });
    scope.onHang(() => new Promise<never>(() => {}));
    await new Promise<never>(() => {});
  }, 10);

  expect(outcome.failed).toBe(true);
  expect(otherReleaseStarted).toBe(true);
});

it('names the phase a hung scenario was running and how long each finished phase took', async () => {
  const outcome = await settleScenario(async (scope) => {
    await scope.phase('child exit', async () => {});
    await scope.phase('claim lapse', async () => {});
    await scope.phase('recovery', () => new Promise<never>(() => {}));
  }, 10);

  expect(outcome.failed).toBe(true);
  const message = (outcome.error as Error).message;
  expect(message).toContain('hang guard');
  expect(message).toMatch(/stalled in phase "recovery"/);
  expect(message).toMatch(/child exit \(\d+ms\)/);
  expect(message).toMatch(/claim lapse \(\d+ms\)/);
});

it('says no phase was running when a hung scenario had not entered one', async () => {
  const outcome = await settleScenario(async () => {
    await new Promise<never>(() => {});
  }, 10);

  expect((outcome.error as Error).message).toContain('before its first phase');
});

it('does not name a phase that finished before the hang', async () => {
  const outcome = await settleScenario(async (scope) => {
    await scope.phase('boot', async () => {});
    await new Promise<never>(() => {});
  }, 10);

  const message = (outcome.error as Error).message;
  expect(message).not.toContain('stalled in phase "boot"');
  expect(message).toContain('between phases after "boot"');
});

it('passes a phase result and rejection through unchanged', async () => {
  const failure = new Error('phase failure');
  const outcome = await settleScenario(async (scope) => {
    expect(await scope.phase('first', async () => 7)).toBe(7);
    await scope.phase('second', async () => {
      throw failure;
    });
  }, 1000);

  expect(outcome).toEqual({ failed: true, error: failure });
});

it('names the check and what it last read when a state wait is the stalled phase', async () => {
  const bureau = await createBureau({ agents: {} });
  try {
    let reads = 0;
    const outcome = await settleScenario(async (scope) => {
      await scope.phase('run status', () =>
        waitForBureauState(
          [bureau],
          () => {
            reads += 1;
            return false;
          },
          { scope, label: 'every session run completed', describe: () => `read ${reads} times` },
        ),
      );
    }, 10);

    const message = (outcome.error as Error).message;
    expect(message).toContain('stalled in phase "run status"');
    expect(message).toContain('waiting for "every session run completed"');
    expect(message).toContain('last read: read 1 times');
  } finally {
    await bureau.shutdown();
  }
});

it('reads an asynchronous description of the wait when it reports the hang', async () => {
  const bureau = await createBureau({ agents: {} });
  try {
    const outcome = await settleScenario(async (scope) => {
      await scope.phase('run status', () =>
        waitForBureauState([bureau], () => false, {
          scope,
          label: 'a state',
          describe: async () => 'read from the store',
        }),
      );
    }, 10);

    expect((outcome.error as Error).message).toContain('last read: read from the store');
  } finally {
    await bureau.shutdown();
  }
});

it('reports the hang when the stalled phase finishes while its description is being read', async () => {
  const outcome = await settleScenario(async (scope) => {
    await scope.phase('slow', async () => {
      // The description settles after the guard fires and after the phase itself has finished.
      scope.observe(
        () => new Promise<string>((resolve) => setTimeout(() => resolve('described late'), 60)),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    });
  }, 10);

  expect(outcome.failed).toBe(true);
  expect((outcome.error as Error).message).toMatch(/stalled in phase "slow"/);
});

it('starts the releases when the guard fires, before the hang has been described', async () => {
  const order: string[] = [];
  const outcome = await settleScenario(async (scope) => {
    scope.onHang(() => order.push('released'));
    await scope.phase('stuck', async () => {
      scope.observe(
        () =>
          new Promise<string>((resolve) =>
            setTimeout(() => {
              order.push('described');
              resolve('described late');
            }, 60),
          ),
      );
      await new Promise<never>(() => {});
    });
  }, 10);

  expect(outcome.failed).toBe(true);
  expect(order).toEqual(['released', 'described']);
});
