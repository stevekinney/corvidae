/**
 * Runs the branches of an advancing parallel step (a document `parallel`): every branch moves on
 * the moment its own current operation settles, without waiting for a sibling's, and each step a
 * branch settles is committed durably while a sibling is still running.
 *
 * Each branch is a driver (see `context/branch-driver.ts`) the engine resumes with the settled
 * outcome of the operation it asked for. The branch keeps its own results, numbered in its own
 * scope, so the commit writes the step's cache entry with each unfinished branch's results so far,
 * and a recovered run resumes every branch where it stopped instead of running its finished
 * operations again.
 *
 * @module engine/advancing-branches
 */

import type { ContextOperationRequest } from '../context.ts';
import type { BranchDriver, BranchOutcome, BranchStep } from '../context/branch-driver.ts';
import {
  createParallelOperationCacheEntry,
  type ParallelBranchSlot,
  type ParallelOperationCacheEntry,
} from '../context/parallel-cache-entry.ts';
import type { MidOperationCommitReport } from './checkpoint-io.ts';
import { finalizeAndUnwrap } from './deferred-consume-envelope.ts';
import { requestCompletion } from './file-workflow-completion-events.ts';
import {
  captureFirstRejection,
  createFirstRejectionCapture,
  normalizeRejectionReason,
} from './parallel-dispatch.ts';
import { recordSettledStep, takeSettledSteps } from './settled-step-sink.ts';
import { assertSupportedSignalBranches } from './signal-branch-guard.ts';

type ParallelOperation = Extract<ContextOperationRequest, { type: 'parallel' }>;

export type AdvancingRun = {
  internals: object;
  workflowId: string;
  operation: ParallelOperation;
  drivers: readonly BranchDriver[];
  /** Run one branch operation; a wait-signal branch resolves with its deferred-consume envelope. */
  execute: (request: ContextOperationRequest, signal: AbortSignal) => Promise<unknown>;
  parentSignal?: AbortSignal | undefined;
  /**
   * Make the step's progress durable: write its partial cache entry, then commit a checkpoint that
   * reports `report`. Absent where nothing is durable (a step nested in another coordinator, or a
   * worker run), which keeps every branch's progress in memory until the step settles.
   */
  commit?:
    | ((
        operation: ParallelOperation,
        entry: ParallelOperationCacheEntry,
        report: MidOperationCommitReport,
      ) => Promise<void>)
    | undefined;
  /** Whether the run this step belongs to is still the one that is current. */
  isCurrent?: (() => boolean) | undefined;
};

export type AdvancingResult = {
  slots: ParallelBranchSlot[];
  /** The last operation each branch asked for, by branch index; absent for a branch that ran none. */
  lastRequests: (ContextOperationRequest | undefined)[];
  hasFirstError: boolean;
  firstError: unknown;
  /** An error that ends the step at once: a sibling would wait on a signal another branch waits on. */
  fatal: { error: unknown } | undefined;
  /** A failed commit: a branch's progress never became durable. */
  commitFailure: { error: unknown } | undefined;
};

/** The outcome with a fulfilled value finalized: the consume of a wait's signal is staged. */
async function finalizeOutcome(settled: BranchOutcome): Promise<BranchOutcome> {
  if (settled.status === 'rejected') return settled;
  try {
    return { status: 'fulfilled', value: await finalizeAndUnwrap(settled.value) };
  } catch (error) {
    return { status: 'rejected', error };
  }
}

/**
 * Run every branch to its end and return the settled slots. Never rejects for a branch's failure:
 * the caller rethrows `firstError` once every branch has settled, as `ctx.all` does.
 */
