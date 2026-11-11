/**
 * Maintenance (COR-2376 slice S11): the retention and pruning passes (audit trail, resolved reviews,
 * event history, workflow and agent snapshots, tasks, terminal checkpoints, memory, workflow logs,
 * notifications, hook deliveries, chats), the `maintain` pass that runs them, the removal of expired
 * records, and the automatic maintenance timer's starter. The admission flag, the memory authority,
 * the three bindings the run ownership prune timer lives in, and the two construction-time
 * statements that start the timer and subscribe to settings stay in `constructBureau`, because
 * shutdown reads and clears them and their order is construction order. Built by `constructBureau`
 * and reached only through `createBureau`; run creation, recovered runs, run operations, durable
 * recovery and child runs call into it.
 */
import type { AgentDefinitions } from '../agent-catalog';
import type { BureauCore } from './core';
import { BureauError } from '../bureau-errors';
import type { ContextDeletionReport, ExpiredRecordRemoval } from '../types';
import { DEFAULT_EVENT_RETENTION_MS } from '../settings/setting-defaults';
import { DURABLE_FORCIBLY_TERMINABLE_STATUSES } from '../durable-run-waits';
import {
  EXPIRY_SWEEP_INTERVAL_MILLISECONDS,
  type MaintenancePassName,
  detachBestEffortPromise,
  expiredRecordRemovalOf,
  hasMaintenanceSurface,
  taskRetentionOf,
} from '../bureau-construction-support';
import type {
  CleanupAcknowledgement as RunCleanupAcknowledgement,
  SessionListOptions,
  SessionStore,
} from '@lostgradient/operative';
import { RunRemovedEvent } from '../events';
import type { WorkflowState } from '@lostgradient/weft';
import { serializeUnknownError } from '../serialization';
import { settledActionTimestamp } from '../run-settlement';

/** The callables maintenance reads from elsewhere in `constructBureau`. */
export interface MaintenancePeers {
  /** Releases the peer calls a run holds. */
  readonly releasePeerCalls: (runId: string) => void;
  /** Releases the claim of a scheduled fire. */
  readonly releaseScheduledFire: (
    runId: string,
    ending: 'settled' | 'canceled' | 'removed',
    scope?: { sessionId?: string | undefined },
  ) => Promise<void>;
  /** Drains the session outbox. */
  readonly drainOutbox: () => Promise<void>;
  /** Sweeps the reviews that expired. */
  readonly sweepExpiredReviews: (now?: number) => Promise<number>;
  /** Deletes a run. */
  readonly deleteRun: (id: string) => Promise<void>;
  /** Prunes the run ownership records of runs past the retention floor. */
  readonly pruneStaleRunOwnership: () => Promise<void>;
  /** Pauses the schedules that no longer validate. */
  readonly pauseInvalidSchedules: () => Promise<void>;
  /** Records the schedule transitions that committed and are not yet in history. */
  readonly recordPendingScheduleTransitions: (prefix?: string) => Promise<void>;
  /** Lists the sessions the session store holds. */
  readonly listSessions: (requestOptions?: SessionListOptions) => ReturnType<SessionStore['list']>;
  /** Reconciles the asset claims of every session. */
  readonly reconcileAssetClaims: () => Promise<void>;
  /** Starts the deletion of a session. */
  readonly startSessionDeletion: (
    id: string,
    deleteOptions: {
      readonly incarnation?: string | undefined;
      readonly actor?: string | undefined;
      readonly idleBefore?: number | undefined;
    },
  ) => Promise<ContextDeletionReport>;
}

