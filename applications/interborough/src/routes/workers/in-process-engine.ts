/**
 * Whether the Workers page has nothing to operate: no worker is connected, no deployment has
 * reported, and no task queue exists, so the engine runs its work in-process and the page's tabs
 * would be zeros. A queue with a task in it is remote work whose ledger the Diagnostics tab reads,
 * and an address that opens one worker, queue, task, or diagnostic asks for it by name (the Overview
 * alerts link to `/workers?diagnostic=<kind>`), so either keeps the full page.
 *
 * The queue list names only queues with pending tasks, so a task that dead-lettered after its worker
 * disconnected leaves no queue behind. The diagnostics read counts it, and any count in it (a dead
 * letter, a stuck or stale task, a delayed one) is remote work Diagnostics has to show, so a
 * non-zero count keeps the full page too. The caller has read all three successfully: a read that
 * failed or is still loading says nothing about the fleet.
 */
import type {
  TaskDiagnosticsOutput,
  TaskQueuesListOutput,
  WorkersListOutput,
} from './worker-catalog-types.ts';

/** The address parameters that name something the full page shows. */
const NAMING_PARAMETERS = ['worker', 'queue', 'task', 'diagnostic'] as const;

export function runsInProcessOnly(
  workers: WorkersListOutput,
  queues: TaskQueuesListOutput,
  diagnostics: TaskDiagnosticsOutput,
  search: URLSearchParams,
): boolean {
  return (
    workers.items.length === 0 &&
    workers.deployments.length === 0 &&
    queues.items.length === 0 &&
    Object.values(diagnostics.summary).every((count) => count === 0) &&
    !NAMING_PARAMETERS.some((name) => search.has(name))
  );
}
