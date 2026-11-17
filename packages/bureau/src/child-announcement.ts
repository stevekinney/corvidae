/**
 * How a child run of Bureau's topology reaches its parent run's event stream (COR-1806).
 *
 * `bureau.children.dispatch` starts the child as a run of its own, so nothing the child does
 * reaches the parent's emitter. The topology tells `createBureau` when a child starts and when it
 * settles; this turns each into the record Operative's own `multiagent.child-workflow.*` events
 * leave in a run's action log, so the parent's AG-UI stream projects a topology child as it
 * projects a child a tool dispatched. The child's input is never part of the record.
 *
 * @module child-announcement
 */

import {
  ChildWorkflowAbortedEvent,
  ChildWorkflowCompletedEvent,
  ChildWorkflowFailedEvent,
  ChildWorkflowStartedEvent,
} from '@lostgradient/operative';

import type { ChildAnnouncement } from './child-topology.ts';
import { recordedRunEvent } from './recorded-run-events.ts';

/** The action a child announcement records on its parent run: an event type and its detail. */
export type ChildAction = {
  readonly type: string;
  readonly detail: Readonly<Record<string, unknown>>;
};

/**
 * The action to record on the parent run for `announcement`, or `undefined` for a record that is
 * not terminal when it says it settled.
 */
export function childActionOf(announcement: ChildAnnouncement): ChildAction | undefined {
  const { record } = announcement;
  const correlation = {
    parentAgentName: record.parentAgentName,
    parentRunId: record.parentRunId,
    childAgentName: record.childAgentName,
    childRunId: record.childRunId,
  };
  if (announcement.kind === 'started') {
    return {
      type: ChildWorkflowStartedEvent.type,
      detail: { ...correlation, durable: record.workflow.kind === 'durable' },
    };
  }
  const reason = record.outcome?.reason;
  switch (record.status) {
    case 'completed':
      return { type: ChildWorkflowCompletedEvent.type, detail: correlation };
    case 'failed':
      return {
        type: ChildWorkflowFailedEvent.type,
        detail: { ...correlation, reason: reason ?? 'failed' },
      };
    case 'aborted':
      return {
        type: ChildWorkflowAbortedEvent.type,
        detail: { ...correlation, ...(reason === undefined ? {} : { reason }) },
      };
    default:
      return undefined;
  }
}

/**
 * Makes `announcement` known on its parent run (COR-1806, COR-2097): the parent's action log when
 * the parent is on the run store, from which the store's action stream publishes it to the
 * feed; and, when it is not, the feed itself. A child can be dispatched under another child, a goal
 * attempt or a workflow step, none of which is on the store, so a record made through the store
 * alone would be dropped there. One path is taken for each announcement, never both, so the event
 * is published once.
 */
export function announceChildOnParent(
  announcement: ChildAnnouncement,
  store: {
    getRun(runId: string): unknown;
    recordAction(runId: string, type: string, detail: unknown): void;
  },
  dispatch: (event: Event) => void,
  now: () => number,
): void {
  const action = childActionOf(announcement);
  if (action === undefined) return;
  const { parentRunId } = announcement.record;
  if (store.getRun(parentRunId) !== undefined) {
    store.recordAction(parentRunId, action.type, action.detail);
    return;
  }
  // `sequence` orders a run's actions in its own log, and this run has none here: no reader of the
  // feed's projection looks at it.
  const event = recordedRunEvent({
    sequence: 0,
    runId: parentRunId,
    type: action.type,
    detail: action.detail,
    timestamp: now(),
  });
  if (event !== undefined) dispatch(event);
}
