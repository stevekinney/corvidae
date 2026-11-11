/**
 * Run operations (COR-2376 slice S12): reading, subscribing to, aborting, deleting and cancelling
 * runs, the durable run reads, and the run ownership restore and prune passes. Built by
 * `constructBureau` and reached only through `createBureau`; task start, sessions, child runs,
 * maintenance, fire approval restore and review records call into it.
 */
import type { AbortingRun } from '../bureau-types/facade';
import type { CancelDurableRunOutcome, RunSummary } from '../bureau-types/runs';
import type { PendingReview, ReviewStatus, SessionPendingReview } from '../bureau-types/reviews';
import type {
  ActiveRun,
  AgentSession,
  LivenessSnapshot,
  CleanupAcknowledgement as RunCleanupAcknowledgement,
  Subscription,
} from '@lostgradient/operative';
import type { AgentDefinitions } from '../agent-catalog';
import type { BureauCore, ScheduledFireApprovalEnding } from './core';
import { BureauError } from '../bureau-errors';
import type { ListFilter, ListOptions } from '@lostgradient/weft';
import { RunAbortSettledEvent } from '../events';
import {
  type RunAttribution,
  findRunAgentName,
  serializeRunDetail,
  serializeRunState,
  serializeUnknownError,
} from '../serialization';
import type { SignedPendingToolApproval } from 'armorer';
import { detachBestEffortPromise } from '../bureau-construction-support';
import { isPlainAuthorityRecord } from '../session-authority';
import { isTerminalApprovalBindingError } from '../recovered-run-classification';
import { ownEntry } from '../own-entry';
import { resolveCancelDurableRun, resolveWaitForDurableRun } from '../durable-run-waits';

/** The callables run operations reads from elsewhere in `constructBureau`. */
export interface RunOperationsPeers {
  /** Retries a run deletion persistence write. */
  readonly retryRunDeletionPersistenceWrite: (
    operation: 'pending-approvals' | 'resolved-reviews',
    sessionId: string,
    reviewIdPrefix: string,
  ) => Promise<void>;
  /** Closes the human waits of a canceled fire. */
  readonly closeCanceledFireHumanWaits: (runId: string, principal: string) => Promise<void>;
  /** Closes the review of a canceled fire. */
  readonly closeCanceledFireReview: (
    review: PendingReview,
    principal: string,
    known?: { readonly historyHoldsCancel?: boolean },
  ) => Promise<void>;
  /** Releases the approval a scheduled fire holds. */
  readonly releaseScheduledFireApproval: (
    runId: string,
    reviewId: string,
    ending: ScheduledFireApprovalEnding,
    scope?: { sessionId?: string | undefined; durablyPruned?: boolean },
  ) => Promise<void>;
  /** Reads the session identifiers of a run. */
  readonly getRunSessionIdentifier: (runState: { activeRun: ActiveRun }) => string;
  /** Runs the terminal checkpoint cleanup of a run. */
  readonly runTerminalCheckpointCleanup: (runId: string) => Promise<RunCleanupAcknowledgement>;
  /** Records a review status transition. */
  readonly recordReviewStatusTransition: (
    review: PendingReview,
    status: Exclude<ReviewStatus, 'pending' | 'approved' | 'denied' | 'rejected'>,
    principal: string,
    parts?: { readonly audit?: boolean; readonly dispatch?: boolean },
  ) => Promise<void>;
  /** Lists the pending reviews. */
  readonly listPendingReviews: () => SessionPendingReview[];
  /** Reads what a held run is attributed to. */
  readonly attributionOf: (runId: string) => RunAttribution | undefined;
  /** Reads the session a durable run input names. */
  readonly durableInputSessionId: (input: unknown) => string | undefined;
  /** Settles the session inputs of a run that ended. */
  readonly settleSessionInputsAfterRunEnd: (sessionId: string, runId: string) => Promise<void>;
}

