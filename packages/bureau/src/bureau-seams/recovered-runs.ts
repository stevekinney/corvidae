/**
 * Recovered runs (COR-2376 slice S8): reattach a run recovered at boot to the live registries, rebuild
 * the review of a run parked on a human wait, classify and dispatch each recovered run, sweep the
 * suspended scheduler runs a crash left behind, and write a settled schedule fire into its history.
 * Built by `constructBureau` and reached only through `createBureau`; durable recovery, the
 * scheduled-fire wiring and the review seams call into it.
 */
import {
  type ActiveRun,
  type AgentSession,
  type DurableRunDeps,
  HumanWaitParkedEvent,
  type JSONValue,
  type RecoveredRunHandle,
  type CleanupAcknowledgement as RunCleanupAcknowledgement,
  SCHEDULER_RUN_ID_PREFIX,
  SteeringAppliedEvent,
  type StepRecord,
  createRecoveredRunEventSurface,
  createRunFinishedFrame,
  isAgentRunWorkflowInput,
  isFailureFinishReason,
  reattachDurableActiveRun,
  runScopedExecutionContextOf,
} from '@lostgradient/operative';
import type { AgentDefinitions } from '../agent-catalog';
import {
  BUREAU_AGENT_NAME,
  SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS,
  detachBestEffortPromise,
} from '../bureau-construction-support';
import type { BureauCore, ChatRunSpend } from './core';
import type { BureauSteeringGate } from '../steering';
import type { BureauToolbox } from '../runtime-composition';
import {
  type ClassifyRecoveredRunArgs,
  RECOVERED_RUN_TERMINAL_STATUSES,
  type SessionLoadOutcome,
  classifyRecoveredRunDetailed,
  monitorRecoveredCatalogRun,
} from '../recovered-run-classification';
import type { Conversation, ConversationHistory } from 'conversationalist';
import type { DurableEndReader } from '../catalog-run-settlement';
import { RECOVERY_ACTOR, ownerOrLocal } from '../owner-of-record';
import {
  type RecoveredRunVerdict,
  RecoveryAttemptedEvent,
  RecoveryLeaseReleasedEvent,
  RecoveryRejectedEvent,
  type RecoveryRejectionReason,
} from '../events';
import type { RecoveredWorkflowInfo } from '@lostgradient/weft';
import {
  SCHEDULE_FIRE_SETTLED_EVENT_KIND,
  type ScheduleFireSettledPayload,
  scheduleFireSettledDedupeKey,
} from '../schedule-fire-settled-event';
import type { ServerFrame } from '../types';
import type { SteeringLogEvent } from '../steering-log';
import type { TaskRecord } from '../task-registry';
import { attachRunEventFeed } from '../run-event-feed-attachment.ts';
import {
  buildTerminalReportFromAbortedEvent,
  buildTerminalReportFromCompletedEvent,
  createRunFrameForwarder,
} from '../run-envelope';
import {
  countCheckpointParks,
  humanWaitParkOrdinal as sharedHumanWaitParkOrdinal,
} from '../park-ordinals';
import { leaseEvidenceFromLostHealth } from '../liveness-projection';
import { recoveryEntryFailure } from '../goal-recovery';
import { resolvePersistedRunOwningPrincipal } from '../session-authority';
import { serializeUnknownError } from '../serialization';

/** The callables recovered runs reads from elsewhere in `constructBureau`. */
export interface RecoveredRunsPeers {
  /** Logs the steering of a run boundary. */
  readonly logRunBoundarySteering: (
    sessionId: string,
    gate: BureauSteeringGate,
    event: Extract<SteeringLogEvent, { type: 'applied' | 'run-ended' }>,
  ) => void;
  /** Polls a session steering log. */
  readonly pollSessionSteering: (sessionId: string, incarnation: string, runId: string) => void;
  /** Recovers a run steering gate. */
  readonly recoverRunSteering: (
    sessionId: string,
    session: AgentSession | undefined,
    runId: string,
    services: DurableRunDeps,
  ) => Promise<BureauSteeringGate | undefined>;
  /** Settles an abandoned run. */
  readonly settleAbandonedRun: (sessionId: string, runId: string, activeRun: ActiveRun) => void;
  /** Abandons a terminal session record. */
  readonly abandonTerminalSessionRecord: (runId: string) => void;
  /** Expects a terminal session record. */
  readonly expectTerminalSessionRecord: (runId: string) => void;
  /** Persists a terminal session. */
  readonly persistTerminalSession: (
    saveSessionUpdate: () => Promise<unknown>,
    context: {
      runId: string;
      sessionId: string;
      status: 'completed' | 'error' | 'aborted';
      /** What the run spent, for the chat's ledger (COR-1915); written before the session's save. */
      spend?: ChatRunSpend;
    },
  ) => void;
  /** Saves a run terminal session. */
  readonly saveRunTerminalSession: (
    runId: string,
    sessionId: string,
    conversation: Conversation,
    metadata: Record<string, JSONValue>,
    agentName?: string,
    baseConversationHistory?: ConversationHistory,
  ) => Promise<AgentSession | undefined>;
  /** Restores resolved review ids. */
  readonly restoreResolvedReviewIds: (metadata: unknown, runId: string) => void;
  /** Restores pending approval overrides. */
  readonly restorePendingApprovalOverrides: (
    metadata: unknown,
    runId: string,
    committed?: ReadonlySet<string>,
  ) => void;
  /** Restores pending approval states. */
  readonly restorePendingApprovalStates: (
    toolbox: BureauToolbox,
    metadata: unknown,
    runId: string,
    sessionId: string,
    committed?: ReadonlySet<string>,
  ) => Promise<void>;
  /** Emits a live frame. */
  readonly emitLiveFrame: (frame: ServerFrame) => void;
  /** Seeds a run sequence generation. */
  readonly seedRunSeqGeneration: (runId: string) => void;
  /** Durable terminal cleanup. */
  readonly durableTerminalCleanup: () =>
    ((runId: string) => Promise<RunCleanupAcknowledgement>) | undefined;
  /** Terminal checkpoint cleanup. */
  readonly runTerminalCheckpointCleanup: (runId: string) => Promise<RunCleanupAcknowledgement>;
  /** Catalog durable end. */
  readonly catalogDurableEnd: DurableEndReader;
  /** Attaches a recovered session input. */
  readonly attachRecoveredSessionInput: (
    sessionId: string,
    runId: string,
    services: DurableRunDeps,
    incarnation: string | undefined,
  ) => Promise<void>;
}

