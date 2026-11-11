/**
 * What the Workflows area says of a catalog row, a file's steps, and its trigger, in the words
 * `copy.ts` holds. Plain functions over data, so the rows and the labels are tested without a
 * page.
 */
import { humanizeIdentifier } from '@lostgradient/cinder';

import { WORKFLOW_COPY } from '../../app/copy.ts';
import { calendarDay, clockTime, rowTime, viewerTimeZone } from '../../lib/format/clock.ts';
import type {
  CatalogRow,
  CodeActivity,
  DefinitionDetail,
  InternalActivity,
} from '../../lib/workflow-catalog.ts';
import type { WorkflowRunCounts } from '../../lib/workflow-files.ts';
import { describeCadence } from '../schedules/cadence.ts';

/** The segments above the list: every workflow, the paused ones, and the ones that cannot load. */
export type ListSegment = 'all' | 'paused' | 'problems';

/** Whether a workflow cannot be used: its file is invalid, or the engine failed to load its source. */
export function hasProblem(row: CatalogRow): boolean {
  return row.file?.state === 'invalid' || row.failure !== null;
}

/**
 * The one segment a row belongs to besides All: a problem first, because a file that cannot load
 * is not also read as paused, then paused, else none. Both the filter and the counts read this, so
 * a segment's number is the number of rows it shows.
 */
export function rowSegment(row: CatalogRow): Exclude<ListSegment, 'all'> | null {
  if (hasProblem(row)) return 'problems';
  return row.file?.paused === true ? 'paused' : null;
}

/** Whether a row shows under a segment. */
export function inSegment(row: CatalogRow, segment: ListSegment): boolean {
  return segment === 'all' || rowSegment(row) === segment;
}

/** How many of `rows` each segment shows, counted from the rows themselves. */
export function segmentCounts(rows: readonly CatalogRow[]): Record<ListSegment, number> {
  return {
    all: rows.length,
    paused: rows.filter((row) => inSegment(row, 'paused')).length,
    problems: rows.filter((row) => inSegment(row, 'problems')).length,
  };
}

/** The rows in the order the list shows them: those that cannot load first, the rest as the catalog sorts them. */
export function sortListRows(rows: readonly CatalogRow[]): CatalogRow[] {
  return rows.toSorted((first, second) => Number(hasProblem(second)) - Number(hasProblem(first)));
}

/** One part of the line under a row's title. */
export type LinePart = {
  readonly text: string;
  /** The part is the run in progress: a solid dot and the word, in the info tone. */
  readonly status?: 'Running';
  /** The test id of the element that carries the part. */
  readonly testId?: string;
};

/** The two words a row's status column can carry. */
export type ListStatusWord =
  typeof WORKFLOW_COPY.list.statusCantLoad | typeof WORKFLOW_COPY.list.statusPaused;

/** What the list shows of one workflow, as Cinder's status-first row says it. */
export type WorkflowListRow = {
  /** The identifier: the file's name without `.json`, and the name of the type in the engine. */
  readonly name: string;
  /** The title the file gives, or `null`: a file with none is shown by its identifier alone. */
  readonly title: string | null;
  /** The status word: only a workflow that cannot load or is paused has one. */
  readonly statusWord: ListStatusWord | null;
  /** The right edge of line one, or `null` while the engine has not said. */
  readonly date: string | null;
  /** Line two. */
  readonly line: readonly LinePart[];
};

/** The year of an instant in a zone. */
function yearOf(at: number, zone: string): string {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: zone }).format(at);
}

/**
 * When something last happened, for the right edge of a row: the clock for today ("10:42 AM"), and
 * the day for any other ("Oct 30"), with the year when it is not this one.
 */
export function listDate(at: number, now: number, zone: string = viewerTimeZone()): string {
  if (calendarDay(at, zone) >= calendarDay(now, zone)) return clockTime(at, zone);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(yearOf(at, zone) === yearOf(now, zone) ? {} : { year: 'numeric' as const }),
    timeZone: zone,
  }).format(at);
}

/**
 * The right edge of a row: when the newest run began, "Never run" for a workflow with none, and
 * when the run in progress began ("Started 10:45 AM") while one is going. `null` when the engine
 * has not said, so a count that could not be read is never shown as never run.
 */
export function rowDate(
  runs: WorkflowRunCounts | null | undefined,
  now: number,
  zone: string = viewerTimeZone(),
): string | null {
  // No counts is not zero runs: a file the Bureau cannot use is not counted by the Bureau, so its
  // date waits for the engine's own count of its type, and stays blank if the engine will not say.
  if (runs === null || runs === undefined) return null;
  if (runs.lastRunAt === null) return WORKFLOW_COPY.list.neverRun;
  const at = Date.parse(runs.lastRunAt);
  if (Number.isNaN(at)) return null;
  return runs.active > 0
    ? WORKFLOW_COPY.list.started(rowTime(at, now, zone))
    : listDate(at, now, zone);
}

