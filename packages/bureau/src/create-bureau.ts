import {
  resolveWorkspaceOwner,
  runtimeWorkspaceOwnerAuthority,
} from './http/workspace-principal.ts';
import {
  CompletableEventTarget,
  createDefaultRuntimeServices,
  type HookRegistry,
  type RuntimeServices,
  type RuntimeTimeoutHandle,
} from '@lostgradient/lifecycle';
import {
  type ActiveRun,
  type AgentRun,
  type AgentSession,
  type ChildSignalContract,
  // COR-625: operative's OBJECT-form cleanup acknowledgement, aliased on
  // import because `./types` exports an unrelated string-union type under
  // the same name (armorer's shutdown-owner outcome vocabulary). The two are
  // genuinely different values and must not shadow each other here.
  type CleanupAcknowledgement as RunCleanupAcknowledgement,
  type BackendDescriptor,
  createAgentRunEventRegistry,
  createFlowController,
  createSessionInputDeliveryStore,
  createStore,
  type DurableRunDeps,
  type FlowController,
  hasDefinitionResolver,
  type JSONValue,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  readGenerationProfile,
  resolvesOwnGuardrails,
  RunRegisteredEvent as StoreRunRegisteredEvent,
  RunRemovedEvent as StoreRunRemovedEvent,
  ScheduleAttemptedEvent,
  ScheduleCompletedEvent,
  ScheduleFailedEvent,
  ScheduleSkippedEvent,
  type SessionInputAdmissionOutcome,
  type SessionInputGate,
  SessionOutboxAppendedEvent,
  type SessionSummary,
  type SteeringRequestedValue,
  type PeerCallJournal,
  type Store,
  StoreActionEvent,
  readDurableRunResult,
  type OperativeHookMap,
} from '@lostgradient/operative';
import {
  createSkillArtifactLoader,
  SkillActivatedEvent,
  SkillDeactivatedEvent,
  SkillFailedEvent,
  SkillLoadedEvent,
  SkillRejectedEvent,
} from './skills';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { type Engine, Mailbox, type RecoveredWorkflowInfo } from '@lostgradient/weft';
import { type Tool, type ToolRequestContext } from 'armorer';
import type { PluginHost } from '@lostgradient/interborough-plugin';
import { shutdownThenRethrow } from './composition-failure';
import {
  BUREAU_PLUGIN_NAME,
  validateBuiltInPluginOptions,
  withBuiltInPlugin,
} from './plugins/bureau-plugin';
import { bureauOwnTools, withAgentsBuiltFromBureauTools } from './agents-with-bureau-tools';
import { composePlugins } from './plugins/compose-plugins';
import { createAgentDiscoveryTool } from './create-agent-discovery-tool';
import { createChildRunTools } from './child-run-tools';
import { createAssetTools } from './asset-tools';
import { createPluginRegistry, hostGuardrailRows } from './plugins/plugin-registry';
import { createGoalForPlugin } from './goals';
import {
  type AgentDefinitions,
  type AgentNames,
  createAgentCatalog,
  type CreateAgentCatalogOptions,
} from './agent-catalog';
import { definitionDrift } from './agent-definition-pin';
import { AgentSnapshotError, guardrailIdOf } from './agent-file';
import { createTryAgents, isTryAgentName } from './agent-try';
import {
  createAgentFileCatalog,
  type FileAgentBinding,
  readFileAgentBinding,
} from './agent-file-catalog';
import { createFileAgentRuntime, type FileAgentRuntime } from './agent-file-runtime';
import { createAgentSnapshotStore } from './agent-snapshot-store';
import { createAssetService } from './assets/asset-service';
import {
  createAssetContentSourceResolver,
  createMcpResourceContentSourceResolver,
} from './assets/content-source-resolver';
import { createAssetGeneratedMediaAdmitter } from './assets/generated-media-admitter';
import { runRowHolderId, sessionRowHolderId } from './assets/row-asset-claims';
import { validateHumanInputOption } from './human-input-option';
import {
  validateChildrenOption,
  validateLogsMaximumLinesPerRun,
  validateRetentionOptions,
  validateSessionInputBacklogLimit,
} from './option-validators.ts';
import type { AssetService } from './assets/types';
import { createAssetClaimReconciler } from './asset-claim-reconciliation';
import { purgeChatAssets } from './chat-asset-purge';
import { purgeChatMemories } from './chat-memory-purge';
import { type AuditTrail, computeInitialAuditSequence, createAuditTrail } from './audit-trail';
import { catalogRunGuardrailsContext, createCatalogDispatcher } from './bureau-catalog-dispatch';
import { createBureauEventFeed } from './bureau-event-feed.ts';
import { createBureauEventFormatter } from './bureau-event-formatting.ts';
import {
  createDiagnosticDispatcher,
  forwardAssetEvents,
  forwardDefinitionChanges,
  forwardMemoryGovernance,
  forwardMissedFires,
  subscribeEventFeed,
} from './bureau-event-forwarders.ts';
import { publishWorkflowScheduleOutcomes } from './workflow-schedule-outcomes';
import { auditMemoryCorrections } from './memory-correction-audit.ts';
import { createSessionPersistence } from './bureau-session-persistence';
import { type BureauChildren, type ChildTopology, createChildTopology } from './child-topology';
import { childActionOf } from './child-announcement';
import { createChildTopologyStore } from './child-topology-store';
import { createRunCreationLedger, type RunCreationObservation } from './command-ledger';
import {
  createDurableEventHistory,
  createDurableEventProducer,
  type DurableEventHistory,
  type DurableEventProducer,
} from './durable-event-history';
import { createEventTimestampResolver } from './event-timestamp';
import {
  ActionEvent,
  type BureauEventMap,
  ReviewApprovedEvent,
  ReviewRequestedEvent,
  ReviewDeniedEvent,
  ReviewRejectedEvent,
  RunRegisteredEvent,
  RunSettledEvent,
  RunRemovedEvent,
  NotificationCreatedEvent,
  SessionTaintEvent,
  TaskCleanupAcknowledgedEvent,
  DiagnosticEvent,
} from './events';
import { createGoalAttemptFenceHost } from './goal-attempt-fence';
import { createGoalWorkflowHost } from './goal-ports';
import type { BureauGoals } from './goal-types';
import { createGoalValidatorCatalog } from './goal-validator-catalog';
import { createWorkflowContributions } from './workflow-contributions';
import { composeBureauGoals } from './goals-composition';
import { createAbandonedTaskSweeper, openProcessLease } from './process-lease';
import {
  createDecisions,
  decisionModelNames,
  validateDecisionsModelChoice,
  validateDecisionsOptions,
} from './decisions/create-decisions';
import { createLateDecisions } from './decisions/late-decisions';
import { createSettings, type SettingsComposition } from './settings/create-settings';
import { builtInSettingDefaults } from './settings/setting-defaults';
import { decisionModelFailures, summarizerFailures } from './settings/settings-validation';
import { createMemoryEmbedderSetting, type MemoryEmbedderSetting } from './memory-embedder-setting';
import {
  bootSettings,
  enginePatchOf,
  modelPolicyOf,
  settingsDefaultsOf,
  toolGrantOf,
  validateSettingsOptions,
} from './settings/settings-options';
import { createModels, validateModelsOptions, type Models } from './models/create-models';
import { createScorerSampler, type ScorerSampler } from './scorers';
import { agentTaintThresholdField } from './agent-taint-threshold.ts';
import { disposeRunEventFeed } from './run-event-feed-attachment.ts';
import type {
  BureauToolbox,
  CatalogAgentRunOptionsResolution,
  ScheduledFireNotice,
  ScheduledFireServicesNotice,
  ScheduledFireSettlement,
  ScheduledSessionNotice,
} from './runtime-composition-types';
import { createRuntimeComposition } from './runtime-composition';
import { createMaintenanceMemoryAuthority } from './run-memory';
import {
  resolveDiagnosticSink,
  type RunAttribution,
  serializeRunState,
  serializeUnknownError,
} from './serialization';
import { createCatalogTaskSettler } from './catalog-task-settlement';
import {
  createCatalogAssetReleaseDrain,
  createCatalogRunAssetReleaser,
  createRecoveredRunReleaseListener,
} from './catalog-run-asset-release';
import {
  createCatalogRunSettlementHook,
  type DurableEnd,
  type DurableEndReader,
  createCatalogSettlementTracker,
} from './catalog-run-settlement';
import {
  createTaskRegistry,
  originatingMessageText,
  settledTaskState,
  TASK_ARTIFACT_TEXT_LIMIT,
  TASK_STATUS_MESSAGE_LIMIT,
  type LiveTask,
  type TaskRegistry,
  type TaskToolGrant,
} from './task-registry';
import { createTaskResync, type TaskResync } from './task-resync';
import { ANONYMOUS_LOCAL_OWNER, ownerOrLocal, SCHEDULER_ACTOR } from './owner-of-record';
import { storedScheduleInput, workflowScheduleBinding } from './workflow-schedule';
import {
  createWorkflowRuntime,
  payloadMaximumBytesOf,
  type WorkflowRuntime,
} from './workflow-runtime';
import { createBureauWorkerDeployments } from './worker-deployments';
import { everySchedule, readAttention } from './attention-feed';
import { createWorkflowTools } from './workflow-tools';
import { createSettingsTools } from './settings/settings-tools';
import { createWorkflowRevisionLedger } from './workflow-revision-ledger';
import { createWorkflowScheduleHolds } from './workflow-schedule-holds';
import { createAgentOverrideStore } from './agent-override-store';
import { createWorkflowSnapshotStore } from './workflow-snapshot-store';
import { createWorkflowDocumentHost } from './workflow-host';
import { createFireReviewSeeds, trackFireReviewSeeds } from './fire-review-seeds';
import {
  createFireReviewFollower,
  type FireReviewFollower,
  trackFireReviewFollower,
} from './fire-review-follower';
import { createBureauInteractiveSurfaces } from './interactive-surface/bureau-wiring';
import {
  endContinuingScheduledFire,
  type ScheduledFireReviewState,
  trackScheduledFireReviewState,
} from './scheduled-fire-review-state';
import {
  attributeScheduledFire,
  recordScheduleFired,
  releaseScheduledFire as releaseScheduledFireAttribution,
} from './scheduled-fire-record';
import { isPlainAuthorityRecord } from './session-authority';
import { createReviewDecisionRecords } from './review-decision-record';
import { createResolvedReviewStore } from './resolved-review-record';
import { type SecretAnswerAuditEntry, secretResolverOf } from './secret-answers';
import { createRunHumanWaits } from './run-human-waits';
import { createWorkflowReviewWaits } from './workflow-review-waits';
import { createChatSpendLedger } from './chat-spend-ledger';
import { SESSION_INPUT_DELIVERY_RETENTION_MS } from './session-input-durability';
import { createSessionInputSettlement } from './session-input-settlement';
import { generateSessionOutboxDrainOwnerSuffix } from './session-outbox-drain-owner-suffix';
import { createForkLedger } from './session-fork';
import { createRegenerateLedger } from './session-regenerate';
import {
  type BureauSteeringGate,
  createSteeringCommandLedger,
  type SteeringCommandAdmissionOutcome,
} from './steering';
import type { Bureau, BureauRecoveryReport, BureauShutdownReport } from './bureau-types/facade';
import type { BureauOptions } from './bureau-types/options';
import type { ApprovalDecisionSurface, PendingReview } from './bureau-types/reviews';
import type { ContextDeletionReport } from './bureau-types/contexts';
import type { ServerFrame } from './bureau-types/frames';
import {
  DEFAULT_PRINCIPAL_SESSION_INPUT_BACKLOG_LIMIT,
  DEFAULT_SESSION_INPUT_BACKLOG_LIMIT,
} from './bureau-types/options';
import { isSettlingRunAction } from './run-settlement';
import { createAudit } from './audit/create-audit';
import { createChatContentPurge } from './chat-content-purge';
import { purgeReviewRecords } from './chat-review-purge';
import { purgeChatLedgerEntries } from './chat-ledger-purge';
import { createNotifications } from './notifications/create-notifications';
import { createContexts } from './contexts/create-contexts';
import { createTasks } from './tasks/create-tasks';
import { createReviews } from './reviews/create-reviews';
import { createSchedules } from './schedules/create-schedules';
import { createWebhookNotifier, type WebhookNotifier } from './webhook-notifier';
import { workspaceHookEvents } from './hooks/workspace-hook-events.ts';
import {
  validateRunWorkspaceAuthority,
  createRunAuthorityValidator,
  mayRunUseSharedConfiguration,
} from './run-authority.ts';
import { type CreatedHooks } from './hooks/create-hooks';
import { createRunHookOrigins } from './hooks/run-hook-origins';
import { BureauError, TaskRespondError, toBadRequest } from './bureau-errors';
import { isCommittedElsewhere, terminalActionTimestamp } from './durable-run-waits';
import {
  hasRecoverableTransportAuthority,
  dedupeRecoveryPerRunFailures,
} from './recovered-run-classification';
import {
  type BureauConstruction,
  snapshotWorkspaceOptions,
  withLayeredSources,
  snapshotAnswerEncryption,
  rejectOptInToolOption,
  validateExpiredRecordsOption,
  assertMemoryTenantIsStable,
  BUREAU_AGENT_NAME,
  withPluginContentLayers,
  createBureauMemoryTools,
  assertNoMemoryToolCollision,
  detachBestEffortPromise,
  SESSION_PERSISTENCE_RETRY_DELAY_MILLISECONDS,
  createSessionPersistenceSleep,
  createShutdownTimeoutSleep,
  SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS,
  taskRetentionOf,
  FIRE_REVIEW_RECONCILIATION_MAXIMUM_DELAY_MILLISECONDS,
  notifyPeerCallsReady,
  watcherHealthOf,
  rejectHooksWithoutStorage,
  wantsWebhookNotifier,
  webhookNotifierOptionsOf,
  composeHooks,
  resumeHooks,
} from './bureau-construction-support';
import { NotifyingReviewIdSet } from './approval-state-records';
import { validateAgentRunInput, createTasksRespondLedger } from './run-request-validation';
import {
  type BureauCore,
  type SteeringCursor,
  type SteeringPoller,
  type SessionDeletionRecord,
} from './bureau-seams/core';
import { createEventHistoryReads, type EventHistoryPeers } from './bureau-seams/event-history';
import { createTaskStart, type TaskStartPeers } from './bureau-seams/task-start';
import { createRunCreation, type RunCreationPeers } from './bureau-seams/run-creation';
import { createShutdown, type ShutdownPeers } from './bureau-seams/shutdown';
import { createDurableRecovery, type DurableRecoveryPeers } from './bureau-seams/durable-recovery';
import {
  createScheduleOperations,
  type ScheduleOperationsPeers,
} from './bureau-seams/schedule-operations';
import {
  createSessionInputAdmission,
  type SessionInputAdmissionPeers,
} from './bureau-seams/session-input-admission';
import { createSessionForks, type SessionForksPeers } from './bureau-seams/session-forks';
import {
  createSessionRegeneration,
  type SessionRegenerationPeers,
} from './bureau-seams/session-regeneration';
import {
  createSteeringAdmission,
  type SteeringAdmissionPeers,
} from './bureau-seams/steering-admission';
import { createRecoveredRuns, type RecoveredRunsPeers } from './bureau-seams/recovered-runs';
import { createSessions, type SessionsPeers } from './bureau-seams/sessions';
import { createChildRuns, type ChildRunsPeers } from './bureau-seams/child-runs';
import { createOutbox, type OutboxPeers } from './bureau-seams/outbox';
import { createSessionRestore, type SessionRestorePeers } from './bureau-seams/session-restore';
import { createMaintenance, type MaintenancePeers } from './bureau-seams/maintenance';
import { createRunOwnership, type RunOwnershipPeers } from './bureau-seams/run-ownership';
import { createRunOperations, type RunOperationsPeers } from './bureau-seams/run-operations';
import {
  createTerminalSessions,
  type TerminalSessionsPeers,
} from './bureau-seams/terminal-sessions';
import {
  createReviewAnnouncements,
  type ReviewAnnouncementsPeers,
} from './bureau-seams/review-announcements';
import {
  createApprovalPersistence,
  type ApprovalPersistencePeers,
} from './bureau-seams/approval-persistence';
import {
  createReviewResolution,
  type ReviewResolutionPeers,
} from './bureau-seams/review-resolution';
import {
  createFireApprovalRestore,
  type FireApprovalRestorePeers,
} from './bureau-seams/fire-approval-restore';
import { createSteeringLog, type SteeringLogPeers } from './bureau-seams/steering-log';
import {
  createSessionInputGates,
  type SessionInputGatesPeers,
} from './bureau-seams/session-input-gates';
import { createReviewRecords, type ReviewRecordsPeers } from './bureau-seams/review-records';
import { createLiveFrames, type LiveFramesPeers } from './bureau-seams/live-frames';
import { createRunBookkeeping, type RunBookkeepingPeers } from './bureau-seams/run-bookkeeping';
import {
  createApprovedToolScan,
  type ApprovedToolScanPeers,
} from './bureau-seams/approved-tool-scan';

/**
 * The callables the seams of `constructBureau` read from one another and from the parent: the
 * intersection of every seam's peers. The annotation on `peers` is required: without it, a getter
 * that returns a factory's member makes that factory's inferred type circular (TS7022).
 */
type BureauPeers = EventHistoryPeers &
  TaskStartPeers &
  RunCreationPeers &
  ShutdownPeers &
  DurableRecoveryPeers &
  ScheduleOperationsPeers &
  SessionInputAdmissionPeers &
  SessionForksPeers &
  SessionRegenerationPeers &
  SteeringAdmissionPeers &
  RecoveredRunsPeers &
  SessionsPeers &
  ChildRunsPeers &
  OutboxPeers &
  SessionRestorePeers &
  MaintenancePeers &
  RunOwnershipPeers &
  RunOperationsPeers &
  TerminalSessionsPeers &
  ReviewAnnouncementsPeers &
  ApprovalPersistencePeers &
  ReviewResolutionPeers &
  FireApprovalRestorePeers &
  SteeringLogPeers &
  SessionInputGatesPeers &
  ReviewRecordsPeers &
  LiveFramesPeers &
  RunBookkeepingPeers &
  ApprovedToolScanPeers;

export function createBureau<const D extends AgentDefinitions = Record<never, never>>(
  options: BureauOptions<D>,
): Promise<Bureau<D>> {
  // `constructBureau` resolves this promise itself, as its last step, rather than this function
  // awaiting it: an await here would cost the caller a turn, and a recovered run's first events race
  // the caller's first subscription (COR-1664). Only a failure takes the longer way, through the
  // teardown construction had reached, so a step after the guarded block cannot leave the engine
  // running and the storage in use.
  const result = Promise.withResolvers<Bureau<D>>();
  const construction: BureauConstruction<D> = { built: result.resolve };
  void constructBureau(options, construction)
    .catch((error: unknown) =>
      construction.abandon === undefined ? Promise.reject(error) : construction.abandon(error),
    )
    .catch(result.reject);
  return result.promise;
}

