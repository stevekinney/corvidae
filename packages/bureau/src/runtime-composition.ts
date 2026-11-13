import { normalizeRunRequestContext } from './session-request-context.ts';
import {
  createRunAuthorityValidator,
  guardWorkspaceRunOptions,
  recoverRunWorkspaceAuthority,
} from './run-authority.ts';
import type { RuntimeServices } from '@lostgradient/lifecycle';
import { createSecretAnswerStore, secretResolverOf } from './secret-answers';
import {
  createDefaultRuntimeServices,
  HookRegistry,
  TypedEventTarget,
} from '@lostgradient/lifecycle';
import { composeRunHooks, pluginHookTier, type RunHookTiers } from './run-hook-tiers';
import type { GovernedMemory } from '@lostgradient/memory';
import type {
  DurableRunDeps,
  GenerateFunction,
  BureauChildInvariants,
  GuardrailsOptions,
  JSONValue,
  OperativeHookMap,
  PersistedSessionTaint,
} from '@lostgradient/operative';
import {
  createCheckpointStore,
  createDefaultGuardrailsPreset,
  createGuardrails,
  withSessionTaint,
  createRunEngine,
  createRunWorkflow,
  createSessionStore,
  DEFAULT_MAXIMUM_STEPS,
  isAgentRunWorkflowInput,
  isFailureFinishReason,
  isScheduledAgentRunInput,
  ScheduleAttemptedEvent,
  ScheduleCompletedEvent,
  ScheduleFailedEvent,
  SCHEDULER_ORIGIN_TAG,
  SCHEDULER_RUN_ID_PREFIX,
  ScheduleSkippedEvent,
  bureauInvariantsField,
  WorkflowVersionMismatchEvent,
} from '@lostgradient/operative';
import {
  DEFAULT_SOURCE_PRECEDENCE,
  discoverSkills,
  type SkillCatalogRevision,
  type SkillEventMap,
} from './skills';
import { fenceStorage } from './storage-fence';
import type { CompositionCore } from './composition-seams/core';
import {
  createScheduledRunServices,
  type ScheduledRunServicesPeers,
} from './composition-seams/scheduled-run-services';
import { createRunRuntimeSeam, type RunRuntimePeers } from './composition-seams/run-runtime';
import {
  createSessionAgentRuns,
  type SessionAgentRunsPeers,
} from './composition-seams/session-agent-runs';
import {
  createCatalogRunRecovery,
  type CatalogRunRecoveryPeers,
} from './composition-seams/catalog-run-recovery';
import {
  createWorkflowLogStore,
  type WorkflowLogRecord,
  WorkflowCancelledEvent,
  WorkflowTimedOutEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  type WorkflowServicesResolution,
  type WorkflowServicesResolverInfo,
} from '@lostgradient/weft';
import {
  type ConditionalTextValueStore,
  type Storage,
  textValueStore,
} from '@lostgradient/storage';
import { createToolbox, type ToolRequestContext } from 'armorer';
import { describeDefinitionDrift, pinOf } from './agent-definition-pin';
import { isTryAgentName } from './agent-try';
import { type GoalAttemptTarget, registerGoalAttemptFence } from './goal-attempt-fence';
import { bufferMissedFires } from './bureau-event-forwarders';
import { ownerOrLocal } from './owner-of-record';
import { resolveDiagnosticSink, serializeUnknownError } from './serialization';
import { createSessionTaintSeam, type SessionTaintSeam } from './session-taint-seam';
import { DEFAULT_MAX_CONCURRENT_RUNS } from './settings/settings-options';
import type {
  BureauInvariantOptions,
  BureauToolbox,
  CatalogAgentRunOptionsResolver,
  DurableComposition,
  RuntimeComposition,
  RuntimeCompositionDependencies,
  RuntimeCompositionOptions,
  ScheduleFireEventMap,
  ScheduledFireSettlement,
} from './runtime-composition-types';
import { type CatalogRunRecoveryRecord } from './catalog-run-recovery-record';
import {
  grantedTools,
  hasDispatchEvent,
  recoveredRequestContext,
  wireDurableOptInTools,
} from './run-request-context';
import { createUnavailableToolbox } from './skill-step-metadata';
import { applyCache, unsetMediaOptions } from './provider-resolution';
import {
  BUREAU_HOOK_TIER,
  registerGuardrailInvariants,
  registerIdentityInvariant,
} from './bureau-invariant-hooks';
import { hasPersistedScheduleMarker, recoveredMarkerSessionId } from './schedule-run-marker';

const defaultRuntimeCompositionDependencies: RuntimeCompositionDependencies = {
  createSessionStore,
};

export async function createRuntimeComposition(
  options: RuntimeCompositionOptions,
  suppliedDependencies: Partial<RuntimeCompositionDependencies> = {},
): Promise<RuntimeComposition> {
  // COR-1509: the durable engine starts reclaiming and resuming runs with a lapsed claim as soon
  // as it exists, on its own interval and independent of `recover`, which is before this
  // composition finishes. `resolveRunServices` therefore waits on this gate rather than answering
  // "not ready": a run that reaches the resolver early must be held, not durably failed.
  const readiness = Promise.withResolvers<void>();
  // A failed composition rejects the gate; the resolver handles that, and nothing else needs to.
  readiness.promise.catch(() => {});
  try {
    return await buildRuntimeComposition(options, suppliedDependencies, readiness);
  } catch (error) {
    readiness.reject(error);
    throw error;
  }
}

/** What the seams of `buildRuntimeComposition` read from one another, read at call time. */
type CompositionPeers = CatalogRunRecoveryPeers &
  SessionAgentRunsPeers &
  RunRuntimePeers &
  ScheduledRunServicesPeers;

