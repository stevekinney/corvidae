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
 * `setUp` and `tearDown` bracket every scenario, standing in for `beforeEach` and `afterEach`,
 * which would run too late. `tearDown` runs even when the scenario throws.
 */

import { test } from 'bun:test';
import { outcomeOf, rethrow } from '../module-scope-scenario.test-support.ts';

export interface ScenarioHooks {
  setUp?: () => void | Promise<void>;
  tearDown?: () => void | Promise<void>;
}

export interface Scenarios {
  /** Run `body` now, in order, and register a test called `name` that reports its outcome. */
  scenario(name: string, body: () => unknown): void;
  /** Resolves when every registered scenario has finished. */
  settled(): Promise<void>;
}

export function createScenarios(hooks: ScenarioHooks = {}): Scenarios {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    scenario(name, body) {
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
      test(name, async () => {
        rethrow(await outcome);
      });
    },
    async settled() {
      await chain;
    },
  };
}
