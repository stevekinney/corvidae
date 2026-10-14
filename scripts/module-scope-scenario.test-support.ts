/**
 * Helpers for a test whose real child process is the behavior under test.
 *
 * Bun gives every test and hook a five-second clock, and a process started inside one pays its
 * boot on that clock, which a loaded host cannot meet (COR-1392, COR-1503). Such a scenario runs
 * once at module scope, where no per-test timeout applies, through `outcomeOf`. Its test is then
 * `rethrow(outcome)`, so a failed assertion still fails under the test that names it.
 * `scripts/check-test-process-spawns.ts` fails a test body or hook that starts a process.
 */

/** Runs `scenario` and returns what it threw, or `undefined` when it finished. */
export async function outcomeOf(scenario: () => unknown): Promise<unknown> {
  try {
    await scenario();
    return undefined;
  } catch (error) {
    return error ?? new Error('scenario failed');
  }
}

/** Rethrows what `outcomeOf` recorded, so the failure surfaces under its own test. */
export function rethrow(outcome: unknown): void {
  if (outcome !== undefined) throw outcome;
}
