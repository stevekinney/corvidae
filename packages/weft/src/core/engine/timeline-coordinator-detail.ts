import type { ContextOperationRequest } from '../context.ts';
import type { ParallelBranchSlot } from '../context/parallel-cache-entry.ts';
import type { WorkflowTimelineOperationDetail } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { getTimelineOperationLabel, summarizeTimelineValue } from './state-utilities.ts';
import {
  MAX_TIMELINE_COORDINATOR_DETAILS,
  MAX_TIMELINE_DETAIL_STRING_LENGTH,
} from './timeline-coordinator-constants.ts';

export type ActivityCompletionReceipt = {
  operationId: string;
  workflowExecutionToken: string | undefined;
  activityName: string;
  duration: number;
};

/**
 * Completion receipts for `ctx.all`/`ctx.race`/run-all branch activities that
 * succeeded locally, keyed `workflowId -> operationId`, per engine. The
 * enclosing coordinator's result commit reports the branches its timeline
 * entry records as fulfilled or won and drops the rest (race losers, failed
 * siblings). Held only in memory, collected with the engine, and dropped per
 * workflow by {@link forgetBranchActivityReceipts} on terminal cleanup and purge.
 */
const branchActivityReceipts = new WeakMap<
  EngineInternals,
  Map<string, Map<string, ActivityCompletionReceipt>>
>();

/** Drop a workflow's held branch receipts when its run ends or is purged. */
export function forgetBranchActivityReceipts(internals: EngineInternals, workflowId: string): void {
  branchActivityReceipts.get(internals)?.delete(workflowId);
}

const COORDINATOR_OPERATION_TYPES: ReadonlySet<string> = new Set(['parallel', 'race', 'run-all']);

/**
 * Which lifecycle evidence an activity attempt reports, decided by the
 * workflow's current durable operation. A `'top-level'` activity is that
 * operation; a `'branch'` runs under an enclosing `ctx.all`/`ctx.race`/run-all
 * whose result commit reports it. Anything else, such as a `durableActivity()`
 * helper under `ctx.memo`, reports neither event rather than a start that
 * never completes.
 */
export function activityLifecycleScope(
  internals: EngineInternals,
  workflowId: string,
  operationId: string,
): 'top-level' | 'branch' | undefined {
  const operation = internals.durableInlineOperations?.get(workflowId);
  if (operation === undefined) return undefined;
  if (operation.type === 'activity') {
    return operation.operationId === operationId ? 'top-level' : undefined;
  }
  return COORDINATOR_OPERATION_TYPES.has(operation.type) ? 'branch' : undefined;
}

/**
 * Hold a succeeded branch activity's receipt until its coordinator commits. A
 * race loser that finishes after its workflow moved on or ended has no
 * coordinator left to report it, so it is not held.
 */
export function recordBranchActivityReceipt(
  internals: EngineInternals,
  workflowId: string,
  receipt: ActivityCompletionReceipt,
): void {
  const operation = internals.durableInlineOperations?.get(workflowId);
  if (
    activityLifecycleScope(internals, workflowId, receipt.operationId) !== 'branch' ||
    operation?.workflowExecutionToken !== receipt.workflowExecutionToken
  ) {
    return;
  }
  let byWorkflow = branchActivityReceipts.get(internals);
  if (byWorkflow === undefined) {
    byWorkflow = new Map();
    branchActivityReceipts.set(internals, byWorkflow);
  }
  let receipts = byWorkflow.get(workflowId);
  if (receipts === undefined) {
    receipts = new Map();
    byWorkflow.set(workflowId, receipts);
  }
  receipts.set(receipt.operationId, receipt);
}

/**
 * The activity completions the commit about to run makes durable: the
 * top-level activity's, or each branch the coordinator's timeline entry
 * records as fulfilled or won. Branch receipts the commit does not report
 * (race losers, failed siblings) are dropped with it.
 */
export function captureActivityCompletionReceipts(
  internals: EngineInternals,
  workflowId: string,
): ActivityCompletionReceipt[] {
  const operation = internals.durableInlineOperations?.get(workflowId);
  if (operation === undefined) return [];
  if (COORDINATOR_OPERATION_TYPES.has(operation.type)) {
    return captureBranchCompletionReceipts(internals, workflowId);
  }
  // A remote-mode engine dispatches every activity to a worker, and
  // `task-result-application.ts` reports its completion under the task
  // ledger's operation id, the one its `activity:started` carried. Reporting
  // the committed checkpoint here too would publish a second completion.
  if (internals.remoteActivityBroker || operation.type !== 'activity') return [];
  const pending = internals.pendingTimelineEntries.get(workflowId);
  if (
    pending?.entry.operationType !== 'activity' ||
    pending.entry.status !== 'completed' ||
    pending.entry.duration === undefined
  ) {
    return [];
  }
  return [
    {
      operationId: operation.operationId,
      workflowExecutionToken: operation.workflowExecutionToken,
      activityName: pending.entry.operationLabel,
      duration: Math.max(0, pending.entry.duration),
    },
  ];
}

