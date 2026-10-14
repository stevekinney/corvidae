/**
 * Runs a test scenario at module scope and keeps its outcome for the test that reports it.
 *
 * A test that spawns a real process (`tsc`, a fresh Bun runtime, a SIGKILLed child) pays that
 * process's boot and module load on Bun's five-second per-test clock, and times out when the
 * host is loaded. Awaiting `outcomeOf(scenario)` at module scope runs the same body, assertions
 * included, before any test starts, where no per-test timeout applies. The test then calls
 * {@link rethrow} with the outcome, so a failed assertion still fails under the test that names
 * it, with its original message.
 *
 * Module scope has no per-test timeout, so a scenario whose child never exits would otherwise
 * hold the whole run. {@link SCENARIO_HANG_GUARD_MILLISECONDS} turns that hang into a failure of
 * the scenario's test. It is the largest per-test budget these suites used before hoisting, set
 * far above any healthy run on a loaded host: it detects hangs and is never a performance bound.
 *
 * @example
 * ```ts
 * const compiled = await outcomeOf(async () => {
 *   const exitCode = await Bun.spawn(['bun', tscPath, '--noEmit']).exited;
 *   expect(exitCode).toBe(0);
 * });
 * it('compiles the fixture', () => rethrow(compiled));
 * ```
 */
export const SCENARIO_HANG_GUARD_MILLISECONDS = 120_000;

/** The outcome {@link outcomeOf} records when a scenario does not settle before its hang guard. */
export class ScenarioHangError extends Error {
  constructor(hangGuardMilliseconds: number) {
    super(`scenario did not settle within ${hangGuardMilliseconds} ms; it is hung, not slow`);
    this.name = 'ScenarioHangError';
  }
}

export async function outcomeOf(
  scenario: () => Promise<void>,
  hangGuardMilliseconds = SCENARIO_HANG_GUARD_MILLISECONDS,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<Error>((resolve) => {
    timer = setTimeout(
      () => resolve(new ScenarioHangError(hangGuardMilliseconds)),
      hangGuardMilliseconds,
    );
  });
  try {
    return await Promise.race([
      scenario().then(
        () => undefined,
        (error: unknown) => error ?? new Error('scenario failed'),
      ),
      hang,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Re-throws what {@link outcomeOf} captured; does nothing when the scenario succeeded. */
export function rethrow(outcome: unknown): void {
  if (outcome !== undefined) throw outcome;
}
