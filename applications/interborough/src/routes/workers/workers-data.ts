/**
 * Query/mutation wiring for the Workers/Queues/Diagnostics surface (Track C,
 * plan §4, §9.4). Plain, framework-free functions over the narrow slice of
 * `HttpClient` each one needs — `.svelte` files wire these into
 * `createQuery`/`createMutation` (`@tanstack/svelte-query`), following the
 * same split `reviews-data.ts`/`schedule-queries.ts` established: logic here
 * stays unit-testable without a DOM, `.svelte` files stay thin.
 *
 * None of the three list queries take reactive params (`weft.workers.list`
 * and `weft.task.queues.list` accept `{}`; `weft.tasks.diagnostics` always
 * runs with the same server-mirrored defaults — `worker-catalog-types.ts`'s
 * `DEFAULT_TASK_DIAGNOSTICS_INPUT`), so their option getters use stable
 * keys. Task detail reads its selected operation inside a reactive getter.
 *
 * The list queries follow the shell's ONE shared `FleetEventSource`
 * (`src/app/engine-status.svelte.ts`): its frames ask again for what they
 * change (`../../lib/live-source/cache-integration.ts`,
 * `../../app/task-event-queries.ts`), and a query polls every 30s (plan §5.3:
 * "the default for low-churn surfaces … workers ~30s") only while that feed is
 * not live. A query that reads the feed's state is therefore made while a
 * component initializes (`useFleetEventsLive` reads context), like every
 * `createQuery`. Per plan §5's ≤3-connection budget, none opens a connection
 * of its own: "one fleet SSE … never per-row/per-surface connections".
 */
import type { HttpClient } from '@lostgradient/weft';

import {
  createMutation,
  createQuery,
  type CreateMutationResult,
  type CreateQueryResult,
  type QueryClient,
} from '@tanstack/svelte-query';

import { useFleetEventsLive } from '../../app/live-polling.svelte.ts';
import { queryKeys } from '../../lib/query.ts';
import type { RegistrySnapshotSource } from '../system/registry-view.ts';
import {
  parseConformanceReport,
  parseConformanceTargets,
  type ConformanceReport,
} from './conformance-evidence.ts';
import { parseRegistrySnapshot } from './registry-snapshot-guard.ts';
import { parseDeadLetter, parseTaskDeliveries } from './task-delivery-evidence.ts';
import { isTaskLedgerDetail } from './task-ledger-validation.ts';
import {
  DEFAULT_TASK_DIAGNOSTICS_INPUT,
  type TaskDiagnosticsOutput,
  type TaskLedgerDetail,
  type TaskProvenanceFilters,
  type WorkersListOutput,
} from './worker-catalog-types.ts';
import {
  parseWorkerDiagnosticsResponse,
  parseWorkerRegistrationRejections,
  type WorkerManifestDiagnostics,
  type WorkerRegistrationRejection,
} from './worker-manifest-diagnostics.ts';

const REFETCH_INTERVAL_MS = 30_000;

type WorkersOperations = Pick<HttpClient, 'operations'>;

/** A `weft.tasks.get` response the dashboard refuses to render, distinct from a transport or server fault. */
export class MalformedTaskLedgerError extends Error {
  constructor() {
    super('Weft returned a malformed task ledger response.');
    this.name = 'MalformedTaskLedgerError';
  }
}

/** Validates the generated operation's currently-unknown output at the Console trust boundary. */
export function parseTaskLedgerDetail(value: unknown): TaskLedgerDetail {
  if (!isTaskLedgerDetail(value)) {
    throw new MalformedTaskLedgerError();
  }
  return value;
}

