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
 * The invariant every commit here keeps: a signal a branch's step consumes is written only in a
 * commit whose entry already records that step's result, at every nesting depth and whatever the
 * branch does next (moves on, finishes, or throws). Three things carry it:
 *
 * - One tree per top-level step. An advancing step nested in a branch (see {@link NestedLink})
 *   runs its sections on the top-level step's chain and commits through it, so no two sections of
 *   one tree interleave, and nothing commits between a consume and the recording of its result.
 * - Held consumes. A branch's envelope is finalized into the tree's {@link HeldSideEffects}, never
 *   the workflow's staged buffer; the section that finalized it records the result and then
 *   commits, and that commit writes the held consumes and nothing staged elsewhere.
 * - Results on every slot. A branch that has not finished, or that threw, keeps the results of the
 *   steps it finished in its slot, and a nested step keeps its progress under its own step number
 *   in its parent branch's results, so the commit's entry holds every result a held consume took.
 *
 * @module engine/advancing-branches
 */

import type { ContextOperationRequest } from '../context.ts';
import {
  branchDriversOf,
  type BranchDriver,
  type BranchOutcome,
  type BranchStep,
} from '../context/branch-driver.ts';
import {
  createParallelOperationCacheEntry,
  type ParallelBranchSlot,
  type ParallelOperationCacheEntry,
} from '../context/parallel-cache-entry.ts';
import type { MidOperationCommitReport } from './checkpoint-io.ts';
import { finalizeAndUnwrap } from './deferred-consume-envelope.ts';
import { requestCompletion } from './file-workflow-completion-events.ts';
import { HeldSideEffects, type SideEffectHold } from './held-side-effects.ts';
import type { EngineInternals } from './internals.ts';
import {
  captureFirstRejection,
  createFirstRejectionCapture,
  normalizeRejectionReason,
} from './parallel-dispatch.ts';
import { recordSettledStep, takeSettledSteps } from './settled-step-sink.ts';
import { assertSupportedSignalBranches } from './signal-branch-guard.ts';

type ParallelOperation = Extract<ContextOperationRequest, { type: 'parallel' }>;

/**
 * What every advancing step nested in one top-level step shares with it: the chain its sections
 * run on, the consumes it holds, and the operations every branch has open, at any depth.
 */
type BranchTree = {
  /** Run `section` after every section of the tree before it. A section never rejects. */
  inOrder: <Result>(section: () => Promise<Result>) => Promise<Result>;
  held: HeldSideEffects;
  /** The operation each branch of the tree has open, by run and branch. */
  open: Map<string, ContextOperationRequest>;
  /** The nested steps whose runs have begun, which register their own branches' operations. */
  started: WeakSet<ContextOperationRequest>;
  /** Resolves the next time a branch of the tree closes an operation. */
  changed: () => Promise<void>;
  notifyChanged: () => void;
  nextRunId: number;
};