async function buildRuntimeComposition(
  options: RuntimeCompositionOptions,
  suppliedDependencies: Partial<RuntimeCompositionDependencies>,
  readiness: PromiseWithResolvers<void>,
): Promise<RuntimeComposition> {
  const dependencies: RuntimeCompositionDependencies = {
    ...defaultRuntimeCompositionDependencies,
    ...suppliedDependencies,
  };
  const maximumSteps = options.maximumSteps ?? DEFAULT_MAXIMUM_STEPS;
  const systemPrompt = options.systemPrompt;
  const diagnose = resolveDiagnosticSink(options.onDiagnostic);
  // AB-260: `createBureau` resolves and forwards its own single
  // `RuntimeServices` instance through `options.runtime` before calling this
  // function, so this resolution just picks that SAME instance back up. A
  // direct caller of this exported function (bypassing `createBureau`
  // entirely — this package's own extensive test suite does exactly that)
  // gets the real-globals default, identical to this composition's behavior
  // before `RuntimeServices` existed.
  const runtimeServices: RuntimeServices = options.runtime ?? createDefaultRuntimeServices();

  // The resolver waits on `readiness` until the whole composition is assembled. In automatic mode
  // `createRunEngine` starts its scheduler and claim-reclaim interval before later consts
  // (`sessionStore`, the `createRunRuntime` closure deps) are initialized, so a persisted schedule
  // or a lapsed claim can reach `resolveRunServices` mid-build and would hit a not-yet-initialized
  // binding. Manual mode has no background poller, but shares the same gate for consistency.
  // Only so the resolver can say, once, that it had to wait; the gate itself is `readiness`.
  let compositionOpen = false;
  let requestAuthorityValidator = createRunAuthorityValidator(
    options.workspace,
    options.requestAuthorityValidator,
  );
  // AB-240: wired by `createBureau` once its agent catalog exists (this
  // function's own contract deliberately excludes `agents` — see
  // `RuntimeCompositionOptions`'s doc comment) — `undefined` until then, and
  // for any direct `createRuntimeComposition` caller that never wires one.
  let catalogAgentRunOptionsResolver: CatalogAgentRunOptionsResolver | undefined;
  // COR-1586: with `awaitsCatalogAgentRunOptionsResolver`, a reader of the resolver that finds it
  // unset waits on this gate. It opens when the resolver is wired or abandoned, and stays open.
  const catalogResolverGate = Promise.withResolvers<void>();
  let catalogResolverGateOpen = false;
  let catalogResolverAbandonedReason: string | undefined;
  const openCatalogResolverGate = (): void => {
    catalogResolverGateOpen = true;
    catalogResolverGate.resolve();
  };

  // AB-10: run ids the durable engine flags as version-mismatched during boot
  // recovery — see RuntimeComposition.workflowVersionMismatches.
  const workflowVersionMismatches = new Map<
    string,
    { storedVersion: string; registeredVersion: string }
  >();

  // COR-1916: see RuntimeComposition.unrebuildableRecoveredRuns.
  const unrebuildableRecoveredRuns = new Set<string>();

  // AB-223: runId → scheduleId for a scheduled fire whose deps this composition
  // has built (live tick or recovered), so the `workflow:completed`/
  // `workflow:failed` engine listener wired below `createRunEngine` can
  // correlate a terminal event back to its owning schedule. Populated in
  // `buildScheduledRunServices`; each entry is deleted the instant its
  // terminal event dispatches, so it never grows past the count of in-flight
  // scheduled fires.
  const scheduledFireScheduleIds = new Map<string, string>();

  // Declared before any await in composition: a schedule fire can settle while it is running.
  const pendingScheduledTaints = new Map<string, PersistedSessionTaint>();
  const pendingTaintKey = (sessionId: string, runId: string): string =>
    `${sessionId}\u0000${runId}`;

  /**
   * COR-1482: tells the host a schedule fire's run has ended. The settlement is a record about a
   * run that already ended, so a host that cannot write it is diagnosed, never thrown into the
   * engine's event dispatch.
   */
  function settleScheduledFire(settlement: ScheduledFireSettlement): void {
    // COR-2381 — a fire whose first step tripped never ran its write-back hook, which is what
    // deletes a held taint; every exit path of a fire settles here.
    for (const key of pendingScheduledTaints.keys()) {
      if (key.endsWith(`\u0000${settlement.runId}`)) pendingScheduledTaints.delete(key);
    }
    const hook = dependencies.onScheduledFireSettled;
    if (hook === undefined) return;
    void (async () => hook(settlement))().catch((error: unknown) => {
      diagnose({
        level: 'error',
        scope: 'task-registry',
        message: `[bureau] Could not settle the task of schedule fire "${settlement.runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    });
  }

  // AB-241 review finding: runId → the decoded `CatalogRunRecoveryRecord`
  // `resolveRunServices`'s catalog branch already successfully read during
  // boot recovery, cached here so BOTH `classifyCatalogRecoveredRun` (called
  // from the awaited `onRecoveredWorkflow` hook, during `recoverAll()`) and
  // `isCatalogRecoveredRun` (called again, LATER, from
  // `recoverDurableRuns`'s own post-recovery loop over `recoverAll()`'s
  // returned handles) can reuse that SAME decode instead of each issuing
  // its own independent storage read — a transient failure on either read
  // could disagree with the first, either losing an already-attributed
  // run's attribution or, worse, misclassifying an already-resolved
  // catalog run as an orphan and cancelling it. Entries are intentionally
  // NOT evicted per-read (a second fresh review finding after an earlier,
  // wrong per-entry-eviction attempt starved the later of these two
  // consumers) — the whole cache is cleared in one call, once, at the end
  // of the boot recovery pass (`clearCatalogRunRecoveryCache`, called from
  // `recoverDurableRuns` in create-bureau.ts), so it never persists past
  // that one pass — unlike `runAttribution`, this is not live-dispatch
  // state.
  const catalogRunRecoveryCache = new Map<string, CatalogRunRecoveryRecord>();
  const scheduleFireEvents = new TypedEventTarget<ScheduleFireEventMap>();
  const skillEvents = new TypedEventTarget<SkillEventMap>();

  // The caller's storage adapter. Bureau never disposes it: the caller constructed it and closes
  // it after the Bureau has shut down. Everything here uses it through a fence, which the Bureau
  // closes when it shuts down or fails to start, so no work left over from it writes afterwards.
  const effectiveStorage = options.storage;
  const storageFence = effectiveStorage === undefined ? undefined : fenceStorage(effectiveStorage);

  let kv: ConditionalTextValueStore | undefined;
  // Keep the raw Storage so the durable engine can share the exact backend with
  // the text-value KV view (Weft requires one engine per durable store).
  const durableStorage: Storage | undefined = storageFence?.storage;
  if (durableStorage) {
    kv = textValueStore(durableStorage, { disposeUnderlyingStorage: false });
  }

  const effectiveObservability = options.observability;
  const effectiveOnLog = options.onLog;
  // COR-1811: persisted `ctx.log` lines. The store shares the engine's own storage, because the
  // engine reads, flushes, and purges through it; it exists only for a durable composition.
  const logStore =
    suppliedDependencies.workflowLogs === undefined || durableStorage === undefined
      ? undefined
      : createWorkflowLogStore(durableStorage, {
          maximumLinesPerRun: () => suppliedDependencies.workflowLogs?.maximumLinesPerRun(),
          // The retention window is measured on the Bureau's clock, as every other one is.
          getNow: () => runtimeServices.clock.now(),
          onError: (error) => suppliedDependencies.workflowLogs?.onError(error),
        });

  // Durable execution is ON BY DEFAULT whenever a PERSISTENT storage backend is
  // configured. The default follows persistence because that is the only place resume is real:
  // `memory` storage loses its checkpoints with the process, so default-on there
  // would be pure overhead with zero recovery. The explicit `durable`
  // flag overrides the default either way.
  let effectiveStorageIsPersistent = false;
  if (effectiveStorage) {
    const persistence = effectiveStorage.capabilities().persistence;
    effectiveStorageIsPersistent = persistence === 'local' || persistence === 'remote';
  }
  const wantsDurable = options.durable ?? effectiveStorageIsPersistent;

  let durable: DurableComposition | undefined;
  if (wantsDurable && durableStorage) {
    // Build the checkpoint store over the SAME backend the engine persists to.
    const checkpointStore = createCheckpointStore(
      textValueStore(durableStorage, { disposeUnderlyingStorage: false }),
    );
    const runWorkflow = createRunWorkflow(checkpointStore, { version: options.workflowVersion });
    // recover: false is REQUIRED. Weft's `Engine.create` default is recover:true,
    // which runs recoverAll() *during construction* — but the bureau needs the
    // recovered handles itself (to attach the `settleRecoveredRun` monitors that
    // persist each resumed run's terminal session status), and a handle started
    // inside Engine.create is not surfaced to the caller. So the bureau owns
    // recovery: it calls engine.recoverAll() at boot and keeps the handles. The
    // per-run deps a recovered run needs are re-provided lazily by
    // `resolveRunServices` (passed as resolveWorkflowServices), which Weft fires
    // per recovered run before its generator advances — no pre-injection, no
    // module-global registry.
    //
    // In the default automatic profile, `startScheduler: true` is REQUIRED too:
    // recover:false decouples *who drives recovery* from *whether timers fire*,
    // and the poller otherwise follows recover. In manual mode the serverless
    // host drives timers through `Bureau.maintain()`, so Weft
    // requires the in-process scheduler to remain stopped.
    const createdEngine = await createRunEngine({
      storage: durableStorage,
      runWorkflow,
      checkpointStore,
      recover: false,
      // COR-2009: the engine reads the Bureau's clock, so what it stores (events, checkpoints,
      // schedule fires and misses, indexes) is stamped on the same clock as the Bureau's own records.
      getNow: () => runtimeServices.clock.now(),
      backgroundTasks: options.maintenance ?? 'automatic',
      // COR-1527: with workflow files the scheduler waits until their documents are registered,
      // so a schedule that is due the moment the engine exists cannot fire a type Weft does not
      // have yet. `createBureau` starts it, before the engine recovers, once they are.
      startScheduler: options.maintenance !== 'manual' && options.workflowSource === undefined,
      resolveWorkflowServices: resolveRunServices,
      ...(dependencies.onRecoveredWorkflow === undefined
        ? {}
        : { onRecoveredWorkflow: dependencies.onRecoveredWorkflow }),
      ...(dependencies.goalWorkflow === undefined
        ? {}
        : { goalWorkflow: dependencies.goalWorkflow }),
      ...(effectiveObservability !== undefined ? { observability: effectiveObservability } : {}),
      ...(options.alerts === undefined ? {} : { alerts: options.alerts }),
      ...(options.storageSizeReportIntervalMs === undefined
        ? {}
        : { storageSizeReportIntervalMs: options.storageSizeReportIntervalMs }),
      ...(logStore === undefined
        ? effectiveOnLog
          ? { onLog: effectiveOnLog }
          : {}
        : {
            // The store keeps the lines; the host's own sink, or the console without one, still
            // receives each, as it did before lines were kept.
            onLog: (record: WorkflowLogRecord) => {
              logStore.sink(record);
              if (effectiveOnLog) effectiveOnLog(record);
              else console[record.level](record);
            },
            workflowLogs: logStore,
          }),
      // durableGuardrails is a Pick of these exact CreateRunEngineOptions fields, so
      // it spreads straight through; createRunEngine guards each one internally, so
      // passing `undefined` members is harmless.
      ...options.durableGuardrails,
      // The one guardrail Bureau defaults itself: Weft caps nothing unless asked.
      maxConcurrentRuns:
        options.durableGuardrails?.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
      // durableOwnership (AB-178) is the same Pick pattern — createRunEngine
      // defaults `ownership` to 'workflow-lease' when this is omitted entirely.
      ...options.durableOwnership,
      runWorkflowVersion: options.workflowVersion,
      // AB-10: record the mismatch so the boot recovery loop below can pass it
      // to `classifyRecoveredRun` (distinct 'reattach-version-mismatch' verdict)
      // before it inspects `workflowVersionMismatches`.
      onWorkflowVersionMismatch: (event: WorkflowVersionMismatchEvent) => {
        workflowVersionMismatches.set(event.runId, {
          storedVersion: event.storedVersion,
          registeredVersion: event.registeredVersion,
        });
        diagnose({
          level: 'warn',
          scope: 'recovery',
          message:
            `[bureau] Recovered run "${event.runId}" was checkpointed under workflow version ` +
            `"${event.storedVersion}" but is resuming under "${event.registeredVersion}". ` +
            `Recovery proceeds against the currently-deployed code (pin-and-warn) — see ` +
            `documentation/workflow-versioning.md.`,
        });
      },
    });
    // The poller started inside `Engine.create`, so listen for a missed fire now, with nothing
    // awaited in between, and let `createBureau` take what was held once it can forward it.
    durable = {
      ...createdEngine,
      missedFires: bufferMissedFires(createdEngine.engine),
      workflowLogs: logStore,
    };

    // AB-223: schedule-fire terminal events. `workflow:completed`/
    // `workflow:failed` fire on the engine for EVERY workflow (scheduled or
    // not) — a live tick and a recovered fire both settle through this same
    // pair, so listening here (rather than duplicating from
    // `monitorRecoveredScheduledFire`'s recovery-only await) gives exactly one
    // dispatch per fire regardless of how it settled. A run with no entry in
    // `scheduledFireScheduleIds` (every ordinary, non-scheduled run) is
    // silently ignored — `return` before either handler does anything else.
    durable.engine.addEventListener(WorkflowCompletedEvent.type, (event) => {
      const scheduleId = scheduledFireScheduleIds.get(event.workflowId);
      if (scheduleId === undefined) return;
      scheduledFireScheduleIds.delete(event.workflowId);
      const result = event.result;
      const finishReason =
        typeof result === 'object' && result !== null && 'finishReason' in result
          ? result.finishReason
          : undefined;
      // Two branches, each dispatching its own concrete event type, rather
      // than one `dispatch(cond ? new A() : new B())` call: TypedEventTarget's
      // `dispatch<K>` infers `K` from its argument's `type` literal, and a
      // ternary's union argument defeats that inference (the argument's
      // static `type` widens to `string`) — using the typed `dispatch` wrapper
      // (not the untyped inherited `dispatchEvent`) needs single-type call
      // sites.
      const failed = isFailureFinishReason(finishReason);
      const content =
        typeof result === 'object' && result !== null && 'content' in result
          ? result.content
          : undefined;
      settleScheduledFire({
        runId: event.workflowId,
        status: failed ? 'failed' : finishReason === 'aborted' ? 'canceled' : 'completed',
        finishReason: typeof finishReason === 'string' ? finishReason : undefined,
        error: undefined,
        content: typeof content === 'string' ? content : undefined,
      });
      if (failed) {
        scheduleFireEvents.dispatch(new ScheduleFailedEvent(scheduleId, event.workflowId));
      } else {
        scheduleFireEvents.dispatch(new ScheduleCompletedEvent(scheduleId, event.workflowId));
      }
    });
    durable.engine.addEventListener(WorkflowFailedEvent.type, (event) => {
      const scheduleId = scheduledFireScheduleIds.get(event.workflowId);
      if (scheduleId === undefined) return;
      scheduledFireScheduleIds.delete(event.workflowId);
      settleScheduledFire({
        runId: event.workflowId,
        status: 'failed',
        finishReason: undefined,
        error: event.error instanceof Error ? event.error.message : String(event.error),
        content: undefined,
      });
      scheduleFireEvents.dispatch(new ScheduleFailedEvent(scheduleId, event.workflowId));
    });
    // COR-1482: a fire that timed out is a fire that failed, and its task says so. Without this
    // its task reads `working` until the next boot, and its attribution is never released.
    durable.engine.addEventListener(WorkflowTimedOutEvent.type, (event) => {
      const scheduleId = scheduledFireScheduleIds.get(event.workflowId);
      if (scheduleId === undefined) return;
      scheduledFireScheduleIds.delete(event.workflowId);
      settleScheduledFire({
        runId: event.workflowId,
        status: 'failed',
        finishReason: 'timed-out',
        error: `The fire timed out (${event.timeoutType})`,
        content: undefined,
      });
      scheduleFireEvents.dispatch(new ScheduleFailedEvent(scheduleId, event.workflowId));
    });
    // Not a fire-terminal dispatch (cancellation is out of this issue's scope),
    // but the correlation entry must still be dropped on a cancelled fire, or
    // it leaks for the lifetime of the engine.
    durable.engine.addEventListener(WorkflowCancelledEvent.type, (event) => {
      if (scheduledFireScheduleIds.delete(event.workflowId)) {
        settleScheduledFire({
          runId: event.workflowId,
          status: 'canceled',
          finishReason: 'aborted',
          error: undefined,
          content: undefined,
        });
      }
    });

    // COR-660: the tick observation point Weft's COR-105 exposes. Unlike the
    // terminal pair above, these arrive already keyed by scheduleId, so there
    // is no `scheduledFireScheduleIds` correlation to do and nothing to
    // filter: every schedule on this engine is one the bureau created
    // (`createSchedule`, `createAgentScheduler`, or a durable heartbeat), the
    // engine being bureau-owned. A tick that collides emits `attempted` then
    // `skipped`; a tick that launches emits `attempted` and later one of the
    // terminal pair.
    durable.engine.addEventListener('schedule:attempted', (event) => {
      scheduleFireEvents.dispatch(new ScheduleAttemptedEvent(event.scheduleId, event.occurrence));
    });
    durable.engine.addEventListener('schedule:skipped', (event) => {
      scheduleFireEvents.dispatch(
        new ScheduleSkippedEvent(
          event.scheduleId,
          event.policy,
          event.occurrence,
          // A scheduled fire's Weft workflow id IS its AgentRun id — the same
          // identity `ScheduleFailedEvent`/`ScheduleCompletedEvent` carry as
          // `runId` from `event.workflowId`.
          event.blockingWorkflowId,
        ),
      );
    });
  }

  // COR-1879: plugin composition calls a `memory` factory before construction reaches here.
  if (typeof options.memory === 'function') {
    throw new TypeError('A memory factory reached composition without being called.');
  }
  const memory: GovernedMemory | undefined = options.memory;
  await memory?.init();
  // COR-1546 — the tenant a run's memory is partitioned under. `createBureau` passes its resolved
  // identifier, so `bureau.memory.*`, which builds its authority from `Bureau.id`, reads what the
  // runs wrote. A composition built on its own with no identifier gets one of its own.
  let generatedMemoryTenantId: string | undefined;
  const memoryTenantId = (): string =>
    options.id ?? (generatedMemoryTenantId ??= runtimeServices.identifiers.next('bureau'));

  // A run's skills come from a catalog revision, and only from one. COR-892 removed Bureau's
  // second path — a provider it read skills out of directly — because a skill admitted that way
  // had no trust decision, no artifact digest and no compatibility verdict, so a run holding one
  // could not say where it came from.
  //
  // A caller that has already discovered a revision hands it in, which is the host's job under
  // COR-752's Decision 1: discovery reads approved filesystem roots and remote URLs, and deciding
  // which of those to trust is not Bureau's call to make. A caller that has only configured
  // persistence gets the skills its own store holds, discovered here through the `storage` source.
  // That is the one source Bureau can compose without deciding anything on the host's behalf: the
  // store is already the bureau's, and what is in it is what this runtime itself put there.
  const skillCatalog: SkillCatalogRevision | undefined =
    options.skills === undefined
      ? undefined
      : (options.skills.catalog ??
        (kv === undefined
          ? undefined
          : await discoverSkills({
              sources: [
                {
                  id: 'storage',
                  kind: 'storage',
                  // Not a filesystem path and deliberately not credential-bearing: a catalog entry
                  // exposes this verbatim.
                  location: 'kv://skills',
                  precedence: DEFAULT_SOURCE_PRECEDENCE.storage,
                },
              ],
              storage: kv,
            })));
  /** Whether this Bureau has a skill client: the skills it was given, and a catalog to admit them. */
  const skillsConfigured = options.skills !== undefined && skillCatalog !== undefined;

  // AB-384 (Codex P2 review finding, PR #592, "Mint incarnations from the
  // Bureau's injected runtime"): `runtimeServices` (resolved above from
  // `options.runtime`, defaulting to the real globals) must be threaded
  // through here — omitting it would let `createSessionStore` silently
  // construct its OWN second default `RuntimeServices`, so every
  // `AgentSession.incarnation` it mints would come from real
  // `crypto.randomUUID()`/wall-clock time instead of the same injected
  // runtime every other subsystem this composition builds already uses,
  // breaking determinism for manual-runtime tests and fault-replay runs.
  const sessionStore = kv
    ? (dependencies.createSessionStore ?? createSessionStore)(kv, {
        runtime: runtimeServices,
        beforeCleanup: dependencies.beforeSessionCleanup,
      })
    : undefined;
  // COR-1920: secret answers need somewhere durable to keep their ciphertext and a key to seal it
  // with. The toolbox the Bureau builds itself reads them back for the run that asked; an author's
  // toolbox keeps its own options, and takes `createSecretAnswerResolver` to do the same.
  const secretAnswers =
    kv !== undefined && options.answerEncryption !== undefined
      ? createSecretAnswerStore({
          kv,
          keys: options.answerEncryption,
          now: () => runtimeServices.clock.now(),
        })
      : undefined;
  /**
   * COR-2105 — the seed and the write-back of one run of `sessionId`: the taint the session holds
   * in `metadata`, and an `onTainted` that stores a new one and publishes `session.tainted` once.
   */
  function sessionTaintSeamFor(
    sessionId: string,
    runId: string,
    metadata: Readonly<Record<string, JSONValue>> | undefined,
  ): SessionTaintSeam {
    return createSessionTaintSeam(
      {
        store: sessionStore,
        now: () => runtimeServices.clock.now(),
        publish: dependencies.onSessionTainted,
        // A scheduled fire's first step runs before its session exists: hold the taint for the
        // write-back hook that creates the session.
        holdForAbsentSession: (heldSessionId, heldRunId, value) => {
          const key = pendingTaintKey(heldSessionId, heldRunId);
          if (!pendingScheduledTaints.has(key)) pendingScheduledTaints.set(key, value);
        },
        diagnose: (cause) =>
          diagnose({
            level: 'warn',
            scope: 'guardrails',
            message: `[bureau] The taint of session "${sessionId}" could not be stored: ${serializeUnknownError(cause)}`,
            cause,
          }),
      },
      { sessionId, runId, metadata },
    );
  }
  const baseToolbox: BureauToolbox =
    options.toolbox ??
    createToolbox([], {
      context: {},
      ...(secretAnswers === undefined ? {} : { secretResolver: secretResolverOf(secretAnswers) }),
    });
  const hasSkillTools = options.skills !== undefined && options.skills.includeTools !== false;
  const fallbackToolbox: BureauToolbox =
    options.toolbox !== undefined || hasSkillTools ? baseToolbox : createUnavailableToolbox();

  const configuredGenerate: GenerateFunction | undefined =
    options.generate === undefined ? undefined : applyCache(options.generate, options.cache, kv);

  /**
   * The guardrail configuration in force for this composition, with `false`
   * narrowed away so a caller sees a real configuration or nothing.
   *
   * AB-40 — `undefined` (not configured) wires the enabled-by-default preset;
   * `false` opts out entirely; anything else replaces the preset. A pure
   * function of `options`, hoisted to composition scope because
   * {@link createBureauInvariantHooks} needs the same answer for a run that
   * never goes through `createRunRuntime` at all.
   */
  function resolveGuardrailsConfiguration(): GuardrailsOptions | undefined {
    const resolved =
      options.guardrails === undefined ? createDefaultGuardrailsPreset() : options.guardrails;
    return resolved === false ? undefined : resolved;
  }

  /**
   * The Bureau invariants that do not close over a run (COR-1265 criterion 3b,
   * owner ruling 2026-09-20).
   *
   * A catalog-dispatched run resolves its provider, toolbox, memory and skills
   * through the catalog agent's OWN `OPERATIVE_RESOLVE_RUN_OPTIONS`, never
   * through `createRunRuntime` — that separation is AB-240's point and its
   * rollback trigger. Bureau's hooks were absent from those runs entirely, which
   * was survivable only while no tier reached them at all; once the agent tier
   * became real, a catalog run would carry its agent's hooks and none of
   * Bureau's policy, which contradicts COR-567's non-bypassable invariants.
   *
   * The whole Bureau tier cannot travel there. `bureau:memory-recall`,
   * `bureau:memory-persist`, the skill hooks and `bureau:skill-record-snapshot`
   * close over this run's session, memory and skill session, and a catalog run
   * has none of them. The three that close over composition-level configuration
   * only — the identity prompt and both guardrails — do, and they are exactly
   * the registrations COR-567's "non-bypassable Bureau invariant hooks" section
   * names.
   *
   * A fresh registry, and a fresh `createGuardrails`, per call: the guardrail
   * carries per-run taint state, so sharing one across catalog runs would leak
   * one run's detections into another.
   *
   * Every catalog path carries these, and so does a child a Bureau-owned run dispatches
   * (`bureauChildInvariants`): an agent exposing no `OPERATIVE_RESOLVE_RUN_OPTIONS` has no
   * `RunOptions` for anyone to augment, so it is refused rather than run without them (COR-2106).
   * See `documentation/hierarchical-hook-composition.md`.
   */
  function createBureauInvariantHooks(
    goalAttempt?: GoalAttemptTarget,
    invariantOptions?: BureauInvariantOptions,
  ): HookRegistry<OperativeHookMap> {
    const invariants = new HookRegistry<OperativeHookMap>({ source: BUREAU_HOOK_TIER });
    // First, so no other `prepareStep` handler (the guardrail scan included)
    // runs for a step the goal no longer allows. This is the one invariant that
    // closes over a run, and only a goal attempt's run is given it.
    if (goalAttempt !== undefined && dependencies.goalAttemptFence !== undefined) {
      registerGoalAttemptFence(invariants, dependencies.goalAttemptFence, goalAttempt, {
        runtime: runtimeServices,
      });
    }
    if (options.identity) {
      registerIdentityInvariant(invariants, options.identity);
    }
    // COR-1367 — an agent that resolves its own guardrails was handed this
    // bureau's policy through `inheritedGuardrails` (see
    // `catalogRunGuardrailsContext`) and applies it in its own tier, so
    // registering it here as well would run the same policy twice.
    const guardrailsConfig =
      invariantOptions?.agentResolvesGuardrails === true
        ? undefined
        : resolveGuardrailsConfiguration();
    if (guardrailsConfig) {
      const seam = invariantOptions?.sessionTaint;
      registerGuardrailInvariants(
        invariants,
        createGuardrails(withSessionTaint(guardrailsConfig, seam, seam?.runId)),
      );
    }
    return invariants;
  }

  /**
   * COR-2106 — what a Bureau-owned run hands the children it dispatches
   * (`bureauInvariantsField`): Bureau's identity and guardrail tier, and (COR-2127) the plugin tier,
   * fresh registries per child. The single seam through which both reach a child.
   */
  const bureauChildInvariants: BureauChildInvariants = (request) => ({
    bureau: createBureauInvariantHooks(undefined, request),
    plugin: pluginHookTier(options.agentContributions, request.agentTier),
  });

  /** {@link RuntimeComposition.composeRunHooks}. */
  const composeHooks = (tiers: RunHookTiers): HookRegistry<OperativeHookMap> =>
    composeRunHooks(options.agentContributions, tiers);

  const core: CompositionCore = {
    options,
    dependencies,
    maximumSteps,
    systemPrompt,
    diagnose,
    runtimeServices,
    catalogResolverGate,
    workflowVersionMismatches,
    unrebuildableRecoveredRuns,
    scheduledFireScheduleIds,
    catalogRunRecoveryCache,
    pendingScheduledTaints,
    pendingTaintKey,
    scheduleFireEvents,
    skillEvents,
    effectiveStorage,
    storageFence,
    durableStorage,
    kv,
    durable,
    effectiveStorageIsPersistent,
    effectiveObservability,
    logStore,
    memory,
    memoryTenantId,
    skillCatalog,
    skillsConfigured,
    hasSkillTools,
    sessionStore,
    secretAnswers,
    baseToolbox,
    fallbackToolbox,
    configuredGenerate,
    bureauChildInvariants,
    get compositionOpen() {
      return compositionOpen;
    },
    get requestAuthorityValidator() {
      return requestAuthorityValidator;
    },
    get catalogAgentRunOptionsResolver() {
      return catalogAgentRunOptionsResolver;
    },
    get catalogResolverGateOpen() {
      return catalogResolverGateOpen;
    },
    get catalogResolverAbandonedReason() {
      return catalogResolverAbandonedReason;
    },
  };
  const peers: CompositionPeers = {
    get sessionTaintSeamFor() {
      return sessionTaintSeamFor;
    },
    get composeHooks() {
      return composeHooks;
    },
    get readSessionSkillSnapshot() {
      return readSessionSkillSnapshot;
    },
    get createRunRuntime() {
      return createRunRuntime;
    },
    get mediaOptionsFor() {
      return mediaOptionsFor;
    },
    get resolveGuardrailsConfiguration() {
      return resolveGuardrailsConfiguration;
    },
    get awaitCatalogAgentRunOptionsResolver() {
      return awaitCatalogAgentRunOptionsResolver;
    },
    get resolveSessionAgentRun() {
      return resolveSessionAgentRun;
    },
  };
  const {
    persistCatalogRunRecoveryRecord,
    claimCatalogRunRecoveryRecord,
    loadCatalogRunRecoveryRecord,
    deleteCatalogRunRecoveryRecord,
    fenceGoalAttemptRecoveryRecord,
    isCatalogRecoveredRun,
    classifyCatalogRecoveredRun,
    clearCatalogRunRecoveryCache,
  } = createCatalogRunRecovery(core, peers);
  const {
    loadScheduleIdForRecoveredRun,
    loadExistingScheduledSessionId,
    readCommittedScheduledSkillSnapshot,
    readSessionSkillSnapshot,
    buildScheduledRunServices,
  } = createScheduledRunServices(core, peers);
  const { holdToModelPolicy, governedByChat, mediaOptionsFor, createRunRuntime } =
    createRunRuntimeSeam(core, peers);
  const { awaitCatalogAgentRunOptionsResolver, resolveSessionAgentRun, buildRunDepsFromSession } =
    createSessionAgentRuns(core, peers);

  /**
   * AB-240: `resolveRunServices`'s catalog branch — resolves a recovered
   * catalog-dispatched run's deps through the CATALOG AGENT's own
   * `OPERATIVE_RESOLVE_RUN_OPTIONS` (via `catalogAgentRunOptionsResolver`,
   * wired by `createBureau`), never through `buildRunDepsFromSession` /
   * the Bureau's own runtime composition — reattaching a catalog run
   * against the Bureau's default provider/tools instead of the agent's own
   * is this feature's rollback trigger.
   */
  async function resolveCatalogAgentRunServices(
    runId: string,
    record: CatalogRunRecoveryRecord,
  ): Promise<WorkflowServicesResolution> {
    const authority =
      options.workspace === undefined
        ? undefined
        : await recoverRunWorkspaceAuthority(
            options.workspace,
            record.workspaceAuthority,
            record.principal,
          );
    if (options.workspace !== undefined && authority === undefined)
      return { status: 'unavailable', reason: 'Workspace authority unavailable.' };
    const baseContext = normalizeRunRequestContext(
      undefined,
      runId,
      record.contextId ?? runId,
      record.agentName,
      record.principal,
    );
    const workspaceContext: ToolRequestContext =
      authority === undefined
        ? baseContext
        : { ...baseContext, authority: { ...baseContext.authority, workspace: authority } };
    const wired = await awaitCatalogAgentRunOptionsResolver(runId);
    if (wired.status === 'absent') {
      return {
        status: 'unavailable',
        reason: `run ${runId}: no catalog agent recovery resolver is configured`,
      };
    }
    if (wired.status === 'abandoned') {
      return { status: 'unavailable', reason: `run ${runId}: ${wired.reason}` };
    }
    const resolution = await wired.resolver(
      record.agentName,
      record.input,
      {
        agentName: record.agentName,
        // The run's own id, as its first dispatch carried, so a row the agent seeds from `input`
        // gets the id it had then (COR-1581) and the options carry the run's id.
        runId,
        // AB-241 review finding: without this, a recovered catalog agent's
        // re-invoked `OPERATIVE_RESOLVE_RUN_OPTIONS` rebuilt `RunOptions` with
        // no `principal` at all, so a resumed run silently lost attribution
        // across a restart.
        ...(record.principal !== undefined ? { principal: record.principal } : {}),
      },
      runId,
      {
        agentDefinitionHash: record.agentDefinitionHash,
        definitionRevision: record.definitionRevision,
        // COR-2230 — the pin the run started with; a record from before it holds neither.
        ...pinOf(record.agentPluginVersion, record.agentOverrideHash),
      },
    );
    if (resolution.status === 'missing-agent') {
      return {
        status: 'unavailable',
        reason: `run ${runId}: catalog agent "${record.agentName}" is no longer in the catalog`,
      };
    }
    if (resolution.status === 'definition-drifted') {
      return {
        status: 'unavailable',
        reason: `run ${runId}: definition-drifted: ${describeDefinitionDrift(record.agentName, resolution.drift)}`,
      };
    }
    if (resolution.status === 'not-durable-capable') {
      return {
        status: 'unavailable',
        reason:
          `run ${runId}: catalog agent "${record.agentName}" no longer supports durable ` +
          `definition resolution (OPERATIVE_RESOLVE_RUN_OPTIONS)`,
      };
    }
    if (resolution.status === 'resolver-failed') {
      return {
        status: 'unavailable',
        reason:
          `run ${runId}: catalog agent "${record.agentName}" could not resolve run options ` +
          `during recovery: ${serializeUnknownError(resolution.error)}`,
      };
    }
    if (
      resolution.agentBinding === undefined &&
      resolution.definitionRevision !== record.definitionRevision
    ) {
      // Pin-and-warn, mirroring AB-10's workflow-version-mismatch precedent
      // (`workflowVersionMismatches` / 'reattach-version-mismatch'): reattach
      // with the catalog's CURRENT definition (the closest available match)
      // rather than fail, but surface the drift for operators.
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message:
          `[bureau] Catalog agent "${record.agentName}" definition revision changed since ` +
          `run ${runId} was checkpointed (was ${record.definitionRevision}, now ` +
          `${resolution.definitionRevision}); reattaching with the current definition.`,
      });
    }
    // COR-1265 criterion 3b. AB-240's separation is about the PROVIDER and the
    // TOOLBOX — a recovered catalog run must reattach against the agent's own,
    // not the Bureau's, and that is unchanged here. Only the hook tier is added,
    // and only the invariants that close over nothing run-specific, so Bureau's
    // identity and guardrail policy hold on this path as they do on every other.
    // The agent's own tier arrives inside `resolution.options.hooks`, from its
    // own `buildRunOptions`; Bureau goes first so it wins `runFirst` and, being
    // pinned last, still wins the waterfall.
    // A recovered goal attempt's run is fenced exactly as a fresh one is: a run
    // the goal ended over, which a crash left to be resumed here, takes no step.
    const invariants = createBureauInvariantHooks(
      record.goalAttempt === undefined
        ? undefined
        : {
            goalRunId: record.goalAttempt.goalRunId,
            attemptIndex: record.goalAttempt.attemptIndex,
            runId,
          },
      { agentResolvesGuardrails: resolution.agentResolvesGuardrails === true },
    );
    // COR-1577 — a recovered `bureau.run()` run is offered `requestHumanInput` again, exactly
    // when its fresh dispatch was: the option is on, the engine is durable, and it is neither a
    // child nor a goal attempt. The tool parks through the services object being returned, so
    // that object is captured once it exists, as `buildRunDepsFromSession` does.
    // COR-1710 — the grant recorded when the task started; one recorded before grants were
    // resumes with the settings now.
    const catalogGrant = grantedTools(
      record.tools ?? (await dependencies.toolGrantFor?.(runId)),
      options,
    );
    const offersHumanInput =
      catalogGrant.humanInput &&
      durable !== undefined &&
      record.goalAttempt === undefined &&
      record.workflowStep === undefined &&
      resolution.recoveredChild !== true;
    const humanInputServices: { current?: DurableRunDeps } = {};
    // COR-1709: the `decide` tool is offered on exactly the runs `requestHumanInput` is, but is
    // independent of the `humanInput` option.
    const offersDecide =
      durable !== undefined &&
      record.goalAttempt === undefined &&
      record.workflowStep === undefined &&
      resolution.recoveredChild !== true;
    const decide = offersDecide
      ? dependencies.decideToolFor?.(ownerOrLocal(record.principal), catalogGrant.decide)
      : undefined;
    const chatToolbox = governedByChat(resolution.options.toolbox, runId);
    const toolbox =
      offersHumanInput || decide !== undefined
        ? wireDurableOptInTools(chatToolbox, humanInputServices, {
            humanInput: offersHumanInput,
            inputSchemas: catalogGrant.inputSchemas,
            wakeup: false,
            runId,
            ...(decide === undefined ? {} : { decide }),
            humanInputEmitter: {
              dispatchEvent: (event: Event) => {
                const target = humanInputServices.current?.emitter;
                return hasDispatchEvent(target) ? target.dispatchEvent(event) : false;
              },
            },
          })
        : chatToolbox;
    const services: DurableRunDeps = {
      options: {
        // COR-1996: held to the model policy as a fresh dispatch's generate is.
        ...guardWorkspaceRunOptions(
          options.workspace,
          holdToModelPolicy(resolution.options, resolution.generationMode),
          workspaceContext,
        ),
        // The run's owner of record resolves its assets and holds the same
        // unverified-asset policy as on a fresh dispatch, unless the agent set its own.
        ...unsetMediaOptions(
          resolution.options,
          mediaOptionsFor(ownerOrLocal(record.principal), 'run'),
        ),
        toolbox,
        hooks: composeHooks({ bureau: invariants, agent: resolution.options.hooks }),
        // COR-2106 — children this run dispatches carry Bureau's tier.
        ...bureauInvariantsField(bureauChildInvariants),
      },
      toolbox,
    };
    services.childWaitPrincipal = ownerOrLocal(record.principal);
    services.requestChildWait = (request) => {
      if (services.childWaitPrincipal !== request.principal)
        return { parked: false, reason: 'unauthorized' };
      if (
        services.pendingChildWait !== undefined ||
        services.pendingHumanWait !== undefined ||
        services.pendingWakeup !== undefined
      )
        return { parked: false, reason: 'already-parked' };
      services.pendingChildWait = { schemaVersion: 1, ...request };
      return { parked: true };
    };
    dependencies.configureDurableRun?.(runId, services, ownerOrLocal(record.principal));
    humanInputServices.current = services;
    return { status: 'available', services };
  }

  /**
   * Weft's `resolveWorkflowServices` resolver: re-provide a recovered run's deps
   * on a fresh-process resume. Weft fires it (per recovered inline run that was
   * launched with `services`) BEFORE the generator advances, passing the run's
   * `workflowId` — which equals our `runId`, since `engine.start` pins
   * `{ id: runId }`. Finds the owning `running` session, rebuilds its deps, and
   * returns `{ status: 'available', services }`; a run with no reconstructable
   * session returns `{ status: 'unavailable' }`, which fails just that one run
   * (terminal `failed`) without aborting recovery or the engine.
   *
   * When the owning session exists and is `running` but its deps cannot be rebuilt
   * here (`buildRunDepsFromSession` throws — e.g. no `generate` configured on this
   * process), it best-effort reconciles that session to `error` before returning
   * unavailable, so the session metadata is not left stuck `running` for a run the
   * engine is about to fail. This is the resolver's one write; it is keyed on the
   * session it just loaded (no race) and swallowed on failure.
   *
   * Idempotent: once a session is reconciled to `error`, the `=== 'running'`
   * predicate above no longer matches it on a later boot, so it falls through to
   * the no-running-session return and is never re-failed or re-written.
   */
  async function resolveRunServices(
    info: WorkflowServicesResolverInfo,
  ): Promise<WorkflowServicesResolution> {
    // The engine's background tasks are armed at engine construction, before this closure's later
    // dependencies (sessionStore, createRunRuntime deps) are initialized. A tick or a reclaim that
    // reaches this resolver mid-construction waits for the composition instead of being answered
    // "unavailable", which the engine would turn into a terminal failure of the run. (Reading a
    // not-yet-initialized `const` below would otherwise throw a TDZ error.)
    if (!compositionOpen) {
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message:
          `[bureau] Run "${info.workflowId}" reached recovery before the bureau finished ` +
          `composing; holding it until composition completes.`,
      });
    }
    try {
      await readiness.promise;
    } catch {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId}: composition failed`,
      };
    }
    // COR-1527: an instance of a workflow file runs the interpreter, which reads no services.
    if (dependencies.isWorkflowFileType?.(info.workflowType) === true) {
      return { status: 'available', services: undefined };
    }
    if (!sessionStore) {
      return { status: 'unavailable', reason: 'no session store configured' };
    }
    // AB-240: `bureau.run()`'s durable catalog dispatch persists its OWN
    // recovery record (agent name + a stable definition revision + the
    // original input), keyed by workflowId, entirely independent of
    // `sessionStore`'s lastRunId/lastRunStatus correlation — a catalog run
    // deliberately never owns a bureau session. Check for it FIRST: when
    // present it is authoritative and bypasses every guard below (scheduler
    // origin, session ownership), none of which apply to a catalog run.
    const catalogRecovery = await loadCatalogRunRecoveryRecord(info.workflowId);
    if (catalogRecovery.status === 'read-error') {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId}: catalog recovery record unreadable`,
      };
    }
    if (catalogRecovery.status === 'found') {
      // AB-241 review finding: cache the successfully decoded record so
      // `classifyCatalogRecoveredRun` (called from `onRecoveredWorkflow`,
      // always AFTER this resolver for the same workflow) reuses this exact
      // read instead of issuing its own independent one.
      catalogRunRecoveryCache.set(info.workflowId, catalogRecovery.record);
      return resolveCatalogAgentRunServices(info.workflowId, catalogRecovery.record);
    }
    // NATIVE SCHEDULED FIRE (#109/#126): Weft sets `info.schedule` for a live
    // schedule tick, and (Weft 0.10+) also derives it from durable schedule
    // metadata when re-providing services on recovery — so `info.schedule` alone
    // does not distinguish live from recovered. Some recovered fires (older
    // stores, or a schedule whose metadata could not be resolved) may only carry
    // the persisted ScheduledAgentRunInput, so recovery must also check the
    // persisted schedule marker written by createAgentSchedule(); the broad
    // `{ agentName, input }` shape alone is not enough to bypass the interactive
    // session-ownership guards below.
    let recoveredScheduleMarker =
      info.schedule === undefined &&
      isScheduledAgentRunInput(info.input) &&
      !hasPersistedScheduleMarker(info.input)
        ? await loadScheduleIdForRecoveredRun(info.workflowId)
        : undefined;
    if (
      recoveredScheduleMarker !== undefined &&
      recoveredScheduleMarker.status !== 'found' &&
      isScheduledAgentRunInput(info.input)
    ) {
      try {
        const sessionId = await loadExistingScheduledSessionId(
          sessionStore,
          info.input,
          info.workflowId,
        );
        if (sessionId !== undefined)
          recoveredScheduleMarker = { ...recoveredScheduleMarker, sessionId };
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'recovery',
          message: `[bureau] Could not inspect scheduled session proof for recovered run "${info.workflowId}"; continuing without scheduled-fire classification: ${serializeUnknownError(error)}`,
        });
      }
    }
    if (
      info.schedule !== undefined ||
      (isScheduledAgentRunInput(info.input) &&
        (hasPersistedScheduleMarker(info.input) ||
          recoveredScheduleMarker?.status === 'found' ||
          recoveredMarkerSessionId(recoveredScheduleMarker) !== undefined))
    ) {
      return buildScheduledRunServices(info, sessionStore, recoveredScheduleMarker);
    }
    // The owning session id rides in the run's durable input (Weft passes the
    // persisted `input` to the resolver on recovery — see #2), so load the
    // session DIRECTLY by id, with no `sessionStore.list()` scan or
    // lastRunId/lastRunStatus correlation. A run whose input predates the
    // sessionId field (or is not an agentRun) fails the guard and is treated as
    // not-reconstructable — no compatibility fallback for cross-upgrade runs.
    if (!isAgentRunWorkflowInput(info.input)) {
      return { status: 'unavailable', reason: `run ${info.workflowId} has no recoverable session` };
    }
    // SCHEDULER-ORIGIN GUARD (#25, #44): Weft 0.7 includes launch metadata in
    // WorkflowServicesResolverInfo, so new scheduler-origin runs discriminate by
    // their explicit launch tag instead of the old synthetic-input shape. Keep
    // the prefix check only as legacy cleanup for persisted scheduler runs
    // created before resolver launch context was available.
    const schedulerOriginByLaunchTag =
      info.launchOptions?.tags?.includes(SCHEDULER_ORIGIN_TAG) ?? false;
    const legacySchedulerOriginBySyntheticInput =
      info.input.sessionId === info.input.runId &&
      info.input.runId.startsWith(SCHEDULER_RUN_ID_PREFIX);
    if (schedulerOriginByLaunchTag || legacySchedulerOriginBySyntheticInput) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} is scheduler-origin (no session to recover)`,
      };
    }
    // CORRELATION GUARD (committee MF-5): the workflow id IS the run id (pinned at
    // engine.start), so the input's own runId must match. A mismatch means a
    // corrupt or crafted durable input is trying to correlate this run to a
    // foreign session — fail closed (no session load, no reconcile write) rather
    // than rebuild deps for / write to a session the input doesn't legitimately own.
    if (info.input.runId !== info.workflowId) {
      return { status: 'unavailable', reason: `run ${info.workflowId} input runId mismatch` };
    }
    const sessionId = info.input.sessionId;
    const session = await sessionStore.load(sessionId);

    // The session must still OWN this run AND be IN-FLIGHT (its `lastRunId`
    // matches the workflow id AND `lastRunStatus` is `running`) before we rebuild
    // its deps (committee/Bugbot review: recovery skips session-run ownership).
    // The status check is load-bearing, not just symmetric with the post-recover
    // gate in create-bureau: the resolver fires DURING `recoverAll()` and resuming
    // a run whose session already says `completed`/`error` would let it advance
    // (model/tool SIDE EFFECTS) before the post-recover gate could cancel it —
    // too late. A durable input pointing at a session owning a DIFFERENT run, or
    // at an already-terminal session, fails closed with NO session write.
    if (
      !session ||
      session.metadata['lastRunId'] !== info.workflowId ||
      session.metadata['lastRunStatus'] !== 'running'
    ) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} not owned by a running session`,
      };
    }

    const recoveredAuthority = recoveredRequestContext(
      session.metadata,
      info.workflowId,
      sessionId,
      info.input.agentName,
      runtimeServices.clock.now,
    );
    if (!recoveredAuthority) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} request authority is unavailable during recovery`,
      };
    }
    const recoveredAuthorizationRevision = recoveredAuthority.authority.authorizationRevision;
    const requiresTransportValidation =
      options.workspace !== undefined ||
      (recoveredAuthorizationRevision !== 'bureau:1' &&
        recoveredAuthorizationRevision !== 'bureau:scheduler:1');
    if (requestAuthorityValidator === undefined && requiresTransportValidation) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} authority cannot be revalidated during recovery`,
      };
    }
    if (
      requiresTransportValidation &&
      requestAuthorityValidator &&
      !(await requestAuthorityValidator(recoveredAuthority))
    ) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} authority is no longer current`,
      };
    }

    let services: DurableRunDeps;
    try {
      // info.workflowId === the run id (pinned at engine.start) — thread it so the
      // recovered run's memory-persist idempotency key matches its pre-crash key.
      // info.input.agentName is guaranteed non-empty here: isAgentRunWorkflowInput
      // requires a non-empty string (the guard returned earlier if it's missing).
      services = await buildRunDepsFromSession(session, info.workflowId, info.input.agentName);
    } catch (error) {
      // The session exists, but its deps cannot be rebuilt on this process (e.g.
      // no `generate`/provider configured here, so `createRunRuntime` throws).
      // Weft will fail this run terminally pre-replay; the reattached handle then
      // rejects and its adapter stays write-free — so without this reconcile the
      // session would be left stuck `running`. We have the sessionId in hand, so
      // reconcile it to `error` synchronously on the boot path (not a racy
      // detached write).
      const reason = error instanceof Error ? error.message : String(error);
      unrebuildableRecoveredRuns.add(info.workflowId);
      // COR-1911 — a tried agent lives in memory and nowhere else, so a restart loses it and its
      // run cannot be rebuilt. The recovery report lists the run; this names why.
      if (isTryAgentName(info.input.agentName)) {
        diagnose({
          level: 'warn',
          scope: 'agent-try',
          message: `[bureau] Run "${info.workflowId}" (session ${sessionId}) of a tried agent cannot be recovered: try agent not reconstructable after restart. The agent was held in memory only; delete the chat.`,
          cause: error,
        });
      }
      try {
        await sessionStore.updateMetadata(sessionId, {
          lastRunStatus: 'error',
          lastFinishReason: 'error',
          lastError: `Recovered run could not be reconstructed: ${reason}`,
        });
      } catch (writeError) {
        // Reconciliation is best-effort — a failed write must not abort the rest
        // of recovery — but it is NOT silent: a session left stale `running`
        // cannot be repaired by a later boot (the run is already terminal
        // `failed` and is skipped), so surface it for operators.
        diagnose({
          level: 'error',
          scope: 'session-persistence',
          message:
            `[bureau] Failed to reconcile unrecoverable run "${info.workflowId}" ` +
            `(session ${sessionId}) to error: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
        });
      }
      return { status: 'unavailable', reason: `run ${info.workflowId} not reconstructable` };
    }
    // `services` is never null here: the owning-session check above already
    // guarantees a non-null `session`, and `buildRunDepsFromSession` only
    // returns null for a null session — so its return type's `| null` is a
    // defensive contract for OTHER callers (this file's own
    // `resolveCatalogAgentRunServices` and `buildScheduledRunServices` never
    // call it; a future caller might), not a branch reachable from here. A
    // dead `if (services === null)` fail-closed used to guard this anyway,
    // covered only by forcing it through a private mutation seam (AB-260
    // retired both).
    return { status: 'available', services };
  }

  // Every closure dependency the resolver reads is now initialized; open the gate
  // so scheduler-poller ticks (and the bureau's subsequent `recoverAll()`) resolve.
  compositionOpen = true;
  readiness.resolve();

  const composition: RuntimeComposition = {
    kv,
    secretAnswers,
    durable,
    workflowVersionMismatches,
    unrebuildableRecoveredRuns,
    scheduleFireEvents,
    skillEvents,
    stopUsingStorage: () => storageFence?.close(),
    durableStorage,
    memory,
    sessionStore,
    // Exposed so the review queue (`reviews.resolve`) can call `resumeApproval()`
    // on the SAME toolbox instance (or any `.extend()` clone of it, which
    // preserves `approvalSecret` — see armorer's `extend()`) that executed the
    // original tool call. `resumeApproval` re-invokes the tool by name/callId,
    // so any toolbox sharing this instance's `approvalSecret` and tool set can
    // resume a signed pending approval, not only the specific per-run clone.
    baseToolbox,
    withChatPermission: governedByChat,
    holdToModelPolicy,
    setRequestAuthorityValidator(validator) {
      requestAuthorityValidator = createRunAuthorityValidator(options.workspace, validator);
    },
    setCatalogAgentRunOptionsResolver(resolver) {
      catalogAgentRunOptionsResolver = resolver;
      if (resolver !== undefined) openCatalogResolverGate();
    },
    abandonCatalogAgentRunOptionsResolver(reason) {
      if (dependencies.awaitsCatalogAgentRunOptionsResolver !== true) return;
      catalogResolverAbandonedReason ??= reason;
      openCatalogResolverGate();
    },
    persistCatalogRunRecoveryRecord,
    claimCatalogRunRecoveryRecord,
    loadCatalogRunRecoveryRecord,
    deleteCatalogRunRecoveryRecord,
    fenceGoalAttemptRecoveryRecord,
    isCatalogRecoveredRun,
    classifyCatalogRecoveredRun,
    clearCatalogRunRecoveryCache,
    mediaOptionsFor,
    ready: options.generate !== undefined,
    maximumSteps,
    systemPrompt,
    createRunRuntime,
    // AB-260: folded onto the returned object directly — see the interface's
    // own doc comments for why these are genuine capabilities of this
    // composition rather than test-only introspection.
    resolveRunServices,
    buildScheduledRunServices,
    readCommittedScheduledSkillSnapshot,
    readSessionSkillSnapshot,
    createBureauInvariantHooks,
    bureauChildInvariants,
    composeRunHooks: composeHooks,
    sessionTaintSeam: sessionTaintSeamFor,
    pendingScheduledTaintCount: () => pendingScheduledTaints.size,
    resolveSessionAgentRun,
  };

  return composition;
}
