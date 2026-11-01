/**
 * The lines a run logged, from the engine's log store (`weft.workflows.logs.list`), which keeps
 * them with the run: they are there after the run ends and after the host restarts, until the
 * retention window passes. The Details rail lists them whole, oldest first, and the Steps section
 * shows each step's share beside it.
 *
 * ## Placing a line under a step
 *
 * A line's `step` is the index of the durable step it was logged in front of, and a timeline
 * entry's `stepIndex` is the index of the step the operation occupies (COR-1988), so the two compare
 * directly. A line goes under the entry with the greatest `stepIndex` that is not past the line's
 * `step`: a step takes the lines logged in front of it and the lines logged after it, up to the
 * next entry. Several entries can share an index (each attempt of a retried activity), and the
 * line goes to the earliest of them by checkpoint key. An operation that takes an index without
 * writing an entry (a session state write, a repeated memo key) leaves a gap, and the lines in it
 * stay with the entry before it. A line before every entry is kept apart, as the lines logged
 * before the first step.
 *
 * The engine's `?step=<n>` filter is a different rule: it returns the lines logged before step
 * `n`, an exact bound. The page reads the whole log once and groups it, so the two never meet.
 *
 * A run whose entries predate `stepIndex`, or a line with no step, cannot be placed, and the page
 * shows the whole log alone.
 */
import type { HttpClient } from '@lostgradient/weft';
import type { QueryKey } from '@tanstack/svelte-query';

/** The operation the log lines are read with. */
export const LOGS_OPERATION = 'weft.workflows.logs.list';

/** What the page needs of the client: absent on an engine that does not offer log lines. */
export interface LogsClient {
  readonly operations: Partial<Pick<HttpClient['operations'], typeof LOGS_OPERATION>>;
}

/** One stored line, as the engine returns it. */
export type RunLogLine = Awaited<
  ReturnType<HttpClient['operations'][typeof LOGS_OPERATION]>
>['lines'][number];

/** A run's lines, oldest first, and how many older ones the per-run cap or retention removed. */
export interface RunLogs {
  readonly lines: readonly RunLogLine[];
  readonly dropped: number;
}

/** The key of a run's log query. The fleet feed invalidates it with the run's other reads. */
export function workflowLogsQueryKey(workflowId: string): QueryKey {
  return ['workflows', 'logs', workflowId];
}

/** Reads a run's lines. An engine without the operation has none to show. */
export async function fetchRunLogs(client: LogsClient, workflowId: string): Promise<RunLogs> {
  const list = client.operations[LOGS_OPERATION];
  if (list === undefined) return { lines: [], dropped: 0 };
  const result = await list({ workflowId });
  return { lines: result.lines, dropped: result.dropped };
}

/**
 * Where a run's lines belong. `by-step` holds the lines logged before the first step, and for each
 * entry (by its checkpoint key, `WorkflowTimelineEntry.step`) the lines placed under it, oldest
 * first. `whole-run` means the lines cannot be placed.
 */
export type LogPlacement =
  | {
      readonly kind: 'by-step';
      readonly beforeFirst: readonly RunLogLine[];
      readonly byStep: ReadonlyMap<number, readonly RunLogLine[]>;
    }
  | { readonly kind: 'whole-run' };

/** The part of a timeline entry that placement reads. */
export interface PlacedEntry {
  /** The checkpoint key. */
  readonly step: number;
  /** The index of the durable step the entry occupies; absent on an entry from an older run. */
  readonly stepIndex?: number | undefined;
}

/** Places a run's lines under its timeline entries, as the module header describes. */
export function placeLogLines(
  entries: readonly PlacedEntry[],
  lines: readonly RunLogLine[],
): LogPlacement {
  // One owner per step index: the earliest entry by checkpoint key.
  const owners = new Map<number, number>();
  for (const entry of entries) {
    if (entry.stepIndex === undefined) return { kind: 'whole-run' };
    const owner = owners.get(entry.stepIndex);
    if (owner === undefined || entry.step < owner) owners.set(entry.stepIndex, entry.step);
  }
  const indexes = [...owners.keys()].sort((first, second) => first - second);

  const beforeFirst: RunLogLine[] = [];
  const byStep = new Map<number, RunLogLine[]>();
  for (const line of lines) {
    if (line.step === null) return { kind: 'whole-run' };
    const index = greatestAtMost(indexes, line.step);
    const owner = index === undefined ? undefined : owners.get(index);
    if (owner === undefined) {
      beforeFirst.push(line);
      continue;
    }
    const grouped = byStep.get(owner);
    if (grouped === undefined) byStep.set(owner, [line]);
    else grouped.push(line);
  }
  return { kind: 'by-step', beforeFirst, byStep };
}

/** The greatest value in an ascending list that is at most `limit`, by binary search. */
function greatestAtMost(ascending: readonly number[], limit: number): number | undefined {
  let low = 0;
  let high = ascending.length - 1;
  let found: number | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = ascending[middle];
    if (value === undefined) break;
    if (value <= limit) {
      found = value;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}
