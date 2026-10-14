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
 * @example
 * ```ts
 * const compiled = await outcomeOf(async () => {
 *   const exitCode = await Bun.spawn(['bun', tscPath, '--noEmit']).exited;
 *   expect(exitCode).toBe(0);
 * });
 * it('compiles the fixture', () => rethrow(compiled));
 * ```
 */
export async function outcomeOf(scenario: () => Promise<void>): Promise<unknown> {
  try {
    await scenario();
    return undefined;
  } catch (error) {
    return error ?? new Error('scenario failed');
  }
}

/** Re-throws what {@link outcomeOf} captured; does nothing when the scenario succeeded. */
export function rethrow(outcome: unknown): void {
  if (outcome !== undefined) throw outcome;
}
