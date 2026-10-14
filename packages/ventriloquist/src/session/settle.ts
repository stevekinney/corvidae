import type { CleanupOutcome } from '../protocol/messages.ts';
import type { SessionClock } from './session-clock.ts';

/** How one deadline-bounded operation ended. A timeout is not a failure: the operation may still be running. */
export type Settled<Value> =
  | { readonly kind: 'value'; readonly value: Value }
  | { readonly kind: 'rejected'; readonly error: unknown }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'canceled' };

export type Settling<Value> = {
  readonly outcome: Promise<Settled<Value>>;
  /** Stop waiting: clear the deadline timer and settle the outcome as `canceled`. A late result is ignored. */
  cancel(): void;
};

/**
 * Run `operation` and settle with whichever comes first: its result, its rejection (a synchronous
 * throw counts), or the deadline. The returned outcome never rejects, and the deadline timer is
 * always cleared once the outcome is known.
 */
export function settleWithin<Value>(
  clock: SessionClock,
  deadlineMilliseconds: number,
  operation: () => Value | Promise<Value>,
): Settling<Value> {
  let cancel!: () => void;
  const outcome = new Promise<Settled<Value>>((resolve) => {
    const cancelTimer = clock.schedule(() => resolve({ kind: 'timeout' }), deadlineMilliseconds);
    const complete = (result: Settled<Value>): void => {
      cancelTimer();
      resolve(result);
    };
    cancel = () => complete({ kind: 'canceled' });
    try {
      Promise.resolve(operation()).then(
        (value) => complete({ kind: 'value', value }),
        (error: unknown) => complete({ kind: 'rejected', error }),
      );
    } catch (error) {
      complete({ kind: 'rejected', error });
    }
  });
  return { outcome, cancel };
}

/**
 * Report a release step as a cleanup outcome: finishing is `complete`, a rejection proves a
 * resource may remain (`incomplete`), and a step still running at the deadline cannot be
 * observed either way (`unknown`).
 */
export async function settleToOutcome(
  clock: SessionClock,
  deadlineMilliseconds: number,
  operation: () => unknown,
): Promise<CleanupOutcome> {
  const settled = await settleWithin(clock, deadlineMilliseconds, operation).outcome;
  if (settled.kind === 'timeout') return 'unknown';
  return settled.kind === 'rejected' ? 'incomplete' : 'complete';
}

const SEVERITY: Record<CleanupOutcome, number> = { complete: 0, incomplete: 1, unknown: 2 };

/** The least certain of several cleanup outcomes: any unknown wins, then any incomplete. */
export function combineOutcomes(outcomes: readonly CleanupOutcome[]): CleanupOutcome {
  let worst: CleanupOutcome = 'complete';
  for (const outcome of outcomes) {
    if (SEVERITY[outcome] > SEVERITY[worst]) worst = outcome;
  }
  return worst;
}

/** Run `operation` and report whether it finished without throwing or rejecting. It never throws. */
export function attempt(operation: () => unknown): Promise<boolean> {
  try {
    return Promise.resolve(operation()).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}