export async function runAdvancingBranches(run: AdvancingRun): Promise<AdvancingResult> {
  const { drivers, operation } = run;
  const operationIds = drivers.map((_, index) => `${operation.operationId}:${String(index)}`);
  const slots: ParallelBranchSlot[] = drivers.map((driver, index) =>
    driver.first.done
      ? { status: 'fulfilled', value: driver.first.value, operationId: operationIds[index]! }
      : { status: 'pending', operationId: operationIds[index]! },
  );
  const lastRequests: (ContextOperationRequest | undefined)[] = drivers.map((driver) =>
    driver.first.done ? undefined : driver.first.request,
  );
  const active = new Map<number, ContextOperationRequest>();
  /** The next operation of a branch held back by a sibling's wait on the same signal. */
  const deferred = new Map<number, ContextOperationRequest>();
  for (const [index, driver] of drivers.entries()) {
    if (!driver.first.done) active.set(index, driver.first.request);
  }
  /** The operation each unfinished branch waits on, in branch order. */
  const activeRequests = () =>
    [...active.entries()].toSorted(([left], [right]) => left - right).map(([, request]) => request);
  assertSupportedSignalBranches(activeRequests());

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(run.parentSignal?.reason);
  if (run.parentSignal?.aborted === true) abortFromParent();
  run.parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  const capture = createFirstRejectionCapture();
  let fatal: AdvancingResult['fatal'];
  let commitFailure: AdvancingResult['commitFailure'];
  let chain: Promise<void> = Promise.resolve();

  /**
   * Wakes the branches held back by {@link conflictsWithSibling}: told whenever a branch's open
   * operation ends or the step fails. A promise per change, so a branch awaits the next one.
   */
  let changed = Promise.withResolvers<void>();
  const notifyChanged = () => {
    const previous = changed;
    changed = Promise.withResolvers<void>();
    previous.resolve();
  };

  const rejectBranch = (index: number, error: unknown) => {
    slots[index] = {
      status: 'rejected',
      reason: normalizeRejectionReason(error),
      operationId: operationIds[index]!,
    };
    captureFirstRejection(capture, error);
    active.delete(index);
    deferred.delete(index);
    notifyChanged();
  };

  /**
   * Whether `request`, the next operation of branch `index`, waits on a signal an operation a
   * sibling has open waits on. Two waiters on one signal name would share one waiter key, so such a
   * branch is held until the sibling's wait ends: the lockstep rounds this step replaced never had
   * both open at once either.
   */
  const conflictsWithSibling = (index: number, request: ContextOperationRequest): boolean => {
    const siblings = [...active.entries()]
      .filter(([other]) => other !== index)
      .map(([, open]) => open);
    try {
      assertSupportedSignalBranches([...siblings, request]);
      return false;
    } catch {
      return true;
    }
  };

  const commitProgress = async () => {
    if (run.commit === undefined || commitFailure !== undefined || fatal !== undefined) return;
    // With every branch finished the step's own result carries what a commit would.
    if (slots.every((slot) => slot.status !== 'pending')) return;
    if (run.isCurrent?.() === false) return;
    const entry = createParallelOperationCacheEntry(
      'all',
      slots.map((slot, index): ParallelBranchSlot =>
        slot.status === 'pending' ? { ...slot, results: drivers[index]!.results() } : { ...slot },
      ),
      drivers.length,
    );
    const settled = takeSettledSteps(run.internals, run.workflowId);
    try {
      await run.commit({ ...operation, operations: activeRequests() }, entry, {
        settledBranchOperationIds: settled.activityOperationIds,
        settledFileWorkflowEvents: settled.events,
      });
    } catch (error) {
      commitFailure = { error };
    }
  };

  /**
   * Run `section` after every section before it. A step settles in one: finalizing a wait
   * branch's envelope stages the consume of its signal record into the next commit, which must be
   * the commit that makes this step's result durable, not one a sibling's step opens meanwhile.
   * A section never rejects.
   */
  const inOrder = <Result>(section: () => Promise<Result>): Promise<Result> => {
    const result = chain.then(section);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  /** Run one operation of a branch to its raw outcome: a wait's value is still its envelope. */
  const settleRequest = async (request: ContextOperationRequest): Promise<BranchOutcome> => {
    try {
      return { status: 'fulfilled', value: await run.execute(request, controller.signal) };
    } catch (error) {
      return { status: 'rejected', error };
    }
  };

  /** Resume a branch with an outcome; a branch that throws is over, and its error is kept. */
  const resumeBranch = (index: number, outcome: BranchOutcome): BranchStep | undefined => {
    try {
      return drivers[index]!.resume(outcome);
    } catch (error) {
      rejectBranch(index, error);
      return undefined;
    }
  };

  /**
   * Take a branch to where `next` puts it: finished, open on its next operation, or held back until
   * a sibling's wait on the same signal ends. An operation that waits on one signal twice within
   * itself ends the whole step. Returns whether the branch goes on.
   */
  const placeBranch = (index: number, next: BranchStep): boolean => {
    if (next.done) {
      slots[index] = { status: 'fulfilled', value: next.value, operationId: operationIds[index]! };
      return true;
    }
    try {
      assertSupportedSignalBranches([next.request]);
    } catch (error) {
      fatal = { error };
      controller.abort(error);
      rejectBranch(index, error);
      return false;
    }
    if (conflictsWithSibling(index, next.request)) {
      deferred.set(index, next.request);
    } else {
      lastRequests[index] = next.request;
      active.set(index, next.request);
    }
    return true;
  };

  /** Whether this branch must stop: the step failed fast, or its run is no longer the current one. */
  const mustStop = (index: number): boolean => {
    if (fatal !== undefined) {
      rejectBranch(index, fatal.error);
      return true;
    }
    if (run.isCurrent?.() === false) {
      rejectBranch(index, new Error('The workflow is no longer running this parallel step.'));
      return true;
    }
    return false;
  };

  /**
   * Settle one operation of a branch: finalize it, resume the branch with it, and, when the step
   * succeeded, commit what the branch has done. Returns where the branch stands, or `undefined` for
   * a branch that is over.
   */
  const settleStep = async (
    index: number,
    request: ContextOperationRequest,
    settled: BranchOutcome,
  ): Promise<BranchStep | undefined> => {
    if (mustStop(index)) return undefined;
    const outcome = await finalizeOutcome(settled);
    if (mustStop(index)) return undefined;
    active.delete(index);
    notifyChanged();
    if (outcome.status === 'fulfilled') {
      recordSettledStep(run.internals, run.workflowId, requestCompletion(request, outcome.value));
    }
    const next = resumeBranch(index, outcome);
    if (next === undefined || !placeBranch(index, next)) return undefined;
    if (outcome.status === 'fulfilled') await commitProgress();
    return next;
  };

  /**
   * Hold a branch whose next operation waits on a signal a sibling waits on until that wait ends,
   * then open it and commit, so the commit records its start. Returns whether the branch goes on.
   */
  const startDeferred = async (index: number, request: ContextOperationRequest) => {
    while (conflictsWithSibling(index, request)) {
      await changed.promise;
      if (mustStop(index)) return false;
    }
    deferred.delete(index);
    lastRequests[index] = request;
    active.set(index, request);
    await inOrder(commitProgress);
    return true;
  };

  const runBranch = async (index: number): Promise<void> => {
    let step: BranchStep = drivers[index]!.first;
    // A run that was cancelled, or replaced, while a sibling still waited starts nothing more.
    while (!step.done && !mustStop(index)) {
      const request = step.request;
      if (deferred.get(index) === request && !(await startDeferred(index, request))) return;
      const settled = await settleRequest(request);
      const next = await inOrder(() => settleStep(index, request, settled));
      if (next === undefined) return;
      step = next;
    }
  };

  try {
    await Promise.all(
      drivers.map((_, index) =>
        slots[index]!.status === 'pending' ? runBranch(index) : Promise.resolve(),
      ),
    );
    await chain;
  } finally {
    run.parentSignal?.removeEventListener('abort', abortFromParent);
    controller.abort();
  }
  return {
    slots,
    lastRequests,
    hasFirstError: capture.hasFirstError,
    firstError: capture.firstError,
    fatal,
    commitFailure,
  };
}
