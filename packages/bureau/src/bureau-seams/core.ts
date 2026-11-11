/**
 * The core context of `constructBureau` (COR-2376): one object, built once construction has a
 * `runtime`, that every seam factory in this directory reads. A plain member is a value fixed
 * before the core exists; an accessor reads, and a read-write accessor also assigns, the
 * `constructBureau` binding it names, when it is called, so a late or reassigned value is read live.
 *
 * A seam is `create<Seam><D>(core, peers)`: synchronous, side-effect free, and called once, in the
 * seam block of `constructBureau`, before any construction-time code that can reach its members.
 */
import type {
  ActiveRun,
  AgentRun,
  AgentSession,
  DurableRunDeps,
  FlowController,
  OperativeHookMap,
  PeerCallJournal,
  CleanupAcknowledgement as RunCleanupAcknowledgement,
  SessionInputGate,
  SteeringRequestedValue,
  Store,
  Subscription,
  createAgentRunEventRegistry,
  createSessionInputDeliveryStore,
} from '@lostgradient/operative';
import type { AgentDefinitions, createAgentCatalog } from '../agent-catalog';
import type { AssetService } from '../assets/types';
import type { AuditTrail } from '../audit-trail';
import type {
  Bureau,
  BureauShutdownReport,
  ContextDeletionReport,
  PendingReview,
  ServerFrame,
} from '../types';
import type { BureauEventMap } from '../events';
import type { BureauSteeringGate, SteeringRefusal, createSteeringCommandLedger } from '../steering';
import type {
  BureauToolbox,
  RuntimeComposition,
  createMaintenanceMemoryAuthority,
} from '../runtime-composition';
import type { ChildTopology } from '../child-topology';
import type {
  CompletableEventTarget,
  HookRegistry,
  RuntimeServices,
  RuntimeTimeoutHandle,
} from '@lostgradient/lifecycle';
import type { CreatedHooks } from '../hooks/create-hooks';
import type { DurableEventHistory, DurableEventProducer } from '../durable-event-history';
import type { FileAgentRuntime } from '../agent-file-runtime';
import type { FireReviewFollower } from '../fire-review-follower';
import type { Mailbox, RecoveredWorkflowInfo } from '@lostgradient/weft';
import type { MemoryEmbedderSetting } from '../memory-embedder-setting';
import type { Models } from '../models/create-models';
import type { NotifyingReviewIdSet } from '../approval-state-records';
import type { ReviewDecisionRequest, createReviewDecisionRecords } from '../review-decision-record';
import type { RunAttribution } from '../serialization';
import type { ScheduledFireReviewState } from '../scheduled-fire-review-state';
import type { ScorerSampler } from '../scorers';
import type { SecretAnswerAuditEntry } from '../secret-answers';
import type { SettingsComposition } from '../settings/create-settings';
import type { SteeringLogHead } from '../steering-log';
import type { TaskRegistry, TaskToolGrant } from '../task-registry';
import type { TaskResync } from '../task-resync';
import type { Tool, ToolRequestContext } from 'armorer';
import type { WebhookNotifier } from '../webhook-notifier';
import type { WorkflowRuntime } from '../workflow-runtime';
import type { composeBureauGoals } from '../goals-composition';
import type { createAbandonedTaskSweeper, openProcessLease } from '../process-lease';
import type { createAssetClaimReconciler } from '../asset-claim-reconciliation';
import type { createBureauEventFeed } from '../bureau-event-feed.ts';
import type { createBureauInteractiveSurfaces } from '../interactive-surface/bureau-wiring';
import type {
  createCatalogAssetReleaseDrain,
  createCatalogRunAssetReleaser,
} from '../catalog-run-asset-release';
import type {
  createCatalogRunSettlementHook,
  createCatalogSettlementTracker,
} from '../catalog-run-settlement';
import type { createChatContentPurge } from '../chat-content-purge';
import type { createChatSpendLedger } from '../chat-spend-ledger';
import type { createChildTopologyStore } from '../child-topology-store';
import type { createDiagnosticDispatcher, subscribeEventFeed } from '../bureau-event-forwarders.ts';
import type { createFireReviewSeeds } from '../fire-review-seeds';
import type { createForkLedger } from '../session-fork';
import type { createGoalAttemptFenceHost } from '../goal-attempt-fence';
import type { createGoalValidatorCatalog } from '../goal-validator-catalog';
import type { createGoalWorkflowHost } from '../goal-ports';
import type { createLateDecisions } from '../decisions/late-decisions';
import type { createNotifications } from '../notifications/create-notifications';
import type { createPluginRegistry } from '../plugins/plugin-registry';
import type { createResolvedReviewStore } from '../resolved-review-record';
import type { createRunCreationLedger } from '../command-ledger';
import type { createRunHookOrigins } from '../hooks/run-hook-origins';
import type { createRunHumanWaits } from '../run-human-waits';
import type { createSessionInputSettlement } from '../session-input-settlement';
import type { createSessionPersistence } from '../bureau-session-persistence';
import type {
  LayeredBureauOptions,
  createSessionPersistenceSleep,
  createShutdownTimeoutSleep,
} from '../bureau-construction-support';
import type { WorkspaceMembershipOptions } from '../http/workspace-principal.ts';
import type { createTryAgents } from '../agent-try';
import type { createWorkflowReviewWaits } from '../workflow-review-waits';

