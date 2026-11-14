/**
 * An advancing parallel step: `ctx.all` over branches that are sequences of operations, not single
 * ones. Each branch moves on as soon as its own current operation settles, without waiting for its
 * siblings' current operations, and a branch that finishes (or finishes a step) is committed
 * durably on its own, so a recovered run resumes every branch where it stopped.
 *
 * Every branch counts its own steps from zero in a scope of its own (see `branch-driver.ts`), so a
 * step's number does not depend on the order the branches settle in. The step's cache entry keeps,
 * for a branch that has not finished, the results of its steps so far; replaying them feeds the
 * branch back to where it stopped.
 *
 * @module context/advancing-operations
 */

import {
  attachBranchDrivers,
  settledBranchDriver,
  startBranchDriver,
  type BranchDriver,
} from './branch-driver.ts';
import type { Context } from './index.ts';
import {
  getInternals,
  hasContextInternals,
  stepStateKey,
  yieldOperation,
  type ContextInternals,
} from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import {
  assertValidParallelOperationCacheEntry,
  BranchTopologyChangedError,
  createParallelOperationCacheEntry,
  isParallelOperationCacheEntry,
  type ParallelBranchSlot,
} from './parallel-cache-entry.ts';
import { captureCallerStack } from './validation.ts';

/**
 * The slots a replay finds cached for the step, validated against the step it replays, or
 * `undefined` for a step that has none.
 */
function cachedSlots(
  cached: unknown,
  step: number,
  branchCount: number,
): readonly ParallelBranchSlot[] | undefined {
  assertValidParallelOperationCacheEntry(cached);
  if (!isParallelOperationCacheEntry(cached)) return undefined;
  if (cached.variant !== 'all') {
    throw new BranchTopologyChangedError(
      `A parallel step at step ${String(step)} found a cached entry of variant '${cached.variant}'. The same step must use the same parallel primitive across retries.`,
    );
  }
  if (cached.subOperationCount !== branchCount) {
    throw new BranchTopologyChangedError(
      `A parallel step's branch count changed across retry: expected ${String(cached.subOperationCount)}, got ${String(branchCount)}. Branch count must be deterministic.`,
    );
  }
  return cached.branches;
}

/** The cache entry of a step whose branches all finished with `values`. */
function finishedEntry(operationId: string, values: readonly unknown[]) {
  return createParallelOperationCacheEntry(
    'all',
    values.map((value, index): ParallelBranchSlot => ({
      status: 'fulfilled',
      value,
      operationId: `${operationId}:${String(index)}`,
    })),
    values.length,
  );
}

/**
 * Whether the step `context` numbers next can run as an advancing parallel step: it belongs to an
 * inline run, and does not hold what a run persisted before branches advanced on their own left
 * there, as the first result of the lockstep rounds it ran (see the document `parallel` step).
 */
export function canAdvanceBranches(context: object): boolean {
  if (!hasContextInternals(context)) return false;
  const internals = getInternals(context);
  const results = internals.accumulatedResults;
  return (
    results?.has(internals.stepIndex) !== true ||
    isParallelOperationCacheEntry(results.get(internals.stepIndex))
  );
}

/** {@link advanceBranches} for a caller outside the context's own modules. */
export function* advanceBranchesOf(
  context: object,
  branches: Generator<ContextOperationRequest, unknown, unknown>[],
): Generator<ContextOperationRequest, unknown[], unknown> {
  if (!hasContextInternals(context)) {
    throw new Error('An advancing parallel step needs the context of an inline workflow run.');
  }
  return yield* advanceBranches(context, getInternals(context), branches);
}

/**
 * Run `branches` as an advancing parallel step and return each branch's result, in order. A branch
 * is a generator of operations; it is not started until the step runs.
 */
export function* advanceBranches(
  context: Context,
  internals: ContextInternals,
  branches: Generator<ContextOperationRequest, unknown, unknown>[],
): Generator<ContextOperationRequest, unknown[], unknown> {
  const step = internals.stepIndex++;
  const operationId = `parallel:${stepStateKey(internals, step)}`;
  const parentNamespace =
    internals.branchNamespace === undefined ? '' : `${internals.branchNamespace}/`;
  const namespace = `${parentNamespace}p${String(step)}`;

  const cached = internals.accumulatedResults?.get(step);
  const slots = cachedSlots(cached, step, branches.length);
  if (slots?.every((slot) => slot.status === 'fulfilled') === true) {
    return slots.map((slot) => (slot.status === 'fulfilled' ? slot.value : undefined));
  }

  const drivers: BranchDriver[] = branches.map((generator, index) => {
    const slot = slots?.[index];
    if (slot?.status === 'fulfilled') return settledBranchDriver(slot.value);
    return startBranchDriver(internals, generator, {
      namespace: `${namespace}.${String(index)}`,
      results: slot?.status === 'pending' ? slot.results : undefined,
    });
  });
  const operations = drivers.flatMap((driver) => (driver.first.done ? [] : [driver.first.request]));
  if (operations.length === 0) {
    // Every branch finished while priming (its steps all had results): nothing for the engine to run.
    const values = drivers.map((driver) => (driver.first.done ? driver.first.value : undefined));
    context.accumulatedResults.set(step, finishedEntry(operationId, values));
    return values;
  }

  const request: ContextOperationRequest = {
    type: 'parallel',
    operationId,
    operations,
    step,
    ...(cached === undefined ? {} : { resumedCacheEntry: cached }),
    callerStack: captureCallerStack(),
  };
  attachBranchDrivers(request, drivers);
  const values = (yield* yieldOperation(internals, request)) as unknown[];
  // The engine writes this entry itself when it runs inline; write it here too so a replay sees a
  // finished step whatever strategy ran it.
  context.accumulatedResults.set(step, finishedEntry(operationId, values));
  return values;
}