/** Reads exactly one authoritative durable ledger record. */
export function taskLedgerDetailQuery(client: WorkersOperations, operationId: () => string) {
  // An attempt starting, failing, queueing or settling asks for the record again
  // (`../../app/task-event-queries.ts`); the timer runs only while the fleet feed is not live.
  const fleetLive = useFleetEventsLive();
  return createQuery(() => {
    // Read here, not in the interval, which TanStack Query reads untracked.
    const polling = !fleetLive();
    return {
      queryKey: queryKeys.tasks.detail(operationId()),
      queryFn: async () => {
        const selectedOperationId = operationId();
        return parseTaskLedgerDetail(
          await client.operations['weft.tasks.get']({ operationId: selectedOperationId }),
        );
      },
      enabled: operationId().length > 0,
      // poll-reason: fallback
      refetchInterval: polling ? REFETCH_INTERVAL_MS : false,
    };
  });
}

/** The server's answers to one task's result submissions (`weft.tasks.deliveries`, `system:read`). */
export function taskDeliveriesQuery(client: WorkersOperations, operationId: () => string) {
  // `task:result-delivery` and `activity:completed` ask for the history again; the timer runs only
  // while the fleet feed is not live.
  const fleetLive = useFleetEventsLive();
  return createQuery(() => {
    const polling = !fleetLive();
    return {
      queryKey: queryKeys.tasks.deliveries(operationId()),
      queryFn: async () =>
        parseTaskDeliveries(
          await client.operations['weft.tasks.deliveries']({ operationId: operationId() }),
        ),
      enabled: operationId().length > 0,
      // A malformed response is deterministic, so retrying only delays naming it; the poll recovers a transient fault.
      retry: false,
      // poll-reason: fallback
      refetchInterval: polling ? REFETCH_INTERVAL_MS : false,
    };
  });
}

/**
 * A dead-lettered attempt's retained result (`weft.tasks.deadletters.get`,
 * `system:admin`). Disabled until `enabled()` is true so the value is read only
 * on an operator's explicit request. It is never polled: the retained result
 * holds until the dead letter is retried or cleared, and both of those ask for
 * it again (`retryDeadLetterMutation`, `invalidateDeadLetterQueries`).
 */
export function deadLetterQuery(
  client: WorkersOperations,
  operationId: () => string,
  enabled: () => boolean,
) {
  return createQuery(() => ({
    queryKey: queryKeys.tasks.deadLetter(operationId()),
    queryFn: async () =>
      parseDeadLetter(
        await client.operations['weft.tasks.deadletters.get']({ operationId: operationId() }),
      ),
    enabled: enabled() && operationId().length > 0,
    retry: false,
  }));
}

/** The worker conformance targets this server can run (`weft.conformance.targets`, `system:read`). */
export function conformanceTargetsQuery(client: WorkersOperations) {
  return createQuery(() => ({
    queryKey: queryKeys.conformance.targets(),
    queryFn: async () =>
      parseConformanceTargets(await client.operations['weft.conformance.targets']({})),
    retry: false,
    // The targets are what this server can run, fixed for the life of the process; the poll only
    // recovers a transient fault.
    // poll-reason: static
    refetchInterval: REFETCH_INTERVAL_MS,
  }));
}

/**
 * Runs one target's conformance checks in a private sandbox (`weft.conformance.report`,
 * `system:admin`). The outcome callbacks are options-level, so each receives its own target as the
 * variables even when runs overlap; a callback passed to `mutate()` fires only for the latest call.
 */
export function runConformanceMutation(
  client: WorkersOperations,
  outcome: {
    readonly onReport: (target: string, report: ConformanceReport) => void;
    readonly onFailure: (target: string, error: unknown) => void;
  },
) {
  return createMutation(() => ({
    mutationFn: async (target: string) =>
      parseConformanceReport(await client.operations['weft.conformance.report']({ target })),
    onSuccess: (report: ConformanceReport, target: string) => outcome.onReport(target, report),
    onError: (error: Error, target: string) => outcome.onFailure(target, error),
  }));
}

/** `GET /v1/workers` (`system:read`) — fleet + deployment rollup + routing policy. */
export function workersListQuery(client: WorkersOperations): CreateQueryResult<WorkersListOutput> {
  // `worker:connected`, `worker:disconnected` and `worker:deployment-changed` ask for the list
  // again; the timer runs only while the fleet feed is not live.
  const fleetLive = useFleetEventsLive();
  return createQuery(() => {
    const polling = !fleetLive();
    return {
      queryKey: queryKeys.workers.list(),
      queryFn: () => client.operations['weft.workers.list']({}),
      // poll-reason: fallback
      refetchInterval: polling ? REFETCH_INTERVAL_MS : false,
    };
  });
}

