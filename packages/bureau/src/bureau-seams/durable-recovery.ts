/**
 * Durable recovery (COR-2376 slice S4): the boot pass that settles and reattaches what a crashed
 * process left behind (`recoverDurableRuns`, `recoverDurableRunsPass`) and the task-record
 * reconciliation (`reconcileTaskRecords`). Built by `constructBureau` and reached only through
 * `createBureau`. The order of its steps is a contract.
 */
import type { AgentDefinitions } from '../agent-catalog';
import {
  type AgentSession,
  type DurableRunDeps,
  type JSONValue,
  type RecoveredRunHandle,
  bureauInvariantsField,
  type createRecoveredRunEventSurface,
  isAgentRunWorkflowInput,
  isScheduledAgentRunInput,
} from '@lostgradient/operative';
import { BUREAU_AGENT_NAME } from '../bureau-construction-support';
import type { BureauCore } from './core';
import type { BureauRecoveryReport } from '../types';
import type { BureauSteeringGate } from '../steering';
import { sessionRunMediaOptions } from '../provider-resolution';
import { type BureauToolbox, type SessionAgentRun } from '../runtime-composition-types';
import {
  type ClassifyRecoveredRunArgs,
  type SessionLoadOutcome,
  classifyRecoveredRunDetailed,
  dedupeRecoveryPerRunFailures,
  emptyRecoveredStepMetadata,
  isRecoverableScheduledFireInput,
  loadExistingScheduledSessionId,
  loadScheduleIdForRecoveredRun,
  monitorRecoveredScheduledFire,
} from '../recovered-run-classification';
import { Conversation } from 'conversationalist';
import type { RecoveredRunVerdict, RecoveryRejectionReason } from '../events';
import { type RecoveredWorkflowInfo, WorkflowRecoverySkippedEvent } from '@lostgradient/weft';
import {
  SCHEDULE_FIRE_SETTLED_EVENT_KIND,
  scheduleFireSettledDedupeKey,
} from '../schedule-fire-settled-event';
import {
  TASK_ARTIFACT_TEXT_LIMIT,
  type TaskRecord,
  originatingMessageText,
  settledTaskState,
} from '../task-registry';
import { copyAgentOwnedRunOptions, sessionExecuteOptions } from '../session-agent-options';
import { isScheduleTickRunId } from '../schedule-tick';
import { ownerOrLocal } from '../owner-of-record';
import { recoveredRequestContextFromMetadata } from '../session-request-context';
import { resolveRunMemoryOwner, resolveSessionOwner } from '../session-authority';
import { serializeUnknownError } from '../serialization';
import { subordinateTaskAdmission } from '../catalog-task-settlement';

/** The callables durableRecovery reads from elsewhere in `constructBureau`. */
export interface DurableRecoveryPeers {
  /** Appends a settled schedule fire's event to its schedule's history, once. */
  readonly appendFireSettledEvent: (record: TaskRecord) => Promise<void>;
  /** Dispatches a recovered run's classification on the Bureau's emitter. */
  readonly dispatchRecoveryClassification: (
    runId: string,
    classification: { verdict: RecoveredRunVerdict; rejection?: RecoveryRejectionReason },
  ) => void;
  /** Dispatches the release of a recovered run's lease, if it held one. */
  readonly dispatchRecoveryLeaseReleasedIfAny: (runId: string) => void;
  /** Handles a workflow the durable engine recovers at boot. */
  readonly onRecoveredWorkflow: (info: RecoveredWorkflowInfo) => Promise<void>;
  /** Reattaches a recovered run's handle to the live run registries. */
  readonly reattachRecoveredRun: (
    runId: string,
    sessionId: string,
    handle: RecoveredRunHandle,
    eventSurface?: ReturnType<typeof createRecoveredRunEventSurface>,
    recoveredServices?: DurableRunDeps,
    sessionMetadata?: unknown,
    steeringGate?: BureauSteeringGate,
    sessionIncarnation?: string,
  ) => void;
  /** Rebuilds the review of a run parked on a human wait. */
  readonly reconstructHumanWaitReviewIfParked: (runId: string) => Promise<void>;
  /** Recovers the goals left in flight, and reports the runs it could not. */
  readonly recoverGoalsAtBoot: () => Promise<{ runId: string; reason: string }[]>;
  /** Skips a recovered run that another process already finished. */
  readonly skipRunFinishedByPeer: (
    runId: string,
    args: ClassifyRecoveredRunArgs,
    classification: { verdict: RecoveredRunVerdict; rejection?: RecoveryRejectionReason },
  ) => Promise<{ verdict: RecoveredRunVerdict; rejection?: RecoveryRejectionReason }>;
  /** Cancels the suspended scheduler runs left behind, and counts those it could not cancel. */
  readonly sweepSuspendedSchedulerRuns: (
    engine: NonNullable<BureauCore<AgentDefinitions>['runtime']['durable']>['engine'],
  ) => Promise<number>;
  /** Closes the reviews a canceled schedule fire left open. */
  readonly closeOpenReviewsOfCanceledFire: (runId: string) => Promise<void>;
  /** Restores a recovered run's pending approval states into its toolbox. */
  readonly restorePendingApprovalStates: (
    toolbox: BureauToolbox,
    metadata: unknown,
    runId: string,
    sessionId: string,
    committed?: ReadonlySet<string>,
  ) => Promise<void>;
  /** Retries the review closes of canceled fires that failed at an earlier boot. */
  readonly retryCanceledFireCloses: () => Promise<void>;
  /** The event retention cutoff in force, if any. */
  readonly eventRetentionCutoff: () => number | undefined;
  /** Drains the session outbox. */
  readonly drainOutbox: () => Promise<void>;
  /** Whether a run is the child of another run. */
  readonly isChildRun: (runId: string) => Promise<boolean>;
  /** Attaches a recovered run to its session's input gate. */
  readonly attachRecoveredSessionInput: (
    sessionId: string,
    runId: string,
    services: DurableRunDeps,
    incarnation: string | undefined,
  ) => Promise<void>;
  /** Settles a session's inputs once a run has ended. */
  readonly settleSessionInputsAfterRunEnd: (sessionId: string, runId: string) => Promise<void>;
  /** Resolves the agent a recovered session run continues with. */
  readonly resolveRecoveredSessionAgent: (
    agentName: string,
    runId: string,
    metadata: Record<string, JSONValue>,
    sessionId: string,
  ) => Promise<SessionAgentRun | undefined | 'unavailable'>;
  /** Recovers a recovered run's steering gate from the durable steering log. */
  readonly recoverRunSteering: (
    sessionId: string,
    session: AgentSession | undefined,
    runId: string,
    services: DurableRunDeps,
  ) => Promise<BureauSteeringGate | undefined>;
}