/**
 * Line two of a row. A file the Bureau cannot use names its file and the problem. Any other says
 * what failed to load for a source the engine could not load, then the run in progress, the steps
 * of the file, and how many runs began in the last 24 hours. The date is never repeated here.
 */
export function rowLine(row: CatalogRow, runs: WorkflowRunCounts | null | undefined): LinePart[] {
  if (row.file?.state === 'invalid') {
    return [
      { text: WORKFLOW_COPY.list.fileName(row.name) },
      ...(row.problem === null ? [] : [{ text: row.problem.message, testId: 'workflow-problem' }]),
    ];
  }
  const parts: LinePart[] = [];
  if (row.failure !== null) {
    parts.push({ text: WORKFLOW_COPY.sourceFailed(row.failure), testId: 'workflow-failure' });
  }
  if (runs !== null && runs !== undefined && runs.active > 0) {
    parts.push({ text: WORKFLOW_COPY.list.runningNow, status: 'Running' });
  }
  const steps = row.file?.steps;
  if (steps !== null && steps !== undefined) {
    parts.push({ text: WORKFLOW_COPY.list.steps(steps.length) });
  }
  if (runs !== null && runs !== undefined && runs.last24Hours > 0) {
    parts.push({ text: WORKFLOW_COPY.list.runs(runs.last24Hours), testId: 'workflow-run-counts' });
  }
  return parts;
}

/**
 * One workflow as the list's status-first row. The counts of a code-defined type, and of a file the
 * Bureau cannot use, come from the engine apart from the list (`activity`), and read as nothing
 * until they arrive and when the engine would not give them.
 */
export function workflowListRow(
  row: CatalogRow,
  activity: CodeActivity | undefined,
  now: number = Date.now(),
  zone: string = viewerTimeZone(),
): WorkflowListRow {
  // The Bureau counts a file that loaded. A code-defined type, and a file the Bureau cannot use,
  // are counted by the engine apart from the list, by the name of the type.
  const runs = row.kind === 'code' ? activity?.runs : (row.runs ?? activity?.runs);
  const title = row.file?.title?.trim() ?? '';
  const segment = rowSegment(row);
  return {
    name: row.name,
    title: title === '' ? null : title,
    statusWord:
      segment === 'problems'
        ? WORKFLOW_COPY.list.statusCantLoad
        : segment === 'paused'
          ? WORKFLOW_COPY.list.statusPaused
          : null,
    date: rowDate(runs, now, zone),
    line: rowLine(row, runs),
  };
}

/** What a person calls a type Interborough runs itself, and what it does. */
export type InternalWords = { readonly title: string; readonly description: string | null };

/**
 * The internal types in the order the page lists them: those Interborough has words for, in the
 * order `WORKFLOW_COPY.internal.types` gives them, then any other as the catalog sorts them.
 */
export function sortInternalRows(rows: readonly CatalogRow[]): CatalogRow[] {
  const known = Object.keys(WORKFLOW_COPY.internal.types);
  const position = (name: string): number => {
    const index = known.indexOf(name);
    return index === -1 ? known.length : index;
  };
  return rows.toSorted((first, second) => position(first.name) - position(second.name));
}

/**
 * The name and the line on what an internal type does: the words Interborough gives it, else the
 * identifier in words and the engine's own description.
 */
export function internalWords(name: string, description: string | null): InternalWords {
  const types = WORKFLOW_COPY.internal.types;
  if (Object.hasOwn(types, name)) {
    const known = types[name as keyof typeof types];
    return { title: known.title, description: known.description };
  }
  return { title: humanizeIdentifier(name), description };
}

/** "Today, 10:42 AM" for today, and "Oct 30, 10:07 AM" for any other day. */
function stamp(at: number, now: number, zone: string): string {
  const clock = clockTime(at, zone);
  return calendarDay(at, zone) >= calendarDay(now, zone)
    ? `Today, ${clock}`
    : `${listDate(at, now, zone)}, ${clock}`;
}

/** The Runs and Last run cells of an internal type: blank while the engine has not said, never zero. */
export function internalCells(
  activity: InternalActivity | null | undefined,
  now: number,
  zone: string = viewerTimeZone(),
): { readonly runs: string | null; readonly lastRun: string | null } {
  if (activity === null || activity === undefined) return { runs: null, lastRun: null };
  const runs = String(activity.runs);
  if (activity.lastRunAt === null) return { runs, lastRun: WORKFLOW_COPY.internal.neverRun };
  const at = Date.parse(activity.lastRunAt);
  if (Number.isNaN(at)) return { runs, lastRun: null };
  return { runs, lastRun: stamp(at, now, zone) };
}

type Described = { readonly kind: string; readonly [key: string]: unknown };

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One step in words. */
export function stepLabel(step: Described): string {
  switch (step.kind) {
    case 'activity': {
      const handler = text(step['handler']) ?? 'activity';
      const input = step['input'];
      if (handler === 'agent' && isRecord(input)) {
        const agent = text(input['agent']);
        const message = text(input['message']);
        if (agent !== undefined && message !== undefined) {
          return WORKFLOW_COPY.steps.agent(agent, message);
        }
      }
      return WORKFLOW_COPY.steps.activity(handler);
    }
    case 'sleep':
      return WORKFLOW_COPY.steps.sleep(text(step['duration']) ?? '');
    case 'await-signal':
      return WORKFLOW_COPY.steps.awaitSignal(text(step['signal']) ?? '');
    default:
      return WORKFLOW_COPY.steps.unknown(step.kind);
  }
}

