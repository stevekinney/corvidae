/**
 * What a schedule's page says, worked out from what the engine and the Bureau say of the schedule,
 * with no DOM in it (COR-2018, the heading and the details card of `ScheduleDetail`): the sentence
 * under the heading, the line that says when it runs next and when it last ran, why Run now is
 * off, the rows of the details card, and the input it sends. The words a row of the Schedules list
 * already says (the status word, the blockers, the agents, the workflow's name) come from
 * `scheduleRowOf`, so the list and the page never disagree about one schedule.
 */
import {
  describeScheduleFields,
  formatDateTime,
  formatRelativeTime,
  formatTimeOfDay,
  formatTimeZoneLabel,
  humanizeIdentifier,
  type ScheduleFieldSummary,
} from '@lostgradient/cinder';

import type { ScheduleSummary } from '@lostgradient/weft';

import { SCHEDULE_COPY } from '../../app/copy.ts';
import { AGENT_RUN_TYPE } from '../../lib/schedule-kinds.ts';
import type { WorkflowFileListing } from '../../lib/workflow-files.ts';
import { cadenceToScheduleValue, describeCadence } from './cadence.ts';
import { cadenceText } from './schedule-cadence-text.ts';
import { cadenceClause } from './schedule-presentation.ts';
import type { RowBlocker, ScheduleRow } from './schedule-row-model.ts';

/** The cadence as the end of the sentence under the heading: "every day at 3:00 AM (9:00 AM UTC)". */
export function sentenceCadence(schedule: ScheduleSummary, now: number): string {
  const text = cadenceText(schedule, now);
  // A cadence with no single clock time is said in `describeCadence`'s words, as the sentence always has.
  if (text.full === describeCadence(schedule)) return cadenceClause(schedule);
  return `${text.full.charAt(0).toLowerCase()}${text.full.slice(1)}`;
}

/**
 * How long ago a run that is going started, spelled out: "38 seconds ago", "5 minutes ago", "2 hours
 * ago". A run that has gone for under a minute still says its seconds, because the line it sits in is
 * the one that says it is going.
 */
export function startedAgo(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) {
    return new Intl.RelativeTimeFormat('en-US', { numeric: 'always', style: 'long' }).format(
      -seconds,
      'second',
    );
  }
  return formatRelativeTime(startedAt, { now, units: 'spelled' });
}

/** One part of the line that says when the schedule runs next. */
export type SummaryPart = {
  readonly text: string;
  /** `warning` is a run that is due and will not start. */
  readonly tone?: 'warning';
};

/**
 * The first half of the summary line: when it runs next, and with what the viewer sees of it.
 * "Next Tue Nov 3, 3:00 AM (in 16 hours)", "No next run while paused", and for a schedule that is
 * due and will not start "Due today, 11:00 AM (in 14 minutes)" then "won't start", both in amber (row 72z).
 */
export function nextSummary(
  schedule: Pick<ScheduleSummary, 'nextFireAt'>,
  row: Pick<ScheduleRow, 'status' | 'blockers'>,
  now: number,
  /**
   * Leave out "in 16 hours". The page shows old data while the server cannot answer, which would
   * make it a claim the page cannot keep, and a line that already says a run is going gives its
   * words to that.
   */
  stale = false,
): readonly SummaryPart[] {
  if (row.status === 'paused') return [{ text: SCHEDULE_COPY.detail.summary.pausedNext }];
  if (row.status !== 'active' || schedule.nextFireAt === null) {
    return [{ text: SCHEDULE_COPY.detail.summary.noNext }];
  }
  const at = schedule.nextFireAt;
  const day = formatDateTime(at, { dayWords: false, now });
  const relative = formatRelativeTime(at, { now, units: 'spelled' });
  // Beyond the range of relative time the formatter answers with the date, which the line already
  // says: the parenthetical is left out then, as it is when the page cannot keep a claim of "in 4 hours".
  const saysRelative = !stale && /^in /.test(relative);
  if (row.blockers.length === 0) {
    return [
      {
        text: !saysRelative
          ? SCHEDULE_COPY.detail.summary.nextStale(day)
          : SCHEDULE_COPY.detail.summary.next(day, relative),
      },
    ];
  }
  const today = formatDateTime(at, { dayWords: 'today', now }).startsWith('Today, ');
  const due = today ? `today, ${formatTimeOfDay(at)}` : day;
  return [
    {
      text: !saysRelative
        ? SCHEDULE_COPY.detail.summary.dueStale(due)
        : SCHEDULE_COPY.detail.summary.due(due, relative),
      tone: 'warning',
    },
    { text: SCHEDULE_COPY.detail.summary.wontStart, tone: 'warning' },
  ];
}

/**
 * The line a JSON parser stopped at, from what it said: Chrome and Firefox name it ("line 12
 * column 3") or the position it stopped at ("at position 289"), which counts the lines before it.
 * A parser that names neither (Safari's) leaves it unsaid.
 */
