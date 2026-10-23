// Chef fetch retry: runs a `git fetch` and repeats it when Git could not lock the remote-tracking
// ref because another process held it. Two worktrees of one repository fetch the same
// `refs/remotes/origin/<branch>`, and a fetch that loses the race fails with `cannot lock ref
// '...': is at X but expected Y` although nothing is wrong, so the failure is transient. Any other
// failure is returned at once, since retrying a network or authentication error only delays it.
//
// This module is a library; it has no command line.

import type { RunnerResult } from './process-runner.ts';

/** How many fetches `fetchWithRetry` makes at most: the first, then two retries. */
export const fetchAttempts = 3;
const baseBackoffMilliseconds = 1_000;
const jitterMilliseconds = 1_000;

export interface FetchRetryDependencies {
  /** Block for `milliseconds`; defaults to `Bun.sleepSync`. */
  sleep?: ((milliseconds: number) => void) | undefined;
  /** A number in [0, 1) that spreads the backoff; defaults to `Math.random`. */
  random?: (() => number) | undefined;
}

/** Whether a failed fetch lost a race for a ref lock, which is worth another try. */
export function isRefLockFailure(result: RunnerResult): boolean {
  return result.code !== 0 && /cannot lock ref/.test(result.stderr);
}

/**
 * Run `fetch` (a function that performs one `git fetch` and returns its result) until it succeeds,
 * fails for a reason other than a ref lock, or has been tried `fetchAttempts` times. Between tries
 * it waits one to two seconds, jittered. The last result is returned either way.
 */
export function fetchWithRetry(
  fetch: () => RunnerResult,
  dependencies: FetchRetryDependencies = {},
): RunnerResult {
  const sleep = dependencies.sleep ?? ((milliseconds) => Bun.sleepSync(milliseconds));
  const random = dependencies.random ?? Math.random;
  let result = fetch();
  for (let attempt = 1; attempt < fetchAttempts && isRefLockFailure(result); attempt += 1) {
    sleep(baseBackoffMilliseconds + Math.floor(random() * jitterMilliseconds));
    result = fetch();
  }
  return result;
}
