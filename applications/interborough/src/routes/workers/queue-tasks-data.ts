/**
 * Reads and writes for the tasks on one queue (COR-2018, rows 78n to 78p, 79b to 79e): the
 * waiting and failed-for-good tasks the Workers page lists under the open worker
 * (`weft.task.queues.tasks`), and the two things it does to the failed ones. Retry all puts each
 * back on its queue through the existing per-task `weft.tasks.deadletters.retry`; Clear all is the
 * existing per-task `weft.tasks.diagnostics.deadletters.clear`, held on the page for an Undo
 * (`queue-task-clear.svelte.ts`) until the toast that offers it is gone.
 */
import type { HttpClient } from '@lostgradient/weft';

import {
  createInfiniteQuery,
  createMutation,
  type CreateMutationResult,
  type QueryClient,
} from '@tanstack/svelte-query';

import { useFleetEventsLive } from '../../app/live-polling.svelte.ts';
import { queryKeys } from '../../lib/query.ts';
import { invalidateDeadLetterQueries } from './workers-data.ts';

type Operations = HttpClient['operations'];

/** One page of a queue's tasks and the counts the queue holds. */
export type QueueTasksOutput = Awaited<ReturnType<Operations['weft.task.queues.tasks']>>;
/** One waiting or failed-for-good task. */
export type QueueTask = QueueTasksOutput['items'][number];
/** Which tasks a tab lists. */
export type QueueTaskTab = 'all' | 'waiting' | 'failed';

/** How many tasks one page asks for. */
export const QUEUE_TASKS_PAGE_SIZE = 25;

const REFETCH_INTERVAL_MS = 30_000;

/**
 * A queue's tasks for one tab, a page at a time. It reads nothing until a queue is named. The fleet
 * feed asks it again as tasks queue, run and fail (`../../lib/live-source/cache-integration.ts`),
 * and it polls only while that feed is not live.
 */
export function queueTasksQuery(
  client: Pick<HttpClient, 'operations'>,
  queue: () => string | undefined,
  tab: () => QueueTaskTab,
) {
  const fleetLive = useFleetEventsLive();
  return createInfiniteQuery(() => {
    const name = queue();
    const status = tab();
    // Read here, not in the interval, which TanStack Query reads untracked.
    const polling = !fleetLive();
    return {
      queryKey: queryKeys.queues.tasks(name ?? '', status),
      queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
        client.operations['weft.task.queues.tasks']({
          queue: name ?? '',
          status,
          limit: QUEUE_TASKS_PAGE_SIZE,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last: QueueTasksOutput) => last.nextCursor ?? undefined,
      enabled: name !== undefined,
      // poll-reason: fallback
      refetchInterval: polling ? REFETCH_INTERVAL_MS : (false as const),
    };
  }, undefined);
}

/** What Retry all did: the tasks put back, and why the others were not. */
export interface RetryAllResult {
  readonly retried: number;
  readonly refused: readonly unknown[];
}

/**
 * Retry all: puts each failed task back on its queue, with no confirmation (a retry is a
 * re-queue). Each is its own request, so one that is refused (cleared or retried since it was
 * read) does not stop the rest; the result says how many went back and why the others did not.
 * Asks again for the queue's tasks and counts when it is done, accepted or not.
 */
export function retryAllMutation(
  client: Pick<HttpClient, 'operations'>,
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
): CreateMutationResult<RetryAllResult, Error, readonly string[]> {
  return createMutation(() => ({
    mutationFn: async (operationIds: readonly string[]): Promise<RetryAllResult> => {
      const outcomes = await Promise.allSettled(
        operationIds.map((operationId) =>
          client.operations['weft.tasks.deadletters.retry']({ operationId }),
        ),
      );
      return {
        retried: outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
        refused: outcomes.flatMap((outcome) =>
          outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
        ),
      };
    },
    onSettled: async (_result: RetryAllResult | undefined, _error: Error | null, ids) => {
      await Promise.all([
        invalidateQueueTaskQueries(queryClient),
        ...ids.map((operationId) => invalidateDeadLetterQueries(queryClient, operationId)),
      ]);
    },
  }));
}

/** Asks again for every queue's tasks, the queue list and the diagnostics they count. */
export function invalidateQueueTaskQueries(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['queues'] }),
    queryClient.invalidateQueries({ queryKey: queryKeys.diagnostics() }),
  ]);
}
