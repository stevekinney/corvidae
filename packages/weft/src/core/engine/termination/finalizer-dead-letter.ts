/**
 * Dead-letter paths that never run the finalizer: the recorded resource state is gone, or
 * every attempt was spent by a crashed host (COR-1422). Split from `./finalizer.ts` to keep
 * that module under the size budget.
 *
 * @module core/engine/termination/finalizer-dead-letter
 */

import { WorkflowTeardownEvent } from '../../events.ts';
import type { WorkflowState } from '../../types.ts';
import type { EngineInternals } from '../internals.ts';
import { deadLetterTeardown, type TeardownHold } from './finalizer-claim.ts';

type FinalizerDriveCallbacks = { dispatchEvent: (event: Event) => void };

/**
 * Dead-letter a teardown without running the finalizer: its recorded state is gone, or its
 * attempts were all consumed by crashes. Conditioned on `expected` so a concurrent settle is
 * never overwritten; the event is emitted only after the durable record commits.
 */
export async function deadLetterWithoutRunning(
  internals: EngineInternals,
  workflowId: string,
  state: WorkflowState,
  attempts: number,
  expected: TeardownHold,
  lastError: string,
  finalizerInput: unknown,
  callbacks: FinalizerDriveCallbacks,
): Promise<void> {
  const settled = await deadLetterTeardown(
    internals,
    workflowId,
    state.type,
    attempts,
    expected,
    { lastError, finalizerInput },
    state.workflowExecutionToken,
    state.revision,
  );
  if (settled) {
    // The event's `error` is present for every 'failed'/'dead-lettered' status (the
    // documented contract). Carry the same reason the dead-letter record stores so the
    // event stream is consistent with the attempt-exhausted dead-letter path.
    callbacks.dispatchEvent(
      new WorkflowTeardownEvent(workflowId, state.type, 'dead-lettered', attempts, lastError),
    );
  }
}