/** Builds the run operations of one Bureau. Synchronous, and registers nothing. */
export function createRunOperations<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: RunOperationsPeers,
) {
  const {
    options,
    runtimeServices,
    store,
    emitter,
    runSessionIdentifiers,
    runSessionIncarnations,
    runtime,
    diagnose,
    runToolboxesByRunId,
    releaseRunScope,
    resolvedReviewIds,
    pendingApprovalOverrides,
    pendingApprovalRounds,
    terminalReviewSessions,
    scheduledFireApprovalRuns,
    invalidApprovalReviewIds,
    runAttribution,
    sessionInputGates,
    runRequestContexts,
    terminalCheckpointCleanups,
    abortingRunIds,
    humanWaitParkBaseline,
  } = core;

  function getRun(id: string) {
    const runState = store.getRun(id);
    if (!runState) return undefined;

    return serializeRunDetail(
      runState,
      peers.getRunSessionIdentifier(runState),
      peers.attributionOf(id),
    );
  }

  function subscribeRunSnapshot(
    runId: string,
    observer: (snapshot: LivenessSnapshot) => void,
    requestOptions?: { signal?: AbortSignal },
  ): Subscription {
    const runState = store.getRun(runId);
    if (!runState) {
      throw new BureauError('Run not found', 'NOT_FOUND');
    }

    return runState.activeRun.subscribeSnapshot(observer, requestOptions);
  }

  /**
   * AB-37/AB-205: idempotent. A repeat call, or one arriving after the run
   * finished on its own, returns the run's current summary instead of
   * throwing `CONFLICT`. Called against a still-`'running'` run it requests
   * cancellation and returns synchronously with the transitional
   * `status: 'aborting'` — never a fabricated terminal `'aborted'` before
   * teardown has actually started.
   *
   * `'aborting'` is reported ONLY in `abortRun`'s own return value here, not
   * through `getRun`/`listRuns` (which keep reporting the run's real,
   * unmodified `store` status — still `'running'` at this point): a run in
   * this window has NOT actually stopped running yet — `store`'s `RunState`,
   * the flow-control admission slot, and every other "is this run still
   * live" consumer all still treat it as `'running'` until its own terminal
   * event fires. Surfacing `'aborting'` through those general-purpose status
   * reads would make `status !== 'running'` — the idiom this codebase (and
   * `operative/test/wait.ts`'s `waitForRunState`) uses throughout to mean
   * "this run has settled" — falsely true before settlement has actually
   * happened.
   */
  function abortRun(id: string, reason = 'Aborted via API'): RunSummary {
    const runState = store.getRun(id);
    if (!runState) throw new BureauError('Run not found', 'NOT_FOUND');

    if (runState.status !== 'running') {
      // AB-369 review finding (PR #583, Codex): do NOT clear `abortingRunIds`
      // here just because the run's status has left `'running'` — status can
      // flip to a terminal value slightly BEFORE the same settlement's
      // `closed()` continuation below actually runs (see that continuation's
      // own comment). Deleting the entry here, on a same-run repeat call
      // landing in that window, would make `listAbortingRuns()` under-report
      // a cleanup that has not genuinely finished yet — exactly the
      // invisible-leak failure mode this issue exists to close. The entry is
      // cleared exclusively by the `closed()` continuation, the one place
      // that actually knows cleanup settled.
      return serializeRunState(
        runState,
        peers.getRunSessionIdentifier(runState),
        peers.attributionOf(id),
      );
    }

    if (!abortingRunIds.has(id)) {
      abortingRunIds.set(id, runtimeServices.clock.now());
      runState.activeRun.abort(reason);
      // COR-1481 — the task records where its cleanup ended.
      void core.tasks.watchCleanup(id, runState.activeRun.closed());
      // Evict the transitional marker once cleanup genuinely settles — never
      // on `abort()` returning, which is synchronous and proves nothing
      // about teardown. `closed()` never rejects (AB-204), so this is a
      // plain best-effort continuation, not a value anything awaits.
      detachBestEffortPromise(
        runState.activeRun.closed().then(() => {
          abortingRunIds.delete(id);
          emitter.dispatch(new RunAbortSettledEvent(id));
          return undefined;
        }),
      );
      // AB-46: `abortRun` carries no principal, so every still-pending review
      // (both kinds) scoped to this run is attributed to the synthetic
      // principal `'system:run-abort'`. `abortRun` itself stays synchronous
      // (its `RunSummary` return predates this record), so this is a
      // best-effort detached continuation, matching the pattern above.
      detachBestEffortPromise(
        revokePendingApprovalsForRun(id, { status: 'canceled', principal: 'system:run-abort' }),
      );
      // COR-772 — the explicit parent-cancellation policy. A child never
      // shares this run's abort signal; each running child's recorded
      // `parentCancellation` decides whether it is cancelled or detached.
      detachBestEffortPromise(core.childTopology.parentCancelled(id, reason));
    }

    return {
      ...serializeRunState(
        runState,
        peers.getRunSessionIdentifier(runState),
        peers.attributionOf(id),
      ),
      status: 'aborting',
    };
  }

  /**
   * AB-369: publicly read snapshot of `abortingRunIds` — every run
   * `abortRun` has requested cancellation for whose `activeRun.closed()`
   * has not yet settled, paired with the `runtimeServices.clock.now()`
   * timestamp recorded when cancellation was first requested. A run that
   * regresses the `closed().then(() => abortingRunIds.delete(id))` cleanup
   * above stays listed here for the life of the process — exactly the leak
   * `BureauQuiescenceReport` (`bureau/test`) surfaces at shutdown.
   */
  function listAbortingRuns(): readonly AbortingRun[] {
    return Array.from(abortingRunIds, ([runId, since]) => ({ runId, since }));
  }

  /**
   * The single owner of review cancellation (AB-46 coordinator ruling):
   * transitions every still-pending review — BOTH kinds — scoped to `runId`
   * to `outcome.status`, attributed to `outcome.principal`. `deleteRun` and
   * `deleteSession` pass `{ status: 'revoked', principal: 'system:run-deletion'
   * | 'system:session-deletion' }`; `abortRun` and `cancelDurableRun` pass
   * `{ status: 'canceled', principal: 'system:run-abort' }`. A `tool-approval`
   * review additionally has its binding revoked (unchanged from before this
   * record); a `human-wait` review has nothing to revoke — it is simply
   * marked resolved, so it stops appearing in `listPendingReviews()` and a
   * later `resolveReview` against its id throws `NOT_FOUND`.
   */
  async function revokePendingApprovalsForRun(
    runId: string,
    outcome: { status: 'canceled' | 'revoked'; principal: string },
  ): Promise<void> {
    const approvalToolbox = runToolboxesByRunId.get(runId) ?? runtime.baseToolbox;
    const runState = store.getRun(runId);
    // COR-1596: a fire is not on the store; the session it ran in is the one it registered.
    const firesSession = terminalReviewSessions.get(runId);
    const sessionId = runState
      ? peers.getRunSessionIdentifier(runState)
      : (firesSession?.sessionId ?? '');
    const agentName = runState ? findRunAgentName(runState) : firesSession?.agentName;

    const toolApprovalReviews = new Map<
      string,
      Extract<PendingReview, { kind: 'tool-approval' }>
    >();
    for (const review of peers.listPendingReviews()) {
      if (review.kind === 'tool-approval' && review.runId === runId) {
        toolApprovalReviews.set(review.id, review);
      }
    }
    for (const [reviewId, approval] of pendingApprovalOverrides) {
      if (!reviewId.startsWith(`approval:${runId}:`)) continue;
      // AB-224: skip an override left behind for a review THIS FUNCTION (or
      // `sweepExpiredReviews`/`resolveReview`) already resolved on an
      // earlier call — `pendingApprovalOverrides` is only ever cleared by
      // `deleteRun` or a successful `resolveReview`, so a review canceled by
      // `abortRun` and later revoked by `deleteRun` (or expired by
      // `sweepExpiredReviews` and later canceled by `abortRun`) would
      // otherwise still be found here and re-transitioned, dispatching a
      // second, duplicate `review.*` live event/audit entry for an id that
      // is no longer pending — exactly the duplicate-event failure this
      // issue's rollback trigger names.
      if (resolvedReviewIds.has(reviewId) || invalidApprovalReviewIds.has(reviewId)) continue;
      // Unconditional overwrite (never skipped when already present from the
      // scan above) — matches the pre-AB-46 behavior of this same merge, so
      // an override always reflects the LATEST approval object even when a
      // step-scan-sourced entry for the same id also exists.
      toolApprovalReviews.set(reviewId, {
        kind: 'tool-approval',
        id: reviewId,
        runId,
        sessionId,
        agentName,
        approval,
        requestedAt: 0,
        ageMilliseconds: 0,
        status: 'pending',
        round: pendingApprovalRounds.get(reviewId) ?? 0,
      });
    }

    for (const review of toolApprovalReviews.values()) {
      const approval = review.approval;
      if (approval.approvalBinding && approval.approvalToken !== undefined) {
        try {
          await approvalToolbox.revokeApproval(approval as SignedPendingToolApproval);
        } catch (error) {
          if (!isTerminalApprovalBindingError(error)) throw error;
        }
      }
      resolvedReviewIds.add(review.id);
      // COR-1613: a canceled fire's review is closed once, whichever process or boot gets to it
      // first; every other transition is written as it always was.
      if (outcome.status === 'canceled' && scheduledFireApprovalRuns.has(runId)) {
        await peers.closeCanceledFireReview(review, outcome.principal);
      } else {
        await peers.recordReviewStatusTransition(review, outcome.status, outcome.principal);
      }
      // COR-1596: a fire's approval is revoked in both homes, or a restart brings it back to run
      // a tool for a run that was canceled.
      if (scheduledFireApprovalRuns.has(runId)) {
        await peers.releaseScheduledFireApproval(runId, review.id, outcome.status);
      }
    }

    for (const review of peers.listPendingReviews()) {
      if (review.kind !== 'human-wait' || review.runId !== runId) continue;
      resolvedReviewIds.add(review.id);
      await peers.recordReviewStatusTransition(review, outcome.status, outcome.principal);
    }
    // COR-1613: a fire's parked human wait is not in the session list, and is closed with it.
    if (outcome.status === 'canceled')
      await peers.closeCanceledFireHumanWaits(runId, outcome.principal);
  }

  async function deleteRun(id: string): Promise<void> {
    const runState = store.getRun(id);
    if (!runState) {
      throw new BureauError('Run not found', 'NOT_FOUND');
    }

    if (runState.status === 'running') {
      throw new BureauError('Cannot delete a running run', 'CONFLICT');
    }

    await revokePendingApprovalsForRun(id, {
      status: 'revoked',
      principal: 'system:run-deletion',
    });
    // COR-1631: the run's surfaces go after the fallible review revocation above, which leaves
    // them intact if it fails, and before anything is removed, so a failure here leaves the run in
    // place and a second delete retries, instead of orphaning the surfaces.
    await core.surfaces?.removeTask(id);
    const sessionId = peers.getRunSessionIdentifier(runState);
    const ownerPrincipal = runAttribution.get(id)?.principal;
    const ownerIncarnation = runSessionIncarnations.get(id);
    runSessionIdentifiers.delete(runState.activeRun);
    runAttribution.delete(id);
    runSessionIncarnations.delete(id);
    runRequestContexts.delete(id);
    for (const reviewId of pendingApprovalOverrides.keys()) {
      if (reviewId.startsWith(`approval:${id}:`)) core.dropPendingApprovalOverride(reviewId);
    }
    for (const reviewId of invalidApprovalReviewIds) {
      if (reviewId.startsWith(`approval:${id}:`)) invalidApprovalReviewIds.delete(reviewId);
    }
    for (const reviewId of resolvedReviewIds) {
      if (reviewId.startsWith(`approval:${id}:`) || reviewId.startsWith(`human-wait:${id}:`)) {
        resolvedReviewIds.delete(reviewId);
      }
    }
    runToolboxesByRunId.delete(id);
    releaseRunScope(id);
    humanWaitParkBaseline.delete(id);
    store.removeRun(id);
    // A task record that cannot be removed is diagnosed, like every step after the run has left
    // the store: a throw here would skip the pruning below and make a second delete answer
    // `Run not found`.
    await core.tasks.remove(id).catch((error: unknown) => {
      diagnose({
        level: 'error',
        scope: 'task-registry',
        message: `[bureau] Could not remove the task record of deleted run "${id}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    });
    await restoreRunOwnershipAfterEvent(id, sessionId, ownerPrincipal, ownerIncarnation);
    if (sessionId) {
      await peers.retryRunDeletionPersistenceWrite(
        'pending-approvals',
        sessionId,
        `approval:${id}:`,
      );
      await peers.retryRunDeletionPersistenceWrite(
        'resolved-reviews',
        sessionId,
        `approval:${id}:`,
      );
      await peers.retryRunDeletionPersistenceWrite(
        'resolved-reviews',
        sessionId,
        `human-wait:${id}:`,
      );
    }
    // COR-625: released when the run is deleted. The step has already
    // recorded its acknowledgement durably by then, so nothing observable is
    // lost — only the in-memory memo, whose exactly-once duty is over once every trigger for
    // this run id has passed.
    terminalCheckpointCleanups.delete(id);
  }

  /**
   * Read the durable engine's full state for a run (status, step, failure
   * category, termination reason). Thin passthrough to `engine.get`; `undefined`
   * when no durable engine is composed, `null` when the engine has no such run.
   */
  async function getDurableRun(runId: string) {
    if (!runtime.durable) return undefined;
    return runtime.durable.engine.get(runId);
  }

  /**
   * The durable engine this bureau composed — see the {@link Bureau.durableEngine} doc comment.
   */
  function durableEngine() {
    return runtime.durable?.engine;
  }

  /**
   * Resolve once a run's durable workflow is terminal in the durable store — see the
   * {@link BureauTasks.wait} doc comment. Built on Weft's result waiter
   * (`engine.getHandle(runId).result()`), which settles from the store for a run another engine
   * finishes; its rejection carries a failed run's error, which this wrapper turns back into the
   * run's state.
   */
  async function waitForDurableRun(runId: string) {
    if (!runtime.durable) return undefined;
    const engine = runtime.durable.engine;
    return resolveWaitForDurableRun(runId, {
      getDurableRun,
      awaitResult: async (id) => {
        await engine.getHandle(id).result();
      },
      manualBackgroundTasks: options.maintenance === 'manual',
    });
  }

  /**
   * Cancel a durable run with no live `ActiveRun` (AB-37, AB-205) — see the
   * {@link Bureau.cancelDurableRun} doc comment. Delegates the resolution
   * algorithm to {@link resolveCancelDurableRun}; this wrapper supplies the
   * real `getDurableRun`/`engine.cancel` dependencies.
   */
  async function cancelDurableRun(runId: string): Promise<CancelDurableRunOutcome> {
    const outcome = await resolveCancelDurableRun(runId, {
      getDurableRun,
      cancel: (id) => runtime.durable!.engine.cancel(id).then(() => undefined),
    });
    // AB-46: only an ACTUALLY-committed cancellation ('requested') terminates
    // the run — 'already-terminal'/'not-found'/'failed'/'unsupported-capability'
    // must not transition reviews that belong to a run cancelDurableRun never
    // genuinely touched. `cancelDurableRun` carries no principal, so this is
    // attributed to the synthetic principal `'system:run-abort'`, the same one
    // `abortRun` uses — both are the same "run cancellation" outcome from the
    // review lifecycle's perspective.
    if (outcome.status === 'requested') {
      // Read before anything below can end the run's bookkeeping.
      const inputSessionId = sessionInputGates.get(runId)?.sessionId;
      await revokePendingApprovalsForRun(runId, {
        status: 'canceled',
        principal: 'system:run-abort',
      });
      // COR-625: the third trigger. A run cancelled here may have no live
      // `ActiveRun` in this process at all — no terminal listener will ever
      // fire for it — so the cancellation path owes the step directly.
      // `'requested'` is the only outcome that proves a committed
      // cancellation; the others describe a run this call never genuinely
      // terminated, and pruning on those would be the exact
      // prune-before-terminal-transition this issue names as its rollback
      // trigger. Where a live run DOES exist, its own terminal listener
      // reaches the same memoized step, which is what keeps
      // cancel-then-terminal at exactly one step rather than two.
      await peers.runTerminalCheckpointCleanup(runId);
      // COR-772 — only a committed cancellation applies the child policy.
      await core.childTopology.parentCancelled(runId, 'Cancelled via cancelDurableRun');
      // COR-1476 — the run has ended: its session's input is settled here, so
      // the caller returns with the cancellation already reflected in every
      // receipt, and again by its terminal listener, which finds nothing left.
      if (inputSessionId !== undefined) {
        await peers.settleSessionInputsAfterRunEnd(inputSessionId, runId);
      }
      if (store.getRun(runId) === undefined) {
        // The cancellation committed; a session that could not be told stays as it was, and
        // `cancelDurableRun` still never rejects.
        await publishPeerCancellation(runId).catch((error: unknown) => {
          diagnose({
            level: 'error',
            scope: 'session-persistence',
            message: `[bureau] cancelDurableRun("${runId}") could not publish the cancellation to its session: ${serializeUnknownError(error)}`,
          });
        });
      }
    }
    return outcome;
  }

  /**
   * COR-1580 — the session's terminal status of a run this call cancelled while another process
   * holds it. That holder sees another engine's terminal commit and writes nothing, so the canceller
   * writes it: `lastRunStatus` and `lastFinishReason` `'aborted'`, only while the session's last run
   * is still this one, and never the conversation. A session-less run has nothing to publish.
   */
  async function publishPeerCancellation(runId: string): Promise<void> {
    if (!runtime.sessionStore) return;
    const durable = await getDurableRun(runId);
    const sessionId = peers.durableInputSessionId(durable?.input);
    if (sessionId === undefined) return;
    await runtime.sessionStore.update(sessionId, (session) =>
      session === undefined || session.metadata['lastRunId'] !== runId
        ? undefined
        : {
            ...session,
            metadata: {
              ...session.metadata,
              lastRunStatus: 'aborted',
              lastFinishReason: 'aborted',
            },
          },
    );
  }

  /**
   * List durable runs from the engine, optionally filtered. Thin passthrough to
   * `engine.list`; `undefined` when no durable engine is composed.
   */
  async function listDurableRuns(filter?: ListFilter, requestOptions?: ListOptions) {
    if (!runtime.durable) return undefined;
    return runtime.durable.engine.list(filter, requestOptions);
  }

  /**
   * COR-1380 — `session` with `runId`'s `lastRunOwningPrincipals` entry set
   * back to `principal`, or `undefined` (no write) when the session is gone,
   * is no longer the `incarnation` the entry belonged to (deleted and
   * recreated under the same id), the entry is already present, or the map
   * is present but malformed: a corrupted map fails closed here as it does
   * for the pruner.
   */
  function withRestoredRunOwner(
    session: AgentSession | undefined,
    runId: string,
    principal: string,
    incarnation: string,
  ): AgentSession | undefined {
    if (!session || session.incarnation !== incarnation) return undefined;
    const owners = session.metadata['lastRunOwningPrincipals'];
    if (owners !== undefined && !isPlainAuthorityRecord(owners)) return undefined;
    if (owners !== undefined && ownEntry(owners, runId) !== undefined) return undefined;
    return {
      ...session,
      metadata: {
        ...session.metadata,
        lastRunOwningPrincipals: { ...owners, [runId]: principal },
      },
    };
  }

  /**
   * COR-1380 — the writer side of the both-sides-verify rule
   * `pruneStaleRunOwnership` documents. Called right after `deleteRun()` or a
   * `review.*` transition dispatches its durable event for `runId`: waits
   * for that write to settle, then reads the run's ownership entry, and
   * writes it back if a pruner on any instance removed it in the meantime.
   * `principal` is always the run owner's (from `runAttribution`), never
   * the acting principal of the deletion or review. Attempted once; a
   * failure is diagnosed and never thrown, so the caller's own outcome
   * stands. No-op without a durable event producer, a session store, a
   * principal, a session id, or the incarnation the run was saved into.
   */
  async function restoreRunOwnershipAfterEvent(
    runId: string,
    sessionId: string,
    principal: string | undefined,
    incarnation: string | undefined,
  ): Promise<void> {
    const producer = core.durableEventProducerInstance;
    const sessionStore = runtime.sessionStore;
    if (
      !producer ||
      !sessionStore ||
      principal === undefined ||
      incarnation === undefined ||
      !sessionId
    ) {
      return;
    }
    try {
      await producer.waitForActiveWrites({ kind: 'run', id: runId });
      const session = await sessionStore.load(sessionId);
      if (!withRestoredRunOwner(session, runId, principal, incarnation)) return;
      await sessionStore.update(
        sessionId,
        (fresh) => withRestoredRunOwner(fresh, runId, principal, incarnation),
        { refreshActivity: false },
      );
    } catch (error: unknown) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] Run-ownership restore failed for run "${runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  /**
   * AB-363 — drops a session's `lastRunOwningPrincipals` entries whose run's
   * ENTIRE durable event history has fallen below the fleet feed's
   * retention floor (coordinator ruling, 2026-09-08): a history that can no
   * longer be paged needs no owner. This is the only place that map is
   * pruned — see the "never pruned HERE" comment on the `lastRunOwningPrincipals`
   * write above for what this deliberately does NOT do (no pruning on
   * terminal transition, no pruning on a count).
   *
   * `eventHistoryInstance.retainedRunOwnerIds()` returns `undefined` when
   * the retention floor is still 0 (nothing retired yet); this function
   * then does nothing at all, rather than pruning against an empty set —
   * an empty set at floor 0 would read as "nothing survived" when in fact
   * nothing has even been asked to retire.
   *
   * A candidate run (not in the retained set) is excluded from pruning —
   * left in place for a later cycle — on any of four signals. None of them
   * is `runtime.durable.engine.get` (Codex/Copilot review, PR #568 — an
   * earlier revision used that run-state read and got both the "unknown
   * run" case and the write-in-flight race below wrong, because workflow
   * state cannot say whether a run's terminal outcome is fully durable):
   *
   * 1. `lastRequestAuthorities` still names the run. This map is written
   *    unconditionally at dispatch, in the SAME merge as
   *    `lastRunOwningPrincipals`, and its entry for a run is removed ONLY
   *    at that run's own terminal transition, and ONLY when the run has no
   *    pending approval (see that removal's own doc comment). So presence
   *    here means the run is either still live, or terminal-but-awaiting-
   *    a-human-decision — the exact case that can still produce a future
   *    `review.*` durable event.
   * 2. `durableEventProducerInstance.hasActiveWrite({ kind: 'run', id })` —
   *    a `history.record()` write for this run, started but not yet
   *    settled. This closes the window `lastRequestAuthorities` alone
   *    cannot: the bureau-level `'action'` event that removes the
   *    authority entry is dispatched no earlier than the SAME completion
   *    sequence that also fires the `'action'` event `createDurableEventProducer`
   *    sinks into `history.record()` (both are driven off the same
   *    `store`-dispatched action for this run's terminal transition) — so
   *    by the time the authority entry is gone, that write has already
   *    STARTED (`hasActiveWrite` synchronously flips true before
   *    `history.record()`'s promise even begins), even if it has not yet
   *    settled. Checking both together means: authority gone AND no write
   *    in flight ⟹ the run's terminal outcome is fully durable, with no
   *    future write this pass could race.
   * 3. `store.getRun(runId) !== undefined` — the run is still present in
   *    the in-memory run store, so `deleteRun()` can still be called on it
   *    (it throws NOT_FOUND once a run leaves `store`) and would record a
   *    brand-new, retained `run.removed` durable event under this same
   *    owner (Codex review, PR #568, "Preserve ownership for a later run
   *    removal event"). Process-bound: a TERMINAL run is never
   *    repopulated into `store` at boot, so a run this process never held
   *    can never be deleted by this process either, and correctly gets no
   *    protection here.
   * 4. `runtime.durable!.engine.claimHolder(runId)` reports the run's
   *    workflow-lease claim held by any process (COR-204). Checked last,
   *    and only for a candidate the first three did not exclude, because
   *    it is a storage read per candidate per update attempt; skipped
   *    entirely under `durableOwnership: { ownership: 'none' }`, where no
   *    claim exists. Unlike `engine.get`, it answers one narrow question,
   *    whether some process still holds this run's live claim, and it can
   *    only add an exclusion: no claim record or a stranded claim leaves
   *    the decision to signals 1-3. Signals 2 and 3 are process-local, so
   *    this is what protects a run still executing on ANOTHER instance
   *    whose authority entry is already gone from the shared session store
   *    (for example after `prunePersistedInvalidApprovalReviewState` on the
   *    recovery path). An ordinary live run is protected by signal 1 in
   *    every instance already. A claim a crashed instance never released
   *    reads as held until its grace-adjusted expiry, so pruning that run
   *    waits at most that long. A rejected read propagates out of the
   *    updater like a rejected refresh: nothing is deleted and the pass is
   *    diagnosed under `durable-maintenance`.
   *
   * The retained-owner set itself is REVALIDATED immediately before each
   * session's write, not read once for the whole pass (Codex review, PR
   * #568, "Revalidate retained owners before pruning"): a run can
   * dispatch, complete, and have its terminal event land in the feed
   * ENTIRELY within the time this function spends paging through other
   * sessions, which would make a single up-front snapshot stale by the
   * time this run's own session is reached. That revalidation goes
   * through `eventHistoryInstance.refreshRetainedRunOwnerIds`, not a
   * second from-scratch `retainedRunOwnerIds()` call (Codex review, PR
   * #568, "Avoid replaying the full fleet feed per candidate session") —
   * calling the full scan once per candidate session, and again per
   * optimistic-concurrency retry, would replay the ENTIRE retained window
   * that many times over. `refreshRetainedRunOwnerIds` instead resumes
   * from the previous call's cursor, so the shared `retainedRunOwners`
   * variable below accumulates monotonically across the whole pass at a
   * cost proportional to NEW activity, not to how many candidates this
   * pass has examined so far. Every `sessionStore.update()` call in this
   * function runs sequentially (awaited before the next), so mutating
   * that shared variable across iterations — including across an
   * individual call's own conflict retries — is race-free.
   *
   * Across instances sharing one backend, the pass observes another
   * instance's write that lands before the refresh runs, since
   * `refreshRetainedRunOwnerIds` reads the same shared feed every writer
   * appends to, and under `'workflow-lease'` it leaves alone any run whose
   * claim is live anywhere. No primitive here spans the fleet feed and the
   * session store in one atomic operation, and `claimHolder` is a
   * point-in-time read, not a lock, so an event for a pruned run can still
   * land after the delete (COR-1380): a terminal run whose claim was already
   * released can still be deleted (`run.removed`) or have a review resolved
   * (`review.*`) by an instance that holds it in memory, and another
   * instance's event can commit between this attempt's refresh and its
   * session write.
   *
   * Both sides therefore verify after they write. Whichever read comes
   * second sees the other side's write, so one of them restores the entry
   * with an idempotent union write (`{ refreshActivity: false }`, and
   * nothing when the entry is already back or the map is malformed):
   *
   * - The pruner deletes, then reads the feed again
   *   (`refreshRetainedRunOwnerIds`) once per committed delete, and puts
   *   back, with the principal it just removed, every deleted run that is
   *   now retained, whatever kind of event made it so. A rejected restore
   *   write is diagnosed for that session and the pass continues.
   * - The event writer (`deleteRun()`, and every `review.*` transition
   *   through `recordReviewDecision` and `recordReviewStatusTransition`)
   *   records its event, waits for that write to settle, then reads the
   *   run's entry and restores it with the run owner's principal from
   *   `runAttribution` (`restoreRunOwnershipAfterEvent`).
   *
   * Guarantee: once a pass and a `deleteRun()` or `review.*` transition on
   * the same run have both settled, the run's entry exists whenever a
   * retained `run.removed` or `review.*` event for it exists, provided the
   * recording instance holds the run's principal in memory. Limits that
   * remain:
   *
   * - The entry is briefly absent between a prune commit and its restore.
   * - A pass that crashes, or whose post-delete refresh rejects, between its
   *   commit and its restore can leave the entry absent.
   * - An instance with no in-memory principal for the run (its
   *   `runAttribution` was rehydrated at boot after the entry was already
   *   pruned), or no recorded session incarnation for it (a run recovered
   *   without one), or a run recorded without a principal, gets no
   *   writer-side restore.
   * - A restore never writes into a session deleted and recreated under the
   *   same id since the entry was removed: both sides fence on the session
   *   incarnation the entry belonged to.
   * - `run.completed`, `run.error`, `run.aborted`, `run.tripwire`,
   *   `schedule.completed`, and `schedule.failed` events under a run owner
   *   have no writer-side restore; they are covered only by the exclusion
   *   signals above and, when they land before the pruner's re-read, by the
   *   pruner-side restore.
   */
  async function pruneStaleRunOwnership(): Promise<void> {
    const sessionStore = runtime.sessionStore;
    const eventHistoryInstance = core.eventHistoryInstance;
    if (!eventHistoryInstance || !sessionStore) return;
    // `createRunEngine` defaults an omitted `ownership` to `'workflow-lease'`
    // (AB-178), so only an explicit `'none'` turns the claim guard off.
    const workflowLeaseOwnership =
      (options.durableOwnership?.ownership ?? 'workflow-lease') === 'workflow-lease';

    let retainedRunOwners = await eventHistoryInstance.retainedRunOwnerIds();
    if (retainedRunOwners === undefined) return;

    const pageLimit = 100;
    let offset = 0;
    for (;;) {
      const page = await sessionStore.list({ limit: pageLimit, offset });
      if (page.length === 0) break;

      for (const summary of page) {
        const owners = summary.metadata['lastRunOwningPrincipals'];
        if (!isPlainAuthorityRecord(owners)) continue;

        const hasCandidate = Object.keys(owners).some(
          (runId) => !retainedRunOwners!.ownerIds.has(runId),
        );
        if (!hasCandidate) continue;

        // Read-modify-write against the FRESH session inside `update`
        // (optimistic concurrency, same as every other write to this map),
        // not against the `summary` snapshot above — a concurrent dispatch's
        // union-merge (the write path this pass never touches) can add a
        // new entry between the `list()` read and this write, and it must
        // survive. `lastRequestAuthorities` is read from this SAME fresh
        // session too, for the identical reason. The updater is async so
        // it can revalidate the retained-owner set fresh on every attempt
        // (including a conflict retry), per this function's own doc
        // comment. `refreshActivity: false` (Codex review, PR #568,
        // "Avoid refreshing session activity during retention pruning")
        // — this write drops stale metadata, it is never itself evidence
        // the session is active, so it must not reorder or resurrect an
        // otherwise-inactive session in `listSessions()`'s default sort or
        // `cleanup({ olderThan })`'s age cutoff.
        // Reset on every updater attempt, so a conflict retry restores only
        // what the attempt that committed actually deleted.
        let deletedOwners: Record<string, string> = {};
        let prunedIncarnation = '';
        await sessionStore.update(
          summary.id,
          async (session) => {
            deletedOwners = {};
            if (!session) return undefined;
            prunedIncarnation = session.incarnation;
            const currentOwners = session.metadata['lastRunOwningPrincipals'];
            if (!isPlainAuthorityRecord(currentOwners)) return undefined;

            retainedRunOwners = await eventHistoryInstance.refreshRetainedRunOwnerIds(
              retainedRunOwners!,
            );

            const currentAuthorities = session.metadata['lastRequestAuthorities'];
            // A PRESENT-but-malformed `lastRequestAuthorities` (a scalar or
            // array surviving JSON metadata, not simply absent) fails
            // closed for the WHOLE session, not just the run it would have
            // named (Codex review, PR #568, "Preserve owners when the
            // authority map is malformed") — this module elsewhere (see
            // the session-owner check) already distinguishes malformed from
            // absent for the identical reason: treating malformed as "no live
            // runs" would let a still-live or pending-approval owner get
            // deleted here.
            if (currentAuthorities !== undefined && !isPlainAuthorityRecord(currentAuthorities)) {
              return undefined;
            }
            const liveOrPendingRunIds = isPlainAuthorityRecord(currentAuthorities)
              ? new Set(Object.keys(currentAuthorities))
              : new Set<string>();

            const nextOwners = { ...currentOwners };
            let changed = false;
            for (const runId of Object.keys(nextOwners)) {
              if (retainedRunOwners.ownerIds.has(runId)) continue;
              if (liveOrPendingRunIds.has(runId)) continue;
              if (core.durableEventProducerInstance?.hasActiveWrite({ kind: 'run', id: runId }))
                continue;
              // A run still present in the in-memory run `store` can still
              // be handed to `deleteRun()` at any future point — which
              // records a brand-new, retained `run.removed` durable event
              // under this SAME owner (Codex review, PR #568, "Preserve
              // ownership for a later run removal event"). Before AB-363
              // this map was never pruned at all, so that future write
              // always had an owner waiting for it; excluding a
              // still-present run here restores that guarantee.
              // `deleteRun()` throws NOT_FOUND once a run is gone from
              // `store` — the exact same check, so this is really "can a
              // future deleteRun() still fire for this run", not a proxy
              // for it. It is also process-bound: `store` is never
              // repopulated with a TERMINAL run at boot (only recovered
              // in-flight ones are), so a run this process never held can
              // never be deleted again by any process, and gets no
              // protection here — correctly, since no future `run.removed`
              // is possible for it either. Once `deleteRun()` actually
              // runs, `store.getRun` returns `undefined` immediately, and
              // `hasActiveWrite` above already protects the write it
              // starts synchronously in the same call.
              if (store.getRun(runId) !== undefined) continue;
              // COR-204: last, and only for a candidate the three signals
              // above did not exclude, because it costs a storage read.
              // `claimHolder` reads whether any process still holds this
              // run's live workflow-lease claim, which is the one signal
              // another instance's still-executing run leaves in shared
              // storage once its authority entry is gone. A claim held
              // anywhere defers pruning to a later pass; no claim record
              // or a stranded one changes nothing. A rejection aborts this
              // write exactly as a rejected refresh above does.
              if (workflowLeaseOwnership) {
                const claim = await runtime.durable!.engine.claimHolder(runId);
                if (claim?.heldByAnyProcess) continue;
              }
              const deletedPrincipal = nextOwners[runId];
              if (typeof deletedPrincipal === 'string') deletedOwners[runId] = deletedPrincipal;
              delete nextOwners[runId];
              changed = true;
            }
            if (!changed) return undefined;

            // Rest-spread the key out entirely once emptied, rather than
            // persisting `{}`, so a fully-pruned session reads back with NO
            // `lastRunOwningPrincipals` key at all — the same shape a
            // never-attributed session already has (AB-359's "no principal
            // recorded" test).
            const { lastRunOwningPrincipals: _pruned, ...restMetadata } = session.metadata;
            return {
              ...session,
              metadata:
                Object.keys(nextOwners).length > 0
                  ? { ...restMetadata, lastRunOwningPrincipals: nextOwners }
                  : restMetadata,
            };
          },
          { refreshActivity: false },
        );
        if (Object.keys(deletedOwners).length === 0) continue;

        // COR-1380: the pruner side of the both-sides-verify rule. Read the
        // feed again after the delete committed: an event recorded for a
        // deleted run since this attempt's refresh means the run is still
        // retained, so its entry goes back with the principal just removed.
        // A rejected refresh propagates like the in-updater one does.
        retainedRunOwners =
          await eventHistoryInstance.refreshRetainedRunOwnerIds(retainedRunOwners);
        const toRestore = Object.entries(deletedOwners).filter(([runId]) =>
          retainedRunOwners!.ownerIds.has(runId),
        );
        if (toRestore.length === 0) continue;
        try {
          await sessionStore.update(
            summary.id,
            (session) => {
              let restored = session;
              for (const [runId, principal] of toRestore) {
                restored =
                  withRestoredRunOwner(restored, runId, principal, prunedIncarnation) ?? restored;
              }
              return restored === session ? undefined : restored;
            },
            { refreshActivity: false },
          );
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Run-ownership restore failed for session "${summary.id}": ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
      }

      if (page.length < pageLimit) break;
      offset += pageLimit;
    }
  }

  return {
    getRun,
    subscribeRunSnapshot,
    abortRun,
    listAbortingRuns,
    revokePendingApprovalsForRun,
    deleteRun,
    getDurableRun,
    durableEngine,
    waitForDurableRun,
    cancelDurableRun,
    listDurableRuns,
    restoreRunOwnershipAfterEvent,
    pruneStaleRunOwnership,
  };
}
