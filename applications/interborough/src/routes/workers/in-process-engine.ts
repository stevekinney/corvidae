/**
 * Whether the Workers page has nothing to operate: no worker is connected, no deployment has
 * reported, and no task queue exists, so the engine runs its work in-process and the page's tabs
 * would be zeros. A queue with a task in it is remote work whose ledger the Diagnostics tab reads,
 * and an address that opens one worker, queue, or task asks for it by name, so either keeps the full
 * page. The caller has read both lists successfully: a list that failed or is still loading says
 * nothing about the fleet.
 */
import type { TaskQueuesListOutput, WorkersListOutput } from './worker-catalog-types.ts';

export function runsInProcessOnly(
  workers: WorkersListOutput,
  queues: TaskQueuesListOutput,
  search: URLSearchParams,
): boolean {
  return (
    workers.items.length === 0 &&
    workers.deployments.length === 0 &&
    queues.items.length === 0 &&
    !search.has('worker') &&
    !search.has('queue') &&
    !search.has('task')
  );
}
