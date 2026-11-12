/**
 * How the Goals list reads its goals, with no DOM in it: each goal as a row (the name that titles
 * it, the status word, the attempts made of those allowed, the check it runs and the time it
 * began), the segments that partition the rows and the counts they carry, the filters the address
 * holds, the day a row is listed under, and the sentence an empty result says.
 *
 * The address owns the filters so a filtered list can be shared: `status` is a segment (`running`,
 * `done`, `gave-up` or `stopped`; no value is All) and `agent` is the Agent chip.
 */
import type { DataListGroup, StatusDotWordLabel } from '@lostgradient/cinder';

import { GOALS_COPY } from '../../app/copy/goals.ts';
import { goalHasEnded, type Goal, type GoalStatus } from '../../lib/bureau-goals.ts';
import { calendarDay, dateLine, zoneLabel } from '../../lib/format/clock.ts';

/** The segments of the filter bar. `all` holds every goal. */
export type GoalSegment = 'all' | 'running' | 'done' | 'gave-up' | 'stopped';

/** The segments in the order the filter bar draws them. */
export const GOAL_SEGMENTS: readonly GoalSegment[] = [
  'all',
  'running',
  'done',
  'gave-up',
  'stopped',
];

/** The words each segment is drawn with. */
export const GOAL_SEGMENT_LABELS: Readonly<Record<GoalSegment, string>> = {
  all: GOALS_COPY.segments.all,
  running: GOALS_COPY.segments.running,
  done: GOALS_COPY.segments.done,
  'gave-up': GOALS_COPY.segments.gaveUp,
  stopped: GOALS_COPY.segments.stopped,
};

/** The segments a goal can be in besides `all`. */
export type GoalOutcomeSegment = Exclude<GoalSegment, 'all'>;

/**
 * The segment a goal status falls in. A goal that has not ended is Running, whatever its attempt
 * waits for (the attempt says that, not the list); one that spent its attempts without passing
 * Gave up, and a canceled one Stopped. A goal that failed (the check could not run) is in no
 * segment but All, as a chat that failed is in no segment but its own.
 */
export function goalSegmentOf(status: GoalStatus): GoalOutcomeSegment | null {
  switch (status) {
    case 'pending':
    case 'running':
    case 'evaluating':
    case 'retrying':
      return 'running';
    case 'succeeded':
      return 'done';
    case 'exhausted':
      return 'gave-up';
    case 'canceled':
      return 'stopped';
    case 'failed':
      return null;
  }
}

/**
 * The status word a goal's row reads, from Cinder's table of words: Running, Done, Gave up (red),
 * Stopped (neutral), and Failed for a goal whose check could not run. A goal that was asked to stop
 * and has not yet reads "Running, stopping": a qualifier on Running, not a new word.
 */
export function goalListWord(goal: Pick<Goal, 'status' | 'cancellation'>): StatusDotWordLabel {
  switch (goalSegmentOf(goal.status)) {
    case 'running':
      return goal.cancellation !== null && !goalHasEnded(goal.status)
        ? `Running, ${GOALS_COPY.stopping}`
        : 'Running';
    case 'done':
      return 'Done';
    case 'gave-up':
      return 'Gave up';
    case 'stopped':
      return 'Stopped';
    case null:
      return 'Failed';
  }
}

/**
 * The words of a check, from the name of the validator it runs. A validator is named by the exact
 * text it was configured with, and a name with no space in it is a slug
 * (`summary-lists-every-refund-waiting-for-approval`), which reads as the sentence it stands for
 * ("Summary lists every refund waiting for approval"). A name that already has spaces is said as it is.
 */