export function lineOfParseError(message: string, text: string): number | undefined {
  const named = /\bline (\d+)\b/i.exec(message)?.[1];
  if (named !== undefined) return Number(named);
  const position = /\bposition (\d+)\b/i.exec(message)?.[1];
  if (position === undefined) return undefined;
  return text.slice(0, Number(position)).split('\n').length;
}

/** The line a workflow file's text stops parsing at, or `undefined` when it parses or the parser does not say. */
export function jsonProblemLine(text: string): number | undefined {
  try {
    JSON.parse(text);
    return undefined;
  } catch (error) {
    return error instanceof Error ? lineOfParseError(error.message, text) : undefined;
  }
}

/**
 * Where a workflow's file went wrong, as the blocker card says it: "order-refund,
 * order-refund.json line 12", or the type alone when no line is known.
 */
export function problemLocation(workflowType: string, line: number | undefined): string {
  return line === undefined
    ? workflowType
    : `${workflowType}, ${workflowType}.json line ${String(line)}`;
}

/** The reason one blocker gives for Run now being off, in a sentence. */
function blockerReason(blocker: RowBlocker): string {
  switch (blocker.kind) {
    case 'cannot-load':
      return SCHEDULE_COPY.detail.runNowOff.cannotLoad(blocker.label);
    case 'deleted':
      return SCHEDULE_COPY.detail.runNowOff.deleted(blocker.workflowType);
    case 'provider':
      return SCHEDULE_COPY.detail.runNowOff.provider;
  }
}

/**
 * Why Run now is off, or `null` when it is on. A run cannot start while the workflow's file cannot
 * load or was deleted, or while no model provider is connected and an agent it runs needs a model;
 * a schedule on Assistant, which is scripted, is never held by a provider. Several reasons are said
 * in the order the row says them.
 */
export function runNowOffReason(row: Pick<ScheduleRow, 'allBlockers'>): string | null {
  if (row.allBlockers.length === 0) return null;
  return row.allBlockers.map(blockerReason).join(' ');
}

/** The rows of the When group: Repeats, At and Time zone, as the New schedule form words them. */
export function whenRows(schedule: ScheduleSummary): readonly ScheduleFieldSummary[] {
  return describeScheduleFields(cadenceToScheduleValue(schedule));
}

/**
 * The sentence under When that says the same time in the viewer's zone: "That is 3:00 AM in
 * Central time." It says nothing for a schedule with no clock time, or one whose own zone reads
 * the same clock as the viewer's: the cadence's words carry the viewer's reading in front of the
 * schedule's own in parentheses only when the two differ.
 */
export function viewerClockNote(schedule: ScheduleSummary, now: number): string | null {
  const own = / at (\d{1,2}:\d{2} [AP]M) \(/.exec(cadenceText(schedule, now).full)?.[1];
  if (own === undefined) return null;
  return SCHEDULE_COPY.detail.card.viewerClock(own, formatTimeZoneLabel(now, { style: 'long' }));
}

/** The fixed values a workflow file's trigger sends on every fire, or `undefined` when it sends none. */
export function triggerInput(
  file: WorkflowFileListing,
): Readonly<Record<string, unknown>> | undefined {
  const input: unknown = file.trigger?.['input'];
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input))
    : undefined;
}

/**
 * Whether a schedule is defined by its workflow's file: the file's trigger fixes the values it
 * sends each time, so the file is the only place to change it. A trigger that sends no input is
 * a schedule made for the workflow, which Edit opens.
 */
export function isFileDefined(file: WorkflowFileListing): boolean {
  return triggerInput(file) !== undefined;
}

/** What each fire sends, as the details card shows it: the values as labelled fields, and as JSON. */
export type ScheduleInput = {
  readonly fields: readonly { readonly label: string; readonly value: string }[];
  /** The payload, for the JSON view and the copy button. */
  readonly payload: Readonly<Record<string, unknown>>;
};

function fieldText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/**
 * The input a schedule sends, or `undefined` when the workflow has none to show: the message of a
 * chat the Bureau says the start of, and the fixed values of a workflow file's trigger.
 */
export function scheduleInput(
  schedule: Pick<ScheduleSummary, 'workflowType'>,
  message: string | undefined,
  file: WorkflowFileListing | undefined,
): ScheduleInput | undefined {
  if (schedule.workflowType === AGENT_RUN_TYPE) {
    if (message === undefined) return undefined;
    return {
      fields: [{ label: SCHEDULE_COPY.detail.card.messageLabel, value: message }],
      payload: { message },
    };
  }
  const values = file === undefined ? undefined : triggerInput(file);
  if (values === undefined) return undefined;
  return {
    fields: Object.entries(values).map(([key, value]) => ({
      label: humanizeIdentifier(key, { casing: 'sentence' }),
      value: fieldText(value),
    })),
    payload: values,
  };
}
