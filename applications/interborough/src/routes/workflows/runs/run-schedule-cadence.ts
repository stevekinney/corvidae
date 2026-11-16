/**
 * When a schedule runs, as the end of the sentence a run's Started by says it in (COR-2424, row
 * 55i): "every day at 3:00 AM (9:00 AM UTC)", the timetable in the viewer's time with the schedule's
 * own zone in parentheses. Said by the same words Home uses for a schedule's cadence.
 */
import type { BureauSchedule } from '../../../lib/bureau-schedules.ts';
import { viewerTimeZone } from '../../../lib/format/clock.ts';
import { viewerCadence } from '../../home/home-rows.ts';

/** The schedule's cadence as a clause that follows its name: the first letter in lower case. */
export function cadenceClauseOf(
  schedule: Pick<BureauSchedule, 'cronExpression' | 'intervalMs' | 'timeZone' | 'nextFireAt'>,
  zone: string = viewerTimeZone(),
): string {
  const text = viewerCadence(schedule, zone);
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}