/** A trigger in words. */
export function triggerLabel(trigger: Described): string {
  switch (trigger.kind) {
    case 'schedule':
      return WORKFLOW_COPY.triggers.schedule(
        text(trigger['spec']) ?? '',
        text(trigger['overlap']) ?? null,
      );
    case 'signal':
      return WORKFLOW_COPY.triggers.signal(text(trigger['name']) ?? '');
    default:
      return WORKFLOW_COPY.triggers.unknown(trigger.kind);
  }
}

/** A schedule's cadence in words. */
export function scheduleLabel(cadence: {
  readonly cronExpression?: string;
  readonly intervalMs?: number;
}): string {
  return describeCadence(cadence);
}

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** The grammar the Bureau accepts for a duration `spec`: a number, then a unit or its word. */
const DURATION_SPEC =
  /^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?)$/i;

/**
 * A `schedule` trigger's `spec` as the cadence the schedules area words. The Bureau reads a
 * duration (`1h`, `30 seconds`) as an interval and everything else as a cron expression, so this
 * does too, and `describeCadence` then says it as it does for a schedule.
 */
export function specCadence(spec: string): {
  readonly cronExpression?: string;
  readonly intervalMs?: number;
} {
  const trimmed = spec.trim();
  const match = DURATION_SPEC.exec(trimmed);
  const amount = match?.[1];
  const word = match?.[2]?.toLowerCase();
  if (amount === undefined || word === undefined) return { cronExpression: trimmed };
  const scale = word === 'ms' || word.startsWith('milli') ? 1 : UNIT_MS[word.charAt(0)];
  if (scale === undefined) return { cronExpression: trimmed };
  return { intervalMs: Math.round(Number(amount) * scale) };
}

/** What starts a workflow, for a row: a cadence in words, or the signal that does. */
export type TriggerSummary =
  | {
      readonly kind: 'schedule';
      readonly words: string;
      /** How many schedules start the type, when it is more than one. */
      readonly count?: number;
    }
  | { readonly kind: 'signal'; readonly name: string };

/** A file's trigger as a row says it, or `null` for a file that has none to read. */
export function triggerSummary(
  trigger: Readonly<Record<string, unknown>> | null,
): TriggerSummary | null {
  if (trigger === null) return null;
  if (trigger['kind'] === 'schedule' && typeof trigger['spec'] === 'string') {
    return { kind: 'schedule', words: describeCadence(specCadence(trigger['spec'])) };
  }
  if (trigger['kind'] === 'signal' && typeof trigger['name'] === 'string') {
    return { kind: 'signal', name: trigger['name'] };
  }
  return null;
}

/** The schedules that start a code-defined type, as a row says them: one in words, several by count. */
export function schedulesSummary(
  schedules: readonly { readonly cronExpression?: string; readonly intervalMs?: number }[] | null,
): TriggerSummary | null {
  if (schedules === null || schedules.length === 0) return null;
  const [only] = schedules;
  if (schedules.length === 1 && only !== undefined) {
    return { kind: 'schedule', words: describeCadence(only) };
  }
  return {
    kind: 'schedule',
    words: WORKFLOW_COPY.list.schedules(schedules.length),
    count: schedules.length,
  };
}

/** What the engine's contract says of a type, keeping only what it says: nothing is padded with "None". */
export type DefinitionDetails = {
  readonly signals: readonly string[];
  readonly updates: readonly string[];
  readonly queries: readonly string[];
};

/** The parts of a type's contract worth listing: its signals (passed in), updates, and queries. */
export function definitionDetails(
  definition: DefinitionDetail | undefined,
  signals: readonly string[],
): DefinitionDetails {
  return {
    signals,
    updates: definition?.updates ?? [],
    queries: definition?.queries ?? [],
  };
}

/** Whether the contract lists anything, so the facts show only what the workflow has. */
export function hasDefinitionDetails(details: DefinitionDetails): boolean {
  return details.signals.length > 0 || details.updates.length > 0 || details.queries.length > 0;
}

/**
 * The JSON Schema a workflow's input or output is held to: the file's own when it declares one,
 * else the engine's contract for the type (a code-defined type's, or the one a ready file loaded as).
 * `undefined` when neither declares one.
 */
export function schemaOf(
  declared: Readonly<Record<string, unknown>> | null | undefined,
  definition: DefinitionDetail | undefined,
  key: 'inputSchema' | 'outputSchema',
): unknown {
  if (declared !== null && declared !== undefined) return declared;
  const fromContract = definition?.contract?.[key];
  return fromContract === null ? undefined : fromContract;
}
