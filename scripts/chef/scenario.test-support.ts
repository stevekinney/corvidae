/**
 * Registers tests whose body starts real processes (`git`, `sleep`, a `bun` child) without
 * putting those processes on Bun's five-second per-test clock.
 *
 * A scenario runs once, in order, while its test file loads; its test then only rethrows what
 * the scenario threw (`scripts/module-scope-scenario.test-support.ts` explains the pattern and
 * `scripts/check-test-process-spawns.ts` enforces it). The file ends with
 * `await scenarios.settled()`, so every scenario has finished before the first test runs and no
 * test waits on another's turn. Scenarios share one host's process table, so they never overlap.
 *
 * `scenario()` must be called while the file loads, before `await scenarios.settled()`. Bun runs
 * a `describe` callback after the module has finished evaluating, so a scenario registered there
 * would start after `settled()` had already waited on an empty chain, and would then run beside
 * its own test on Bun's five-second clock, where an overrun kills its child. A `scenario()` call
 * after `settled()` therefore throws. To group scenarios, use `scenarios.describe`, which runs its
 * callback at once and registers the real `describe` with the matching tests.
 *
 * `setUp` and `tearDown` bracket every scenario, standing in for `beforeEach` and `afterEach`,
 * which would run too late. `tearDown` runs even when the scenario throws.
 */

import { describe as bunDescribe, test as bunTest } from 'bun:test';
import { outcomeOf, rethrow } from '../module-scope-scenario.test-support.ts';

export interface ScenarioHooks {
  setUp?: () => void | Promise<void>;
  tearDown?: () => void | Promise<void>;
}

/** The two `bun:test` registrars a scenario set uses; tests of this module substitute stubs. */
export interface ScenarioRegistrar {
  test(name: string, body: () => Promise<void>): void;
  describe(name: string, body: () => void): void;
}

export interface Scenarios {
  /**
   * Run `body` now, in order, and register a test called `name` that reports its outcome. Throws
   * once `settled()` has been called: register scenarios at module scope.
   */
  scenario(name: string, body: () => unknown): void;
  /**
   * Group scenarios under a `describe`. `define` runs immediately, at module scope, so the
   * scenarios it registers start now; the tests are registered inside the real `describe`.
   */
  describe(name: string, define: () => void): void;
  /** Resolves when every registered scenario has finished. Closes registration. */
  settled(): Promise<void>;
}

export const lateRegistrationMessage = (name: string): string =>
  `scenario "${name}" was registered after settled() was called. Scenarios run while the file ` +
  'loads, so register them at module scope, before `await scenarios.settled()`, and never ' +
  'inside a bun:test `describe` or `test` callback (Bun runs those after the module has ' +
  'evaluated, so the scenario would run on the five-second test clock). Use `scenarios.describe` ' +
  'to group them.';

export function createScenarios(
  hooks: ScenarioHooks = {},
  registrar: ScenarioRegistrar = { test: bunTest, describe: bunDescribe },
): Scenarios {
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;
  // Registrations of the `scenarios.describe` being defined; empty-handed at the top level.
  let group: Array<() => void> | undefined;
  return {
    scenario(name, body) {
      if (closed) throw new Error(lateRegistrationMessage(name));
      const outcome = chain.then(async () => {
        await hooks.setUp?.();
        try {
          return await outcomeOf(body);
        } finally {
          await hooks.tearDown?.();
        }
      });
      // A failed `setUp` or `tearDown` rejects `outcome`; keep the chain going and fail the test.
      chain = outcome.catch(() => undefined);
      const register = () =>
        registrar.test(name, async () => {
          rethrow(await outcome);
        });
      if (group) group.push(register);
      else register();
    },
    describe(name, define) {
      const outer = group;
      const registrations: Array<() => void> = [];
      group = registrations;
      try {
        define();
      } finally {
        group = outer;
      }
      const register = () =>
        registrar.describe(name, () => {
          for (const registration of registrations) registration();
        });
      if (outer) outer.push(register);
      else register();
    },
    async settled() {
      closed = true;
      await chain;
    },
  };
}
