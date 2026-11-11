import type { EventMap } from '@lostgradient/lifecycle';
import type { SecretAnswerStore } from './secret-answers';
import { TypedEventTarget, HookRegistry } from '@lostgradient/lifecycle';
import type { RunHookTiers } from './run-hook-tiers';
import type { GovernedMemory } from '@lostgradient/memory';
import type {
  HumanInputSchema,
  RunOptions,
  GenerationMode,
  AgentInput,
  AgentRunContext,
  DurableRunDeps,
  AgentSession,
  ContentSourceResolver,
  GeneratedMediaAdmitter,
  RegistryAgnosticEngine,
  CheckpointStore,
  RunEngineObservability,
  SessionStore,
  JSONValue,
  GenerateFunction,
  OperativeHookMap,
  BureauChildInvariants,
  GuardrailsOptions,
  StopCondition,
} from '@lostgradient/operative';
import {
  createSessionStore,
  ScheduleCompletedEvent,
  ScheduleFailedEvent,
  ScheduleAttemptedEvent,
  ScheduleSkippedEvent,
} from '@lostgradient/operative';
import type { SkillActivationRecord, SkillEventMap } from './skills';
import type { DecideToolWiring } from './decisions/decide-tool';
import type { TaskToolGrant } from './task-registry';
import type { ChatPermissionReading } from './tool-approval';
import type {
  AnyWorkflowDefinition,
  RecoverAllOptions,
  WorkflowLogStore,
  WorkflowServicesResolverInfo,
  WorkflowServicesResolution,
} from '@lostgradient/weft';
import type { ConditionalTextValueStore, Storage } from '@lostgradient/storage';
import type { AnyToolbox, ToolRequestContext } from 'armorer';
import type { FileAgentBinding } from './agent-file-catalog';
import type { GoalAttemptFence, GoalAttemptTarget } from './goal-attempt-fence';
import type { MissedFireBuffer } from './bureau-event-forwarders';
import type {
  SessionTaintPublication,
  SessionTaintSource,
  SessionTaintSeam,
} from './session-taint-seam';
import type {
  CreateRunRequest,
  SkillRuntimeConfiguration,
  CacheConfiguration,
  BureauOptions,
} from './types';
import type { ModelPolicySource } from './code-agent-model-policy';
import type {
  CatalogRunRecoveryLoad,
  CatalogRunRecoveryRecord,
  GoalAttemptClaimFence,
  GoalAttemptClaimOwner,
} from './catalog-run-recovery-record';
import type { RecoveredScheduleMarker } from './schedule-run-marker';

export type BureauToolbox = AnyToolbox;
/**
 * The narrow surface `requestHumanInput` needs to dispatch its
 * `HumanWaitParkedEvent` (matches `create-request-human-input-tool.ts`'s own
 * private `HumanInputEventDispatcher` structurally, without importing it).
 */
export interface HumanWaitEventDispatcher {
  dispatchEvent(event: Event): boolean;
}
export interface WireDurableOptInToolsOptions {
  /** Wires `requestHumanInput` in when true (AB-13/AB-41/AB-43). */
  readonly humanInput?: boolean;
  /**
   * COR-1709 — wires the `decide` tool in when present. It needs no durable services, but the
   * callers offer it to exactly the runs that are offered `requestHumanInput`.
   */
  readonly decide?: DecideToolWiring | undefined;
  /**
   * COR-1674 — per-signal answer schemas handed to `requestHumanInput`. Ignored when `humanInput`
   * is falsy. Every wiring site, fresh and recovered, passes the same map.
   */
  readonly inputSchemas?: Readonly<Record<string, HumanInputSchema>> | undefined;
  /** Wires `scheduleWakeup` in when true (AB-201). */
  readonly wakeup?: boolean;
  readonly runId: string;
  /**
   * Where `requestHumanInput`'s `HumanWaitParkedEvent` dispatches. Ignored
   * when `humanInput` is falsy. A caller whose real emitter is not yet
   * assigned at wiring time (AB-336 — recovery's `services.emitter` is set
   * by `createRecoveredRunEventSurface` AFTER `buildRunDepsFromSession`
   * returns, but this wiring happens INSIDE it) passes a lazy forwarder
   * instead of the emitter itself; the tool only calls `dispatchEvent` at
   * actual tool-call time, by which point a lazy forwarder's target has
   * settled.
   */
  readonly humanInputEmitter?: HumanWaitEventDispatcher;
}
/**
 * What a run's runtime is composed from. `agentName` stays optional here: a recovered run with no
 * stored agent is an internal caller that name none, and the memory
 * collection falls back through the request context to the implicit Bureau agent.
 */
export type RunRuntimeRequest = Omit<CreateRunRequest, 'agentName'> & {
  agentName?: string;
  sessionId: string;
  runId?: string;
};
/**
 * The outcome of re-resolving a catalog agent's `RunOptions` during boot
 * recovery — `resolveRunServices`'s catalog branch consults
 * `catalogAgentRunOptionsResolver` (wired by `createBureau` from its own
 * agent catalog, which `createRuntimeComposition` deliberately does not know
 * about — see this file's own `RuntimeCompositionOptions` doc comment) rather
 * than reaching into the catalog directly.
 */
