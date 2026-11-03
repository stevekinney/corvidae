/**
 * The outcome of a run a workflow file's schedule started, published as the Bureau's
 * `schedule.completed` or `schedule.failed` (COR-2009). Both kinds say "a run a schedule started
 * completed" or "failed", and an agent schedule's fire has published them since AB-223; a workflow
 * file's schedule starts its workflow directly on the engine, with no fire of the Bureau's in
 * between, so nothing published its runs' outcomes, and a hook that pages on-call when a scheduled
 * run fails never heard of the Release notes digest's failure.
 *
 * The engine records which schedule occurrence started a run (`getScheduleProvenance`). When a run
 * ends, its provenance is read, and a run a workflow file's schedule started (its schedule id has
 * the {@link WORKFLOW_SCHEDULE_ID_PREFIX}) is published: `schedule.completed` when it completed,
 * `schedule.failed` when it failed or timed out. An agent schedule's fire is left to the fire's own
 * forwarding, so no outcome is published twice, and a cancelled run publishes neither, as a
 * cancelled fire does not.
 *
 * @module workflow-schedule-outcomes
 */

import { ScheduleCompletedEvent, ScheduleFailedEvent } from '@lostgradient/operative';
import {
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowTimedOutEvent,
  type WorkflowScheduleProvenance,
} from '@lostgradient/weft';

import { WORKFLOW_SCHEDULE_ID_PREFIX } from './workflow-schedule';

/** The engine a run's outcome is read from. */
export interface WorkflowScheduleOutcomeEngine {
  /** Weft's event target, which dispatches each run's terminal event. */
  addEventListener(type: string, listener: (event: Event) => void): void;
  /** Removes a listener {@link WorkflowScheduleOutcomeEngine.addEventListener} added. */
  removeEventListener(type: string, listener: (event: Event) => void): void;
  /** The schedule occurrence that started `workflowId`, or `null` when no schedule did. */
  getScheduleProvenance(workflowId: string): Promise<WorkflowScheduleProvenance | null>;
}

/** Where an outcome is published: the Bureau's own emitter. */
export type WorkflowScheduleOutcomeSink = (
  event: ScheduleCompletedEvent | ScheduleFailedEvent,
) => void;

/**
 * Publishes the outcome of every run a workflow file's schedule starts on `engine` to `publish`,
 * and answers the function that stops it. A provenance that can't be read publishes nothing: the
 * outcome is a notice, and the run's own record still says how it ended.
 */
export function publishWorkflowScheduleOutcomes(
  engine: WorkflowScheduleOutcomeEngine,
  publish: WorkflowScheduleOutcomeSink,
): () => void {
  const settle = (workflowId: string, failed: boolean): void => {
    void engine.getScheduleProvenance(workflowId).then(
      (provenance) => {
        if (provenance === null) return;
        if (!provenance.scheduleId.startsWith(WORKFLOW_SCHEDULE_ID_PREFIX)) return;
        publish(
          failed
            ? new ScheduleFailedEvent(provenance.scheduleId, workflowId)
            : new ScheduleCompletedEvent(provenance.scheduleId, workflowId),
        );
      },
      () => undefined,
    );
  };
  const listeners: ReadonlyArray<readonly [string, (event: Event) => void]> = [
    [
      WorkflowCompletedEvent.type,
      (event) => {
        if (event instanceof WorkflowCompletedEvent) settle(event.workflowId, false);
      },
    ],
    [
      WorkflowFailedEvent.type,
      (event) => {
        if (event instanceof WorkflowFailedEvent) settle(event.workflowId, true);
      },
    ],
    [
      WorkflowTimedOutEvent.type,
      (event) => {
        if (event instanceof WorkflowTimedOutEvent) settle(event.workflowId, true);
      },
    ],
  ];
  for (const [type, listener] of listeners) engine.addEventListener(type, listener);
  return () => {
    for (const [type, listener] of listeners) engine.removeEventListener(type, listener);
  };
}