/** Builds the durable recovery functions of one Bureau. Synchronous, and registers nothing. */
export function createDurableRecovery<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: DurableRecoveryPeers,
) {
  const { runtimeServices, store, recoveredWorkflowHandler, runtime, diagnose } = core;

  /**
   * COR-1481 — a crash can land between a run reaching its terminal state and the task record
   * saying so, or between a catalog run's durable start and its task record being written. At
   * boot, a task record whose durable run is terminal is settled from the durable state, and a
   * durable catalog run with no task record is given one. A run still in flight is left to the
   * recovery that reattaches it, which settles it as it ends.
   */
  async function reconcileTaskRecords(): Promise<void> {
    const durable = runtime.durable;
    if (!durable) {
      // COR-1946: with no durable engine every run is process-local, and only the lease rule applies.
      await core.abandonedTaskSweeper.run();
      return;
    }
    const settle = async (
      taskId: string,
      state: Awaited<ReturnType<typeof durable.engine.get>>,
    ): Promise<void> => {
      if (state === null) return;
      if (
        state.status !== 'completed' &&
        state.status !== 'failed' &&
        state.status !== 'cancelled' &&
        state.status !== 'timed-out'
      ) {
        return;
      }
      const result =
        state.result !== null && typeof state.result === 'object'
          ? (state.result as Record<string, unknown>)
          : {};
      const finishReason =
        typeof result['finishReason'] === 'string' ? result['finishReason'] : undefined;
      const status =
        state.status === 'completed'
          ? settledTaskState('completed', finishReason)
          : state.status === 'cancelled'
            ? 'canceled'
            : 'failed';
      const content = typeof result['content'] === 'string' ? result['content'] : '';
      // COR-1613: a fire canceled while parked on a human wait, whose process died before it
      // wrote the wait's `canceled` record, has its wait closed here, from the checkpoint.
      if (state.status === 'cancelled') {
        // COR-1622: a close that cannot be made is reported and retried at the next boot; it never
        // keeps the task from being settled.
        await peers.closeOpenReviewsOfCanceledFire(taskId).catch((error: unknown) => {
          diagnose({
            level: 'error',
            scope: 'recovery',
            message: `[bureau] Could not close the reviews of canceled schedule fire "${taskId}": ${serializeUnknownError(error)}`,
            cause: error,
          });
        });
      }
      await core.tasks.recordSettled(taskId, {
        at: runtimeServices.clock.nowISO(),
        status,
        finishReason: finishReason ?? (status === 'canceled' ? 'aborted' : null),
        message:
          status === 'failed' && typeof state.error === 'string'
            ? state.error.slice(0, 1000)
            : null,
        ...(status === 'completed' && content !== ''
          ? {
              answer: {
                text: content.slice(0, TASK_ARTIFACT_TEXT_LIMIT),
                truncated: content.length > TASK_ARTIFACT_TEXT_LIMIT,
              },
            }
          : {}),
      });
    };
    for (const record of await core.tasks.unsettled()) {
      if (store.getRun(record.taskId) !== undefined) continue;
      await settle(record.taskId, await durable.engine.get(record.taskId));
    }
    // COR-1946: what the durable state did not settle, and no durable workflow records, belongs to
    // the process that admitted it.
    await core.abandonedTaskSweeper.run();
    // COR-1594: a fire whose settlement was written but whose history event never was, because its
    // process died between the two, would leave a stream open on another process for ever. The
    // event is deduplicated per fire, so the ones that were appended are skipped by their marker.
    // A read that fails here is reported and leaves the pass to the next boot, and the steps after
    // it still run. It is a plain `try`, not a wrapped call, so the boot takes no extra turn.
    if (core.eventHistoryInstance !== undefined) {
      try {
        // Event retention removes an event together with its deduplication marker, so a fire
        // settled before its cutoff has neither, by design, and is not announced again at every
        // boot. Under `'forever'` nothing is retired, so there is no bound.
        const cutoff = peers.eventRetentionCutoff();
        for (const record of await core.tasks.settledFires()) {
          if (cutoff !== undefined && Date.parse(record.settled?.at ?? '') < cutoff) continue;
          const owner = { kind: 'run', id: record.taskId } as const;
          if (
            await core.eventHistoryInstance.wasRecorded(
              owner,
              SCHEDULE_FIRE_SETTLED_EVENT_KIND,
              scheduleFireSettledDedupeKey(record.taskId),
            )
          ) {
            continue;
          }
          try {
            await peers.appendFireSettledEvent(record);
          } catch (error) {
            diagnose({
              level: 'error',
              scope: 'task-registry',
              message: `[bureau] Could not record in the history how schedule fire "${record.taskId}" ended: ${serializeUnknownError(error)}`,
              cause: error,
            });
          }
        }
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'recovery',
          message: `[bureau] Could not announce the ends of settled schedule fires at boot: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
    }
    // COR-1622: the open closes of every canceled fire, settled or not.
    await peers.retryCanceledFireCloses().catch((error: unknown) => {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Could not retry the closes of canceled schedule fires at boot: ${serializeUnknownError(error)}`,
        cause: error,
      });
    });
    // A durable catalog run still in flight whose task record was never written: the lost
    // admission window. A run that is over is not given a record here: its task either was
    // settled and has since been removed by retention, or never existed, and recreating it at
    // every boot would resurrect expired tasks, message text included. The record is dated
    // from the durable run, and the run settles it through the catalog settlement hook.
    // COR-1868: a child run, a goal attempt and a workflow step are listed too, so no id prefix
    // narrows the list; the claim says what each one is.
    for (let offset = 0; ;) {
      const page = await durable.engine.list({
        type: 'agentRun',
        status: ['pending', 'running', 'suspended'],
        limit: 100,
        offset,
      });
      for (const summary of page.items) {
        if ((await core.tasks.record(summary.id)) !== undefined) continue;
        const loaded = await runtime.loadCatalogRunRecoveryRecord(summary.id);
        const createdAt = new Date(summary.createdAt).toISOString();
        if (loaded.status === 'found' && loaded.record.taskOrigin !== undefined) {
          // The claim stores the origin the run's start recorded: the task is rebuilt from it.
          await core.tasks.recordAdmission(
            subordinateTaskAdmission(
              summary.id,
              { ...loaded.record, taskOrigin: loaded.record.taskOrigin },
              { ownerOf: ownerOrLocal, originatingMessage: originatingMessageText, createdAt },
            ),
          );
          continue;
        }
        // A run claimed before COR-1868 is classified as it always was: only a top-level
        // `bureau.run()` run is a task.
        if (!summary.id.startsWith('agent-run-')) continue;
        if (await peers.isChildRun(summary.id)) continue;
        if (
          loaded.status !== 'found' ||
          loaded.record.goalAttempt !== undefined ||
          loaded.record.workflowStep !== undefined
        ) {
          continue;
        }
        await core.tasks.recordAdmission({
          taskId: summary.id,
          contextId: loaded.record.contextId ?? summary.id,
          incarnation: '',
          agentName: loaded.record.agentName,
          owner: ownerOrLocal(loaded.record.principal),
          // The run's original start is gone with its record: nothing names a surface for it.
          origin: { kind: 'api' },
          message: originatingMessageText(loaded.record.input),
          createdAt,
        });
      }
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
  }

  /**
   * Boot-single-shot: called at most once per bureau, either immediately
   * during `createBureau()` or once from the deferred-authority-validator
   * path (never both — `durableRecoveryStarted` guards it). Resolves a
   * {@link BureauRecoveryReport} aggregating this one pass's outcome; never
   * rejects (AB-242's decision record — recovery failure stays diagnostic,
   * `createBureau()` never rejects on it, in whole or in part).
   */
  async function recoverDurableRuns(): Promise<BureauRecoveryReport> {
    // COR-1421 — retain every live frame for the first subscriber while the
    // pass runs.
    core.recoveryPassActive = true;
    try {
      const report = await recoverDurableRunsPass();
      await reconcileTaskRecords().catch((error: unknown) => {
        diagnose({
          level: 'error',
          scope: 'recovery',
          message: `[bureau] Could not reconcile task records at boot: ${serializeUnknownError(error)}`,
          cause: error,
        });
      });
      // COR-1669: a task whose settlement was written but whose event never was. Not awaited, so
      // the boot takes no extra turn; held in `taskResyncBootPass`, which `shutdown()` awaits
      // before storage closes.
      const repaired = core.taskResyncInstance?.repairAll().then(
        () => undefined,
        (error: unknown) => {
          diagnose({
            level: 'error',
            scope: 'recovery',
            message: `[bureau] Could not repair task histories at boot: ${serializeUnknownError(error)}`,
            cause: error,
          });
        },
      );
      if (repaired !== undefined) {
        core.taskResyncBootPass = Promise.all([core.taskResyncBootPass, repaired]).then(
          () => undefined,
        );
      }
      // COR-1945: a failed run whose process died after its settlement committed and before its
      // notification was written, or whose notification write failed, still has its outbox entry.
      // Held in the same boot pass, so the boot takes no extra turn and `shutdown()` waits for it.
      const notificationsRepaired = core.notificationsComposition.repair().then(
        () => undefined,
        (error: unknown) => {
          diagnose({
            level: 'error',
            scope: 'recovery',
            message: `[bureau] Could not repair the owed notifications at boot: ${serializeUnknownError(error)}`,
            cause: error,
          });
        },
      );
      core.taskResyncBootPass = Promise.all([core.taskResyncBootPass, notificationsRepaired]).then(
        () => undefined,
      );
      return report;
    } finally {
      core.recoveryPassActive = false;
    }
  }

  /**
   * Boot-time recovery for durable runs (seams #2, #3/#5b, #5). Resumes any
   * `agentRun` workflows a previous process left in flight via
   * `engine.recoverAll()`. Interactive bureau-owned runs reattach as live
   * `ActiveRun`s; native scheduled fires stay monitor-only because they have no
   * interactive session ownership or live run surface.
   *
   * #2 — no side table. Each recovered run's owning session is read from the
   * handle's own launch metadata (`handle.getLaunchMetadata().input.sessionId`,
   * which the run carried in its durable input), not from a pre-built
   * runId→sessionId scan of the session store. The deps a recovered run needs are
   * re-provided lazily by the engine's `resolveWorkflowServices` resolver
   * (`resolveRunServices`) before its generator advances — no pre-injection, no
   * module-global registry.
   *
   * #3/#5b — live visibility. Weft's awaited `onRecoveredWorkflow` hook wraps
   * each owned handle in a {@link reattachRecoveredRun} adapter and registers it
   * before resumed user code advances, so per-step events, live subscribers, and
   * terminal session persistence all share the same recovered event surface.
   *
   * Boot returns once `recoverAll()` has STARTED the handles and they are
   * registered, not when they complete: a recovered run that resumes into a long
   * model call must not hold the bureau hostage. Each adapter awaits its result
   * detached.
   *
   * Fail-safe: a run whose deps the resolver cannot rebuild is failed terminally
   * by the engine BEFORE replay (the resolver reconciles its session to `error`
   * synchronously, with the sessionId in hand); its reattached handle then rejects
   * and the adapter stays write-free, so the resolver's status is authoritative.
   * A scheduled fire whose launch metadata narrows to a marker-bearing
   * `ScheduledAgentRunInput` is not cancelled for lacking `runId` / `sessionId`
   * ownership. Its services are rebuilt by `resolveRunServices`'s scheduled
   * branch, and its scheduled session write-back hook owns transcript persistence.
   * Recovery attaches only a detached result monitor so failures are visible.
   *
   * A non-scheduled run whose launch metadata lacks a `sessionId` (checkpointed
   * before #2, or not bureau-owned) is skipped — there is no compatibility
   * fallback for cross-upgrade in-flight runs.
   *
   * KNOWN SEAM — durable scheduler runs (#7b) are NOT cross-process recoverable.
   * A durable scheduler task (durable scheduler enabled) runs as an `agentRun`
   * workflow in this SAME engine with `sessionId === runId` (a synthetic
   * `scheduler-run-…` id), and the durable run path does NOT write a session
   * record (only the bureau's interactive `runDurable` path persists sessions).
   * So if the process crashes with a scheduler run in flight, `recoverAll()`
   * surfaces it here, but `resolveRunServices` finds no session for its synthetic
   * id → returns `unavailable` → the engine fails it clean before replay. The
   * reattached handle then rejects and the adapter stays write-free. Net: scheduler
   * durable runs are SAME-PROCESS suspend/resume only (their value — preemption
   * preserves progress within a live process); they surface briefly on recovery
   * and fail clean rather than resuming. This is intentional, not a gap:
   * cross-process recovery of scheduler tasks would require persisting a session
   * per task, which the in-process scheduler deliberately does not do.
   */
  async function recoverDurableRunsPass(): Promise<BureauRecoveryReport> {
    // AB-389 — boot recovery drains the session outbox BEFORE anything
    // else in this pass, so a crash between a commit and its own drain
    // (the post-commit trigger never fired, or fired but the process died
    // before the durable write settled) is caught up before this bureau
    // serves reads. `drainOutbox()` is a no-op when there is no
    // session store or no durable event history to drain into, so this
    // runs unconditionally, ahead of the `!runtime.durable` early return
    // below (a kv-only session store with no durable engine still has an
    // outbox — see that function's own doc comment — though with no
    // durable event history to drain into it resolves immediately).
    //
    // Isolated in its own try/catch (Codex P1 review finding, PR #598,
    // "Isolate outbox failures from durable run recovery"), same rationale
    // as the scheduler-residue sweep just below: an outbox failure (a
    // transient session-store outage, say) must be diagnosed loudly, never
    // let it abort this ENTIRE recovery pass — recovery is single-shot, so
    // an unguarded throw here would strand every otherwise-recoverable
    // durable run for the lifetime of this Bureau over an unrelated
    // subsystem's failure.
    try {
      await peers.drainOutbox();
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Session outbox drain failed during boot recovery; durable run recovery continues: ${serializeUnknownError(error)}`,
        cause: error,
      });
    }

    // COR-772 — load every non-terminal child relationship and reopen its
    // signal channel BEFORE Weft resumes any workflow, so a recovered child's
    // re-resolved run options can carry its port. Reconciled below, after
    // `recoverAll()`, and never by starting a workflow.
    try {
      await core.childTopology.prepareRecovery();
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Could not load child relationships for recovery; durable run recovery continues: ${serializeUnknownError(error)}`,
        cause: error,
      });
    }

    if (!runtime.durable) {
      await core.childTopology.reconcileRecovery();
      // A goal's stored record is settled without an engine too: a marked
      // cancellation is committed, and what cannot be read back is reported.
      const goalFailures = dedupeRecoveryPerRunFailures(await peers.recoverGoalsAtBoot());
      return {
        outcome: goalFailures.length > 0 ? 'partial' : 'clean',
        perRunFailures: goalFailures,
        skippedRuns: [],
      };
    }

    const durable = runtime.durable;

    // Sweep suspended scheduler-origin residue FIRST and UNCONDITIONALLY (not
    // gated on a session store): a hard crash with a preempted scheduler task in
    // `suspended` leaves a workflow that recoverAll() never surfaces (suspended ≠
    // running) and that would otherwise dangle forever. A durable-scheduler-only
    // deployment (no bureau session store) still needs this. It also clears
    // suspended runs whose ids could collide with a fresh dispatch's reused
    // counter id — onTerminalConflict:'start-new' does NOT cover suspended (only
    // terminal), so the sweep is the sole protection against that collision.
    //
    // The sweep is isolated in its own try/catch: a sweep failure (its
    // sanity-cap throw, or a storage error) is logged LOUDLY but must NOT block
    // session-run reattach below — a pathological suspended-scheduler backlog
    // should not also strand every genuine session run's recovery. Its message
    // is also captured onto the resolved report's `sweepFailure` — including
    // via `currentRecoverySweepFailure` for the batch-failure path below,
    // where `recoverAll()` throwing before this function can return means the
    // ONLY way this pass's sweep failure reaches the resolved report is
    // through that shared, boot-call-site-read variable.
    let sweepFailure: { message: string } | undefined;
    try {
      const failedCancellations = await peers.sweepSuspendedSchedulerRuns(durable.engine);
      if (failedCancellations > 0) {
        // The sweep itself didn't throw, but real collision-risk residue
        // survived it (each rejection already diagnosed individually inside
        // sweepSuspendedSchedulerRuns) — an outcome of 'clean' would
        // misreport that. See sweepSuspendedSchedulerRuns's own doc comment.
        sweepFailure = {
          message: `${failedCancellations} suspended scheduler run(s) could not be cancelled during the sweep.`,
        };
        core.currentRecoverySweepFailure = sweepFailure;
      }
    } catch (error) {
      sweepFailure = { message: serializeUnknownError(error) };
      core.currentRecoverySweepFailure = sweepFailure;
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Suspended scheduler-run sweep failed; session-run recovery continues: ${serializeUnknownError(error)}`,
      });
    }

    // This pass's own per-run 'cancel' collector — reset here, read back
    // once every handle below has been classified. On the batch-failure path
    // below (`recoverAll()` throwing), this function exits via rejection
    // before it can reset either collector itself — the two boot call
    // sites' `.catch()` handlers reset BOTH `currentRecoveryPerRunFailures`
    // and `currentRecoverySweepFailure` to `undefined` themselves after
    // reading them, so a stale entry from this pass never leaks into a
    // later one.
    core.currentRecoveryPerRunFailures = [];
    core.currentRecoverySkippedRuns = [];

    // recoverAll resumes the in-flight workflows (firing the services resolver per
    // run before each generator advances); if it throws, NO handle was classified
    // at all — a whole-batch failure. This deliberately propagates uncaught (as
    // before AB-349): both boot call sites' own `.catch()` builds the
    // `outcome: 'failed'`/`batchFailure` report from it (folding in
    // `currentRecoverySweepFailure` above, so a sweep failure that happened
    // just before `recoverAll()` threw is never silently dropped) and keeps
    // their existing `onDiagnostic` message unchanged — this function's own
    // diagnostic logging is scoped to failures it can isolate (the sweep,
    // per-handle reads) without losing the caller's identity.
    // AB-241 review finding: everything from here through the post-recovery
    // loop below runs inside a `try` whose `finally` releases
    // `catalogRunRecoveryCache` unconditionally — including when
    // `recoverAll()` itself throws after already populating the cache for
    // one or more successfully-resolved catalog workflows (each resolved
    // via `onRecoveredWorkflow`'s services resolver, BEFORE the throw). The
    // earlier plain end-of-function call left those entries in the cache
    // for the rest of this process's lifetime whenever the batch-failure
    // path below was taken; `finally` runs on both the normal-return and
    // rejection paths, so no failure mode leaks them. The rejection itself
    // is still deliberately allowed to propagate uncaught afterward — the
    // batch-failure handling this doc comment describes further up is
    // unchanged.
    // COR-1583 — a stored run whose workflow type this Bureau has not registered must not stop the
    // rest of the store recovering: the engine's default refuses the whole batch, on every boot,
    // for as long as that one run exists. `acknowledgeUnknownWorkflowTypes` has it leave each such
    // run untouched in storage, with no claim taken, and report it, so a later boot that has
    // registered the type recovers it. Every skipped run is diagnosed and listed in the report.
    const onRecoverySkipped = (event: { workflowId: string; workflowType: string }): void => {
      core.currentRecoverySkippedRuns?.push({ runId: event.workflowId, type: event.workflowType });
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message: `[bureau] Left run "${event.workflowId}" of workflow type "${event.workflowType}" as it is: the type is not registered, so it will be recovered by a boot that registers it.`,
      });
    };
    durable.engine.addEventListener(WorkflowRecoverySkippedEvent.type, onRecoverySkipped);
    try {
      recoveredWorkflowHandler.resolve(peers.onRecoveredWorkflow);
      const handles = await durable.engine.recoverAll({
        onRecoveredWorkflow: peers.onRecoveredWorkflow,
        acknowledgeUnknownWorkflowTypes: true,
      });

      // Read each handle's launch metadata CONCURRENTLY, so one slow/stuck read does
      // not block registration of the rest (no head-of-line blocking). The read is
      // caught PER HANDLE so the resolved value always carries the handle identity —
      // a rejected read must not lose the handle, or we could not cancel the
      // now-resumed-but-unidentifiable run (committee round-2 finding 1). Then
      // reattach each owned handle SYNCHRONOUSLY in one turn, preserving the
      // register-before-terminal-event ordering invariant.
      const resolved = await Promise.all(
        handles.map(async (handle) => {
          try {
            return { handle, metadata: await handle.getLaunchMetadata() };
          } catch (error) {
            return { handle, metadata: null, error };
          }
        }),
      );

      const orphanCancellations: Array<{ runId: string; cancel: Promise<void> }> = [];
      // COR-297 — the cancels of runs prepared and never launched, which the task reconciliation
      // after this pass must see terminal: nothing else settles those runs' tasks.
      const preparedCancellations: Promise<void>[] = [];
      // COR-297 — what a recovered record's state says about Weft's two-phase start. Weft recovers
      // a `pending` record without resuming it. It is crash residue only when no other process
      // holds a live claim on it: under `workflow-lease` ownership the process that prepared it may
      // still be running the start hook. A read that fails is diagnosed and reported as unknown.
      const preparedState = async (
        runId: string,
      ): Promise<'never-launched' | 'preparing-elsewhere' | 'not-pending' | 'unknown'> => {
        try {
          const record = await durable.engine.get(runId);
          if (record?.status !== 'pending') return 'not-pending';
          const claim = await durable.engine.claimHolder(runId);
          return claim?.heldByAnyProcess === true && !claim.heldByThisProcess
            ? 'preparing-elsewhere'
            : 'never-launched';
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'recovery',
            message: `[bureau] Could not read the durable record of recovered run "${runId}"; classifying it without its status: ${serializeUnknownError(error)}`,
            cause: error,
          });
          return 'unknown';
        }
      };
      const cancelNeverLaunched = (runId: string, cancel: Promise<void>): void => {
        orphanCancellations.push({ runId, cancel });
        preparedCancellations.push(cancel.catch(() => undefined));
      };
      const sessionStore = runtime.sessionStore;
      for (const { handle, metadata, ...rest } of resolved) {
        // The awaited recovery hook already registered owned interactive runs
        // before replay. The post-recovery pass only classifies the remaining
        // handles (scheduled fires, orphans, and unknown ownership).
        if (store.getRun(handle.id)) continue;

        // AB-240: the awaited recovery hook (`onRecoveredWorkflow`) already
        // routed a catalog-dispatched run to its own headless monitor above —
        // skip it here too, the same way an already-registered interactive
        // run is skipped, so it is never re-classified by the session-ownership
        // logic below (which would treat its absent session as "orphaned" and
        // cancel it).
        if (await runtime.isCatalogRecoveredRun(handle.id)) {
          // COR-297 — a catalog run prepared and never launched has no monitor (Weft calls no
          // recovery hook for a `pending` record), so it is cancelled here and its task settles
          // with the reconciliation after this pass.
          if ((await preparedState(handle.id)) === 'never-launched') {
            peers.dispatchRecoveryClassification(handle.id, {
              verdict: 'cancel',
              rejection: 'prepared-not-launched',
            });
            cancelNeverLaunched(
              handle.id,
              durable.engine.cancel(handle.id).then(() => undefined),
            );
          }
          continue;
        }

        // COR-851: a goal's controller workflow carries `{ goalRunId }`, not an
        // agent run's input, so the classification below would read it as a
        // foreign run and cancel it. The goal control plane recovers it instead
        // (`goals.recover`, below), by what the goal's own record says.
        if (await core.goalsComposition.ownsWorkflow(handle.id)) continue;

        // COR-1527: an instance of a workflow file carries a document's trigger, not an agent
        // run's input, so the classification below would read it as a foreign run and cancel it.
        // The workflow runtime registered its revision before this recovery; the engine resumes it.
        // COR-2009: a schedule tick carries what it records, and is the Bureau's own; the engine
        // resumes it too. Its id says what it is, so this costs no read.
        if (isScheduleTickRunId(handle.id)) continue;
        if (core.workflowRuntime !== undefined) {
          const instance = await durable.engine.get(handle.id);
          if (instance !== null && (await core.workflowRuntime.isWorkflowType(instance.type)))
            continue;
        }

        const readError = 'error' in rest ? rest.error : undefined;
        if (readError !== undefined) {
          diagnose({
            level: 'error',
            scope: 'recovery',
            message: `[bureau] Could not read launch metadata for recovered run "${handle.id}"; cancelling: ${serializeUnknownError(readError)}`,
          });
        }

        // A run is bureau-owned only if its launch metadata narrows to an agentRun
        // input AND its input runId matches this handle's id (the workflow id is the
        // run id).
        const ownedSessionId =
          readError === undefined &&
          metadata &&
          isAgentRunWorkflowInput(metadata.input) &&
          metadata.input.runId === handle.id
            ? metadata.input.sessionId
            : undefined;

        const recoveredScheduleMarker =
          readError === undefined &&
          metadata != null &&
          !isAgentRunWorkflowInput(metadata.input) &&
          isScheduledAgentRunInput(metadata.input) &&
          !isRecoverableScheduledFireInput(metadata.input)
            ? await loadScheduleIdForRecoveredRun(durable.engine, handle.id)
            : undefined;
        let recoveredScheduledSessionId: string | undefined;
        if (
          recoveredScheduleMarker !== undefined &&
          recoveredScheduleMarker.status !== 'found' &&
          sessionStore &&
          metadata != null &&
          isScheduledAgentRunInput(metadata.input)
        ) {
          try {
            recoveredScheduledSessionId = await loadExistingScheduledSessionId(
              sessionStore,
              metadata.input,
              handle.id,
            );
          } catch (error) {
            diagnose({
              level: 'error',
              scope: 'recovery',
              message: `[bureau] Could not inspect scheduled session proof for recovered run "${handle.id}"; continuing without scheduled-fire classification: ${serializeUnknownError(error)}`,
            });
          }
        }
        const scheduledFire =
          readError === undefined &&
          metadata != null &&
          !isAgentRunWorkflowInput(metadata.input) &&
          (isRecoverableScheduledFireInput(metadata.input) ||
            recoveredScheduleMarker?.status === 'found' ||
            recoveredScheduledSessionId !== undefined);

        // Load the owning session (only meaningful for an owned run with a store).
        // A throw leaves ownership UNKNOWN — classifyRecoveredRun then skips rather
        // than cancels, so a transient read blip never terminates a legitimately
        // recovering run.
        let sessionLoad: SessionLoadOutcome = { ok: true, session: null };
        // The incarnation this run was classified against: a later load
        // that finds another one is a session recreated meanwhile.
        let classifiedIncarnation: string | undefined;
        if (ownedSessionId !== undefined && sessionStore) {
          try {
            const session = await sessionStore.load(ownedSessionId);
            classifiedIncarnation = session?.incarnation;
            sessionLoad = { ok: true, session: session ? { ...session.metadata } : null };
          } catch (error) {
            diagnose({
              level: 'error',
              scope: 'recovery',
              message: `[bureau] Could not load owning session for recovered run "${handle.id}"; leaving it to resume without live visibility: ${serializeUnknownError(error)}`,
            });
            sessionLoad = { ok: false };
          }
        }

        const classificationArgs: ClassifyRecoveredRunArgs = {
          handleId: handle.id,
          scheduledFire,
          ownedSessionId,
          metadataReadFailed: readError !== undefined,
          hasSessionStore: sessionStore !== undefined,
          sessionLoad,
          versionMismatch: runtime.workflowVersionMismatches.has(handle.id),
        };
        let classification = classifyRecoveredRunDetailed(classificationArgs);
        // COR-297 — a run that would reattach may be a record its process prepared and never
        // launched: reattaching it would leave a run whose result never settles. Its state is read
        // only here, for a would-be reattach; one another live process is still preparing is left
        // to it, and a read that fails leaves the verdict as it was.
        if (
          classification.verdict === 'reattach' ||
          classification.verdict === 'reattach-version-mismatch'
        ) {
          const prepared = await preparedState(handle.id);
          if (prepared === 'never-launched') {
            classification = classifyRecoveredRunDetailed({
              ...classificationArgs,
              engineRecordStatus: 'pending',
            });
          } else if (prepared === 'preparing-elsewhere') {
            classification = { verdict: 'skip' };
          }
        }
        if (classification.rejection === 'session-not-running') {
          classification = await peers.skipRunFinishedByPeer(
            handle.id,
            classificationArgs,
            classification,
          );
        }
        // The session says the run is running, and no later boot could repair that once the record
        // is cancelled, so it is settled first; the cancel is issued whether or not this write
        // lands, and a cancel that fails leaves the next boot a `session-not-running` run to cancel.
        if (
          classification.rejection === 'prepared-not-launched' &&
          sessionStore &&
          ownedSessionId !== undefined
        ) {
          try {
            // Fenced to the incarnation that was classified and to this run still being its running
            // one: another process may have started a run on the session, or recreated it, since.
            await sessionStore.update(ownedSessionId, (session) =>
              session !== undefined &&
              session.incarnation === classifiedIncarnation &&
              session.metadata['lastRunId'] === handle.id &&
              session.metadata['lastRunStatus'] === 'running'
                ? {
                    ...session,
                    metadata: {
                      ...session.metadata,
                      lastRunStatus: 'aborted',
                      lastFinishReason: 'aborted',
                      lastError: `Run "${handle.id}" was prepared but never launched before its process stopped.`,
                    },
                  }
                : undefined,
            );
          } catch (error) {
            diagnose({
              level: 'error',
              scope: 'session-persistence',
              message: `[bureau] Failed to settle the session of never-launched run "${handle.id}" (session ${ownedSessionId}): ${serializeUnknownError(error)}`,
              cause: error,
            });
          }
        }
        const { verdict } = classification;
        peers.dispatchRecoveryClassification(handle.id, classification);
        peers.dispatchRecoveryLeaseReleasedIfAny(handle.id);

        if (verdict === 'reattach' || verdict === 'reattach-version-mismatch') {
          if (verdict === 'reattach-version-mismatch') {
            diagnose({
              level: 'warn',
              scope: 'recovery',
              message:
                `[bureau] Reattaching recovered run "${handle.id}" that resumed under a ` +
                `different workflow version than it was checkpointed with (pin-and-warn; ` +
                `see documentation/workflow-versioning.md).`,
            });
          }
          // A mocked/custom engine that does not invoke Weft's recovery hook can
          // still reattach terminal visibility here. Real Weft recovery has
          // already taken the hook path above, including live event forwarding.
          let recoveredServices: DurableRunDeps | undefined;
          let recoveredSession: AgentSession | undefined;
          if (sessionStore && ownedSessionId) {
            const fullSession = await sessionStore.load(ownedSessionId);
            recoveredSession = fullSession;
            if (fullSession) {
              const recoveredAgentName = isAgentRunWorkflowInput(metadata?.input)
                ? metadata.input.agentName
                : BUREAU_AGENT_NAME;
              const requestContext = recoveredRequestContextFromMetadata(
                fullSession.metadata,
                handle.id,
                ownedSessionId,
                recoveredAgentName,
                runtimeServices.clock.now,
              );
              const reattachedSessionAgent = await peers.resolveRecoveredSessionAgent(
                recoveredAgentName,
                handle.id,
                fullSession.metadata,
                ownedSessionId,
              );
              if (reattachedSessionAgent !== 'unavailable') {
                const runRuntime = await runtime.createRunRuntime(
                  {
                    message:
                      typeof fullSession.metadata['lastUserMessage'] === 'string'
                        ? fullSession.metadata['lastUserMessage']
                        : '',
                    sessionId: ownedSessionId,
                    runId: handle.id,
                    agentName: recoveredAgentName,
                    requestContext,
                  },
                  {
                    sessionAgent: reattachedSessionAgent,
                    sessionMetadata: fullSession.metadata,
                    memoryOwner: resolveRunMemoryOwner(fullSession.metadata, handle.id),
                  },
                );
                recoveredServices = {
                  toolbox: runRuntime.toolbox,
                  getStepMetadata: emptyRecoveredStepMetadata,
                  options: {
                    generate: runRuntime.generate,
                    toolbox: runRuntime.toolbox,
                    conversation: new Conversation(fullSession.conversationHistory),
                    // COR-2106 — children this run dispatches carry Bureau's tier.
                    ...bureauInvariantsField(runtime.bureauChildInvariants),
                    ...copyAgentOwnedRunOptions(reattachedSessionAgent?.options),
                    ...sessionRunMediaOptions(
                      reattachedSessionAgent,
                      runtime.mediaOptionsFor(resolveSessionOwner(fullSession.metadata), 'session'),
                    ),
                    // AB-260: the bureau's single composed RuntimeServices
                    // instance, snapshotted into every run it starts — including
                    // a mocked/custom-engine reattach.
                    onToolResultTaint: runRuntime.onToolResultTaint,
                    runtime: runtimeServices,
                    sessionId: ownedSessionId,
                    // COR-1265 — the Bureau tier, snapshotted.
                    hooks: runtime.composeRunHooks({
                      bureau: runRuntime.hooks,
                      agent: reattachedSessionAgent?.options.hooks,
                    }),
                    executeOptions: sessionExecuteOptions(
                      reattachedSessionAgent?.options,
                      requestContext,
                    ),
                    agentName: recoveredAgentName,
                    runId: handle.id,
                  },
                };
              }
            }
          }
          if (recoveredServices) {
            const fullSession = await sessionStore?.load(ownedSessionId!);
            await peers.restorePendingApprovalStates(
              recoveredServices.toolbox,
              fullSession?.metadata,
              handle.id,
              ownedSessionId!,
            );
          }
          // Steered and fenced like the primary path: its log folded into the
          // session's gate, so its end is logged, and its terminal save bound
          // to the incarnation it was recovered against. The engine has
          // already resumed it, so a log that cannot be folded is reported
          // (by `recoverRunSteering`) rather than failing the run.
          let fallbackSteeringGate: BureauSteeringGate | undefined;
          if (
            recoveredServices !== undefined &&
            recoveredSession !== undefined &&
            recoveredSession.incarnation === classifiedIncarnation
          ) {
            try {
              fallbackSteeringGate = await peers.recoverRunSteering(
                ownedSessionId!,
                recoveredSession,
                handle.id,
                recoveredServices,
              );
            } catch {
              fallbackSteeringGate = undefined;
            }
          }
          if (recoveredServices !== undefined) {
            // The incarnation `reattachRecoveredRun` records for the run
            // below, read here before it has.
            await peers.attachRecoveredSessionInput(
              ownedSessionId!,
              handle.id,
              recoveredServices,
              classifiedIncarnation,
            );
          }
          peers.reattachRecoveredRun(
            handle.id,
            ownedSessionId!,
            handle,
            undefined,
            recoveredServices,
            sessionLoad.ok ? sessionLoad.session : null,
            fallbackSteeringGate,
            // Fenced to the classified incarnation even when the session was
            // recreated since: the old run then saves into nothing.
            classifiedIncarnation,
          );
          // AB-336 — same reconstruction as the primary reattach path above
          // (`onRecoveredWorkflow`); this post-recovery classification pass
          // reattaches runs whose live services were rebuilt from config
          // rather than captured before the crash, but the checkpoint gap
          // this closes is identical either way.
          await peers.reconstructHumanWaitReviewIfParked(handle.id);
        } else if (verdict === 'monitor') {
          // Scheduled fires have no ActiveRun surface, but the recovered Weft handle
          // still needs a detached result monitor so failures are visible.
          void monitorRecoveredScheduledFire(handle, diagnose);
        } else {
          if (verdict === 'cancel') {
            // Collect the cancel (do NOT fire-and-forget swallow): a rejected cancel
            // could leave an unowned, already-resumed run live with no monitor, so
            // its failure must be surfaced for operators. engine.cancel terminalizes
            // the run and rejects its waiter — covering metadata-less / read-failed /
            // foreign-input / orphaned-session residue without store.register'ing it.
            const cancel = durable.engine.cancel(handle.id).then(async () => {
              // COR-1476 — a cancelled run owes its session's input the same
              // settlement as one that ended on its own.
              if (ownedSessionId !== undefined) {
                await peers.settleSessionInputsAfterRunEnd(ownedSessionId, handle.id);
              }
              return undefined;
            });
            if (classification.rejection === 'prepared-not-launched') {
              cancelNeverLaunched(handle.id, cancel);
            } else {
              orphanCancellations.push({ runId: handle.id, cancel });
            }
          }
          // 'skip' — ownership unknown; leave the run to resume without live visibility.
        }
      }

      // Await the orphan cancels DETACHED — boot must not block on them (same as the
      // recovered-run monitors), but a cancel that REJECTS leaves an unowned run
      // running, which is an operator-actionable failure, not something to swallow.
      if (orphanCancellations.length > 0) {
        void Promise.allSettled(orphanCancellations.map(({ cancel }) => cancel)).then(
          (outcomes) => {
            outcomes.forEach((outcome, index) => {
              if (outcome.status === 'rejected') {
                diagnose({
                  level: 'error',
                  scope: 'recovery',
                  message: `[bureau] Failed to cancel unowned recovered run "${orphanCancellations[index]!.runId}" — it may still be running: ${serializeUnknownError(outcome.reason)}`,
                });
              }
            });
            return undefined;
          },
        );
      }
      // Cancelling a record that never launched is a single write, so boot waits for these. Only
      // when there are any: a reattached run starts at once, and an extra turn here would hold
      // `createBureau()` back while it runs.
      if (preparedCancellations.length > 0) await Promise.all(preparedCancellations);
    } finally {
      durable.engine.removeEventListener(WorkflowRecoverySkippedEvent.type, onRecoverySkipped);
      // AB-241 review finding: the post-recovery loop above is the LAST
      // consumer of `catalogRunRecoveryCache` for this boot pass (the
      // awaited `onRecoveredWorkflow` hook, invoked earlier during
      // `recoverAll()` above, was the first) — release every entry now
      // rather than let them persist for the rest of this process's
      // lifetime. `finally` also covers `recoverAll()` itself throwing
      // after populating one or more entries, which the surrounding `try`
      // exists to catch. Safe to run before the detached orphan-cancel
      // promises above settle: none of them touch this cache.
      runtime.clearCatalogRunRecoveryCache();
      // COR-772 — reconciled even when `recoverAll()` itself threw: the
      // engine's durable state is still readable, and a child left
      // unreconciled would have no observer for the life of this process.
      // `reconcileRecovery()` diagnoses each child's failure itself and
      // never rejects, so it cannot mask the error this `finally` follows.
      await core.childTopology.reconcileRecovery();
      // COR-851 — every unfinished goal, now that its controller and its
      // attempt's run have both been resumed by `recoverAll()` above. Recovery
      // reports what it could not do rather than throwing.
      core.currentRecoveryPerRunFailures?.push(...(await peers.recoverGoalsAtBoot()));
    }

    // COR-1934 — a deleted chat whose content purge a crash or a failure stopped.
    try {
      await core.chatContentPurge.sweep();
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Boot recovery could not finish the pending content purges of deleted chats: ${serializeUnknownError(error)}`,
        cause: error,
      });
    }

    // COR-1476 — recovered runs are reattached and visible as live now, so
    // input left open with no run at all (a process that died between a run's
    // end and its settlement) is cancelled, and the rest waits for its run.
    try {
      await core.sessionInputSettlement?.sweep();
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Boot recovery could not sweep the pending session input: ${serializeUnknownError(error)}`,
        cause: error,
      });
    }

    const perRunFailures = dedupeRecoveryPerRunFailures(core.currentRecoveryPerRunFailures ?? []);
    const skippedRuns = core.currentRecoverySkippedRuns ?? [];
    core.currentRecoveryPerRunFailures = undefined;
    core.currentRecoverySweepFailure = undefined;
    core.currentRecoverySkippedRuns = undefined;
    const outcome: BureauRecoveryReport['outcome'] =
      sweepFailure || perRunFailures.length > 0 || skippedRuns.length > 0 ? 'partial' : 'clean';
    return {
      outcome,
      ...(sweepFailure ? { sweepFailure } : {}),
      perRunFailures,
      skippedRuns,
    };
  }

  return { recoverDurableRuns };
}