/** `GET /v1/task-queues` (`system:read`). */
export function taskQueuesListQuery(client: WorkersOperations) {
  // `queue:depth-changed` asks for the list again (`../../lib/live-source/cache-integration.ts`); the
  // timer runs only while the fleet feed is not live.
  const fleetLive = useFleetEventsLive();
  return createQuery(() => {
    // Read here, not in the interval, which TanStack Query reads untracked.
    const polling = !fleetLive();
    return {
      queryKey: queryKeys.queues.list(),
      queryFn: () => client.operations['weft.task.queues.list']({}),
      // poll-reason: fallback
      refetchInterval: polling ? REFETCH_INTERVAL_MS : false,
    };
  });
}

/**
 * `GET /v1/tasks/diagnostics` (`system:read`), server-mirrored default
 * thresholds. Provenance filters (deployment, build, artifact digest, worker,
 * workflow revision) are passed to the server, which matches them against the
 * identity recorded on each task's attempts; an unfiltered read keeps the key
 * the Dashboard's alerts share.
 */
export function taskDiagnosticsQuery(
  client: WorkersOperations,
  filters: () => TaskProvenanceFilters = () => ({}),
): CreateQueryResult<TaskDiagnosticsOutput> {
  return createQuery(() => {
    const active = filters();
    const filtered = Object.keys(active).length > 0;
    return {
      queryKey: filtered ? queryKeys.diagnosticsFiltered(active) : queryKeys.diagnostics(),
      queryFn: () =>
        client.operations['weft.tasks.diagnostics']({
          ...DEFAULT_TASK_DIAGNOSTICS_INPUT,
          ...active,
        }),
      // A task goes stale by the clock (queued too long, no heartbeat), which no event announces.
      // poll-reason: time-derived
      refetchInterval: REFETCH_INTERVAL_MS,
    };
  });
}

/** Runtime-validated canonical manifest detail for one connected worker. */
export async function loadWorkerManifestDiagnostics(
  client: WorkersOperations,
  workerId: string,
): Promise<WorkerManifestDiagnostics | null> {
  const response = await client.operations['weft.workers.diagnostics']({ workerId });
  return parseWorkerDiagnosticsResponse(response);
}

/** Canonical manifest detail for the current connected fleet, ordered by worker id. */
export async function loadFleetManifestDiagnostics(
  client: WorkersOperations,
  workerIds: readonly string[],
): Promise<readonly WorkerManifestDiagnostics[]> {
  const diagnostics = await Promise.all(
    workerIds.toSorted().map((workerId) => loadWorkerManifestDiagnostics(client, workerId)),
  );
  return diagnostics.filter((entry): entry is WorkerManifestDiagnostics => entry !== null);
}

/** The active registry snapshot that Worker detail's contract verification compares manifests with (COR-162). */
export async function loadRegistrySnapshot(
  client: WorkersOperations,
): Promise<RegistrySnapshotSource> {
  return parseRegistrySnapshot(await client.operations['weft.system.registry']({}));
}

/** Bounded, server-owned evidence for recently rejected registration attempts. */
export async function loadWorkerRegistrationRejections(
  client: WorkersOperations,
  limit = 25,
): Promise<readonly WorkerRegistrationRejection[]> {
  const response = await client.operations['weft.workers.rejections']({ limit });
  return parseWorkerRegistrationRejections(response);
}

/** Invalidate every worker surface affected by fleet events or administrative mutations. */
export function invalidateWorkerSurfaceQueries(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.workers.list() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.queues.list() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.diagnostics() });
  void queryClient.invalidateQueries({ queryKey: ['workers', 'manifests'] });
  void queryClient.invalidateQueries({ queryKey: queryKeys.workers.rejections() });
}

