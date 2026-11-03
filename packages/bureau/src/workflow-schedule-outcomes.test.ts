/**
 * COR-2009 — a run a workflow file's schedule started publishes its outcome as `schedule.completed`
 * or `schedule.failed`, as an agent schedule's fire does; a run no schedule started, an agent
 * schedule's fire (which publishes its own) and a cancelled run publish nothing.
 */
import { ScheduleCompletedEvent, ScheduleFailedEvent } from '@lostgradient/operative';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import {
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowTimedOutEvent,
  type WorkflowScheduleProvenance,
} from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  publishWorkflowScheduleOutcomes,
  type WorkflowScheduleOutcomeEngine,
} from './workflow-schedule-outcomes';

/** An engine double: an event target whose runs' provenance a test sets. */
function engineWith(provenance: Readonly<Record<string, WorkflowScheduleProvenance>>) {
  const target = new EventTarget();
  const engine: WorkflowScheduleOutcomeEngine = {
    addEventListener: (type, listener) => target.addEventListener(type, listener),
    removeEventListener: (type, listener) => target.removeEventListener(type, listener),
    getScheduleProvenance: async (workflowId) =>
      Object.hasOwn(provenance, workflowId) ? (provenance[workflowId] ?? null) : null,
  };
  return { engine, target };
}

const FILE_SCHEDULE = 'bureau-workflow-schedule:release-notes:1';

describe('publishWorkflowScheduleOutcomes', () => {
  it('publishes schedule.completed and schedule.failed for a workflow file schedule’s runs', async () => {
    const { engine, target } = engineWith({
      done: { scheduleId: FILE_SCHEDULE, occurrence: 1 },
      broke: { scheduleId: FILE_SCHEDULE, occurrence: 2 },
      late: { scheduleId: FILE_SCHEDULE, occurrence: 3 },
    });
    const published: Array<ScheduleCompletedEvent | ScheduleFailedEvent> = [];
    publishWorkflowScheduleOutcomes(engine, (event) => published.push(event));

    target.dispatchEvent(new WorkflowCompletedEvent('done', null, 10));
    target.dispatchEvent(new WorkflowFailedEvent('broke', new Error('GitHub didn’t answer')));
    target.dispatchEvent(new WorkflowTimedOutEvent('late', 'execution', 1000));
    await waitUntil(() => published.length === 3);

    expect(published.map((event) => [event.type, event.scheduleId, event.runId])).toEqual([
      ['schedule.completed', FILE_SCHEDULE, 'done'],
      ['schedule.failed', FILE_SCHEDULE, 'broke'],
      ['schedule.failed', FILE_SCHEDULE, 'late'],
    ]);
  });

  it('publishes nothing for an unscheduled run, an agent schedule’s fire or a cancelled run, nor once stopped', async () => {
    const { engine, target } = engineWith({
      fire: { scheduleId: 'schedule-1-daily', occurrence: 1 },
      cancelled: { scheduleId: FILE_SCHEDULE, occurrence: 1 },
      after: { scheduleId: FILE_SCHEDULE, occurrence: 2 },
    });
    const published: unknown[] = [];
    const stop = publishWorkflowScheduleOutcomes(engine, (event) => published.push(event));

    target.dispatchEvent(new WorkflowCompletedEvent('chat-run', null, 1));
    target.dispatchEvent(new WorkflowCompletedEvent('fire', null, 1));
    target.dispatchEvent(new WorkflowCancelledEvent('cancelled'));
    stop();
    target.dispatchEvent(new WorkflowCompletedEvent('after', null, 1));

    // Load can only delay a publication, never make one that was not going to happen.
    await quietFor(50);
    expect(published).toEqual([]);
  });
});
