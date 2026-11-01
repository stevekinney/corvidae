import { WeftError } from '../weft-error.ts';

/**
 * Thrown by `skipNextScheduleOccurrence` when the caller named an `occurrence` that is neither the
 * schedule's next real run nor the run already skipped (COR-1985): a fire passed it, it is later
 * than the next run, or it is a wake-up that starts nothing. Nothing was written. Read the schedule
 * again and choose from `nextOccurrence`, the next real run as the schedule stands now.
 *
 * @example
 * ```ts
 * import { Engine, ScheduleOccurrenceNotNextError, workflow } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'report' }).execute(async function* () { return 'ok'; }));
 * await engine.schedule('report', null, '0 9 * * *', { id: 'daily-report' });
 * try {
 *   await engine.skipNextScheduleOccurrence('daily-report', { occurrence: 0 });
 * } catch (error) {
 *   if (error instanceof ScheduleOccurrenceNotNextError) {
 *     console.error(error.scheduleId, error.occurrence, error.nextOccurrence);
 *   }
 * }
 * engine[Symbol.dispose]();
 * ```
 */
export class ScheduleOccurrenceNotNextError extends WeftError<'ScheduleOccurrenceNotNextError'> {
  /** The id of the schedule the skip was for. */
  readonly scheduleId: string;
  /** The occurrence the caller named, in milliseconds since the epoch. */
  readonly occurrence: number;
  /** The schedule's next real run now, in milliseconds since the epoch. */
  readonly nextOccurrence: number;

  constructor(scheduleId: string, occurrence: number, nextOccurrence: number) {
    super(
      'ScheduleOccurrenceNotNextError',
      `Schedule "${scheduleId}" has its next run at ${nextOccurrence}, not ${occurrence}. ` +
        'The occurrence changed after it was read; read it again.',
    );
    this.scheduleId = scheduleId;
    this.occurrence = occurrence;
    this.nextOccurrence = nextOccurrence;
  }
}
