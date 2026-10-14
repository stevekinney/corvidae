import { expect, it } from 'bun:test';

import { settleScenario } from './hoisted-scenario';

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