export type CatalogAgentRunOptionsResolution =
  | {
      status: 'resolved';
      options: RunOptions;
      definitionRevision: number;
      /**
       * COR-1367 — the agent resolved its own guardrails (`resolvesOwnGuardrails`),
       * so recovery registers no Bureau guardrail invariant on top, exactly as
       * the run's fresh dispatch did not.
       */
      agentResolvesGuardrails?: boolean;
      /** COR-2385 — the `taintThreshold` the agent declares in its own guardrails, when it does. */
      agentTaintThreshold?: number;
      /**
       * COR-1996 — the agent's generation mode (`readGenerationProfile`), which the model policy
       * reads to tell a fixed agent, whose provider ignores a steered model, from a selectable
       * one. Required, so a resolver cannot leave an agent out of the policy by omitting it.
       */
      generationMode: GenerationMode;
      /**
       * COR-1577 — the run is a recovered child of another run (its resolver found a topology
       * record), which is never offered `requestHumanInput`.
       */
      recoveredChild?: boolean;
      /**
       * COR-1524 — set when the agent is file-based: the definition the options were resolved
       * from, which is the snapshot a recorded run asked for, or the file's current definition
       * for a run that is starting.
       */
      agentBinding?: FileAgentBinding;
    }
  | { status: 'missing-agent' }
  /**
   * The named agent exists in the catalog but does not (or no longer)
   * expose AB-21's `OPERATIVE_RESOLVE_RUN_OPTIONS` — distinct from
   * `'missing-agent'` (review finding: conflating the two produced the
   * misleading "is no longer in the catalog" reason for an agent that
   * genuinely IS still there, just not durable-resolution-capable). This is
   * reachable at recovery even though live dispatch only reaches the
   * durable branch for a resolver-exposing agent: the catalog can be
   * reconfigured between restarts to swap the same name to a different
   * `RunnableAgent` that lacks the capability.
   */
  | { status: 'not-durable-capable' }
  | { status: 'resolver-failed'; error: unknown };
export type CatalogAgentRunOptionsResolver = (
  agentName: string,
  input: AgentInput,
  context: AgentRunContext,
  /**
   * COR-772 — the recovered workflow's run identifier, so a resolver can
   * restore run-scoped context the recovery record does not carry (a
   * recovered child's parent-signal port and correlation).
   */
  runId: string,
  /**
   * COR-1524 — present when the run already started and is being resumed: the definition hash it
   * recorded, or `undefined` for a code-defined agent. A hash makes the resolver build the agent
   * from the run's snapshot; absent altogether means a run that is starting, which resolves the
   * agent as it is now.
   */
  recorded?: CatalogRunRecordedDefinition,
) => Promise<CatalogAgentRunOptionsResolution>;
/**
 * COR-1577 — a catalog agent resolved for a session run: the run options its own definition
 * resolves, which a session run reads its `generate`, toolbox, hooks, stop conditions and step
 * and token caps from, and the system prompt its definition would seed a new conversation with.
 */
export interface SessionAgentRun {
  readonly agentName: string;
  readonly options: RunOptions;
  readonly definitionRevision: number;
  /** COR-1524 — the file definition the run is built from, when the agent is file-based. */
  readonly agentBinding?: FileAgentBinding;
  readonly agentResolvesGuardrails: boolean;
  /** COR-2385 — the `taintThreshold` the agent declares in its own guardrails, when it does. */
  readonly agentTaintThreshold?: number;
  /** COR-1996 — the agent's generation mode, which the model policy judges its steps by. */
  readonly generationMode: GenerationMode;
  /** The agent's own system prompt, or `undefined` when its definition declares none. */
  readonly instructions: string | undefined;
}
export type SessionAgentRunResolution =
  | { status: 'resolved'; run: SessionAgentRun }
  | Exclude<CatalogAgentRunOptionsResolution, { status: 'resolved' }>;
/**
 * COR-1524, COR-1584 — the definition a run being resumed recorded: the hash of the agent file it
 * started with (`undefined` for a code-defined agent), and the definition revision it started at
 * (`undefined` when its record names none). The resolver rebuilds a file agent from the snapshot
 * under the hash, and the rebuilt agent reports the revision, not the revision the file has
 * reached since: one snapshot is keyed by content, so it can have been several revisions.
 */
export interface CatalogRunRecordedDefinition {
  readonly agentDefinitionHash: string | undefined;
  readonly definitionRevision?: number | undefined;
}
/**
 * Who keeps the managed assets a run's rows reference (COR-1581): the session the run writes into,
 * or, for a run with no session, the run itself.
 */
