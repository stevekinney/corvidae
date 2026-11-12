/**
 * What the Runs list of a schedule's page says, worked out from the schedule, the runs it started
 * and the fires it missed, with no DOM in it (COR-2018, the runs timeline of `ScheduleDetail`):
 * the upcoming rows (farthest first, so the nearest sits against the Now marker), the one band
 * the missed fires fold into, each past run as a status-first row, and the labelled break where
 * the clock changed. Every time is the viewer's, in the zone the page names.
 */
import type { StatusDotWord } from '@lostgradient/cinder';
import { formatDate, formatDateTime, formatRelativeTime } from '@lostgradient/cinder';

import type { ScheduleSummary, WorkflowSummary } from '@lostgradient/weft';

import { SCHEDULE_COPY } from '../../app/copy/schedules.ts';
import type { MissedFire } from '../../lib/bureau-schedules.ts';
import { workflowDetailPath } from '../../lib/router.svelte.ts';
import { pastRows, type PastRowsTruncation } from './past-runs-model.ts';
import type { RowBlocker, ScheduleRow } from './schedule-row-model.ts';
import { upcomingFires, zoneOffsetMinutes } from './schedule-time.ts';

/** How many upcoming runs the list shows at most. */
export const UPCOMING_RUN_LIMIT = 3;

/** How far ahead an upcoming run after the first may be and still be listed: a weekly schedule shows this week's and next week's, not a month of them. */
export const UPCOMING_HORIZON_MS = 10 * 24 * 60 * 60 * 1000;

const MINUTE_MS = 60_000;

/** One run the schedule has coming. */
export type UpcomingRow = {
  readonly at: number;
  /** "Tue Nov 3, 3:00 AM", in the viewer's zone. */
  readonly absolute: string;
  /** "in 16 hours". */
  readonly relative: string;
  /** Whether a person asked to skip it. */
  readonly skipped: boolean;
  /** The second line of a run that will not start: "won't start, Order refund can't load, no provider". */
  readonly note: string | undefined;
};

/** "in 16 hours", or nothing for a run so far off that the relative time says its date, which its row already does. */
function relativeOf(at: number, now: number): string {
  const text = formatRelativeTime(at, { now, units: 'spelled' });
  return text.startsWith('in ') ? text : '';
}

/** The reasons, said short, on the second line of the run that is due and will not start. */
function blockerNote(blockers: readonly RowBlocker[]): string {
  const reasons = blockers.map((blocker) => {
    switch (blocker.kind) {
      case 'cannot-load':
        return SCHEDULE_COPY.detail.runs.noteCannotLoad(blocker.label);
      case 'deleted':
        return SCHEDULE_COPY.detail.runs.noteDeleted(blocker.workflowType);
      case 'provider':
        return SCHEDULE_COPY.detail.runs.noteProvider;
    }
  });
  return [SCHEDULE_COPY.detail.runs.wontStart, ...reasons].join(', ');
}

/**
 * The runs a schedule has coming, farthest first. Any of them can be skipped, and a skipped one
 * taken back. An occurrence that is due and will not start says why on a second line, because
 * skipping it still prevents the start once things are fixed.
 */
export function upcomingRows(
  schedule: ScheduleSummary,
  row: Pick<ScheduleRow, 'status' | 'allBlockers'>,
  now: number,
): readonly UpcomingRow[] {
  if (row.status !== 'active') return [];
  // The row's status is the schedule's as the Bureau reads it: a schedule held because its workflow
  // cannot load is Active there although the engine holds it paused, and its runs are still coming.
  // The next run is always listed, however far off; those after it only while they are within reach.
  const fires = upcomingFires({ ...schedule, status: 'active' }, UPCOMING_RUN_LIMIT, now).filter(
    (fire, index) => index === 0 || fire.at - now <= UPCOMING_HORIZON_MS,
  );
  const wontStart = row.allBlockers.length > 0;
  return fires
    .map((fire, index) => ({
      at: fire.at,
      absolute: formatDateTime(fire.at, { dayWords: false, now }),
      relative: relativeOf(fire.at, now),
      skipped: fire.skipped,
      // Only the run that is due next is said to be held, the one the blockers keep from starting.
      note: wontStart && index === 0 && !fire.skipped ? blockerNote(row.allBlockers) : undefined,
    }))
    .toReversed();
}

/** One past run, as a row. */
export type PastRunRow = {
  readonly id: string;
  readonly at: number;
  readonly absolute: string;
  readonly status: StatusDotWord;
  /** "14 s", or "38 s so far" for a run that is going. */
  readonly duration: string | undefined;
  readonly href: string;
  /** Whether the run is going, so its detail (the step it is on) is worth reading. */
  readonly running: boolean;
  /** Whether its detail (what started it, where it stopped) is worth reading. */
  readonly needsDetail: boolean;
};

