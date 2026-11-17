/**
 * A workflow file's schedule trigger as Cinder's `ScheduleBuilder` edits it, and back (COR-2432,
 * board PageWorkflowBuilder, rows 65d and 65q): the builder's When block shows Repeats, At, Time
 * zone and the next runs for a `spec` it can read, and writes what the person picks back as the
 * file's `spec` and `timezone`. A cron `spec` is read in its `timezone` (UTC when the file names
 * none, as the Bureau reads it); an interval of whole minutes or hours (`15m`, `24h`) is an
 * interval, which has no zone. Any other `spec` is not the builder's to draw, and stays a field.
 */
import type { ScheduleValue } from '@lostgradient/cinder';

import type { ScheduleFields } from './workflow-builder-model.ts';

/** A five-field cron expression, as the file format writes one. */
const CRON = /^\S+(?:\s+\S+){4}$/;
/** An interval the builder can show: a whole number of minutes or hours. */
const INTERVAL = /^(\d+)(m|h)$/;

/** The zone a cron schedule the file names no zone for is read in. */
export const FILE_SCHEDULE_DEFAULT_ZONE = 'UTC';

/** The trigger's cadence as the builder edits it, or `undefined` for a `spec` it cannot show. */
export function scheduleValueOf(trigger: {
  readonly spec: string;
  readonly timezone: string | null;
}): ScheduleValue | undefined {
  const spec = trigger.spec.trim();
  const timeZone = trigger.timezone ?? FILE_SCHEDULE_DEFAULT_ZONE;
  if (CRON.test(spec)) return { cron: spec.split(/\s+/).join(' '), timeZone };
  const interval = INTERVAL.exec(spec);
  if (interval === null) return undefined;
  const count = Number(interval[1]);
  if (!Number.isSafeInteger(count) || count < 1) return undefined;
  return { every: { unit: interval[2] === 'h' ? 'hours' : 'minutes', count }, timeZone };
}

/** What the file writes for a cadence the builder emitted: a cron with its zone, or an interval with none. */
export function scheduleFieldsOf(value: ScheduleValue): ScheduleFields {
  if ('cron' in value) return { spec: value.cron, timezone: value.timeZone };
  const unit = value.every.unit === 'hours' ? 'h' : 'm';
  return { spec: `${String(value.every.count)}${unit}`, timezone: null };
}