async function constructBureau<const D extends AgentDefinitions>(
  given: BureauOptions<D>,
  construction: BureauConstruction<D>,
): Promise<void> {
  // COR-1873: several definition sources are read as one layered source from here on.
  let options = snapshotWorkspaceOptions(withLayeredSources(given));
  const workspace = options.workspace;
  // COR-1920: the answer keys are the caller's, so they are read once, before the first await.
  const answerEncryption = snapshotAnswerEncryption(options.answerEncryption);
  // AB-194: validated here (BAD_REQUEST at construction time). Admission
  // enforces these same validated values (defaulting to
  // `DEFAULT_SESSION_INPUT_BACKLOG_LIMIT`/`DEFAULT_PRINCIPAL_SESSION_INPUT_BACKLOG_LIMIT`)
  // against the session mailbox.
  validateSessionInputBacklogLimit(
    options.sessionInput?.sessionBacklogLimit,
    'sessionBacklogLimit',
    toBadRequest,
  );
  validateSessionInputBacklogLimit(
    options.sessionInput?.principalBacklogLimit,
    'principalBacklogLimit',
    toBadRequest,
  );
  // COR-1674: an unacceptable answer schema is a startup error, not a failure on the first park.
  rejectOptInToolOption('humanInput', options.humanInput);
  rejectOptInToolOption('wakeup', options.wakeup);
  rejectOptInToolOption('decide', options.decide);
  validateDecisionsOptions(options.decisions, toBadRequest);
  validateHumanInputOption(options.humanInput);
  validateRetentionOptions(options.retention, toBadRequest);
  validateExpiredRecordsOption(options.expiredRecords);
  validateLogsMaximumLinesPerRun(options.logs?.maximumLinesPerRun, toBadRequest);
  validateChildrenOption(options.children, toBadRequest);
  assertMemoryTenantIsStable(options);
  // COR-1577: `bureau` names the Bureau-wide default agent on the session path, which is told
  // apart from a catalog agent by name alone, so a catalog entry called `bureau` would be
  // shadowed there and run under another name on `bureau.run()`. Refused before anything is built.
  if (options.agents !== undefined && Object.hasOwn(options.agents, BUREAU_AGENT_NAME)) {
    throw new BureauError(
      `Agent name "${BUREAU_AGENT_NAME}" is reserved for the Bureau-wide default agent, so a ` +
        `catalog agent cannot use it.`,
      'BAD_REQUEST',
    );
  }
  validateModelsOptions(options.models, toBadRequest);
  // COR-1524: a model written in an agent file has to become a `generate` somehow, and only the
  // host holds the credentials to do it. Refused here rather than leaving every file unusable.
  if (options.agentSource !== undefined) {
    if (options.models?.generate === undefined) {
      toBadRequest(
        '"options.models.generate" is required with "options.agentSource": it turns a model in the model catalog into the generate an agent file runs with',
      );
    }
  }
  // COR-1913: an empty secret would sign nothing, so a host that read it from an unset variable
  // would raise approvals no one can approve, without knowing why.
  if (options.agentApprovalSecret !== undefined && options.agentApprovalSecret.trim() === '') {
    toBadRequest(
      '"options.agentApprovalSecret" must not be empty: it signs the tool approvals file agents raise, so leave it out to raise unsigned ones',
    );
  }
  // COR-1890: the `bureau` namespace and the `built-in` source are the built-in plugin's.
  validateBuiltInPluginOptions(options, toBadRequest);
  const assetServiceHolder: { current: AssetService | undefined } = { current: undefined };
  // COR-1890: the built-in `bureau` plugin contributes Bureau's own tools through the plugin API.
  // The tools read the Bureau when they are called, which is after construction has finished.
  const bureauTools = [
    createAgentDiscoveryTool(
      {
        entries: () => agentCatalog.entries(),
        list: () => agentCatalog.list(),
        find: (name) => agentCatalog.find(name),
      },
      {
        runAgent: async (runId) => runAttribution.get(runId)?.agentName,
        agentDetail: (id) => agentCatalog.detail(id),
      },
    ),
    ...createChildRunTools({
      children: () => childTopologyForWait?.children,
      assets: () => assetServiceHolder.current,
      ownerOfRun: async (runId) => ownerOrLocal(await runOwner(runId)),
      workspaceAuthority: (owner) => runtimeWorkspaceOwnerAuthority(workspace, owner),
      agentDetail: (id) => agentCatalog.detail(id),
      runAgent: async (runId) => runAttribution.get(runId)?.agentName,
    }),
    ...createAssetTools({
      assets: () => assetServiceHolder.current,
      ownerOfRun: async (runId) => ownerOrLocal(await runOwner(runId)),
      workspaceAuthority: (owner) => runtimeWorkspaceOwnerAuthority(workspace, owner),
    }),
    ...(options.workflowSource === undefined
      ? []
      : Object.values(
          // COR-1529: the workflow tools read the workflow runtime and the run's identity when called.
          createWorkflowTools({
            workspace: workspace,
            workflows: () => workflowRuntime?.workflows,
            runIdentity: async (runId) => ({
              agent: runAttribution.get(runId)?.agentName,
              owner: await ownerOf({ kind: 'run', id: runId }),
              hookOrigin: await hookOriginOfRun(runId),
            }),
          }),
        )),
  ];
  // COR-2009 — the code-defined agents built from Bureau's own tools join `agents` before any
  // plugin is composed, so a plugin agent of the same name is a clash, as with any host agent.
  const agentsWithOwnTools = withAgentsBuiltFromBureauTools(
    options.agents,
    options.agentsWithBureauTools,
    bureauOwnTools(bureauTools),
    BUREAU_AGENT_NAME,
    toBadRequest,
  );
  if (agentsWithOwnTools !== undefined) options = { ...options, agents: agentsWithOwnTools };
  // COR-1879 — plugin setup runs once the caller's options are known to be usable, and what the
  // running plugins contribute is folded into the options the rest of construction reads.
  // COR-2118 — the guardrails the host gave, read before plugins' join them (and before any await),
  // so a listing tells them apart.
  const hostGuardrails = hostGuardrailRows(options.agentContributions);
  const composedPlugins = await composePlugins({
    ...options,
    plugins: withBuiltInPlugin(options.plugins, bureauTools),
  });
  options = composedPlugins.options;
  options = withPluginContentLayers(options, given, composedPlugins.shippedContent);
  // `decisions.model` names a catalog row, or a decision model the host registered in code.
  validateDecisionsModelChoice(options.decisions, toBadRequest);
  const pluginRegistry = createPluginRegistry(composedPlugins.records, {
    guardrails: hostGuardrails,
  });
  // COR-1721 — the one choke point every Bureau diagnostic passes through: it reaches the sink, and,
  // once the emitter below is bound, is dispatched as a `diagnostic` event (level and scope only).
  const diagnostics = createDiagnosticDispatcher(resolveDiagnosticSink(options.onDiagnostic));
  const { diagnose } = diagnostics;
  // COR-1710 — the settings: validated here, read in `bootSettings` below, before the engine.
  const settingsLocked = validateSettingsOptions(options, toBadRequest);
  const settingsDefaults = settingsDefaultsOf(options);
  const diagnoseSettings = (message: string, cause?: unknown): void =>
    diagnose({
      level: 'warn',
      scope: 'settings',
      message,
      ...(cause === undefined ? {} : { cause }),
    });
  let settingsComposition: SettingsComposition | undefined;
  // COR-1898 — the reader of `memory.embedder`, built with the settings and run by every maintenance pass.
  let memoryEmbedder: MemoryEmbedderSetting | undefined;
  // COR-1710 — the task registry, for the grant a resumed task reads back; it is built after the
  // runtime composition, whose recovery paths reach it only once composition has finished.
  const taskRegistryHolder: { current?: TaskRegistry } = {};
  /** The tools a task starting now is granted. Before the settings exist, the code options. */
  const toolGrantNow = (): TaskToolGrant => toolGrantOf(currentSettings());
  function currentSettings() {
    return settingsComposition === undefined ? settingsDefaults : settingsComposition.current();
  }
  // COR-435, COR-1710: the session-input backlog limits, read when a session's mailbox is built
  // (the session limit, which Weft's mailbox fixes for its lifetime) and at each admission (the
  // principal limit, and the session limit the cross-session identity read builds a mailbox
  // with), from the settings, over the code options as defaults.
  const sessionInputSessionBacklogLimit = (): number =>
    currentSettings()['sessionInput.sessionBacklogLimit'] ?? DEFAULT_SESSION_INPUT_BACKLOG_LIMIT;
  const sessionInputPrincipalBacklogLimit = (): number =>
    currentSettings()['sessionInput.principalBacklogLimit'] ??
    DEFAULT_PRINCIPAL_SESSION_INPUT_BACKLOG_LIMIT;
  const settingsOf = (): SettingsComposition => {
    if (settingsComposition === undefined) throw new Error('Settings are not composed yet.');
    return settingsComposition;
  };
  const ownsStore = !options.store;
  // AB-260 — resolve the injectable runtime-service seam exactly once,
  // before any subsystem is constructed. Every run, session, schedule,
  // scheduler task, heartbeat tick, audit write, webhook delivery, and
  // background evaluation this bureau starts reads THIS single instance —
  // never `options.runtime` again, and never a process global directly. A
  // caller who omits `runtime` gets the real-globals default, identical to
  // this bureau's behavior before this option existed. Named `runtimeServices`
  // (not `runtime`) to avoid colliding with the pre-existing local `runtime`
  // below, which names the unrelated `RuntimeComposition` value.
  const runtimeServices: RuntimeServices = options.runtime ?? createDefaultRuntimeServices();
  // COR-1524: when this Bureau was built, on its own clock, for telling a reference left by an
  // earlier process apart. COR-2009: a plugin that did not load needs attention from here, and a
  // missed window that began before it is the catch-up after the host was off. Every time it is
  // compared with is the Bureau's clock's or the engine's, which reads the same one.
  const constructedAtMilliseconds = runtimeServices.clock.now();
  // AB-388: ONE resolver shared by `createAuditTrail` and
  // `createDurableEventProducer` below — see `event-timestamp.ts`. Declared
  // this early (well before either subsystem exists) so both constructions
  // reference the identical instance.
  const eventTimestamp = createEventTimestampResolver(runtimeServices);
  // AB-387 — `createStore()` must draw `Action.timestamp` from the SAME
  // resolved `runtimeServices` instance every other bureau subsystem reads,
  // not operative's own real-clock default. Without this, a bureau built
  // with a manual runtime still stamps actions from `Date.now()`, so a test
  // had to construct and pass a pre-built store just to get deterministic
  // timestamps (AB-370's regression test did exactly that before this fix).
  const store: Store = options.store ?? createStore({ runtime: runtimeServices });
  const emitter = new CompletableEventTarget<BureauEventMap>();
  const bureauId = options.id ?? runtimeServices.identifiers.next('bureau');
  // A bureau owns its own events: every dispatch onto `emitter` is also
  // recorded here, with cursors, so a reconnecting client resumes instead of
  // missing whatever happened while it was away. `toObservable()` is the
  // emitter's all-types interception point, so this needs no per-type list
  // and cannot drift from `BureauEventMap`. Events the feed has no
  // projection for are dropped by `publish`, which is what keeps the
  // supervisor's task and synthesis events off it.
  // COR-1939: the hooks are built after the Bureau they listen to, so the feed reaches them through
  // this cell.
  let hooksInstance: CreatedHooks | undefined;
  const eventFeed = createBureauEventFeed({
    bureauId,
    now: runtimeServices.clock.now,
    onPublish: (envelope) => hooksInstance?.dispatch(envelope),
  });
  // COR-1876: the event formatters plugins contribute; a clash between two is refused here.
  const eventFormatter = createBureauEventFormatter(options.formatters, (message, cause) =>
    diagnostics.diagnose({ level: 'warn', scope: 'events', message: `[bureau] ${message}`, cause }),
  );
  // Guarded for the reason `emitLiveFrame` is (AB-96): `dispatchEvent` walks its all-events
  // listeners unguarded, so a throw here would propagate out of whichever `emitter.dispatch` call
  // was in flight — several of which run synchronously inside run setup, where an exception leaves a
  // run launched but untracked. Its failures go to the sink only: a `diagnostic` event would be
  // recorded by the same failing feed (COR-1721).
  const eventFeedSubscription = subscribeEventFeed(emitter, eventFeed, diagnostics.report);
  diagnostics.bind((event) => emitter.dispatch(event));
  // COR-1721 — the forwarders onto the emitter from sources it does not own (assets, file catalogs,
  // the engine's missed fires), stopped at shutdown just before `bureau.disposed`.
  const stopForwarding: Array<() => void> = [];
  // COR-1879 — a plugin missing a declared secret follows the host's `watch` from here, so the
  // secret's save or removal changes its contributions with no restart; stopped at shutdown.
  stopForwarding.push(composedPlugins.watchSecrets());
  // COR-1421 — `onEvent` listens from here, before any recovery pass can
  // dispatch, so it hears the boot-time events a listener added after
  // `createBureau()` returns would miss. It is registered AFTER the event
  // feed's recorder above, so an event is recorded before the host callback
  // runs and anything the callback dispatches in turn lands after it. A
  // rejected promise from an async callback is reported like a throw.
  if (options.onEvent) {
    const onEvent = options.onEvent;
    const reportOnEventFailure = (event: Event, error: unknown): void => {
      // COR-1721 — a failure on a `diagnostic` event goes to the sink only. A rejected promise is
      // reported after the dispatch has returned, outside the dispatcher's re-entrancy guard, so
      // dispatching it would feed the same listener another `diagnostic` without end.
      const report = event instanceof DiagnosticEvent ? diagnostics.report : diagnose;
      report({
        level: 'error',
        scope: 'events',
        message: `[bureau] onEvent listener failed on a "${event.type}" event:`,
        cause: error,
      });
    };
    emitter.toObservable().subscribe((event: Event) => {
      try {
        const outcome: unknown = onEvent(event);
        if (outcome instanceof Promise) {
          outcome.catch((error: unknown) => reportOnEventFailure(event, error));
        }
      } catch (error) {
        reportOnEventFailure(event, error);
      }
    });
  }
  // ...and its operatives' events: one feed per run, created before the run
  // is registered and reaped when it is removed. See
  // `run-event-feed-attachment.ts`.
  const runEventFeeds = createAgentRunEventRegistry();
  // Snapshot `agents` synchronously, before the first `await` below — the
  // "fixed at createBureau() call time" catalog contract otherwise has a
  // real mutation window: a caller that mutates the SAME `agents` object it
  // passed in (adds/removes/reassigns a key) between calling createBureau()
  // and it resolving would leak that change into `bureau.agents`, since
  // `createRuntimeComposition(options)` is awaited before the catalog used
  // to be built from `options.agents` (review round 2, Codex). A shallow
  // copy preserves key insertion order (the definition-order guarantee)
  // while defeating exactly that window; it does not deep-freeze individual
  // agent values, which is unchanged/out of scope.
  const agentsSnapshot = { ...options.agents } as D;
  // Forward the single resolved instance through `options.runtime` so
  // `createRuntimeComposition`'s own `options.runtime ?? createDefaultRuntimeServices()`
  // resolution (its contract for direct, non-Bureau callers) picks up this
  // SAME instance rather than minting a second default one.
  // COR-851 — the goal controller's workflow is registered on the durable
  // engine this call builds; its ports are bound once the goal control plane
  // exists below.
  const goalWorkflowHost = createGoalWorkflowHost();
  // The self-fence every goal attempt's run is registered with is read from the
  // goal store, which exists only after the runtime composition, so it is bound
  // by `composeBureauGoals` below.
  const goalAttemptFenceHost = createGoalAttemptFenceHost();
  // COR-1709: decisions read the model catalog, which is built after the validators and the
  // runtime, so both reach them through this holder.
  const lateDecisions = createLateDecisions();
  // Built first: two validators registered under one name and version are a
  // startup error, and it should fail before the durable engine exists.
  const goalValidatorCatalog = createGoalValidatorCatalog(
    lateDecisions.bindValidators(options.validators),
  );
  // COR-1510: a run the durable engine resumes on its own (a claim it reclaimed) before
  // `recoverDurableRuns` starts is still handed to `onRecoveredWorkflow`, ahead of its first step.
  // This hook waits for that function to be bound, which `recoverDurableRuns` does when it starts.
  const recoveredWorkflowHandler =
    Promise.withResolvers<(info: RecoveredWorkflowInfo) => Promise<void>>();
  // COR-718: a schedule fire can reach the composition before this factory has built the
  // attribution map and the audit trail that record its owner, so the hook waits for both.
  const scheduledFireHandler =
    Promise.withResolvers<(fire: ScheduledFireNotice) => Promise<void>>();
  // COR-1482: a fire is a task, so the task registry that records it, which is built after the
  // composition, is what its end and its session are reported to.
  const scheduledFireSettledHandler =
    Promise.withResolvers<(settlement: ScheduledFireSettlement) => Promise<void>>();
  const scheduledSessionKnownHandler =
    Promise.withResolvers<(session: ScheduledSessionNotice) => Promise<void>>();
  // COR-1596: a fire's reviews are registered from its services, which the composition builds
  // before the run store, the review maps, and the human-wait index exist.
  const scheduledFireServicesHandler =
    Promise.withResolvers<
      (fire: ScheduledFireServicesNotice, services: DurableRunDeps) => Promise<void>
    >();
  // COR-718: the session store exists before the audit trail that consumes the owner
  // record an expiring session needs, so the hook waits for the recorder the same way.
  const sessionCleanupHandler =
    Promise.withResolvers<(sessions: readonly AgentSession[]) => Promise<void>>();
  // COR-794: the managed-asset owner, on this bureau's runtime services so its timers,
  // identifiers, and deferred cleanup are the bureau's own.
  //
  // COR-716: built BEFORE the composition, and handed to it through this holder, because
  // the composition's scheduler can fire a schedule as soon as the engine exists. A fire
  // that came first would find no asset service and fail its managed assets, typed but
  // spuriously. The asset service needs only these options and the runtime services, so
  // nothing about the composition has to exist first.
  const assetServiceInstance: AssetService | undefined = options.assets
    ? await createAssetService({ ...options.assets, runtime: runtimeServices })
    : undefined;
  assetServiceHolder.current = assetServiceInstance;
  if (assetServiceInstance !== undefined) {
    stopForwarding.push(
      forwardAssetEvents(assetServiceInstance, (event) => emitter.dispatch(event)),
    );
  }
  // COR-1527: the services resolver asks whether a workflow type came from a workflow file, and
  // can be reached before the workflow runtime exists, so it reads this holder.
  const workflowFileTypes: { current: ((type: string) => boolean) | undefined } = {
    current: undefined,
  };
  let childTopologyForWait: ChildTopology | undefined;
  function configureChildWaitServices(services: DurableRunDeps, principal: string): void {
    services.deferredChildCallIds ??= new Set<string>();
    services.childWaitPrincipal = principal;
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
      services.deferredChildCallIds?.add(request.toolCallId);
      return { parked: true };
    };
    services.resolveChildWait = async (request) => {
      const topology = childTopologyForWait;
      if (topology === undefined) return { status: 'not-found' };
      const outcome = await topology.children.wait(
        {
          parentRunId: request.parentRunId,
          childRunId: request.childRunId,
        },
        { signal: AbortSignal.abort() },
      );
      if (outcome.outcome === 'settled')
        return { status: 'settled', child: outcome.child as unknown as JSONValue };
      if (outcome.outcome === 'unobservable')
        return { status: 'unobservable', child: outcome.child as unknown as JSONValue };
      if (outcome.outcome === 'wait-aborted') return { status: 'pending' };
      return { status: 'not-found' };
    };
  }
  // COR-1585 — these two are read by the composition's `claimHolderFor` callback below, so they
  // are declared before the composition is awaited, not with the rest of the run bookkeeping.
  const runSessionIdentifiers = new WeakMap<ActiveRun, string>();
  /**
   * COR-1380 — the session incarnation each run was saved into at dispatch,
   * or recovered against. A run-ownership restore writes only into that
   * incarnation, never into a session deleted and recreated under the same
   * id, where the run's owner would otherwise become a co-owner of a session
   * they never touched. Cleared with `runAttribution` in `deleteRun`.
   */
  const runSessionIncarnations = new Map<string, string>();
  // COR-1710 — the stored settings, read after the asset service is ready (so nothing touches
  // the engine's storage first, COR-716) and before the engine exists.
  const booted = await bootSettings(
    options,
    settingsDefaults,
    settingsLocked,
    diagnoseSettings,
  ).catch((error: unknown) =>
    // A storage that cannot open fails here, after the asset service started, as the
    // composition below would: stop the service and report the storage error.
    shutdownThenRethrow(error, async () => assetServiceInstance?.shutdown()),
  );
  options = booted.options;
  const runtime = await createRuntimeComposition(
    // COR-1546: the resolved identifier, so the memory tenant a run writes under is `Bureau.id`.
    // COR-1721: the wrapped sink, so a diagnostic the composition raises is also a `diagnostic`
    // event; the user's `onDiagnostic` is still called once, inside `diagnose`.
    {
      ...options,
      id: bureauId,
      runtime: runtimeServices,
      onDiagnostic: diagnose,
      ...(answerEncryption === undefined ? {} : { answerEncryption }),
    },
    {
      // COR-2105 — a session's taint, once it is stored: the one `session.tainted` the session gets.
      onSessionTainted: (publication) => emitter.dispatch(new SessionTaintEvent(publication)),
      onScheduleAuthorityDenied: (scheduleId) => {
        runtimeServices.deferred.track(
          pauseInvalidSchedule(scheduleId).catch(() => {
            diagnose({
              level: 'error',
              scope: 'durable-maintenance',
              message: 'Workspace schedule pause could not be persisted; maintenance will retry.',
            });
          }),
          'workspace-schedule-pause',
        );
      },
      configureDurableRun: (_runId, services, principal) => {
        configureChildWaitServices(services, principal);
      },
      // COR-1811 — persisted workflow log lines, when `options.logs` asks for them. The cap is read
      // on every line, so a change to `logs.maximumLinesPerRun` applies to the next one.
      ...(options.logs === undefined
        ? {}
        : {
            workflowLogs: {
              maximumLinesPerRun: () => currentSettings()['logs.maximumLinesPerRun'],
              onError: (error: unknown) =>
                diagnose({
                  level: 'error',
                  scope: 'durable-maintenance',
                  message: `[bureau] Writing workflow log lines failed: ${serializeUnknownError(error)}`,
                  cause: error,
                }),
            },
          }),
      decideToolFor: (owner, offered) => lateDecisions.toolWiringFor(true, owner, offered),
      permissionModeOfRun: (runId) => permissionModeOfRun(runId),
      // COR-1996: read at every step, so a policy change applies to a code agent's next step.
      modelPolicy: {
        current: () => modelPolicyOf(currentSettings()),
        // `models` is assigned later in this function; a step reads it only once the Bureau runs.
        catalog: () => models.catalog().descriptors,
      },
      toolGrantFor: async (taskId) =>
        (await taskRegistryHolder.current?.recordToolGrant(taskId, toolGrantNow())) ??
        toolGrantNow(),
      agentRunReferences: {
        reference: async (runId) => fileAgents?.snapshots.reference(runId),
        record: async (binding, runId) => fileAgents?.recordBoundRun(binding, runId),
      },
      contentSourceResolverFor: (principalId) => {
        const owner = ownerOrLocal(principalId);
        if (assetServiceHolder.current !== undefined) {
          return createAssetContentSourceResolver(assetServiceHolder.current, owner, {
            mcpResources: options.mcpResources,
            workspaceAuthority: runtimeWorkspaceOwnerAuthority(workspace, owner),
          });
        }
        // No asset service: a host that reads MCP resources still resolves a linked one.
        return options.mcpResources === undefined || options.mcpResources.length === 0
          ? undefined
          : createMcpResourceContentSourceResolver(options.mcpResources, owner);
      },
      generatedMediaAdmitterFor: (principalId, rowHolder) =>
        assetServiceHolder.current === undefined
          ? undefined
          : createAssetGeneratedMediaAdmitter(
              assetServiceHolder.current,
              ownerOrLocal(principalId),
              {
                // A row a run commits, and the input row it is seeded with, is claimed by the
                // session that holds it, or by the run when it has none (COR-1581; see
                // `assets/row-asset-claims.ts`). A catalog dispatch (`bureau.run()`, a child, a
                // goal attempt, a workflow step) never has a session, whether or not it is
                // registered with the store, so it holds its own rows.
                workspaceAuthority: runtimeWorkspaceOwnerAuthority(
                  workspace,
                  ownerOrLocal(principalId),
                ),
                claimSeededInput: rowHolder === 'run',
                claimHolderFor:
                  rowHolder === 'run'
                    ? (runId) =>
                        runId === undefined ? undefined : (rowId) => runRowHolderId(runId, rowId)
                    : (runId) => {
                        const runState = runId === undefined ? undefined : store.getRun(runId);
                        if (runId === undefined || runState === undefined) return undefined;
                        const sessionId = runSessionIdentifiers.get(runState.activeRun) ?? '';
                        // The session's incarnation is recorded by the run's first save; before
                        // that nothing is claimed here, and the session's own commit claims the
                        // row. A run the store holds without a session claims nothing here.
                        const incarnation = runSessionIncarnations.get(runId);
                        return sessionId === '' || incarnation === undefined
                          ? undefined
                          : (rowId) => sessionRowHolderId(sessionId, incarnation, rowId);
                      },
              },
            ),
      goalWorkflow: goalWorkflowHost.workflow,
      goalAttemptFence: goalAttemptFenceHost.fence,
      // COR-1586: the resolver is wired below, after the agent file scan, and the engine reclaims
      // runs meanwhile: a run that needs it waits instead of failing or taking the wrong agent.
      awaitsCatalogAgentRunOptionsResolver: true,
      isWorkflowFileType: (type) => workflowFileTypes.current?.(type) ?? false,
      onScheduledFire: async (fire) => {
        const handler = await scheduledFireHandler.promise;
        await handler(fire);
      },
      onScheduledFireSettled: async (settlement) => {
        const handler = await scheduledFireSettledHandler.promise;
        await handler(settlement);
      },
      onScheduledSessionKnown: async (session) => {
        const handler = await scheduledSessionKnownHandler.promise;
        await handler(session);
      },
      onScheduledFireServices: async (fire, services) => {
        const handler = await scheduledFireServicesHandler.promise;
        await handler(fire, services);
      },
      beforeSessionCleanup: async (sessions) => {
        const handler = await sessionCleanupHandler.promise;
        await handler(sessions);
      },
      onRecoveredWorkflow: async (info) => {
        const handler = await recoveredWorkflowHandler.promise;
        await handler(info);
      },
    },
  ).catch((error: unknown) =>
    // The composition failed after the asset service started; stop its work,
    // and report the composition error even if stopping fails.
    shutdownThenRethrow(error, async () => assetServiceInstance?.shutdown()),
  );
  // COR-1527: a workflow file's schedule and instances need the durable engine, so a Bureau
  // without one is refused rather than left with a directory that does nothing.
  if (options.workflowSource !== undefined && !runtime.durable) {
    await shutdownThenRethrow(
      new BureauError(
        '"options.workflowSource" needs a durable engine: configure storage (or durable) so workflow instances and schedules can persist',
        'BAD_REQUEST',
      ),
      async () => {
        await assetServiceInstance?.shutdown();
        runtime.stopUsingStorage();
      },
    );
  }
  // COR-2376: the containers the core holds, hoisted here as pure allocations in their original order.
  const activeRuns = new Set<ActiveRun>();
  /**
   * Runs that reported `run.error` and have not yet dispatched the `run.completed` Operative
   * follows it with. `run.error` takes a run out of `activeRuns`, but its terminal session save
   * happens only on `run.completed`, which a durable run dispatches once its workflow's result
   * settles: `shutdown()` waits for these, without aborting them, before it disposes the engine,
   * or a dispose in that gap rejects the result and leaves the session saying `running` over a
   * durable run that completed (COR-1580).
   */
  const erroredActiveRuns = new Set<ActiveRun>();
  /**
   * Runs this process recovered from the durable engine instead of starting them. A graceful
   * `'abort'` shutdown leaves these running for the next process to recover, as `'detach'` leaves
   * every durable run: only the tasks a process started are its own to cancel (COR-1707).
   */
  const recoveredActiveRuns = new WeakSet<ActiveRun>();
  /**
   * COR-2009 — the runs a shutdown aborted. Their session records why the run ended
   * (`lastRunEndReason: 'host-stopped'`), so a chat the host stopped reads as ended by it.
   */
  const runsStoppedByShutdown = new WeakSet<ActiveRun>();
  // AB-22: runs dispatched through `bureau.run(...)`, tracked separately from
  // `activeRuns` above (which holds only bureau-owned `ActiveRun` internals,
  // not the arbitrary `AgentRun` a catalog `RunnableAgent` may return on the
  // direct/non-durable dispatch path). `dispose()` aborts every entry here
  // the same way it aborts `activeRuns`, so a catalog run in flight cannot
  // outlive the bureau that started it.
  const catalogRuns = new Set<AgentRun<unknown, boolean>>();
  // COR-1302: the ids of `bureau.run()` runs registered on `store` (see
  // `registerCatalogRun`), so the reads that enumerate `createRun`'s
  // session-owned runs — `listRuns`, `listPendingReviews`,
  // `sweepExpiredReviews` — keep enumerating only those, and the store
  // subscription keeps their actions, registration, and release off this
  // bureau's event streams. Released with the rest of a run's per-run state
  // when the run leaves `store` as it settles.
  const catalogRunIds = new Set<string>();
  const runToolboxes = new Set<BureauToolbox>();
  const runToolboxesByRunId = new Map<string, BureauToolbox>();
  /**
   * COR-2106 — the run-scoped `executionContext` of each live run, from the options it was built
   * with (`runScopedExecutionContextOf`), for the approved call that resumes outside the run's step.
   * Released wherever `runToolboxesByRunId` releases the run.
   */
  const runScopedContexts = new Map<string, Record<string, unknown>>();
  /**
   * COR-2299 — the hook plan of each live run (Bureau, plugin and agent tiers), which an approved
   * call's result is scanned with outside the run's step. Released with `runScopedContexts`.
   */
  const runHookPlans = new Map<string, HookRegistry<OperativeHookMap>>();
  const releaseRunScope = (runId: string): void => {
    runScopedContexts.delete(runId);
    runHookPlans.delete(runId);
  };
  // AB-207: Bureau-owned background work (scheduler, online-evals, webhook
  // notifier, audit trail) shares this signal so `shutdown()` can tell an
  // in-flight judge invocation / webhook delivery to hurry up and settle
  // instead of stalling the awaited drain. Threaded into each subsystem at
  // construction time (merged with any caller-supplied signal via
  // `AbortSignal.any`), aborted at the top of `shutdown()` under BOTH
  // policies — Bureau-owned work is stopped identically under `'drain'`
  // (only caller-owned runs get the drain treatment).
  const backgroundShutdownController = new AbortController();
  // AB-67/AB-199 review finding (PR #430 — Codex P1, "Prevent released runs
  // from recreating deleted sessions"): `deleteSession` releases a paused
  // run rather than aborting it (see `settleForDeletion`'s own doc
  // comment), so that run keeps executing with no session left to write
  // to; its terminal `run.completed`/`run.aborted` listener's `saveSession`
  // call would otherwise recreate the just-deleted record via its own
  // `existingSession ?? createAgentSession(...)` fallback. Every runId
  // still live at the moment its session is deleted, or expired through the
  // store's own `cleanup()` (COR-718), is marked here;
  // `saveSession` below checks this set (via `metadata['lastRunId']`, the
  // field every terminal listener already passes) and skips the write
  // entirely for an orphaned run's own terminal transition. Consumed
  // (deleted) exactly once, by whichever terminal listener observes the
  // run first, so a session id legitimately reused later is never blocked
  // by a stale entry.
  const orphanedRunIds = new Set<string>();
  // COR-1622: the pass of the expiry sweep that is under way. The sweep's own timer and its armed
  // flag are local to `createReviewAnnouncements`, which the id sets below reach only through
  // `stopLazyExpirySweepWhenNoneHeld`, when an id is added, after the seam block has run.
  let lazyExpirySweepPass: Promise<void> | undefined;
  // Ids of PendingReview items already resolved via resolveReview() (AB-20).
  // Neither resolution path (resumeApproval, signalSession) mutates the live
  // store in a way listPendingReviews() can detect on its own — resumeApproval
  // re-invokes the tool directly (no run/step event), and a signalled human-wait
  // run may take a moment to produce its next action. This set is the
  // authoritative "already handled" marker so a resolved review disappears
  // from the queue immediately, and is never accidentally resolved twice.
  const resolvedReviewIds = new NotifyingReviewIdSet(() => stopLazyExpirySweepWhenNoneHeld());
  const resolvingReviewIds = new Set<string>();
  const reviewResolutionCleanupPending = new Map<
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
      /**
       * COR-2292: where the first attempt was decided, which its retry records whatever surface
       * the retry came from.
       */
      decisionSurface?: ApprovalDecisionSurface | undefined;
    }
  >();
  const pendingApprovalOverrides = new Map<
    string,
    Extract<PendingReview, { kind: 'tool-approval' }>['approval']
  >();
  // COR-855: how many times each review's approval has been superseded (the
  // policy gated the resumed call again), by review id. Absent means round 0.
  // Persisted beside the override so it survives a restart.
  const pendingApprovalRounds = new Map<string, number>();
  // COR-1717: approvals restored at boot whose resolution had started but never committed, by
  // review id, with the epoch-ms the resolution started (undefined for a legacy marker).
  const interruptedApprovals = new Map<string, number | undefined>();
  // COR-1596: when each fire approval was requested; see `ScheduledFireReviewState`.
  const approvalRequestedAt = new Map<string, number>();
  const terminalReviewSessions = new Map<
    string,
    { sessionId: string; agentName: string; requestedAt: number }
  >();
  /**
   * COR-1596 — the runs of schedule fires that hold a tool approval, registered or restored. It
   * does not gate the terminal-run loop in `listPendingReviews`, which reads
   * `terminalReviewSessions`: it marks the runs whose per-run state is a fire's, which ends only
   * through `releaseScheduledFireApproval` and `releaseScheduledFire`, whichever way an approval or
   * the fire ends.
   */
  const scheduledFireApprovalRuns = new Set<string>();
  // COR-1596: the fires that take another step with an approval pending; see
  // `ScheduledFireReviewState.continuingScheduledFires`.
  const continuingScheduledFires = new Set<string>();
  // A persisted approval can be stale by the time a process restarts. Keep
  // that failure scoped to its review rather than preventing the bureau from
  // recovering unrelated runs.
  const invalidApprovalReviewIds = new NotifyingReviewIdSet(() =>
    stopLazyExpirySweepWhenNoneHeld(),
  );
  // AB-54 usage analytics: agentName/principal resolved deterministically at
  // `createRun` time, keyed by runId. Layer A only (in-memory, like the rest
  // of RunSummary) — a durably recovered run (process restart) has no entry
  // here and `serializeRunState` falls back to the `findRunAgentName`
  // heuristic for `agentName`; `principal` has no such fallback since it is
  // never persisted durably. Entries for a `createRun`-dispatched run are
  // removed on `deleteRun` so this map does not outlive the run it
  // describes. A `bureau.run()` durable catalog dispatch's entry (AB-241)
  // has no `deleteRun` equivalent and is never removed, exactly like
  // `createRun`'s own entry for a run nobody ever calls `deleteRun` on: the
  // run leaves `store` on its own as it settles (COR-1302), and its
  // attribution deliberately outlives that release, since `eventHistory`'s
  // principal gate reads it.
  const runAttribution = new Map<string, RunAttribution>();
  // AB-67/AB-199 — one SteeringGate per session, created (or reused)
  // EAGERLY by `createRunFromRequest` at the start of every in-memory run —
  // NOT lazily on the first `submitSteeringCommand` call, which would miss
  // every run already in flight by the time a caller first pauses it (see
  // the identical note at `createRunFromRequest`'s own gate lookup, and
  // `steering.ts`'s `createSteeringGate` doc comment). `submitSteeringCommand`
  // also creates one on demand for the (rare) case a caller pauses a session
  // whose current run started before this map existed at all (recovery
  // paths), but in ordinary operation the run-start path always wins the
  // race. Held for the bureau's lifetime, like the other per-session maps
  // above, EXCEPT this one is explicitly cleaned up on `deleteSession` (see
  // `deleteSession` below) so a reused session id never inherits a deleted
  // session's pause state / command history / applied floor.
  const steeringGates = new Map<string, BureauSteeringGate>();
  /**
   * COR-435 — one session-input mailbox per session incarnation (COR-1476),
   * for a durably-configured bureau. See `session-input-durability.ts`'s
   * module doc: the cross-session identity index lives in `runtime.kv`
   * directly, not in a second `Mailbox`. Cached for the same reason
   * `steeringMailboxes` is: constructing a second `Mailbox` for the same
   * `(namespace, resourceId)` would defeat the FIFO ordering that is the
   * point of using one.
   */
  const sessionInputMailboxes = new Map<string, Mailbox>();
  /**
   * The pending `run-ended` steering write of each run that is ending (COR-1476).
   * It is the durable not-live write the run's session-input settlement waits
   * for, and rejects when the write failed, so the settlement retries it.
   */
  const steeringRunEndWrites = new Map<string, Promise<void>>();
  /** The session-input settlements of runs that have ended and have not finished (COR-1476). */
  const inFlightSessionInputSettlements = new Set<Promise<void>>();
  /**
   * The save that records a run's end in its session, while it is in flight, by run id. A reader
   * that needs the session as the run left it (`Bureau.whenRunRecorded`) waits on this promise,
   * not on a count of turns of the event loop, so however slow or retried the save is, it is waited
   * for.
   */
  const terminalSessionRecords = new Map<string, Promise<void>>();
  const terminalSessionRecordSettlers = new Map<
    string,
    { resolve: () => void; reject: (reason: unknown) => void }
  >();
  /**
   * Resolves the moment shutdown begins, so a settlement waiting out a retry
   * backoff ends its wait at once instead of after the whole delay.
   */
  const sessionInputClosing = Promise.withResolvers<void>();
  /** The gate of each durable run that has one, disposed when the run ends however it ends. */
  const sessionInputGates = new Map<
    string,
    { readonly gate: SessionInputGate; readonly sessionId: string }
  >();
  const steeringCursors = new Map<string, SteeringCursor>();
  /**
   * The session incarnation each of this process's durably steered runs
   * belongs to, until its `run-ended` is logged. A session deleted and
   * recreated under the same id while an old run is still settling must
   * not count that run as live for the new incarnation.
   */
  const steeringRunIncarnations = new Map<string, string>();
  /**
   * Runs whose local handle has settled. A durable run abandoned to another
   * owner (a lost checkpoint race, a disposed engine) settles with no
   * terminal event and stays `running` in the store, so the store alone
   * cannot say whether this process still drives it.
   */
  const settledLocalRunIds = new Set<string>();
  /** One log operation at a time per session, in this process. */
  const steeringQueues = new Map<string, Promise<unknown>>();
  /**
   * One poller per session while this process drives any of its durable
   * runs. A command admitted in another process reaches these runs only
   * through the log, so the poller folds it here every
   * {@link STEERING_POLL_MS}: a remote pause, resume, or configuration
   * change takes effect at the run's next boundary, and a remote resume
   * releases a run waiting on its pause. A session deleted elsewhere is
   * seen here too: that deletion settles only its own process's gate, so
   * the poller releases this gate's paused runs the same way.
   */
  const steeringPollers = new Map<string, SteeringPoller>();
  /** Polls already running, which shutdown awaits before storage closes. */
  const inFlightSteeringPolls = new Set<Promise<void>>();
  /** Durable steering submissions in progress, which shutdown awaits. */
  const inFlightSteeringSubmissions = new Set<Promise<SteeringCommandAdmissionOutcome>>();
  /**
   * COR-435 — generalizes the `inFlightSessionDeletions` coalescing pattern
   * (see that map's own doc comment, below `deleteSession`) to
   * `(principal, 'session-input', id)`: two concurrent admission attempts
   * for the identical retry identity share ONE in-flight promise rather
   * than racing two independent mailbox admissions. Keyed by a joined
   * string (not a nested Map) for the same reason a plain `Map<string, ...>`
   * suffices for session deletions — the three components are individually
   * unbounded strings, so a delimiter that cannot appear in any of them is
   * used to prevent `("a\x00b", "c")` and `("a", "b\x00c")` from colliding.
   */
  const inFlightSessionInputAdmissions = new Map<string, Promise<SessionInputAdmissionOutcome>>();
  // AB-67/AB-199 — the bureau-wide `(principal, id)` idempotency ledger
  // every session's gate shares (see `steering.ts`'s `createSteeringGate`
  // `ledger` parameter doc comment): a same-`(principal, id)` retry against
  // a DIFFERENT session must resolve to `session-mismatch`, not be silently
  // admitted as an unrelated command in that other session's own ledger.
  const steeringCommandLedger = createSteeringCommandLedger();
  /**
   * The `policyRef` a caller submitted for an in-process model command Bureau resolved, by the
   * session's steering gate and then `principal -> id`: the in-process counterpart of a cursor's
   * `submitted`, which a fork reads to carry the request as the parent made it. Keyed by the gate,
   * the entries leave with it when the session is deleted or expires, as its ledger entries do, so
   * a command id reused afterwards, or a session recreated under the same id, never reads them.
   */
  const submittedSteeringValues = new WeakMap<
    BureauSteeringGate,
    Map<string, Map<string, SteeringRequestedValue>>
  >();
  // Keep the exact host-supplied (or bureau-derived) context for approval
  // resumption. Approval bindings identify the original caller, but are not a
  // substitute for the complete request context and must not mint authority.
  const runRequestContexts = new Map<string, ToolRequestContext>();
  const recoveredRunIds = new Set<string>();
  const scheduledFireReviewState: ScheduledFireReviewState = {
    pendingApprovalOverrides,
    pendingApprovalRounds,
    terminalReviewSessions,
    approvalRequestedAt,
    runRequestContexts,
    runToolboxesByRunId,
    resolvedReviewIds,
    invalidApprovalReviewIds,
    scheduledFireApprovalRuns,
    continuingScheduledFires,
    now: runtimeServices.clock.now,
  };
  const isTransportIssuedAuthority = (context: ToolRequestContext): boolean =>
    workspace !== undefined ||
    (context.authority.authorizationRevision !== 'bureau:1' &&
      context.authority.authorizationRevision !== 'bureau:scheduler:1');
  const liveFrameListeners = new Set<(frame: ServerFrame) => void>();
  const bootFrameRunIds = new Set<string>();
  const bootFrameBuffer: ServerFrame[] = [];
  // COR-625: one memoized terminal-cleanup step per run id. Every trigger
  // MUST route through `runTerminalCheckpointCleanup` rather than calling the
  // step directly — the exactly-once guarantee is the memo, not the triggers.
  // Entries are released only by `deleteRun`, which a caller can reach only
  // for an already-terminal run, so a released entry cannot be re-created by
  // any of today's three triggers. A future API that can re-fire a terminal
  // transition for one run id would break that and must be routed here too. This is what
  // makes the step exactly-once across its three independent triggers — the
  // live run's terminal listeners, a recovered run's terminal listeners, and
  // `cancelDurableRun` on a run this process holds no `ActiveRun` for. Its
  // entries are released when the run is deleted (`deleteRun`), so
  // a long-lived bureau does not retain one promise per run forever.
  const terminalCheckpointCleanups = new Map<string, Promise<RunCleanupAcknowledgement>>();
  // AB-205/AB-37 — ids `abortRun` has already requested cancellation for
  // (`ActiveRun.abort()` called) but whose teardown has not yet genuinely
  // settled. Guards `abortRun` itself against re-calling `abort()` (and
  // re-chaining a `closed()` continuation) on a same-run repeat call while
  // it is still `'running'`; NOT surfaced through `getRun`/`listRuns` — see
  // the doc comment on `abortRun` below for why those two deliberately keep
  // reporting the real, unmodified `'running'` status for a run in this
  // window rather than the transitional `'aborting'` value `abortRun`'s own
  // return reports. An entry is removed once `ActiveRun.closed()` genuinely
  // settles (AB-204); `Store` itself never writes `'aborting'` (see
  // `RunStatus`'s doc comment in `operative/src/store/types.ts`).
  //
  // AB-369: the value is the `runtimeServices.clock.now()` timestamp
  // recorded when `abortRun` first requested cancellation for that run —
  // exposed publicly via `listAbortingRuns()` so a regression in the
  // `closed().then(() => abortingRunIds.delete(id))` cleanup below surfaces
  // as a genuinely observable leak (`BureauQuiescenceReport`, `bureau/test`)
  // instead of an invisible, unbounded-growth bookkeeping mutation.
  const abortingRunIds = new Map<string, number>();
  // AB-15: per-run monotonic sequence counter for run-scoped live frames
  // (`event` and `stream:*`). Stamped once here — the single point where
  // frames reach `emitLiveFrame` — so the store action listener never has to
  // coordinate on sequencing itself.
  // Cleared on `run.removed` (see the store subscription below) so the map
  // does not grow unbounded across a long-lived bureau.
  const runSequenceCounters = new Map<string, number>();
  const sessionPersistenceRetryDelayMilliseconds = SESSION_PERSISTENCE_RETRY_DELAY_MILLISECONDS;
  const sessionPersistenceSleep = createSessionPersistenceSleep(runtimeServices.timers);
  const shutdownTimeoutSleep = createShutdownTimeoutSleep(runtimeServices.timers);
  /**
   * COR-1481 — the review ids already announced with `review.requested`, per run,
   * so a review is announced once however many actions follow it. Dropped with the
   * run.
   */
  const announcedReviewRequests = new Map<string, Set<string>>();
  /**
   * Per run: parks already committed to the durable checkpoint by a previous
   * process, seeded by `reconstructHumanWaitReviewIfParked` on recovery. The
   * live action log only holds this process's parks, so the ordinal of the
   * first live park starts here.
   */
  const humanWaitParkBaseline = new Map<string, number>();
  /**
   * AB-388 (Codex review, PR #597, "Run audit retention for KV-backed
   * non-durable bureaus" / "Isolate the manual audit-retention sub-pass"):
   * `auditTrailInstance` is built whenever `runtime.kv` exists — a
   * storage backend with `durable: false` gives it a `kv`
   * without ever giving `runtime.durable` a durable engine. Gating this whole
   * function's body on `!runtime.durable` (the ORIGINAL shape) made a
   * configured `retention.audit` policy unreachable for exactly that
   * configuration — a manual host's own alarm/Cron trigger calling this
   * got an early `undefined` and never pruned anything, growing the
   * durable audit keys without bound. `runtime.durable.engine.runMaintenance()`
   * is still SKIPPED when there is no durable engine (nothing to
   * maintain), but `pruneStaleRunOwnership()`/`pruneAuditTrail()` are
   * unconditional — both already self-guard on their own preconditions
   * (`eventHistoryInstance`/`sessionStore` and `auditTrailInstance`
   * respectively) and no-op harmlessly when those are absent.
   *
   * Each sub-pass runs under its OWN try/catch, mirroring the automatic
   * timer's identical isolation further below: a `pruneStaleRunOwnership()`
   * rejection (e.g. `sessionStore.list()` failing) must never prevent
   * `pruneAuditTrail()` from running this same call — the two are
   * documented (`packages/bureau/README.md`) as independent sub-passes,
   * and before this fix a manual host's own call here contradicted that
   * for exactly the case a rejection actually happens.
   */
  // AB-388 (Codex review, PR #597, "Await manual pruning before storage
  // teardown"): `automaticRunOwnershipPruneCurrentPass` below only tracks
  // the AUTOMATIC-profile timer's own tick. A caller invoking
  // `maintain()` directly (the manual/serverless profile's own
  // alarm/Cron trigger) has no equivalent tracking, so `shutdown()` could
  // dispose storage while such a call's `pruneStaleRunOwnership()`/
  // `pruneAuditTrail()` sub-passes were still listing, deleting, or writing
  // a watermark/summary. Every in-flight manual call registers its pass
  // here; `shutdown()` drains the set (`Promise.allSettled`, since a
  // rejection is already diagnosed by each sub-pass's own try/catch, or is
  // this function's own re-thrown `engineMaintenanceError`) before backend
  // teardown, alongside the automatic timer's own await.
  const manualDurableMaintenancePasses = new Set<Promise<void>>();
  const inFlightSessionDeletions = new Map<string, Promise<ContextDeletionReport>>();
  const sessionDeletionOwners = new Map<string, SessionDeletionRecord>();
  /** Sessions the store is about to expire, held until their `session.deleted` entry drains. */
  const expiringSessions = new Map<string, AgentSession>();
  const core: BureauCore<D> = {
    options,
    workspace,
    assetServiceHolder,
    assetServiceInstance,
    pluginRegistry,
    ownsStore,
    runtimeServices,
    constructedAtMilliseconds,
    store,
    emitter,
    bureauId,
    eventFeed,
    eventFeedSubscription,
    stopForwarding,
    runEventFeeds,
    agentsSnapshot,
    goalWorkflowHost,
    goalAttemptFenceHost,
    lateDecisions,
    goalValidatorCatalog,
    recoveredWorkflowHandler,
    runSessionIdentifiers,
    runSessionIncarnations,
    runtime,
    diagnose,
    diagnoseSettings,
    currentSettings,
    settingsOf,
    toolGrantNow,
    sessionInputSessionBacklogLimit,
    sessionInputPrincipalBacklogLimit,
    configureChildWaitServices,
    get assertRunAdmissionOpen() {
      return assertRunAdmissionOpen;
    },
    get releaseRunToolboxWhenIdle() {
      return releaseRunToolboxWhenIdle;
    },
    get withBackgroundShutdownSignal() {
      return withBackgroundShutdownSignal;
    },
    get interruptedFields() {
      return interruptedFields;
    },
    get dropPendingApprovalOverride() {
      return dropPendingApprovalOverride;
    },
    activeRuns,
    erroredActiveRuns,
    recoveredActiveRuns,
    runsStoppedByShutdown,
    catalogRuns,
    catalogRunIds,
    runToolboxes,
    runToolboxesByRunId,
    runScopedContexts,
    runHookPlans,
    releaseRunScope,
    backgroundShutdownController,
    orphanedRunIds,
    resolvedReviewIds,
    resolvingReviewIds,
    reviewResolutionCleanupPending,
    pendingApprovalOverrides,
    pendingApprovalRounds,
    interruptedApprovals,
    approvalRequestedAt,
    terminalReviewSessions,
    scheduledFireApprovalRuns,
    continuingScheduledFires,
    invalidApprovalReviewIds,
    runAttribution,
    steeringGates,
    sessionInputMailboxes,
    steeringRunEndWrites,
    inFlightSessionInputSettlements,
    terminalSessionRecords,
    terminalSessionRecordSettlers,
    sessionInputClosing,
    sessionInputGates,
    steeringCursors,
    steeringRunIncarnations,
    settledLocalRunIds,
    steeringQueues,
    steeringPollers,
    inFlightSteeringPolls,
    inFlightSteeringSubmissions,
    inFlightSessionInputAdmissions,
    steeringCommandLedger,
    submittedSteeringValues,
    runRequestContexts,
    recoveredRunIds,
    scheduledFireReviewState,
    isTransportIssuedAuthority,
    liveFrameListeners,
    bootFrameRunIds,
    bootFrameBuffer,
    terminalCheckpointCleanups,
    abortingRunIds,
    runSequenceCounters,
    sessionPersistenceRetryDelayMilliseconds,
    sessionPersistenceSleep,
    shutdownTimeoutSleep,
    announcedReviewRequests,
    humanWaitParkBaseline,
    manualDurableMaintenancePasses,
    inFlightSessionDeletions,
    sessionDeletionOwners,
    expiringSessions,
    get settingsComposition() {
      return settingsComposition;
    },
    get memoryEmbedder() {
      return memoryEmbedder;
    },
    get hooksInstance() {
      return hooksInstance;
    },
    get models() {
      return models;
    },
    get agentToolCatalog() {
      return agentToolCatalog;
    },
    get fileAgents() {
      return fileAgents;
    },
    get agentCatalog() {
      return agentCatalog;
    },
    get workflowRuntime() {
      return workflowRuntime;
    },
    get steeringSweep() {
      return steeringSweep;
    },
    get requestAuthorityValidator() {
      return requestAuthorityValidator;
    },
    get durableRecoveryStarted() {
      return durableRecoveryStarted;
    },
    get liveFramesSubscribed() {
      return liveFramesSubscribed;
    },
    get frameReplayQueue() {
      return frameReplayQueue;
    },
    get fireReviewFollower() {
      return fireReviewFollower;
    },
    get auditTrailInstance() {
      return auditTrailInstance;
    },
    get webhookNotifierInstance() {
      return webhookNotifierInstance;
    },
    get scorerSamplerInstance() {
      return scorerSamplerInstance;
    },
    get durableEventProducerInstance() {
      return durableEventProducerInstance;
    },
    get taskResyncInstance() {
      return taskResyncInstance;
    },
    get shutdownPromise() {
      return shutdownPromise;
    },
    set shutdownPromise(value) {
      shutdownPromise = value;
    },
    get runAdmissionClosed() {
      return runAdmissionClosed;
    },
    set runAdmissionClosed(value) {
      runAdmissionClosed = value;
    },
    get lazyExpirySweepPass() {
      return lazyExpirySweepPass;
    },
    set lazyExpirySweepPass(value) {
      lazyExpirySweepPass = value;
    },
    get currentRecoveryPerRunFailures() {
      return currentRecoveryPerRunFailures;
    },
    set currentRecoveryPerRunFailures(value) {
      currentRecoveryPerRunFailures = value;
    },
    get currentRecoverySweepFailure() {
      return currentRecoverySweepFailure;
    },
    set currentRecoverySweepFailure(value) {
      currentRecoverySweepFailure = value;
    },
    get currentRecoverySkippedRuns() {
      return currentRecoverySkippedRuns;
    },
    set currentRecoverySkippedRuns(value) {
      currentRecoverySkippedRuns = value;
    },
    get recoveryPassActive() {
      return recoveryPassActive;
    },
    set recoveryPassActive(value) {
      recoveryPassActive = value;
    },
    get taskResyncBootPass() {
      return taskResyncBootPass;
    },
    set taskResyncBootPass(value) {
      taskResyncBootPass = value;
    },
    get outboxRetryTimerHandle() {
      return outboxRetryTimerHandle;
    },
    set outboxRetryTimerHandle(value) {
      outboxRetryTimerHandle = value;
    },
    get outboxRetryTimerArmedForMs() {
      return outboxRetryTimerArmedForMs;
    },
    set outboxRetryTimerArmedForMs(value) {
      outboxRetryTimerArmedForMs = value;
    },
    get outboxDrainInFlight() {
      return outboxDrainInFlight;
    },
    set outboxDrainInFlight(value) {
      outboxDrainInFlight = value;
    },
    get maintenanceAdmissionClosed() {
      return maintenanceAdmissionClosed;
    },
    set maintenanceAdmissionClosed(value) {
      maintenanceAdmissionClosed = value;
    },
    get automaticRunOwnershipPruneTimer() {
      return automaticRunOwnershipPruneTimer;
    },
    set automaticRunOwnershipPruneTimer(value) {
      automaticRunOwnershipPruneTimer = value;
    },
    get automaticRunOwnershipPruneTimerStarted() {
      return automaticRunOwnershipPruneTimerStarted;
    },
    set automaticRunOwnershipPruneTimerStarted(value) {
      automaticRunOwnershipPruneTimerStarted = value;
    },
    get automaticRunOwnershipPruneCurrentPass() {
      return automaticRunOwnershipPruneCurrentPass;
    },
    set automaticRunOwnershipPruneCurrentPass(value) {
      automaticRunOwnershipPruneCurrentPass = value;
    },
    get tryAgents() {
      return tryAgents;
    },
    get flowController() {
      return flowController;
    },
    get scheduleHookOrigins() {
      return scheduleHookOrigins;
    },
    get runCreationLedger() {
      return runCreationLedger;
    },
    get sessionInputDeliveryStore() {
      return sessionInputDeliveryStore;
    },
    get sessionInputSettlement() {
      return sessionInputSettlement;
    },
    get chatSpendLedger() {
      return chatSpendLedger;
    },
    get processLease() {
      return processLease;
    },
    get tasks() {
      return tasks;
    },
    get notificationsComposition() {
      return notificationsComposition;
    },
    get catalogRunSettlements() {
      return catalogRunSettlements;
    },
    get catalogSettlements() {
      return catalogSettlements;
    },
    get catalogAssetReleases() {
      return catalogAssetReleases;
    },
    get catalogRunAssets() {
      return catalogRunAssets;
    },
    get fireReviewSeeds() {
      return fireReviewSeeds;
    },
    get storeSubscription() {
      return storeSubscription;
    },
    get sessionPersistence() {
      return sessionPersistence;
    },
    get abandonedTaskSweeper() {
      return abandonedTaskSweeper;
    },
    get outboxDrainOwner() {
      return outboxDrainOwner;
    },
    get maintenanceMemoryAuthority() {
      return maintenanceMemoryAuthority;
    },
    get chatContentPurge() {
      return chatContentPurge;
    },
    get assetClaimReconciler() {
      return assetClaimReconciler;
    },
    get forkLedger() {
      return forkLedger;
    },
    get regenerateLedger() {
      return regenerateLedger;
    },
    get persistentDurableStorage() {
      return persistentDurableStorage;
    },
    get eventHistoryInstance() {
      return eventHistoryInstance;
    },
    get surfaces() {
      return surfaces;
    },
    get reviewDecisions() {
      return reviewDecisions;
    },
    get resolvedReviewStore() {
      return resolvedReviewStore;
    },
    get runHumanWaits() {
      return runHumanWaits;
    },
    get workflowReviewWaits() {
      return workflowReviewWaits;
    },
    get childTopologyStore() {
      return childTopologyStore;
    },
    get childTopology() {
      return childTopology;
    },
    get peerCalls() {
      return peerCalls;
    },
    get goalsComposition() {
      return goalsComposition;
    },
    get bureau() {
      return bureau;
    },
  };
  // Every peer is read through a getter, at call time, so the order of the factory calls below does
  // not matter and a peer may be declared after them.
  const peers: BureauPeers = {
    get runOwner() {
      return runOwner;
    },
    get scheduleOwner() {
      return scheduleOwner;
    },
    get createRunFromRequest() {
      return createRunFromRequest;
    },
    get abortRun() {
      return abortRun;
    },
    get deleteRun() {
      return deleteRun;
    },
    get getRun() {
      return getRun;
    },
    get waitForDurableRun() {
      return waitForDurableRun;
    },
    get deleteSession() {
      return deleteSession;
    },
    get purgeDurableRun() {
      return purgeDurableRun;
    },
    get loadConversation() {
      return loadConversation;
    },
    get saveSession() {
      return saveSession;
    },
    get trackCatalogAssetRelease() {
      return trackCatalogAssetRelease;
    },
    get abortTask() {
      return abortTask;
    },
    get assertTriedAgentBelongsTo() {
      return assertTriedAgentBelongsTo;
    },
    get bindStartSignal() {
      return bindStartSignal;
    },
    get missingAgentError() {
      return missingAgentError;
    },
    get toolGrantFor() {
      return toolGrantFor;
    },
    get triedOriginMetadata() {
      return triedOriginMetadata;
    },
    get abandonTerminalSessionRecord() {
      return abandonTerminalSessionRecord;
    },
    get chatCostBudgetOf() {
      return chatCostBudgetOf;
    },
    get expectTerminalSessionRecord() {
      return expectTerminalSessionRecord;
    },
    get persistTerminalSession() {
      return persistTerminalSession;
    },
    get saveRunTerminalSession() {
      return saveRunTerminalSession;
    },
    get appendThenApplySteering() {
      return appendThenApplySteering;
    },
    get durableSteeringStore() {
      return durableSteeringStore;
    },
    get enqueueSteering() {
      return enqueueSteering;
    },
    get getSessionSteeringGate() {
      return getSessionSteeringGate;
    },
    get logRunBoundarySteering() {
      return logRunBoundarySteering;
    },
    get pollSessionSteering() {
      return pollSessionSteering;
    },
    get settleAbandonedRun() {
      return settleAbandonedRun;
    },
    get sessionInputGateFor() {
      return sessionInputGateFor;
    },
    get settleSessionInputsAfterRunEnd() {
      return settleSessionInputsAfterRunEnd;
    },
    get trackSessionInputSettlement() {
      return trackSessionInputSettlement;
    },
    get durableTerminalCleanup() {
      return durableTerminalCleanup;
    },
    get runTerminalCheckpointCleanup() {
      return runTerminalCheckpointCleanup;
    },
    get emitLiveFrame() {
      return emitLiveFrame;
    },
    get persistPendingApprovalOverrideWithRetry() {
      return persistPendingApprovalOverrideWithRetry;
    },
    get releaseTerminalRunReviewState() {
      return releaseTerminalRunReviewState;
    },
    get disposeRegisteredStreamListeners() {
      return disposeRegisteredStreamListeners;
    },
    get whenActiveRunTerminal() {
      return whenActiveRunTerminal;
    },
    get whenErroredRunEnds() {
      return whenErroredRunEnds;
    },
    get stopLazyExpirySweep() {
      return stopLazyExpirySweep;
    },
    get releaseSessionInputs() {
      return releaseSessionInputs;
    },
    get drainSessionInputSettlements() {
      return drainSessionInputSettlements;
    },
    get appendFireSettledEvent() {
      return appendFireSettledEvent;
    },
    get dispatchRecoveryClassification() {
      return dispatchRecoveryClassification;
    },
    get dispatchRecoveryLeaseReleasedIfAny() {
      return dispatchRecoveryLeaseReleasedIfAny;
    },
    get onRecoveredWorkflow() {
      return onRecoveredWorkflow;
    },
    get reattachRecoveredRun() {
      return reattachRecoveredRun;
    },
    get reconstructHumanWaitReviewIfParked() {
      return reconstructHumanWaitReviewIfParked;
    },
    get recoverGoalsAtBoot() {
      return recoverGoalsAtBoot;
    },
    get skipRunFinishedByPeer() {
      return skipRunFinishedByPeer;
    },
    get sweepSuspendedSchedulerRuns() {
      return sweepSuspendedSchedulerRuns;
    },
    get closeOpenReviewsOfCanceledFire() {
      return closeOpenReviewsOfCanceledFire;
    },
    get restorePendingApprovalStates() {
      return restorePendingApprovalStates;
    },
    get retryCanceledFireCloses() {
      return retryCanceledFireCloses;
    },
    get eventRetentionCutoff() {
      return eventRetentionCutoff;
    },
    get drainOutbox() {
      return drainOutbox;
    },
    get isChildRun() {
      return isChildRun;
    },
    get attachRecoveredSessionInput() {
      return attachRecoveredSessionInput;
    },
    get resolveRecoveredSessionAgent() {
      return resolveRecoveredSessionAgent;
    },
    get recoverRunSteering() {
      return recoverRunSteering;
    },
    get hookOriginOfRun() {
      return hookOriginOfRun;
    },
    get readScheduledAgentInput() {
      return readScheduledAgentInput;
    },
    get sessionOwner() {
      return sessionOwner;
    },
    get isSessionInputClosed() {
      return isSessionInputClosed;
    },
    get tryGetSessionInputMailbox() {
      return tryGetSessionInputMailbox;
    },
    get liveSessionRunIdsEverywhere() {
      return liveSessionRunIdsEverywhere;
    },
    get resolveLiveSessionPreAdmission() {
      return resolveLiveSessionPreAdmission;
    },
    get catchUpSteering() {
      return catchUpSteering;
    },
    get requireSessionStore() {
      return requireSessionStore;
    },
    get listPendingReviews() {
      return listPendingReviews;
    },
    get admitSteeringRequest() {
      return admitSteeringRequest;
    },
    get getRunSessionIdentifier() {
      return getRunSessionIdentifier;
    },
    get agentAllowsModel() {
      return agentAllowsModel;
    },
    get unpricedSwitchRefusalOf() {
      return unpricedSwitchRefusalOf;
    },
    get applySteeringEvent() {
      return applySteeringEvent;
    },
    get applyToCursor() {
      return applyToCursor;
    },
    get asSubmittedRetry() {
      return asSubmittedRetry;
    },
    get createSteeringFoldHistory() {
      return createSteeringFoldHistory;
    },
    get nestedSet() {
      return nestedSet;
    },
    get steeringContention() {
      return steeringContention;
    },
    get restoreResolvedReviewIds() {
      return restoreResolvedReviewIds;
    },
    get restorePendingApprovalOverrides() {
      return restorePendingApprovalOverrides;
    },
    get seedRunSeqGeneration() {
      return seedRunSeqGeneration;
    },
    get catalogDurableEnd() {
      return catalogDurableEnd;
    },
    get persistedApprovalRunIds() {
      return persistedApprovalRunIds;
    },
    get revokePendingApprovalsForRun() {
      return revokePendingApprovalsForRun;
    },
    get retireSessionInputs() {
      return retireSessionInputs;
    },
    get forgetSessionSteering() {
      return forgetSessionSteering;
    },
    get discardTriedRuns() {
      return discardTriedRuns;
    },
    get durableRunCreatedAt() {
      return durableRunCreatedAt;
    },
    get startWorkflowStepRun() {
      return startWorkflowStepRun;
    },
    get chatOfParentRun() {
      return chatOfParentRun;
    },
    get announceFireReview() {
      return announceFireReview;
    },
    get followFireReviews() {
      return followFireReviews;
    },
    get recordResolvedReview() {
      return recordResolvedReview;
    },
    get claimSessionAssets() {
      return claimSessionAssets;
    },
    get loadSessionDeletionOwner() {
      return loadSessionDeletionOwner;
    },
    get releaseSessionGeneratedAssets() {
      return releaseSessionGeneratedAssets;
    },
    get removeSessionDeletionOwner() {
      return removeSessionDeletionOwner;
    },
    get prunePersistedInvalidApprovalReviewStateWithRetry() {
      return prunePersistedInvalidApprovalReviewStateWithRetry;
    },
    get unfollowFireReviewsWhenNoneRemain() {
      return unfollowFireReviewsWhenNoneRemain;
    },
    get releasePeerCalls() {
      return releasePeerCalls;
    },
    get releaseScheduledFire() {
      return releaseScheduledFire;
    },
    get sweepExpiredReviews() {
      return sweepExpiredReviews;
    },
    get pruneStaleRunOwnership() {
      return pruneStaleRunOwnership;
    },
    get pauseInvalidSchedules() {
      return pauseInvalidSchedules;
    },
    get recordPendingScheduleTransitions() {
      return recordPendingScheduleTransitions;
    },
    get listSessions() {
      return listSessions;
    },
    get reconcileAssetClaims() {
      return reconcileAssetClaims;
    },
    get startSessionDeletion() {
      return startSessionDeletion;
    },
    get getReview() {
      return getReview;
    },
    get retryRunDeletionPersistenceWrite() {
      return retryRunDeletionPersistenceWrite;
    },
    get closeCanceledFireHumanWaits() {
      return closeCanceledFireHumanWaits;
    },
    get closeCanceledFireReview() {
      return closeCanceledFireReview;
    },
    get releaseScheduledFireApproval() {
      return releaseScheduledFireApproval;
    },
    get recordReviewStatusTransition() {
      return recordReviewStatusTransition;
    },
    get attributionOf() {
      return attributionOf;
    },
    get durableInputSessionId() {
      return durableInputSessionId;
    },
    get persistSessionUpdate() {
      return persistSessionUpdate;
    },
    get holdsFireApproval() {
      return holdsFireApproval;
    },
    get humanWaitParkOrdinal() {
      return humanWaitParkOrdinal;
    },
    get nextRunSeq() {
      return nextRunSeq;
    },
    get peerRecoveryForApproval() {
      return peerRecoveryForApproval;
    },
    get persistApprovalResolutionStartedWithRetry() {
      return persistApprovalResolutionStartedWithRetry;
    },
    get persistReviewResolutionWithRetry() {
      return persistReviewResolutionWithRetry;
    },
    get adoptPersistedApprovalRound() {
      return adoptPersistedApprovalRound;
    },
    get endScheduledFireWhenNoApprovalRemains() {
      return endScheduledFireWhenNoApprovalRemains;
    },
    get persistedApprovalOf() {
      return persistedApprovalOf;
    },
    get readFireEngineStatus() {
      return readFireEngineStatus;
    },
    get approvedCallAuditOf() {
      return approvedCallAuditOf;
    },
    get buildReviewDecisionAuditRecord() {
      return buildReviewDecisionAuditRecord;
    },
    get grantFieldsOf() {
      return grantFieldsOf;
    },
    get ownerForRecord() {
      return ownerForRecord;
    },
    get prepareHumanWaitDelivery() {
      return prepareHumanWaitDelivery;
    },
    get recordApprovedCall() {
      return recordApprovedCall;
    },
    get recordReviewDecision() {
      return recordReviewDecision;
    },
    get refuseUnsealedSecrets() {
      return refuseUnsealedSecrets;
    },
    get deliverHumanWaitDecision() {
      return deliverHumanWaitDecision;
    },
    get skillPolicyToolboxOf() {
      return skillPolicyToolboxOf;
    },
    get scannedApprovedOutcome() {
      return scannedApprovedOutcome;
    },
    get prunePersistedResolvedReviewIds() {
      return prunePersistedResolvedReviewIds;
    },
    get readCommittedFireApprovals() {
      return readCommittedFireApprovals;
    },
    get reviewAuditOutboxAttachment() {
      return reviewAuditOutboxAttachment;
    },
    get closeAbandonedFireRequests() {
      return closeAbandonedFireRequests;
    },
    get ensureLazyExpirySweep() {
      return ensureLazyExpirySweep;
    },
    get readFireReviewHistory() {
      return readFireReviewHistory;
    },
    get admitApprovedToolResultMedia() {
      return admitApprovedToolResultMedia;
    },
    get markReviewResolvedLocally() {
      return markReviewResolvedLocally;
    },
    get releaseDecidedReview() {
      return releaseDecidedReview;
    },
    get scanApprovedToolResult() {
      return scanApprovedToolResult;
    },
    get abandonSessionInputGate() {
      return abandonSessionInputGate;
    },
    get stopLazyExpirySweepWhenNoneHeld() {
      return stopLazyExpirySweepWhenNoneHeld;
    },
    get assertDecisionFitsInput() {
      return assertDecisionFitsInput;
    },
    get assertExpectedReviewRound() {
      return assertExpectedReviewRound;
    },
    get resolveReview() {
      return resolveReview;
    },
    get restoreRunOwnershipAfterEvent() {
      return restoreRunOwnershipAfterEvent;
    },
    get getSessionSteering() {
      return getSessionSteering;
    },
  };
  // The seam block: synchronous, side-effect-free factories, called before anything can reach them.
  const { readEventHistory, subscribeToEventHistory } = createEventHistoryReads<D>(core, peers);
  const {
    startTask,
    missingAgentError,
    assertTriedAgentBelongsTo,
    triedOriginMetadata,
    toolGrantFor,
    discardTriedRuns,
    tryAgent,
    bindStartSignal,
    abortTask,
  } = createTaskStart<D>(core, peers);
  const { createRunFromRequest, locateRunCreationReceipt } = createRunCreation<D>(core, peers);
  const { shutdown, dispose } = createShutdown<D>(core, peers);
  const { recoverDurableRuns } = createDurableRecovery<D>(core, peers);
  const {
    createSchedule,
    recordScheduleTick,
    getSchedule,
    listSchedules,
    reassignSchedule,
    pauseInvalidSchedule,
    pauseInvalidSchedules,
    pauseSchedule,
    resumeSchedule,
    cancelSchedule,
    recordPendingScheduleTransitions,
    skipNextSchedule,
    unskipSchedule,
    runScheduleNow,
    listScheduleMissed,
    updateSchedule,
  } = createScheduleOperations<D>(core, peers);
  const {
    deliverHumanWaitDecision,
    signalSession,
    submitSessionInput,
    retractSessionInput,
    forgetSessionGrants,
  } = createSessionInputAdmission<D>(core, peers);
  const {
    submitSteeringCommand,
    unpricedSwitchRefusalOf,
    agentAllowsModel,
    forkSession,
    getSessionSteering,
    getContextWindow,
  } = createSessionForks<D>(core, peers);
  const { regenerateSession } = createSessionRegeneration<D>(core, peers);
  const { admitSteeringRequest, resolveLiveSessionPreAdmission, liveSessionRunIdsEverywhere } =
    createSteeringAdmission<D>(core, peers);
  const {
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
  } = createRecoveredRuns<D>(core, peers);
  const {
    listSessions,
    getSession,
    renameSession,
    purgeDurableRun,
    isTerminalDurableStatus,
    descendantRunIdsOf,
    deleteSession,
    startSessionDeletion,
    sessionDeletionOwnerKey,
    prepareSessionsForRemoval,
    loadSessionDeletionOwner,
    removeSessionDeletionOwner,
    abandonSessionRuns,
    claimedRowAssets,
    claimSessionAssets,
    releaseSessionGeneratedAssets,
    reconcileAssetClaims,
  } = createSessions<D>(core, peers);
  const {
    registerCatalogRun,
    registerScheduledFireReviews,
    trackSubordinateRun,
    runWorkflowAgentStep,
    releasePeerCalls,
    resolveChildParent,
    isKnownRun,
  } = createChildRuns<D>(core, peers);
  const { drainOutbox } = createOutbox<D>(core, peers);
  const {
    skillPolicyToolboxOf,
    resolveRecoveredSessionAgent,
    restoreTerminalReviewSession,
    disposeRegisteredStreamListeners,
  } = createSessionRestore<D>(core, peers);
  const {
    durableTerminalCleanup,
    eventRetentionCutoff,
    runTerminalCheckpointCleanup,
    classifyTerminalCheckpointCleanup,
    maintain,
    removeExpiredRecords,
    startAutomaticMaintenance,
  } = createMaintenance<D>(core, peers);
  const {
    attributionOf,
    runOwner,
    durableInputSessionId,
    scheduleOwner,
    readScheduledAgentInput,
    getScheduleAgentName,
    getScheduleBlocker,
    getScheduleInputPreview,
    getScheduleContinuesChat,
    sessionOwner,
    ownerOf,
  } = createRunOwnership<D>(core, peers);
  const {
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
  } = createRunOperations<D>(core, peers);
  const {
    requireSessionStore,
    chatCostBudgetOf,
    persistTerminalSession,
    expectTerminalSessionRecord,
    abandonTerminalSessionRecord,
    whenRunRecorded,
    sessionInputsDeliveredBy,
    drainSessionInputSettlements,
    saveRunTerminalSession,
  } = createTerminalSessions<D>(core, peers);
  const {
    readFireReviewHistory,
    followFireReviews,
    unfollowFireReviewsWhenNoneRemain,
    announceFireReview,
    closeAbandonedFireRequests,
    automaticMaintenanceRuns,
    stopLazyExpirySweepWhenNoneHeld,
    stopLazyExpirySweep,
    ensureLazyExpirySweep,
    announceReviewRequests,
    emitActionFrame,
  } = createReviewAnnouncements<D>(core, peers);
  const {
    reviewAuditOutboxAttachment,
    prunePersistedPendingApprovalOverrides,
    retryRunDeletionPersistenceWrite,
    prunePersistedInvalidApprovalReviewStateWithRetry,
    persistPendingApprovalOverrideWithRetry,
    persistApprovalResolutionStartedWithRetry,
    peerRecoveryForApproval,
    persistReviewResolutionWithRetry,
    prunePersistedResolvedReviewIds,
    restoreResolvedReviewIds,
    readCommittedFireApprovals,
  } = createApprovalPersistence<D>(core, peers);
  const {
    listPendingReviews,
    releaseDecidedReview,
    releaseTerminalRunReviewState,
    admitApprovedToolResultMedia,
    markReviewResolvedLocally,
    assertExpectedReviewRound,
    assertDecisionFitsInput,
    resolveReview,
  } = createReviewResolution<D>(core, peers);
  const {
    readFireEngineStatus,
    closeCanceledFireReview,
    closeCanceledFireHumanWaits,
    closeOpenReviewsOfCanceledFire,
    retryCanceledFireCloses,
    persistedApprovalOf,
    adoptPersistedApprovalRound,
    rereadFireReviews,
    holdsFireApproval,
    endScheduledFireWhenNoApprovalRemains,
    releaseScheduledFireApproval,
    releaseScheduledFire,
    restorableBootApprovals,
    restorePendingApprovalOverrides,
    recoverPeerApproval,
    persistedApprovalRunIds,
    restorePendingApprovalStates,
  } = createFireApprovalRestore<D>(core, peers);
  const {
    settleAbandonedRun,
    durableSteeringStore,
    enqueueSteering,
    getSessionSteeringGate,
    applySteeringEvent,
    createSteeringFoldHistory,
    applyToCursor,
    nestedSet,
    asSubmittedRetry,
    catchUpSteering,
    pollSessionSteering,
    forgetSessionSteering,
    appendThenApplySteering,
    logRunBoundarySteering,
    recoverRunSteering,
    sweepOrphanedSteeringLogs,
    steeringContention,
  } = createSteeringLog<D>(core, peers);
  const {
    tryGetSessionInputMailbox,
    trackSessionInputSettlement,
    sessionInputGateFor,
    attachRecoveredSessionInput,
    releaseSessionInputs,
    settleSessionInputsAfterRunEnd,
    abandonSessionInputGate,
    isSessionInputClosed,
    retireSessionInputs,
  } = createSessionInputGates<D>(core, peers);
  const {
    grantFieldsOf,
    approvedCallAuditOf,
    recordApprovedCall,
    buildReviewDecisionAuditRecord,
    recordResolvedReview,
    ownerForRecord,
    recordResolvedReviewBestEffort,
    recordReviewDecision,
    approvalGrantsOfRun,
    permissionModeOfRun,
    chatOfParentRun,
    recordReviewStatusTransition,
    pendingHumanWaitsOfRun,
    sealHumanWaitAnswer,
    refuseUnsealedSecrets,
    prepareHumanWaitDelivery,
    resolveAnyReview,
    getReview,
    sweepExpiredReviews,
  } = createReviewRecords<D>(core, peers);
  const {
    nextRunSeq,
    seedRunSeqGeneration,
    getRunSessionIdentifier,
    whenErroredRunEnds,
    whenActiveRunTerminal,
    emitLiveFrame,
    deliverLiveFrame,
    liveTaskOf,
  } = createLiveFrames<D>(core, peers);
  const {
    assertRunAdmissionOpen,
    releaseRunToolboxWhenIdle,
    withBackgroundShutdownSignal,
    interruptedFields,
    dropPendingApprovalOverride,
    recordTaskWakeup,
    recordTaskSettlement,
  } = createRunBookkeeping<D>(core, peers);
  const { scanApprovedToolResult, scannedApprovedOutcome } = createApprovedToolScan<D>(core, peers);
  // COR-660 — the per-tick observation pair, forwarded the same way and for
  // the same reason: a scheduled tick is headless, so the bureau emitter is
  // the only surface it has. Fresh instances again, for the WHATWG
  // already-being-dispatched reason above.
  // COR-767 — skill lifecycle, forwarded the same way and for the same reason
  // as the schedule families: the `@lostgradient/bureau/skills` tools dispatch onto the
  // composition's target, and this bureau's emitter is the surface consumers
  // actually subscribe to. Fresh instances again, for the WHATWG
  // already-being-dispatched constraint documented above.
  // COR-1586: the engine is live from here, and reclaims runs on its own interval, so a run that
  // needs the agent run options resolver waits for it (`awaitsCatalogAgentRunOptionsResolver`).
  // If any step of construction fails before the resolver is wired, nothing will ever wire it. The
  // work construction started is stopped, in this order, and the waiting readers are settled
  // LAST, as `unavailable`, before the error is rethrown. Weft treats `unavailable` as a terminal
  // failure when the engine can commit it, so settling first fails a reclaimed run for good;
  // settling after the engine and the store are closed (or fenced off) leaves the run in its
  // persisted state for a correctly configured boot to resume.
  let models: Models;
  /** The deployment's tool catalog; mutable only through `agents.addTools` (COR-2009). */
  let agentToolCatalog: Record<string, Tool>;
  let fileAgents: FileAgentRuntime | undefined;
  /** COR-1911 — the agents being tried, held in memory for the contexts that started them. */
  const tryAgents = createTryAgents();
  let agentCatalog: ReturnType<typeof createAgentCatalog<D>>;
  let workflowRuntime: WorkflowRuntime | undefined;
  // COR-1952: a schedule a hook-started run creates records the hook, and the chain guard reads the
  // record for each run the schedule fires. These closures read `tasks`, declared far below, only
  // when a run is looked up, which is after construction.
  const { scheduleHookOrigins, startedByHook, hookOriginOfRun, subjectsOfRun } =
    createRunHookOrigins({
      kv: runtime.kv,
      workflowOf: async (runId) => runtime.durable?.engine.get(runId),
      taskOriginOf: async (runId) => {
        const record = await tasks.record(runId);
        return record?.origin;
      },
      agentOf: async (runId) => {
        const record = await tasks.record(runId);
        return record?.agentName;
      },
      diagnose,
    });
  const abandonConstruction = async (error: unknown): Promise<never> => {
    const failures: unknown[] = [];
    const attempt = async (stop: () => unknown): Promise<void> => {
      try {
        await stop();
      } catch (stopError) {
        failures.push(stopError);
      }
    };
    // First: each forwarder holds a subscription on something the caller or a later Bureau may
    // keep (the supplied governed memory, the file catalogs), so none outlives a failed build.
    // Drained, so a second pass has nothing left to stop.
    for (const stop of stopForwarding.splice(0)) await attempt(stop);
    await attempt(() => fileAgents?.files.close());
    await attempt(() => assetServiceInstance?.shutdown());
    await attempt(() => runtime.durable?.observability?.dispose());
    await attempt(() => runtime.durable?.engine.shutdown());
    // The store is fenced off before the waiters settle (see above): Bureau never closes a storage
    // it was given, so this is what keeps a settled waiter from committing to it (COR-1767).
    runtime.stopUsingStorage();
    runtime.abandonCatalogAgentRunOptionsResolver(
      `the bureau failed while it was being constructed: ${serializeUnknownError(error)}`,
    );
    if (failures.length === 0) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AggregateError(
      [error, ...failures],
      `${message} (and shutting down after the failure also failed)`,
      { cause: failures[0] },
    );
  };
  try {
    runtime.skillEvents.addEventListener(SkillLoadedEvent.type, (event) => {
      emitter.dispatch(new SkillLoadedEvent(event.skillName, event.correlation));
    });
    runtime.skillEvents.addEventListener(SkillActivatedEvent.type, (event) => {
      emitter.dispatch(new SkillActivatedEvent(event.skillName, event.correlation));
    });
    runtime.skillEvents.addEventListener(SkillDeactivatedEvent.type, (event) => {
      emitter.dispatch(new SkillDeactivatedEvent(event.skillName, event.correlation));
    });
    runtime.skillEvents.addEventListener(SkillRejectedEvent.type, (event) => {
      emitter.dispatch(
        new SkillRejectedEvent(event.skillName, event.reason, event.correlation, event.rule),
      );
    });
    runtime.skillEvents.addEventListener(SkillFailedEvent.type, (event) => {
      emitter.dispatch(new SkillFailedEvent(event.skillName, event.correlation));
    });
    runtime.scheduleFireEvents.addEventListener(ScheduleAttemptedEvent.type, (event) => {
      emitter.dispatch(new ScheduleAttemptedEvent(event.scheduleId, event.occurrence));
    });
    runtime.scheduleFireEvents.addEventListener(ScheduleSkippedEvent.type, (event) => {
      emitter.dispatch(
        new ScheduleSkippedEvent(
          event.scheduleId,
          event.policy,
          event.occurrence,
          event.blockingRunId,
        ),
      );
    });
    // COR-1723 — the supplied governed memory's notifications, so its writes, forgets, and
    // corrections reach the emitter whoever constructed it.
    if (runtime.memory !== undefined) {
      stopForwarding.push(
        forwardMemoryGovernance(runtime.memory, (event) => emitter.dispatch(event), diagnose),
      );
      // COR-2009 — every correction, a person's or an agent's, as the audit log's "Corrected a memory".
      stopForwarding.push(
        auditMemoryCorrections(
          runtime.memory,
          (entry) => auditTrailInstance?.record(entry),
          diagnose,
        ),
      );
    }
    if (runtime.durable !== undefined) {
      // COR-2009: a run a workflow file's schedule started publishes its outcome, as a fire does.
      stopForwarding.push(
        publishWorkflowScheduleOutcomes(runtime.durable.engine, (event) => emitter.dispatch(event)),
      );
      stopForwarding.push(
        forwardMissedFires(
          // COR-1721: the composition listens from the moment the engine exists, and replays here.
          runtime.durable.missedFires,
          (scheduleId) => getSchedule(scheduleId),
          (event) => {
            emitter.dispatch(event);
            // COR-2009: the notice is also a schedule tick, the Bureau's own run.
            void recordScheduleTick(event.scheduleId, (scheduleName) => ({
              event: 'missed-runs',
              scheduleId: event.scheduleId,
              scheduleName,
              missedRuns: event.missedCount,
              reason: event.reason,
              since: event.windowStart,
              until: event.windowEnd,
              whileStopped: event.windowStart < constructedAtMilliseconds,
            }));
          },
          diagnose,
        ),
      );
    }
    // The model namespace. Independent of `runtime`. Constructed BEFORE `agentCatalog` below so
    // the file catalog validates against it; `onReplace` reaches the file agents, which are built
    // after it, so it reads `fileAgents` when it is called.
    models = createModels({
      options: options.models,
      now: runtimeServices.clock.nowISO,
      badRequest: toBadRequest,
      notConfigured: () =>
        new BureauError(
          '"options.models.generate" is required to turn a model in the model catalog into a generate',
          'NOT_CONFIGURED',
          'generate',
        ),
      onReplace: () => {
        // A replace after shutdown began has no one left to validate for.
        if (runAdmissionClosed) return;
        fileAgents?.files.refresh().catch((cause: unknown) =>
          diagnose({
            level: 'error',
            scope: 'agent-files',
            message: '[bureau] could not validate agent files against the replaced model catalog',
            cause,
          }),
        );
      },
      agents: agentsSnapshot,
      settings: currentSettings,
      modelPolicy: () => modelPolicyOf(currentSettings()),
    });
    // COR-1709: decisions read the model catalog and write to the audit trail, which is built
    // later in this function, so the trail is read at each call.
    lateDecisions.compose(
      createDecisions({
        options: options.decisions,
        settings: currentSettings,
        modelPolicy: () => modelPolicyOf(currentSettings()),
        models,
        modelsOptions: options.models,
        notConfigured: (message, cause) => {
          const error = new BureauError(message, 'NOT_CONFIGURED', 'generate');
          if (cause !== undefined) error.cause = cause;
          return error;
        },
        badRequest: toBadRequest,
        audit: async (entry) => {
          await auditTrailInstance?.record(entry);
        },
      }),
    );
    // COR-1710: the settings, over the record read at boot. A live engine key is applied through
    // `engine.reconfigure`, now for the stored values and on every later change.
    memoryEmbedder = createMemoryEmbedderSetting({
      memory: runtime.memory,
      settings: currentSettings,
      bureauSettings: () => settingsComposition?.settings,
      diagnose: diagnoseSettings,
    });
    const embedderSetting = memoryEmbedder;
    settingsComposition = createSettings({
      store: runtime.kv,
      persisted: booted.persisted,
      defaults: settingsDefaults,
      builtInDefaults: builtInSettingDefaults({ persistentStorage: booted.persisted }),
      locked: settingsLocked,
      decisionModels: decisionModelNames(options.decisions),
      // A summarizer must name a row of the catalog as it is at the write (COR-1899), and an
      // embedder one memory can switch to now (COR-1898).
      checkPatch: async (values) => [
        ...summarizerFailures(values, models.catalog().descriptors),
        ...decisionModelFailures(
          values,
          models.catalog().descriptors,
          decisionModelNames(options.decisions),
        ),
        ...(await embedderSetting.failures(values)),
      ],
      afterUpdate: (keys) => embedderSetting.afterUpdate(keys),
      boot: booted.stored,
      nowISO: runtimeServices.clock.nowISO,
      diagnose: diagnoseSettings,
      audit: async (entry) => {
        await auditTrailInstance?.record(entry);
      },
      applyLive: (values, keys) => {
        // COR-1866: a file agent that enables compaction is valid only while a summarizer is
        // configured, and the model catalog does not carry the setting, so the files are checked
        // again here. Unset at boot there is no catalog yet, and its first scan reads the setting.
        if (
          fileAgents !== undefined &&
          keys.includes('context.summarizerModel') &&
          !runAdmissionClosed
        ) {
          fileAgents.files.revalidate().catch((cause: unknown) =>
            diagnose({
              level: 'error',
              scope: 'agent-files',
              message: '[bureau] could not validate agent files against the summarizer setting',
              cause,
            }),
          );
        }
        const engine = runtime.durable?.engine;
        const patch = enginePatchOf(values, keys);
        if (engine === undefined || patch === undefined) return;
        const result = engine.reconfigure(patch);
        if (result.outcome === 'rejected') {
          diagnoseSettings(
            `[bureau] The engine refused the settings ${result.keys.join(', ')}: ${result.message}`,
          );
        }
      },
    });
    // AB-15/AB-22: the typed agent catalog — a plain literal map, fixed for
    // the bureau's lifetime, dispatched by name through `bureau.run`.
    // Independent of `runtime` (bureau-level generate/toolbox/provider
    // composition, still used by `createRun`).
    // `selectorAvailable: true` (AB-250/mod-03c) — `models.plan` below is
    // now wired, so a `selectable` agent's catalog-read profile reports
    // `selector: 'available'` (AB-247/mod-02e's one named mechanism for this
    // transition).
    //
    // COR-1524: with an `agentSource`, the definitions in it join the catalog. They are
    // scanned before the catalog is handed out and before boot recovery runs, so the first
    // `bureau.agents.list()` and a resumed run both see the directory as it is now.
    // COR-1529: with a workflow directory the catalog also holds the workflow tools. They read the
    // workflow runtime and the run's identity when called, which is after construction has finished.
    // COR-1710: the settings tools are always in the catalog; an agent file that lists them gets them.
    const settingsTools = createSettingsTools({
      workspace: workspace,
      settings: () => settingsOf().settings,
      authorityForRun: async (runId) => (await ownerOf({ kind: 'run', id: runId })) ?? undefined,
    });
    const memoryTools = createBureauMemoryTools(
      runtime.memory,
      options.memoryAuthority,
      bureauId,
      async (runId) => (runId === undefined ? undefined : ownerOf({ kind: 'run', id: runId })),
      workspace,
    );
    const memoryToolsByName = Object.fromEntries(
      Object.values(memoryTools).map((tool) => [tool.name, tool]),
    );
    assertNoMemoryToolCollision(options.agentSource, memoryToolsByName);
    agentToolCatalog = {
      ...options.agentSource?.tools,
      ...memoryToolsByName,
      // COR-1879: the plugins' tools, by the `plugin:name` an agent file names them with.
      ...composedPlugins.tools,
      ...settingsTools,
    };
    // COR-1818: the tools Bureau added itself, which the tool catalog reports as its own: the
    // settings tools, and the built-in `bureau` plugin's (COR-1890).
    const bureauToolNames: ReadonlySet<string> = new Set([
      ...Object.keys(settingsTools),
      ...Object.keys(composedPlugins.tools).filter((name) =>
        name.startsWith(`${BUREAU_PLUGIN_NAME}:`),
      ),
    ]);
    // COR-1892: the tools another plugin contributes, which the tool catalog reports as a plugin's.
    const pluginToolNames: ReadonlySet<string> = new Set(
      Object.keys(composedPlugins.tools).filter((name) => !bureauToolNames.has(name)),
    );
    /**
     * COR-1961: the run's owner decides whether a default effort its model cannot do fails the step
     * or is lowered; a run with no owner on record, or an owner whose profile says nothing, rejects.
     * A file agent's and an overridden built-in agent's runs ask it alike.
     */
    async function effortFallbackModeOfRun(
      runId: string | undefined,
    ): Promise<'reject' | 'degrade'> {
      if (runId === undefined) return 'reject';
      const owner = ownerOrLocal(await ownerOf({ kind: 'run', id: runId }));
      const users = modelPolicyOf(currentSettings())?.users;
      const profile = users !== undefined && Object.hasOwn(users, owner) ? users[owner] : undefined;
      return profile?.effortFallbackMode ?? 'reject';
    }
    /**
     * COR-2009 — a built-in agent's overrides apply to its runs as an agent file's settings do: the
     * same model resolver, tool catalog, plugin guardrails, approval secret and effort fallback.
     */
    function codeAgentRunsDeployment(): NonNullable<CreateAgentCatalogOptions['codeAgentRuns']> {
      return {
        ...(options.models?.generate === undefined
          ? {}
          : { resolveGenerate: (row: BackendDescriptor) => models.generate(row) }),
        toolCatalog: () => agentToolCatalog,
        contributions: options.agentContributions,
        approvalSecret: options.agentApprovalSecret,
        ...(runtime.secretAnswers === undefined
          ? {}
          : { secretResolver: secretResolverOf(runtime.secretAnswers) }),
        effortFallbackMode: effortFallbackModeOfRun,
        runtime: runtimeServices,
      };
    }
    // COR-1815: built before the catalog, which asks it which revisions a retained run references.
    const agentSnapshots = createAgentSnapshotStore({
      store: runtime.kv,
      nowISO: runtimeServices.clock.nowISO,
    });
    fileAgents =
      options.agentSource === undefined || options.models?.generate === undefined
        ? undefined
        : createFileAgentRuntime({
            files: createAgentFileCatalog({
              source: options.agentSource,
              reservedIdentifiers: new Set(Object.keys(agentsSnapshot)),
              tools: agentToolCatalog,
              bureauToolNames,
              pluginToolNames,
              models,
              resolveGenerate: (row) => models.generate(row),
              // COR-1980: the settings are live, so a write is judged by the policy as it is now.
              modelPolicy: () => modelPolicyOf(currentSettings()),
              effortFallbackMode: effortFallbackModeOfRun,
              ...(options.agentApprovalSecret === undefined
                ? {}
                : { approvalSecret: options.agentApprovalSecret }),
              // COR-1828: a tool a person allowed for the rest of the chat skips its `on-changes` ask.
              rememberedTools: approvalGrantsOfRun,
              contributions: options.agentContributions,
              // COR-1975: the skills a file's `skills` draws on, read through the host.
              ...(options.agentSkillCatalog === undefined
                ? {}
                : {
                    skills: {
                      catalog: options.agentSkillCatalog,
                      loadArtifact: createSkillArtifactLoader(
                        runtime.kv === undefined ? {} : { storage: runtime.kv },
                      ),
                      events: runtime.skillEvents,
                    },
                  }),
              // COR-1920: a file agent's per-run toolbox resolves secret answers as the Bureau's does.
              ...(runtime.secretAnswers === undefined
                ? {}
                : { secretResolver: secretResolverOf(runtime.secretAnswers) }),
              runtime: runtimeServices,
              // COR-1584: the revision records share the Bureau's store, so a revision survives a
              // restart and two Bureaus on one store agree on it.
              revisionStore: runtime.kv,
              retainedRevisions: (id) => agentSnapshots.referencedRevisions(id),
              diagnose: (message, cause) =>
                diagnose({
                  level: 'error',
                  scope: 'agent-files',
                  message: `[bureau] ${message}`,
                  cause,
                }),
            }),
            snapshots: agentSnapshots,
            diagnose: (message, cause) =>
              diagnose({
                level: 'error',
                scope: 'agent-files',
                message: `[bureau] ${message}`,
                cause,
              }),
            track: (promise, label) => runtimeServices.deferred.track(promise, label),
          });
    await fileAgents?.files.refresh();
    /**
     * COR-2009 — adds a tool source the host connected while the Bureau runs: the tools join the
     * catalog as the host's, and every agent file is checked again, so a file that names one of
     * them is ready without a restart. A name Bureau or a plugin holds is refused, and nothing is
     * added; a name the host already holds is replaced.
     */
    async function addHostTools(tools: Readonly<Record<string, Tool>>): Promise<void> {
      const files = fileAgents?.files;
      if (files === undefined) {
        throw new BureauError(
          'Tools can be added only to a Bureau with an agent source and a model catalog.',
          'UNSUPPORTED_CAPABILITY',
        );
      }
      const added = Object.entries(tools);
      const held = added.find(([name]) => bureauToolNames.has(name) || pluginToolNames.has(name));
      if (held !== undefined) {
        throw new BureauError(
          `Cannot add tool "${held[0]}": the name belongs to ${bureauToolNames.has(held[0]) ? 'Bureau' : 'a plugin'}.`,
          'CONFLICT',
        );
      }
      for (const [name, tool] of added) agentToolCatalog[name] = tool;
      await files.revalidate();
    }
    agentCatalog = createAgentCatalog(agentsSnapshot, {
      selectorAvailable: true,
      addTools: addHostTools,
      files: fileAgents?.files,
      snapshots: fileAgents?.snapshots,
      descriptors: () => models.catalog().descriptors,
      modelPolicy: () => modelPolicyOf(currentSettings()),
      unavailable: composedPlugins.unavailableAgents,
      details: composedPlugins.agentDetails,
      overrides: createAgentOverrideStore({
        store: runtime.kv,
        nowISO: runtimeServices.clock.nowISO,
      }),
      codeAgentRuns: codeAgentRunsDeployment(),
    });
    // COR-2009: the overrides in force of the built-in agents, read before any run can start.
    await agentCatalog.overrides.load();
    // COR-1721 — after the first scan, so the files present at boot are not reported as added.
    stopForwarding.push(
      forwardDefinitionChanges('agents', agentCatalog, (event) => emitter.dispatch(event)),
    );
    // COR-1527: the workflow files. The directory is scanned and the engine told about the documents
    // in `start()`, at the end of construction and before the engine recovers; the `agent` step runs
    // through `runWorkflowAgentStep`, defined below with the rest of the run machinery.
    const workflowContributions = createWorkflowContributions(options.contributionCatalog);
    workflowRuntime =
      options.workflowSource === undefined || runtime.durable === undefined
        ? undefined
        : createWorkflowRuntime({
            workspace,
            resumeAdministrator: async (actor) => {
              if (workspace === undefined) return true;
              const owner = actor?.startsWith('agent-run:')
                ? await runOwner(actor.slice('agent-run:'.length))
                : (actor ?? ANONYMOUS_LOCAL_OWNER);
              if (owner === undefined) return false;
              const member = await resolveWorkspaceOwner(workspace, owner);
              return member?.capabilities.includes('workspace:manage') ?? false;
            },
            source: options.workflowSource,
            // The composition's engine type hides `register`; it is the one Weft `Engine`, and
            // registering documents (`registerSource`) is exactly what it is lent out for here.
            engine: runtime.durable.engine as Engine,
            host: createWorkflowDocumentHost({
              admitActivity: async (argument) => {
                if (workspace === undefined) return;
                const trigger = argument.trigger;
                const sourceSchedule: unknown =
                  typeof trigger === 'object' && trigger !== null
                    ? Reflect.get(trigger, 'scheduleId')
                    : undefined;
                try {
                  const binding = workflowScheduleBinding(trigger);
                  const currentBinding =
                    typeof sourceSchedule === 'string'
                      ? workflowScheduleBinding(
                          await storedScheduleInput(runtime.durable!.engine, sourceSchedule),
                        )
                      : binding;
                  if (
                    currentBinding.authorityHold === undefined &&
                    currentBinding.workspaceAuthority?.actorId ===
                      binding.workspaceAuthority?.actorId &&
                    binding.authorityHold === undefined &&
                    (await validateRunWorkspaceAuthority(workspace, binding.workspaceAuthority)) !==
                      undefined
                  )
                    return;
                } catch {
                  /* Malformed persisted authority is denied and its schedule paused below. */
                }
                const scheduleId: unknown =
                  typeof trigger === 'object' && trigger !== null
                    ? Reflect.get(trigger, 'scheduleId')
                    : undefined;
                if (typeof scheduleId === 'string')
                  runtimeServices.deferred.track(
                    pauseInvalidSchedule(scheduleId).catch(() => {
                      diagnose({
                        level: 'error',
                        scope: 'durable-maintenance',
                        message: 'Workspace schedule pause remains pending.',
                      });
                    }),
                    'workspace-workflow-pause',
                  );
                throw new BureauError('Workspace authority unavailable.', 'CONFLICT');
              },
              runAgentStep: (request) => runWorkflowAgentStep(request),
              contributions: workflowContributions,
            }),
            contributions: workflowContributions,
            snapshotStore: createWorkflowSnapshotStore({
              store: runtime.kv,
              nowISO: runtimeServices.clock.nowISO,
            }),
            revisionLedger: createWorkflowRevisionLedger({
              store: runtime.kv,
              nowISO: runtimeServices.clock.nowISO,
            }),
            scheduleHolds: createWorkflowScheduleHolds({
              store: runtime.kv,
              nowISO: runtimeServices.clock.nowISO,
            }),
            runtime: runtimeServices,
            onPinnedUnavailable: (activity, runId) =>
              pluginRegistry.notePinnedUnavailable(activity, runId),
            diagnose: (message, cause) =>
              diagnose({
                level: 'error',
                scope: 'workflow-files',
                message: `[bureau] ${message}`,
                cause,
              }),
            createError: (message, code) => new BureauError(message, code),
            payloadMaximumBytes: payloadMaximumBytesOf(options.durableGuardrails?.payloadSize),
            track: (promise, label) => runtimeServices.deferred.track(promise, label),
            // The trail is built later in construction; a write only happens after it exists.
            audit: async (entry) => auditTrailInstance?.record(entry),
            hookOrigins: scheduleHookOrigins,
          });
    workflowFileTypes.current = workflowRuntime?.isRegisteredType;
  } catch (error) {
    return abandonConstruction(error);
  }
  // Every later step that fails is stopped the same way, by `createBureau`.
  construction.abandon = abandonConstruction;
  // AB-240: wire boot recovery's catalog branch NOW that the catalog exists —
  // `runtime` (built above, before this catalog) deliberately knows nothing
  // about it (see `RuntimeCompositionOptions`'s doc comment), so this is the
  // one place `resolveRunServices` reaches the catalog from, via the resolver
  // it stores and calls back into. Registered before `recoverDurableRuns()`
  // (called later, once this bureau's construction finishes) so every boot
  // recovery pass sees it.
  //
  // COR-1586 — LINE ORDER MATTERS HERE. Runs parked for this resolver resume at the first
  // top-level `await` after it is wired, and the closure below reads `childTopology`, a `const`
  // declared much further down. A top-level `await` placed between this call and
  // `const childTopology` would resume those runs while it is still in its temporal dead zone,
  // and the resulting `ReferenceError` durably fails them. The catalog reclaim test in
  // `bureau-construction-reclaim.test.ts` catches it.
  runtime.setCatalogAgentRunOptionsResolver(async (name, input, context, runId, recorded) => {
    // COR-1524: a run being resumed builds a file agent from the snapshot it recorded, never
    // from the file, which may have changed or be gone. A run that is starting takes the agent
    // as it is now.
    let agent: ReturnType<typeof agentCatalog.find>;
    let agentBinding: FileAgentBinding | undefined;
    try {
      if (recorded?.agentDefinitionHash !== undefined) {
        if (fileAgents === undefined) {
          throw new AgentSnapshotError(
            'snapshot-unresolvable',
            name,
            recorded.agentDefinitionHash,
            `Run "${runId}" recorded an agent file definition, but this Bureau has no agent directory.`,
          );
        }
        const rebuilt = await fileAgents.agentForRecordedRun(
          name,
          recorded.agentDefinitionHash,
          recorded.definitionRevision,
        );
        agent = rebuilt.agent;
        agentBinding = rebuilt.binding;
      } else {
        // COR-1911 — a tried agent is held for its context's owner and is in no catalog, so no
        // schedule, goal, child or workflow can name it; a session run of it reaches it here.
        // COR-2230 — a run pins the overrides in force where it started, which may be another
        // Bureau on a shared store, and a run that starts here is compared later by whichever
        // Bureau reclaims it. This Bureau's copy is the one it last read, so the store is read
        // before the agent is built and pinned or compared: the agent and the pin then describe
        // the same overrides, and only a change in the store is drift.
        if (!isTryAgentName(name)) {
          await agentCatalog.overrides.reload(name);
        }
        agent = isTryAgentName(name)
          ? tryAgents.find(name, ownerOrLocal(context.principal))
          : agentCatalog.find(name);
        agentBinding = agent === undefined ? undefined : readFileAgentBinding(agent);
      }
    } catch (error) {
      return { status: 'resolver-failed', error };
    }
    if (!agent) return { status: 'missing-agent' };
    // AB-240 review finding: distinct from `'missing-agent'` — the name IS
    // still in the catalog, it just no longer (or never did) exposes AB-21's
    // resolver, e.g. the catalog was reconfigured between restarts to swap
    // this name to a different `RunnableAgent`. Conflating the two produced
    // a misleading "is no longer in the catalog" reason for an agent that
    // genuinely is still there.
    if (!hasDefinitionResolver(agent)) return { status: 'not-durable-capable' };
    // COR-2230 — a code agent's pin, read now from the same overrides the agent above was built
    // from. A run being resumed that pinned the agent's plugin version or overrides is refused
    // when either has moved, before the resolver or a signal port can run for it; a record from
    // before the pin carries neither and recovers as it always did.
    const agentPin = agentBinding === undefined ? agentCatalog.definitionPin(name) : undefined;
    if (recorded !== undefined) {
      const drift = definitionDrift(recorded, agentPin);
      if (drift.length > 0) return { status: 'definition-drifted', agentName: name, drift };
    }
    try {
      // COR-772 — a recovered child gets back its correlation and a freshly
      // opened signal port, bound to the same parent-child pair, before its
      // workflow resumes. Anything else resolves exactly as before.
      const childContext = childTopology.recoveredRunContext(runId);
      // Invoke through the agent so a method-shaped resolver retains its receiver.
      // COR-1367 — the same guardrail inheritance the run's fresh dispatch
      // used, so a recovered run resumes under the policy it started with.
      const resolvedOptions = await agent[OPERATIVE_RESOLVE_RUN_OPTIONS](input, {
        // COR-1828: the run's own id, so a per-run toolbox (a file agent's `toolboxOptions`) can
        // find the chat the run belongs to. A catalog dispatch already names it.
        ...(context.runId === undefined && runId !== '' ? { runId } : {}),
        ...(childContext === undefined ? context : { ...context, ...childContext }),
        ...catalogRunGuardrailsContext(agent),
      });
      const resolution: CatalogAgentRunOptionsResolution = {
        status: 'resolved',
        options: resolvedOptions,
        definitionRevision: readGenerationProfile(agent).revision,
        agentResolvesGuardrails: resolvesOwnGuardrails(agent),
        ...agentTaintThresholdField(agent),
        generationMode: readGenerationProfile(agent).mode,
        recoveredChild: childContext !== undefined,
        ...(agentBinding === undefined ? {} : { agentBinding }),
        ...(agentPin === undefined ? {} : { agentPin }),
      };
      return resolution;
    } catch (error) {
      return { status: 'resolver-failed', error };
    }
  });
  // AB-13 — declarative flow control (concurrency/rate-limit/singleton). One
  // controller instance shared across BOTH `createRun` (API-triggered) and
  // durable schedule fires, so a per-agent concurrency cap counts runs from
  // either surface against the same limit.
  const flowController: FlowController | undefined = options.flowControl
    ? createFlowController(options.flowControl)
    : undefined;
  let shutdownPromise: Promise<BureauShutdownReport> | undefined;
  // COR-690: flipped synchronously the moment `shutdown()` starts, before it
  // snapshots the runs and toolboxes it drains, so an API or scheduler run
  // admitted afterwards can never exist outside that snapshot.
  let runAdmissionClosed = false;

  /**
   * COR-718 — the runs of schedule fires whose attribution this Bureau holds. A fire's
   * entry is released when the fire settles, so a recurring schedule does not grow
   * `runAttribution` by one entry per tick; its owner is then read durably through
   * the schedule (see `runOwner`).
   */
  const firedRunIds = new Set<string>();
  // COR-1585 — registered here, after `runAttribution` and `firedRunIds` exist, not beside the
  // other composition listeners above: the `await fileAgents?.files.refresh()` between them lets a
  // fire settle while these two are still uninitialised, and reading one would throw.
  // AB-223: scheduled fires are headless (no per-run emitter — see
  // `runtime-composition.ts`'s `buildScheduledRunServices`), so a fire's
  // terminal `schedule.completed`/`schedule.failed` has nowhere else to
  // dispatch. Forward each onto this bureau's own emitter, the same sink
  // `pauseSchedule`/`resumeSchedule`/`cancelSchedule` dispatch their
  // definition-level siblings onto.
  // A fresh Event instance for the forwarded dispatch, not a re-dispatch of
  // `event` itself: the WHATWG dispatch algorithm tracks a "being dispatched"
  // flag per Event OBJECT, so re-dispatching the SAME instance onto a second
  // EventTarget while still inside the first target's listener throws
  // "already being dispatched" (this failed loudly in schedule-fire.test.ts
  // before this fix — every scheduled fire's terminal event forwards
  // synchronously, from inside `scheduleFireEvents`' own dispatch).
  runtime.scheduleFireEvents.addEventListener(ScheduleCompletedEvent.type, (event) => {
    releaseScheduledFireAttribution(runAttribution, firedRunIds, event.runId);
    emitter.dispatch(new ScheduleCompletedEvent(event.scheduleId, event.runId));
  });
  runtime.scheduleFireEvents.addEventListener(ScheduleFailedEvent.type, (event) => {
    releaseScheduledFireAttribution(runAttribution, firedRunIds, event.runId);
    emitter.dispatch(new ScheduleFailedEvent(event.scheduleId, event.runId));
  });
  // COR-424 — the run-creation command ledger, in the same store as this
  // bureau's sessions. Receipts promise that a retry after a restart finds
  // the original run, so the ledger exists only where a restart can recover
  // one: a bureau with storage and a durable engine. See `command-ledger.ts`.
  const runCreationKv = runtime.durable ? runtime.kv : undefined;
  const runCreationLedger =
    runCreationKv === undefined
      ? undefined
      : createRunCreationLedger({
          kv: runCreationKv,
          clock: runtimeServices.clock,
          identifiers: runtimeServices.identifiers,
          terminalRetentionMs: () => currentSettings()['retention.receipts']?.olderThan,
          observe: async ({ runId }): Promise<RunCreationObservation> => {
            const runState = store.getRun(runId);
            if (runState !== undefined) {
              return {
                live: serializeRunState(
                  runState,
                  getRunSessionIdentifier(runState),
                  runAttribution.get(runId),
                ),
                durableStatus: undefined,
                settledAt: terminalActionTimestamp(runState.actions),
              };
            }
            const durableState = await getDurableRun(runId);
            return {
              live: undefined,
              durableStatus:
                durableState === undefined ? undefined : (durableState?.status ?? null),
            };
          },
        });

  /**
   * COR-1476 — the per-session record of which run is delivering each admitted
   * input (`session-input-deliveries:v1:{sessionId}`), in the same text-value
   * store the run's checkpoint is written to, so a step's promotion commits in
   * the same batch as its transcript. Absent without a durable engine.
   */
  const sessionInputDeliveryStore =
    runtime.durable !== undefined && runtime.kv !== undefined
      ? createSessionInputDeliveryStore(runtime.kv, {
          retentionMs: SESSION_INPUT_DELIVERY_RETENTION_MS,
          nowMs: runtimeServices.clock.now,
        })
      : undefined;

  /**
   * COR-1476 — the marker index of sessions that may have open input, and the
   * sweep that cancels input no run will deliver. See
   * `session-input-settlement.ts`. Absent without a durable mailbox.
   */
  const sessionInputSettlement =
    runtime.durable !== undefined &&
    runtime.kv !== undefined &&
    sessionInputDeliveryStore !== undefined
      ? createSessionInputSettlement({
          kv: runtime.kv,
          incarnationOf: async (sessionId) => {
            const session = await runtime.sessionStore?.load(sessionId);
            return session?.incarnation;
          },
          liveRunIds: async (sessionId, incarnation) => {
            const steeringKv = durableSteeringStore();
            if (steeringKv !== undefined) {
              await enqueueSteering(sessionId, () =>
                catchUpSteering(steeringKv, sessionId, incarnation),
              );
            }
            return liveSessionRunIdsEverywhere(sessionId, incarnation);
          },
          mailboxOf: tryGetSessionInputMailbox,
          isClosed: isSessionInputClosed,
          diagnose: (message, cause) =>
            diagnose({
              level: 'error',
              scope: 'session-input',
              message: `[bureau] ${message}${cause === undefined ? '' : ` ${serializeUnknownError(cause)}`}`,
              ...(cause === undefined ? {} : { cause }),
            }),
        })
      : undefined;

  let steeringSweep: Promise<void> = Promise.resolve();

  let requestAuthorityValidator:
    ((context: ToolRequestContext) => boolean | Promise<boolean>) | undefined =
    createRunAuthorityValidator(workspace, options.requestAuthorityValidator);
  let durableRecoveryDeferred = false;
  let durableRecoveryStarted = false;
  let durableRecoveryBarrier: Promise<BureauRecoveryReport> = Promise.resolve({
    outcome: 'clean',
    perRunFailures: [],
    skippedRuns: [],
  });
  let resolveDurableRecoveryBarrier: ((report: BureauRecoveryReport) => void) | undefined;
  // COR-1731: the report the barrier resolved with, kept so `internals.diagnostics()` can answer
  // synchronously. `undefined` while a deferred recovery has not finished. A Bureau with no
  // recovery to run starts as clean, like the barrier's own initial value.
  let settledRecoveryReport: BureauRecoveryReport | undefined = {
    outcome: 'clean',
    perRunFailures: [],
    skippedRuns: [],
  };
  // Boot-single-shot collector (see `recoverDurableRuns`'s own doc comment):
  // `dispatchRecoveryClassification` pushes every 'cancel' verdict's
  // {runId, reason} here so `recoverDurableRuns` can aggregate them into its
  // resolved `BureauRecoveryReport.perRunFailures` without a second pass over
  // the event stream. Scoped to the currently-running recovery pass only —
  // `recoverDurableRuns` resets it to `[]` on entry and reads it back at exit.
  let currentRecoveryPerRunFailures: Array<{ runId: string; reason: string }> | undefined;
  // Companion to the collector above: the scheduler-residue sweep's own
  // failure, if any, for THIS pass. `durable.engine.recoverAll()` propagates
  // its throw uncaught out of `recoverDurableRuns` (so the two boot call
  // sites' `.catch()` can build the `batchFailure` report — see that
  // function's own doc comment), which would otherwise lose a sweep failure
  // that happened just before it. Read (and cleared) by both boot call
  // sites' `.catch()` handlers so a sweep failure is never dropped from the
  // resolved report, and never leaks into a later pass.
  let currentRecoverySweepFailure: { message: string } | undefined;
  // COR-1583 — companion to the two above: the runs THIS pass's `recoverAll()` left untouched in
  // storage because their workflow type is not registered, in the order the engine reported them.
  // Read back by the pass's own return and by both boot call sites' `.catch()`, like the others.
  let currentRecoverySkippedRuns: Array<{ runId: string; type: string }> | undefined;
  // COR-1731: subscribers, counted from `frames()` to their unsubscribe. Not the size of
  // `liveFrameListeners`, which a listener joins only once its boot-frame replay has drained.
  let liveFrameSubscriberCount = 0;
  let recoveryPassActive = false;
  /** The boot repair of task histories (COR-1669), which `shutdown()` awaits before storage closes. */
  let taskResyncBootPass: Promise<void> | undefined;

  let liveFramesSubscribed = false;
  // Frames emitted while the first subscriber is being replayed queue behind
  // the remaining replay instead of interleaving with it.
  let frameReplayQueue: ServerFrame[] | undefined;

  // COR-1915: what each run of a chat spent, which a file agent's `limits.cost.chat` is
  // measured against. A Bureau with no key-value store keeps it in memory, as it does its tasks.
  const chatSpendLedger = createChatSpendLedger({ kv: runtime.kv, diagnose });
  // COR-1946: a Bureau over a store that outlives the process names itself on every task it admits
  // and holds a lease under that name, which is how a later boot tells a task whose process is gone
  // from one whose process is another Bureau still running over the same store.
  const processLease = openProcessLease({
    kv: runtime.kv,
    persistence: options.storage?.capabilities().persistence,
    clock: runtimeServices.clock,
    timers: runtimeServices.timers,
    identifiers: runtimeServices.identifiers,
    diagnose: (message, cause) =>
      diagnose({ level: 'error', scope: 'task-registry', message: `[bureau] ${message}`, cause }),
  });
  const tasks = createTaskRegistry({
    kv: runtime.kv,
    clock: runtimeServices.clock,
    identifiers: runtimeServices.identifiers,
    processId: processLease.processId,
    // COR-1594: the end of a fire reaches a stream another process serves through the fire's
    // durable history. A Bureau with no persistent storage has none, and no second process.
    onFireSettled: appendFireSettledEvent,
    onSettled: async (record) => {
      emitter.dispatch(new RunSettledEvent(record.taskId));
    },
    onCleanupAcknowledged: (taskId, cleanup) => {
      emitter.dispatch(new TaskCleanupAcknowledgedEvent(taskId, cleanup));
    },
    diagnose: (message, cause) =>
      diagnose({ level: 'error', scope: 'task-registry', message: `[bureau] ${message}`, cause }),
    host: {
      liveTask: liveTaskOf,
      liveTasksOfContexts: (contextIds) => {
        const wanted = new Set(contextIds);
        const grouped = new Map<string, { taskId: string; phase: LiveTask['phase'] }[]>();
        for (const [runId, runState] of store.getState().runs) {
          const contextId = getRunSessionIdentifier(runState);
          if (!wanted.has(contextId)) continue;
          const phase = liveTaskOf(runId)?.phase;
          if (phase === undefined) continue;
          const held = grouped.get(contextId) ?? [];
          held.push({ taskId: runId, phase });
          grouped.set(contextId, held);
        }
        return grouped;
      },
      // The public list: a `bureau.run()` run's human wait (COR-1577) is a review of its
      // task too, so it holds the task at `input-required` and `respond` can answer it.
      pendingReviews: () => [...listPendingReviews(), ...runHumanWaits.list()],
      releaseClosedReview: async (taskId, reviewId, eventKind) => {
        // A review this process closed itself is finished by its own release, which prunes the
        // session before it drops the override: this event is that close read back.
        if (resolvedReviewIds.has(reviewId)) return;
        // `REREAD_CLOSURE` (a re-read of durable state, not an event) is not `review.approved`, so
        // it skips this re-gate check: the re-read has already decided the review is closed.
        // A re-gate records the round's approval and keeps the review pending under its id at
        // the next round, so a session that still holds the override has not lost the review. This
        // process lists the round the session holds (COR-1621), not the one it read before.
        if (eventKind === 'review.approved') {
          const sessionId = terminalReviewSessions.get(taskId)?.sessionId;
          const session =
            sessionId === undefined ? undefined : await runtime.sessionStore?.load(sessionId);
          const kept = persistedApprovalOf(session?.metadata, reviewId);
          if (kept !== undefined) {
            await adoptPersistedApprovalRound(taskId, reviewId, kept);
            return;
          }
        }
        // The peer that closed it pruned the session; only this process's copy is left.
        runHumanWaits.closedElsewhere(reviewId);
        if (scheduledFireApprovalRuns.has(taskId) && pendingApprovalOverrides.has(reviewId)) {
          await releaseScheduledFireApproval(taskId, reviewId, 'resolved', { durablyPruned: true });
        }
      },
      currentIncarnation: async (contextId) => {
        const session = await runtime.sessionStore?.load(contextId);
        return session?.incarnation;
      },
      abort: (taskId) => {
        try {
          return abortRun(taskId).status === 'aborting' ? 'requested' : 'already-terminal';
        } catch (error) {
          if (error instanceof BureauError && error.code === 'NOT_FOUND') return 'not-found';
          throw error;
        }
      },
      cancelDurable: (taskId) => cancelDurableRun(taskId),
      // COR-1868: a child run's task is stopped by the topology that owns the child.
      cancelChild: async (child) => {
        const cancelled = await childTopology.children.cancel(child);
        if (cancelled.outcome === 'failed') throw new BureauError(cancelled.reason, 'CONFLICT');
        return cancelled.outcome;
      },
      sleep: (milliseconds) =>
        new Promise<void>((resolve) => {
          runtimeServices.timers.setTimeout(resolve, milliseconds);
        }),
    },
  });
  taskRegistryHolder.current = tasks;
  // COR-1941 — the owner's notifications. The built-in kinds are written from the events this
  // emitter dispatches, after the task record they read is committed; the writes are drained at
  // shutdown, before the storage closes.
  const notificationsComposition = createNotifications({
    kv: runtime.kv,
    clock: runtimeServices.clock,
    identifiers: runtimeServices.identifiers,
    diagnose,
    refusal: (message) => new BureauError(message, 'BAD_REQUEST'),
    source: emitter,
    tasks,
    onCreated: (notification) => {
      emitter.dispatch(new NotificationCreatedEvent(notification.id, notification.kind));
    },
  });

  /**
   * COR-1481 — the catalog-run settlement hook (`catalog-run-settlement.ts`): every `bureau.run()`
   * run publishes here when it ends, dispatched by this process or recovered after a restart. The
   * task registry settles a catalog task from it, so a run that crossed a restart is settled like
   * any other.
   */
  const catalogRunSettlements = createCatalogRunSettlementHook(diagnose);
  /**
   * The settlements being published: a fresh dispatch following its handle, and a recovered run
   * being monitored. Each starts the writes that settle a task and a snapshot reference only
   * after its run's result is known, which for a run ended by disposing the engine is after
   * `shutdown()` has moved on. `shutdown()` waits for them before it closes storage: a bounded
   * number of event-loop turns for a run to end, and then, for a run whose end is known, until
   * the storage work that records it has finished. It then closes the tracker, so a run whose end
   * is known later records nothing; the next process settles it from the durable state at boot.
   */
  const catalogSettlements = createCatalogSettlementTracker();
  /**
   * Where a catalog run stands in the durable engine, read when its handle rejects: disposing the
   * engine rejects the handle of a run that is still running, and that is not an end. A read that
   * fails rejects, and the caller treats it as a run that is not over.
   */
  const catalogDurableEnd: DurableEndReader = async (runId) => {
    const state = await runtime.durable?.engine.get(runId);
    if (state === null || state === undefined) return 'not-durable';
    const ends: Partial<Record<typeof state.status, DurableEnd>> = {
      completed: 'completed',
      failed: 'failed',
      'timed-out': 'failed',
      cancelled: 'canceled',
    };
    return ends[state.status] ?? 'in-flight';
  };
  /**
   * COR-1630 — lets go of the `run-row` claims a catalog run holds on managed assets when the run
   * ends (`catalog-run-asset-release.ts`). A fresh dispatch is released by the catalog dispatcher
   * (`onCatalogRunEnded`), a recovered run by the settlement hook below, and a goal attempt by the
   * goal forwarder, after the goal's session holds its rows.
   */
  const catalogAssetReleases = createCatalogAssetReleaseDrain();
  /** Follows a release so `shutdown()` can wait for the ones under way before the asset service closes. */
  const trackCatalogAssetRelease = (pending: Promise<void>): Promise<void> =>
    catalogAssetReleases.track(pending);
  const catalogRunAssets = createCatalogRunAssetReleaser({
    assets: () => assetServiceHolder.current,
    durableEnd: catalogDurableEnd,
    readEnded: async (runId) => {
      const durable = runtime.durable;
      if (durable === undefined) return { status: 'missing' };
      const reading = await readDurableRunResult(durable, runId, { runtime: runtimeServices });
      if (reading.status === 'completed' || reading.status === 'ended') {
        return { status: 'ended', conversation: reading.result.conversation };
      }
      return { status: reading.status === 'missing' ? 'missing' : 'running' };
    },
    isClosed: () => catalogAssetReleases.isClosed(),
    diagnose,
  });
  catalogRunSettlements.subscribe(
    createRecoveredRunReleaseListener({
      releaser: {
        releaseAfterRecovery: (run) =>
          trackCatalogAssetRelease(catalogRunAssets.releaseAfterRecovery(run)),
      },
      loadRecoveryRecord: (runId) => runtime.loadCatalogRunRecoveryRecord(runId),
      goalIsOver: (goalRunId) => goalsComposition.goalIsOver(goalRunId),
      ownerOf: ownerOrLocal,
      diagnose,
    }),
  );
  /**
   * Whether a run whose claim stores no `taskOrigin` is a child run rather than a task: the child
   * topology holds it, or, failing that, its identifier is not a catalog run's. Only a run claimed
   * before COR-1868 is classified this way; a later child, attempt or step is a task by its claim.
   */
  const isChildRun = async (runId: string): Promise<boolean> =>
    (await childTopologyStore.get(runId)) !== undefined || !runId.startsWith('agent-run-');
  // COR-1524 — a recovered run's snapshot reference is settled when the run ends, through the same
  // hook as its task. A fresh dispatch settles its own reference where it is dispatched. This
  // subscriber filters on `recovered` and settles a child run's or a goal attempt's reference as
  // well, since those hold a snapshot too; the task settler below is the one that skips them.
  catalogRunSettlements.subscribe(async (settlement) => {
    if (settlement.recovered && fileAgents !== undefined) {
      await fileAgents.settleRun(settlement.runId);
    }
  });
  /** When the durable run was created (ISO 8601), or `undefined` when the engine has no record of it. */
  const durableRunCreatedAt = async (runId: string): Promise<string | undefined> => {
    const state = await runtime.durable?.engine.get(runId);
    return state === null || state === undefined
      ? undefined
      : new Date(state.createdAt).toISOString();
  };
  catalogRunSettlements.subscribe(
    createCatalogTaskSettler({
      tasks,
      loadRecoveryRecord: (runId) => runtime.loadCatalogRunRecoveryRecord(runId),
      durableCreatedAt: durableRunCreatedAt,
      isChildRun,
      now: runtimeServices.clock.nowISO,
      ownerOf: ownerOrLocal,
      originatingMessage: originatingMessageText,
    }),
  );

  /**
   * COR-1622 — each fire's seed read of its review history, kept as a promise so a close writer
   * can wait for a read that is still under way, and dropped with the fire.
   */
  const fireReviewSeeds = createFireReviewSeeds({
    read: async (runId) => {
      const history = await readFireReviewHistory(runId);
      const announced = announcedReviewRequests.get(runId) ?? new Set<string>();
      announcedReviewRequests.set(runId, announced);
      for (const id of history.requested) announced.add(id);
    },
    diagnose,
  });

  /**
   * COR-1621 — the one subscription this process keeps on the durable history of the fires it
   * holds a review of, built once the event history exists. `undefined` for a Bureau with no
   * persistent durable history, which has no peer to follow.
   */
  let fireReviewFollower: FireReviewFollower | undefined;

  const storeSubscription = store.toObservable().subscribe((event) => {
    switch (event.type) {
      case 'action': {
        const storeActionEvent = event as StoreActionEvent;
        // COR-1614: the end of a run another process ended reaches this process's streams and
        // nothing else; every other consumer below records or publishes it.
        if (isCommittedElsewhere(storeActionEvent.action)) {
          // COR-1302: a `bureau.run()` run's actions never reach live frames (see below).
          if (!catalogRunIds.has(storeActionEvent.action.runId)) {
            emitActionFrame(storeActionEvent.action);
          }
          break;
        }
        recordTaskSettlement(storeActionEvent.action);
        recordTaskWakeup(storeActionEvent.action);
        // COR-1302: a `bureau.run()` run is on `store` only so `getRun` and
        // `abortRun` resolve its id. Its actions stay off this bureau's
        // `'action'` stream and live frames, as they were before it was
        // registered, so every consumer of that stream (online evals, the
        // webhook notifier, the audit trail, durable event history) sees
        // exactly the runs it saw before.
        // COR-1524: a file agent's snapshot is held until its run settles, whichever kind of run.
        if (fileAgents !== undefined && isSettlingRunAction(storeActionEvent.action.type)) {
          detachBestEffortPromise(fileAgents.settleRun(storeActionEvent.action.runId));
        }
        if (catalogRunIds.has(storeActionEvent.action.runId)) break;
        emitter.dispatch(new ActionEvent(storeActionEvent.action));
        announceReviewRequests(storeActionEvent.action);
        emitActionFrame(storeActionEvent.action);
        break;
      }
      case 'run.registered': {
        const registeredRunId = (event as StoreRunRegisteredEvent).runId;
        // COR-1302: see the `'action'` case above.
        if (catalogRunIds.has(registeredRunId)) break;
        emitter.dispatch(new RunRegisteredEvent(registeredRunId));
        break;
      }
      case 'run.removed': {
        const removedRunId = (event as StoreRunRemovedEvent).runId;
        // COR-1302: a `bureau.run()` run's release is not a deletion, so it
        // is not announced as one. Durable event history records
        // `run.removed` as the evidence that a run's record was deleted,
        // which would otherwise hide the history of a catalog run that only
        // settled.
        const removedCatalogRun = catalogRunIds.has(removedRunId);
        const removedRun = store.getRun(removedRunId);
        const removedSessionId = removedRun ? getRunSessionIdentifier(removedRun) : '';
        runSequenceCounters.delete(removedRunId);
        // Reaped with the rest of this run's per-run state: the feed holds a
        // bounded log per run, so a long-lived gateway that never released
        // them would leak one per run forever. Disposal aborts the feed's
        // lifetime signal, so a client still reading it ends cleanly rather
        // than parking on a generator that can never yield again.
        disposeRunEventFeed(removedRunId, runEventFeeds);
        catalogRunIds.delete(removedRunId);
        runRequestContexts.delete(removedRunId);
        recoveredRunIds.delete(removedRunId);
        runToolboxesByRunId.delete(removedRunId);
        releaseRunScope(removedRunId);
        terminalReviewSessions.delete(removedRunId);
        announcedReviewRequests.delete(removedRunId);
        fireReviewSeeds.release(removedRunId);
        for (const [reviewId, cleanup] of reviewResolutionCleanupPending) {
          if (cleanup.runId === removedRunId) reviewResolutionCleanupPending.delete(reviewId);
        }
        for (const id of pendingApprovalOverrides.keys()) {
          if (id.startsWith(`approval:${removedRunId}:`)) dropPendingApprovalOverride(id);
        }
        for (const id of invalidApprovalReviewIds) {
          if (id.startsWith(`approval:${removedRunId}:`)) invalidApprovalReviewIds.delete(id);
        }
        if (removedSessionId) {
          detachBestEffortPromise(
            prunePersistedPendingApprovalOverrides(removedSessionId, `approval:${removedRunId}:`),
          );
          detachBestEffortPromise(
            prunePersistedResolvedReviewIds(removedSessionId, `approval:${removedRunId}:`),
          );
          detachBestEffortPromise(
            prunePersistedResolvedReviewIds(removedSessionId, `human-wait:${removedRunId}:`),
          );
        }
        // COR-1524: deleting a task releases its hold on the agent snapshot it ran on. A
        // `bureau.run()` run's leaving the store is a release, not a deletion, so its hold ends
        // by the retention pass instead (`retainAgentSnapshots`).
        if (!removedCatalogRun && fileAgents !== undefined) {
          detachBestEffortPromise(fileAgents.releaseRun(removedRunId));
        }
        if (!removedCatalogRun) {
          emitter.dispatch(new RunRemovedEvent(removedRunId));
          // COR-1670: a catalog run that merely settled keeps its records; retention removes them.
          releasePeerCalls(removedRunId);
        }
        // Prune this run's entries from `resolvedReviewIds` — the review ids
        // it tracks (`approval:${runId}:...`, `human-wait:${runId}:...`) can
        // never be produced by `listPendingReviews()` again once the run
        // itself is gone from the store, so keeping them around forever
        // would be an unbounded per-run leak on a long-lived gateway with
        // frequent approvals/denials.
        for (const id of resolvedReviewIds) {
          if (
            id.startsWith(`approval:${removedRunId}:`) ||
            id.startsWith(`human-wait:${removedRunId}:`)
          ) {
            resolvedReviewIds.delete(id);
          }
        }
        break;
      }
    }
  });

  const sessionPersistence = createSessionPersistence({
    sessionStore: runtime.sessionStore,
    orphanedRunIds,
    store,
    retryDelayMilliseconds: sessionPersistenceRetryDelayMilliseconds,
    sleep: sessionPersistenceSleep,
    diagnose,
    serializeError: serializeUnknownError,
    runtime: runtimeServices,
  });
  const { loadConversation, saveSession, persistSessionUpdate } = sessionPersistence;

  /**
   * COR-1946 — settles the tasks of a process that is gone (see `process-lease.ts`). A lease that is
   * still current is left alone and looked at again when it would lapse, so a process restarted
   * inside its predecessor's lease still settles what the predecessor left. Never rejects.
   */
  const abandonedTaskSweeper = createAbandonedTaskSweeper({
    lease: processLease,
    kv: runtime.kv,
    timers: runtimeServices.timers,
    // A manual host has no timer of the Bureau's: its next `maintain()` looks again.
    rearm: options.maintenance !== 'manual',
    now: runtimeServices.clock.now,
    nowISO: runtimeServices.clock.nowISO,
    unsettled: () => tasks.unsettled(),
    hasLiveRun: (taskId) => store.getRun(taskId) !== undefined,
    isDurablyRecorded: async (taskId) =>
      runtime.durable !== undefined && (await runtime.durable.engine.get(taskId)) !== null,
    settleAbandoned: (taskId, ownerProcess, lease, settlement) =>
      tasks.settleAbandoned(taskId, ownerProcess, lease, settlement),
    diagnose: (message, cause) =>
      diagnose({ level: 'error', scope: 'recovery', message: `[bureau] ${message}`, cause }),
  });

  // AB-389 — the session commit outbox drain. `SessionStore.save()`/
  // `update()`/`delete()` no longer dispatch `SessionCreatedEvent`/
  // `SessionSavedEvent`/`SessionDeletedEvent` directly; each commit instead
  // appends a `SessionOutboxEntry` to its own atomic batch, and this is the
  // ONE place those entries are replayed as the real events — in ordinal
  // order, coupled to their own durable write settling before the entry is
  // acknowledged and removed. Three drivers all call this same function
  // (never a separate implementation each): the best-effort
  // `SessionOutboxAppendedEvent` trigger above (promptness only), the
  // durable maintenance pass below (`maintain`, on the
  // runtime clock), and boot recovery (`recoverDurableRuns`, so a crash
  // between a commit and its own drain is caught up before this bureau
  // serves reads).
  //
  // Single-flighted per bureau instance: a caller that invokes this while
  // a drain is already running gets the SAME promise, so the post-commit
  // trigger and an overlapping maintenance tick can never both drain the
  // same pending entry from within this one process (the coordinator
  // ruling's "no event is recorded twice when the drain loop and the
  // post-commit drain overlap"). The cross-process/reboot exactly-once
  // case — a crash between a durable write settling and its outbox entry
  // being acknowledged, replayed again after restart — is enforced one
  // layer down: `durable-event-history.ts`'s `record()` dedupes a redelivery
  // by the entry's own `ordinal`, so acknowledging a replayed entry a
  // second time is safe even though the durable write itself is skipped as
  // an already-recorded duplicate.
  //
  // AB-390 — closes the residual AB-389 left open: `pending()` alone still
  // claims nothing (see its own doc comment), but every entry this drain
  // replays is now claimed first via `outbox.claim()`, a compare-and-swap
  // on the entry's own `claim` field keyed by THIS bureau instance's own
  // `outboxDrainOwner` id and `runtimeServices.clock.now()`. Two
  // bureau processes whose maintenance ticks (or simultaneous boot
  // recoveries) both observe the same still-unacknowledged entry can no
  // longer both dispatch it: only the one whose `claim()` call wins the CAS
  // proceeds, and `acknowledge()` itself re-verifies that claim is still
  // held before removing the entry. A drainer that crashes between winning
  // a claim and acknowledging leaves the entry claimed but undelivered
  // until its own `claim.until` lease lapses — `drainOutboxPass`
  // stops at the first entry it fails to claim (never skips ahead to a
  // later ordinal) so a live peer's in-order replay is never reordered by a
  // stalled one, and a later drain (this same process's own next tick, or a
  // peer's) reclaims and completes it once `until` passes.
  //
  // `outboxDrainOwner` is minted once per bureau instance (not per
  // drain pass) so a renewed claim from a LATER pass in this same process
  // is recognized as "the owner I already am", never treated as a foreign
  // claim — see `SessionStore.outbox.claim()`'s own doc comment on why
  // same-owner renewal must always succeed.
  //
  // Codex P1 review finding, PR #599, "Use an owner identifier unique
  // across runtime instances": `runtimeServices.identifiers.next()` alone
  // is NOT a cross-instance uniqueness guarantee — `RuntimeServices`'
  // own contract lets two independently constructed manual/deterministic
  // runtimes with the same `identifierSeed` intentionally mint identical
  // sequences (exact reproduction is the whole point of that seam). Two
  // bureau processes built that way would then mint the SAME drain-owner
  // id, and `outbox.claim()` treats a matching owner as same-owner
  // renewal — exactly the cross-owner exclusivity this lease exists to
  // enforce, silently defeated. `crypto.randomUUID()` appended here
  // mirrors what `createDefaultRuntimeServices()` itself does internally
  // for the identical reason (`lifecycle/src/runtime-services.ts`) — real
  // randomness is the right tool for a value that must be globally unique
  // regardless of injected determinism, never serialized into any
  // reproduction artifact, run report, or other reproducible-output
  // surface this codebase's determinism guarantees actually cover.
  const outboxDrainOwner = `${runtimeServices.identifiers.next('session-outbox-drainer')}:${generateSessionOutboxDrainOwnerSuffix()}`;
  // Codex P1 review finding, PR #599, "Schedule a retry when a live claim
  // blocks recovery": when this drainer loses a `claim()` to a peer whose
  // lease has not yet expired, the ONLY built-in retry today is whichever
  // of the three drivers happens to fire again later (another commit's
  // trigger, the automatic maintenance timer, or a future boot). A
  // KV-only or manual-maintenance bureau can go arbitrarily long with
  // none of those, leaving the entry undelivered long after the blocking
  // claim itself expired. This single-slot timer (never more than one
  // outstanding — a later-firing retry is redundant once an earlier one
  // is armed, and an earlier-observed lease always REPLACES a
  // later-armed one) wakes this bureau's own drain right at the known
  // holder's `claim.until`, without waiting on an unrelated trigger.
  // `RuntimeTimeoutHandle` is `unknown` (lifecycle's own opaque-handle
  // type, see `automaticRunOwnershipPruneTimer` below for the same note),
  // so it cannot be distinguished from `undefined` by type alone —
  // `outboxRetryTimerArmedForMs`'s own `undefined`/set state is the
  // single source of truth for whether this handle holds a live timer.
  let outboxRetryTimerHandle: RuntimeTimeoutHandle;
  let outboxRetryTimerArmedForMs: number | undefined;
  let outboxDrainInFlight: Promise<void> | undefined;

  // AB-388 (Codex review, PR #597, "Fence maintenance admission once
  // shutdown starts"): closed SYNCHRONOUSLY (no `await` in between) as the
  // very first step of the "stop background work" section of `shutdown()`
  // below, strictly BEFORE that section takes its `manualDurableMaintenancePasses`
  // snapshot. Without this, a `maintain()` call arriving after
  // the snapshot but before `backgroundShutdownController.abort()` (e.g.
  // during the automatic pass's own await, which yields control) could add
  // itself to the set too late to be captured by that snapshot, and still
  // be listing/deleting/writing a summary when backend teardown proceeds.
  // Checked (and set) with no `await` between the check and the
  // registration below, so no admitted call can slip in between the flag
  // flipping and the snapshot being taken — ordinary JS single-threaded
  // synchronous-until-the-first-`await` semantics, not a real lock.
  let maintenanceAdmissionClosed = false;

  // COR-1629 — the authority the maintenance pass sweeps governed memory's retention under, built
  // once and only for a Bureau that has memory, so a Bureau without it calls nothing.
  const maintenanceMemoryAuthority = createMaintenanceMemoryAuthority(runtime.memory, bureauId);

  // `RuntimeTimeoutHandle` is `unknown` (lifecycle's own opaque-handle
  // type), so it cannot be distinguished from `undefined` by type alone —
  // a separate boolean tracks whether the timer was actually started.
  let automaticRunOwnershipPruneTimer: RuntimeTimeoutHandle;
  let automaticRunOwnershipPruneTimerStarted = false;
  // Holds the CURRENTLY in-flight pass's own promise, or `undefined`
  // between ticks. Serves two purposes:
  //
  // 1. Guards against overlapping passes (Copilot review, PR #579,
  //    "Prevent overlapping automatic pruning passes"): if a pass ever
  //    takes longer than the interval — many sessions, slow storage, a
  //    conflict-retry storm — the next tick must skip rather than start a
  //    SECOND concurrent `pruneStaleRunOwnership()` call piling on extra
  //    I/O and `sessionStore.update()` contention against the first.
  // 2. Lets `shutdown()` AWAIT a pass that is still running when shutdown
  //    is admitted (Codex review, PR #579, "Await running pruning passes
  //    before backend teardown") — `clearInterval` alone only stops
  //    FUTURE ticks; without this, shutdown could dispose
  //    `eventHistoryInstance` and the raw storage while this promise is
  //    still replaying the feed or mid-`sessionStore.update()`.
  //
  // Deliberately NOT run through `runtimeServices.deferred.track()`
  // (an earlier revision did): that seam's `tracked` map is only ever
  // drained by an explicit `deferred.drain()` call, which nothing in
  // production ever makes — every 5-minute tick would have permanently
  // grown that map for the life of the process (Codex review, PR #579,
  // "Bound deferred tracking for recurring passes"). This local variable
  // gives a `createManualRuntimeServices()` test everything `drain()`
  // would have (something to await after `runtime.advance()`) without
  // that unbounded growth.
  let automaticRunOwnershipPruneCurrentPass: Promise<void> | undefined;
  // AB-388 (Codex review, PR #597, "Run audit retention for KV-backed
  // non-durable bureaus"): widened from `runtime.durable` alone — a
  // storage backend with `durable: false` gives `runtime.kv` a value (and therefore later
  // builds `auditTrailInstance`, further down this factory function)
  // without ever giving `runtime.durable` a durable engine. Checking
  // `runtime.kv` here rather than `auditTrailInstance` itself: that `let`
  // binding is declared much further down this function and would throw
  // "Cannot access before initialization" if read this early — `runtime.kv`
  // is the exact precondition `auditTrailInstance`'s own construction
  // gates on, so it is an equivalent, TDZ-safe proxy for "the audit trail
  // will exist". `pruneStaleRunOwnership()` still self-guards on
  // `eventHistoryInstance` (which DOES require `runtime.durable`) and
  // no-ops harmlessly for a KV-only bureau — only `pruneAuditTrail()`
  // actually does anything in that configuration.
  //
  // AB-388 (Codex review, PR #597, "Start the KV-only timer only for
  // active retention"): a KV-only bureau (`runtime.kv` truthy, `runtime.durable`
  // falsy) with no configured `options.retention?.audit` (the default,
  // `'forever'`) has NOTHING for this timer to do — `pruneStaleRunOwnership()`
  // always no-ops without `eventHistoryInstance` (which requires
  // `runtime.durable`), and `pruneAuditTrail()` returns immediately for a
  // `'forever'`/omitted policy. Starting a real interval anyway meant
  // recurring useless work AND kept the process alive (the interval handle
  // itself) until an operator explicitly called `shutdown()`. A durable
  // bureau (`runtime.durable` truthy) still always starts the timer
  // regardless of `retention.audit`, since `pruneStaleRunOwnership()` has
  // real work to do there independent of audit retention.
  // COR-1710 — the timer starts at boot when the settings in force need it, and later when a
  // settings change makes them need it (an audit retention window set on a key-value-only Bureau).
  if (automaticMaintenanceRuns()) startAutomaticMaintenance();
  settingsOf().settings.subscribe(() => {
    if (!automaticRunOwnershipPruneTimerStarted && !maintenanceAdmissionClosed) {
      if (automaticMaintenanceRuns()) startAutomaticMaintenance();
    }
  });

  /**
   * COR-1934 — the content a deleted chat leaves outside the session store: its event history, its
   * dedupe and surface markers, its runs' workflows, and the answer text in its audit entries. See
   * `chat-content-purge.ts` for what goes, the order, and how a failed purge is finished.
   */
  const chatContentPurge = createChatContentPurge({
    kv: runtime.kv,
    history: () => eventHistoryInstance,
    producer: () => durableEventProducerInstance,
    audit: () => auditTrailInstance,
    runEnded: async (runId) => {
      const durable = runtime.durable;
      if (durable === undefined) return true;
      const state = await durable.engine.get(runId);
      return state === null || isTerminalDurableStatus(state.status);
    },
    purgeRun: purgeDurableRun,
    purgeReviews: async (runIds) => {
      if (runtime.kv === undefined) return;
      await purgeReviewRecords({ kv: runtime.kv, audit: () => auditTrailInstance }, runIds);
    },
    // Read when it runs: the surface store is built after this purge.
    descendantsOf: descendantRunIdsOf,
    purgeRunRecords: async (runId) => {
      const recovery = await runtime.loadCatalogRunRecoveryRecord(runId);
      // A goal attempt's or a workflow step's record is its owner's claim, not a chat's words.
      const claimed =
        recovery.status === 'found' &&
        (recovery.record.goalAttempt !== undefined || recovery.record.workflowStep !== undefined);
      if (recovery.status !== 'missing' && recovery.status !== 'read-error' && !claimed) {
        await runtime.deleteCatalogRunRecoveryRecord(runId);
      }
      await childTopologyStore.remove(runId);
      await childTopologyStore.deletePeerCalls(runId);
    },
    purgeSurfaces: async (runId) => {
      await surfaces?.removeTask(runId);
    },
    taskIdsOf: (sessionId, incarnation) => tasks.taskIdsOfContext(sessionId, incarnation),
    purgeLedgers: async (runIds) => {
      if (runtime.kv !== undefined) await purgeChatLedgerEntries(runtime.kv, runIds);
    },
    redactTaskRecords: async (runIds) => {
      for (const runId of runIds) await tasks.redactSettlement(runId);
    },
    purgeNotifications: async (runIds) => {
      await notificationsComposition.purgeRuns(runIds);
    },
    // Read when it runs: the hooks are built after the Bureau they listen to.
    purgeHookDeliveries: async (chat, runIds) => {
      await hooksInstance?.purgeChatDeliveries(chat, runIds);
    },
    purgeAssets: async (assets) => {
      const service = assetServiceHolder.current;
      if (service !== undefined) await purgeChatAssets(service, assets);
    },
    purgeMemories: async (sessionId, runIds, placements) => {
      if (runtime.memory === undefined) return;
      await purgeChatMemories(
        {
          memory: runtime.memory,
          tenantId: bureauId,
          // The task record outlives the chat, and names the agent and owner a run's memory was
          // written under.
          placementOf: async (runId) => {
            const record = await tasks.record(runId);
            return record === undefined || record.agentName === null
              ? undefined
              : { agentName: record.agentName, owner: record.owner };
          },
        },
        { sessionId, runIds, placements },
      );
    },
    purgeSessionInput: async (sessionId, incarnation) => {
      if (runtime.durable === undefined) return;
      const mailbox = tryGetSessionInputMailbox(sessionId, incarnation);
      if (mailbox !== undefined) {
        await mailbox.purge();
        // The mailbox is gone: a handle kept for it would only hold its registry.
        sessionInputMailboxes.delete(`${sessionId}\u0000${incarnation}`);
        mailbox.dispose();
      }
      await sessionInputSettlement?.forget(sessionId, incarnation);
    },
    hasUndrainedEvents: async (sessionId, incarnation) => {
      const pending = await runtime.sessionStore?.outbox.pending();
      return (
        pending?.some(
          (entry) =>
            entry.sessionId === sessionId &&
            entry.incarnation === incarnation &&
            entry.kind !== 'session.deleted',
        ) ?? false
      );
    },
    currentIncarnation: async (sessionId) => {
      const session = await runtime.sessionStore?.load(sessionId);
      return session?.incarnation;
    },
    now: () => runtimeServices.clock.now(),
    diagnose,
  });

  /**
   * COR-1664 — releases, from the asset side, the claims of a run that ended or a session that was
   * deleted when the paths that normally release them never ran (`asset-claim-reconciliation.ts`).
   */
  const assetClaimReconciler = createAssetClaimReconciler({
    assets: () => assetServiceHolder.current,
    durableEnd: catalogDurableEnd,
    loadRecoveryRecord: (runId) => runtime.loadCatalogRunRecoveryRecord(runId),
    goalIsOver: (goalRunId) => goalsComposition.goalIsOver(goalRunId),
    sessionIsLive: async (sessionId, incarnation) => {
      // Without a session store no session holds a claim; only a store that answers can say gone.
      const live = await runtime.sessionStore?.load(sessionId);
      return runtime.sessionStore === undefined || live?.incarnation === incarnation;
    },
    isClosed: () => catalogAssetReleases.isClosed(),
    onReleased: (claim) => claimedRowAssets.delete(`${claim.holderId}\u0000${claim.assetId}`),
    diagnose,
  });

  /**
   * COR-1560 — the fork command ledger: an exact retry of `forkSession`, even after a restart,
   * returns the original result and creates nothing more. It keeps its entries in this Bureau's
   * store, or in memory for an ephemeral one, under a key prefix of its own.
   */
  const forkLedger = createForkLedger(runtime.kv, runtimeServices);

  /**
   * COR-2296 — the regeneration command ledger: a duplicate of `regenerateSession`, even after a
   * restart, never asks the model twice. It keeps its entries beside the fork ledger's, under a key
   * prefix of its own.
   */
  const regenerateLedger = createRegenerateLedger(runtime.kv, runtimeServices);

  // Build the bureau object first so the audit trail (and webhook notifier)
  // can subscribe to its action events via addEventListener. The audit trail
  // is best-effort — a write failure must never crash a run (handled inside
  // createAuditTrail).
  let auditTrailInstance: AuditTrail | undefined;
  let webhookNotifierInstance: WebhookNotifier | undefined;
  let scorerSamplerInstance: ScorerSampler | undefined;
  // The durable event history store (AB-91's `ab91-01` slice, AB-310) —
  // built eagerly (unlike `auditTrailInstance`/`webhookNotifierInstance`
  // below, which need `bureau` itself to subscribe to action events) since
  // it needs only `runtime.durable.engine.storage` and `runtimeServices`,
  // both already available here. "A persistent storage backend is
  // configured" (this issue's own acceptance criterion) means more than
  // "`runtime.durable` exists" — a caller can force `durable:
  // true` over `{ type: 'memory' }` storage (several existing shutdown
  // tests do exactly this) and get a real durable engine over genuinely
  // EPHEMERAL storage, which would make restart-durability a lie the
  // moment this store's FleetEventFeed were built over it. Gating on the
  // backend's own declared `capabilities().persistence` (never `'ephemeral'`)
  // is the same test Weft's `assertDurableStorageForRecovery` and
  // `runtime-composition.ts`'s own `effectiveStorageIsPersistent` check
  // use.
  const persistentDurableStorage =
    runtime.durable && runtime.durable.engine.storage.capabilities().persistence !== 'ephemeral'
      ? runtime.durable.engine.storage
      : undefined;
  const eventHistoryInstance: DurableEventHistory | undefined = persistentDurableStorage
    ? createDurableEventHistory(persistentDurableStorage, runtimeServices, diagnose)
    : undefined;
  // COR-1631 — a surface lives in its task's durable history, so a Bureau without one has none.
  const surfaces = createBureauInteractiveSurfaces({
    storage: persistentDurableStorage,
    history: eventHistoryInstance,
    tasks,
    now: runtimeServices.clock.now,
    diagnose,
    // A review belongs to the run Bureau holds it for: this process's pending reviews, and a run's
    // human waits derived from durable state when another process holds the run.
    reviewIdsOf: async (taskId) => {
      const local = [...listPendingReviews(), ...runHumanWaits.list()].filter(
        (review) => review.runId === taskId,
      );
      const waits = await pendingHumanWaitsOfRun(taskId);
      return new Set([...local, ...waits].map((review) => review.id));
    },
  });
  // COR-1621: a review another process closes is read from the shared history by one subscription
  // per process, whether or not any client follows a task.
  fireReviewFollower =
    eventHistoryInstance === undefined
      ? undefined
      : createFireReviewFollower({
          history: eventHistoryInstance,
          closeReview: (runId, reviewId, eventKind) =>
            tasks.reviewClosedElsewhere(runId, reviewId, eventKind),
          reread: rereadFireReviews,
          now: runtimeServices.clock.now,
          timers: runtimeServices.timers,
          diagnose,
          attempts: SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS,
          // A wait of zero would make a failing store a busy loop, so the backoff has a floor.
          retryDelayMilliseconds: Math.max(1, sessionPersistenceRetryDelayMilliseconds),
          maximumRetryDelayMilliseconds: FIRE_REVIEW_RECONCILIATION_MAXIMUM_DELAY_MILLISECONDS,
        });
  // The durable event producer (AB-311's coordinator amendment) — sinks
  // `bureau`'s action stream into `eventHistoryInstance.record()`. Wired
  // below, alongside `auditTrailInstance`, once `bureau` itself exists to
  // subscribe to.
  let durableEventProducerInstance: DurableEventProducer | undefined;
  // COR-1669 — repairs a task's history after a failed append, at boot, and in maintenance.
  let taskResyncInstance: TaskResync | undefined;

  // COR-1579 — the durable decision record every review resolution claims before it acts.
  const reviewDecisions = createReviewDecisionRecords(runtime.kv);
  // COR-1828 — the record of each decided review, written beside the decision's audit entry.
  const resolvedReviewStore = createResolvedReviewStore(runtime.kv);

  // COR-1577 — the human-wait reviews of `bureau.run()` runs, which have no session. Held apart
  // from `listPendingReviews()` above so the session path (and what COR-1302 excluded) is as it
  // was; the wrappers on the Bureau object below add them to the public list and to resolution.
  const runHumanWaits = createRunHumanWaits({
    store,
    catalogRunIds,
    runAttribution,
    engine: () => runtime.durable?.engine,
    checkpointSteps: async (runId) =>
      (await runtime.durable?.checkpointStore.loadSteps(runId)) ?? [],
    now: runtimeServices.clock.now,
    recordDecision: async (
      review,
      decision,
      principal,
      reason,
      writeAudit,
      secretAnswers,
      answerDigest,
    ) => {
      // COR-1622: a close follows the request it closes in the history.
      await fireReviewSeeds.pending(review.runId);
      // COR-1579: only the caller whose decision record turned `recorded` writes the entry, so
      // two processes deciding one park alike leave one.
      if (writeAudit) {
        const audit = buildReviewDecisionAuditRecord(
          review,
          decision,
          principal,
          reason,
          secretAnswers,
          answerDigest,
          await ownerForRecord(review.runId),
        );
        await auditTrailInstance?.record(audit);
        await recordResolvedReviewBestEffort(audit);
      }
      if (decision === 'approve') {
        emitter.dispatch(new ReviewApprovedEvent(review.id, review.runId, principal, review.kind));
      } else if (decision === 'reject') {
        emitter.dispatch(new ReviewRejectedEvent(review.id, review.runId, principal, review.kind));
      } else {
        emitter.dispatch(new ReviewDeniedEvent(review.id, review.runId, principal, review.kind));
      }
      // COR-1596: a fire answered is no longer waiting, which whoever follows its task is told.
      await tasks.announceChanged(review.runId);
    },
    checkDelivery: (review, payload, decision) => refuseUnsealedSecrets(review, payload, decision),
    prepareDelivery: (review, payload, principal, decision) =>
      prepareHumanWaitDelivery(review, payload, principal, decision),
    decisions: reviewDecisions,
    released: (runId) => unfollowFireReviewsWhenNoneRemain(runId),
    classifyRun: (runId) => runtime.classifyCatalogRecoveredRun(runId),
    createError: (message, code) => new BureauError(message, code),
    durableNotConfigured: () =>
      new BureauError('Durable engine not configured', 'NOT_CONFIGURED', 'durable'),
    diagnose,
  });

  // COR-2009 — the reviews of workflow files: an instance waiting at an `await-signal` step its file
  // writes with `"review": true`. They list beside the run human waits, waiting on the workflow's
  // owner, and resolve through `runHumanWaits.resolve` by run id: the same decision-record fence,
  // delivery and audit entry as a `bureau.run()` run's park.
  const workflowReviewWaits = createWorkflowReviewWaits({
    engine: () => (workflowRuntime === undefined ? undefined : runtime.durable?.engine),
    revisionSteps: async (type, workflowVersion) =>
      workflowRuntime?.revisionSteps(type, workflowVersion),
    inFlightRunIds: async () => (await workflowRuntime?.inFlightRunIds()) ?? [],
    now: runtimeServices.clock.now,
    announce: (review) => {
      emitter.dispatch(
        new ReviewRequestedEvent(
          review.id,
          review.runId,
          workflowRuntime?.workflows.owner ?? ANONYMOUS_LOCAL_OWNER,
          'human-wait',
          { signalName: review.signalName },
        ),
      );
    },
    released: (runId) => runHumanWaits.forget(runId),
    track: (promise, label) => runtimeServices.deferred.track(promise, label),
    diagnose,
  });

  const { planChildRun, startChildRun, startGoalAttemptRun, startWorkflowStepRun } =
    createCatalogDispatcher({
      workspace,
      agentCatalog,
      runtime,
      runtimeServices,
      getShutdownPromise: () => shutdownPromise,
      catalogRuns,
      runAttribution,
      detachBestEffortPromise,
      createBureauError: (message, code) => new BureauError(message, code),
      validateAgentRunInput,
      registerCatalogRun,
      // COR-1630 — a run's asset claims are released when its handle settles, if the run ended.
      onCatalogRunEnded: ({ runId, principal, settled }) =>
        catalogSettlements.follow(
          trackCatalogAssetRelease(
            catalogRunAssets.releaseAfterHandle({
              runId,
              principalId: ownerOrLocal(principal),
              settled,
            }),
          ),
        ),
      trackSubordinateRun,
      fileAgents,
      // COR-1577 — `requestHumanInput` for a durable `bureau.run()` run.
      humanInput: runtime.durable !== undefined ? options.humanInput : false,
      decideToolFor: (owner, offered) =>
        lateDecisions.toolWiringFor(runtime.durable !== undefined, owner, offered),
      toolGrant: toolGrantNow,
      // COR-772 — a durable `bureau.run` parent aborted through its own handle
      // is a cancelled parent like any other. Once shutdown has begun, dispose
      // — not the policy — ends every live run, and boot recovery applies the
      // policy to whatever it left running from the cancelled parent's
      // durable state.
      onDurableRunAborted: (runId, reason) => {
        if (shutdownPromise) return;
        void childTopology.parentCancelled(runId, reason);
      },
      configureDurableRun: (_runId, services, principal) => {
        configureChildWaitServices(services, principal);
      },
    });

  // COR-772 — the durable parent-child topology, persisted in the same KV
  // store as the audit trail (or in memory for an ephemeral bureau, where
  // there is nothing to recover across a restart anyway).
  const childTopologyStore = createChildTopologyStore(
    runtime.kv ?? textValueStore(new MemoryStorage()),
    {
      onCorrupt: (key) =>
        diagnose({
          level: 'error',
          scope: 'child-topology',
          message: `[bureau] Ignoring an unreadable child-topology record at "${key}".`,
        }),
      onUnsupported: (key, error) =>
        diagnose({
          level: 'error',
          scope: 'child-topology',
          message: `[bureau] Skipping the child-topology record at "${key}", which this build cannot read: ${error.message}`,
          cause: error,
        }),
    },
  );

  const childTopology = createChildTopology({
    store: childTopologyStore,
    runtime: runtimeServices,
    diagnose,
    recordAudit: async ({ principal, ...entry }) => {
      await auditTrailInstance?.record({
        ...entry,
        ...(principal === undefined ? {} : { principal }),
      });
    },
    // COR-1806: a child shows on its parent run's stream as a child a tool dispatched does. A
    // parent this process does not hold has no action log here, and the record is dropped.
    announce: async (announcement) => {
      const action = childActionOf(announcement);
      if (action !== undefined) {
        store.recordAction(announcement.record.parentRunId, action.type, action.detail);
      }
      if (announcement.kind === 'settled') {
        void runtime.durable?.engine
          .signal(
            announcement.record.parentRunId,
            `durable-child:${announcement.record.parentRunId}:${announcement.record.childRunId}`,
            null,
          )
          .catch(() => undefined);
      }
    },
    resolveParent: resolveChildParent,
    isKnownRun,
    planChild: planChildRun,
    startChild: startChildRun,
    getEngine: () => runtime.durable?.engine,
    cancelDurable: cancelDurableRun,
    validateInput: validateAgentRunInput,
    createBadRequest: (message) => new BureauError(message, 'BAD_REQUEST'),
    signalContracts: options.children?.signals as
      Readonly<Record<string, ChildSignalContract>> | undefined,
    delegation: options.children?.delegation,
    defaultTimeToLiveMilliseconds: () =>
      currentSettings()['children.delegation.defaultTimeToLiveMilliseconds'],
  });
  childTopologyForWait = childTopology;

  // COR-1670 — the journal behind `createPeerCallTool({ durable })`.
  const peerCalls: PeerCallJournal = {
    async read(key) {
      const record = await childTopologyStore.getPeerCall(key.parentRunId, key.operationKey);
      return record === undefined
        ? undefined
        : {
            taskId: record.taskId,
            contextId: record.contextId,
            requestDigest: record.requestDigest,
          };
    },
    async write(key, entry) {
      if (
        [key.parentRunId, key.operationKey, entry.taskId, entry.requestDigest].some(
          (value) => typeof value !== 'string' || value === '',
        ) ||
        typeof entry.contextId !== 'string'
      ) {
        throw new BureauError(
          'A peer call record needs a run id, an operation key, a task id, a request digest, and a context id.',
          'BAD_REQUEST',
        );
      }
      // A parent this Bureau has never heard of is a caller's mistake, not a run to journal for.
      // A run deleted while its call was in flight is not caught here: its workflow record can
      // outlive it, so a record written after the deletion ran stays, unread, with its run id.
      if (!(await isKnownRun(key.parentRunId))) {
        throw new BureauError(
          `Run "${key.parentRunId}" is not a run this Bureau knows, so its peer call was not recorded.`,
          'NOT_FOUND',
        );
      }
      const recording = await childTopologyStore.recordPeerCall({
        ...key,
        ...entry,
        recordedAt: runtimeServices.clock.now(),
      });
      if (recording.status === 'exists' && recording.existing?.taskId !== entry.taskId) {
        // Another task already holds this operation: this call must not claim it.
        throw new BureauError(
          `The peer call "${key.operationKey}" of run "${key.parentRunId}" already records a different task.`,
          'CONFLICT',
        );
      }
    },
  };
  notifyPeerCallsReady(options, peerCalls);

  // COR-851 — durable goals: the control plane over the goal store, its
  // controller workflow's ports, and the attempt forwarder.
  const goalsComposition = composeBureauGoals({
    workspace,
    catalog: goalValidatorCatalog,
    kv: runtime.kv,
    sessionStore: runtime.sessionStore,
    resolveFreshAttemptSource: options.resolveFreshAttemptSource,
    runtimeServices,
    host: goalWorkflowHost,
    getDurable: () => runtime.durable,
    planAgent: planChildRun,
    startAttemptRun: startGoalAttemptRun,
    cancelRun: cancelDurableRun,
    readRunRecord: (runId) => runtime.loadCatalogRunRecoveryRecord(runId),
    fenceClaim: (runId, owner, tombstonedAt) =>
      runtime.fenceGoalAttemptRecoveryRecord(runId, owner, tombstonedAt),
    fenceHost: goalAttemptFenceHost,
    // COR-1630 — an attempt's run lets go of its asset claims once the goal's session holds them.
    claimSessionAssets,
    releaseAssets: catalogRunAssets,
    releasesClosed: () => catalogAssetReleases.isClosed(),
    // Not the memoized, audited step runs get: that records a run's cleanup
    // under a run id, and a goal's controller is not a run. An attempt's run is
    // one, but a goal prunes it at close, once its terminal checkpoint has been
    // read, and a memoized "not terminal yet" answer must not outlive that.
    // Pruning is idempotent, so asking again on every `close()` is safe.
    cleanupWorkflow: classifyTerminalCheckpointCleanup,
    isClosing: () => shutdownPromise !== undefined,
    diagnose,
    eventHistory: eventHistoryInstance,
    dispatchGoalEvent: (event) => emitter.dispatch(event),
  });

  // COR-1577: a `bureau.run()` run's park joins the session reviews in the public list, and
  // resolves through the engine by run id. Every other review resolves exactly as before.
  const reviews = createReviews({
    listResolved: async (filter) => {
      const held = await resolvedReviewStore.list();
      return held
        .filter(
          (resolved) =>
            filter?.resolvedAfter === undefined || resolved.decidedAt >= filter.resolvedAfter,
        )
        .toSorted((a, b) => b.decidedAt - a.decidedAt || (a.review.id < b.review.id ? -1 : 1));
    },
    listSessionReviews: listPendingReviews,
    listRunHumanWaits: () => [...runHumanWaits.list(), ...workflowReviewWaits.list()],
    get: getReview,
    pendingOf: pendingHumanWaitsOfRun,
    resolve: resolveAnyReview,
  });

  // COR-1704: the schedule operations stay private implementations that share the durable engine,
  // the emitter, and the transition outbox; `events` reads the `schedule` owner of the history the
  // Bureau already serves.
  const schedules = createSchedules({
    // Never the third, internal parameter: only a plugin's host API names a source.
    create: (definition, scheduleOptions) => createSchedule(definition, scheduleOptions),
    get: getSchedule,
    list: listSchedules,
    pause: pauseSchedule,
    resume: resumeSchedule,
    reassign: reassignSchedule,
    cancel: cancelSchedule,
    update: updateSchedule,
    skipNext: skipNextSchedule,
    unskip: unskipSchedule,
    runNow: runScheduleNow,
    missed: listScheduleMissed,
    agentName: getScheduleAgentName,
    inputPreview: getScheduleInputPreview,
    continuesChat: getScheduleContinuesChat,
    blocker: getScheduleBlocker,
    eventHistory: readEventHistory,
    subscribeEventHistory: subscribeToEventHistory,
  });

  // COR-1706: the context operations stay private implementations that share the session store,
  // the live runs, the steering gates, and the durable mailbox; `events` reads the `session` owner of
  // the history the Bureau already serves.
  const contexts = createContexts({
    list: listSessions,
    get: getSession,
    delete: deleteSession,
    rename: renameSession,
    signal: signalSession,
    input: submitSessionInput,
    retract: retractSessionInput,
    forgetGrants: forgetSessionGrants,
    inputsDeliveredBy: sessionInputsDeliveredBy,
    steer: submitSteeringCommand,
    steering: getSessionSteering,
    fork: forkSession,
    regenerate: regenerateSession,
    window: getContextWindow,
    eventHistory: readEventHistory,
    subscribeEventHistory: subscribeToEventHistory,
  });

  // COR-1707: `start` is a session run over the task input, returned as a handle; the reads and
  // the cancel are the registry's and the Bureau's own, and `events` reads the `run` owner.
  const bureauTasks = createTasks({
    start: startTask,
    detail: getRun,
    receipt: (query) =>
      locateRunCreationReceipt({
        principal: query.principal,
        runCreationRequestId: query.commandId,
        ...(query.agentName === undefined ? {} : { agentName: query.agentName }),
        ...(query.contextId === undefined ? {} : { sessionId: query.contextId }),
      }),
    workflow: getDurableRun,
    workflows: listDurableRuns,
    wait: waitForDurableRun,
    snapshot: subscribeRunSnapshot,
    registry: tasks,
    children: childTopology.children,
    eventHistory: readEventHistory,
    subscribeEventHistory: subscribeToEventHistory,
    steps: async (runId) => (await runtime.durable?.checkpointStore.loadSteps(runId)) ?? [],
    notFound: (message) => new BureauError(message, 'NOT_FOUND'),
    responder: {
      reviews,
      ledger: createTasksRespondLedger(runtime.kv, runtimeServices),
      refusal: (refusal) => new TaskRespondError(refusal),
      isRefusal: (error): error is BureauError => error instanceof BureauError,
      sealAnswer: async (review, answer) => {
        const sealed = await sealHumanWaitAnswer(review, answer);
        return sealed.sealed;
      },
    },
  }) as Bureau<D>['tasks'];

  const audit = createAudit({
    trail: () => auditTrailInstance,
    ownerOf: ({ runId, detail }) => ownerOf({ kind: 'audit', runId, detail }),
    refusal: (message, code) => new BureauError(message, code),
  });

  const bureau: Bureau<D> = {
    workspaceBinding: workspace,
    id: bureauId,
    plugins: pluginRegistry.plugins,
    // COR-2009: what needs attention, read now from the parts this Bureau has.
    attention: () =>
      readAttention({
        // The Bureau's clock, which the engine stamps the missed occurrences it compares with by.
        now: runtimeServices.clock.now,
        activeAlerts: () => durableEngine()?.getActiveAlerts() ?? [],
        schedules: () => everySchedule(schedules),
        missed: (scheduleId) => schedules.missed(scheduleId),
        hooks: async () => (await hooksInstance?.hooks.list()) ?? [],
        plugins: () => pluginRegistry.plugins.list(),
        pluginsComposedAt: constructedAtMilliseconds,
        ...(options.attention === undefined ? {} : { contributed: options.attention }),
      }),
    reviews,
    schedules,
    contexts,
    tasks: bureauTasks,
    audit,
    notifications: notificationsComposition.notifications,
    internals: {
      hasExplicitId: options.id !== undefined,
      get taskRetention() {
        return taskRetentionOf(currentSettings());
      },
      hasDurableEngine: runCreationLedger !== undefined,
      eventFeed,
      runEventFeeds,
      store,
      sessionStore: runtime.sessionStore,
      pendingScheduledTaintCount: () => runtime.pendingScheduledTaintCount(),
      kv: runtime.kv,
      get auditTrail(): AuditTrail | undefined {
        return auditTrailInstance;
      },
      get webhookNotifier(): WebhookNotifier | undefined {
        return webhookNotifierInstance;
      },
      get scorerSampler(): ScorerSampler | undefined {
        return scorerSamplerInstance;
      },
      abortingTasks: listAbortingRuns,
      whenTaskRecorded: whenRunRecorded,
      taskRegistry: tasks,
      diagnostics: () => ({
        recovery:
          settledRecoveryReport === undefined
            ? { status: 'pending', failedRunCount: 0 }
            : {
                status: settledRecoveryReport.outcome,
                failedRunCount: settledRecoveryReport.perRunFailures.length,
              },
        lifecycle: bureau.lifecycle,
        liveFrameSubscriberCount,
        eventFeedSubscriberCount: eventFeed.subscriberCount(),
        watchers: [
          ...(fileAgents === undefined ? [] : [watcherHealthOf('agents', fileAgents.files)]),
          ...(workflowRuntime === undefined ? [] : [watcherHealthOf('workflows', workflowRuntime)]),
        ],
        modelCatalogRevision: models.catalog().revision,
        runningRunCount: activeRuns.size + catalogRuns.size,
        abortingRunCount: abortingRunIds.size,
        pendingReviewCount: reviews.list().length,
      }),
    },
    runtimeServices,
    memory: runtime.memory,
    surfaces,
    get lifecycle() {
      return bureau.completed ? 'stopped' : runAdmissionClosed ? 'draining' : 'ready';
    },
    agents: Object.freeze({ ...agentCatalog, try: tryAgent }),
    workflows: workflowRuntime?.workflows,
    get hooks() {
      return hooksInstance?.hooks;
    },
    formatEvent: eventFormatter,
    deployments:
      options.workerDeployments === undefined
        ? undefined
        : createBureauWorkerDeployments({
            catalog: options.workerDeployments,
            now: () => runtimeServices.clock.now(),
            audit: async (entry) => auditTrailInstance?.record(entry),
            diagnose: (message, cause) =>
              diagnose({
                level: 'error',
                scope: 'worker-deployments',
                message: `[bureau] ${message}`,
                cause,
              }),
          }),
    models,
    decisions: lateDecisions.decisions,
    // COR-1710: composed with the runtime, before this object exists.
    settings: settingsOf().settings,
    // The topology is keyed by plain runtime strings; `D` only narrows which
    // agent names a caller may pass.
    children: childTopology.children as BureauChildren<AgentNames<D>>,
    peerCalls,
    // COR-1707: a goal's history is the `goal` owner of the history the Bureau serves.
    goals: {
      ...goalsComposition.goals,
      events: (goalRunId, eventHistoryOptions) =>
        readEventHistory({ kind: 'goal', id: goalRunId }, eventHistoryOptions),
      subscribeEvents: (goalRunId, listener, subscribeOptions) =>
        subscribeToEventHistory({ kind: 'goal', id: goalRunId }, listener, subscribeOptions),
    } as BureauGoals<AgentNames<D>>,
    get assets(): AssetService | undefined {
      return assetServiceInstance;
    },
    ownerOf,
    durableEngine,
    maintain,
    removeExpiredRecords,
    setRequestAuthorityValidator(validator) {
      requestAuthorityValidator = createRunAuthorityValidator(workspace, validator);
      runtime.setRequestAuthorityValidator(validator);
      if (validator && durableRecoveryDeferred && !durableRecoveryStarted) {
        durableRecoveryDeferred = false;
        durableRecoveryStarted = true;
        const recovery = recoverDurableRuns().catch((error) => {
          diagnose({
            level: 'error',
            scope: 'recovery',
            message: `[bureau] Deferred durable run recovery failed: ${serializeUnknownError(error)}`,
          });
          // The sweep, and any handle `onRecoveredWorkflow` classified before
          // `recoverAll()` itself threw, may have already produced real
          // failures — fold both in rather than dropping them (see
          // `currentRecoverySweepFailure`'s own doc comment; code-review
          // regression fixture), then reset both this-pass collectors so
          // neither leaks into a later recovery pass.
          const sweepFailure = currentRecoverySweepFailure;
          const perRunFailures = dedupeRecoveryPerRunFailures(currentRecoveryPerRunFailures ?? []);
          const skippedRuns = currentRecoverySkippedRuns ?? [];
          currentRecoverySweepFailure = undefined;
          currentRecoveryPerRunFailures = undefined;
          currentRecoverySkippedRuns = undefined;
          return {
            outcome: 'failed',
            ...(sweepFailure ? { sweepFailure } : {}),
            batchFailure: { message: serializeUnknownError(error) },
            perRunFailures,
            skippedRuns,
          } satisfies BureauRecoveryReport;
        });
        void recovery.then((report) => {
          // Before the barrier resolves, so a reading taken once `recovery()` has answered
          // never sees the pass still pending.
          settledRecoveryReport = report;
          resolveDurableRecoveryBarrier?.(report);
          return report;
        });
        void recovery.then(() => trackCatalogAssetRelease(reconcileAssetClaims()));
      }
    },
    recovery() {
      return durableRecoveryBarrier;
    },
    frames(listener) {
      let active = true;
      liveFrameSubscriberCount += 1;
      const unsubscribe = () => {
        // Counted once however many times it is called.
        if (active) liveFrameSubscriberCount -= 1;
        active = false;
        liveFrameListeners.delete(listener);
      };
      // COR-1421 — the first subscriber closes the boot buffer and is replayed
      // what recovery produced before it attached. The replay runs in a
      // microtask, after this call has returned its unsubscribe handle, so a
      // listener may unsubscribe itself from inside the replay. The listener
      // joins the live set only once the replay queue drains, so a frame its
      // own callback causes is delivered after the remaining replay, in
      // emission order.
      const firstSubscriber = !liveFramesSubscribed && frameReplayQueue === undefined;
      liveFramesSubscribed = true;
      bootFrameRunIds.clear();
      const queue = firstSubscriber ? bootFrameBuffer.splice(0) : [];
      if (queue.length === 0) {
        liveFrameListeners.add(listener);
        return unsubscribe;
      }
      frameReplayQueue = queue;
      queueMicrotask(() => {
        try {
          while (queue.length > 0) {
            if (!active) break;
            deliverLiveFrame(listener, queue.shift()!);
          }
        } finally {
          frameReplayQueue = undefined;
          if (active) liveFrameListeners.add(listener);
        }
      });
      return unsubscribe;
    },
    addEventListener: (type, listener, listenerOptions) =>
      emitter.addEventListener(type, listener, listenerOptions),
    removeEventListener: (type, listener, listenerOptions) =>
      emitter.removeEventListener(type, listener, listenerOptions),
    on: (type, observableOptions) => emitter.on(type, observableOptions),
    once: (type, listener) => emitter.once(type, listener),
    subscribe: (type, observerOrNext, error, complete) =>
      emitter.subscribe(type, observerOrNext, error, complete),
    toObservable: () => emitter.toObservable(),
    events: (type, iteratorOptions) => emitter.events(type, iteratorOptions),
    complete: () => emitter.complete(),
    get completed() {
      return emitter.completed;
    },
    get signal() {
      return emitter.signal;
    },
    dispose,
    shutdown,
  } satisfies Bureau<D>;
  // From here a failed step shuts the whole Bureau down, which stops what the composition's
  // shutdown would and everything built since.
  construction.abandon = (error) => shutdownThenRethrow(error, () => bureau.shutdown());

  // Wire the durable audit trail (Layer B) now that we have a bureau to
  // subscribe to. Only created when a KV store is available; ephemeral
  // bureaus have Layer A only.
  //
  // The trail is subscribed BEFORE durable run recovery so that actions
  // emitted by recovered/reattached runs — including handles that are already
  // settled, or settle during the awaits inside recoverDurableRuns() — are
  // captured in the durable trail rather than landing only in the live store.
  if (runtime.kv) {
    // AB-370: seed the trail's shared sequence counter above anything a
    // prior process lifetime already persisted, BEFORE `createAuditTrail`
    // subscribes its listeners and starts admitting new writes — see
    // `computeInitialAuditSequence`'s own doc comment and
    // `AuditRecord.sequence`'s. This one `await` still lands before
    // `recoverDurableRuns()` further down, so the "subscribed BEFORE
    // durable run recovery" ordering above is unaffected.
    const auditTrailInitialSequence = await computeInitialAuditSequence(runtime.kv, diagnose);
    // AB-207: threaded with the bureau-owned background-shutdown signal so
    // `shutdown()` can bound this subsystem's drain the same way it bounds
    // online-evals and the webhook notifier below.
    auditTrailInstance = createAuditTrail(
      bureau,
      runtime.kv,
      diagnose,
      {
        signal: backgroundShutdownController.signal,
        initialSequence: auditTrailInitialSequence,
        eventTimestamp,
        sessionDeletionOwner: (sessionId, incarnation) =>
          sessionDeletionOwners.get(sessionDeletionOwnerKey(sessionId, incarnation))?.owner,
        sessionDeletionActor: (sessionId, incarnation) =>
          sessionDeletionOwners.get(sessionDeletionOwnerKey(sessionId, incarnation))?.actor,
        sessionDeletionSummary: (sessionId, incarnation) =>
          sessionDeletionOwners.get(sessionDeletionOwnerKey(sessionId, incarnation))?.summary,
      },
      runtimeServices,
    );
  }

  // Wire the durable event history producer (AB-311's coordinator
  // amendment) now that we have a bureau to subscribe to — same ordering
  // rationale as the audit trail above: subscribed BEFORE durable run
  // recovery so recovered/reattached runs' `run.*` transitions are sunk
  // into the durable store too. Only created when `eventHistoryInstance`
  // itself exists (a persistent storage backend is configured) — there is
  // nothing to sink into otherwise.
  if (eventHistoryInstance) {
    durableEventProducerInstance = createDurableEventProducer(
      bureau,
      eventHistoryInstance,
      runtimeServices,
      diagnose,
      {
        signal: backgroundShutdownController.signal,
        eventTimestamp,
        onAppendFailed: (owner) => void taskResyncInstance?.appendFailed(owner),
      },
    );
    taskResyncInstance = createTaskResync({
      contextIsLive: async (contextId, incarnation) => {
        const sessionStore = runtime.sessionStore;
        if (sessionStore === undefined) return true;
        const session = await sessionStore.load(contextId);
        return session?.incarnation === incarnation;
      },
      answerOf: (taskId) => {
        const content = bureau.tasks
          .detail(taskId)
          ?.stepDetails.findLast((step) => step.final)?.content;
        if (content === undefined || content === '') return undefined;
        return {
          text: content.slice(0, TASK_ARTIFACT_TEXT_LIMIT),
          truncated: content.length > TASK_ARTIFACT_TEXT_LIMIT,
        };
      },
      tasks,
      history: eventHistoryInstance,
      producer: durableEventProducerInstance,
      diagnose: (message, cause) =>
        diagnose({ level: 'error', scope: 'task-registry', message: `[bureau] ${message}`, cause }),
    });
  }

  // Wire the webhook notifier (AB-21) now that the audit trail exists (an
  // exhausted delivery is recorded there). Only created when at least one
  // target is configured — the common case (no `options.webhooks`) costs
  // nothing beyond the `undefined` check in `createWebhookNotifier`.
  rejectHooksWithoutStorage(options.hooks, runtime.kv);
  if (wantsWebhookNotifier(options)) {
    webhookNotifierInstance = createWebhookNotifier(
      bureau,
      runtime.kv,
      auditTrailInstance,
      // AB-207: merge any caller-supplied signal with the bureau-owned
      // background-shutdown signal so `shutdown()` can tell an in-flight
      // delivery's `fetchImpl` to abort — the mechanism `dispose()`'s prior
      // detached call gave up entirely, which is what let a delivery's
      // write race storage teardown (AB-206 review finding, PR #402).
      webhookNotifierOptionsOf(options, withBackgroundShutdownSignal(options.webhooks?.signal)),
      diagnose,
      runtimeServices,
    );
  }

  // COR-1939: user-defined hooks, on the notifier's delivery engine.
  hooksInstance = composeHooks({
    workspace,
    eventForHookOwner:
      workspace === undefined ? undefined : workspaceHookEvents(workspace, ownerOf),
    mayStartWorkflows:
      workspace === undefined
        ? undefined
        : (owner) => mayRunUseSharedConfiguration(workspace, owner, 'bureau.workflows:write', true),
    options: options.hooks,
    engine: webhookNotifierInstance?.engine,
    kv: runtime.kv,
    keys: answerEncryption,
    bureauId,
    runtimeServices,
    auditTrail: auditTrailInstance,
    diagnose,
    workflows: () => workflowRuntime?.workflows,
    notifications: () => notificationsComposition.notifications,
    // COR-1940: a run a hook started, or any run beneath it, raises events no `start-workflow`
    // hook acts on. The instance carries the hook's tag; a step, child or attempt reaches it
    // through the parent its task records.
    startedByHook,
    subjects: {
      run: subjectsOfRun,
      agentOfSchedule: (scheduleId) => schedules.agentName(scheduleId),
      agentOfGoal: async (goalRunId) => {
        const goal = await goalsComposition.goals.get(goalRunId);
        return goal?.objective.agentName;
      },
    },
  });

  // COR-718: an expiry is a deletion, so each expiring session's owner is recorded for
  // its deletion's audit entry the way `deleteSession` records it, before the store
  // removes anything; a session whose owner cannot be recorded is kept.
  sessionCleanupHandler.resolve(async (sessions) => {
    // Every owner first, and every task history erased: a record that cannot be written
    // keeps every session, with its runs untouched.
    await prepareSessionsForRemoval(sessions);
    // An expired session's rows are gone with it, so its asset claims end too, but only once the
    // store has removed it: the claims are released when its `session.deleted` entry drains.
    for (const session of sessions) {
      expiringSessions.set(`${session.id}\u0000${session.incarnation}`, session);
    }
    // Then the expiry is a deletion for the sessions' runs too: each still-running
    // run is orphan-marked and aborted (or released, if paused) exactly as
    // `performDeleteSession` does, so none of them writes into whatever session
    // the id names afterwards. Nothing here awaits a run's terminal event or
    // touches the session store: this hook runs inside the store's own mutation,
    // and a terminal save queued behind it would deadlock.
    for (const session of sessions) {
      const { steeringGate } = abandonSessionRuns(session.id);
      steeringGate?.settleForDeletion(runtimeServices.clock.nowISO());
      steeringGate?.purgeFromLedger();
      if (steeringGates.get(session.id) === steeringGate) steeringGates.delete(session.id);
      if (steeringCursors.get(session.id)?.incarnation === session.incarnation) {
        forgetSessionSteering(session.id);
      }
    }
  });

  // COR-718: a schedule fire's run is owned by its schedule's owner, and the scheduler is
  // only the actor on the `schedule.fired` entry. The fire's services are rebuilt on
  // recovery, so the entry is written through an atomic key and is written once.
  scheduledFireHandler.resolve(async (fire) => {
    attributeScheduledFire(runAttribution, firedRunIds, fire);
    // COR-1482: the fire is a task owned by the schedule's owner, started by the scheduler. It is
    // written once however many times the fire is rebuilt, and unbound to a session incarnation,
    // because a fresh session does not exist until the fire's first step saves it.
    try {
      await tasks.recordAdmission({
        taskId: fire.runId,
        contextId: fire.sessionId,
        incarnation: '',
        agentName: fire.agentName,
        owner: fire.owner,
        actor: SCHEDULER_ACTOR,
        kind: 'schedule-fire',
        // COR-1867: the fire is its run id. Without a schedule id (a branch the composition's own
        // preconditions rule out) the origin is not recorded, and reads `null`, not a guess.
        origin:
          fire.scheduleId === undefined
            ? undefined
            : {
                kind: 'schedule',
                scheduleId: fire.scheduleId,
                fireId: fire.runId,
                // COR-1829: a fire a person started with `schedules.runNow`, not the cadence.
                ...(fire.manual === true ? { manual: true as const } : {}),
              },
        message: fire.message,
        // COR-1710: the fire's grant, recorded once with it; a rebuilt fire reads it back.
        tools: toolGrantNow(),
      });
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'task-registry',
        message: `[bureau] Could not record the task of schedule fire "${fire.runId}":`,
        cause: error,
      });
    }
    // COR-2009: an agent schedule that came due is a schedule tick, the Bureau's own run. A fire a
    // person started with `schedules.runNow` did not come due, so it records none.
    const { scheduleId } = fire;
    if (scheduleId !== undefined && fire.manual !== true) {
      await recordScheduleTick(scheduleId, (scheduleName) => ({
        event: 'came-due',
        scheduleId,
        scheduleName,
        fireRunId: fire.runId,
      }));
    }
    const trail = auditTrailInstance;
    if (trail === undefined) return;
    try {
      await recordScheduleFired(trail, fire);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'audit-trail',
        message: `[bureau] Could not record schedule.fired for run "${fire.runId}":`,
        cause: error,
      });
    }
  });

  // COR-1482: how a fire's task ends, from the engine's own terminal event for its run, and which
  // session incarnation it ran in.
  scheduledFireSettledHandler.resolve(async (settlement) => {
    // COR-1613: a canceled fire's parked wait is closed in the audit trail and the history before
    // it is forgotten, because fire waits are not in the session list the revoke scans.
    if (settlement.status === 'canceled') {
      try {
        await closeCanceledFireHumanWaits(settlement.runId, 'system:run-abort');
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'task-registry',
          message: `[bureau] Could not record the canceled wait of schedule fire "${settlement.runId}": ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
    }
    // COR-1596: a settled fire has no wait left to answer, and announces nothing more.
    runHumanWaits.forget(settlement.runId);
    announcedReviewRequests.delete(settlement.runId);
    endContinuingScheduledFire(scheduledFireReviewState, settlement.runId);
    // COR-1596: a canceled fire ends every approval it holds, by whichever route it was canceled;
    // any other fire's checkpoint is complete now, so what its session holds is checked against
    // it, once, and nothing stale outlives the fire.
    try {
      await releaseScheduledFire(
        settlement.runId,
        settlement.status === 'canceled' ? 'canceled' : 'settled',
      );
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'task-registry',
        message: `[bureau] Could not reconcile the tool approvals of settled schedule fire "${settlement.runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
    // COR-1622: the fire's final reconciliation is done, so its seed read is dropped (after a read
    // still under way, which a close written by it may be waiting on); a later announcement of
    // the same run id reads its history afresh, and the map holds only the fires in flight.
    await fireReviewSeeds.pending(settlement.runId);
    fireReviewSeeds.release(settlement.runId);
    const status =
      settlement.status === 'completed'
        ? settledTaskState('completed', settlement.finishReason)
        : settlement.status;
    const content = status === 'completed' ? (settlement.content ?? '') : '';
    await tasks.recordSettled(settlement.runId, {
      at: runtimeServices.clock.nowISO(),
      status,
      finishReason: settlement.finishReason ?? null,
      message:
        status === 'failed'
          ? (settlement.error ?? settlement.finishReason ?? 'The task failed.').slice(
              0,
              TASK_STATUS_MESSAGE_LIMIT,
            )
          : null,
      ...(content === ''
        ? {}
        : {
            answer: {
              text: content.slice(0, TASK_ARTIFACT_TEXT_LIMIT),
              truncated: content.length > TASK_ARTIFACT_TEXT_LIMIT,
            },
          }),
    });
  });
  scheduledSessionKnownHandler.resolve(async (session) => {
    await tasks.bindIncarnation(session.runId, session.incarnation);
  });
  scheduledFireServicesHandler.resolve(registerScheduledFireReviews);

  // Wire the online eval sampler (AB-53) now that the audit trail and webhook
  // notifier exist (a sampled score is recorded to the former; a threshold
  // breach is delivered through the latter). Only created when at least one
  // judge is configured with a positive sample rate — the common case (no
  // `options.scorers`) costs nothing beyond the `undefined` check inside
  // `createScorerSampler`.
  if (options.scorers && options.scorers.list.length > 0 && options.scorers.sampleRate > 0) {
    scorerSamplerInstance = createScorerSampler(
      bureau,
      auditTrailInstance,
      webhookNotifierInstance,
      {
        ...options.scorers,
        // AB-207: same bounded-abort wiring as the webhook notifier above, for
        // an in-flight judge invocation.
        signal: withBackgroundShutdownSignal(options.scorers.signal),
      },
      runtimeServices,
    );
  }

  // A host that calls `createBureau()` without `requestAuthorityValidator` has
  // no validator until it calls `bureau.setRequestAuthorityValidator()`. Defer
  // recovery when a persisted session's in-flight run carries transport-issued
  // authority, so that run cannot execute unvalidated.
  let hasDeferredGatewayAuthority = false;
  if (runtime.durable && runtime.sessionStore) {
    try {
      const sessions: SessionSummary[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await runtime.sessionStore.list({ limit: 100, offset });
        sessions.push(...page);
        if (page.length < 100) break;
      }
      for (const session of sessions) {
        const runId = session.metadata['lastRunId'];
        const status = session.metadata['lastRunStatus'];
        const metadata = session.metadata;
        // AB-359 (chatgpt-codex-connector review, PR #564, P1) — rehydrate
        // `runAttribution` for EVERY run this session ever dispatched with a
        // principal, not only the one `reattachRecoveredRun` happens to
        // reattach. `recoverAll()` only surfaces still-in-flight workflows,
        // so a run that already reached a terminal state before the crash
        // never reaches `reattachRecoveredRun` at all — without this, its
        // real owner would read `not-found` from `eventHistory` after a
        // restart despite `lastRunOwningPrincipals` having the entry,
        // because `resolveEventHistory`'s AB-313 check consults only the
        // in-memory map. This loop already walks every persisted session
        // once at boot (the pending-approval/terminal-review restore
        // above), so this rides the same pass rather than adding a second
        // full session scan.
        const owners = metadata['lastRunOwningPrincipals'];
        if (isPlainAuthorityRecord(owners)) {
          for (const [ownedRunId, ownerPrincipal] of Object.entries(owners)) {
            if (typeof ownerPrincipal === 'string') {
              runAttribution.set(ownedRunId, {
                ...runAttribution.get(ownedRunId),
                principal: ownerPrincipal,
              });
            }
          }
        }
        const restoredRunIds = persistedApprovalRunIds(metadata);
        if (typeof runId === 'string' && status === 'running') restoredRunIds.delete(runId);
        for (const restoredRunId of restoredRunIds) {
          const before = pendingApprovalOverrides.size;
          // COR-1596: a fire's session holds approvals its run may not have committed, and for a
          // fire the engine canceled, approvals nothing may run.
          const restorable = await restorableBootApprovals(metadata, restoredRunId, session.id);
          if (restorable === 'none') continue;
          const committed = restorable === 'not-a-fire' ? undefined : restorable;
          restorePendingApprovalOverrides(metadata, restoredRunId, committed);
          if (pendingApprovalOverrides.size > before) {
            terminalReviewSessions.set(restoredRunId, {
              sessionId: session.id,
              agentName: session.agentName,
              requestedAt: Date.parse(session.updatedAt) || runtimeServices.clock.now(),
            });
            await restoreTerminalReviewSession(session, restoredRunId, committed);
          }
          await recoverPeerApproval(session.id, restoredRunId, metadata);
        }
        if (!requestAuthorityValidator && hasRecoverableTransportAuthority(session.metadata)) {
          hasDeferredGatewayAuthority = true;
        }
      }
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Could not inspect sessions before durable recovery${requestAuthorityValidator ? '; continuing with the configured authority validator' : '; deferring until authority validator attachment'}: ${serializeUnknownError(error)}`,
      });
      hasDeferredGatewayAuthority = !requestAuthorityValidator;
    }
  }
  // COR-1585 — the post-commit trigger is registered here, not where the composition is wired
  // above. `drainOutbox` reads state declared much further down, so a commit that landed while
  // construction was still awaiting (the agent file scan, the audit sequence seed) would reach
  // it uninitialised. Registered before the boot drain below, so a commit made during or after it
  // still triggers a drain, and the boot drain applies any entry appended before this point.
  // AB-389 — `SessionStore.events` (`@lostgradient/operative`) now carries
  // only the best-effort `SessionOutboxAppendedEvent` drain trigger, never
  // `SessionCreatedEvent`/`SessionSavedEvent`/`SessionDeletedEvent`
  // directly (that fire-and-forget dispatch is exactly the KNOWN
  // LIMITATION this issue closes — see `create-session-store.ts`'s own
  // doc comment). A missed or duplicate trigger costs nothing: `drainOutbox`
  // (declared above) is single-flighted and idempotent, and the durable
  // maintenance pass drains unconditionally on its own cadence regardless
  // of whether this trigger ever fires.
  //
  // Tracked via `runtimeServices.deferred.track()` — the same seam
  // `durable-event-history.ts`'s own per-write `trackWrite` already uses
  // for exactly this kind of per-event (not per-interval-tick) background
  // work — so a test using `createManualRuntimeServices()` can await
  // `runtime.deferred.drain()` for deterministic "has this commit's drain
  // settled yet" assertions, the same way it already can for an individual
  // durable-event-history write.
  if (runtime.sessionStore) {
    runtime.sessionStore.events.addEventListener(SessionOutboxAppendedEvent.type, () => {
      const drain = drainOutbox().catch((error: unknown) => {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Session outbox drain (post-commit trigger) failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      });
      runtimeServices.deferred.track(drain, 'session-outbox-drain');
      detachBestEffortPromise(drain);
    });
  }
  // AB-389 (Codex P1 review finding, PR #598, "Drain the outbox before
  // deferring authority recovery"): the crash-recovery outbox drain used
  // to live ONLY at the start of `recoverDurableRuns()` — when boot
  // defers durable run reattachment below (no request-authority validator
  // attached yet), that function is never called until
  // `setRequestAuthorityValidator()` runs, so pending outbox entries from
  // a previous process would sit undrained for however long attachment
  // takes, or forever if it never happens. Draining is authority-
  // independent (it only needs `runtime.sessionStore`/`eventHistoryInstance`,
  // neither gated on gateway authority) and idempotent/single-flighted, so
  // running it unconditionally here — BEFORE deciding whether to defer —
  // costs nothing extra on the non-deferred path (`recoverDurableRuns()`'s
  // own drain call below is then a no-op empty pass) and closes the gap
  // on the deferred one.
  try {
    await drainOutbox();
  } catch (error) {
    diagnose({
      level: 'error',
      scope: 'recovery',
      message: `[bureau] Session outbox drain failed during boot recovery; continuing: ${serializeUnknownError(error)}`,
      cause: error,
    });
  }
  // COR-194 — authority-independent like the session outbox, so it runs here, before recovery is
  // deferred or started: a run recovery reattaches starts at once, and nothing should stand between
  // its reattachment and `createBureau()` returning.
  await recordPendingScheduleTransitions().catch((error: unknown) => {
    diagnose({
      level: 'error',
      scope: 'recovery',
      message: `[bureau] Could not record pending schedule transitions at boot: ${serializeUnknownError(error)}`,
      cause: error,
    });
  });
  // COR-1946: the lease exists before the first task is admitted and before recovery looks at
  // what a stopped process left, so a peer that boots now finds this process alive.
  await processLease.start(options.maintenance === 'manual' ? 'manual' : 'timer');
  // Orphaned steering logs are independent of run recovery, so they are
  // swept at boot even when that recovery is deferred; in the background,
  // and awaited by shutdown before the backend closes.
  if (runtime.durable) {
    steeringSweep = sweepOrphanedSteeringLogs().catch((error: unknown) => {
      diagnose({
        level: 'error',
        scope: 'steering',
        message: `[bureau] Could not sweep orphaned steering logs: ${serializeUnknownError(error)}`,
      });
    });
  }
  // COR-1527: the workflow files' documents are registered with the engine, and their schedules
  // put in place, before anything recovers: a run in flight on a workflow file resumes on the
  // revision it began on only if that revision is loaded by then. The scheduler waits for this (see
  // `startScheduler` in `runtime-composition.ts`) and starts as soon as it is done.
  if (workflowRuntime !== undefined) {
    await workflowRuntime.start();
    // COR-2009 — after registration, so the sweep reads each in-flight instance against its
    // revision; before recovery, so no wait that begins from here on goes unheard.
    await workflowReviewWaits.start();
    stopForwarding.push(() => workflowReviewWaits.close());
    // COR-1721 — after the first scan `start()` made, as for the agent files.
    stopForwarding.push(
      forwardDefinitionChanges('workflows', workflowRuntime.workflows, (event) =>
        emitter.dispatch(event),
      ),
    );
    if (options.maintenance !== 'manual') runtime.durable?.engine.scheduler.start();
  }
  resumeHooks({ hooks: hooksInstance, engine: webhookNotifierInstance?.engine, diagnose });
  if (hasDeferredGatewayAuthority) {
    durableRecoveryDeferred = true;
    settledRecoveryReport = undefined;
    durableRecoveryBarrier = new Promise<BureauRecoveryReport>((resolve) => {
      resolveDurableRecoveryBarrier = resolve;
    });
  } else {
    durableRecoveryStarted = true;
    durableRecoveryBarrier = recoverDurableRuns().catch((error) => {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Durable run recovery failed during boot: ${serializeUnknownError(error)}`,
      });
      // See the deferred-path `.catch()` above: fold in a sweep failure and
      // any per-handle failures classified before recoverAll() threw, then
      // reset both this-pass collectors so neither leaks into a later
      // recovery pass.
      const sweepFailure = currentRecoverySweepFailure;
      const perRunFailures = dedupeRecoveryPerRunFailures(currentRecoveryPerRunFailures ?? []);
      const skippedRuns = currentRecoverySkippedRuns ?? [];
      currentRecoverySweepFailure = undefined;
      currentRecoveryPerRunFailures = undefined;
      currentRecoverySkippedRuns = undefined;
      return {
        outcome: 'failed',
        ...(sweepFailure ? { sweepFailure } : {}),
        batchFailure: { message: serializeUnknownError(error) },
        perRunFailures,
        skippedRuns,
      } satisfies BureauRecoveryReport;
    });
    settledRecoveryReport = await durableRecoveryBarrier;
    // COR-1664 — after recovery, so the runs it resumed are in flight and keep their claims. Not
    // awaited: recovery's resumed steps race the caller's first subscription, and every extra turn
    // before this function returns costs a recovered run's first events. Shutdown waits for it.
    void trackCatalogAssetRelease(reconcileAssetClaims());
  }

  trackScheduledFireReviewState(bureau, scheduledFireReviewState);
  trackFireReviewSeeds(bureau, fireReviewSeeds);
  if (fireReviewFollower !== undefined) trackFireReviewFollower(bureau, fireReviewFollower);
  construction.built(bureau);
  // COR-1879 — after the caller has the Bureau, so a plugin's `start` costs a recovered run's
  // first events nothing; `bureau.plugins.ready()` settles when every one has.
  // COR-1879 — a file a running plugin ships that names a contribution nothing loaded holds, and
  // what names each contribution, counted on every `plugins.list()`.
  pluginRegistry.observe({
    agents: () => bureau.agents.list(),
    agentReferences: async () => {
      const ready = bureau.agents.list().filter(({ state }) => state === 'ready');
      const details = await Promise.all(ready.map(({ id }) => bureau.agents.detail(id)));
      return details.flatMap((detail) =>
        detail === undefined
          ? []
          : [
              {
                id: detail.id,
                tools: detail.definition?.tools ?? detail.codeDefinition?.tools ?? [],
                guardrails: (detail.definition?.guardrails ?? []).map(guardrailIdOf),
                interceptors: detail.definition?.interceptors ?? [],
              },
            ],
      );
    },
    scheduleAgents: async () => {
      const agentNames: string[] = [];
      const pageSize = 100;
      for (let offset = 0; ; offset += pageSize) {
        const page = await listSchedules({
          status: ['active', 'paused'],
          limit: pageSize,
          offset,
        });
        if (page === undefined) break;
        for (const schedule of page.items) {
          const agentName = await getScheduleAgentName(schedule.id);
          if (agentName !== undefined) agentNames.push(agentName);
        }
        if (page.items.length < pageSize || offset + pageSize >= page.total) break;
      }
      return agentNames;
    },
    waitingRuns: () =>
      bureau.reviews.list().map((review) => ({
        runId: review.runId,
        agentName: review.agentName,
        toolName: review.kind === 'tool-approval' ? review.approval.toolName : undefined,
      })),
  });
  void pluginRegistry.start((plugin) => pluginHostApiOf(bureau as unknown as Bureau, plugin));

  /**
   * COR-1879 — the slice of `bureau` plugin `plugin` may call, and nothing else. What it causes is
   * the plugin's: the schedule it creates announces `schedule.created` with `source: plugin`, and
   * the goal it creates stores the plugin, so every `goal.*` event of the goal carries it.
   */
  function pluginHostApiOf(host: Bureau, plugin: string): PluginHost {
    return {
      agents: { list: () => host.agents.list() },
      schedules: {
        create: (definition) => createSchedule(definition, undefined, plugin),
        list: (filter) => host.schedules.list(filter),
      },
      goals: { create: (request) => createGoalForPlugin(goalsComposition.goals, request, plugin) },
    };
  }
}