/** A duration as the design says it: "14 s", "1 min 48 s", "2 h 5 min". */
export function spacedDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(rest)} s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${String(days)} d` : `${String(days)} d ${String(rest)} h`;
}

const RUN_WORDS: Readonly<Record<WorkflowSummary['status'], StatusDotWord>> = {
  pending: 'Scheduled',
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Canceled',
  'timed-out': 'Failed',
  suspended: 'Paused',
};

const TERMINAL = new Set<WorkflowSummary['status']>([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

function pastRunOf(run: WorkflowSummary, now: number): PastRunRow {
  const terminal = TERMINAL.has(run.status);
  return {
    id: run.id,
    at: run.createdAt,
    absolute: formatDateTime(run.createdAt, { dayWords: false, now }),
    status: RUN_WORDS[run.status],
    duration: terminal
      ? spacedDuration(run.updatedAt - run.createdAt)
      : run.status === 'running'
        ? SCHEDULE_COPY.detail.runs.soFar(spacedDuration(now - run.createdAt))
        : undefined,
    href: workflowDetailPath(run.id),
    running: run.status === 'running',
    needsDetail: run.status !== 'completed',
  };
}

/** One missed fire, as a row of the band when it is open. */
export type MissedRow = {
  readonly key: string;
  readonly at: number;
  readonly absolute: string;
  /** "Missed, Interborough was off". */
  readonly text: string;
};

/** The one band the missed fires fold into, below Now. */
export type MissedBand = {
  /** "Missed 4 times since Oct 30". */
  readonly title: string;
  /** "Interborough was off". */
  readonly detail: string;
  readonly rows: readonly MissedRow[];
  /** The newest and the oldest fire the band holds, which place it among the rows around it. */
  readonly newest: number;
  readonly oldest: number;
};

function reasonOf(reason: MissedFire['reason']): string {
  return SCHEDULE_COPY.detail.runs.missedReason[reason];
}

/** The band for the fires a schedule missed, newest first, or `null` when it missed none. */
export function missedBand(missed: readonly MissedFire[], now: number): MissedBand | null {
  if (missed.length === 0) return null;
  const sorted = missed.toSorted((first, second) => second.occurrence - first.occurrence);
  const newest = sorted[0]?.occurrence ?? now;
  const oldest = sorted.at(-1)?.occurrence ?? now;
  const count = sorted.reduce((sum, fire) => sum + fire.count, 0);
  const reasons = [...new Set(sorted.map((fire) => reasonOf(fire.reason)))];
  return {
    title: SCHEDULE_COPY.detail.runs.missedTitle(
      count,
      formatDate(oldest, 'en-US', { month: 'short', day: 'numeric' }),
    ),
    detail: reasons.join(', '),
    rows: sorted.map((fire) => ({
      key: `${String(fire.occurrence)}:${fire.reason}:${String(fire.recordedAt)}`,
      at: fire.occurrence,
      absolute: formatDateTime(fire.occurrence, { dayWords: false, now }),
      text: SCHEDULE_COPY.detail.runs.missedRow(fire.count, reasonOf(fire.reason)),
    })),
    newest,
    oldest,
  };
}

/** The runs and the missed band that sit below the Now marker, newest first. */
export type PastSection = {
  readonly band: MissedBand | null;
  readonly runs: readonly PastRunRow[];
};

/**
 * What sits below Now: the one band the missed fires fold into, then the runs. Each list is a page
 * of the newest, so a list that stopped at its page leaves out what is older than its last row
 * (`pastRows`), and the table never shows one kind with the other missing.
 */
export function pastSection(
  runs: readonly WorkflowSummary[],
  missed: readonly MissedFire[],
  truncated: PastRowsTruncation,
  now: number,
): PastSection {
  const rows = pastRows(runs, missed, truncated);
  return {
    band: missedBand(
      rows.flatMap((row) => (row.kind === 'missed' ? [row.missed] : [])),
      now,
    ),
    runs: rows.flatMap((row) => (row.kind === 'run' ? [pastRunOf(row.run, now)] : [])),
  };
}

/** A labelled break between two rows whose clocks differ: where daylight saving time began or ended. */
export type ClockBreak = {
  /** "Daylight saving time ended Nov 1". */
  readonly label: string;
  /** The instant the clock changed. */
  readonly at: number;
};

/** The minute of the UTC day an instant falls in. */
function utcMinuteOfDay(at: number): number {
  return Math.floor(at / MINUTE_MS) % (24 * 60);
}

/**
 * The break between a newer row and an older one, or `null` when there is nothing to explain. A
 * break marks where the viewer's clock changed, so the same cadence reading "4:00 AM" before the
 * change and "3:00 AM" after it does not look like a mistake: it is drawn only when the zone's
 * offset differs between the two rows and the rows fall at the same moment of the UTC day, which is
 * what a cadence that does not follow the viewer's clock does. A run someone started by hand, or a
 * cadence that follows the viewer's own clock, reads the same either side and needs none.
 */
export function clockBreak(newer: number, older: number, zone: string): ClockBreak | null {
  if (older >= newer) return null;
  const newerOffset = zoneOffsetMinutes(newer, zone);
  const olderOffset = zoneOffsetMinutes(older, zone);
  if (newerOffset === olderOffset) return null;
  if (utcMinuteOfDay(newer) !== utcMinuteOfDay(older)) return null;
  // The first minute at the newer offset, found by halving the span between the two rows.
  let low = older;
  let high = newer;
  while (high - low > MINUTE_MS) {
    const middle = Math.floor((low + high) / 2);
    if (zoneOffsetMinutes(middle, zone) === newerOffset) high = middle;
    else low = middle;
  }
  const day = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: zone,
  }).format(high);
  return {
    // Clocks that moved back end daylight saving time; ones that moved forward start it.
    label:
      newerOffset < olderOffset
        ? SCHEDULE_COPY.detail.runs.dstEnded(day)
        : SCHEDULE_COPY.detail.runs.dstStarted(day),
    at: high,
  };
}