export type MediaRowHolder = 'session' | 'run';
export type RuntimeCompositionDependencies = {
  /** Configures live and recovered durable catalog-run services. */
  configureDurableRun?:
    ((runId: string, services: DurableRunDeps, principal: string) => void) | undefined;
  /**
   * Builds the session store this composition uses over its resolved KV
   * view. Defaults to operative's own `createSessionStore` — the real
   * production wiring. A caller (test or platform package) that supplies a
   * different `SessionStore` implementation here does so through this
   * non-test-gated dependency-injection parameter, not a retired test-only
   * seam: this package's own test suite uses it to exercise `resolveRunServices`' failure-handling
   * branches (a store whose `load`/`updateMetadata` fails) without a
   * private mutation backdoor.
   */
  createSessionStore?: typeof createSessionStore;
  /**
   * COR-718 — `CreateSessionStoreOptions.beforeCleanup` for the session store this
   * composition builds: told which sessions `cleanup()` is about to expire, before
   * they are removed, and able to keep them by rejecting. `createBureau` records
   * each one's owner for its deletion's audit entry.
   */
  beforeSessionCleanup?: ((sessions: readonly AgentSession[]) => Promise<void>) | undefined;
  /**
   * COR-851 — the durable `goalRun` workflow, registered on the durable engine
   * beside `agentRun`. `createBureau` supplies it; the engine is built before
   * the goal store and the agent catalog exist, so the workflow's ports are
   * bound after composition (see `createGoalWorkflowHost`).
   */
  goalWorkflow?: AnyWorkflowDefinition;
  /**
   * COR-851 — the self-fence a goal attempt's run is registered with, on a fresh
   * start and on recovery alike. `createBureau` supplies a late-bound one, since
   * the goal store it reads does not exist yet; a composition with none runs
   * goal attempts unfenced and has no goals to overtake them.
   */
  goalAttemptFence?: GoalAttemptFence;
  /**
   * COR-1586 — the caller will wire the catalog agent run options resolver
   * (`setCatalogAgentRunOptionsResolver`) once it has built the catalog the resolver reads, which
   * is after this composition exists and after the engine has started reclaiming runs. Set, every
   * reader of the resolver waits while it is unset, instead of answering that it is not
   * configured: that answer is a terminal failure for a run, or a resume under the wrong agent.
   * A caller that wires the resolver itself, or none, leaves this unset and gets the answer at once.
   * `createBureau` sets it, and calls `abandonCatalogAgentRunOptionsResolver` if it will never wire
   * the resolver.
   */
  awaitsCatalogAgentRunOptionsResolver?: boolean;
  /**
   * COR-1510 — the engine's recovery hook, installed when the engine is created. The engine
   * reclaims and resumes runs whose claim has lapsed on its own interval, which can be before
   * `createBureau` calls `recoverAll()` with its hook; a run resumed that way must reach the same
   * hook before its first step, or the bureau never sees that step. `createBureau` supplies a
   * late-bound one that waits until its recovery has started.
   */
  onRecoveredWorkflow?: RecoverAllOptions['onRecoveredWorkflow'];
  /**
   * COR-718 — called when a schedule fire's services are built, with the fire's
   * run, its schedule, and the schedule's owner. `createBureau` records the
   * fire's owner and its `schedule.fired` audit entry here. A fire is rebuilt on
   * recovery, so this can run more than once for one fire; the hook is
   * responsible for recording once.
   */
  onScheduledFire?: (fire: ScheduledFireNotice) => void | Promise<void>;
  /** Queue a durable pause without blocking the scheduler's own serialized fire. */
  onScheduleAuthorityDenied?: (scheduleId: string) => void;
  /**
   * COR-2105 — called once a session's taint is first stored, after the write commits.
   * `createBureau` publishes `session.tainted` from it.
   */
  onSessionTainted?: (publication: SessionTaintPublication) => void;
  /**
   * COR-1482 — called once a schedule fire's run has ended, however it ended: completed, failed,
   * or canceled. `createBureau` settles the fire's task here.
   */
  onScheduledFireSettled?: (settlement: ScheduledFireSettlement) => void | Promise<void>;
  /**
   * COR-1482 — called when a fire's session is known: found when the fire's services are built,
   * or saved by the fire's first step, which is when a fresh session first gets its incarnation.
   * `createBureau` binds the fire's task to it, so the task is found by its context.
   */
  onScheduledSessionKnown?: (session: ScheduledSessionNotice) => void | Promise<void>;
  /**
   * COR-1596 — called once a schedule fire's services are built and before the fire runs, with
   * the services themselves: on a live tick and on a recovered fire alike, because the engine
   * rebuilds a fire's services the same way for both. `createBureau` registers the fire's human
   * waits and tool approvals as pending reviews here, which needs the services' emitter and
   * toolbox. A host that cannot register them is diagnosed and the fire still runs.
   */
  onScheduledFireServices?: (
    fire: ScheduledFireServicesNotice,
    services: DurableRunDeps,
  ) => void | Promise<void>;
  /**
   * COR-1527 — whether `type` is a workflow Bureau registered from a workflow file. An instance of
   * one needs no services: its steps are the host's activities, and its fire or its recovery must
   * not be answered "unrecognized workflow type". Late-bound by the caller, since the workflow
   * files are read after the composition exists.
   */
  isWorkflowFileType?: (type: string) => boolean;
  /**
   * COR-716 — the {@link ContentSourceResolver} a run owned by `principalId` is
   * given, so a managed asset in its input reaches a provider as bytes or a
   * provider-fetched URL. `createBureau` supplies one over its asset service; a
   * composition with none leaves such a part to fail admission, typed, before any
   * provider call. Late-bound by the caller: the asset service is built after this
   * composition, and a run resolves it only when it starts.
   */
  contentSourceResolverFor?: (principalId: string | undefined) => ContentSourceResolver | undefined;
  /**
   * COR-1709 — what a run owned by `principalId` needs to be offered the `decide` tool, or
   * `undefined` when the tool is not offered (`decide: false`, or nothing can answer). Late-bound
   * by `createBureau`: the decisions are built after this composition.
   */
  decideToolFor?: (
    principalId: string | undefined,
    offered: boolean,
  ) => DecideToolWiring | undefined;
  /**
   * COR-1936 — the permission mode of the chat a run belongs to, read when each of the run's tool
   * calls is decided, so a steer applies from the next call; `undefined` for a run that belongs to
   * no chat. A rejection is read as `read-only`. Late-bound by `createBureau`, which holds the
   * steering.
   */
  permissionModeOfRun?: (runId: string) => Promise<ChatPermissionReading | undefined>;
  /**
   * COR-1996 — the model policy now in force and the model catalog, read at every step of a
   * catalog agent's run so that a plugin code agent's generate is held to the policy as a file
   * agent's is. `createBureau` supplies it from its settings and catalog. Without it no code
   * agent's model is judged.
   */
  modelPolicy?: ModelPolicySource;
  /**
   * COR-1710 — the tools task `taskId` was granted when it started, from its admission record;
   * for a task recorded before grants were, the settings now, recorded on it once. Without this,
   * a resumed task is offered what the options say, as before grants existed.
   */
  toolGrantFor?: (taskId: string) => Promise<TaskToolGrant>;
  /**
   * COR-1524 — the definition a file-backed agent's run started with. A scheduled fire records its
   * binding here as a session run does, so recovering it resolves the agent it started with, not the
   * file as it is now. Settlement and release follow the run's store actions. Absent when no agent
   * files are wired.
   */
  agentRunReferences?: {
    reference(
      runId: string,
    ): Promise<{ id: string; hash: string; definitionRevision?: number } | undefined>;
    record(binding: FileAgentBinding, runId: string): Promise<void>;
  };
  /**
   * COR-713: the media-admission port of a run's owning principal, built from the asset service
   * like {@link RuntimeCompositionDependencies.contentSourceResolverFor}. Without an asset service
   * a run has no port, and a generated media part fails typed at its admission point.
   */
  generatedMediaAdmitterFor?: (
    principalId: string | undefined,
    rowHolder: MediaRowHolder,
  ) => GeneratedMediaAdmitter | undefined;
  /**
   * COR-1811 — persist the `ctx.log` lines of durable workflows. Set, the composition creates a Weft
   * log store over the durable storage, feeds it every line the engine emits (the human-wait park
   * marker excepted, and `BureauOptions.onLog` still receives each), and hands it to the engine
   * to serve, flush on shutdown, and clear with a purged run. `maximumLinesPerRun` is read on every
   * line, so a host can change the cap while the engine runs; `undefined` is Weft's default of
   * 500. `onError` is told about a write that failed.
   */
  workflowLogs?: {
    maximumLinesPerRun(): number | undefined;
    onError(error: unknown): void;
  };
};
/** What {@link RuntimeCompositionDependencies.onScheduledFire} is told about one fire. */
export type ScheduledFireNotice = {
  readonly runId: string;
  readonly scheduleId: string | undefined;
  readonly sessionId: string;
  readonly agentName: string;
  /** The schedule's owner of record, which also owns this fire's run and, if it creates one, its session. */
  readonly owner: string;
  /** The text the fire delivers to its agent: the originating message of the fire's task. */
  readonly message: string;
  /** `true` when a person started this fire with `schedules.runNow` instead of the cadence (COR-1829). */
  readonly manual?: true | undefined;
};
/** What {@link RuntimeCompositionDependencies.onScheduledFireSettled} is told about one fire. */
export type ScheduledFireSettlement = {
  readonly runId: string;
  readonly status: 'completed' | 'failed' | 'canceled';
  readonly finishReason: string | undefined;
  /** Why the fire failed, when it did and the engine said. */
  readonly error: string | undefined;
  /** The fire's answer, when it completed with one. */
  readonly content: string | undefined;
};
/** What {@link RuntimeCompositionDependencies.onScheduledFireServices} is told about one fire. */
export type ScheduledFireServicesNotice = {
  readonly runId: string;
  readonly sessionId: string;
  readonly agentName: string;
  /** The request context the fire runs under, which a later approval of its tool resumes under. */
  readonly requestContext: ToolRequestContext;
};
/** What {@link RuntimeCompositionDependencies.onScheduledSessionKnown} is told. */
export type ScheduledSessionNotice = {
  readonly runId: string;
  readonly sessionId: string;
  readonly incarnation: string;
};
/** The run options through which Bureau governs the media a run carries (COR-716). */
export type MediaRunOptions = Pick<
  RunOptions,
  'contentSourceResolver' | 'assetSafety' | 'generatedMediaAdmitter'
