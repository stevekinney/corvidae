/**
 * A crash scenario that boots real processes (a SIGKILLed child and, sometimes, a fresh verifying
 * one) pays process boot, module load, and a real-time claim-lapse wait. That cannot fit Bun's
 * per-test clock on a loaded host, so the scenario runs once at module scope and its test only
 * reports how it went.
 *
 * `settleScenario` captures a scenario's outcome, including the failure of its own assertions, and
 * `expectScenarioPassed` rethrows that failure from the test that names the scenario. Scenarios
 * run one after another: they share a host that is already loaded by the processes they boot.
 *
 * `waitForBureauState` replaces a wall-clock poll with the thing the poll stood in for: it checks
 * the state, and when the state is not yet true it waits for the bureau to say something changed.
 */
import type { Subscription } from '@lostgradient/lifecycle';

import type { Bureau } from '../types';

export interface ScenarioOutcome {
  readonly failed: boolean;
  readonly error?: unknown;
}

/**
 * Runs `run`, capturing its failure. `hangGuardMilliseconds` is the only time bound: it is the
 * per-test timeout the scenario's tests had before they were hoisted, kept solely so a genuine
 * hang fails the scenario instead of stalling the file. It does not bound any wait for a state
 * change, which `waitForBureauState` makes by event.
 */
export async function settleScenario(
  run: () => Promise<void>,
  hangGuardMilliseconds: number,
): Promise<ScenarioOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<ScenarioOutcome>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          failed: true,
          error: new Error(
            `the scenario made no progress within the ${hangGuardMilliseconds}ms hang guard`,
          ),
        }),
      hangGuardMilliseconds,
    );
  });
  const finished = (async (): Promise<ScenarioOutcome> => {
    try {
      await run();
      return { failed: false };
    } catch (error) {
      return { failed: true, error };
    }
  })();
  try {
    return await Promise.race([finished, hang]);
  } finally {
    clearTimeout(timer);
  }
}

export function expectScenarioPassed(outcome: ScenarioOutcome | undefined): void {
  if (outcome === undefined) throw new Error('the scenario never ran');
  if (outcome.failed) throw outcome.error;
}

export interface WaitForBureauStateOptions {
  /**
   * Runs whose liveness snapshots also wake the wait. A run is subscribed once the bureau knows it,
   * so ids may name runs that are only registered later (by recovery, for example).
   */
  readonly runIds?: readonly string[];
  /**
   * An extra source of change the bureau cannot announce, such as a test double being called.
   * Receives `notify` and returns how to stop listening.
   */
  readonly onChange?: (notify: () => void) => () => void;
}

/**
 * Resolves once `check` is true. The current state is checked first; otherwise the wait wakes on
 * whatever the bureaus announce (every live frame, every bureau event, and the liveness snapshots
 * of `runIds`) and checks again. Listeners are attached before the first check, and a
 * notification that arrives while a check is running forces another check, so a transition that
 * happens before or during the wait cannot be missed. For a state with no event of its own, such as
 * `getDurableRun`, the re-check on each announcement is the whole mechanism; no timer is involved.
 */
export async function waitForBureauState(
  bureaus: readonly Bureau[],
  check: () => boolean | Promise<boolean>,
  options: WaitForBureauStateOptions = {},
): Promise<void> {
  let version = 0;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    version += 1;
    wake?.();
  };

  const subscriptions: Array<{ unsubscribe: () => void }> = [];
  const snapshotSubscriptions = new Set<string>();
  const subscribeSnapshots = (): void => {
    for (const [index, bureau] of bureaus.entries()) {
      for (const runId of options.runIds ?? []) {
        const key = `${index}:${runId}`;
        if (snapshotSubscriptions.has(key)) continue;
        try {
          subscriptions.push(bureau.subscribeRunSnapshot(runId, notify));
          snapshotSubscriptions.add(key);
        } catch {
          // The bureau does not know the run yet; the next announcement tries again.
        }
      }
    }
  };

  for (const bureau of bureaus) {
    subscriptions.push({ unsubscribe: bureau.subscribeLiveFrames(notify) });
    const eventSubscription: Subscription = bureau.toObservable().subscribe(notify);
    subscriptions.push(eventSubscription);
  }

  const stopCustom = options.onChange?.(notify);
  try {
    while (true) {
      const seen = version;
      subscribeSnapshots();
      if (await check()) return;
      if (version !== seen) continue;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  } finally {
    stopCustom?.();
    for (const subscription of subscriptions) subscription.unsubscribe();
  }
}
