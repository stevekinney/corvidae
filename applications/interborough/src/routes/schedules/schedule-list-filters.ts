/**
 * How the Schedules list narrows its rows, with no DOM in it. The address owns the filters so a
 * filtered list can be shared: `status` is a segment (`active` or `paused`; no value is All),
 * `missed` is the Missed runs chip, and `agent` and `workflow` are the add-facet chips. The
 * segments partition the list (All = Active + Paused), and "Missed runs" is a facet over Active, not
 * a fourth segment, because a schedule that missed runs is both Active and missed. The counts on the
 * segments and the chip are those of the rows the agent and workflow chips leave, so they say what
 * choosing each would show.
 */
import type { ScheduleRow } from './schedule-row-model.ts';

/** The segments of the filter bar. */
export type ScheduleSegment = 'all' | 'active' | 'paused';

/** What the address asks the list to show. */
export type ScheduleListFilters = {
  readonly status: ScheduleSegment;
  readonly missed: boolean;
  readonly agent: string | undefined;
  readonly workflow: string | undefined;
};

/** Reads the filters out of the address's query string; a value that names nothing is left out. */
export function filtersFromSearch(search: URLSearchParams): ScheduleListFilters {
  const status = search.get('status');
  return {
    status: status === 'active' || status === 'paused' ? status : 'all',
    missed: search.get('missed') === '1',
    agent: search.get('agent') || undefined,
    workflow: search.get('workflow') || undefined,
  };
}

/** The rows the agent and workflow chips leave. */
export function narrowByFacets(
  rows: readonly ScheduleRow[],
  filters: Pick<ScheduleListFilters, 'agent' | 'workflow'>,
): ScheduleRow[] {
  return rows.filter(
    (row) =>
      (filters.agent === undefined || row.agentIds.includes(filters.agent)) &&
      (filters.workflow === undefined || row.workflowType === filters.workflow),
  );
}

/** The counts the segments and the Missed runs chip carry. */
export type ScheduleCounts = {
  readonly all: number;
  readonly active: number;
  readonly paused: number;
  readonly missed: number;
};

/** Counts the rows the facets left. A deleted workflow's schedule is paused, so it counts there. */
export function countRows(rows: readonly ScheduleRow[]): ScheduleCounts {
  return {
    all: rows.length,
    active: rows.filter((row) => row.status === 'active').length,
    paused: rows.filter((row) => row.status === 'paused').length,
    missed: rows.filter((row) => row.missedCount > 0 && row.statusKey === 'missed').length,
  };
}

/** The rows the segment and the Missed runs chip leave of those the facets left. */
export function narrowByView(
  rows: readonly ScheduleRow[],
  filters: Pick<ScheduleListFilters, 'status' | 'missed'>,
): ScheduleRow[] {
  return rows.filter(
    (row) =>
      (filters.status === 'all' || row.status === filters.status) &&
      (!filters.missed || row.statusKey === 'missed'),
  );
}

/** Whether any filter narrows the list, so an empty result is "no match" and not "no schedules". */
export function isFiltered(filters: ScheduleListFilters): boolean {
  return (
    filters.status !== 'all' ||
    filters.missed ||
    filters.agent !== undefined ||
    filters.workflow !== undefined
  );
}

/** The names the filtered-to-nothing sentence calls the agent and the workflow by. */
export type NoMatchLabels = {
  /** The agent the Agent chip names, as a person reads it ("Tool runner"). */
  readonly agent?: string | undefined;
  /** The workflow the Workflow chip names, as a person reads it ("Release notes"). */
  readonly workflow?: string | undefined;
};

/** Joins the facets a person could change: "status", "status or agent", "status, agent or workflow". */
function orList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1) ?? ''}`;
}

/**
 * The sentence under "No schedules match these filters": who has none of what, then what to change.
 * "Tool runner has no paused schedules. Try another status or agent." The agent comes first as the
 * subject, then the workflow, and a list with neither says what no schedule is ("No schedules are
 * paused."). The hint names only the facets that are applied, and the Missed runs chip alone has
 * none to name, so it says "Try another filter."
 */
export function noMatchDescription(
  filters: ScheduleListFilters,
  labels: NoMatchLabels = {},
): string {
  const status = filters.status === 'all' ? undefined : filters.status;
  const subject = filters.agent === undefined ? undefined : (labels.agent ?? filters.agent);
  const workflow =
    filters.workflow === undefined ? undefined : (labels.workflow ?? filters.workflow);
  const kind = [status, 'schedules'].filter((word) => word !== undefined).join(' ');

  let sentence: string;
  if (subject !== undefined) {
    const qualifier = filters.missed ? ' that missed runs' : '';
    const forWorkflow = workflow === undefined ? '' : ` for ${workflow}`;
    sentence = `${subject} has no ${kind}${qualifier}${forWorkflow}.`;
  } else if (workflow !== undefined) {
    const qualifier = filters.missed ? ' that missed runs' : '';
    sentence = `${workflow} has no ${kind}${qualifier}.`;
  } else if (filters.missed) {
    sentence = `No ${kind} have missed runs.`;
  } else if (status !== undefined) {
    sentence = `No schedules are ${status}.`;
  } else {
    sentence = 'No schedules match.';
  }

  const hints = [
    ...(status === undefined ? [] : ['status']),
    ...(filters.agent === undefined ? [] : ['agent']),
    ...(filters.workflow === undefined ? [] : ['workflow']),
  ];
  return `${sentence} Try another ${hints.length === 0 ? 'filter' : orList(hints)}.`;
}