>;
/**
 * What the active-skill snapshot of a run says (COR-1620). `verified` with no records is a
 * verified absence of skills. `unverifiable` is the snapshot failing to be read or deserialized,
 * or naming another run: the policy that governed the run is not known.
 */
export type SkillSnapshot =
  | { readonly status: 'verified'; readonly records: SkillActivationRecord[] | undefined }
  | { readonly status: 'unverifiable'; readonly reason: string };
/** The outcome of re-validating stored skill records against the live catalog. */
export interface SkillRecoveryOutcome {
  readonly recovered: readonly string[];
  readonly refused: readonly string[];
}
/**
 * What a recovered run's toolbox was rebuilt with (COR-1620), kept with the toolbox that was
 * built. A restored approval, a replayed fire and a reattached session run are all built by
 * recovery, and each is decided under the snapshot read again at approve time, never under the
 * toolbox as it was built.
 */
export interface RecoveredSkillPolicy {
  readonly scheduledFire: boolean;
  readonly agentName: string;
  readonly sessionAgent: SessionAgentRun | undefined;
  /** The records the toolbox was built with, as JSON. */
  readonly recordsKey: string;
  /** Whether the snapshot was verified and every stored skill recovered. */
  readonly recoveredCleanly: boolean;
}
/**
 * The durable run engine + checkpoint store, plus the optional observability
 * handle. `observability` is present only when `BureauOptions.observability` was
 * enabled; its `dispose` MUST be called before `engine[Symbol.dispose]()` so the
 * engine's terminal lifecycle events still reach the span-closing listeners.
 */
