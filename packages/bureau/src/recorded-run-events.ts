/**
 * The run events a Bureau publishes from what a run records (COR-2096): `run.tripwire`,
 * `run.guardrail`, `budget.threshold`, `tool.policy-denied` and `tool.error`; and (COR-2097) the
 * four `multiagent.child-workflow.*` events, `multiagent.handoff.occurred` and `hook-plan.failed`.
 * `steering.applied` is not among them: a run observes the version it applied, but the steering log
 * decides whether the command was applied at all, so the event is published by the append that
 * recorded it (`bureau-seams/steering-log.ts`).
 *
 * The operative store records every event of a run as an `Action` whose `type` is the event's type
 * and whose `detail` is the event's own fields, so one function turns a recorded action into the
 * Bureau event that wraps it ({@link recordedRunEvent}) and the store's `'action'` subscription calls
 * it for every run in the store. A run that is not in the store (a child run, a goal attempt or a
 * workflow step, each dispatched with the id its owner recorded) has no action to read, so
 * {@link observeRecordedRunEvents} builds the same action from the event as the run fires it.
 *
 * Nothing here publishes content: the feed's projection of each event reads only the identity of the
 * guardrail, the tool and the call, the numbers, and an error code.
 *
 * @module recorded-run-events
 */

import type { Action, ActiveRun } from '@lostgradient/operative';

import {
  BudgetThresholdRecordedEvent,
  ChildWorkflowAbortedRecordedEvent,
  ChildWorkflowCompletedRecordedEvent,
  ChildWorkflowFailedRecordedEvent,
  ChildWorkflowStartedRecordedEvent,
  HandoffOccurredRecordedEvent,
  HookPlanFailedRecordedEvent,
  RunGuardrailRecordedEvent,
  RunTripwireRecordedEvent,
  ToolErrorRecordedEvent,
  ToolPolicyDeniedRecordedEvent,
} from './events.ts';
import { observeRunOutcome, type RunOutcomeDetailRecorder } from './run-outcome-details.ts';

/** The Bureau event that wraps a recorded run event. */
export type RecordedRunEvent =
  | BudgetThresholdRecordedEvent
  | ChildWorkflowAbortedRecordedEvent
  | ChildWorkflowCompletedRecordedEvent
  | ChildWorkflowFailedRecordedEvent
  | ChildWorkflowStartedRecordedEvent
  | HandoffOccurredRecordedEvent
  | HookPlanFailedRecordedEvent
  | RunGuardrailRecordedEvent
  | RunTripwireRecordedEvent
  | ToolErrorRecordedEvent
  | ToolPolicyDeniedRecordedEvent;

/** The run events these Bureau events are made from, by their type. */
export const RECORDED_RUN_EVENT_TYPES = [
  RunTripwireRecordedEvent.type,
  RunGuardrailRecordedEvent.type,
  BudgetThresholdRecordedEvent.type,
  ToolPolicyDeniedRecordedEvent.type,
  ToolErrorRecordedEvent.type,
  ChildWorkflowStartedRecordedEvent.type,
  ChildWorkflowCompletedRecordedEvent.type,
  ChildWorkflowFailedRecordedEvent.type,
  ChildWorkflowAbortedRecordedEvent.type,
  HandoffOccurredRecordedEvent.type,
  HookPlanFailedRecordedEvent.type,
] as const;

/** The Bureau event for `action`, or `undefined` for an action that is not one of these. */
export function recordedRunEvent(action: Action): RecordedRunEvent | undefined {
  switch (action.type) {
    case ChildWorkflowStartedRecordedEvent.type:
      return new ChildWorkflowStartedRecordedEvent(action);
    case ChildWorkflowCompletedRecordedEvent.type:
      return new ChildWorkflowCompletedRecordedEvent(action);
    case ChildWorkflowFailedRecordedEvent.type:
      return new ChildWorkflowFailedRecordedEvent(action);
    case ChildWorkflowAbortedRecordedEvent.type:
      return new ChildWorkflowAbortedRecordedEvent(action);
    case HandoffOccurredRecordedEvent.type:
      return new HandoffOccurredRecordedEvent(action);
    case HookPlanFailedRecordedEvent.type:
      return new HookPlanFailedRecordedEvent(action);
    case RunTripwireRecordedEvent.type:
      return new RunTripwireRecordedEvent(action);
    case RunGuardrailRecordedEvent.type:
      return new RunGuardrailRecordedEvent(action);
    case BudgetThresholdRecordedEvent.type:
      return new BudgetThresholdRecordedEvent(action);
    case ToolPolicyDeniedRecordedEvent.type:
      return new ToolPolicyDeniedRecordedEvent(action);
    case ToolErrorRecordedEvent.type:
      return new ToolErrorRecordedEvent(action);
    default:
      return undefined;
  }
}

/** What {@link observeRecordedRunEvents} sends events to and reads the time from. */
export interface RecordedRunEventObserver {
  /** Receives each recorded event, once, as the run fires it. */
  readonly dispatch: (event: RecordedRunEvent) => void;
  /** The Bureau's composed clock, so a manually-clocked Bureau stays deterministic. */
  readonly now: () => number;
  /** Told what the run's `run.error` said, so `run.error` can name its step, code and kind (COR-2095). */
  readonly outcomeDetails?: RunOutcomeDetailRecorder | undefined;
  /** Where a throwing listener is reported; without one it is swallowed. */
  readonly onError?: ((error: unknown, kind: string) => void) | undefined;
}

/**
 * Publishes the recorded events of a run that is not in the store, as it fires them, and
 * records what its `run.error` says for the outcome event that follows (COR-2095).
 *
 * The action is built the way the store builds one: the event's own enumerable fields are the
 * `detail`, and `sequence` counts this run's observed events from zero. Returns a disposer that
 * detaches the listeners; a run's listeners die with it, so most callers keep nothing.
 *
 * Each listener is guarded, as the run event feed's are: it sits on the run's own emitter, and a
 * throw escaping it would surface inside whichever dispatch the run was making.
 */
export function observeRecordedRunEvents(
  activeRun: Pick<ActiveRun, 'addEventListener' | 'removeEventListener' | 'runId'>,
  observer: RecordedRunEventObserver,
): () => void {
  let sequence = 0;
  const disposers: Array<() => void> = [];
  for (const type of RECORDED_RUN_EVENT_TYPES) {
    // The untyped overload, as `attachRunEventFeed` uses it: the action is built from the event's
    // own fields, so nothing here needs the per-kind event type.
    const listener = (event: Event): void => {
      try {
        const detail: Record<string, unknown> = {};
        for (const key of Object.keys(event)) {
          detail[key] = (event as unknown as Record<string, unknown>)[key];
        }
        const recorded = recordedRunEvent({
          sequence: sequence++,
          runId: activeRun.runId,
          type,
          detail,
          timestamp: observer.now(),
        });
        if (recorded !== undefined) observer.dispatch(recorded);
      } catch (error) {
        observer.onError?.(error, type);
      }
    };
    activeRun.addEventListener(type, listener);
    disposers.push(() => activeRun.removeEventListener(type, listener));
  }
  const outcomeDetails = observer.outcomeDetails;
  if (outcomeDetails !== undefined) {
    disposers.push(observeRunOutcome(activeRun, activeRun.runId, outcomeDetails, observer.onError));
  }
  return () => {
    for (const dispose of disposers) dispose();
  };
}
