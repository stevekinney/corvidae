/**
 * Types for this track derived from the generated operation catalog itself
 * (plan §4: "no hand-maintained API types … drift is caught by bumping the
 * `@lostgradient/weft` dependency and type-checking"), rather than
 * hand-copied from `weft/src/worker/registry.ts` /
 * `weft/src/server/task-queue-types.ts` / `weft/src/server/operations/
 * get-task-diagnostics.ts` — none of which are exported as values or types
 * from any public `@lostgradient/weft` subpath. Deriving from
 * `HttpClient['operations'][...]`'s own return type means a future catalog
 * change surfaces here as a type error, not a silent shape mismatch.
 */
import type { HttpClient } from '@lostgradient/weft';

type Operations = HttpClient['operations'];

export type WorkersListOutput = Awaited<ReturnType<Operations['weft.workers.list']>>;
export type WorkerSummary = WorkersListOutput['items'][number];
export type WorkerDeploymentSummary = WorkersListOutput['deployments'][number];
export type WorkerHealth = WorkerSummary['health'];

export type TaskQueuesListOutput = Awaited<ReturnType<Operations['weft.task.queues.list']>>;
export type TaskQueueHealth = TaskQueuesListOutput['items'][number];

export type TaskDiagnosticsOutput = Awaited<ReturnType<Operations['weft.tasks.diagnostics']>>;
export type TaskDiagnosticItem = TaskDiagnosticsOutput['items'][number];
export type TaskDiagnosticKind = TaskDiagnosticItem['kind'];
export type StandardTaskDiagnosticItem = Extract<
  TaskDiagnosticItem,
  {
    readonly kind:
      | 'stuck-queued'
      | 'stale-inflight'
      | 'retry-storm'
      | 'all-workers-at-capacity'
      | 'dead-lettered';
  }
>;
export const PROVENANCE_FILTER_FIELDS = [
  'deploymentName',
  'buildId',
  'artifactDigest',
  'workerId',
  'workflowRevision',
] as const;
export type ProvenanceFilterField = (typeof PROVENANCE_FILTER_FIELDS)[number];
/** The bounded execution-identity filters `weft.tasks.diagnostics` accepts. */
export type TaskProvenanceFilters = Readonly<Partial<Record<ProvenanceFilterField, string>>>;
export type TaskDiagnosticsSummary = TaskDiagnosticsOutput['summary'];

export type TaskLedgerOutput = Awaited<ReturnType<Operations['weft.tasks.get']>>;
/** One fenced attempt record from `weft.tasks.get`'s `attempts` history. */
export type TaskAttemptRecord = TaskLedgerOutput['attempts'][number];
export type TaskAttemptDisposition = TaskAttemptRecord['disposition'];

export type TaskLedgerState =
  'queued' | 'leased' | 'completing' | 'cancelling' | 'terminal' | 'deadLettered';

export type TaskLedgerDetail = Readonly<{
  state: TaskLedgerState;
  operationId: string;
  workflowId?: string;
  workflowExecutionToken?: string;
  workflowType: string;
  activityName: string;
  queue: string;
  priority?: number;
  headerKeys: readonly string[];
  visibilityTimeoutMilliseconds: number;
  scheduleToCloseDeadline?: number;
  retryPolicy?: Readonly<{
    maxAttempts: number;
    initialBackoff: number | string;
    backoffMultiplier: number;
    maxBackoff: number | string;
    nonRetryableErrors?: readonly string[];
  }>;
  executionRequirement?: Readonly<Record<string, string | undefined>>;
  fairShareKey?: string;
  stickyWorkflowId?: string;
  createdAt: number;
  attempt: number;
  availableAt?: number;
  firstQueuedAt?: number;
  lastQueuedAt?: number;
  startedAt?: number;
  lastHeartbeatAt?: number;
  leaseDeadline?: number;
  attemptDeadline?: number;
  attempts: readonly TaskAttemptRecord[];
  retryCount?: number;
  requeueCount?: number;
  lastRequeueReason?: string;
  pendingStatus?: 'completed' | 'failed';
  resultDigest?: string;
  cancellationReason?: string;
  cancellationRequestedAt?: number;
  terminalAt?: number;
  disposition?: 'resolved' | 'cancelled' | 'retryExhausted';
  resultStatus?: 'completed' | 'failed';
  error?: string;
  adopted?: boolean;
  adoptedAt?: number;
  deadLetteredAt?: number;
  persistenceFailureReason?: string;
}>;

/**
 * Heartbeat age at which an in-flight task reads stale. The Diagnostics
 * query sends it to `weft.tasks.diagnostics` and task detail renders with
 * it, so a `stale-inflight` row and its detail view cannot disagree.
 */
export const TASK_HEARTBEAT_STALE_AFTER_MS = 60_000;

/** `weft.tasks.diagnostics` input fields the generated client types as required (mirroring the server's Zod `.default(...)` values, which the catalog generator does not reflect as optional — plan §9.4 T5.4). */
export const DEFAULT_TASK_DIAGNOSTICS_INPUT = {
  staleQueuedAfterMs: 60_000,
  staleHeartbeatAfterMs: TASK_HEARTBEAT_STALE_AFTER_MS,
  retryStormMinimumAttempts: 3,
  includeExpectedDelayed: true,
  unadoptedAfterMs: 60_000,
  limit: 50,
} as const;
