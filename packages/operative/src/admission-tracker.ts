import type { GeneratedMediaAdmission } from './generated-media';
import type { CleanupAcknowledgement } from './types';

/**
 * Collects every generated-media admission a run starts, so the run's terminal result and
 * `ActiveRun.closed()` can wait for each to settle (COR-713), as `hookTracker` collects hooks.
 * An admission that is still `pending` when a run ends is exactly the cleanup a run must not
 * report as done.
 */
export interface AdmissionTracker {
  /** Hand every admission a step starts to this; it is the `StepDeps.admissionTracker`. */
  readonly track: (admission: GeneratedMediaAdmission) => void;
  /**
   * How many admissions the run has started. Any at all disqualifies `closed()`'s
   * `not-required` fast path: the run did have an asset operation to acknowledge.
   */
  started(): number;
  /**
   * Waits for every admission to close and folds the answers: `completed` once each has settled
   * as available, rejected or deleted (a failed admission, settled `rejected`, is `completed`),
   * `failed` (with its error) for one that reported a definite failure, `unresolved` with
   * `unknown-effect` for one whose outcome cannot be confirmed. The caller's
   * own `closed({ signal })` bounds the wait; no timer is introduced here.
   */
  settle(): Promise<CleanupAcknowledgement>;
}

export function createAdmissionTracker(): AdmissionTracker {
  const admissions: GeneratedMediaAdmission[] = [];

  return {
    track(admission) {
      admissions.push(admission);
    },
    started: () => admissions.length,
    async settle() {
      let folded: CleanupAcknowledgement = { status: 'completed' };
      // An admission can only be started by a running step, so the list is final once the run's
      // result has settled; the loop still re-reads it in case a late one was tracked. A definite
      // failure is kept as it was reported, with its error, and outranks an outcome that merely
      // did not resolve.
      for (let index = 0; index < admissions.length; index += 1) {
        const acknowledgement = await admissions[index]!.closed();
        if (acknowledgement.status === 'failed') {
          if (folded.status !== 'failed') folded = acknowledgement;
        } else if (
          acknowledgement.status !== 'completed' &&
          acknowledgement.status !== 'not-required' &&
          folded.status !== 'failed'
        ) {
          folded = { status: 'unresolved', reason: 'unknown-effect' };
        }
      }
      return folded;
    },
  };
}