/** How many times an append retries after losing a race to another process. */
export const STEERING_APPEND_ATTEMPTS = 25;
export const REVIEW_AUDIT_OUTBOX_NAMESPACE = 'audit-record';

/**
 * Durable steering (see `steering-log.ts` and
 * `documentation/durable-steering-log.md`). A durably-configured bureau
 * keeps each session's steering as an append-only log of events in
 * `runtime.kv`; the session's gate is a fold of it, and every change to
 * the gate — admissions, promotions, and run-boundary transitions alike —
 * is appended first and applied only after, so the local gate changes in
 * exactly the log's order.
 *
 * A cursor records which gate instance it folded into, which session
 * incarnation, and how far. Each durable gate has its OWN ledger: the
 * fold must depend on nothing but the log, and the bureau-wide ledger
 * can hold entries for sessions another process has since deleted.
 * Cross-session idempotency comes from the log's durable key bindings.
 */
export interface SteeringCursor {
  readonly incarnation: string;
  readonly gate: BureauSteeringGate;
  readonly ledger: ReturnType<typeof createSteeringCommandLedger>;
  /**
   * Admissions the gate did not accept (rejected, or unsupported), keyed
   * `principal -> id`, as folded from the log. The ledger records only
   * accepted commands; these keep a refused command's id decided too, so
   * a retry is answered from the log instead of decided afresh.
   */
  readonly refusals: Map<string, Map<string, SteeringRefusal>>;
  /** Each accepted command's value as the caller submitted it, where Bureau resolved it. */
  readonly submitted: Map<string, Map<string, SteeringRequestedValue>>;
  /**
   * Runs promoted in the log with no `run-ended` yet, by promotion time.
   * Each is a durable launch marker: a run counts as starting from its
   * `promoted` entry until its workflow is queryable, however many runs
   * start concurrently on the session.
   */
  readonly starting: Map<string, string>;
  /** What the fold has seen so far, checked as each event folds. */
  readonly history: SteeringFoldHistory;
  /** The last head read or written. Appends are conditioned on it. */
  head: SteeringLogHead;
  /** How many entries have been applied to `gate`. */
  applied: number;
}

/** What a fold of one log has seen, for checking each next event against. */
export interface SteeringFoldHistory {
  /** Each run's place in its life: promoted, then (once) ended. */
  readonly runs: Map<string, 'promoted' | 'ended'>;
  /** Every `(principal, id)` already decided by an `admit` or `refused`. */
  readonly keys: Set<string>;
}

export interface SteeringPoller {
  readonly incarnation: string;
  readonly gate: BureauSteeringGate;
  /** The session's durable runs this process drives. */
  readonly runIds: Set<string>;
  readonly timer: ReturnType<RuntimeServices['timers']['setInterval']>;
  /** The last failure reported, so a repeating one is reported once. */
  lastFailure?: string | undefined;
  /** The poll still running, if any: a tick never starts a second one. */
  inFlight?: Promise<void> | undefined;
}

/**
 * What the record kept before a deletion holds (COR-2018): the owner, which the audit entry
 * carries as `detail.owner`, and the chat's title and message count, which it carries so the log
 * can say which chat was deleted. The value is stored as JSON; a record written before the
 * summary was kept is the owner alone, as plain text, and reads as no summary.
 */
