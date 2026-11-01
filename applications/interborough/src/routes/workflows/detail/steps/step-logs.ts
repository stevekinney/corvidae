/**
 * The lines a run logged, from the engine's log store (`weft.workflows.logs.list`), which keeps
 * them with the run: they are there after the run ends and after the host restarts, until the
 * retention window passes. One read serves the step detail and the run's Details, so both share a
 * query key and the lines are fetched once.
 *
 * A line's `step` is the number of durable operations the run had completed when it logged, so the
 * line was written just before the operation with that number. It is how a line finds its step
 * (see {@link linesByTimelineStep}). The last lines of a run, logged after its final step, belong
 * to no step, and so do lines stored without one; they appear only in the run's whole log.
 */
import type { HttpClient, WorkflowTimelineEntry } from '@lostgradient/weft';
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

/** The operations a timeline entry stands for in the run's step count, or `undefined` when it cannot be told. */
function operationsOf(entry: WorkflowTimelineEntry): number | undefined {
  const isGroup =
    entry.operationType === 'race' ||
    entry.operationType === 'parallel' ||
    entry.operationType === 'run-all' ||
    entry.operationType === 'speculate';
  if (!isGroup) return 1;
  const speculative = entry.operationType === 'speculate';
  const details = speculative ? entry.children : entry.branches;
  if (details === undefined) return undefined;
  const omitted = speculative ? entry.childrenOmitted : entry.branchesOmitted;
  // The group is one operation of its own, and each branch is another.
  return 1 + details.length + (omitted ?? 0);
}

/**
 * The lines each timeline step logged before or while it ran, by the step's number in the timeline.
 *
 * A line's `step` counts every durable operation the run had completed, and a group of branches
 * (`race`, `all`, `speculate`) counts as the group and each of its branches, while the timeline
 * lists the group as one entry. So the two numberings agree only until the first group, and the
 * lines are placed by walking the timeline in order and giving each entry the span of operation
 * numbers it stands for. An entry whose branches the engine did not report has a span nobody can
 * state, so the walk stops there: lines from that point on belong to no step and appear only in the
 * run's whole log. A line whose number is past the last entry (it was logged after the final step)
 * belongs to no step either.
 */
export function linesByTimelineStep(
  lines: readonly RunLogLine[],
  entries: readonly WorkflowTimelineEntry[],
): ReadonlyMap<number, readonly RunLogLine[]> {
  const spans: { readonly step: number; readonly start: number; readonly end: number }[] = [];
  let start = 0;
  for (const entry of entries.toSorted((a, b) => a.step - b.step)) {
    const operations = operationsOf(entry);
    if (operations === undefined) break;
    spans.push({ step: entry.step, start, end: start + operations });
    start += operations;
  }

  const grouped = new Map<number, RunLogLine[]>();
  for (const line of lines) {
    if (line.step === null) continue;
    const lineStep = line.step;
    let low = 0;
    let high = spans.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const span = spans[middle]!;
      if (lineStep < span.start) high = middle - 1;
      else if (lineStep >= span.end) low = middle + 1;
      else {
        const group = grouped.get(span.step);
        if (group === undefined) grouped.set(span.step, [line]);
        else group.push(line);
        break;
      }
    }
  }
  return grouped;
}
