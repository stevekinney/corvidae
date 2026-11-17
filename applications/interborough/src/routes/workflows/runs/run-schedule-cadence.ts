/**
 * When a schedule runs, as the end of the sentence a run's Started by says it in (COR-2424, row
 * 55i): "every day at 3:00 AM (9:00 AM UTC)", the timetable in the viewer's time with the schedule's
 * own zone in parentheses. Said by the same words Home uses for a schedule's cadence. A run's row
 * in Runs says the viewer's clock only ("every day at 3:00 AM", row 53l).
 */
import type { BureauSchedule } from '../../../lib/bureau-schedules.ts';
import { viewerTimeZone } from '../../../lib/format/clock.ts';
import { viewerCadence } from '../../home/home-rows.ts';

/** The schedule's cadence as a clause that follows its name: the first letter in lower case. */
export function cadenceClauseOf(
  schedule: Pick<BureauSchedule, 'cronExpression' | 'intervalMs' | 'timeZone' | 'nextFireAt'>,
  zone: string = viewerTimeZone(),
  options: { readonly scheduleZone?: boolean } = {},
): string {
  const text = viewerCadence(schedule, zone, options);
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}
