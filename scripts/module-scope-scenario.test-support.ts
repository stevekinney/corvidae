/**
 * Helpers for a test whose real child process is the behavior under test.
 *
 * Bun gives every test and hook a five-second clock, and a process started inside one pays its
 * boot on that clock, which a loaded host cannot meet (COR-1392, COR-1503). Such a scenario runs
 * once at module scope, where no per-test timeout applies, through `outcomeOf`. Its test is then
 * `rethrow(outcome)`, so a failed assertion still fails under the test that names it. COR-1507
 * adds the guard that fails a test body or hook that starts a process.
 *
 * Module scope has no per-test timeout, so a scenario whose child never exits would otherwise
 * hold the whole run. `HANG_GUARD_MILLISECONDS` of awake time turns that hang into a failure of
 * the scenario's test; `hang-guard.ts` explains why the guard counts only time the process was
 * awake (COR-1541). It is a uniform hang detector, set far above any healthy run on a loaded host
 * and never a performance bound. A scenario that had a larger budget as a test passes it
 * explicitly: the mirror end-to-end syncs keep their 300 seconds.
 */

import { afterAwakeTime, HANG_GUARD_MILLISECONDS } from './hang-guard.ts';

/** Runs `scenario` and returns what it threw, or `undefined` when it finished. */
export async function outcomeOf(
  scenario: () => unknown,
  hangGuardMilliseconds = HANG_GUARD_MILLISECONDS,
): Promise<unknown> {
  let cancel: (() => void) | undefined;
  const hang = new Promise<Error>((resolve) => {
    cancel = afterAwakeTime(hangGuardMilliseconds, () =>
      resolve(
        new Error(
          `scenario did not settle within ${hangGuardMilliseconds} ms; it is hung, not slow`,
        ),
      ),
    );
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(scenario)
        .then(
          () => undefined,
          (error: unknown) => error ?? new Error('scenario failed'),
        ),
      hang,
    ]);
  } finally {
    cancel?.();
  }
}

/** Rethrows what `outcomeOf` recorded, so the failure surfaces under its own test. */
export function rethrow(outcome: unknown): void {
  if (outcome !== undefined) throw outcome;
}
