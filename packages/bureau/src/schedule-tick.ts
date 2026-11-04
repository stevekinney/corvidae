/**
 * The schedule tick (COR-2009): an internal workflow whose short runs record what the Bureau's
 * scheduler did, so the run list shows the scheduler's own work beside the runs it started. The
 * Bureau starts one, never a person:
 *
 * - `came-due`: an agent schedule came due and its fire started (the fire is its own run, of the
 *   built-in chat workflow). A workflow file's schedule starts its workflow directly and records no
 *   tick.
 * - `missed-runs`: the engine noticed occurrences a schedule missed. `whileStopped` is `true` when
 *   the missed window began before this Bureau started, which is the catch-up after the host was
 *   off ("Interborough started · logged 4 missed runs").
 *
 * Each run is tagged `origin:system` (the task origin kind `system`), which is how a list tells the
 * Bureau's own runs from the ones a person, a chat, a schedule or a goal started. A tick is started
 * under a run id derived from what it records, so a fire whose services are rebuilt
 * (recovery, a lease handoff) or a notice replayed after a restart records one tick, not two.
 *
 * @module schedule-tick
 */

import { RUN_ENGINE_WORKFLOW_TYPE, type ScheduleTick } from '@lostgradient/operative';
import { WorkflowAlreadyExistsError } from '@lostgradient/weft';

import { taskOriginTag } from './task-origin';

/** The workflow type the schedule tick is registered under on the Bureau's engine. */
export const SCHEDULE_TICK_WORKFLOW_TYPE = RUN_ENGINE_WORKFLOW_TYPE.scheduleTick;

/** The prefix of every schedule tick's run id, which tells a tick from other runs without a read. */
export const SCHEDULE_TICK_ID_PREFIX = 'schedule-tick:';

/** The run id of the tick that records `tick`: the same however often it is recorded. */
export function scheduleTickId(tick: ScheduleTick): string {
  return tick.event === 'came-due'
    ? `${SCHEDULE_TICK_ID_PREFIX}came-due:${tick.fireRunId}`
    : `${SCHEDULE_TICK_ID_PREFIX}missed-runs:${tick.scheduleId}:${String(tick.since)}:${String(tick.until)}`;
}

/** Whether `runId` names a schedule tick's run. */
export function isScheduleTickRunId(runId: string): boolean {
  return runId.startsWith(SCHEDULE_TICK_ID_PREFIX);
}

/** The engine a tick is started on. */
export interface ScheduleTickEngine {
  /** Weft's start, by registered type. */
  readonly start: (
    type: string,
    input: unknown,
    options: { readonly id: string; readonly tags: string[] },
  ) => Promise<unknown>;
}

/**
 * Starts the run that records `tick`, tagged as the Bureau's own. Its run id is derived from what it
 * records, so a second start of the same tick finds the run already there and records nothing more.
 */
export async function startScheduleTick(
  engine: ScheduleTickEngine,
  tick: ScheduleTick,
): Promise<void> {
  try {
    await engine.start(SCHEDULE_TICK_WORKFLOW_TYPE, tick, {
      id: scheduleTickId(tick),
      tags: [taskOriginTag({ kind: 'system' }), `schedule:${tick.scheduleId}`],
    });
  } catch (error) {
    if (error instanceof WorkflowAlreadyExistsError) return;
    throw error;
  }
}