function createBranchTree(): BranchTree {
  let chain: Promise<void> = Promise.resolve();
  let changed = Promise.withResolvers<void>();
  return {
    inOrder: (section) => {
      const result = chain.then(section);
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    held: new HeldSideEffects(),
    open: new Map(),
    started: new WeakSet(),
    changed: () => changed.promise,
    notifyChanged: () => {
      const previous = changed;
      changed = Promise.withResolvers<void>();
      previous.resolve();
    },
    nextRunId: 0,
  };
}

/**
 * How an advancing step nested in a branch of another reports to it: through the tree they share,
 * by writing its progress under its own step number in the branch's results, and by committing
 * through the step that owns the branch.
 */
export type NestedLink = {
  tree: BranchTree;
  /** Keep `entry`, the nested step's progress, in the results of the branch it is a step of. */
  record: (entry: ParallelOperationCacheEntry) => void;
  /** Commit the owning step's progress, which now carries the nested step's. Runs in a section. */
  commit: () => Promise<void>;
};

const NESTED_LINKS = new WeakMap<ContextOperationRequest, NestedLink>();

/** The link of an advancing step a branch of another runs, or `undefined` for any other. */
export function nestedLinkOf(request: ContextOperationRequest): NestedLink | undefined {
  return NESTED_LINKS.get(request);
}

/** Add to `names` every signal `request` waits on, through every coordinator it holds. */
function collectWaitNames(
  request: ContextOperationRequest,
  started: WeakSet<ContextOperationRequest>,
  names: Set<string>,
): void {
  if (request.type === 'wait-signal') {
    names.add(request.signalName);
    return;
  }
  if (request.type !== 'race' && request.type !== 'parallel') return;
  // A nested step whose run has begun has its branches' operations open in the tree itself; its
  // own operations are only the first of each.
  if (started.has(request)) return;
  for (const operation of request.operations) collectWaitNames(operation, started, names);
}

export type AdvancingRun = {
  internals: EngineInternals;
  workflowId: string;
  operation: ParallelOperation;
  drivers: readonly BranchDriver[];
  /** Run one branch operation; a wait-signal branch resolves with its deferred-consume envelope. */
  execute: (request: ContextOperationRequest, signal: AbortSignal) => Promise<unknown>;
  parentSignal?: AbortSignal | undefined;
  /**
   * Make the step's progress durable: write its partial cache entry, then commit a checkpoint that
   * reports `report`. Absent where nothing is durable (a worker run, or a step nested in a
   * coordinator that is not an advancing step), which keeps every branch's progress in memory
   * until the step settles.
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
  /** Present for a step nested in a branch of another advancing step: see {@link NestedLink}. */
  nested?: NestedLink | undefined;
};

export type AdvancingResult = {
  slots: ParallelBranchSlot[];
  /** The step's cache entry as it settled, with the results of every branch that did not finish. */
  entry: ParallelOperationCacheEntry;
  /** The last operation each branch asked for, by branch index; absent for a branch that ran none. */
  lastRequests: (ContextOperationRequest | undefined)[];
  hasFirstError: boolean;
  firstError: unknown;
  /** An error that ends the step at once: an operation waits on one signal twice within itself. */
  fatal: { error: unknown } | undefined;
  /** A failed commit: a branch's progress never became durable. */
  commitFailure: { error: unknown } | undefined;
};

/** The outcome with a fulfilled value finalized: the consume of a wait's signal goes to `hold`. */
async function finalizeOutcome(settled: BranchOutcome, hold: SideEffectHold): Promise<BranchOutcome> {
  if (settled.status === 'rejected') return settled;
  try {
    return { status: 'fulfilled', value: await finalizeAndUnwrap(settled.value, hold) };
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
  const tree = run.nested?.tree ?? createBranchTree();
  const runId = tree.nextRunId++;
  tree.started.add(operation);
  const keyOf = (index: number) => `${String(runId)}:${String(index)}`;
  const operationIds = drivers.map((_, index) => `${operation.operationId}:${String(index)}`);
  const capture = createFirstRejectionCapture();
  const slots: ParallelBranchSlot[] = drivers.map((driver, index) => {
    const operationId = operationIds[index]!;
    if (driver.failure !== undefined) {
      // The branch threw while its recorded steps replayed: it fails as it did before the restart.
      captureFirstRejection(capture, driver.failure.error);
      return {
        status: 'rejected',
        reason: normalizeRejectionReason(driver.failure.error),
        operationId,
      };
    }
    return driver.first.done
      ? { status: 'fulfilled', value: driver.first.value, operationId }
      : { status: 'pending', operationId };
  });
  const lastRequests: (ContextOperationRequest | undefined)[] = drivers.map((driver) =>
    driver.first.done ? undefined : driver.first.request,
  );
  const active = new Map<number, ContextOperationRequest>();
  /** The next operation of a branch held back by a sibling's wait on the same signal. */
  const deferred = new Map<number, ContextOperationRequest>();
  /** The operation each unfinished branch waits on, in branch order. */
  const activeRequests = () =>
    [...active.entries()].toSorted(([left], [right]) => left - right).map(([, request]) => request);

  const openBranch = (index: number, request: ContextOperationRequest) => {
    deferred.delete(index);
    lastRequests[index] = request;
    active.set(index, request);
    tree.open.set(keyOf(index), request);
  };
  const closeBranch = (index: number) => {
    active.delete(index);
    deferred.delete(index);
    tree.open.delete(keyOf(index));
    tree.notifyChanged();
  };

  /**
   * Whether `request`, the next operation of branch `index`, waits on a signal an operation open
   * anywhere in the tree waits on: in a sibling, in a branch of a step nested in a sibling, or in
   * a branch of the step this one is nested in. Two waiters on one signal name would share one
   * waiter key, so such a branch is held until that wait ends: the lockstep rounds this step
   * replaced never had both open at once either.
   */
  const conflictsWithSibling = (index: number, request: ContextOperationRequest): boolean => {
    const held = new Set<string>();
    for (const [key, open] of tree.open) {
      if (key !== keyOf(index)) collectWaitNames(open, tree.started, held);
    }
    const wanted = new Set<string>();
    collectWaitNames(request, tree.started, wanted);
    return [...wanted].some((name) => held.has(name));
  };

  // A step that starts afresh refuses branches whose first steps wait on one signal, as `main`
  // did. A step resumed after a restart opens its branches in order and holds a later one whose
  // wait a sibling already has open, as the run held it before the restart.
  const firstRequests = drivers.flatMap((driver) => (driver.first.done ? [] : [driver.first.request]));
  if (operation.resumedCacheEntry === undefined) assertSupportedSignalBranches(firstRequests);
  for (const [index, driver] of drivers.entries()) {
    if (driver.first.done) continue;
    if (conflictsWithSibling(index, driver.first.request)) {
      deferred.set(index, driver.first.request);
    } else {
      openBranch(index, driver.first.request);
    }
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(run.parentSignal?.reason);
  if (run.parentSignal?.aborted === true) abortFromParent();
  run.parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  let fatal: AdvancingResult['fatal'];
  let commitFailure: AdvancingResult['commitFailure'];
  let ownTail: Promise<void> = Promise.resolve();
  const inOrder = <Result>(section: () => Promise<Result>): Promise<Result> => {
    const result = tree.inOrder(section);
    ownTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const rejectBranch = (index: number, error: unknown) => {
    slots[index] = {
      status: 'rejected',
      reason: normalizeRejectionReason(error),
      operationId: operationIds[index]!,
    };
    captureFirstRejection(capture, error);
    closeBranch(index);
  };

  /** The step's cache entry now: every branch that has not finished keeps its results so far. */
  const currentEntry = () =>
    createParallelOperationCacheEntry(
      'all',
      slots.map((slot, index): ParallelBranchSlot => {
        if (slot.status === 'pending' || slot.status === 'rejected') {
          return { ...slot, results: drivers[index]!.results() };
        }
        return { ...slot };
      }),
      drivers.length,
    );

  /**
   * Commit the step's progress with the consumes the tree holds. Runs in a section, after the
   * section recorded every result those consumes took. A nested step records its entry in its
   * parent branch and commits through the step that owns that branch.
   */
  const commitProgress = async (): Promise<void> => {
    if (fatal !== undefined) return;
    if (run.nested !== undefined) {
      run.nested.record(currentEntry());
      await run.nested.commit();
      return;
    }
    if (run.commit === undefined || commitFailure !== undefined) return;
    // With every branch over, the commit that settles the operation carries the step's result and
    // what the tree still holds.
    if (slots.every((slot) => slot.status !== 'pending')) return;
    if (run.isCurrent?.() === false) return;
    const taken = tree.held.take();
    const settled = takeSettledSteps(run.internals, run.workflowId);
    try {
      await run.commit({ ...operation, operations: activeRequests() }, currentEntry(), {
        settledBranchOperationIds: settled.activityOperationIds,
        settledFileWorkflowEvents: settled.events,
        sideEffects: taken?.sideEffects ?? { conditions: [], operations: [] },
      });
    } catch (error) {
      taken?.restore();
      commitFailure = { error };
    }
  };

  /**
   * Run one operation of a branch to its raw outcome: a wait's value is still its envelope. A
   * parallel step nested in the branch is linked to this one first, so it reports through it.
   */
  const settleRequest = async (
    index: number,
    request: ContextOperationRequest,
  ): Promise<BranchOutcome> => {
    if (request.type === 'parallel' && branchDriversOf(request) !== undefined) {
      NESTED_LINKS.set(request, {
        tree,
        record: (entry) => drivers[index]!.hold(request.step, entry),
        commit: commitProgress,
      });
    }
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
   * a wait on the same signal elsewhere in the tree ends. An operation that waits on one signal
   * twice within itself ends the whole step. Returns whether the branch goes on.
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
      openBranch(index, next.request);
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
   * Settle one operation of a branch, in one section: finalize it (holding the consume of a wait's
   * signal), resume the branch with it, and commit. The commit runs whatever the branch did with
   * a fulfilled outcome, so a consume is written with the result that took it, even when the
   * branch then threw. Returns where the branch stands, or `undefined` for a branch that is over.
   */
  const settleStep = async (
    index: number,
    request: ContextOperationRequest,
    settled: BranchOutcome,
  ): Promise<BranchStep | undefined> => {
    if (mustStop(index)) return undefined;
    const outcome = await finalizeOutcome(settled, tree.held.hold);
    let next: BranchStep | undefined;
    if (mustStop(index)) {
      next = undefined;
    } else {
      closeBranch(index);
      if (outcome.status === 'fulfilled') {
        recordSettledStep(run.internals, run.workflowId, requestCompletion(request, outcome.value));
      }
      next = resumeBranch(index, outcome);
      if (next !== undefined && !placeBranch(index, next)) next = undefined;
    }
    if (outcome.status === 'fulfilled') await commitProgress();
    return next;
  };

  /**
   * Hold a branch whose next operation waits on a signal open elsewhere in the tree until that
   * wait ends, then open it and commit, so the commit records its start. Returns whether the
   * branch goes on.
   */
  const startDeferred = async (index: number, request: ContextOperationRequest) => {
    while (conflictsWithSibling(index, request)) {
      await tree.changed();
      if (controller.signal.aborted) {
        rejectBranch(index, controller.signal.reason);
        return false;
      }
      if (mustStop(index)) return false;
    }
    openBranch(index, request);
    await inOrder(commitProgress);
    return true;
  };

  const runBranch = async (index: number): Promise<void> => {
    let step: BranchStep = drivers[index]!.first;
    // A run that was cancelled, or replaced, while a sibling still waited starts nothing more.
    while (!step.done && !mustStop(index)) {
      const request = step.request;
      if (deferred.get(index) === request && !(await startDeferred(index, request))) return;
      const settled = await settleRequest(index, request);
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
    await ownTail;
  } finally {
    run.parentSignal?.removeEventListener('abort', abortFromParent);
    controller.abort();
    for (const index of drivers.keys()) tree.open.delete(keyOf(index));
    tree.notifyChanged();
  }
  const entry = currentEntry();
  if (run.nested === undefined) {
    // The commit that settles the operation writes the entry; it writes what is still held too.
    tree.held.stageRemaining(run.internals, run.workflowId);
  } else {
    run.nested.record(entry);
  }
  return {
    slots,
    entry,
    lastRequests,
    hasFirstError: capture.hasFirstError,
    firstError: capture.firstError,
    fatal,
    commitFailure,
  };
}
