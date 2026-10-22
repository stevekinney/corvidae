import { WeftError } from '../weft-error.ts';

/**
 * Thrown by `pauseSchedule`, `resumeSchedule`, `cancelSchedule`, and `updateSchedule` when the
 * caller's `extraConditions` name a key under one of Weft's reserved prefixes
 * (`WEFT_RESERVED_KEY_PREFIXES`), the schedule's own key among them. The conditions guard the
 * caller's own keys; the schedule's own write is conditioned by the engine, and a condition of the
 * caller's on a key the engine owns could never be told apart from the engine's. Nothing was
 * written.
 *
 * @example
 * ```ts
 * import { Engine, ScheduleReservedKeyError } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * try {
 *   await engine.pauseSchedule('daily-report', {
 *     extraConditions: [{ key: 'schedule:daily-report', expectedValue: null }],
 *   });
 * } catch (error) {
 *   if (error instanceof ScheduleReservedKeyError) console.error(error.key);
 * }
 * engine[Symbol.dispose]();
 * ```
 */
export class ScheduleReservedKeyError extends WeftError<'ScheduleReservedKeyError'> {
  readonly scheduleId: string;
  readonly key: string;

  constructor(scheduleId: string, key: string) {
    super(
      'ScheduleReservedKeyError',
      `The extraConditions of a transition of schedule "${scheduleId}" name "${key}", which is ` +
        'under a key prefix Weft reserves. Condition only keys of your own.',
    );
    this.scheduleId = scheduleId;
    this.key = key;
  }
}
