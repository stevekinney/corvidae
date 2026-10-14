/**
 * Run a whole test body at module scope, where Bun applies no per-test timeout, and rethrow its
 * outcome from the test that names it. For bodies that start a real process (git, a fresh Bun,
 * server-side rendering): the process boots off the five-second clock, yet a failed assertion
 * still fails under the test that owns it.
 */
export async function outcomeOf(scenario: () => Promise<void> | void): Promise<unknown> {
  try {
    await scenario();
    return undefined;
  } catch (error) {
    return error ?? new Error('scenario failed');
  }
}

/** Rethrow what `outcomeOf` recorded; returns normally when the scenario passed. */
export function rethrow(outcome: unknown): void {
  if (outcome !== undefined) throw outcome;
}