/** Builds the maintenance of one Bureau. Synchronous, and registers nothing. */
export function createMaintenance<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: MaintenancePeers,
) {
  const {
    options,
    runtimeServices,
    constructedAtMilliseconds,
    store,
    emitter,
    runtime,
    diagnose,
    diagnoseSettings,
    currentSettings,
    catalogRunIds,
    terminalCheckpointCleanups,
    shutdownTimeoutSleep,
    manualDurableMaintenancePasses,
  } = core;

  // COR-625: registered on a durable run's `closed()` only when a retention
  // policy is actually configured. Registering it unconditionally would
  // disqualify every durable run's `not-required` fast path (a run with a
  // step registered genuinely has cleanup left to do — see
  // `active-run-create.ts`'s `disqualifiesFastPath`) and so would change
  // `closed()`'s answer for every bureau that never asked for retention. The
  // terminal listeners still call the step unconditionally, so the
  // `run.cleanup-settled` audit record exists either way.
  // COR-1710: read when each run starts, so a policy set while the Bureau runs applies to the
  // next run; a run already started keeps what it started with.
  const durableTerminalCleanup = () => {
    const retention = currentSettings()['retention.checkpoints'];
    return retention && retention !== 'keep-all' ? runTerminalCheckpointCleanup : undefined;
  };

  /**
   * AB-388: prunes the durable audit trail per `options.retention?.audit`
   * (default `'forever'`, a no-op). References `auditTrailInstance` and
   * `eventHistoryInstance`, both declared further down this factory
   * function — safe because this function is only ever CALLED (from
   * `maintain` below, or from the automatic-profile interval)
   * after the whole factory body, including both of those assignments, has
   * already run; see `pruneStaleRunOwnership`'s own forward-reference to
   * `eventHistoryInstance` for the identical, already-established pattern.
   *
   * Computes the effective cutoff as `min(now - olderThan, floorTimestamp)`
   * — never a record newer than the fleet feed's own retention floor is
   * pruned, so audit evidence always outlives the durable events it
   * describes, even when the operator's own `olderThan` would have allowed
   * pruning it sooner. `floorTimestamp` is `undefined` (no clamp beyond the
   * operator's own cutoff) when there is no durable event history at all
   * (ephemeral bureau, or a persistent backend without one), or when
   * `eventHistoryInstance.retentionFloorTimestamp()` itself reports no
   * floor to protect (nothing retired from the fleet feed yet, or nothing
   * currently retained at all).
   *
   * AB-388 (Codex review, PR #597, "Protect earlier audit records for
   * retained owners"): the global `floorTimestamp` clamp above protects
   * records at or after the EARLIEST currently-retained durable event
   * anywhere in the fleet feed — it does NOT protect an individual run's
   * OWN earlier audit records once that run's only retained durable event
   * is a single, later terminal transition (`run.completed`/etc.). This
   * function additionally asks `eventHistoryInstance.retainedRunOwnerIds()`
   * for the full set of run ids the fleet feed still retains at least one
   * event for, and passes a `protectRunId` predicate into `prune()` so
   * every one of THOSE runs' audit records survive this pass regardless of
   * `effectiveCutoff` — matching `packages/bureau/README.md`'s promise that
   * a retained run history keeps that run's audit records.
   *
   * AB-388 (Codex review, PR #597, "Wait for durable event writes before
   * reading the floor"): both `retentionFloorTimestamp()` and
   * `retainedRunOwnerIds()` read the fleet feed's CURRENT state — a
   * `history.record()` write already in flight (started by
   * `durableEventProducerInstance`'s own listener for the SAME action this
   * pruning pass is racing) has not yet landed there. Awaiting
   * `durableEventProducerInstance.waitForAllActiveWrites()` first ensures
   * every durable event whose corresponding audit record already committed
   * is visible to both reads below, closing the window where a pass could
   * otherwise prune an audit record whose durable-event counterpart was
   * still mid-append.
   *
   * ACCEPTED RESIDUAL (Codex review, PR #597, "Coordinate pruning with
   * writers in every Bureau instance"): this only awaits THIS process's
   * own `durableEventProducerInstance` — when two Bureau processes share
   * one persistent backend and a DIFFERENT process has already committed
   * an audit record whose matching durable-event append is still
   * in-flight over there, this local wait observes nothing and the
   * following floor/owner-set snapshots can still omit that pending
   * event. The cross-process prune LEASE this same round of fixes adds
   * (`audit-trail.ts`) serializes destructive PRUNE PASSES across
   * processes; it does not extend to coordinating with each process's own
   * independent WRITE path, which would need a durable, cross-process
   * write-in-flight marker — a materially larger primitive than a prune
   * lease. This is the same class of residual `create-bureau.ts`'s own
   * `drainOutbox` doc comment already accepts for a different
   * cross-process race (multiple maintenance ticks observing the same
   * unacknowledged outbox entry before either acknowledges it) — closing
   * it fully is out of scope here and left as a follow-up.
   *
   * AB-393 (coordinator ruling, 2026-09-09, closing the residual the
   * paragraph above once described): `retainedRunOwnerIdsForAuditRetention()`
   * below still takes one snapshot to SEED this pass, but `protectRunId`
   * itself is now an ASYNC predicate that revalidates that snapshot via
   * `eventHistoryInstance.refreshRetainedRunOwnerIds()` — including the
   * re-check `audit-trail.ts`'s own `prune()` now performs immediately
   * before each candidate's delete, not only once during listing. This is
   * the exact pattern `pruneStaleRunOwnership()` already uses for the
   * identical class of staleness (see that function's own doc comment): a
   * shared, monotonically-accumulating snapshot variable, advanced by a
   * cursor-resumed scan rather than a from-scratch replay, so a durable
   * event that starts after this predicate's first call for a candidate
   * but lands before that candidate's own delete is still observed —
   * closing the window the prior revision of this comment described as an
   * accepted residual.
   *
   * AB-393 (Codex review, PR #600, "Avoid replaying the feed for every
   * unprotected audit record" / "Batch retained-owner refreshes instead
   * of replaying per record"): the predicate below only refreshes on a
   * `'delete'`-phase call, never on a `'listing'`-phase one — bounding the
   * extra cost to one `refreshRetainedRunOwnerIds()` round trip per
   * SURVIVING candidate (the ones this pass's delete loop actually
   * reaches), not per candidate examined during listing. That round trip
   * is now cheap in the common case too:
   * `refreshRetainedRunOwnerIds()` itself pre-checks
   * `FleetEventFeed.snapshotTailSequence()` (a single `storage.get`)
   * before ever paying for a full `feed.replay()` page load — see that
   * function's own doc comment (`durable-event-history.ts`) for why that
   * pre-check is sound. Under this ruling's per-candidate requirement,
   * one bounded read per surviving candidate is the floor; coarsening it
   * further (batching several candidates per refresh) would reopen the
   * exact staleness window this issue exists to close and would need a
   * fresh coordinator ruling to trade away.
   *
   * AB-393 (Codex review, PR #600, "Fence event appends through the
   * audit-record deletion" / "Fence producer admission through the audit
   * deletion"): the predicate also re-awaits
   * `durableEventProducerInstance.waitForAllActiveWrites()` on every
   * `'delete'`-phase call, not only once at this function's own start
   * above — a producer write for a candidate can start any time after
   * that first wait (during listing, or during an earlier candidate's own
   * delete) and would otherwise still be mid-flight, invisible to the
   * `refreshRetainedRunOwnerIds` read that immediately follows, when THAT
   * candidate's own delete is reached.
   *
   * ACCEPTED RESIDUAL (Codex review, PR #600, "Fence producer admission
   * through the audit deletion", round 2): the re-awaited
   * `waitForAllActiveWrites()` above closes the window where a producer
   * write STARTED before that wait but had not yet landed — it does NOT
   * close a write that starts strictly AFTER that wait resolves but
   * before `refreshRetainedRunOwnerIds()`'s own read settles, or between
   * that read settling and the following `kv.delete()` actually
   * executing. `waitForAllActiveWrites()` itself is explicitly a
   * snapshot-then-await, by its own doc comment ("a write that starts
   * AFTER this call is a NEW write this call never promised to wait
   * for") — every check-then-act pair has some such window unless the
   * check and the act are one atomic operation. Closing this fully would
   * need either a primitive spanning both the fleet feed and the audit
   * KV in one atomic operation (which does not exist here), or blocking
   * new durable-event-producer admission for the full duration of the
   * delete phase (a materially larger, cross-cutting change touching
   * every run's own write path, far outside this issue's "one pull
   * request in packages/bureau" delivery boundary). This is the same
   * class of residual this same paragraph's own earlier revision, and
   * `pruneStaleRunOwnership`'s doc comment above, already accept for
   * analogous races — the coordinator ruling's ask ("re-checked per
   * candidate immediately before each delete") is satisfied; what
   * remains is the theoretically irreducible gap between one async check
   * and the destructive operation it gates, narrowed from this pass's
   * entire duration down to one async tick.
   */
  async function pruneAuditTrail(): Promise<{
    readonly audit: number;
    readonly reviews: number | 'failed';
  }> {
    const reviews = await pruneResolvedReviews();
    if (!core.auditTrailInstance) return { audit: 0, reviews };
    const retention = currentSettings()['retention.audit'];
    if (!retention || retention === 'forever') return { audit: 0, reviews };

    await core.durableEventProducerInstance?.waitForAllActiveWrites();

    const now = runtimeServices.clock.now();
    const cutoff = now - retention.olderThan;
    const floorTimestamp = await core.eventHistoryInstance?.retentionFloorTimestamp();
    const effectiveCutoff =
      floorTimestamp !== undefined ? Math.min(cutoff, floorTimestamp) : cutoff;

    // AB-388 (Codex review, PR #597, "Scan retained run owners at floor
    // zero"): uses `retainedRunOwnerIdsForAuditRetention()`, not
    // `retainedRunOwnerIds()` — the latter deliberately returns
    // `undefined` at floor 0 for `pruneStaleRunOwnership`'s own eligibility
    // check (see that function's doc comment), which would silently drop
    // ALL owner-based protection here whenever the fleet feed floor
    // happens to still be 0, letting a still-retained run's earlier audit
    // records (e.g. a `tool.result` write earlier than that run's own
    // later terminal durable event) be pruned by timestamp alone. See
    // `retainedRunOwnerIdsForAuditRetention`'s own doc comment
    // (`durable-event-history.ts`) for why this consumer's polarity makes
    // the real set safe to use at every floor value.
    //
    // AB-393: seeds the shared, mutable `retainedRunOwners` variable this
    // pass's `protectRunId` closure below revalidates on every `'delete'`
    // -phase call — the SAME "seed once, refresh per check" shape
    // `pruneStaleRunOwnership()` already uses (see that function's own
    // doc comment for why a shared variable reassigned sequentially,
    // never cloned, is race-free here).
    let retainedRunOwners = await core.eventHistoryInstance?.retainedRunOwnerIdsForAuditRetention();
    const eventHistoryInstance = core.eventHistoryInstance;
    const protectRunId = eventHistoryInstance
      ? async (runId: string, phase: 'listing' | 'delete'): Promise<boolean> => {
          if (retainedRunOwners === undefined) return false;
          if (retainedRunOwners.ownerIds.has(runId)) return true;
          // AB-393 (Codex review, PR #600, "Avoid replaying the feed for
          // every unprotected audit record"): a `'listing'` call answers
          // from whatever `retainedRunOwners` this pass has ALREADY
          // resolved — it never itself triggers a fresh
          // `refreshRetainedRunOwnerIds()` read. Refreshing here too
          // would cost one bounded-but-real feed round trip PER
          // NEVER-RETAINED CANDIDATE EXAMINED DURING LISTING, which for a
          // large backlog of ordinary (non-retained) audit records is a
          // real, avoidable multiplier — only the `'delete'`-phase call
          // immediately before a SURVIVING candidate's own delete needs
          // the current answer; see `audit-trail.ts`'s own doc comment on
          // `protectRunId`'s `phase` parameter for the full rationale.
          if (phase !== 'delete') return false;
          // AB-393 (Codex review, PR #600, "Fence event appends through
          // the audit-record deletion"): this pass's ONE
          // `waitForAllActiveWrites()` call above ran before listing even
          // started — a NEW durable-event-producer write for a candidate
          // can start any time after that (during listing, or during an
          // earlier candidate's own delete) and would otherwise still be
          // in flight, not yet visible to the `refreshRetainedRunOwnerIds`
          // read just below, when THIS candidate's delete is reached.
          // Waiting again here, immediately before that read, closes that
          // gap: any write that has started by this exact point is
          // guaranteed to have landed in the feed before `refresh` reads
          // it. Cheap when nothing is in flight (`activeWrites.size === 0`
          // resolves immediately; see that method's own doc comment).
          await core.durableEventProducerInstance?.waitForAllActiveWrites();
          retainedRunOwners =
            await eventHistoryInstance.refreshRetainedRunOwnerIds(retainedRunOwners);
          return retainedRunOwners.ownerIds.has(runId);
        }
      : undefined;

    const pruned = await core.auditTrailInstance.prune(effectiveCutoff, { protectRunId });
    // COR-1934 — the tombstones of runs purged before the same cutoff: an entry or event older
    // than it is pruned anyway.
    await core.chatContentPurge.pruneTombstones(effectiveCutoff);
    return { audit: pruned?.prunedCount ?? 0, reviews };
  }

  /**
   * COR-1828 — retires the resolved-review records decided before `retention.audit` allows, on the
   * same pass and the same setting as the audit entries of those decisions. Kept for ever under
   * `'forever'` or no setting. A failure is diagnosed and does not stop the audit prune that follows.
   * Resolves how many records it retired, or `'failed'`.
   */
  async function pruneResolvedReviews(): Promise<number | 'failed'> {
    const retention = currentSettings()['retention.audit'];
    if (!retention || retention === 'forever') return 0;
    try {
      return await core.resolvedReviewStore.pruneBefore(
        runtimeServices.clock.now() - retention.olderThan,
      );
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'audit-trail',
        message: `[bureau] Could not prune the resolved-review records: ${serializeUnknownError(error)}`,
        cause: error,
      });
      return 'failed';
    }
  }

  /**
   * COR-1477 — advances the durable event history's retention floor past every
   * event older than {@link BureauRetentionOptions.events} (default 7 days), so
   * the history is bounded. A reader resuming below the new floor, or an open
   * subscription it overtakes, receives one gap event. Runs ahead of
   * {@link pruneAuditTrail} in a pass, so that pass already clamps against the
   * advanced floor. The clamp protects only records the history still
   * retains, so it holds whichever order the two run in.
   */
  async function retainEventHistory(): Promise<void> {
    if (!core.eventHistoryInstance) return;
    const cutoff = eventRetentionCutoff();
    if (cutoff === undefined) return;
    await core.eventHistoryInstance.retainBefore(cutoff);
  }

  /**
   * The instant (epoch milliseconds) before which {@link BureauRetentionOptions.events} retires an
   * event, or `undefined` when events are kept for ever.
   */
  function eventRetentionCutoff(): number | undefined {
    const retention = currentSettings()['retention.events'] ?? {
      olderThan: DEFAULT_EVENT_RETENTION_MS,
    };
    return retention === 'forever' ? undefined : runtimeServices.clock.now() - retention.olderThan;
  }

  /**
   * COR-1524 — prunes the agent snapshots whose last run settled before the task retention
   * window. A snapshot is kept while any run that references it is retained: a session run's
   * reference goes when its task is deleted (`run.removed`), and any run's goes here once it has
   * been settled for longer than {@link BureauRetentionOptions.tasks}, which is also what releases
   * a `bureau.run()` run, since those leave the run store on settling and are never deleted.
   * A run that has not settled keeps its snapshot, because it may still be resumed.
   */
  async function retainWorkflowSnapshots(): Promise<void> {
    if (core.workflowRuntime === undefined) return;
    const retention = taskRetentionOf(currentSettings());
    if (retention === 'forever') return;
    await core.workflowRuntime.pruneSnapshots(runtimeServices.clock.now() - retention.olderThan);
  }

  async function retainAgentSnapshots(): Promise<void> {
    if (core.fileAgents === undefined) return;
    const retention = taskRetentionOf(currentSettings());
    if (retention === 'forever') return;
    await core.fileAgents.snapshots.pruneSettledBefore(
      runtimeServices.clock.now() - retention.olderThan,
    );
  }

  /**
   * COR-1524 — finishes the snapshot references that in-process settlement did not: a run the
   * durable engine has ended is settled at the time it ended (a crash, a recovered run, or a
   * handle that never attached), and a reference whose run the engine has no record of, past a
   * grace period, is a start that failed and is released. A run this process is driving is left
   * to settle itself. Runs ahead of {@link retainAgentSnapshots}, which prunes what it settles.
   */
  async function reconcileAgentSnapshots(): Promise<void> {
    if (core.fileAgents === undefined) return;
    await core.fileAgents.reconcile({
      now: runtimeServices.clock.now(),
      isLive: (runId) => {
        const status = store.getRun(runId)?.status;
        return status === 'running' || status === 'aborting';
      },
      durableState: async (reference) => {
        // Without a durable engine nothing outlives the process, so a reference from before this
        // Bureau was built belongs to a run no one can resume.
        if (!runtime.durable) {
          return Date.parse(reference.startedAt) < constructedAtMilliseconds
            ? { kind: 'absent' }
            : { kind: 'active' };
        }
        const record = await runtime.durable.engine.get(reference.runId);
        if (record === null || record === undefined) return { kind: 'absent' };
        if (DURABLE_FORCIBLY_TERMINABLE_STATUSES.has(record.status)) return { kind: 'active' };
        return { kind: 'ended', at: new Date(record.updatedAt).toISOString() };
      },
    });
  }

  /**
   * COR-1477 — removes every terminal task older than {@link BureauRetentionOptions.tasks}
   * (default 30 days) through {@link deleteRun}, which removes the run from the
   * run store, so the store's `run.removed` event fires and Bureau's own
   * `run.removed` follows for dependents to release their state. A running
   * task and a terminal one inside the window stay.
   *
   * A task is also kept while its COR-424 run-creation binding is stored, expired
   * or not: an exact retry of the request that created it finds the task through
   * that binding, so deleting the task first would turn the retry into a second
   * run. The pass runs ahead of the ledger's own sweep, so a binding the sweep
   * deletes releases its task in the next pass, never the same one. An
   * unreadable binding rejects the read, and nothing is deleted this pass.
   * Resolves how many tasks it removed.
   */
  async function retainTasks(): Promise<number> {
    // COR-1304 — the expired `bureau.tasks.list` snapshots go with every pass, whatever the
    // retention, and are deleted by key alone. A failure here never stops task retention.
    try {
      await core.tasks.expireListings();
    } catch (error: unknown) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] Expired task-listing snapshots could not be deleted: ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
    const retention = taskRetentionOf(currentSettings());
    if (retention === 'forever') return 0;
    const cutoff = runtimeServices.clock.now() - retention.olderThan;
    const expired: string[] = [];
    for (const [runId, runState] of store.getState().runs) {
      if (
        runState.status === 'running' ||
        runState.status === 'aborting' ||
        catalogRunIds.has(runId)
      ) {
        continue;
      }
      // The closing action, not `terminalActionTimestamp`: a run between
      // `run.error` and `run.completed` is still finishing.
      const settledAt = settledActionTimestamp(runState.actions);
      if (settledAt !== undefined && settledAt < cutoff) expired.push(runId);
    }
    const bound = (await core.runCreationLedger?.boundRunIds()) ?? new Set<string>();
    // COR-1481 — the records of tasks whose runs left the run store on their own
    // (a catalog run releases itself when it settles) age out here.
    // COR-1596: what a fire's decided approval keeps to fence a concurrent resolver ends with the
    // fire's task, which is the last thing that could name it.
    let removed = await core.tasks.expire(
      cutoff,
      bound,
      async (record) => {
        // COR-1670: whatever kind of task this was, its run's peer call records end with it.
        peers.releasePeerCalls(record.taskId);
        if (record.kind === 'schedule-fire') {
          await peers.releaseScheduledFire(record.taskId, 'removed', {
            sessionId: record.contextId,
          });
          return;
        }
        // A task the Bureau no longer holds a run for (one a restart left, or one that never had
        // a run) leaves the store without a `run.removed` of its own, so announce its removal here:
        // the state kept for it elsewhere (an A2A task record, a push configuration) ends with it.
        emitter.dispatch(new RunRemovedEvent(record.taskId));
      },
      // COR-1631: a task's surfaces stay readable until its retention ends, and end with it. They
      // go first: a failure keeps the task's record, so the next pass finds the task and retries.
      async (record) => {
        try {
          await core.surfaces?.removeTask(record.taskId);
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'interactive-surfaces',
            message: `[bureau] Could not remove the surfaces of expired task "${record.taskId}": ${serializeUnknownError(error)}`,
            cause: error,
          });
          throw error;
        }
      },
    );
    for (const runId of expired) {
      if (bound.has(runId)) continue;
      try {
        await peers.deleteRun(runId);
        removed += 1;
      } catch (error: unknown) {
        // Gone, or running again, since it was chosen: a later pass decides.
        if (error instanceof BureauError && ['NOT_FOUND', 'CONFLICT'].includes(error.code)) {
          continue;
        }
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Could not remove expired task "${runId}": ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
    }
    return removed;
  }

  /**
   * COR-625 — the terminal-run cleanup step: one application of
   * `options.retention?.checkpoints` to a durable run's weft checkpoint history,
   * run exactly once per run id and reported as a {@link RunCleanupAcknowledgement}.
   *
   * Memoized on `runId` in {@link terminalCheckpointCleanups}, which is what
   * makes "exactly one step, never two" true across the THREE independent
   * triggers that can observe the same run reaching a terminal state: the
   * live run's own terminal listeners, a recovered run's terminal listeners,
   * and `cancelDurableRun` cancelling a run this process holds no
   * `ActiveRun` for at all. Every trigger calls this; the first one to arrive
   * performs the step and the rest await its promise.
   *
   * The step re-reads the durable record before pruning anything. A bureau
   * terminal listener fires on operative's own event emitter, which is NOT
   * proof that the engine's final checkpoint write has committed, and weft's
   * prune rejects on a compare-and-swap race with a concurrent write
   * (`packages/weft/src/core/engine/checkpoint-prune.ts`). Pruning on the
   * event alone would therefore both risk this issue's own rollback trigger
   * — a run whose checkpoints are pruned BEFORE its terminal transition —
   * and manufacture spurious `persistence-failed` results out of a race that
   * is really just "too early". Gating on the same post-transition re-read
   * `resolveCancelDurableRun` already performs removes both.
   *
   * Never rejects: it is folded into `closed()`, which never rejects, and a
   * throw here would be attributed to the RUN's teardown rather than to this
   * step.
   */
  async function runTerminalCheckpointCleanup(runId: string): Promise<RunCleanupAcknowledgement> {
    const existing = terminalCheckpointCleanups.get(runId);
    if (existing) return existing;
    const step = performTerminalCheckpointCleanup(runId);
    terminalCheckpointCleanups.set(runId, step);
    return step;
  }

  /** The un-memoized body of {@link runTerminalCheckpointCleanup}. */
  async function performTerminalCheckpointCleanup(
    runId: string,
  ): Promise<RunCleanupAcknowledgement> {
    // The outer fence behind this step's "never rejects" contract. Every
    // caller depends on it: the terminal listeners fire this as
    // `void runTerminalCheckpointCleanup(...)`, where a rejection becomes an
    // unhandled rejection, and `cancelDurableRun` AWAITS it while its own
    // public doc comment promises it never rejects. `classifyTerminalCheckpointCleanup`
    // classifies the outcomes it can see, but it also awaits a
    // runtime-timer sleep and the engine's prune, so it cannot promise this on
    // its own — the same reason `shutdown()` wraps its identical
    // `shutdownTimeoutSleep` race in `settleNeverRejecting`.
    let acknowledgement: RunCleanupAcknowledgement;
    try {
      acknowledgement = await classifyTerminalCheckpointCleanup(runId);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'audit-trail',
        message: `[bureau] terminal checkpoint cleanup for run "${runId}" settled via an unexpected rejection: ${serializeUnknownError(error)}`,
      });
      acknowledgement = { status: 'failed', error };
    }
    // The acknowledgement is recorded whatever it is — including the
    // `not-required` of the default `'keep-all'` policy. "A cleanup failure
    // that is invisible" is this issue's other named rollback trigger, and
    // an operator can only answer "did cleanup finish?" from a record that
    // exists for every run, not only for the ones that pruned something.
    await core.auditTrailInstance
      ?.record({
        runId,
        type: 'run.cleanup-settled',
        detail: { acknowledgement },
      })
      .catch((error: unknown) => {
        // `record()` is documented best-effort and does not reject without a
        // `dedupeKey`; a rejection nonetheless must not turn a successful
        // prune into a failed cleanup, so it is diagnosed rather than
        // folded into the acknowledgement.
        diagnose({
          level: 'warn',
          scope: 'audit-trail',
          message: `[bureau] run.cleanup-settled audit record failed for run "${runId}"`,
          cause: error,
        });
      });
    return acknowledgement;
  }

  /**
   * Resolves the step's acknowledgement without recording it. Split from
   * {@link performTerminalCheckpointCleanup} so the audit write happens on
   * exactly one path, including the early returns.
   */
  async function classifyTerminalCheckpointCleanup(
    runId: string,
  ): Promise<RunCleanupAcknowledgement> {
    const durable = runtime.durable;
    // Nothing durable to retain: a process-local run has no checkpoint
    // history, which is this issue's own documented out-of-scope case.
    if (!durable) return { status: 'not-required' };
    const retention = currentSettings()['retention.checkpoints'];
    if (!retention || retention === 'keep-all') return { status: 'not-required' };

    let state: WorkflowState | null;
    try {
      state = await durable.engine.get(runId);
    } catch (error) {
      return { status: 'unresolved', reason: 'persistence-failed', error };
    }
    if (!state || DURABLE_FORCIBLY_TERMINABLE_STATUSES.has(state.status)) {
      // Either the engine has no such run, or it is not terminal yet. Both
      // mean this step cannot truthfully claim to have pruned a terminal
      // run's history — see this function's own doc comment.
      return {
        status: 'unresolved',
        reason: 'persistence-failed',
        error: new Error(
          `runTerminalCheckpointCleanup("${runId}"): refusing to prune checkpoints for a run ` +
            `the engine reports as ${state ? `"${state.status}"` : 'missing'} — not terminal.`,
        ),
      };
    }

    const timeoutMilliseconds = retention.timeoutMilliseconds;
    if (timeoutMilliseconds === undefined) {
      try {
        await durable.engine.pruneCheckpoints(runId, { keepLast: retention.keepLast });
        return { status: 'completed' };
      } catch (error) {
        return { status: 'unresolved', reason: 'persistence-failed', error };
      }
    }

    // The bound ABORTS the prune rather than merely abandoning the wait:
    // weft throws the abort reason before issuing any delete, so a step that
    // times out while still scanning leaves no unowned deletes running
    // behind a cached `'timed-out'` acknowledgement. Weft stops rechecking
    // the signal once its first delete chunk commits (see
    // `checkpoint-prune.ts`'s own doc comment), so a prune large enough to
    // span more than one chunk can still finish its remaining chunks after
    // the abort — an abandoned wait would leave EVERY delete unowned, which
    // is the case this actually closes. Sleeps on `shutdownTimeoutSleep`, which
    // is `RuntimeServices.timers`-backed (never a real timer), so a manual
    // runtime drives this exactly as it drives `shutdown()`'s own wait.
    const pruneAbort = new AbortController();
    const sleepAbort = new AbortController();
    try {
      const outcome = await Promise.race([
        durable.engine
          .pruneCheckpoints(runId, { keepLast: retention.keepLast, signal: pruneAbort.signal })
          .then(
            (): RunCleanupAcknowledgement => ({ status: 'completed' }),
            (error: unknown): RunCleanupAcknowledgement =>
              pruneAbort.signal.aborted
                ? { status: 'unresolved', reason: 'timed-out' }
                : { status: 'unresolved', reason: 'persistence-failed', error },
          ),
        shutdownTimeoutSleep(timeoutMilliseconds, sleepAbort.signal).then(
          (): RunCleanupAcknowledgement => {
            pruneAbort.abort();
            return { status: 'unresolved', reason: 'timed-out' };
          },
        ),
      ]);
      return outcome;
    } finally {
      // Release whichever side of the race lost, so a pending
      // timer does not outlive this step.
      sleepAbort.abort();
    }
  }

  // COR-2009 — whether the maintenance passes remove expired records, or the host does it through
  // `removeExpiredRecords` on a schedule of its own.
  const expiredRecordsByMaintenance = options.expiredRecords !== 'on-request';

  // The sweep in flight, shared by every caller. The automatic timer and a manual
  // `maintain()` can overlap, and two concurrent sweeps can each open a receipt for the
  // same expired record, so a caller that arrives while one runs waits for it instead of starting
  // another. Within one Bureau this is the whole guard, as `automaticRunOwnershipPruneCurrentPass`
  // is for the timer's own passes.
  let memoryRetentionSweepInFlight: Promise<number | 'failed'> | undefined;

  /**
   * COR-1629 — expires the tenant's records that have outlived their retention, so a collection that
   * reached `maxRecordsPerCollection` accepts writes again. Governed memory runs nothing on a timer
   * of its own, so every maintenance pass calls this before `propagateMemoryDeletions`, which then
   * starts advancing the deletions the sweep opened. A sweep that throws, or that governed memory
   * refuses, is reported once, by the pass that started it, and never stops the rest of any pass
   * that waited on it. Resolves how many expired memories it opened a deletion for, or `'failed'`.
   */
  function sweepMemoryRetention(pass: MaintenancePassName): Promise<number | 'failed'> {
    if (runtime.memory === undefined || core.maintenanceMemoryAuthority === undefined) {
      return Promise.resolve(0);
    }
    if (memoryRetentionSweepInFlight !== undefined) return memoryRetentionSweepInFlight;
    const memory = runtime.memory;
    const authority = core.maintenanceMemoryAuthority;
    const sweep = (async () => {
      try {
        // COR-1809: `retention.memory` is read per pass, so a change applies to the next sweep.
        const window = currentSettings()['retention.memory'];
        const result = await memory.sweepRetention(
          authority,
          window === undefined
            ? undefined
            : { retention: { episodic: { kind: 'duration', milliseconds: window.olderThan } } },
        );
        if (result.status !== 'applied') {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message:
              `[bureau] ${pass} memory retention sweep was ${result.status}` +
              `${result.reason === undefined ? '' : ` (${result.reason})`}, so no expired record was deleted.`,
          });
          return 'failed' as const;
        }
        return result.deletionIds.length;
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] ${pass} memory retention sweep failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
        return 'failed' as const;
      }
    })().finally(() => {
      memoryRetentionSweepInFlight = undefined;
    });
    memoryRetentionSweepInFlight = sweep;
    return sweep;
  }

  /**
   * COR-1811 — removes the persisted workflow log lines of finished runs that wrote nothing for longer
   * than `retention.logs`, read per pass so a change applies to the next one. With the setting unset the
   * lines stay until their run is purged. A failure is reported and never stops the rest of a pass.
   */
  async function pruneWorkflowLogs(pass: MaintenancePassName): Promise<number | 'failed'> {
    const logs = runtime.durable?.workflowLogs;
    const window = currentSettings()['retention.logs'];
    if (logs === undefined || window === undefined) return 0;
    try {
      const pruned = await logs.prune({ olderThan: window.olderThan });
      return pruned.runs;
    } catch (error: unknown) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] ${pass} workflow log retention pass failed: ${serializeUnknownError(error)}`,
        cause: error,
      });
      return 'failed';
    }
  }

  /**
   * COR-1941 — removes the notifications written longer ago than `retention.notifications`, read per
   * pass so a change applies to the next one. With the setting unset an owner keeps up to 1000. A
   * failure is reported and never stops the rest of a pass.
   */
  async function pruneNotifications(pass: MaintenancePassName): Promise<number | 'failed'> {
    const window = currentSettings()['retention.notifications'];
    if (window === undefined) return 0;
    try {
      return await core.notificationsComposition.prune(window.olderThan);
    } catch (error: unknown) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] ${pass} notification retention pass failed: ${serializeUnknownError(error)}`,
        cause: error,
      });
      return 'failed';
    }
  }

  /**
   * COR-1943 — removes the settled hook deliveries last written longer ago than
   * `retention.hookDeliveries`, read per pass so a change applies to the next one. With the setting
   * unset, or no hooks, nothing is removed; a pending delivery never is. A failure is reported and
   * never stops the rest of a pass.
   */
  async function pruneHookDeliveries(pass: MaintenancePassName): Promise<number | 'failed'> {
    const window = currentSettings()['retention.hookDeliveries'];
    if (window === undefined || core.hooksInstance === undefined) return 0;
    try {
      return await core.hooksInstance.prune(window.olderThan);
    } catch (error: unknown) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] ${pass} hook delivery retention pass failed: ${serializeUnknownError(error)}`,
        cause: error,
      });
      return 'failed';
    }
  }

  /** The most chats one maintenance pass deletes, so a first pass over a large backlog stays bounded. */
  const CHAT_RETENTION_BATCH_SIZE = 100;

  /**
   * Deletes the chats whose last message is older than `retention.chats`, read per pass so a change
   * applies to the next one, through the same deletion a person's delete runs (live runs cancelled,
   * content purged, the deletion audited). A chat is a context no goal, schedule or try started, and
   * its age is its `updatedAt`, which a rename does not move. With the setting `'forever'` nothing is
   * deleted. A failure is reported and never stops the rest of a pass. Resolves how many chats it
   * deleted, or `'failed'`.
   */
  async function pruneChats(pass: MaintenancePassName): Promise<number | 'failed'> {
    const window = currentSettings()['retention.chats'];
    if (window === undefined || window === 'forever' || !runtime.sessionStore) return 0;
    try {
      const cutoff = runtimeServices.clock.now() - window.olderThan;
      const oldest = await peers.listSessions({
        origin: 'chat',
        sortBy: 'updatedAt',
        sortOrder: 'asc',
        limit: CHAT_RETENTION_BATCH_SIZE,
      });
      let deleted = 0;
      for (const chat of oldest) {
        if (new Date(chat.updatedAt).getTime() >= cutoff) break;
        // The listing is read before any chat's lease: a message sent since moves the chat inside
        // the window, so the deletion checks again under the lease and keeps a chat that moved.
        const report = await peers.startSessionDeletion(chat.id, { idleBefore: cutoff });
        if (report.deleted) deleted += 1;
      }
      return deleted;
    } catch (error: unknown) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] ${pass} chat retention pass failed: ${serializeUnknownError(error)}`,
        cause: error,
      });
      return 'failed';
    }
  }

  /**
   * COR-1546 — advances every open governed-memory deletion: resumes an interrupted synchronous
   * lane and settles the bounded-async targets, which stay pending until something asks. Governed
   * memory runs nothing on a timer of its own, so a record forgotten through `bureau.memory.forget`
   * reports its other targets settled only because each maintenance pass calls this.
   */
  async function propagateMemoryDeletions(): Promise<void> {
    await runtime.memory?.processDeletionPropagation();
  }

  async function maintain(now?: number): Promise<true | undefined> {
    if (core.maintenanceAdmissionClosed) {
      throw new BureauError('Cannot run durable maintenance: bureau is shutting down', 'CONFLICT');
    }
    const hasDurableEngine = Boolean(runtime.durable);
    // AB-388 (Codex review, PR #597, "Isolate audit pruning from engine
    // maintenance failures"): a rejected `engine.runMaintenance()` (e.g. a
    // transient storage error) used to exit this function BEFORE any of
    // `pruneStaleRunOwnership()`/`drainOutbox()`/`pruneAuditTrail()`
    // ran, even though the sub-passes below are already isolated from EACH
    // OTHER by their own try/catch — a failed alarm silently also skipped
    // the others. The engine failure is captured here, every sub-pass
    // still runs unconditionally, and the captured failure is re-thrown
    // only at the end, so a caller still observes (and can alert on) the
    // engine failure exactly as before, just no longer at the cost of
    // skipping the other passes.
    let engineMaintenanceError: Error | undefined;
    let engineMaintenanceFailed = false;
    // COR-1477 — how many terminal tasks this pass removed.
    let tasksRemoved = 0;

    const pass = (async () => {
      // COR-1710 — a settings change another process made applies from this pass on, ahead of the
      // passes that read it.
      try {
        await core.settingsComposition?.reload();
      } catch (error: unknown) {
        diagnoseSettings(
          `[bureau] Manual settings re-read failed: ${serializeUnknownError(error)}`,
          error,
        );
      }
      // COR-1946 — a manual host's lease is renewed here, and what a stopped process left is looked
      // for again, since the Bureau runs no timer of its own for either.
      if (options.maintenance === 'manual') {
        try {
          await core.processLease.renew();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Could not renew the process lease: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        await core.abandonedTaskSweeper.run();
      }
      if (hasDurableEngine) {
        try {
          await runtime.durable?.engine.runMaintenance(now);
        } catch (error: unknown) {
          engineMaintenanceFailed = true;
          // Normalized to a real `Error` (never re-thrown as `unknown`) so
          // the eventual `throw engineMaintenanceError` below satisfies
          // `@typescript-eslint/only-throw-error`.
          engineMaintenanceError =
            error instanceof Error ? error : new Error(serializeUnknownError(error));
        }
      }
      try {
        await peers.pruneStaleRunOwnership();
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Manual run-ownership pruning pass failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      try {
        await peers.drainOutbox();
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Manual session-outbox drain pass failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      // COR-1934 — the content purge of a deleted chat that failed or was cut short is finished.
      try {
        await core.chatContentPurge.sweep();
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Manual deleted-chat purge pass failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      // COR-1664 — claims on assets whose run ended or whose session was deleted without a release.
      await peers.reconcileAssetClaims();
      // COR-194 — a schedule transition whose record failed after its commit is retried here.
      try {
        await peers.pauseInvalidSchedules();
        await peers.recordPendingScheduleTransitions();
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Manual schedule-transition drain pass failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      // COR-1476 — the backstop: input left open with no live run, by a run-end
      // settlement that never ran, is cancelled here.
      try {
        await core.sessionInputSettlement?.sweep();
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Manual session-input sweep failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      // COR-1477 — before the audit prune, so its clamp reads the advanced floor.
      try {
        await retainEventHistory();
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Manual event-history retention pass failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      // COR-2009 — expired records go with this pass unless the host removes them itself.
      if (expiredRecordsByMaintenance) {
        try {
          await pruneAuditTrail();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Manual audit-trail pruning pass failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
      }
      // COR-1622 — expired reviews go with a manual host's maintenance, as they do with the
      // automatic timer's: ahead of task retention, which holds a task open for a review it lists.
      try {
        await peers.sweepExpiredReviews(now);
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Manual expired-review sweep failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      // COR-1477 — before the receipt prune: a task leaves only once its
      // binding is gone, so a binding the prune below deletes releases its task
      // in the next pass.
      try {
        tasksRemoved = await retainTasks();
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Manual task retention pass failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      // COR-1669 — a task marked resync-pending, or settled with no event that says so.
      try {
        await core.taskResyncInstance?.repairAll();
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Manual task-history repair pass failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      try {
        await reconcileAgentSnapshots();
        await retainAgentSnapshots();
        await retainWorkflowSnapshots();
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Manual agent snapshot retention pass failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      try {
        await core.runCreationLedger?.prune();
        await core.forkLedger.prune();
        await core.regenerateLedger.prune();
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Manual run-creation receipt pruning pass failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      if (expiredRecordsByMaintenance) {
        // COR-1629 — governed memory's retention expires only when asked to, before its deletions advance.
        await sweepMemoryRetention('Manual');
        // COR-1811 — persisted workflow log lines past `retention.logs`.
        await pruneWorkflowLogs('Manual');
        // COR-1941 — notifications past `retention.notifications`.
        await pruneNotifications('Manual');
        // COR-1943 — settled hook deliveries past `retention.hookDeliveries`.
        await pruneHookDeliveries('Manual');
        // Chats past `retention.chats`.
        await pruneChats('Manual');
      }
      // COR-1898 — governed memory's embedder switch advances only when asked to.
      await core.memoryEmbedder?.reconcile();
      // COR-1546 — governed memory's deletions advance only when asked to.
      try {
        await propagateMemoryDeletions();
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Manual memory deletion propagation pass failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
    })();

    manualDurableMaintenancePasses.add(pass);
    try {
      await pass;
    } finally {
      manualDurableMaintenancePasses.delete(pass);
    }

    if (engineMaintenanceFailed) {
      // The `?? new Error(...)` fallback is unreachable in practice —
      // `engineMaintenanceFailed` is only ever set alongside
      // `engineMaintenanceError` above — but keeps this a definite `Error`
      // for `@typescript-eslint/only-throw-error`, since the two are
      // separate bindings the type checker cannot link.
      throw engineMaintenanceError ?? new Error('Durable engine maintenance failed');
    }
    // `true` whenever there was ANY maintenance surface to drive (a durable
    // engine, or just the KV-backed audit trail) — `undefined` only for the
    // fully ephemeral case (no durable engine AND no audit trail), matching
    // this function's pre-existing "nothing here" contract for a bureau
    // with no persistence at all. COR-1477: a pass that removed terminal tasks
    // did maintain something, so it reports `true` even there.
    return hasMaintenanceSurface({
      durableEngine: hasDurableEngine,
      auditTrail: Boolean(core.auditTrailInstance),
      memory: runtime.memory !== undefined,
      notificationRetention: currentSettings()['retention.notifications'] !== undefined,
      hookDeliveryRetention: currentSettings()['retention.hookDeliveries'] !== undefined,
      tasksRemoved,
    })
      ? true
      : undefined;
  }

  /**
   * COR-2009 — removes every record past its retention window now: audit records and the resolved
   * reviews they describe (`retention.audit`), expired memories (`retention.memory`, or the memory
   * policy), finished runs' log lines (`retention.logs`), notifications (`retention.notifications`)
   * and settled hook deliveries (`retention.hookDeliveries`), with the windows read afresh. Each
   * kind's pass is isolated as in `maintain`, so one that fails is diagnosed, listed in `failed`,
   * and stops none of the others. Shutdown waits for a removal in flight, as for `maintain`.
   */
  async function removeExpiredRecords(): Promise<ExpiredRecordRemoval> {
    if (core.maintenanceAdmissionClosed) {
      throw new BureauError('Cannot remove expired records: bureau is shutting down', 'CONFLICT');
    }
    let removal: ExpiredRecordRemoval | undefined;
    const pass = (async () => {
      try {
        await core.settingsComposition?.reload();
      } catch (error: unknown) {
        diagnoseSettings(
          `[bureau] Settings re-read before removing expired records failed: ${serializeUnknownError(error)}`,
          error,
        );
      }
      let audit: number | 'failed' = 'failed';
      let reviews: number | 'failed' = 'failed';
      try {
        ({ audit, reviews } = await pruneAuditTrail());
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Requested audit-trail pruning pass failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      removal = expiredRecordRemovalOf({
        audit,
        reviews,
        memories: await sweepMemoryRetention('Requested'),
        logs: await pruneWorkflowLogs('Requested'),
        notifications: await pruneNotifications('Requested'),
        hookDeliveries: await pruneHookDeliveries('Requested'),
        chats: await pruneChats('Requested'),
      });
    })();
    manualDurableMaintenancePasses.add(pass);
    try {
      await pass;
    } finally {
      manualDurableMaintenancePasses.delete(pass);
    }
    return removal!;
  }

  // AB-363 — Codex review PR #568, "Run ownership pruning in the automatic
  // maintenance profile": `maintain()` above is the ONLY
  // caller of `pruneStaleRunOwnership()`, but that wrapper is documented
  // (`BureauOptions.maintenance`) as something only a
  // manual/serverless host calls on its own alarm/Cron trigger. The
  // DEFAULT `'automatic'` profile instead has Weft run its OWN
  // `engine.runMaintenance()` on in-process intervals it starts and owns
  // internally (`backgroundTasks: 'automatic'` in `runtime-composition.ts`)
  // — Weft's engine exposes no hook to run extra work after each of ITS
  // maintenance cycles, so without a SEPARATE bureau-owned interval here,
  // a default automatic bureau would never prune `lastRunOwningPrincipals`
  // at all, no matter how far an operator or retention driver advances the
  // fleet-feed floor.
  //
  // This timer calls `pruneStaleRunOwnership()` ONLY, never the
  // `maintain()` wrapper — that wrapper also calls
  // `runtime.durable.engine.runMaintenance()`, which the automatic profile
  // is ALREADY running on its own schedule; calling it again here would
  // double-drive Weft's engine maintenance.
  //
  // `AUTOMATIC_RUN_OWNERSHIP_PRUNE_INTERVAL_MS` matches Weft's own
  // `DEFAULT_RETENTION_SWEEP_INTERVAL_MS` (5 minutes,
  // `weft/src/core/types/constants.ts`) — the cadence the fleet feed's own
  // retention floor advances on by default, so this pruning pass runs
  // about as often as there is new floor movement to react to. Not a
  // `BureauOptions` knob (coordinator ruling, AB-363: the issue's
  // acceptance criteria name no configurable cadence) — a fixed constant
  // is the simplest thing that satisfies "the automatic profile also
  // prunes" without inventing new public surface this issue never asked
  // for.
  //
  // Uses `runtimeServices.timers` (never a bare global `setInterval`) so a
  // test using `createManualRuntimeServices()` can drive this
  // deterministically via `runtime.advance(...)`, with no real sleep.
  const AUTOMATIC_RUN_OWNERSHIP_PRUNE_INTERVAL_MS = EXPIRY_SWEEP_INTERVAL_MILLISECONDS;

  /** Starts the automatic maintenance timer. */
  function startAutomaticMaintenance(): void {
    core.automaticRunOwnershipPruneTimerStarted = true;
    core.automaticRunOwnershipPruneTimer = runtimeServices.timers.setInterval(() => {
      if (core.automaticRunOwnershipPruneCurrentPass) return;
      // AB-389 — `drainOutbox()` rides this SAME timer, tracked by
      // the SAME in-flight guard: the coordinator ruling requires the
      // session outbox drain to run "on the runtime clock inside the
      // durable maintenance pass," and — like `pruneStaleRunOwnership`
      // above it (AB-363's own rationale, unchanged) — the automatic
      // profile has Weft run its OWN `engine.runMaintenance()` on an
      // interval it starts and owns internally, exposing no hook to run
      // extra work after each cycle. Without this timer also driving the
      // drain, a default automatic bureau would never drain the outbox at
      // all except via the post-commit trigger, which is best-effort by
      // design (a missed dispatch, or a process that crashes before it
      // fires, would otherwise never get a second chance until an operator
      // manually calls `maintain()`).
      //
      // AB-388: the same guarded, awaited pass now also prunes the durable
      // audit trail (`options.retention?.audit`) — never a second, separate
      // timer. Each sub-pass has its own try/catch so a failure in one
      // (e.g. a rejected `sessionStore.list()`) never prevents the others
      // from running this tick; each is diagnosed under its own message so
      // all three remain distinguishable in `onDiagnostic` output.
      const pass = (async () => {
        // COR-1710 — a settings change another process made applies from this pass on, ahead of the
        // passes that read it.
        try {
          await core.settingsComposition?.reload();
        } catch (error: unknown) {
          diagnoseSettings(
            `[bureau] Automatic settings re-read failed: ${serializeUnknownError(error)}`,
            error,
          );
        }
        try {
          await peers.pruneStaleRunOwnership();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Automatic run-ownership pruning pass failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        try {
          await peers.drainOutbox();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Automatic session-outbox drain pass failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        // COR-1664 — claims on assets whose run ended or whose session was deleted without a release.
        await peers.reconcileAssetClaims();
        // COR-194 — a schedule transition whose record failed after its commit is retried here.
        try {
          await peers.pauseInvalidSchedules();
          await peers.recordPendingScheduleTransitions();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Automatic schedule-transition drain pass failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        // COR-1934 — the content purge of a deleted chat that failed or was cut short.
        try {
          await core.chatContentPurge.sweep();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Automatic deleted-chat purge pass failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        // COR-1476 — the backstop for input left open with no live run.
        try {
          await core.sessionInputSettlement?.sweep();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Automatic session-input sweep failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        // COR-1477 — before the audit prune, so its clamp reads the advanced floor.
        try {
          await retainEventHistory();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Automatic event-history retention pass failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        // COR-2009 — expired records go with this pass unless the host removes them itself.
        if (expiredRecordsByMaintenance) {
          try {
            await pruneAuditTrail();
          } catch (error: unknown) {
            diagnose({
              level: 'error',
              scope: 'durable-maintenance',
              message: `[bureau] Automatic audit-trail pruning pass failed: ${serializeUnknownError(error)}`,
              cause: error,
            });
          }
        }
        // COR-1613 — expired reviews go without a host calling `sweepExpiredReviews`: a fire's
        // or a session run's approval whose binding ran out is expired, and its state released.
        // Ahead of task retention, which holds a task open for a review it still lists.
        try {
          await peers.sweepExpiredReviews();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Automatic expired-review sweep failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        // COR-1477 — before the receipt prune: a task leaves only once its
        // binding is gone, so a binding the prune below deletes releases its
        // task in the next pass.
        try {
          await retainTasks();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Automatic task retention pass failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        try {
          await core.taskResyncInstance?.repairAll();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Automatic task-history repair pass failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        try {
          await reconcileAgentSnapshots();
          await retainAgentSnapshots();
          await retainWorkflowSnapshots();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Automatic agent snapshot retention pass failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        // COR-424 — expired run-creation receipts ride the same pass.
        try {
          await core.runCreationLedger?.prune();
          await core.forkLedger.prune();
          await core.regenerateLedger.prune();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Automatic run-creation receipt pruning pass failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        if (expiredRecordsByMaintenance) {
          // COR-1629 — governed memory's retention expires only when asked to, before its deletions advance.
          await sweepMemoryRetention('Automatic');
          // COR-1811 — persisted workflow log lines past `retention.logs`.
          await pruneWorkflowLogs('Automatic');
          // COR-1941 — notifications past `retention.notifications`.
          await pruneNotifications('Automatic');
          // COR-1943 — settled hook deliveries past `retention.hookDeliveries`.
          await pruneHookDeliveries('Automatic');
          // Chats past `retention.chats`.
          await pruneChats('Automatic');
        }
        // COR-1898 — governed memory's embedder switch advances only when asked to.
        await core.memoryEmbedder?.reconcile();
        // COR-1546 — governed memory's deletions advance only when asked to.
        try {
          await propagateMemoryDeletions();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Automatic memory deletion propagation pass failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
      })().finally(() => {
        core.automaticRunOwnershipPruneCurrentPass = undefined;
      });
      core.automaticRunOwnershipPruneCurrentPass = pass;
      detachBestEffortPromise(pass);
    }, AUTOMATIC_RUN_OWNERSHIP_PRUNE_INTERVAL_MS);
  }

  return {
    durableTerminalCleanup,
    eventRetentionCutoff,
    runTerminalCheckpointCleanup,
    classifyTerminalCheckpointCleanup,
    maintain,
    removeExpiredRecords,
    startAutomaticMaintenance,
  };
}