export type SessionDeletionRecord = {
  readonly owner: string | undefined;
  /** Who asked for the deletion, when somebody did: an expiry has no actor. */
  readonly actor: string | undefined;
  readonly summary: { readonly title: string | null; readonly messageCount: number } | undefined;
};

// ── AB-391: review-transition audit records ride the session outbox ──
//
// A review transition (`resolveReview`'s approve/deny/reject decision, or
// `resumeApproval`'s re-gate `superseded` transition) used to write its
// durable audit record via a separate, fire-and-forget
// `auditTrailInstance.record()` call AFTER the session-store commit that
// makes the transition itself durable (`persistReviewResolutionWithRetry`/
// `persistPendingApprovalOverrideWithRetry`). A crash between the two lost
// the audit record forever: the session commit already marks the review
// resolved, so nothing ever retries the write.
//
// The fix mirrors AB-389/AB-390's session commit outbox: the review
// transition's audit payload rides the SAME `conditionalBatch` as the
// session-store commit, as a `SessionOutboxEntry` of kind
// `'session.attachment'` (namespace `'audit-record'`) — see
// `SessionStore.update()`'s own `options.outbox` doc comment
// (`@lostgradient/operative`). `drainOutbox` (this file, generalized from
// the session-only `drainSessionOutbox`) replays it into the real audit
// trail exactly once, in the same ordinal order as every other outbox
// entry for that session, whether that happens promptly (this bureau is
// still alive) or after a restart.
export type ReviewAuditAttachment = {
  runId: string;
  type: string;
  detail: unknown;
  principal: string;
  decisionRequest?: ReviewDecisionRequest;
};

/**
 * What every seam factory reads from `constructBureau`. Never destructure an accessor at a
 * factory's top: read `core.x` where it is used, so the read happens at call time.
 */
