/**
 * Checkpoints tab data access (plan T3.3): `GET …/checkpoints` (list),
 * `GET …/checkpoints/:step` (one checkpoint's raw state), `GET
 * …/replay/:step` (read-only reconstruction), and
 * `POST …/fork` (fork preview and creation).
 *
 * The generated checkpoint reads and replay require `workflows:read`.
 * Forking requires `workflows:write`.
 *
 * Query keys are local to this module (matching `workflow-timeline-data.ts`'s
 * precedent) rather than added to the frozen `src/lib/query.ts` — that file
 * is Foundation-owned and closed after the Phase 1 gate.
 *
 * ## Why the results are runtime-validated, not just typed
 *
 * The reads declare `outputSchema: z.unknown()` server-side (Weft
 * intentionally loosens the wire contract for these — see the operation
 * definitions), and the GENERATED client catalog
 * (`weft/src/cli/generated/operation-client.generated.ts`, the actual
 * source of `HttpClient.operations[name]`'s return type) reads that zod
 * schema, not the operation's TS `Output` generic — so
 * `client.operations['weft.workflows.checkpoints.list']` is really typed to
 * return `Promise<unknown>`, not `Promise<CheckpointSummary[]>`. The real
 * shape (verified against `weft/src/core/engine/checkpoint-reads.ts` and a
 * live dev-harness curl) genuinely IS `CheckpointSummary[]`/`CheckpointState`
 * — this module validates that structurally at the boundary rather than
 * asserting it blindly, per this repo's `as`-cast policy.
 */
import type { CheckpointState, CheckpointSummary, WorkflowReplay } from '@lostgradient/weft';
import type { QueryKey } from '@tanstack/svelte-query';

/**
 * The one read the fork dialog's open-time refetch needs (COR-15): the
 * source run's current persisted `revision`. A real generated client returns
 * the complete state; a missing source is a 404 fault.
 */
export interface ForkSourceClient {
  readonly operations: {
    readonly 'weft.workflows.get': (input: {
      readonly workflowId: string;
    }) => Promise<{ readonly revision?: string | undefined }>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCheckpointSummary(value: unknown): value is CheckpointSummary {
  return (
    isRecord(value) &&
    typeof value['step'] === 'number' &&
    typeof value['timestamp'] === 'number' &&
    typeof value['sizeBytes'] === 'number'
  );
}

function parseCheckpointSummaries(value: unknown): CheckpointSummary[] {
  if (!Array.isArray(value) || !value.every(isCheckpointSummary)) {
    throw new TypeError('weft.workflows.checkpoints.list returned an unexpected shape');
  }
  return value;
}

function isCheckpointState(value: unknown): value is CheckpointState {
  return (
    isRecord(value) &&
    typeof value['step'] === 'number' &&
    isRecord(value['locals']) &&
    isRecord(value['searchAttributes']) &&
    typeof value['version'] === 'string' &&
    typeof value['createdAt'] === 'number'
  );
}

function parseCheckpointState(value: unknown): CheckpointState {
  if (!isCheckpointState(value)) {
    throw new TypeError('weft.workflows.checkpoints.get returned an unexpected shape');
  }
  return value;
}

export function checkpointsListQueryKey(workflowId: string): QueryKey {
  return ['workflows', 'checkpoints', workflowId];
}

export function checkpointAtQueryKey(workflowId: string, step: number): QueryKey {
  return ['workflows', 'checkpoints', workflowId, step];
}

export function replayQueryKey(workflowId: string, step: number): QueryKey {
  return ['workflows', 'replay', workflowId, step];
}

/** Narrow surface this module needs off `client.operations` — the two checkpoint operations have no ergonomic method. Matches the REAL generated client type (`output: unknown`) — see module doc. */
export interface CheckpointsOperationsClient {
  readonly operations: {
    readonly 'weft.workflows.checkpoints.list': (input: { workflowId: string }) => Promise<unknown>;
    readonly 'weft.workflows.checkpoints.get': (input: {
      workflowId: string;
      step: number;
    }) => Promise<unknown>;
  };
}

export async function listCheckpoints(
  client: CheckpointsOperationsClient,
  workflowId: string,
): Promise<CheckpointSummary[]> {
  return parseCheckpointSummaries(
    await client.operations['weft.workflows.checkpoints.list']({ workflowId }),
  );
}

export async function getCheckpointAt(
  client: CheckpointsOperationsClient,
  workflowId: string,
  step: number,
): Promise<CheckpointState> {
  return parseCheckpointState(
    await client.operations['weft.workflows.checkpoints.get']({ workflowId, step }),
  );
}

/** The portion of the opaque replay response that the inspector displays. */
type WorkflowReplayInspection = Pick<WorkflowReplay, 'compactedBefore' | 'revision'> & {
  readonly checkpoint: CheckpointState;
  readonly accumulatedResults: readonly unknown[];
  readonly events: readonly unknown[];
};

export interface ReplayClient {
  readonly operations: {
    readonly 'weft.workflows.replay': (input: {
      workflowId: string;
      step: number;
    }) => Promise<unknown>;
  };
}

export async function replayWorkflow(
  client: ReplayClient,
  workflowId: string,
  step: number,
): Promise<WorkflowReplayInspection | null> {
  const response = await client.operations['weft.workflows.replay']({ workflowId, step });
  if (response === null) return null;
  if (!isRecord(response))
    throw new TypeError('weft.workflows.replay returned an unexpected shape');
  const { checkpoint, accumulatedResults, events, compactedBefore, revision } = response;
  if (
    !isCheckpointState(checkpoint) ||
    !Array.isArray(accumulatedResults) ||
    !Array.isArray(events) ||
    (compactedBefore !== undefined && typeof compactedBefore !== 'number') ||
    (revision !== undefined && typeof revision !== 'string')
  )
    throw new TypeError('weft.workflows.replay returned an unexpected shape');
  return {
    checkpoint,
    accumulatedResults,
    events,
    ...(compactedBefore === undefined ? {} : { compactedBefore }),
    ...(revision === undefined ? {} : { revision }),
  };
}