function captureBranchCompletionReceipts(
  internals: EngineInternals,
  workflowId: string,
): ActivityCompletionReceipt[] {
  const receipts = branchActivityReceipts.get(internals)?.get(workflowId);
  forgetBranchActivityReceipts(internals, workflowId);
  const pending = internals.pendingTimelineEntries.get(workflowId);
  if (receipts === undefined || pending?.entry.status !== 'completed') return [];
  const committed: ActivityCompletionReceipt[] = [];
  for (const branch of pending.entry.branches ?? []) {
    if (branch.outcome !== 'fulfilled' && branch.outcome !== 'won') continue;
    const receipt = receipts.get(branch.operationId);
    if (receipt !== undefined) committed.push(receipt);
  }
  return committed;
}

function boundedString(value: string): string {
  return value.length <= MAX_TIMELINE_DETAIL_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_TIMELINE_DETAIL_STRING_LENGTH - 1)}…`;
}

function boundedErrorSummary(error: unknown): string {
  return boundedString(summarizeTimelineValue(error));
}

export function operationTimelineDetail(
  operation: ContextOperationRequest,
  index: number,
  outcome: WorkflowTimelineOperationDetail['outcome'],
  options: { error?: unknown; key?: string } = {},
): WorkflowTimelineOperationDetail {
  return {
    index,
    ...(options.key === undefined ? {} : { key: boundedString(options.key) }),
    operationId: boundedString(operation.operationId),
    operationType: operation.type,
    operationLabel: boundedString(getTimelineOperationLabel(operation)),
    outcome,
    ...(options.error === undefined ? {} : { errorSummary: boundedErrorSummary(options.error) }),
  };
}

export function parallelTimelineDetails(
  operations: readonly ContextOperationRequest[],
  slots: readonly ParallelBranchSlot[],
  branchNames?: readonly string[],
): WorkflowTimelineOperationDetail[] {
  return operations.map((operation, index) => {
    const slot = slots[index];
    return operationTimelineDetail(
      operation,
      index,
      slot?.status === 'fulfilled' ? 'fulfilled' : 'rejected',
      {
        ...(branchNames?.[index] === undefined ? {} : { key: branchNames[index] }),
        ...(slot?.status === 'rejected' ? { error: slot.reason } : {}),
      },
    );
  });
}

export function raceTimelineDetails(
  operations: readonly ContextOperationRequest[],
  winnerIndex: number,
  branchNames?: readonly string[],
  winnerError?: unknown,
): WorkflowTimelineOperationDetail[] {
  return operations.map((operation, index) =>
    operationTimelineDetail(operation, index, index === winnerIndex ? 'won' : 'lost', {
      ...(branchNames?.[index] === undefined ? {} : { key: branchNames[index] }),
      ...(index === winnerIndex && winnerError !== undefined ? { error: winnerError } : {}),
    }),
  );
}

export function runAllTimelineDetails(
  branchNames: readonly string[],
  slots: readonly ParallelBranchSlot[],
  branches: Record<string, readonly [Function] | readonly [Function, unknown]>,
): WorkflowTimelineOperationDetail[] {
  return branchNames.map((key, index) => {
    const slot = slots[index];
    const branchFunction = branches[key]?.[0];
    return {
      index,
      key: boundedString(key),
      operationId: boundedString(slot?.operationId ?? `run-all:${String(index)}:${key}`),
      operationType: 'activity',
      operationLabel: boundedString(branchFunction?.name || key),
      outcome: slot?.status === 'fulfilled' ? 'fulfilled' : 'rejected',
      ...(slot?.status === 'rejected' ? { errorSummary: boundedErrorSummary(slot.reason) } : {}),
    };
  });
}

function boundedDetails(details: readonly WorkflowTimelineOperationDetail[]): {
  details: WorkflowTimelineOperationDetail[];
  omitted: number;
} {
  return {
    details: details.slice(0, MAX_TIMELINE_COORDINATOR_DETAILS),
    omitted: Math.max(0, details.length - MAX_TIMELINE_COORDINATOR_DETAILS),
  };
}

export function recordTimelineBranches(
  internals: EngineInternals,
  workflowId: string,
  details: readonly WorkflowTimelineOperationDetail[],
): void {
  const entry = internals.pendingTimelineEntries?.get(workflowId)?.entry;
  if (entry === undefined) return;
  const bounded = boundedDetails(details);
  entry.branches = bounded.details;
  if (bounded.omitted > 0) entry.branchesOmitted = bounded.omitted;
}

export function recordTimelineSpeculation(
  internals: EngineInternals,
  workflowId: string,
  details: readonly WorkflowTimelineOperationDetail[],
  outcome: 'committed' | 'rolled-back',
): void {
  const entry = internals.pendingTimelineEntries?.get(workflowId)?.entry;
  if (entry === undefined) return;
  const bounded = boundedDetails(details);
  entry.children = bounded.details;
  if (bounded.omitted > 0) entry.childrenOmitted = bounded.omitted;
  entry.speculationOutcome = outcome;
}

/**
 * Record the task ledger operation id a remote-mode activity was just enqueued under on its
 * pending timeline entry, so `WorkflowTimelineEntry.taskOperationId` names the real ledger key.
 * Only an `activity` entry takes it: while a coordinator (`ctx.all`, `ctx.race`) is the pending
 * entry, its branches' tasks belong to no single entry.
 */
export function recordTimelineTaskIdentity(
  internals: EngineInternals,
  workflowId: string,
  taskOperationId: string,
): void {
  const entry = internals.pendingTimelineEntries?.get(workflowId)?.entry;
  if (entry === undefined || entry.operationType !== 'activity') return;
  entry.taskOperationId = taskOperationId;
}
