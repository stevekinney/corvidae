/**
 * The lines a run logged, from the engine's log store (`weft.workflows.logs.list`), which keeps
 * them with the run: they are there after the run ends and after the host restarts, until the
 * retention window passes. The run's Details shows them whole, oldest first.
 *
 * A line is not placed under a step. A line's `step` counts the context positions the run had used
 * when it logged, and a timeline entry's step is its checkpoint key; a signal resume, a retry,
 * `runAll`, a rolled-back `speculate`, a session write, a repeated memo key, a fork or a nested
 * group moves one without the other, so no walk of the timeline can map them (COR-1988).
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
