/**
 * Run bookkeeping (COR-2376 slice S19): the gate that refuses a run once shutdown began, releasing a
 * terminal run's toolbox, the abort signal of background work, the approval overrides a review
 * holds, and the task records a run's wakeup and settlement write. Built by `constructBureau` and
 * reached only through `createBureau`; the parent and several seams call into it.
 */
import type { AgentDefinitions } from '../agent-catalog';
import type { BureauCore } from './core';
import { BureauError } from '../bureau-errors';
import type { BureauToolbox } from '../runtime-composition-types';
import { detachBestEffortPromise } from '../bureau-construction-support';
import { serializeUnknownError } from '../serialization';
import { settledTaskState, type TaskUsage } from '../task-registry';

/** The callables run bookkeeping reads from elsewhere in `constructBureau`. */
export interface RunBookkeepingPeers {
  /** Stops the lazy expiry sweep once no review is held. */
  readonly stopLazyExpirySweepWhenNoneHeld: () => void;
}

/** Builds the run bookkeeping of one Bureau. Synchronous, and registers nothing. */
export function createRunBookkeeping<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: RunBookkeepingPeers,
) {
  const {
    store,
    diagnose,
    runToolboxes,
    backgroundShutdownController,
    pendingApprovalOverrides,
    pendingApprovalRounds,
    interruptedApprovals,
    approvalRequestedAt,
  } = core;

  function assertRunAdmissionOpen(subject: 'run' | 'scheduler task'): void {
    if (core.runAdmissionClosed) {
      throw new BureauError(`Cannot create ${subject}: Bureau is shutting down.`, 'CONFLICT');
    }
  }

  // COR-690: a terminal run's toolbox leaves the tracked set only once its own
  // execution lifecycle is idle. A tool callback that ignored the run's abort
  // is still running inside it, and a later `shutdown()` must find and await it.
  function releaseRunToolboxWhenIdle(runToolbox: BureauToolbox): void {
    detachBestEffortPromise(runToolbox.whenIdle().then(() => runToolboxes.delete(runToolbox)));
  }

  function withBackgroundShutdownSignal(callerSignal: AbortSignal | undefined): AbortSignal {
    return callerSignal
      ? AbortSignal.any([callerSignal, backgroundShutdownController.signal])
      : backgroundShutdownController.signal;
  }

  function interruptedFields(
    reviewId: string,
  ): { interrupted: true; resolutionStartedAt: number | undefined } | Record<never, never> {
    return interruptedApprovals.has(reviewId)
      ? { interrupted: true, resolutionStartedAt: interruptedApprovals.get(reviewId) }
      : {};
  }

  function dropPendingApprovalOverride(reviewId: string): void {
    pendingApprovalOverrides.delete(reviewId);
    pendingApprovalRounds.delete(reviewId);
    interruptedApprovals.delete(reviewId);
    approvalRequestedAt.delete(reviewId);
    peers.stopLazyExpirySweepWhenNoneHeld();
  }

  /**
   * COR-1987 — keeps a task's pending wakeup on its record, so a reload can read it back: a
   * `schedule.wakeup` record sets it from the time the run announced, and the run parking on a
   * human wait clears it, because the run then waits for a person, not the clock. A wakeup that
   * has fired, or a run that ended, needs no write: the task's view shows a wakeup only while the
   * task is working and the time is still ahead.
   */
  function recordTaskWakeup(action: {
    readonly runId: string;
    readonly type: string;
    readonly detail: unknown;
  }): void {
    let wakeAt: number | null;
    if (action.type === 'schedule.wakeup') {
      const detail =
        action.detail !== null && typeof action.detail === 'object'
          ? (action.detail as Record<string, unknown>)
          : {};
      const announced = detail['wakeAt'];
      if (typeof announced !== 'number' || !Number.isFinite(announced)) return;
      wakeAt = announced;
    } else if (action.type === 'multiagent.human-wait.parked') {
      wakeAt = null;
    } else {
      return;
    }
    core.tasks.recordWakeup(action.runId, wakeAt).catch((error: unknown) => {
      diagnose({
        level: 'error',
        scope: 'task-registry',
        message: `[bureau] Could not record the wakeup of task "${action.runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    });
  }

  /**
   * COR-2524 — keeps what a run has used and cost so far on its task record, after each step: a
   * `usage.accumulated` action carries the run's token total and, when a request has been priced,
   * its cost so far. A run no request of which was priced records `costUsd: null`, never `0`. The
   * write is skipped once the task has settled, so a figure from a step cannot replace the run's own
   * total, which rides the settlement.
   */
  function recordTaskUsage(action: {
    readonly runId: string;
    readonly type: string;
    readonly detail: unknown;
  }): void {
    if (action.type !== 'usage.accumulated') return;
    const detail = recordOf(action.detail);
    const usage = usageOfDetail(recordOf(detail['totalUsage']), detail['totalCost']);
    if (usage === undefined) return;
    core.tasks.recordUsage(action.runId, usage).catch((error: unknown) => {
      diagnose({
        level: 'error',
        scope: 'task-registry',
        message: `[bureau] Could not record the usage of task "${action.runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    });
  }

  /** COR-1481 — records how a task ended, from the action that ended its run. */
  function recordTaskSettlement(action: {
    readonly runId: string;
    readonly type: string;
    readonly detail: unknown;
    readonly timestamp: number;
  }): void {
    // `run.error` is not a settlement of its own: Operative announces it before the
    // `run.completed` (or `run.aborted`) that ends the run and carries its finish reason, so
    // the one write comes from that. A `run.error` with no such end is another process's, which
    // `isCommittedElsewhere` keeps from reaching here.
    if (action.type !== 'run.completed' && action.type !== 'run.aborted') {
      return;
    }
    const detail =
      action.detail !== null && typeof action.detail === 'object'
        ? (action.detail as Record<string, unknown>)
        : {};
    const finishReason =
      typeof detail['finishReason'] === 'string' ? detail['finishReason'] : undefined;
    const status =
      action.type === 'run.completed' ? settledTaskState('completed', finishReason) : 'canceled';
    const failure = detail['error'];
    // Every cancellation terminal, a shutdown's abort included, follows its run's cleanup the
    // way an API cancellation does, so the task reports what the cleanup actually did.
    if (status === 'canceled') {
      const activeRun = store.getRun(action.runId)?.activeRun;
      if (activeRun !== undefined) void core.tasks.watchCleanup(action.runId, activeRun.closed());
    }
    // COR-2524 — the run's own total, written in the same compare-and-swap as the settlement. A
    // run with no priced request says `null`: the run's `costEstimate` is absent, never `0`.
    const usage = usageOfDetail(
      recordOf(detail['usage']),
      recordOf(detail['costEstimate'])['totalCost'],
    );
    void core.tasks
      .recordSettled(action.runId, {
        at: new Date(action.timestamp).toISOString(),
        status,
        finishReason: finishReason ?? (status === 'canceled' ? 'aborted' : null),
        message:
          status === 'failed' && failure !== undefined && failure !== null
            ? serializeUnknownError(failure).slice(0, 1000)
            : null,
        ...(usage === undefined ? {} : { usage }),
      })
      .catch((error: unknown) => {
        diagnose({
          level: 'error',
          scope: 'task-registry',
          message: `[bureau] Could not record how task "${action.runId}" ended: ${serializeUnknownError(error)}`,
          cause: error,
        });
      });
  }

  return {
    assertRunAdmissionOpen,
    releaseRunToolboxWhenIdle,
    withBackgroundShutdownSignal,
    interruptedFields,
    dropPendingApprovalOverride,
    recordTaskWakeup,
    recordTaskUsage,
    recordTaskSettlement,
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * A task's usage from a run's token total and its cost so far, or `undefined` when the tokens are
 * not numbers. A cost that is not a finite number is `null`: unknown, never `0`.
 */
function usageOfDetail(tokens: Record<string, unknown>, cost: unknown): TaskUsage | undefined {
  const { prompt, completion, total } = tokens;
  if (
    typeof prompt !== 'number' ||
    typeof completion !== 'number' ||
    typeof total !== 'number' ||
    !Number.isFinite(prompt + completion + total)
  ) {
    return undefined;
  }
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
  };
}
