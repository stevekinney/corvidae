/** The filters of `/tasks`, which the address carries: `?agent=`, `?status=`, and `?session=`. */
import { taskStateSchema, type TaskFilter } from '../../lib/bureau-tasks.ts';

export type TaskListFilter = {
  readonly agent?: string;
  readonly status?: string;
  readonly session?: string;
};

/** Reads the filter out of a query string. A status that is not a state of a task is no filter. */
export function parseTaskFilter(search: URLSearchParams): TaskFilter {
  const agent = search.get('agent')?.trim();
  const session = search.get('session')?.trim();
  const status = taskStateSchema.safeParse(search.get('status'));
  return {
    ...(agent === undefined || agent === '' ? {} : { agentName: agent }),
    ...(session === undefined || session === '' ? {} : { contextId: session }),
    ...(status.success ? { status: status.data } : {}),
  };
}

/** The query string a filter is kept in the address as, empty for no filter. */
export function serializeTaskFilter(filter: TaskListFilter): string {
  const params = new URLSearchParams();
  const agent = filter.agent?.trim();
  const session = filter.session?.trim();
  if (agent !== undefined && agent !== '') params.set('agent', agent);
  if (filter.status !== undefined && filter.status !== '') params.set('status', filter.status);
  if (session !== undefined && session !== '') params.set('session', session);
  return params.toString();
}

/** Whether any filter is applied. */
export function hasTaskFilter(filter: TaskFilter): boolean {
  return (
    filter.agentName !== undefined || filter.contextId !== undefined || filter.status !== undefined
  );
}
