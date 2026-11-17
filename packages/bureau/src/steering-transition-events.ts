/**
 * The steering events a Bureau publishes after `steering.accepted` (COR-2097): `steering.rejected`
 * for a command refused at admission, and, for an accepted command, its one terminal event:
 * `steering.applied` when a boundary applied it, `steering.superseded` when a later one replaced
 * it, and `steering.failed` when a deadline, its run or its session ended it. Every command that
 * publishes `steering.accepted` is covered by exactly one terminal event, from exactly one process,
 * after the durable write that decides it (revision 2026-11-16). `steering.applied` names only the
 * session, so one boundary that applies two commands publishes one, covering both.
 *
 * Each is published by the caller that has just committed what it announces, never by a fold. The
 * steering gate moves a command through the same methods whether it is deciding a live request or
 * replaying a log (another process's, or this process's own after a restart), so it cannot tell
 * the two apart and announces nothing itself: it keeps its transitions, and
 * {@link announceSteeringTransitions} reads them where the change has just been written. A caller
 * that is only catching up reads them with `drainTransitions` and drops them.
 *
 * Which process announces, for each way an accepted command ends:
 *
 * - a boundary, a deadline that passed there, the end of a run, and a later command: the process
 *   whose log append committed it (for a durable session), or whose gate decided it (for one with
 *   no log);
 * - a command recorded applied at admission (a duplicate pause, a resume of an unpaused run, a
 *   re-request of the value in force): the admitting process, `steering.applied` right after its
 *   `steering.accepted`, both after the `admit` append;
 * - a durable session's deletion or expiry: the process that drains the session's
 *   `session.deleted` outbox entry, whichever that is, and only when it wins the conditional write
 *   that seals the log, from a fold of the log up to the sealed head
 *   (`announceEndedSessionSteering`). Neither the deleter nor the expirer decides it from its
 *   memory: each releases its runs and stops writing to the log. A process that saw the session gone
 *   never writes to its log again, and a drainer that finds the log sealed stays silent;
 * - a deletion or expiry with no durable log: the deleting or expiring process, from its own gate,
 *   which is the only record.
 *
 * @module steering-transition-events
 */

import {
  SteeringAppliedRecordedEvent,
  SteeringCommandFailedEvent,
  SteeringCommandRejectedEvent,
  SteeringCommandSupersededEvent,
} from './events.ts';
import type {
  BureauSteeringGate,
  SteeringCommandAdmissionOutcome,
  SteeringGateTransition,
} from './steering.ts';

/** Where the events go: the Bureau's emitter. */
export type SteeringEventDispatch = (event: Event) => void;

/**
 * Publishes every command `gate` has moved out of `accepted` since it was last read. Call it
 * synchronously after the live change that moved them, once that change is committed (after a log
 * append resolved, for a durable session).
 */
export function announceSteeringTransitions(
  gate: BureauSteeringGate,
  dispatch: SteeringEventDispatch,
): void {
  announceTransitions(gate.sessionId, gate.drainTransitions(), dispatch);
}

/**
 * Publishes `steering.applied` for commands of `sessionId` that were applied, once the write that
 * applied them committed (COR-2097): a boundary at which `runId` observed them, after its log
 * recorded it, or an admission that recorded a command applied at once. A run observes a version
 * before anything is written, so the run's own event cannot say the command was applied: a drainer
 * that sealed the log first refuses the append, and the one outcome is the drainer's. `runId` is
 * the run whose boundary applied them, or the run an admission bound the command to; empty for a
 * session-scoped command recorded applied at admission, which no run's boundary applied. The feed
 * publishes only the session.
 */
export function announceSteeringApplied(
  sessionId: string,
  runId: string | undefined,
  appliedAt: string,
  dispatch: SteeringEventDispatch,
): void {
  dispatch(
    new SteeringAppliedRecordedEvent({
      sequence: 0,
      runId: runId ?? '',
      type: SteeringAppliedRecordedEvent.type,
      detail: { sessionId },
      timestamp: Date.parse(appliedAt),
    }),
  );
}

/**
 * Publishes `transitions` of the commands of `sessionId`, in order: each failed or superseded
 * command, then one `steering.applied` for the commands the change applied, however many
 * (`steering.applied` names only the session, ruling of 2026-11-16), and none when it applied
 * nothing. One call is one committed change, so it is at most one boundary.
 */
export function announceTransitions(
  sessionId: string,
  transitions: readonly SteeringGateTransition[],
  dispatch: SteeringEventDispatch,
): void {
  let applied: Extract<SteeringGateTransition, { state: 'applied' }> | undefined;
  for (const transition of transitions) {
    if (transition.state === 'applied') {
      applied ??= transition;
      continue;
    }
    const detail = {
      sessionId,
      commandId: transition.commandId,
      failureReason: transition.failureReason,
    };
    dispatch(
      transition.state === 'superseded'
        ? new SteeringCommandSupersededEvent(detail)
        : new SteeringCommandFailedEvent(detail),
    );
  }
  if (applied !== undefined) {
    announceSteeringApplied(sessionId, applied.runId, applied.appliedAt, dispatch);
  }
}

/**
 * Publishes the refusal `outcome` when it is one: a command the gate or admission refused, for the
 * reason the outcome carries. Call it only for a refusal decided now. An answer read back from the
 * log for a retry of a key is the same refusal, and is not announced again.
 */
export function announceSteeringRefusal(
  sessionId: string,
  commandId: string | undefined,
  outcome: SteeringCommandAdmissionOutcome,
  dispatch: SteeringEventDispatch,
): void {
  if (outcome.outcome !== 'rejected') return;
  dispatch(
    new SteeringCommandRejectedEvent({
      sessionId,
      ...(commandId === undefined ? {} : { commandId }),
      failureReason: outcome.failure.reason,
    }),
  );
}