export interface DurableComposition {
  engine: RegistryAgnosticEngine;
  checkpointStore: CheckpointStore;
  observability?: RunEngineObservability | undefined;
  /**
   * The engine's `schedule:missed-fire` signal, listened to from the moment the engine exists and
   * replayed to the first listener added. Weft's scheduler starts inside `Engine.create`, so a
   * listener added to `engine` once the composition returns can miss a signal raised while the
   * rest of the composition was still being built.
   */
  missedFires: MissedFireBuffer;
  /**
   * COR-1811 — the Weft log store behind the engine's persisted `ctx.log` lines, present only when
   * the composition was asked for one (`RuntimeCompositionDependencies.workflowLogs`).
   * `createBureau` prunes it on each maintenance pass.
   */
  workflowLogs?: WorkflowLogStore | undefined;
}
/**
 * The schedule-fire events dispatched onto
 * {@link RuntimeComposition.scheduleFireEvents}: the two fire-terminal
 * outcomes (AB-223) and the two per-tick observation signals (COR-660) that
 * report an occurrence the overlap policy attempted and, when it collided,
 * dropped.
 */
export interface ScheduleFireEventMap extends EventMap {
  [ScheduleCompletedEvent.type]: ScheduleCompletedEvent;
  [ScheduleFailedEvent.type]: ScheduleFailedEvent;
  [ScheduleAttemptedEvent.type]: ScheduleAttemptedEvent;
  [ScheduleSkippedEvent.type]: ScheduleSkippedEvent;
}
export interface RuntimeComposition {
  kv: ConditionalTextValueStore | undefined;
  /**
   * COR-1920 — the stored secret answers, present when there is a `kv` and the Bureau was given
   * `answerEncryption`. Without it a secret answer is refused before anything holds it.
   */
  secretAnswers: SecretAnswerStore | undefined;
  /**
   * The durable run engine + checkpoint store, present whenever durable
   * execution resolves on (by default: a persistent `storage` backend is
   * configured and `durable` is not explicitly `false`). When present,
   * `createBureau` routes every `createRun()` through it transparently — the run
   * surface is unchanged, but the run is checkpointed and resumes after a crash.
   */
  durable: DurableComposition | undefined;
  /**
   * Dispatches `ScheduleCompletedEvent`/`ScheduleFailedEvent` (AB-223) for
   * every scheduled fire's terminal outcome, live or recovered. Populated by a
   * `durable.engine` `workflow:completed`/`workflow:failed` listener,
   * correlated against the `scheduleId` recorded in `buildScheduledRunServices`
   * when that fire's deps were built — the map entry it reads is deleted the
   * instant this fires, so exactly one event dispatches per fire regardless of
   * whether it settled as a live tick or was recovered on boot (both routes
   * settle through this same Weft engine terminal event). `createBureau`
   * forwards each event onto the bureau's own `emitter` (scheduled fires are
   * headless — there is no per-run emitter to dispatch onto instead). A run
   * with no correlated `scheduleId` (every ordinary, non-scheduled run) is
   * silently ignored.
   */
  scheduleFireEvents: TypedEventTarget<ScheduleFireEventMap>;
  /**
   * Skill lifecycle events (COR-767), dispatched by the `@lostgradient/bureau/skills`
   * tool factories each run's toolbox is built from. One bureau-level target
   * rather than one per run, matching `scheduleFireEvents`: each event carries
   * its own `runId`/`sessionId` correlation, so a shared target loses nothing
   * and `createBureau` forwards from exactly one place.
   */
  skillEvents: TypedEventTarget<SkillEventMap>;
  /**
   * Run ids the durable engine flagged, during boot recovery, as resuming
   * under a DIFFERENT workflow version than the one they were checkpointed
   * with (AB-10 — workflow versioning for in-flight durable runs). Populated
   * by the `onWorkflowVersionMismatch` callback wired into `createRunEngine`,
   * which fires once per recovered run BEFORE `engine.recoverAll()` returns —
   * so this map is fully populated by the time the bureau's recovery loop
   * calls `classifyRecoveredRun`. Never cleared: entries are read exactly once
   * per boot recovery pass and the map is rebuilt fresh on the next boot.
   *
   * Keyed by runId, valued with the stored/registered version strings (AB-12
   * run inspector — `reattachRecoveredRun` reads these to stamp a
   * `workflow.reattached` timeline marker with the mismatch detail, not just
   * the boolean `classifyRecoveredRun` needs).
   */
  workflowVersionMismatches: Map<string, { storedVersion: string; registeredVersion: string }>;
  /**
   * COR-1916 — run ids this process's own recovery resolver ended because their deps could not be
   * rebuilt here (their session is reconciled to `error` and Weft fails the record). Boot recovery
   * reads it to tell a run this boot ended, which it reports, from one a peer finished, which it
   * leaves alone.
   */
  unrebuildableRecoveredRuns: Set<string>;
  /**
   * Stops this composition's writes to the caller's `options.storage` (COR-1767): every later
   * write through `kv`, the checkpoint store, the engine, or `durableStorage` throws; reads still
   * pass. It never closes the caller's storage, which stays the caller's to close. A no-op
   * without storage.
   */
  stopUsingStorage(): void;
  /**
   * The resolved durable `Storage` backend itself, when one exists.
   *
   * Distinct from `kv`, which is a `ConditionalTextValueStore` *view* over
   * this same backend: a `Mailbox` needs the raw `Storage` because it
   * commits its own state transitions through `conditionalBatch`, which
   * the text-value view does not expose.
   *
   * `undefined` when no persistent backend resolved — the caller is then
   * genuinely non-durable and must not pretend otherwise.
   *
   * This is the fenced view of the caller's `options.storage`, which
   * `stopUsingStorage` closes. Neither this composition nor a borrower disposes
   * the caller's adapter.
   */
  durableStorage: Storage | undefined;
  memory: GovernedMemory | undefined;
  sessionStore: SessionStore | undefined;
  /**
   * The bureau's canonical toolbox (`options.toolbox`, or an internally
   * created one). `reviews.resolve` calls `resumeApproval()` on this instance to
   * resume a signed pending tool approval — `resumeApproval` re-invokes the
   * tool by name/callId, so any toolbox sharing the original `approvalSecret`
   * and tool set can resume it, not only the specific per-run `.extend()` clone
   * that produced the pending approval.
   */
  baseToolbox: BureauToolbox;
  /**
   * COR-1947 — `toolbox` with every tool held to the permission mode of the chat `runId` belongs
   * to. Every toolbox a run calls goes through this once, whatever kind of agent built it.
   */
  withChatPermission(toolbox: BureauToolbox, runId: string): BureauToolbox;
  /**
   * COR-1996 — `options` with its `generate` held to the model policy: a step whose catalog rows
   * the policy forbids fails with a `ModelPolicyDeniedError` before the provider is called. Every
   * `RunOptions` a catalog agent resolves goes through this once, whatever path starts the run.
   * `generationMode` is the agent's own (`readGenerationProfile`): a fixed agent is judged by its
   * one row whatever model a session carries as a steer, a selectable one by the model it names.
   */
  holdToModelPolicy<Options extends Pick<RunOptions, 'generate'>>(
    options: Options,
    generationMode: GenerationMode,
  ): Options;
  setRequestAuthorityValidator(
    validator: ((context: ToolRequestContext) => boolean | Promise<boolean>) | undefined,
  ): void;
  /**
   * AB-240: wired by `createBureau` once its agent catalog exists, so boot
   * recovery can resolve a catalog-dispatched run's deps through the
   * catalog agent's OWN `OPERATIVE_RESOLVE_RUN_OPTIONS` rather than the
   * Bureau's default runtime composition.
   */
  setCatalogAgentRunOptionsResolver(resolver: CatalogAgentRunOptionsResolver | undefined): void;
  /**
   * COR-1586 — the resolver will never be wired, because the Bureau failed while it was being
   * built. Every reader waiting for it, and every later one, is answered as unavailable with
   * `reason`. A no-op for a composition built without `awaitsCatalogAgentRunOptionsResolver`.
   */
  abandonCatalogAgentRunOptionsResolver(reason: string): void;
  /**
   * Persist the catalog-run recovery record `resolveRunServices` consults
   * on the next boot. Called from `bureau.run()`'s durable dispatch branch
   * before the durable engine starts. A no-op when this composition has no
   * durable storage.
   */
  persistCatalogRunRecoveryRecord(
    runId: string,
    record: Omit<CatalogRunRecoveryRecord, 'schemaVersion'>,
  ): Promise<void>;
  /**
   * COR-772 — {@link persistCatalogRunRecoveryRecord}, but create-if-absent:
   * `false`, writing nothing, when a record already exists for `runId`. A
   * child run's identifier is chosen by its caller rather than minted here,
   * so its record must never replace the one another run already holds.
   * `true` with no durable storage, where there is nothing to claim.
   */
  claimCatalogRunRecoveryRecord(
    runId: string,
    record: Omit<CatalogRunRecoveryRecord, 'schemaVersion'>,
  ): Promise<boolean>;
  /**
   * COR-851 — the persisted catalog-run recovery record for `runId`, as
   * stored. A goal reads it to verify that a run at one of its deterministic
   * ids is the goal's own before adopting or stopping it.
   */
  loadCatalogRunRecoveryRecord(runId: string): Promise<CatalogRunRecoveryLoad>;
  /**
   * COR-1934 — deletes a run's recovery record, which holds the run's `input`. For a run whose
   * content is being purged and that nothing will recover or claim again. Idempotent.
   */
  deleteCatalogRunRecoveryRecord(runId: string): Promise<void>;
  /**
   * COR-851 — tombstones the claim of a goal attempt's run, so that no start can
   * begin from it and no run under it takes a step (see `goal-attempt-fence.ts`).
   * The claim the goal's own start wrote is changed by compare-and-swap from the
   * exact bytes read; where no claim exists a tombstoned one is created
   * whole, create-if-absent, so a start that claims later finds it. `'fenced'`
   * once the claim is tombstoned (by this call or an earlier one), `'foreign'`
   * when the record at the id is not this goal attempt's, which is left alone.
   * Rejects when the record cannot be read or is not valid, or when concurrent
   * writers keep winning; the caller treats that as work still owed.
   */
  fenceGoalAttemptRecoveryRecord(
    runId: string,
    owner: GoalAttemptClaimOwner,
    tombstonedAt: string,
  ): Promise<GoalAttemptClaimFence>;
  /**
   * Whether `runId` has a persisted catalog-run recovery record — used by
   * `createBureau`'s boot-recovery classification to route a catalog run to
   * a headless monitor instead of the session-ownership classification.
   */
  isCatalogRecoveredRun(runId: string): Promise<boolean>;
  /**
   * AB-241 review finding: the combined catalog-run classification AND
   * attribution read `createBureau`'s `onRecoveredWorkflow` uses, backed by
   * exactly ONE `loadCatalogRunRecoveryRecord` call — deliberately NOT two
   * separate calls (one to `isCatalogRecoveredRun`, one to a
   * would-be `getCatalogRunAttribution`), because a transient storage read
   * failure on a SECOND, independent read could then classify a workflow as
   * catalog territory (the first read succeeded) while losing its
   * attribution (the second read hit the transient failure) — silently
   * demoting an attributed run to unattributed for the rest of this
   * process's lifetime, since `eventHistory`'s principal gate fails closed
   * on an absent `runAttribution` entry. `isCatalogRun` is `true` for
   * `'read-error'` as well as `'found'` (matching `isCatalogRecoveredRun`'s
   * own read-error handling), so a corrupt (not absent) record still routes
   * to the headless catalog monitor rather than falling through to the
   * session-ownership classification; `attribution` is populated only for
   * `'found'`, since a corrupt record has nothing decoded to offer.
   */
  classifyCatalogRecoveredRun(runId: string): Promise<{
    isCatalogRun: boolean;
    attribution?: { agentName: string; principal?: string };
  }>;
  /**
   * AB-241 review finding: releases every entry `catalogRunRecoveryCache`
   * accumulated during the current boot recovery pass. `createBureau`'s
   * `recoverDurableRuns` calls this exactly once, after its post-recovery
   * loop (the last consumer of the cache) has finished — see the cache's
   * own doc comment for why entries are retained rather than evicted
   * per-read.
   */
  clearCatalogRunRecoveryCache(): void;
  /**
   * COR-1577 — resolve the catalog agent a session run names, through the same resolver a
   * catalog dispatch and boot recovery use. The caller checks `agentName` is not the default
   * agent first: `bureau` has no catalog entry and runs the Bureau-wide runtime.
   */
  resolveSessionAgentRun(
    agentName: string,
    runId: string,
    principal?: string,
    recorded?: CatalogRunRecordedDefinition,
    session?: SessionTaintSource,
  ): Promise<SessionAgentRunResolution>;
  /**
   * COR-716 — how a run owned by `principalId` handles the media it carries: the
   * resolver that projects a managed asset to something a provider takes (absent when no
   * asset service is composed), and the policy for an asset no safety gate verified,
   * taken from this bureau's input guardrail. Every path that starts or resumes a run
   * spreads it into the run's options, so a managed-asset part resolves, and is judged,
   * the same on a fresh start, a recovery, and a scheduled fire.
   *
   * `rowHolder` says who keeps the managed assets the run's rows reference (COR-1581): `'session'`
   * for a run that writes into a session, whose claim pass takes them, and `'run'` for a run with
   * no session, which holds them itself. A catalog dispatch (`bureau.run()`, a child, a goal
   * attempt, a workflow step) and its recovery have no session.
   */
  mediaOptionsFor(principalId: string | undefined, rowHolder: MediaRowHolder): MediaRunOptions;
  ready: boolean;
  maximumSteps: number;
  systemPrompt: string | undefined;
  createRunRuntime(
    request: RunRuntimeRequest,
    options?: {
      /**
       * The pre-crash active set, as provenance-carrying activation records.
       *
       * Recovery re-validates these against the live catalog and re-checks each digest, so a skill
       * whose source was revoked or whose content drifted while the run was away does not come
       * back under a name somebody once reviewed.
       */
      initialActiveSkillRecords?: ReadonlyArray<SkillActivationRecord> | undefined;
      /**
       * COR-1577 — run the named catalog agent's `generate` and toolbox in place of the
       * Bureau-wide ones. The Bureau tier (memory, skills, identity, guardrails, opt-in tools)
       * is composed around them exactly as it is around the Bureau-wide runtime.
       */
      sessionAgent?: SessionAgentRun | undefined;
      /** COR-1546 — the run's owner of record, which its memory is partitioned under. */
      memoryOwner?: string | undefined;
      /**
       * COR-2105 — the metadata of the session the run belongs to. The run's Bureau guardrails
       * start tainted when it holds `guardrailTaint`, and write a taint they raise back to the
       * session. Absent, the run starts untainted and still writes back.
       */
      sessionMetadata?: Readonly<Record<string, JSONValue>> | undefined;
      /**
       * COR-1620 — the skill policy that governs the run cannot be verified, so the run is
       * offered no tool and writes no skill snapshot. This is a filter on what the model sees, not
       * a gate on what runs: a call the model makes anyway still reaches its approval, which is
       * refused at approve under the snapshot read again.
       */
      skillPolicyUnverifiable?: boolean | undefined;
      /** COR-1911 — the run neither recalls nor remembers: no memory hook is registered. */
      withoutMemory?: boolean | undefined;
      admitDispatch?: (() => Promise<boolean>) | undefined;
    },
  ): Promise<{
    generate: GenerateFunction;
    toolbox: AnyToolbox;
    /**
     * The run's hook plan (COR-567). Bureau's own hooks were seven pushes into
     * three legacy arrays until this became a registry; they are registered
     * here, under stable ids, in the order those arrays ran.
     *
     * A registry rather than arrays because `RunOptions.hooks` is the only
     * hook surface that carries registration identity, priority and plan
     * observation — and bureau composing one is what makes those real for a
     * production run instead of a capability nothing reaches.
     */
    hooks: HookRegistry<OperativeHookMap>;
    getActiveSkillRecords: () => readonly SkillActivationRecord[];
    /**
     * Settles once the active skills the run was given have been re-validated against the live
     * catalog (COR-1613). A run waits for it before its first step; a caller that decides a tool
     * call outside a step, as the restore of a pending approval does, waits for it itself.
     */
    skillsRecovered: Promise<SkillRecoveryOutcome>;
    /**
     * COR-1620 — whether the skill policy is held unverified: the snapshot could not be
     * verified, or a stored skill was refused on recovery. Such a run is offered no tool and
     * writes no skill snapshot, so what it persisted before is kept. Settles with
     * {@link skillsRecovered}.
     */
    skillPolicyUnverified: () => boolean;
  }>;
  /**
   * AB-260 — folded onto this interface directly rather than reached through
   * the retired `RuntimeCompositionTestingSeams` WeakMap: this is Weft's
   * literal `resolveWorkflowServices` resolver, already wired into
   * `durable.engine` at construction whenever one is composed (production
   * invokes it automatically on every recovered run) — a genuine capability
   * of this returned object, not a test-only backdoor, so every caller (test
   * or production) reaches it the same way. Callable even without a durable
   * engine composed — it resolves `{ status: 'unavailable' }` for every
   * input in that case, matching what an uncomposed resolver would report.
   */
  resolveRunServices(info: WorkflowServicesResolverInfo): Promise<WorkflowServicesResolution>;
  /**
   * AB-260 — folded onto this interface directly for the same reason as
   * {@link RuntimeComposition.resolveRunServices}: the native-scheduled-fire
   * branch of that same resolver, callable standalone for a caller (test or
   * production) that already holds a `SessionStore` and wants to build a
   * scheduled fire's deps without going through the full resolver dispatch.
   */
  buildScheduledRunServices(
    info: WorkflowServicesResolverInfo,
    store: SessionStore,
    recoveredScheduleMarker?: RecoveredScheduleMarker,
  ): Promise<WorkflowServicesResolution>;
  /**
   * COR-1620 — the active-skill snapshot of a scheduled fire under recovery, which a restored
   * approval and a replayed fire are decided under. It tells a verified absence of skills from a
   * snapshot that cannot be verified: the read or deserialization failed, or the session names
   * another fire.
   */
  readCommittedScheduledSkillSnapshot(
    session: { readonly metadata: Record<string, JSONValue> } | undefined,
    runId: string,
    recovering: boolean,
    agentHasSkills?: boolean,
  ): Promise<SkillSnapshot>;
  /**
   * COR-1620 — the same for a session run: the records its session holds, a verified absence
   * when the Bureau has no skills, and unverifiable when they do not deserialize or a later run
   * cleared or replaced them.
   */
  readSessionSkillSnapshot(
    session: { readonly metadata: Record<string, JSONValue> } | undefined,
    runId: string,
    agentHasSkills?: boolean,
  ): SkillSnapshot;
  /**
   * COR-1265 criterion 3b — a fresh registry holding only the Bureau invariants
   * that close over nothing run-specific, for a dispatch path that resolves its
   * run options through a catalog agent rather than through
   * {@link RuntimeComposition.createRunRuntime}. Merged as the first tier so
   * Bureau's policy still applies to those runs.
   */
  createBureauInvariantHooks(
    goalAttempt?: GoalAttemptTarget,
    options?: BureauInvariantOptions,
  ): HookRegistry<OperativeHookMap>;
  /**
   * COR-2106 — {@link RuntimeComposition.createBureauInvariantHooks} as a child-run factory: what a
   * run Bureau owns attaches (`bureauInvariantsField`) so that the children it dispatches carry
   * Bureau's identity and guardrails, and (COR-2127) the plugin tier.
   */
  readonly bureauChildInvariants: BureauChildInvariants;
  /**
   * COR-2127 — one run's hook plan: the Bureau tier and the agent tier given, with the plugin tier
   * (every interceptor a plugin applies to every agent) between them. Every Bureau site that hands a
   * run its hooks composes them here (`run-hook-tiers.ts`).
   */
  composeRunHooks(tiers: RunHookTiers): HookRegistry<OperativeHookMap>;
  /**
   * COR-2299 — the taint seam of one run of `sessionId`: the taint `metadata` holds, and an
   * `onTainted` that stores a new one. For a caller that builds a hook plan outside a run's start,
   * as the scan of an approved call's result does.
   */
  sessionTaintSeam(
    sessionId: string,
    runId: string,
    metadata: Readonly<Record<string, JSONValue>> | undefined,
  ): SessionTaintSeam;
  /** COR-2381 — how many taints a scheduled fire holds for a session it has not yet created. */
  pendingScheduledTaintCount(): number;
}
/** COR-1367 — per-dispatch options for {@link RuntimeComposition.createBureauInvariantHooks}. */
export interface BureauInvariantOptions {
  /**
   * The dispatched agent resolves its own guardrails from its declaration and
   * its inherited policy (`resolvesOwnGuardrails`), so Bureau registers no
   * guardrail invariant of its own for the run.
   */
  agentResolvesGuardrails?: boolean;
  /**
   * COR-2299 — the session taint the Bureau guardrails start from and write back to, for a plan
   * built outside a run's start (an approved call's result scan). Absent, they start untainted.
   */
  sessionTaint?: SessionTaintSeam | undefined;
}
/**
 * The Bureau-wide run configuration a composition itself can carry. `createBureau` supplies none of
 * it (COR-323: every run belongs to a catalog agent, which owns its own `generate`, tools, stop
 * condition, and instructions), so a Bureau-composed `RuntimeComposition` is never `ready`; a
 * caller composing the runtime directly, as the composition's own tests do, may still set it.
 */
export interface CompositionRunOptions {
  generate?: GenerateFunction;
  toolbox?: AnyToolbox;
  guardrails?: GuardrailsOptions | false;
  skills?: SkillRuntimeConfiguration;
  stopWhen?: StopCondition | StopCondition[];
  maximumSteps?: number;
  systemPrompt?: string;
  /** Response caching over the composition's own `generate`; a Bureau composes none. */
  cache?: CacheConfiguration;
}
export type RuntimeCompositionOptions = Omit<BureauOptions, 'agents'> & CompositionRunOptions;
