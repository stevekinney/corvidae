/**
 * The runs a schedule missed, as Runs lists them: one collapsed row per schedule, last among the
 * runs of the day the misses were logged, that says how many runs were missed since when and opens
 * onto each missed occurrence. The occurrences are not runs (nothing ran), so they are plain lines
 * with no row or link of their own, and the row ends with a link to the schedule.
 *
 * A miss is still news while the schedule has not fired after it, as Health's attention list reads
 * it (`packages/bureau/src/attention-feed.ts`). The schedules (`bureau.schedules.list`) say which
 * missed fires at all, and `bureau.schedules.missed` lists each one's occurrences. A caller who may
 * not read schedules sees no missed row; the runs list never fails for it.
 */
import { TASK_COPY } from '../../../app/copy.ts';
import {
  listAgentScheduleMissed,
  listBureauSchedules,
  type BureauSchedule,
  type MissedFire,
} from '../../../lib/bureau-schedules.ts';
import { clockTime } from '../../../lib/format/clock.ts';
import { scheduleDetailPath } from '../../../lib/router.svelte.ts';
import type { ScheduleCadence } from '../../schedules/cadence.ts';
import { cadenceText } from '../../schedules/schedule-cadence-text.ts';

/** The runs one schedule missed since it last fired. */
export type MissedRuns = {
  /** The schedule that missed them. */
  readonly scheduleId: string;
  /** The schedule's name, which titles the row. */
  readonly title: string;
  /** The agent the schedule runs, or `null` when it names none. */
  readonly agentName: string | null;
  /** The schedule's cadence in its own zone and the viewer's: "every day at 3:00 AM (9:00 AM UTC)". */
  readonly cadence: string;
  /** How many runs it missed. */
  readonly count: number;
  /** The first missed occurrence, in epoch milliseconds. */
  readonly since: number;
  /** When the last of the misses was logged, in epoch milliseconds: where the row sits in the list. */
  readonly loggedAt: number;
  /** Each missed occurrence, newest first, in epoch milliseconds. */
  readonly occurrences: readonly number[];
  /** The schedule's page. */
  readonly schedulePath: string;
};

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/** A schedule's cadence as `cadenceText` reads it, from the Bureau's view of the schedule. */
function cadenceOf(schedule: BureauSchedule): ScheduleCadence {
  return {
    ...(schedule.cronExpression === null ? {} : { cronExpression: schedule.cronExpression }),
    ...(schedule.intervalMs === null ? {} : { intervalMs: schedule.intervalMs }),
    timeZone: schedule.timeZone,
  };
}

/**
 * The runs `schedule` missed since it last fired, from the misses it recorded, or `null` when every
 * miss is older than its last fire. `now` stands in for the clock the cadence is read from.
 */
export function missedRunsOf(
  schedule: BureauSchedule,
  missed: readonly MissedFire[],
  now: number,
): MissedRuns | null {
  const lastFire = schedule.lastFireAt === null ? Number.NaN : Date.parse(schedule.lastFireAt);
  const lastFireAt = Number.isNaN(lastFire) ? Number.NEGATIVE_INFINITY : lastFire;
  const open = missed
    .filter((row) => row.occurrence > lastFireAt)
    .toSorted((left, right) => right.occurrence - left.occurrence);
  const oldest = open.at(-1);
  if (oldest === undefined) return null;
  return {
    scheduleId: schedule.id,
    title: schedule.description ?? TASK_COPY.list.missed.untitled,
    agentName: schedule.agentName,
    cadence: lowerFirst(cadenceText(cadenceOf(schedule), now).full),
    count: open.reduce((total, row) => total + row.count, 0),
    since: oldest.occurrence,
    loggedAt: Math.max(...open.map((row) => row.recordedAt)),
    occurrences: open.map((row) => row.occurrence),
    schedulePath: scheduleDetailPath(schedule.id),
  };
}

/** What Runs reads of the schedules: the name of each, and the runs each missed. */
export type RunSchedules = {
  /** Each schedule's name, by its identifier, which titles the runs its fires started. */
  readonly names: ReadonlyMap<string, string>;
  /** Every schedule's missed runs, newest logged first. */
  readonly missed: readonly MissedRuns[];
};

/**
 * The schedules' names and their missed runs. Only a schedule that says it missed a fire is asked
 * for its misses, and one whose misses cannot be read is left out rather than hiding the rest.
 */
export async function readRunSchedules(
  options: { readonly signal?: AbortSignal; readonly now?: number } = {},
): Promise<RunSchedules> {
  const request = options.signal === undefined ? {} : { signal: options.signal };
  const now = options.now ?? Date.now();
  const schedules = await listBureauSchedules(request);
  const names = new Map<string, string>();
  for (const schedule of schedules) {
    if (schedule.description !== null) names.set(schedule.id, schedule.description);
  }
  const missing = schedules.filter(
    (schedule) => schedule.status !== 'cancelled' && (schedule.missedFireCount ?? 0) > 0,
  );
  const answers = await Promise.allSettled(
    missing.map((schedule) => listAgentScheduleMissed(schedule.id, request)),
  );
  const missed = missing
    .flatMap((schedule, index) => {
      const answer = answers[index];
      if (answer?.status !== 'fulfilled') return [];
      const runs = missedRunsOf(schedule, answer.value, now);
      return runs === null ? [] : [runs];
    })
    .toSorted((left, right) => right.loggedAt - left.loggedAt);
  return { names, missed };
}

/** The day a missed row's time column shows: "Oct 30". */
export function missedDay(at: number, zone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: zone,
  }).format(at);
}

/** One missed occurrence, as a line under the expanded row: "Mon, Nov 2, 3:00 AM". */
export function occurrenceWords(at: number, zone: string): string {
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: zone,
  }).format(at);
  return `${day}${TASK_COPY.list.separator}${clockTime(at, zone)}`;
}

/**
 * Line two of the missed row: "Schedule, Assistant, every day at 3:00 AM (9:00 AM UTC), missed 4
 * times since Oct 30". The schedule's own zone stays in the cadence; the occurrences are the viewer's.
 */
export function missedLineTwo(
  missed: MissedRuns,
  zone: string,
  agentLabel: (agentName: string) => string,
): string {
  const copy = TASK_COPY.list;
  return [
    copy.kinds.schedule,
    ...(missed.agentName === null ? [] : [agentLabel(missed.agentName)]),
    missed.cadence,
    copy.missed.since(missed.count, missedDay(missed.since, zone)),
  ].join(copy.separator);
}