export function checkText(validatorName: string): string {
  const name = validatorName.trim();
  if (name === '' || /\s/.test(name)) return name;
  const words = name.replaceAll(/[-_]+/g, ' ').trim();
  return words === '' ? name : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** One goal as a row of the list: everything the row shows, and nothing it does not. */
export type GoalRow = {
  readonly id: string;
  /** The goal's name, which titles the row; the identifier when the goal has none. */
  readonly title: string;
  readonly agentName: string;
  readonly status: GoalStatus;
  /** The segment the goal counts under, or `null` when it counts under All alone. */
  readonly segment: GoalOutcomeSegment | null;
  readonly statusWord: StatusDotWordLabel;
  /** The check the goal runs, as a sentence. */
  readonly check: string;
  /** Attempts made. */
  readonly made: number;
  /** Attempts allowed. */
  readonly allowed: number;
  /** Epoch milliseconds the goal began, or `null` when the Bureau's time is unreadable. */
  readonly startedAt: number | null;
};

/** One goal as a row. */
export function goalRow(goal: Goal): GoalRow {
  const started = Date.parse(goal.createdAt);
  const name = goal.identity.name.trim();
  return {
    id: goal.goalRunId,
    title: name === '' ? goal.goalRunId : name,
    agentName: goal.agentName,
    status: goal.status,
    segment: goalSegmentOf(goal.status),
    statusWord: goalListWord(goal),
    check: checkText(goal.validator.name),
    made: goal.usage.attempts,
    allowed: goal.bounds.maximumAttempts,
    startedAt: Number.isNaN(started) ? null : started,
  };
}

/**
 * The rows as the list orders them, newest first: by when each began, the ones with no readable
 * time last, and rows that began together in the order the Bureau listed them.
 */
export function sortGoalRows(rows: readonly GoalRow[]): GoalRow[] {
  return rows.toSorted((left, right) => {
    if (left.startedAt === right.startedAt) return 0;
    if (left.startedAt === null) return 1;
    if (right.startedAt === null) return -1;
    return right.startedAt - left.startedAt;
  });
}

/** What the address asks the list to show. */
export type GoalListFilters = {
  readonly status: GoalSegment;
  readonly agent: string | undefined;
};

/** Reads the filters out of the address's query string; a value that names nothing is left out. */
export function goalFiltersFromSearch(search: URLSearchParams): GoalListFilters {
  const status = GOAL_SEGMENTS.find((segment) => segment === search.get('status'));
  return { status: status ?? 'all', agent: search.get('agent') || undefined };
}

/** The rows the Agent chip leaves. */
export function narrowByAgent(rows: readonly GoalRow[], agent: string | undefined): GoalRow[] {
  return agent === undefined ? [...rows] : rows.filter((row) => row.agentName === agent);
}

/** Whether a row is in a segment: `all` holds every row. */
export function inGoalSegment(row: Pick<GoalRow, 'segment'>, segment: GoalSegment): boolean {
  return segment === 'all' || row.segment === segment;
}

/** The rows a segment leaves. */
export function narrowBySegment(rows: readonly GoalRow[], segment: GoalSegment): GoalRow[] {
  return rows.filter((row) => inGoalSegment(row, segment));
}

/** How many of `rows` each segment holds. */
export function countGoalRows(
  rows: readonly Pick<GoalRow, 'segment'>[],
): Readonly<Record<GoalSegment, number>> {
  return {
    all: rows.length,
    running: rows.filter((row) => row.segment === 'running').length,
    done: rows.filter((row) => row.segment === 'done').length,
    'gave-up': rows.filter((row) => row.segment === 'gave-up').length,
    stopped: rows.filter((row) => row.segment === 'stopped').length,
  };
}

/**
 * The day band a row is listed under, as a `DataList` group. The band names its day by the viewer's
 * calendar ("Today, Monday, Nov 2", "Yesterday, Sunday, Nov 1", "Friday, Oct 30") and the zone its
 * times are in at the right ("Central time"). A goal with no readable time is Earlier, where nothing
 * claims it is recent. On a phone the bands for today and yesterday read those words alone.
 */
export function goalDayGroup(
  row: Pick<GoalRow, 'startedAt'>,
  now: number,
  zone: string,
  phone: boolean,
): DataListGroup {
  const detail = zoneLabel(now, zone);
  if (row.startedAt === null) return { key: 'earlier', label: GOALS_COPY.band.earlier, detail };
  const days = calendarDay(now, zone) - calendarDay(row.startedAt, zone);
  if (days <= 0) {
    const label = phone
      ? GOALS_COPY.band.today
      : `${GOALS_COPY.band.today}, ${dateLine(now, zone)}`;
    return { key: 'today', label, detail };
  }
  const day = dateLine(row.startedAt, zone);
  if (days === 1) {
    const label = phone ? GOALS_COPY.band.yesterday : `${GOALS_COPY.band.yesterday}, ${day}`;
    return { key: 'yesterday', label, detail };
  }
  return { key: `day-${String(calendarDay(row.startedAt, zone))}`, label: day, detail };
}

/** Whether any filter narrows the list, so an empty result is "no match" and not "no goals". */
export function goalsAreFiltered(filters: GoalListFilters): boolean {
  return filters.status !== 'all' || filters.agent !== undefined;
}

/** The names the filtered-to-nothing sentence calls things by. */
export type GoalNoMatchLabels = {
  /** The agent the Agent chip names, as a person reads it ("Tool runner"). */
  readonly agent?: string | undefined;
};

/** What each segment says about a goal that is not in it, after "has no" or "hasn't". */
const NO_GOAL_OF: Readonly<Record<GoalOutcomeSegment, { agent: string; anyone: string }>> = {
  running: { agent: 'has no running goals', anyone: 'No goals are running' },
  done: { agent: 'has no goals that are done', anyone: 'No goals are done' },
  'gave-up': { agent: 'hasn’t given up on any goal', anyone: 'No goals have given up' },
  stopped: { agent: 'has no stopped goals', anyone: 'No goals are stopped' },
};

/**
 * The sentence under "No goals match these filters": who has none of what, then what to change.
 * "Tool runner hasn't given up on any goal. Try another status or agent." The agent comes first as
 * the subject, and the hint names only the facets that are applied.
 */
export function goalNoMatchDescription(
  filters: GoalListFilters,
  labels: GoalNoMatchLabels = {},
): string {
  const subject = filters.agent === undefined ? undefined : (labels.agent ?? filters.agent);
  const segment = filters.status === 'all' ? undefined : filters.status;
  let sentence: string;
  if (subject !== undefined) {
    sentence = `${subject} ${segment === undefined ? 'has no goals' : NO_GOAL_OF[segment].agent}.`;
  } else if (segment !== undefined) {
    sentence = `${NO_GOAL_OF[segment].anyone}.`;
  } else {
    sentence = 'No goals match.';
  }
  const hints = [
    ...(segment === undefined ? [] : ['status']),
    ...(subject === undefined ? [] : ['agent']),
  ];
  return `${sentence} Try another ${hints.length === 0 ? 'filter' : hints.join(' or ')}.`;
}