export interface DrainWorkerVariables {
  readonly workerId: string;
  readonly reason?: string;
}

/** `POST /v1/workers/:id/drain` (`system:admin`). */
export function drainWorkerMutation(
  client: WorkersOperations,
  onSettled: () => void,
): CreateMutationResult<unknown, Error, DrainWorkerVariables> {
  return createMutation(() => ({
    mutationFn: (variables: DrainWorkerVariables) =>
      client.operations['weft.workers.drain'](variables),
    onSettled,
  }));
}

/** `DELETE /v1/workers/:id/drain` (`system:admin`). */
export function resumeWorkerMutation(
  client: WorkersOperations,
  onSettled: () => void,
): CreateMutationResult<unknown, Error, { workerId: string }> {
  return createMutation(() => ({
    mutationFn: (variables: { workerId: string }) =>
      client.operations['weft.workers.resume'](variables),
    onSettled,
  }));
}

export interface DrainDeploymentVariables {
  readonly deploymentName: string;
  readonly reason?: string;
}

/** `POST /v1/worker-deployments/:name/drain` (`system:admin`). */
export function drainDeploymentMutation(
  client: WorkersOperations,
  onSettled: () => void,
): CreateMutationResult<unknown, Error, DrainDeploymentVariables> {
  return createMutation(() => ({
    mutationFn: (variables: DrainDeploymentVariables) =>
      client.operations['weft.worker.deployments.drain'](variables),
    onSettled,
  }));
}

/** `DELETE /v1/worker-deployments/:name/drain` (`system:admin`). */
export function resumeDeploymentMutation(
  client: WorkersOperations,
  onSettled: () => void,
): CreateMutationResult<unknown, Error, { deploymentName: string }> {
  return createMutation(() => ({
    mutationFn: (variables: { deploymentName: string }) =>
      client.operations['weft.worker.deployments.resume'](variables),
    onSettled,
  }));
}

/** Generated `DELETE /v1/tasks/diagnostics/dead-letter/:operationId` (`system:admin`). */
export function clearDeadLetterMutation(
  client: WorkersOperations,
  onSettled: () => void,
): CreateMutationResult<unknown, Error, { operationId: string }> {
  return createMutation(() => ({
    mutationFn: ({ operationId }: { operationId: string }) =>
      client.operations['weft.tasks.diagnostics.deadletters.clear']({ operationId }),
    onSettled,
  }));
}

/** Ask again for what a retry or a clear of `operationId` changes: its retained result and its ledger record. */
export function invalidateDeadLetterQueries(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  operationId: string,
): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.deadLetter(operationId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(operationId) }),
  ]);
}

export interface RetryDeadLetterVariables {
  readonly operationId: string;
  /** The attempt the person read as dead-lettered; the server refuses the retry if it is no longer that one. */
  readonly attemptTokenDigest?: string;
}

/**
 * Generated `POST /v1/tasks/detail/:operationId/dead-letter/retry` (`system:admin`): puts one dead
 * letter back in its queue under the same id. A retry changes the task, its queue's backlog and its
 * retained result, so a settled retry (accepted or refused) asks for all of them again.
 */
export function retryDeadLetterMutation(
  client: WorkersOperations,
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  handlers: {
    readonly onSettled: () => void;
    readonly onRefused: (error: unknown) => void;
  },
): CreateMutationResult<unknown, Error, RetryDeadLetterVariables> {
  return createMutation(() => ({
    mutationFn: ({ operationId, attemptTokenDigest }: RetryDeadLetterVariables) =>
      client.operations['weft.tasks.deadletters.retry']({
        operationId,
        ...(attemptTokenDigest !== undefined ? { attemptTokenDigest } : {}),
      }),
    onError: (error: Error) => handlers.onRefused(error),
    // Returned, so the mutation stays pending until the task has been read again.
    onSettled: async (
      _result: unknown,
      _error: Error | null,
      variables: RetryDeadLetterVariables,
    ) => {
      handlers.onSettled();
      await invalidateDeadLetterQueries(queryClient, variables.operationId);
    },
  }));
}