/** Builds the recovered-run functions of one Bureau. Synchronous, and registers nothing. */
export function createRecoveredRuns<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: RecoveredRunsPeers,
) {
  const {
    runtimeServices,
    store,
    emitter,
    runEventFeeds,
    runSessionIdentifiers,
    runSessionIncarnations,
    runtime,
    diagnose,
    activeRuns,
    recoveredActiveRuns,
    runToolboxesByRunId,
    runScopedContexts,
    runHookPlans,
    runAttribution,
    steeringRunIncarnations,
    runRequestContexts,
    recoveredRunIds,
    bootFrameRunIds,
    sessionPersistenceRetryDelayMilliseconds,
    sessionPersistenceSleep,
    humanWaitParkBaseline,
  } = core;

  /**
   * The 0-based ordinal of the LAST distinct park in a run's action log.
   * `HumanWaitParkedEvent` can be recorded more than once for one park (the
   * tool's execute and the workflow's replay-aware marker, and the
   * reconstruction from a checkpoint, and on a recovered run the marker again
   * after the signal is delivered), so consecutive events on the same signal
   * with no `step.started` between them count once: a genuine re-park always
   * happens inside a later step. A reconstructed
   * park carries its durable ordinal in `detail.parkOrdinal`; otherwise the
   * count continues from the checkpoint's committed parks.
   */
  function humanWaitParkOrdinal(
    runId: string,
    actions: readonly { type: string; detail: unknown }[],
  ): number {
    return sharedHumanWaitParkOrdinal(actions, humanWaitParkBaseline.get(runId) ?? 0);
  }

  /**
   * AB-336 — reconstructs the `human-wait` pending review for a run
   * recovered mid-park.
   *
   * Root cause: `listPendingReviews()`'s human-wait branch derives entirely
   * from the LIVE in-memory action log (`store`'s per-run `actions`,
   * populated only by events an `ActiveRun` actually dispatches — see that
   * function's own doc comment). `store.register()` gives a recovered run a
   * brand-new, EMPTY action log; nothing replays the `HumanWaitParkedEvent`
   * a since-dead process dispatched. So a run genuinely still parked on
   * `ctx.waitForSignal` (the durable park itself is intact — AB-44/AB-45's
   * `stepResult.pendingHumanWait` loop-break and the workflow's own
   * checkpointed park both already work on a fresh dispatch) was invisible
   * to `listPendingReviews()`/`getRun(...).liveness` the moment a process
   * restarted mid-park: the park was never lost from the durable engine,
   * only from bureau's OWN observability surface for it.
   *
   * The fix reads the run's persisted checkpoint (`requestHumanInput`'s tool
   * RESULT — `{ parked: true, signalName, prompt? }` — is written into the
   * checkpointed `StepRecord.results` by the durable workflow's per-step
   * memo, independent of any live event) and, if the LAST persisted step was
   * a still-unconsumed `requestHumanInput` park, synthesizes the same action
   * `store` would have recorded had the live event survived — so
   * `listPendingReviews()` needs no other change to pick it up.
   *
   * Only the LAST step is ever inspected: if the run resumed past its park
   * (signal delivered and consumed, then a further step committed) before
   * THIS crash, the last persisted step is no longer the `requestHumanInput`
   * step and nothing is synthesized — matching the "already resumed" case
   * the live path's own `status === 'running'` guard excludes.
   *
   * Called from inside the AWAITED `onRecoveredWorkflow` hook, strictly
   * before the recovered generator is allowed to advance (see that
   * function), so this checkpoint read races nothing: the checkpoint cannot
   * change out from under it before this resolves.
   */
  async function reconstructHumanWaitReviewIfParked(runId: string): Promise<void> {
    if (!runtime.durable) return;
    let steps: StepRecord[];
    try {
      steps = await runtime.durable.checkpointStore.loadSteps(runId);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message:
          `[bureau] Could not read checkpoint steps for recovered run "${runId}" while ` +
          `reconstructing a human-wait review; it may stay invisible to ` +
          `listPendingReviews() until it next progresses: ${serializeUnknownError(error)}`,
      });
      return;
    }
    const parks = countCheckpointParks(steps);
    // Always seed the baseline so a recovery landing mid-step (last step not a
    // park) still numbers its first live park after every committed one.
    if (steps.length > 0) humanWaitParkBaseline.set(runId, parks.baseline);
    if (parks.outstanding === undefined) return;
    store.recordAction(runId, HumanWaitParkedEvent.type, {
      signalName: parks.outstanding.signalName,
      runId,
      parkOrdinal: parks.outstanding.ordinal,
      ...(parks.outstanding.prompt !== undefined ? { prompt: parks.outstanding.prompt } : {}),
      ...(parks.outstanding.inputSchema !== undefined
        ? { inputSchema: parks.outstanding.inputSchema }
        : {}),
    });
  }

  /**
   * Reattach one run RECOVERED by `engine.recoverAll()` to the live surface
   * (closes seam #5b). Builds a {@link reattachDurableActiveRun} adapter over the
   * already-running handle, wires the SAME terminal session-persistence listeners
   * the live-run path uses (so a recovered run's `getRun(...)` + session status
   * behave exactly like a never-crashed one), and `store.register`s it.
   *
   * Synchronous by construction (no `await` before `store.register`): the adapter
   * defers its `handle.result()` await onto a microtask, so registration +
   * `runSessionIdentifiers.set` complete in this turn BEFORE any terminal event
   * fires — even for a handle that already settled. So `getRun(runId)` resolves
   * the instant this returns and no subscriber misses the terminal event.
   *
   * Idempotent: skips a `runId` already live on this process (the store uses a
   * plain `Map.set`, which would silently overwrite + split-brain a double
   * register). `recoverDurableRuns` is itself boot-single-shot; this is defense.
   */
  function reattachRecoveredRun(
    runId: string,
    sessionId: string,
    handle: RecoveredRunHandle,
    eventSurface?: ReturnType<typeof createRecoveredRunEventSurface>,
    recoveredServices?: DurableRunDeps,
    sessionMetadata?: unknown,
    steeringGate?: BureauSteeringGate,
    // The session incarnation the run was recovered against (the one
    // `steeringGate`, if any, was folded for): its terminal save is fenced to it,
    // against a deletion or an expiry in any process (COR-718).
    sessionIncarnation?: string,
  ): void {
    // At-most-once registration per runId (guards double-recover / a runId already
    // started live on this process — neither should reach here, but a silent
    // Map.set overwrite would be a split-brain, so cheap-guard it).
    if (store.getRun(runId)) {
      return;
    }
    if (!core.liveFramesSubscribed) bootFrameRunIds.add(runId);
    if (sessionIncarnation !== undefined) runSessionIncarnations.set(runId, sessionIncarnation);

    const recoveredRun = reattachDurableActiveRun(
      {
        engine: runtime.durable!.engine,
        checkpointStore: runtime.durable!.checkpointStore,
        // COR-625: same terminal checkpoint-retention step as the live path.
        // A run recovered after a restart still owes its cleanup.
        ...(peers.durableTerminalCleanup()
          ? { terminalCleanup: peers.runTerminalCheckpointCleanup }
          : {}),
      },
      {
        runId,
        handle,
        // COR-1587: only a run whose session is still `running` is reattached here (the hook runs
        // after the resolver provided its services, and the post-recovery pass classifies a run
        // whose session the resolver reconciled to `error` as `cancel`). Nothing has recorded an
        // end for it, so a rejection settles it as `error` instead of being inferred from the
        // engine's state as a failure before replay, which the engine's late read can misread.
        failedBeforeReplay: false,
        ...(eventSurface
          ? {
              emitter: eventSurface.emitter,
              stopToolboxForward: eventSurface.stopToolboxForward,
              admissions: eventSurface.admissions,
              abort: eventSurface.abort,
            }
          : {}),
      },
    );
    if (recoveredServices) {
      const recoveredRequestContext = recoveredServices.options.executeOptions?.requestContext;
      if (recoveredRequestContext) {
        runRequestContexts.set(runId, recoveredRequestContext);
        recoveredRunIds.add(runId);
      }
      runToolboxesByRunId.set(runId, recoveredServices.toolbox);
      const recoveredScope = runScopedExecutionContextOf(recoveredServices.options);
      if (recoveredScope !== undefined) runScopedContexts.set(runId, recoveredScope);
      if (recoveredServices.options.hooks !== undefined) {
        runHookPlans.set(runId, recoveredServices.options.hooks);
      }
    }
    // AB-359 — rehydrate `runAttribution`'s `principal` from the durably
    // persisted `lastRunOwningPrincipals` map so a recovered run's REAL owner
    // can still authorize against `eventHistory` (AB-313) after a process
    // restart wiped the in-memory map. Reading `sessionMetadata` here rather
    // than `recoveredRequestContext.authority.principalId` (which is always
    // populated — see the AB-359 comment at this run's dispatch site) is what
    // keeps the owner the one `createRun` was given. COR-718: a run whose
    // record carries no owner (written before owners existed) reads as
    // `anonymous:local`; it is never left without one.
    const persistedPrincipal =
      sessionMetadata && typeof sessionMetadata === 'object' && !Array.isArray(sessionMetadata)
        ? resolvePersistedRunOwningPrincipal(sessionMetadata as Record<string, JSONValue>, runId)
        : undefined;
    const recoveredOwner = ownerOrLocal(persistedPrincipal);
    // The agent the run was recovered as, so a tool that asks who is calling still hears it.
    const recoveredAgentName = recoveredServices?.options.agentName;
    runAttribution.set(runId, {
      ...runAttribution.get(runId),
      principal: recoveredOwner,
      ...(recoveredAgentName === undefined ? {} : { agentName: recoveredAgentName }),
    });
    // COR-718 — the run keeps its owner; recovery is only the actor. One entry
    // per reattached run on each start.
    detachBestEffortPromise(
      Promise.resolve(
        core.auditTrailInstance?.record({
          runId,
          type: 'run.recovered',
          detail: { sessionId },
          principal: RECOVERY_ACTOR,
        }),
      ),
    );
    peers.restoreResolvedReviewIds(sessionMetadata, runId);
    peers.restorePendingApprovalOverrides(sessionMetadata, runId);

    // AB-96 — wire the same versioned run-envelope forwarder the live-run path
    // uses. The recovered run's event surface is installed during Weft's awaited
    // recovery hook, before resumed user code advances, and `recoveredRun`'s
    // `addEventListener` is bound to that identical emitter — so subscribing
    // here surfaces every `step`/`tool-pre`/`tool-post`/notification frame a
    // resumed run produces, not just its terminal `run-finished`.
    const disposeRecoveredRunFrameForwarder = createRunFrameForwarder(
      runId,
      recoveredRun,
      (frame) => peers.emitLiveFrame({ type: 'run-envelope', runId, frame }),
      // AB-260: same origin-derived clock threading as the live-run forwarder.
      { clock: runtimeServices.clock.now },
    );
    // A recovered run gets a feed too, and it starts without `run.started`:
    // that event fired in the process that died, so this feed's first
    // envelope is whatever step the run resumes into. That is the honest
    // record — this bureau did not start this run — and a client tells the
    // two apart by the run's session status rather than by guessing from
    // the feed's first envelope.
    //
    // Detached alongside the frame forwarder, on whichever terminal event
    // settles this run. Both are registered BEFORE those `once` handlers,
    // and an EventTarget fires listeners in registration order, so the
    // terminal event still reaches the feed before the feed stops listening
    // for it. The feed itself stays registered and readable until the run is
    // removed.
    const disposeRecoveredRunEventFeed = attachRunEventFeed(runId, recoveredRun, runEventFeeds, {
      now: runtimeServices.clock.now,
      onError: (error, kind) => {
        diagnose({
          level: 'error',
          scope: 'event-feed',
          message: `[bureau] run event feed threw recording a "${kind}" event for run ${runId}:`,
          cause: error,
        });
      },
    });

    // Persist terminal session status from the recovered run's OWN terminal
    // events — the same fields the live-run listeners write. The conversation
    // comes from `event.conversation`, which the reattach adapter reconstructs
    // from the checkpoint (so completed steps from the resumed process are
    // included), preserving the old `settleRecoveredRun`'s checkpoint-preferred
    // conversation behavior. A run the engine failed pre-replay (services
    // unavailable) or one interrupted by teardown fires NO terminal event — the
    // adapter stays write-free for those and the resolver/teardown owns the
    // session status. A run that fails after replay (an activity or workflow-body
    // failure, COR-1587) settles as `error`, with `run.error` then `run.completed`,
    // so these listeners run for it too.
    // COR-625: a reattached run whose `result` REJECTS — a recovered
    // workflow whose stored result fails its schema-version check
    // (`UnsupportedRunResultVersionError`, rethrown by
    // `driveReattachedRun`) is the reachable case — dispatches no terminal
    // event at all, so neither listener below ever fires and `closed()`'s
    // own fold is skipped too (`createClosedAcknowledgement` classifies a
    // rejected `result` as `failed` without consulting `resolveOutcome`).
    // Without this the run would reach a dead end with NO
    // `run.cleanup-settled` record, which is exactly the "cleanup failure
    // that is invisible" this feature exists to prevent. The step re-reads
    // the engine itself, so a run left non-terminal by the failure is
    // recorded as unresolved rather than being pruned.
    detachBestEffortPromise(
      recoveredRun.result.catch(() => peers.runTerminalCheckpointCleanup(runId)),
    );
    // As for a fresh run: a handle that settles while the store still says
    // `running` (rejected, or abandoned to another owner) no longer drives
    // the run, so steering liveness asks the engine instead.
    detachBestEffortPromise(
      recoveredRun.result
        .catch(() => undefined)
        .finally(() => {
          peers.abandonTerminalSessionRecord(runId);
          peers.settleAbandonedRun(sessionId, runId, recoveredRun);
        }),
    );

    // Steered, and so counted as live for steering, only with a gate: the
    // incarnation alone (still passed to fence the terminal save) does not
    // make a run read commands or log its end.
    if (sessionIncarnation !== undefined && steeringGate !== undefined) {
      steeringRunIncarnations.set(runId, sessionIncarnation);
      peers.pollSessionSteering(sessionId, sessionIncarnation, runId);
    }
    if (steeringGate !== undefined) {
      recoveredRun.addEventListener(SteeringAppliedEvent.type, (event) => {
        peers.logRunBoundarySteering(sessionId, steeringGate, {
          type: 'applied',
          runId: event.effective.appliedAtRunId,
          configVersion: event.effective.configVersion,
          now: event.effective.appliedAt,
        });
      });
      const endSteering = (): void => {
        peers.logRunBoundarySteering(sessionId, steeringGate, {
          type: 'run-ended',
          runId,
          now: runtimeServices.clock.nowISO(),
        });
      };
      recoveredRun.once('run.completed', endSteering);
      recoveredRun.once('run.aborted', endSteering);
    }

    peers.expectTerminalSessionRecord(runId);
    recoveredRun.once('run.completed', (event) => {
      activeRuns.delete(recoveredRun);
      disposeRecoveredRunFrameForwarder();
      disposeRecoveredRunEventFeed();
      // COR-625: a terminal transition owes this run one checkpoint-
      // retention step whether or not anyone ever calls `closed()`.
      // Memoized per run id, so this and `closed()`'s own fold resolve the
      // SAME step. Fire-and-forget: the step records its own
      // acknowledgement durably and never rejects.
      void peers.runTerminalCheckpointCleanup(runId);
      const completedConversation = event.conversation;
      const finishReason = event.finishReason;
      const lastRunStatus = isFailureFinishReason(finishReason) ? 'error' : 'completed';
      const lastError = isFailureFinishReason(finishReason) ? event.error : undefined;

      const report = buildTerminalReportFromCompletedEvent(runId, event);
      peers.emitLiveFrame({
        type: 'run-envelope',
        runId,
        frame: createRunFinishedFrame({ runId, report }, runtimeServices.clock.now),
      });

      peers.persistTerminalSession(
        () =>
          peers.saveRunTerminalSession(runId, sessionId, completedConversation, {
            lastRunId: runId,
            lastRunStatus,
            lastFinishReason: finishReason,
            ...(isFailureFinishReason(finishReason)
              ? { lastError: serializeUnknownError(lastError) }
              : {}),
          }),
        {
          runId,
          sessionId,
          status: lastRunStatus,
          spend: {
            agentName: recoveredAgentName ?? BUREAU_AGENT_NAME,
            owner: recoveredOwner,
            costEstimate: event.costEstimate,
          },
        },
      );
    });

    recoveredRun.once('run.aborted', (event) => {
      activeRuns.delete(recoveredRun);
      disposeRecoveredRunFrameForwarder();
      disposeRecoveredRunEventFeed();
      // COR-625: a terminal transition owes this run one checkpoint-
      // retention step whether or not anyone ever calls `closed()`.
      // Memoized per run id, so this and `closed()`'s own fold resolve the
      // SAME step. Fire-and-forget: the step records its own
      // acknowledgement durably and never rejects.
      void peers.runTerminalCheckpointCleanup(runId);
      const abortedConversation = event.conversation;

      const report = buildTerminalReportFromAbortedEvent(runId, {
        usage: event.usage,
        costEstimate: event.costEstimate,
        reason: event.reason,
        error: event.error,
        steps: store.getRun(runId)?.steps ?? [],
        conversation: event.conversation,
      });
      peers.emitLiveFrame({
        type: 'run-envelope',
        runId,
        frame: createRunFinishedFrame({ runId, report }, runtimeServices.clock.now),
      });

      peers.persistTerminalSession(
        // The reattach adapter reconstructs the abort RunResult from the run's
        // final checkpoint and threads it into RunAbortedEvent.conversation, so
        // use that directly instead of re-fetching the checkpoint snapshot.
        () =>
          peers.saveRunTerminalSession(runId, sessionId, abortedConversation, {
            lastRunId: runId,
            lastRunStatus: 'aborted',
            lastFinishReason: 'aborted',
            lastError: serializeUnknownError(event.error),
          }),
        {
          runId,
          sessionId,
          status: 'aborted',
          spend: {
            agentName: recoveredAgentName ?? BUREAU_AGENT_NAME,
            owner: recoveredOwner,
            costEstimate: event.costEstimate,
          },
        },
      );
    });

    // Seed the runSeq generation before `store.register` wires the action
    // subscription that starts stamping frames — see `seedRunSeqGeneration`.
    peers.seedRunSeqGeneration(runId);
    store.register(recoveredRun, runId);
    activeRuns.add(recoveredRun);
    recoveredActiveRuns.add(recoveredRun);
    runSessionIdentifiers.set(recoveredRun, sessionId);

    // AB-12 — stamp a `workflow.reattached` marker into this run's action
    // log so the run-inspector timeline shows the recovery/reattach boundary.
    // Reattachment happens BEFORE `store.register`'s observable subscription
    // exists (recovery itself never fires as a run event), so there is no
    // other way for this transition to reach the sequenced action log.
    // `recordAction` is called synchronously right after `register`, so it
    // gets the lowest sequence number of this run's post-reattach actions —
    // it always precedes whatever the resumed generator emits next.
    const versionMismatch = runtime.workflowVersionMismatches.get(runId);
    store.recordAction(runId, 'workflow.reattached', {
      sessionId,
      versionMismatch: versionMismatch !== undefined,
      ...versionMismatch,
    });
  }

  /**
   * Cancel suspended scheduler-origin durable runs left behind by a hard crash
   * (#25). A preempted scheduler task is parked `suspended`, and its only live
   * pointer is the in-memory queue entry — lost on crash. `recoverAll()` never
   * surfaces a suspended run (suspended ≠ running), so without this sweep the
   * workflow and its checkpoints dangle in storage forever. This sweep is the
   * SOLE protection against a reused scheduler id colliding with suspended residue
   * (`onTerminalConflict: 'start-new'` covers only TERMINAL conflicts), so it must
   * be COMPLETE — it pages until no suspended scheduler runs remain rather than
   * stopping at a cap (a partial sweep would leave an unsafe collision).
   *
   * TOCTOU: cancelling a run flips it suspended→cancelled and shrinks the next
   * page's `total`, which would terminate a per-page-cancel loop early and
   * under-cancel. So we COLLECT every id across all pages FIRST, then cancel.
   *
   * A high sanity bound guards against a pathological/runaway backlog (or a
   * mis-paginating store): if it is hit, the sweep FAILS LOUD (throws) rather than
   * silently truncating and continuing in an unsafe state — the caller's boot
   * try/catch logs it, and the operator sees a clear signal instead of a quiet
   * partial sweep.
   */
  /**
   * Returns the number of suspended-residue ids this sweep found but could
   * NOT cancel (each such rejection is also diagnosed individually below).
   * A non-zero count means real collision-risk residue survives the sweep
   * even though the function itself did not throw — the caller folds this
   * into `BureauRecoveryReport.sweepFailure` (code-review regression
   * fixture, AB-349) so that outcome is not misreported `'clean'`.
   */
  async function sweepSuspendedSchedulerRuns(
    engine: NonNullable<typeof runtime.durable>['engine'],
  ): Promise<number> {
    const PAGE_SIZE = 100;
    // Sanity cap on TOTAL pages — far above any plausible suspended-residue count.
    // Hitting it means something is wrong (a runaway backlog or a store that is
    // not advancing), so we throw rather than truncate.
    const MAX_PAGES = 10_000;
    const ids: string[] = [];
    let offset = 0;

    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) {
        throw new Error(
          `[bureau] Suspended scheduler-run sweep exceeded ${MAX_PAGES} pages ` +
            `(${MAX_PAGES * PAGE_SIZE}+ runs) without draining — aborting boot recovery ` +
            `rather than leaving suspended residue that could collide with a reused id.`,
        );
      }
      // Match by the synthetic-id PREFIX, not the origin TAG: suspended
      // `scheduler-run-*` residue left by an earlier release carries the prefix
      // (and phantom sessionId) but may not carry the tag, and a tag-only filter
      // would never collect it (Bugbot #38). The id format is release-stable, so
      // the prefix catches both legacy and new residue. The tag remains the
      // primary recovery-time discriminant in the resolver via Weft's launch
      // context; this prefix sweep is legacy cleanup for untagged residue.
      // Pagination lives on ListFilter.
      const result = await engine.list({
        status: 'suspended',
        idPrefix: SCHEDULER_RUN_ID_PREFIX,
        limit: PAGE_SIZE,
        offset,
      });
      for (const summary of result.items) {
        ids.push(summary.id);
      }
      offset += result.items.length;
      if (offset >= result.total || result.items.length === 0) {
        break;
      }
    }

    if (ids.length === 0) return 0;

    const outcomes = await Promise.allSettled(ids.map((id) => engine.cancel(id)));
    let failedCancellations = 0;
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'rejected') {
        failedCancellations += 1;
        diagnose({
          level: 'error',
          scope: 'recovery',
          message: `[bureau] Failed to cancel suspended scheduler run "${ids[index]!}": ${serializeUnknownError(outcome.reason)}`,
        });
      }
    });
    return failedCancellations;
  }

  /**
   * COR-1916 — a run whose session is settled and whose durable record is terminal was finished by
   * a peer after this boot took its claim (a process that stalls past its lease TTL loses the run
   * to a peer), so there is nothing to cancel and no recovery failure to report. Applies only to
   * the session-only `session-not-running` verdict, and never to a run this boot ended itself
   * (`unrebuildableRecoveredRuns`), which stays reported. A record that cannot be read leaves the
   * verdict as it was.
   */
  async function skipRunFinishedByPeer(
    runId: string,
    args: ClassifyRecoveredRunArgs,
    classification: { verdict: RecoveredRunVerdict; rejection?: RecoveryRejectionReason },
  ): Promise<{ verdict: RecoveredRunVerdict; rejection?: RecoveryRejectionReason }> {
    const durable = runtime.durable;
    if (
      durable === undefined ||
      classification.rejection !== 'session-not-running' ||
      runtime.unrebuildableRecoveredRuns.has(runId)
    ) {
      return classification;
    }
    try {
      const record = await durable.engine.get(runId);
      if (record === null || !RECOVERED_RUN_TERMINAL_STATUSES.has(record.status)) {
        return classification;
      }
      return classifyRecoveredRunDetailed({ ...args, engineRecordStatus: record.status });
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Could not read the durable record of recovered run "${runId}"; classifying it without its status: ${serializeUnknownError(error)}`,
        cause: error,
      });
      return classification;
    }
  }

  /**
   * Dispatches `recovery.attempted` for every `classifyRecoveredRun` call
   * (AB-90/ab90-09), making the classification externally observable, then
   * `recovery.rejected` — synchronously, right after, so the two are always
   * correctly ordered for the same `runId` — only when the verdict is the
   * positive rejection (`'cancel'`). Shared by both `classifyRecoveredRun`
   * call sites below; not shared with any other AB-90 child's emission
   * points (per the merge-order convention, each child's call sites stay
   * independent).
   */
  function dispatchRecoveryClassification(
    runId: string,
    classification: { verdict: RecoveredRunVerdict; rejection?: RecoveryRejectionReason },
  ): void {
    emitter.dispatch(new RecoveryAttemptedEvent(runId, classification.verdict));
    if (classification.rejection !== undefined) {
      emitter.dispatch(new RecoveryRejectedEvent(runId, classification.rejection));
      core.currentRecoveryPerRunFailures?.push({ runId, reason: classification.rejection });
    }
  }

  /**
   * Dispatches `recovery.lease-released` when Weft's own `Engine.getLeaseHealth()`
   * — read fresh, never cached — reports a released (contested, with holder
   * record) engine-level lease this run's recovery pass overlapped with.
   * Projects Weft's evidence via `leaseEvidenceFromLostHealth`; never
   * dispatched for a disabled/no-lease engine, a currently-held lease, or the
   * sparsest contested shape, since none of those is a lease actually
   * released, and never asserts a Bureau-owned lease of its own (AB-39).
   */
  function dispatchRecoveryLeaseReleasedIfAny(runId: string): void {
    if (!runtime.durable) return;
    const lease = leaseEvidenceFromLostHealth(runtime.durable.engine.getLeaseHealth());
    if (lease !== undefined) {
      emitter.dispatch(new RecoveryLeaseReleasedEvent(runId, lease));
    }
  }

  /**
   * Reattach an owned interactive run inside Weft's awaited recovery hook. At
   * this point the resolver has rebuilt `services`, but the recovered workflow
   * has not advanced, so the ActiveRun surface and all event forwarding exist
   * before the first resumed step can emit anything.
   */
  async function onRecoveredWorkflow(info: RecoveredWorkflowInfo): Promise<void> {
    if (
      !isAgentRunWorkflowInput(info.input) ||
      info.input.runId !== info.workflowId ||
      !runtime.sessionStore ||
      store.getRun(info.workflowId)
    ) {
      return;
    }

    // AB-240: a catalog-dispatched run (`bureau.run()`) never owns a bureau
    // session — its recovery record (agent name + revision + input) is what
    // `resolveRunServices`'s catalog branch already consulted to rebuild
    // `info.services` from the catalog agent's OWN run options. Route it to
    // the same headless monitor a native scheduled fire gets instead of the
    // session-ownership classification below, which would otherwise treat
    // it as an orphaned run and cancel it.
    // AB-241 review finding: ONE combined classify-and-attribute read
    // (`classifyCatalogRecoveredRun`), not a separate `isCatalogRecoveredRun`
    // check followed by an independent attribution lookup — two reads could
    // let a transient storage failure on the SECOND one silently demote an
    // attributed run to unattributed even though the FIRST read (deciding
    // this is catalog territory at all) succeeded. See that function's own
    // doc comment on the `RuntimeComposition` interface.
    const catalogRecovery = await runtime.classifyCatalogRecoveredRun(info.workflowId);
    if (catalogRecovery.isCatalogRun) {
      // Reseed `runAttribution` from the persisted recovery record — the
      // in-memory map a live dispatch populates is empty on a freshly
      // booted process, so without this a recovered catalog run's principal
      // (and `eventHistory`'s principal gate, which consults this map)
      // would silently revert to unattributed. Not cleaned up on
      // settlement, matching a live dispatch's own attribution lifetime
      // (see `trackCatalogRun`'s doc comment) — a settled run's attribution
      // must survive so `eventHistory` can still read it back afterward.
      if (catalogRecovery.attribution) {
        runAttribution.set(info.workflowId, catalogRecovery.attribution);
      }
      // COR-1577 — a recovered `bureau.run()` run that was parked on `requestHumanInput` is a
      // review again, under the id it had, and the parks it makes from here on are heard.
      await core.runHumanWaits.attach(
        info.workflowId,
        { agentName: info.input.agentName },
        info.services as DurableRunDeps,
      );
      // COR-1524: a recovered run is in no store and has no handle of its own, so its snapshot
      // reference settles from the catalog settlement hook, as it ends (see the subscription
      // beside the hook's creation).
      void info.handle.result().then(
        () => core.runHumanWaits.forget(info.workflowId),
        () => core.runHumanWaits.forget(info.workflowId),
      );
      core.catalogSettlements.follow(
        monitorRecoveredCatalogRun(
          info.handle,
          info.input.agentName,
          diagnose,
          (settlement) => core.catalogRunSettlements.publish(settlement),
          peers.catalogDurableEnd,
          core.catalogSettlements,
        ),
      );
      return;
    }

    let sessionLoad: SessionLoadOutcome;
    let loadedSession: AgentSession | undefined;
    try {
      const session = await runtime.sessionStore.load(info.input.sessionId);
      loadedSession = session;
      sessionLoad = { ok: true, session: session ? { ...session.metadata } : null };
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Could not load owning session for recovered run "${info.workflowId}"; leaving it to resume without live visibility: ${serializeUnknownError(error)}`,
      });
      return;
    }

    const classificationArgs: ClassifyRecoveredRunArgs = {
      handleId: info.workflowId,
      scheduledFire: false,
      ownedSessionId: info.input.sessionId,
      metadataReadFailed: false,
      hasSessionStore: true,
      sessionLoad,
      versionMismatch: runtime.workflowVersionMismatches.has(info.workflowId),
    };
    let classification = classifyRecoveredRunDetailed(classificationArgs);
    // Awaited only for the one verdict it can change: a reattach must register its run in the
    // same turn as the classification, before the run can reach a terminal event.
    if (classification.rejection === 'session-not-running') {
      classification = await skipRunFinishedByPeer(
        info.workflowId,
        classificationArgs,
        classification,
      );
    }
    const { verdict } = classification;
    dispatchRecoveryClassification(info.workflowId, classification);
    dispatchRecoveryLeaseReleasedIfAny(info.workflowId);
    if (verdict !== 'reattach' && verdict !== 'reattach-version-mismatch') return;

    if (verdict === 'reattach-version-mismatch') {
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message:
          `[bureau] Reattaching recovered run "${info.workflowId}" that resumed under a ` +
          `different workflow version than it was checkpointed with (pin-and-warn; ` +
          `see documentation/workflow-versioning.md).`,
      });
    }
    if (info.services === undefined || info.services === null) {
      throw new Error(`Recovered run "${info.workflowId}" has no reconstructed services`);
    }

    const services = info.services as DurableRunDeps;
    // A recovered run steers exactly like a fresh one: this awaited hook runs
    // before replay resumes, so the run's gate is folded from the session's
    // log and handed to the run here, and its boundary and end events are
    // logged by `reattachRecoveredRun`.
    const recoveredSteeringGate = await peers.recoverRunSteering(
      info.input.sessionId,
      loadedSession,
      info.workflowId,
      services,
    );
    // The incarnation `reattachRecoveredRun` records for the run below, read
    // here before it has.
    await peers.attachRecoveredSessionInput(
      info.input.sessionId,
      info.workflowId,
      services,
      loadedSession?.incarnation,
    );
    const eventSurface = createRecoveredRunEventSurface(
      services,
      info.workflowId,
      info.input.agentName,
    );
    await peers.restorePendingApprovalStates(
      services.toolbox,
      sessionLoad.session,
      info.workflowId,
      info.input.sessionId,
    );
    reattachRecoveredRun(
      info.workflowId,
      info.input.sessionId,
      info.handle,
      eventSurface,
      info.services as DurableRunDeps,
      sessionLoad.session,
      recoveredSteeringGate,
      loadedSession?.incarnation,
    );
    // AB-336 — see this function's own doc comment: a run recovered still
    // genuinely parked on `requestHumanInput` has no live action log to
    // derive its pending review from until this runs.
    await reconstructHumanWaitReviewIfParked(info.workflowId);
  }

  /**
   * COR-851 — the boot sweep over every unfinished goal. Recovery reports what it
   * could not do rather than throwing; each goal it found stuck (see
   * `recoveryEntryFailure`) is a failure of the boot, not a clean one, and is
   * diagnosed.
   */
  async function recoverGoalsAtBoot(): Promise<{ runId: string; reason: string }[]> {
    const failures: { runId: string; reason: string }[] = [];
    const goalRecovery = await core.goalsComposition.recoverAtBoot();
    for (const failure of goalRecovery.failures) {
      failures.push({ runId: failure.goalRunId, reason: failure.reason });
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Could not recover goal "${failure.goalRunId}": ${failure.reason}`,
      });
    }
    for (const entry of goalRecovery.goals) {
      const reason = recoveryEntryFailure(entry);
      if (reason === undefined) continue;
      failures.push({ runId: entry.goalRunId, reason });
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Goal "${entry.goalRunId}" is ${entry.attempt === 'failed' ? 'running with an attempt that could not be reconciled' : entry.outcome}: ${reason}`,
      });
    }
    return failures;
  }

  /**
   * COR-1594 — records in the fire's durable history that its settlement is written, which is how a
   * stream another process serves learns of the end. A rejected append is tried again, as a session
   * persistence write is; one that still fails is diagnosed by the task registry, and the boot pass
   * (`reconcileTaskRecords`) appends it at the next start. Idempotent: the append is deduplicated
   * per fire, so a live end, a retry and the boot pass write one event between them.
   */
  async function appendFireSettledEvent(record: TaskRecord): Promise<void> {
    if (core.eventHistoryInstance === undefined || record.settled === undefined) return;
    const payload: ScheduleFireSettledPayload = {
      runId: record.taskId,
      status: record.settled.status,
    };
    const endedAt = Date.parse(record.settled.at);
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        await core.eventHistoryInstance.record(
          { kind: 'run', id: record.taskId },
          SCHEDULE_FIRE_SETTLED_EVENT_KIND,
          payload,
          {
            dedupeKey: scheduleFireSettledDedupeKey(record.taskId),
            // Dated where the fire ended, so a repair at a later boot does not move the end.
            ...(Number.isFinite(endedAt) ? { emittedAtMs: endedAt } : {}),
          },
        );
        return;
      } catch (error) {
        lastError = error;
        if (attempt < SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS) {
          await sessionPersistenceSleep(sessionPersistenceRetryDelayMilliseconds);
        }
      }
    }
    throw lastError;
  }

  return {
    humanWaitParkOrdinal,
    reconstructHumanWaitReviewIfParked,
    reattachRecoveredRun,
    sweepSuspendedSchedulerRuns,
    skipRunFinishedByPeer,
    dispatchRecoveryClassification,
    dispatchRecoveryLeaseReleasedIfAny,
    onRecoveredWorkflow,
    recoverGoalsAtBoot,
    appendFireSettledEvent,
  };
}
