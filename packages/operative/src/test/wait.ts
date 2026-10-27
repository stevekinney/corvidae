import { yieldToPortableEventLoop } from '@lostgradient/weft';

/**
 * The most awake time a wait spends before it gives up on a condition that never comes, in
 * milliseconds. The same number as `HANG_GUARD_MILLISECONDS` in `@lostgradient/testing`, which this
 * module cannot import because it ships with the package (a test pins them equal). It is a hang
 * guard, not a performance bound: far above any healthy run on a loaded host.
 */
export const WAIT_HANG_GUARD_MILLISECONDS = 120_000;

// The longest one turn can credit, so a gap the process did not live through (the host asleep, the
// process stopped) counts as one turn rather than as hung time.
const LONGEST_TURN_MILLISECONDS = 1_000;

/** What {@link waitForCondition} can be told besides the condition and its failure message. */
export interface WaitForConditionOptions {
  /** Hands control back between checks. Defaults to one portable event-loop turn. */
  yieldTurn?: () => Promise<void>;
  /** Awake time after which the wait fails. Only a test of the guard itself shortens it. */
  hangGuardMilliseconds?: number;
}

/**
 * Checks `condition` between event-loop turns until it holds. Each yield also drains Weft's
 * deferred inline-launch queue (its `setTimeout(0)` starts) so durable runs can advance.
 *
 * The wait ends on the condition, never on a count of turns: how many turns a round trip takes
 * depends on how busy the host is, so a turn cap fails healthy runs on a loaded machine. Its only
 * deadline is the awake-time hang guard, which credits each turn with the time it actually took,
 * capped at one second, so a hung condition still fails and a slow host never does.
 *
 * Throws with `failureMessage` when the condition is not met within the hang guard.
 */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  failureMessage: string,
  options: WaitForConditionOptions = {},
): Promise<void> {
  const {
    yieldTurn = yieldToPortableEventLoop,
    hangGuardMilliseconds = WAIT_HANG_GUARD_MILLISECONDS,
  } = options;
  let credited = 0;
  let last = performance.now();
  while (!(await condition())) {
    if (credited >= hangGuardMilliseconds) {
      throw new Error(failureMessage);
    }
    await yieldTurn();
    const now = performance.now();
    credited += Math.min(Math.max(0, now - last), LONGEST_TURN_MILLISECONDS);
    last = now;
  }
}

/**
 * A minimal interface for any run-store-like object that can look up a run by
 * id. Works with both the operative `Store` and the gateway `Bureau`.
 */
export interface RunLookup {
  getRun(id: string): { status: string } | undefined;
}

/**
 * Waits until `store.getRun(runId)` satisfies `predicate`, defaulting to
 * waiting for any non-`running` status. Returns the settled run state. `options`
 * are {@link waitForCondition}'s.
 *
 * Works with any object that exposes `getRun(id): { status: string } | undefined`
 * — operative's `Store` and gateway's `Bureau` both qualify structurally.
 */
export async function waitForRunState<R extends { status: string }>(
  store: { getRun(id: string): R | undefined },
  runId: string,
  predicate: (run: R) => boolean = (run) => run.status !== 'running',
  options: WaitForConditionOptions = {},
): Promise<R> {
  let matchingRun: R | undefined;
  await waitForCondition(
    () => {
      const run = store.getRun(runId);
      if (run && predicate(run)) {
        matchingRun = run;
        return true;
      }
      return false;
    },
    `Run ${runId} did not reach the expected state`,
    options,
  );

  return matchingRun!;
}
