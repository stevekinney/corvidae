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
 * All three poll every 30s (plan §5.3: "the default for low-churn surfaces
 * … workers ~30s") as the baseline freshness guarantee; `index.svelte`
 * layers an opt-in subscription to the shell's ONE shared `FleetEventSource`
 * (`getFleetEventSource()`, `src/app/engine-status.svelte.ts`) on top for
 * instant invalidation on `worker:connected`/`worker:disconnected`. The
 * toggle only gates that subscription — it never opens a second connection —
 * per plan §5's ≤3-connection budget: "one fleet SSE … never per-row/
 * per-surface connections".
 */
import type { HttpClient } from '@lostgradient/weft';

import {
  createMutation,
  createQuery,
  type CreateMutationResult,
  type CreateQueryResult,
  type QueryClient,
} from '@tanstack/svelte-query';

import { queryKeys } from '../../lib/query.ts';
import type { RegistrySnapshotSource } from '../system/registry-view.ts';
import { parseConformanceReport, parseConformanceTargets } from './conformance-evidence.ts';
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
  return createQuery(() => ({
    queryKey: queryKeys.tasks.detail(operationId()),
    queryFn: async () => {
      const selectedOperationId = operationId();
      return parseTaskLedgerDetail(
        await client.operations['weft.tasks.get']({ operationId: selectedOperationId }),
      );
    },
    enabled: operationId().length > 0,
    refetchInterval: REFETCH_INTERVAL_MS,
  }));
}

/** The server's answers to one task's result submissions (`weft.tasks.deliveries`, `system:read`). */
export function taskDeliveriesQuery(client: WorkersOperations, operationId: () => string) {
  return createQuery(() => ({
    queryKey: queryKeys.tasks.deliveries(operationId()),
    queryFn: async () =>
      parseTaskDeliveries(
        await client.operations['weft.tasks.deliveries']({ operationId: operationId() }),
      ),
    enabled: operationId().length > 0,
    // A malformed response is deterministic, so retrying only delays naming it; the poll recovers a transient fault.
    retry: false,
    refetchInterval: REFETCH_INTERVAL_MS,
  }));
}

/**
 * A dead-lettered attempt's retained result (`weft.tasks.deadletters.get`,
 * `system:admin`). Disabled until `enabled()` is true so the value is read only
 * on an operator's explicit request; it is never polled, because it cannot change.
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
    refetchInterval: REFETCH_INTERVAL_MS,
  }));
}

/** Runs one target's conformance checks in a private sandbox (`weft.conformance.report`, `system:admin`). */
export function runConformanceMutation(client: WorkersOperations) {
  return createMutation(() => ({
    mutationFn: async (target: string) =>
      parseConformanceReport(await client.operations['weft.conformance.report']({ target })),
  }));
}

/** `GET /v1/workers` (`system:read`) — fleet + deployment rollup + routing policy. */
export function workersListQuery(client: WorkersOperations): CreateQueryResult<WorkersListOutput> {
  return createQuery(() => ({
    queryKey: queryKeys.workers.list(),
    queryFn: () => client.operations['weft.workers.list']({}),
    refetchInterval: REFETCH_INTERVAL_MS,
  }));
}

/** `GET /v1/task-queues` (`system:read`). */
export function taskQueuesListQuery(client: WorkersOperations) {
  return createQuery(() => ({
    queryKey: queryKeys.queues.list(),
    queryFn: () => client.operations['weft.task.queues.list']({}),
    refetchInterval: REFETCH_INTERVAL_MS,
  }));
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
