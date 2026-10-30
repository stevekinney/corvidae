/**
 * What the controls a person has over a schedule's cadence report (COR-1829): the rows of occurrences
 * it missed, and what running it now did.
 *
 * @module types/schedule-controls
 */

/**
 * One persisted record of occurrences a schedule missed (`engine.listScheduleMissedFires`). The
 * schedule keeps the most recent {@link SCHEDULE_MISSED_FIRE_LIMIT} of them, so
 * {@link ScheduleMetadata.missedFireCount} can be larger than the rows that remain. A row is keyed by
 * its schedule, `occurrence`, and `reason`, so a tick that is replayed after a crash records a miss
 * once.
 *
 * @example
 * ```ts
 * import type { ScheduleMissedFire } from '@lostgradient/weft';
 *
 * const row: ScheduleMissedFire = {
 *   scheduleId: 'daily-report',
 *   occurrence: Date.parse('2026-03-08T10:00:00.000Z'),
 *   reason: 'dst-gap',
 *   count: 1,
 *   recordedAt: Date.parse('2026-03-08T10:00:00.000Z'),
 * };
 * void row;
 * ```
 */
export interface ScheduleMissedFire {
  /** The schedule that missed the occurrence. */
  scheduleId: string;
  /**
   * The instant the miss is recorded at. For `late` it is the occurrence's scheduled time. For
   * `dst-gap` it is the instant the gap ends, which is when the clock passes the swallowed time.
   */
  occurrence: number;
  /**
   * Why it was missed: `late`, because the timer reached it too late (as after the engine was down)
   * and a non-backfill schedule drops what it was too late for, or `dst-gap`, because the wall-clock
   * time did not exist when the clock sprang forward. Same as `ScheduleMissedFireEvent.reason`.
   */
  reason: 'late' | 'dst-gap';
  /**
   * How many occurrences the row stands for: `1` for `late`, and for `dst-gap` the number of
   * wall-clock times the gap swallowed at `occurrence`.
   */
  count: number;
  /** When the schedule recorded the miss, from the engine's injected clock. */
  recordedAt: number;
}

/** How many {@link ScheduleMissedFire} rows a schedule keeps; recording one more evicts the oldest. */
export const SCHEDULE_MISSED_FIRE_LIMIT = 100;

/**
 * What {@link Engine.triggerSchedule} did with the run it was asked for, under the schedule's
 * overlap policy: it `started` a run (`workflowId`), `queued` one behind the current run
 * (`workflowId` is the id it will start under), or `skipped` it because a run was still going and
 * the policy is `skip` (`blockingWorkflowId`).
 *
 * @example
 * ```ts
 * import type { ScheduleTriggerResult } from '@lostgradient/weft';
 *
 * function describeTrigger(result: ScheduleTriggerResult): string {
 *   return result.outcome === 'skipped' ? 'skipped' : `run ${result.workflowId}`;
 * }
 * void describeTrigger;
 * ```
 */
export type ScheduleTriggerResult =
  | { outcome: 'started'; workflowId: string }
  | { outcome: 'queued'; workflowId: string }
  | { outcome: 'skipped'; blockingWorkflowId?: string };
