import { yieldToPortableEventLoop } from '@lostgradient/weft';

/**
 * How long a wait keeps polling, at least, before it gives up. It sits under Bun's 5 s test
 * timeout, so it raises no budget: a wait that would pass is no slower, and one that fails reports
 * its own message instead of a bare timeout.
 */
export const MINIMUM_WAIT_MILLISECONDS = 3_000;

/**
 * Polls `condition`, yielding one macrotask between tries. Each yield also
 * drains Weft's deferred inline-launch queue (its `setTimeout(0)` starts) so
 * durable runs can advance.
 *
 * A yield is not a unit of time: a message-channel turn can finish in
 * microseconds, so a run that needs a timer, a thread-pool result, or disk I/O
 * (all slower under host load) can outlast any fixed count of them. The wait
 * therefore gives up only once `maximumAttempts` tries have passed and
 * `minimumWaitMilliseconds` (default {@link MINIMUM_WAIT_MILLISECONDS}; pass 0 for a wait that is
 * meant to fail fast) has elapsed, so the count never decides
 * the outcome on a loaded host.
 *
 * Throws with `failureMessage` when the condition is not met within the limit.
 */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  failureMessage: string,
  maximumAttempts = 50,
  yieldTurn: () => Promise<void> = yieldToPortableEventLoop,
  minimumWaitMilliseconds = MINIMUM_WAIT_MILLISECONDS,
): Promise<void> {
  const startedAt = performance.now();
  for (let attempt = 0; ; attempt++) {
    if (await condition()) {
      return;
    }
    if (
      attempt + 1 >= maximumAttempts &&
      performance.now() - startedAt >= minimumWaitMilliseconds
    ) {
      break;
    }
    await yieldTurn();
  }

  throw new Error(failureMessage);
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
 * waiting for any non-`running` status. Returns the settled run state.
 *
 * Works with any object that exposes `getRun(id): { status: string } | undefined`
 * — operative's `Store` and gateway's `Bureau` both qualify structurally.
 */
export async function waitForRunState<R extends { status: string }>(
  store: { getRun(id: string): R | undefined },
  runId: string,
  predicate: (run: R) => boolean = (run) => run.status !== 'running',
  minimumWaitMilliseconds = MINIMUM_WAIT_MILLISECONDS,
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
    undefined,
    undefined,
    minimumWaitMilliseconds,
  );

  return matchingRun!;
}