export interface BureauCore<D extends AgentDefinitions> {
  /** The resolved options, final once `runtime` exists. */
  readonly options: LayeredBureauOptions<D>;
  /** The workspace membership this Bureau is bound to, if any. */
  readonly workspace: WorkspaceMembershipOptions | undefined;
  /** The asset service, read late by helpers built before it exists. */
  readonly assetServiceHolder: { current: AssetService | undefined };
  /** The asset service built from `options.assets`, if configured. */
  readonly assetServiceInstance: AssetService | undefined;
  /** The composed plugin registry. */
  readonly pluginRegistry: ReturnType<typeof createPluginRegistry>;
  /** Whether this Bureau created `store`, and so closes it. */
  readonly ownsStore: boolean;
  /** The clock, timers and identifiers every seam uses. */
  readonly runtimeServices: RuntimeServices;
  /** When construction started, on `runtimeServices.clock`. */
  readonly constructedAtMilliseconds: number;
  /** The run store. */
  readonly store: Store;
  /** The Bureau event target every public event is dispatched on. */
  readonly emitter: CompletableEventTarget<BureauEventMap>;
  /** This Bureau's identifier. */
  readonly bureauId: string;
  /** The Bureau event feed. */
  readonly eventFeed: ReturnType<typeof createBureauEventFeed>;
  /** The feed's subscription to `emitter`. */
  readonly eventFeedSubscription: ReturnType<typeof subscribeEventFeed>;
  /** Unsubscribers for the event forwarders, run at shutdown. */
  readonly stopForwarding: Array<() => void>;
  /** Per-run event feeds, by run id. */
  readonly runEventFeeds: ReturnType<typeof createAgentRunEventRegistry>;
  /** The agent definitions as given at construction. */
  readonly agentsSnapshot: D;
  /** The host the goal workflows bind to. */
  readonly goalWorkflowHost: ReturnType<typeof createGoalWorkflowHost>;
  /** The host for goal attempt fences. */
  readonly goalAttemptFenceHost: ReturnType<typeof createGoalAttemptFenceHost>;
  /** The decision services bound after construction. */
  readonly lateDecisions: ReturnType<typeof createLateDecisions>;
  /** The goal validators by name. */
  readonly goalValidatorCatalog: ReturnType<typeof createGoalValidatorCatalog>;
  /** Resolves with the handler for workflows the engine recovers. */
  readonly recoveredWorkflowHandler: PromiseWithResolvers<
    (info: RecoveredWorkflowInfo) => Promise<void>
  >;
  /** The session id of each active run. */
  readonly runSessionIdentifiers: WeakMap<ActiveRun, string>;
  /** The session incarnation each run started on, by run id. */
  readonly runSessionIncarnations: Map<string, string>;
  /** The runtime composition: engine, stores and scheduled services. */
  readonly runtime: RuntimeComposition;
  /** Reports a Bureau diagnostic. */
  readonly diagnose: ReturnType<typeof createDiagnosticDispatcher>['diagnose'];
  /** Reports a settings warning. */
  readonly diagnoseSettings: (message: string, cause?: unknown) => void;
  /** The settings in force now. */
  readonly currentSettings: () => ReturnType<SettingsComposition['current']>;
  /** The settings composition, or a throw before it exists. */
  readonly settingsOf: () => SettingsComposition;
  /** The tool grant the current settings allow. */
  readonly toolGrantNow: () => TaskToolGrant;
  /** The per-session input backlog limit in force now. */
  readonly sessionInputSessionBacklogLimit: () => number;
  /** The per-principal input backlog limit in force now. */
  readonly sessionInputPrincipalBacklogLimit: () => number;
  /** Binds the child-wait services to the durable engine. */
  readonly configureChildWaitServices: (services: DurableRunDeps, principal: string) => void;
  /** Throws once shutdown has closed run admission. */
  readonly assertRunAdmissionOpen: (subject: 'run' | 'scheduler task') => void;
  /** Releases a run's toolbox once nothing uses it. */
  readonly releaseRunToolboxWhenIdle: (runToolbox: BureauToolbox) => void;
  /** Ties background work to the shutdown abort signal. */
  readonly withBackgroundShutdownSignal: (callerSignal: AbortSignal | undefined) => AbortSignal;
  /** The interruption fields recorded for an approval. */
  readonly interruptedFields: (
    reviewId: string,
  ) => { interrupted: true; resolutionStartedAt: number | undefined } | Record<never, never>;
  /** Forgets a pending approval override. */
  readonly dropPendingApprovalOverride: (reviewId: string) => void;
  /** The runs active in this process. */
  readonly activeRuns: Set<ActiveRun>;
  /** Active runs that ended in an error. */
  readonly erroredActiveRuns: Set<ActiveRun>;
  /** Active runs recovered after a restart. */
  readonly recoveredActiveRuns: WeakSet<ActiveRun>;
  /** Active runs that shutdown stopped. */
  readonly runsStoppedByShutdown: WeakSet<ActiveRun>;
  /** The catalog runs in flight. */
  readonly catalogRuns: Set<AgentRun<unknown, boolean>>;
  /** The ids of catalog runs. */
  readonly catalogRunIds: Set<string>;
  /** The toolboxes of live runs. */
  readonly runToolboxes: Set<BureauToolbox>;
  /** Each live run's toolbox, by run id. */
  readonly runToolboxesByRunId: Map<string, BureauToolbox>;
  /** The run-scoped context of each run. */
  readonly runScopedContexts: Map<string, Record<string, unknown>>;
  /** The hook plan of each live run, which scans an approved call's result. */
  readonly runHookPlans: Map<string, HookRegistry<OperativeHookMap>>;
  /** Forgets a run's scoped context and hook plan. */
  readonly releaseRunScope: (runId: string) => void;
  /** Aborts background work at shutdown. */
  readonly backgroundShutdownController: AbortController;
  /** Runs whose owner is gone. */
  readonly orphanedRunIds: Set<string>;
  /** Reviews already resolved. */
  readonly resolvedReviewIds: NotifyingReviewIdSet;
  /** Reviews being resolved now. */
  readonly resolvingReviewIds: Set<string>;
  /** Review resolutions whose cleanup has not finished. */
  readonly reviewResolutionCleanupPending: Map<
    string,
    {
      sessionId: string;
      runId: string;
      kind: PendingReview['kind'];
      decision: 'approve' | 'deny' | 'reject';
      review: PendingReview;
      principal: string;
      reason?: string;
      /** What the approved tool returned, so a retry can still write the outcome into the conversation. */
      result?: unknown;
      /** COR-1920: what the decision's audit entry says of each secret answer it delivered. */
      secretAnswers?: readonly SecretAnswerAuditEntry[];
      /** COR-1828: the digest of the approved answer, which the resolved-review record keeps. */
      answerDigest?: string | undefined;
      /** COR-1828: the tool the decision asked to remember, stored with the decision's commit. */
      rememberTool?: string | undefined;
      /** COR-1828: the owner of record of the run, for the resolved-review record. */
      owner?: string | undefined;
    }
  >;
  /** Pending tool approvals overridden in this process. */
  readonly pendingApprovalOverrides: Map<
    string,
    Extract<PendingReview, { kind: 'tool-approval' }>['approval']
  >;
  /** The approval round of each pending approval. */
  readonly pendingApprovalRounds: Map<string, number>;
  /** Approvals interrupted by a restart. */
  readonly interruptedApprovals: Map<string, number | undefined>;
  /** When each approval was requested. */
  readonly approvalRequestedAt: Map<string, number>;
  /** Reviews whose run has ended, with their session. */
  readonly terminalReviewSessions: Map<
    string,
    { sessionId: string; agentName: string; requestedAt: number }
  >;
  /** Scheduled-fire runs waiting on an approval. */
  readonly scheduledFireApprovalRuns: Set<string>;
  /** Scheduled fires continuing after an approval. */
  readonly continuingScheduledFires: Set<string>;
  /** Approval reviews found invalid. */
  readonly invalidApprovalReviewIds: NotifyingReviewIdSet;
  /** The principal and attribution of each run. */
  readonly runAttribution: Map<string, RunAttribution>;
  /** The steering gate of each session. */
  readonly steeringGates: Map<string, BureauSteeringGate>;
  /** The input mailbox of each session. */
  readonly sessionInputMailboxes: Map<string, Mailbox>;
  /** Pending steering writes at run end. */
  readonly steeringRunEndWrites: Map<string, Promise<void>>;
  /** Session input settlements in flight. */
  readonly inFlightSessionInputSettlements: Set<Promise<void>>;
  /** Terminal session record writes in flight. */
  readonly terminalSessionRecords: Map<string, Promise<void>>;
  /** Settlers for terminal session record writes. */
  readonly terminalSessionRecordSettlers: Map<
    string,
    { resolve: () => void; reject: (reason: unknown) => void }
  >;
  /** Resolves when session input closes for shutdown. */
  readonly sessionInputClosing: PromiseWithResolvers<void>;
  /** The input gate of each session. */
  readonly sessionInputGates: Map<
    string,
    { readonly gate: SessionInputGate; readonly sessionId: string }
  >;
  /** The steering cursor of each session. */
  readonly steeringCursors: Map<string, SteeringCursor>;
  /** The steering incarnation of each run. */
  readonly steeringRunIncarnations: Map<string, string>;
  /** Local runs that have settled. */
  readonly settledLocalRunIds: Set<string>;
  /** The serialized steering work of each session. */
  readonly steeringQueues: Map<string, Promise<unknown>>;
  /** The steering poller of each session. */
  readonly steeringPollers: Map<string, SteeringPoller>;
  /** Steering commands by command id. */
  readonly steeringCommandLedger: ReturnType<typeof createSteeringCommandLedger>;
  /** The steering values each gate has submitted. */
  readonly submittedSteeringValues: WeakMap<
    BureauSteeringGate,
    Map<string, Map<string, SteeringRequestedValue>>
  >;
  /** The tool request context of each run. */
  readonly runRequestContexts: Map<string, ToolRequestContext>;
  /** Runs recovered after a restart. */
  readonly recoveredRunIds: Set<string>;
  /** The review state scheduled fires share. */
  readonly scheduledFireReviewState: ScheduledFireReviewState;
  /** Whether a request authority came from a transport. */
  readonly isTransportIssuedAuthority: (context: ToolRequestContext) => boolean;
  /** Listeners for live server frames. */
  readonly liveFrameListeners: Set<(frame: ServerFrame) => void>;
  /** Runs whose frames are buffered at boot. */
  readonly bootFrameRunIds: Set<string>;
  /** Server frames buffered at boot. */
  readonly bootFrameBuffer: ServerFrame[];
  /** Terminal checkpoint cleanups, by run id. */
  readonly terminalCheckpointCleanups: Map<string, Promise<RunCleanupAcknowledgement>>;
  /** Runs being aborted. */
  readonly abortingRunIds: Map<string, number>;
  /** The event sequence counter of each run. */
  readonly runSequenceCounters: Map<string, number>;
  /** The base delay between session persistence retries. */
  readonly sessionPersistenceRetryDelayMilliseconds: number;
  /** Sleeps between session persistence retries. */
  readonly sessionPersistenceSleep: ReturnType<typeof createSessionPersistenceSleep>;
  /** Sleeps toward a shutdown timeout. */
  readonly shutdownTimeoutSleep: ReturnType<typeof createShutdownTimeoutSleep>;
  /** Review requests already announced, by run id. */
  readonly announcedReviewRequests: Map<string, Set<string>>;
  /** The park baseline of each human wait. */
  readonly humanWaitParkBaseline: Map<string, number>;
  /** Manual durable maintenance passes in flight. */
  readonly manualDurableMaintenancePasses: Set<Promise<void>>;
  /** Session deletions in flight. */
  readonly inFlightSessionDeletions: Map<string, Promise<ContextDeletionReport>>;
  /** The owner of each session deletion. */
  readonly sessionDeletionOwners: Map<string, SessionDeletionRecord>;
  /** Sessions being expired. */
  readonly expiringSessions: Map<string, AgentSession>;
  /** The settings composition, once built. */
  readonly settingsComposition: SettingsComposition | undefined;
  /** The memory embedder setting, once built. */
  readonly memoryEmbedder: MemoryEmbedderSetting | undefined;
  /** The hooks, once built. */
  readonly hooksInstance: CreatedHooks | undefined;
  /** The models, once built. */
  readonly models: Models;
  /** The deployment's tool catalog. */
  readonly agentToolCatalog: Record<string, Tool>;
  /** The file agent runtime, if configured. */
  readonly fileAgents: FileAgentRuntime | undefined;
  /** The agent catalog, once built. */
  readonly agentCatalog: ReturnType<typeof createAgentCatalog<D>>;
  /** The workflow runtime, if configured. */
  readonly workflowRuntime: WorkflowRuntime | undefined;
  /** The current steering sweep. */
  readonly steeringSweep: Promise<void>;
  /** Validates a request authority, if configured. */
  readonly requestAuthorityValidator:
    ((context: ToolRequestContext) => boolean | Promise<boolean>) | undefined;
  /** Whether durable recovery has started. */
  readonly durableRecoveryStarted: boolean;
  /** Whether live frames are subscribed. */
  readonly liveFramesSubscribed: boolean;
  /** Frames queued for replay. */
  readonly frameReplayQueue: ServerFrame[] | undefined;
  /** Follows fire reviews closed elsewhere, with durable history. */
  readonly fireReviewFollower: FireReviewFollower | undefined;
  /** The audit trail, once built. */
  readonly auditTrailInstance: AuditTrail | undefined;
  /** The webhook notifier, once built. */
  readonly webhookNotifierInstance: WebhookNotifier | undefined;
  /** The scorer sampler, once built. */
  readonly scorerSamplerInstance: ScorerSampler | undefined;
  /** The durable event producer, once built. */
  readonly durableEventProducerInstance: DurableEventProducer | undefined;
  /** The task history resync, once built. */
  readonly taskResyncInstance: TaskResync | undefined;
  /** The shutdown in progress, if any. */
  shutdownPromise: Promise<BureauShutdownReport> | undefined;
  /** Whether shutdown has closed run admission. */
  runAdmissionClosed: boolean;
  /** The lazy expiry sweep pass in flight. */
  lazyExpirySweepPass: Promise<void> | undefined;
  /** Per-run failures of the current recovery pass. */
  currentRecoveryPerRunFailures: Array<{ runId: string; reason: string }> | undefined;
  /** The sweep failure of the current recovery pass. */
  currentRecoverySweepFailure: { message: string } | undefined;
  /** Runs the current recovery pass skipped. */
  currentRecoverySkippedRuns: Array<{ runId: string; type: string }> | undefined;
  /** Whether a recovery pass is running. */
  recoveryPassActive: boolean;
  /** The boot pass of the task resync. */
  taskResyncBootPass: Promise<void> | undefined;
  /** The outbox retry timer. */
  outboxRetryTimerHandle: RuntimeTimeoutHandle;
  /** When the outbox retry timer fires. */
  outboxRetryTimerArmedForMs: number | undefined;
  /** The outbox drain in flight. */
  outboxDrainInFlight: Promise<void> | undefined;
  /** Whether shutdown has closed maintenance admission. */
  maintenanceAdmissionClosed: boolean;
  /** The automatic run ownership prune timer. */
  automaticRunOwnershipPruneTimer: RuntimeTimeoutHandle;
  /** Whether the automatic run ownership prune timer started. */
  automaticRunOwnershipPruneTimerStarted: boolean;
  /** The automatic run ownership prune pass in flight. */
  automaticRunOwnershipPruneCurrentPass: Promise<void> | undefined;
  /** The agents being tried. */
  readonly tryAgents: ReturnType<typeof createTryAgents>;
  /** The flow controller, if configured. */
  readonly flowController: FlowController | undefined;
  /** The hook origins of schedules. */
  readonly scheduleHookOrigins: ReturnType<typeof createRunHookOrigins>['scheduleHookOrigins'];
  /** The run creation ledger, with a key-value store. */
  readonly runCreationLedger: ReturnType<typeof createRunCreationLedger> | undefined;
  /** The session input delivery store, with a durable engine. */
  readonly sessionInputDeliveryStore:
    ReturnType<typeof createSessionInputDeliveryStore> | undefined;
  /** Settles session input deliveries, with a durable engine. */
  readonly sessionInputSettlement: ReturnType<typeof createSessionInputSettlement> | undefined;
  /** The spend of each chat. */
  readonly chatSpendLedger: ReturnType<typeof createChatSpendLedger>;
  /** This process's lease. */
  readonly processLease: ReturnType<typeof openProcessLease>;
  /** The task registry. */
  readonly tasks: TaskRegistry;
  /** The notifications. */
  readonly notificationsComposition: ReturnType<typeof createNotifications>;
  /** Settles catalog runs. */
  readonly catalogRunSettlements: ReturnType<typeof createCatalogRunSettlementHook>;
  /** Tracks catalog settlements. */
  readonly catalogSettlements: ReturnType<typeof createCatalogSettlementTracker>;
  /** Drains catalog asset releases. */
  readonly catalogAssetReleases: ReturnType<typeof createCatalogAssetReleaseDrain>;
  /** Releases catalog run assets. */
  readonly catalogRunAssets: ReturnType<typeof createCatalogRunAssetReleaser>;
  /** Seeds fire reviews. */
  readonly fireReviewSeeds: ReturnType<typeof createFireReviewSeeds>;
  /** This Bureau's subscription to `store`. */
  readonly storeSubscription: Subscription;
  /** Loads and saves sessions. */
  readonly sessionPersistence: ReturnType<typeof createSessionPersistence>;
  /** Sweeps abandoned tasks. */
  readonly abandonedTaskSweeper: ReturnType<typeof createAbandonedTaskSweeper>;
  /** The owner id of this process's outbox drainer. */
  readonly outboxDrainOwner: string;
  /** The memory authority maintenance uses. */
  readonly maintenanceMemoryAuthority: ReturnType<typeof createMaintenanceMemoryAuthority>;
  /** Purges chat content. */
  readonly chatContentPurge: ReturnType<typeof createChatContentPurge>;
  /** Reconciles asset claims. */
  readonly assetClaimReconciler: ReturnType<typeof createAssetClaimReconciler>;
  /** The session fork ledger. */
  readonly forkLedger: ReturnType<typeof createForkLedger>;
  /** The durable storage, when it persists. */
  readonly persistentDurableStorage:
    NonNullable<RuntimeComposition['durable']>['engine']['storage'] | undefined;
  /** The durable event history, with persistent storage. */
  readonly eventHistoryInstance: DurableEventHistory | undefined;
  /** The interactive surfaces. */
  readonly surfaces: ReturnType<typeof createBureauInteractiveSurfaces>;
  /** The review decision records. */
  readonly reviewDecisions: ReturnType<typeof createReviewDecisionRecords>;
  /** The resolved review store. */
  readonly resolvedReviewStore: ReturnType<typeof createResolvedReviewStore>;
  /** The human waits of runs. */
  readonly runHumanWaits: ReturnType<typeof createRunHumanWaits>;
  /** The review waits of workflows. */
  readonly workflowReviewWaits: ReturnType<typeof createWorkflowReviewWaits>;
  /** The child topology store. */
  readonly childTopologyStore: ReturnType<typeof createChildTopologyStore>;
  /** The child topology. */
  readonly childTopology: ChildTopology;
  /** The peer call journal. */
  readonly peerCalls: PeerCallJournal;
  /** The goals. */
  readonly goalsComposition: ReturnType<typeof composeBureauGoals>;
  /** The Bureau itself. */
  readonly bureau: Bureau<D>;
}
