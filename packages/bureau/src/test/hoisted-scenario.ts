/**
 * A crash scenario that boots real processes (a SIGKILLed child and, sometimes, a fresh verifying
 * one) pays process boot, module load, and a real-time claim-lapse wait. That cannot fit Bun's
 * per-test clock on a loaded host, so the scenario runs once at module scope and its test only
 * reports how it went.
 *
 * `settleScenario` captures a scenario's outcome, including the failure of its own assertions, and
 * `expectScenarioPassed` rethrows that failure from the test that names the scenario. Scenarios
 * run one after another: they share a host that is already loaded by the processes they boot.
 */
export interface ScenarioOutcome {
  readonly failed: boolean;
  readonly error?: unknown;
}

export async function settleScenario(run: () => Promise<void>): Promise<ScenarioOutcome> {
  try {
    await run();
    return { failed: false };
  } catch (error) {
    return { failed: true, error };
  }
}

export function expectScenarioPassed(outcome: ScenarioOutcome | undefined): void {
  if (outcome === undefined) throw new Error('the scenario never ran');
  if (outcome.failed) throw outcome.error;
}
