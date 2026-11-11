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
  createAgentScheduler,
  createFlowController,
  createRecoveredRunEventSurface,
  createRunFinishedFrame,
  createSessionInputDeliveryStore,
  createStore,
  type DurableEventOwner,
  type DurableRunDeps,
  type Effort,
  type FlowController,
  hasDefinitionResolver,
  HumanWaitParkedEvent,
  InvalidScheduleError,
  isAgentRunWorkflowInput,
  isScheduledAgentRunInput,
  type JSONValue,
  type LivenessSnapshot,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  parseSessionInputPayload,
  PERMISSION_MODES,
  type PermissionMode,
  readGenerationProfile,
  reattachDurableActiveRun,
  type RecoveredRunHandle,
  resolvesOwnGuardrails,
  RunRegisteredEvent as StoreRunRegisteredEvent,
  RunRemovedEvent as StoreRunRemovedEvent,
  ScheduleAttemptedEvent,
  ScheduleCancelledEvent,
  ScheduleCompletedEvent,
  type RunOptions,
  type ScheduledAgentRunInput,
  ScheduleFailedEvent,
  SchedulePausedEvent,
  SCHEDULER_RUN_ID_PREFIX,
  ScheduleResumedEvent,
  ScheduleSkippedEvent,
  SessionCreatedEvent,
  SessionDeletedEvent,
  type SessionInputAdmissionOutcome,
  type SessionInputAdmissionRequest,
  type SessionInputRetractionOutcome,
  type SessionInputRetractionRequest,
  type SessionInputGate,
  type SessionListOptions,
  SessionOutboxAppendedEvent,
  type SessionOutboxEntry,
  SessionSavedEvent,
  type SessionStore,
  type SessionSummary,
  SteeringAcceptedEvent,
  SteeringAppliedEvent,
  snapshotPayload,
  type SteeringRequestedValue,
  type StepRecord,
  type PeerCallJournal,
  type PeerCallJournalEntry,
  type Store,
  StoreActionEvent,
  type Subscription,
  sessionOriginOf,
  SESSION_OWNER_METADATA_KEY,
  SESSION_TITLE_METADATA_KEY,
  SESSION_TITLE_OVERRIDE_LIMIT,
  createSessionHandle,
  ForkThroughMessageError,
  admitToolResultMedia,
  createStepGeneratedMediaAdmitter,
  isFailureFinishReason,
  readDurableRunResult,
  humanInputSchemaOf,
  sessionOwnerOf,
  type ScheduleTick,
  summarizeSession,
  TOOL_TIMING_METADATA_KEY,
  type ToolTiming,
  bureauInvariantsField,
  runScopedExecutionContextOf,
  scanToolResult,
  type GuardrailFiring,
  type OperativeHookMap,
} from '@lostgradient/operative';
import type { SessionTaintSeam } from './session-taint-seam';
import {
  approvalDecisionMetadata,
  type ApprovalDecisionRecord,
} from './approval-decision-metadata';
import {
  createSkillArtifactLoader,
  SkillActivatedEvent,
  SkillDeactivatedEvent,
  SkillFailedEvent,
  SkillLoadedEvent,
  SkillRejectedEvent,
} from './skills';
import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import {
  decode,
  KEYS,
  type Engine,
  type ListFilter,
  type ListOptions,
  Mailbox,
  type RecoveredWorkflowInfo,
  type WorkflowState,
  WorkflowRecoverySkippedEvent,
} from '@lostgradient/weft';
import {
  type AnyToolbox,
  formatToolName,
  type SignedPendingToolApproval,
  type Tool,
  type ToolExecutionResult,
  type ToolRequestContext,
} from 'armorer';
import {
  Conversation,
  type ConversationHistory,
  CURRENT_SCHEMA_VERSION,
  materializeToolResultAsync,
  resolveToolResult,
  getOwn,
} from 'conversationalist';
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
import { markEventSource } from './event-source';
import { createGoalForPlugin } from './goals';
import {
  type AgentDefinitions,
  type AgentNames,
  createAgentCatalog,
  type CreateAgentCatalogOptions,
} from './agent-catalog';
import { AgentSnapshotError, type AgentFileDefinitionInput, guardrailIdOf } from './agent-file';
import { createTryAgents, isTryAgentName } from './agent-try';
import {
  allowedDescriptorsOfFileAgent,
  createAgentFileCatalog,
  type FileAgentBinding,
  readFileAgentBinding,
  readFileAgentCostBudget,
} from './agent-file-catalog';
import { unpricedSwitchReason } from './file-agent-cost-budget';
import { createFileAgentRuntime, type FileAgentRuntime } from './agent-file-runtime';
import { createAgentSnapshotStore } from './agent-snapshot-store';
import { createAssetService } from './assets/asset-service';
import {
  createAssetContentSourceResolver,
  createMcpResourceContentSourceResolver,
} from './assets/content-source-resolver';
import { createAssetGeneratedMediaAdmitter } from './assets/generated-media-admitter';
import {
  claimRowAssets,
  isPermanentClaimFailure,
  managedAssetIdsOf,
  releaseClaimsByHolderPrefix,
  releaseRowAssetClaims,
  runRowHolderId,
  sessionRowHolderId,
  sessionRowHolderPrefix,
} from './assets/row-asset-claims';
import { heldClaimsOf } from './assets/internal-access';
import { validateHumanInputOption } from './human-input-option';
import {
  validateChildrenOption,
  validateLogsMaximumLinesPerRun,
  validateRetentionOptions,
  validateSessionInputBacklogLimit,
} from './option-validators.ts';
import type { AssetService } from './assets/types';
import { createAssetClaimReconciler } from './asset-claim-reconciliation';
import { purgeChatAssets, type ChatAsset } from './chat-asset-purge';
import { purgeChatMemories, type RunMemoryPlacement } from './chat-memory-purge';
import {
  AUDIT_AGENT_OWNER_PREFIX,
  AUDIT_HOOK_OWNER_PREFIX,
  AUDIT_HOST_OWNER_ID,
  AUDIT_SCHEDULE_OWNER_PREFIX,
  AUDIT_SESSION_OWNER_PREFIX,
  AUDIT_SKILL_SOURCE_OWNER_PREFIX,
  AUDIT_TOOL_SOURCE_OWNER_PREFIX,
  AUDIT_WORKER_DEPLOYMENT_OWNER_PREFIX,
  AUDIT_WORKFLOW_OWNER_PREFIX,
  type AuditTrail,
  auditTrailSessionOwnerId,
  computeInitialAuditSequence,
  createAuditTrail,
} from './audit-trail';
import { agentSkillsRun } from './agent-skills';
import {
  catalogRunGuardrailsContext,
  createCatalogDispatcher,
  type SubordinateRun,
} from './bureau-catalog-dispatch';
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
import { unopenableNewSessionIdentifierReason } from './reserved-identifiers';
import { createSessionPersistence } from './bureau-session-persistence';
import {
  type BureauChildren,
  type ChildTopology,
  type ChildTopologyParent,
  createChildTopology,
} from './child-topology';
import { childActionOf } from './child-announcement';
import { type BureauChildChat, createChildTopologyStore } from './child-topology-store';
import {
  type ChatPermissionReading,
  ChatPermissionUnavailableError,
  grantLoosensTool,
} from './tool-approval';
import {
  createRunCreationLedger,
  BureauLedgerConflictError,
  digestCommandPayload,
  type RunCreationObservation,
} from './command-ledger';
import {
  createDurableEventHistory,
  createDurableEventProducer,
  type DurableEventHistory,
  type DurableEventProducer,
} from './durable-event-history';
import { createEventTimestampResolver } from './event-timestamp';
import {
  ActionEvent,
  BureauDisposedEvent,
  type BureauEventMap,
  type RecoveredRunVerdict,
  RecoveryAttemptedEvent,
  RecoveryLeaseReleasedEvent,
  RecoveryRejectedEvent,
  type RecoveryRejectionReason,
  ReviewApprovedEvent,
  ReviewRequestedEvent,
  ReviewCanceledEvent,
  ReviewDeniedEvent,
  ReviewExpiredEvent,
  ReviewRejectedEvent,
  ReviewRevokedEvent,
  ReviewSupersededEvent,
  RunAbortSettledEvent,
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
import { recoveryEntryFailure } from './goal-recovery';
import type { BureauGoals } from './goal-types';
import { createGoalValidatorCatalog } from './goal-validator-catalog';
import { createWorkflowContributions } from './workflow-contributions';
import { composeBureauGoals } from './goals-composition';
import { leaseEvidenceFromLostHealth } from './liveness-projection';
import { createAbandonedTaskSweeper, openProcessLease } from './process-lease';
import {
  createDecisions,
  decisionModelNames,
  validateDecisionsModelChoice,
  validateDecisionsOptions,
} from './decisions/create-decisions';
import { createLateDecisions } from './decisions/late-decisions';
import { createSettings, type SettingsComposition } from './settings/create-settings';
import { builtInSettingDefaults, DEFAULT_EVENT_RETENTION_MS } from './settings/setting-defaults';
import { summarizerFailures } from './settings/settings-validation';
import { createMemoryEmbedderSetting, type MemoryEmbedderSetting } from './memory-embedder-setting';
import { modelPolicyDenialOf } from './model-policy';
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
import {
  buildTerminalReportFromAbortedEvent,
  buildTerminalReportFromCompletedEvent,
  createRunFrameForwarder,
} from './run-envelope';
import { attachRunEventFeed, disposeRunEventFeed } from './run-event-feed-attachment.ts';
import type {
  BureauToolbox,
  CatalogAgentRunOptionsResolution,
  ScheduledFireNotice,
  ScheduledFireServicesNotice,
  ScheduledFireSettlement,
  ScheduledSessionNotice,
  SessionAgentRun,
  SkillSnapshot,
} from './runtime-composition';
import {
  createMaintenanceMemoryAuthority,
  createRuntimeComposition,
  isScheduledFireAuthority,
  recordRecoveredSkillPolicy,
  recoveredSkillPolicyOf,
  registerTrailingOnStep,
  SESSION_AGENT_DEFINITION_HASH_METADATA_KEY,
  sessionRecordedRevision,
  sessionRunMediaOptions,
} from './runtime-composition';
import {
  findRunAgentName,
  resolveDiagnosticSink,
  type RunAttribution,
  serializeActionDetail,
  serializeRunDetail,
  serializeRunState,
  serializeUnknownError,
} from './serialization';
import {
  createCatalogTaskSettler,
  type SubordinateClaim,
  subordinateTaskAdmission,
} from './catalog-task-settlement';
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
  publishFreshCatalogRun,
} from './catalog-run-settlement';
import {
  createTaskRegistry,
  originatingMessageText,
  settledTaskState,
  TASK_ARTIFACT_TEXT_LIMIT,
  TASK_STATUS_MESSAGE_LIMIT,
  type LiveTask,
  type TaskRecord,
  type TaskRegistry,
  type TaskToolGrant,
} from './task-registry';
import { isTaskOrigin } from './task-origin';
import { createTaskResync, type TaskResync } from './task-resync';
import {
  ANONYMOUS_LOCAL_OWNER,
  EXPIRY_ACTOR,
  ownerFromPrincipal,
  ownerOrLocal,
  RECOVERY_ACTOR,
  SCHEDULER_ACTOR,
} from './owner-of-record';
import { toScheduleSpec } from './schedule-spec';
import {
  decodeScheduleTransition,
  type PendingScheduleTransition,
  SCHEDULE_TRANSITION_KEY_PREFIX,
  scheduleTransitionKey,
  scheduleTransitionKeyPrefix,
  type ScheduleTransitionKind,
  scheduleTransitionOperation,
} from './schedule-transition-outbox';
import {
  agentStepResultFromRun,
  agentStepResultFromState,
  workflowStepRunId,
} from './workflow-agent-step';
import {
  parseWorkflowScheduleId,
  storedScheduleInput,
  workflowScheduleBinding,
} from './workflow-schedule';
import {
  createWorkflowRuntime,
  payloadMaximumBytesOf,
  type WorkflowRuntime,
  type WorkflowScheduleBlocker,
} from './workflow-runtime';
import { createBureauWorkerDeployments } from './worker-deployments';
import { everySchedule, readAttention } from './attention-feed';
import { isScheduleTickRunId, startScheduleTick } from './schedule-tick';
import { createWorkflowTools } from './workflow-tools';
import { createSettingsTools } from './settings/settings-tools';
import { createWorkflowRevisionLedger } from './workflow-revision-ledger';
import { createWorkflowScheduleHolds } from './workflow-schedule-holds';
import { createAgentOverrideStore } from './agent-override-store';
import { createWorkflowSnapshotStore } from './workflow-snapshot-store';
import {
  type AgentStepRequest,
  type AgentStepResult,
  createWorkflowDocumentHost,
  WorkflowAgentStepError,
} from './workflow-host';
import { createFireReviewSeeds, trackFireReviewSeeds } from './fire-review-seeds';
import {
  createFireReviewFollower,
  type FireReviewFollower,
  trackFireReviewFollower,
} from './fire-review-follower';
import { createBureauInteractiveSurfaces } from './interactive-surface/bureau-wiring';
import {
  adoptRestoredScheduledFire,
  committedFireApprovalIds,
  committedFireReviewIds,
  committedFireReviews,
  endContinuingScheduledFire,
  registerScheduledFireApproval,
  releaseScheduledFireReviews,
  type ScheduledFireReviewState,
  trackScheduledFireReviewState,
  withoutFireApprovals,
} from './scheduled-fire-review-state';
import {
  attributeScheduledFire,
  recordScheduleFired,
  releaseScheduledFire as releaseScheduledFireAttribution,
} from './scheduled-fire-record';
import {
  isPlainAuthorityRecord,
  isSessionAuthorityAuthorized,
  resolvePersistedRunOwningPrincipal,
  resolveRunMemoryOwner,
  resolveSessionOwner,
  resolveSessionPreAdmission,
} from './session-authority';
import {
  createReviewDecisionRecords,
  digestReviewDelivery,
  type ReviewDecisionRequest,
} from './review-decision-record';
import {
  createResolvedReviewStore,
  type ReviewDecisionAuditPayload,
  resolvedReviewOfAudit,
} from './resolved-review-record';
import { validateReviewAnswer } from './review-answer';
import {
  gateSecretAnswer,
  holdsSealedAnswer,
  type SecretAnswerAuditEntry,
  SecretAnswerUnavailableError,
  secretFieldsOfReview,
  secretResolverOf,
  unsealedSecretFields,
} from './secret-answers';
import {
  createRunHumanWaits,
  humanWaitDecisionPayload,
  humanWaitDecisionRequest,
  humanWaitDeliveryId,
} from './run-human-waits';
import { createWorkflowReviewWaits } from './workflow-review-waits';
import {
  countCheckpointParks,
  humanWaitParkOrdinal as sharedHumanWaitParkOrdinal,
} from './park-ordinals';
import {
  REVIEW_CLOSING_EVENT_KINDS,
  reviewCanceledDedupeKey,
  REPLAY_SUPERSEDING_PRINCIPAL,
  REVIEW_SUPERSEDED_EVENT_KIND,
} from './review-closing-events';
import {
  SCHEDULE_FIRE_SETTLED_EVENT_KIND,
  scheduleFireSettledDedupeKey,
  type ScheduleFireSettledPayload,
} from './schedule-fire-settled-event';
import { createChatSpendLedger } from './chat-spend-ledger';
import { copyAgentOwnedRunOptions, sessionExecuteOptions } from './session-agent-options';
import {
  admitSessionInput,
  isSessionInputSessionIdAddressable,
  SessionInputMailboxPurgedError,
  type SessionInputAdmissionAttemptOutcome,
  createSessionInputMailbox,
  type PersistedSessionInput,
  readSessionInputReceipt,
  SESSION_INPUT_DELIVERY_RETENTION_MS,
  SESSION_INPUT_RETRACT_SETTLE_MILLISECONDS,
  SESSION_INPUT_RETRACTED_REASON,
} from './session-input-durability';
import { createSessionInputDeliveryGate } from './session-input-delivery';
import {
  createSessionInputSettlement,
  forEachOpenReceipt,
  SESSION_INPUT_RUN_ENDED_REASON,
} from './session-input-settlement';
import { generateSessionOutboxDrainOwnerSuffix } from './session-outbox-drain-owner-suffix';
import { recoveredRequestContextFromMetadata } from './session-request-context';
import { allowsModelOverride, describeAgentModels } from './agent-models';
import {
  assertBranchPoint,
  createForkLedger,
  FORK_OPERATION_VERSION,
  type ForkLedgerClaim,
  type ForkLedgerFailure,
  type ForkLedgerResult,
  type ForkSessionRequest,
  type ForkSessionResult,
  SessionForkRefusedError,
} from './session-fork';
import { withoutGrantsFor } from './session-grants';
import {
  answerSteeringRetry,
  type BureauSteeringGate,
  getSteeringLedgerEntry,
  createSteeringCommandLedger,
  createSteeringGate,
  type ImplementedSteeringCommand,
  isConfigurationTarget,
  type SteeringCommandAdmissionOutcome,
  type SteeringCommandRequest,
  type SessionSteeringState,
  type SteeringRefusal,
  steersIdleSession,
} from './steering';
import {
  appendSteeringLogEvent,
  deleteSteeringLog,
  listSteeringLogIncarnations,
  readSteeringKeyBinding,
  readSteeringLogEntries,
  readSteeringLogHead,
  isReadableSteeringLogEvent,
  SteeringLogCorruptError,
  steeringSessionRunTag,
  type SteeringKeyBinding,
  type SteeringLogEvent,
} from './steering-log';
import type {
  AbortingRun,
  Bureau,
  BureauOptions,
  ApprovalPeerRecovery,
  BureauRecoveryReport,
  BureauShutdownOptions,
  BureauShutdownOwnerReport,
  BureauShutdownReport,
  CancelDurableRunOutcome,
  CleanupAcknowledgement,
  ContextDeletionReport,
  ContextWindowReport,
  OwnedResource,
  CreateScheduleOptions,
  DurableScheduleDefinition,
  DurableScheduleUpdate,
  ScheduleRevisionGuard,
  PendingHumanWaitReview,
  PendingReview,
  SessionPendingReview,
  ResolveReviewInput,
  ResolveReviewResult,
  ExpiredRecordRemoval,
  ReviewResolutionFields,
  ReviewStatus,
  RunSummary,
  ServerFrame,
} from './types';
import {
  DEFAULT_PRINCIPAL_SESSION_INPUT_BACKLOG_LIMIT,
  DEFAULT_SESSION_INPUT_BACKLOG_LIMIT,
} from './types';
import { isSettlingRunAction, settledActionTimestamp } from './run-settlement';
import { createAudit } from './audit/create-audit';
import {
  ChatRunsNotEndedError,
  createChatContentPurge,
  type DeletedChat,
} from './chat-content-purge';
import { purgeReviewRecords } from './chat-review-purge';
import { writeContextTombstone } from './context-tombstone';
import { type AgUiLease, createAgUiLeases, releaseQuietly } from './http/ag-ui-lease';
import { purgeChatLedgerEntries } from './chat-ledger-purge';
import { createNotifications } from './notifications/create-notifications';
import {
  buildContextWindow,
  type ContextWindowTool,
  type ReportedStepUsage,
  sizeManagedAssets,
} from './contexts/context-window';
import { createContexts } from './contexts/create-contexts';
import { createTasks } from './tasks/create-tasks';
import { createReviews } from './reviews/create-reviews';
import { createSchedules } from './schedules/create-schedules';
import { createWebhookNotifier, type WebhookNotifier } from './webhook-notifier';
import { workspaceHookEvents } from './hooks/workspace-hook-events.ts';
import {
  captureRunWorkspaceAuthority,
  validateRunWorkspaceAuthority,
  mayUseAutomationInput,
  createRunAuthorityValidator,
  mayRunUseSharedConfiguration,
  recoverRunWorkspaceAuthority,
} from './run-authority.ts';
import { type CreatedHooks } from './hooks/create-hooks';
import { createRunHookOrigins } from './hooks/run-hook-origins';
import { scheduleInputPreview } from './schedule-input-preview';
import { ownEntry } from './own-entry';
import {
  BureauError,
  APPROVAL_OUTCOME_NOT_WRITTEN_MESSAGE,
  ApprovalOutcomeNotWrittenError,
  PinnedToolUnavailableError,
  pinnedToolUnavailable,
  ReviewRoundChangedError,
  ReviewAnswerInvalidError,
  UnpricedSwitchRefusedError,
  BureauShuttingDownError,
  TaskRespondError,
  TerminalSessionRecordAbandonedError,
  ScheduleLocatorUnavailableError,
  UnknownScheduleAgentError,
  toBadRequest,
} from './bureau-errors';
import {
  ABORTED_RUN_TERMINAL_GRACE_MILLISECONDS,
  DURABLE_FORCIBLY_TERMINABLE_STATUSES,
  resolveWaitForDurableRun,
  resolveCancelDurableRun,
  COMMITTED_ELSEWHERE,
  isCommittedElsewhere,
  endedElsewhereAs,
  terminalActionTimestamp,
} from './durable-run-waits';
import {
  hasRecoverableTransportAuthority,
  isTerminalApprovalBindingError,
  emptyRecoveredStepMetadata,
  type SessionLoadOutcome,
  type ClassifyRecoveredRunArgs,
  RECOVERED_RUN_TERMINAL_STATUSES,
  classifyRecoveredRunDetailed,
  dedupeRecoveryPerRunFailures,
  isRecoverableScheduledFireInput,
  loadScheduleIdForRecoveredRun,
  loadExistingScheduledSessionId,
  monitorRecoveredScheduledFire,
  monitorRecoveredCatalogRun,
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
  SESSION_INPUT_RUN_END_RETRY_DELAY_MILLISECONDS,
  SESSION_INPUT_RUN_END_DIAGNOSTIC_INTERVAL_MILLISECONDS,
  SESSION_INPUT_RUN_END_RETRY_CAP_MILLISECONDS,
  SESSION_PERSISTENCE_RETRY_DELAY_MILLISECONDS,
  createSessionPersistenceSleep,
  createShutdownTimeoutSleep,
  needsAutomaticMaintenance,
  EXPIRY_SWEEP_INTERVAL_MILLISECONDS,
  SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS,
  taskRetentionOf,
  type MaintenancePassName,
  hasMaintenanceSurface,
  expiredRecordRemovalOf,
  THREAD_LEASE_RETRY_MILLISECONDS,
  CONTEXT_WINDOW_TASK_SCAN_LIMIT,
  resumeRefusedBeforeExecution,
  FIRE_REVIEW_RECONCILIATION_MAXIMUM_DELAY_MILLISECONDS,
  notifyPeerCallsReady,
  watcherHealthOf,
  rejectHooksWithoutStorage,
  wantsWebhookNotifier,
  webhookNotifierOptionsOf,
  composeHooks,
  resumeHooks,
} from './bureau-construction-support';
import {
  NotifyingReviewIdSet,
  omitStartedRecord,
  isJsonObject,
  readApprovalResolutionStarted,
  writeApprovalResolutionStarted,
  omitKeysWithPrefix,
  omitStartedRecordsWithPrefix,
  omitKey,
  approvalGrantsOf,
  type CanceledReviewTarget,
  AUDIT_PAGE_SIZE,
  closingStatusOfRound,
  stringValues,
  type ApprovedCallAudit,
  createScheduledFireApprovalHook,
} from './approval-state-records';
import {
  rejectUnopenableNewSessionIdentifier,
  rejectReservedIdentifier,
  replaceInputText,
  validateAgentRunInput,
  createTasksRespondLedger,
} from './run-request-validation';
import {
  STEERING_APPEND_ATTEMPTS,
  REVIEW_AUDIT_OUTBOX_NAMESPACE,
  type BureauCore,
  type SteeringCursor,
  type SteeringFoldHistory,
  type SteeringPoller,
  type SessionDeletionRecord,
  type ReviewAuditAttachment,
  type ChatRunSpend,
} from './bureau-seams/core';
import { createEventHistoryReads, type EventHistoryPeers } from './bureau-seams/event-history';
import { createTaskStart, type TaskStartPeers } from './bureau-seams/task-start';
import { createRunCreation, type RunCreationPeers } from './bureau-seams/run-creation';

/**
 * The callables the seams of `constructBureau` read from one another and from the parent: the
 * intersection of every seam's peers. The annotation on `peers` is required: without it, a getter
 * that returns a factory's member makes that factory's inferred type circular (TS7022).
 */
type BureauPeers = EventHistoryPeers & TaskStartPeers & RunCreationPeers;

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
  // COR-1879: `decisions.model` may name a decision router a plugin contributed.
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
      permissionModeOfRun,
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
  // Ids of PendingReview items already resolved via resolveReview() (AB-20).
  // Neither resolution path (resumeApproval, signalSession) mutates the live
  // store in a way listPendingReviews() can detect on its own — resumeApproval
  // re-invokes the tool directly (no run/step event), and a signalled human-wait
  // run may take a moment to produce its next action. This set is the
  // authoritative "already handled" marker so a resolved review disappears
  // from the queue immediately, and is never accidentally resolved twice.
  // COR-1622: the expiry sweep's own timer. Declared ahead of the id sets whose additions check
  // whether it is still needed, so no order of construction can read it before it exists.
  // `RuntimeTimeoutHandle` is opaque, so a flag tracks whether the timer is armed.
  let lazyExpirySweepTimer: RuntimeTimeoutHandle;
  let lazyExpirySweepArmed = false;
  let lazyExpirySweepPass: Promise<void> | undefined;
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
    assertRunAdmissionOpen,
    releaseRunToolboxWhenIdle,
    withBackgroundShutdownSignal,
    interruptedFields,
    dropPendingApprovalOverride,
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
        generationMode: readGenerationProfile(agent).mode,
        recoveredChild: childContext !== undefined,
        ...(agentBinding === undefined ? {} : { agentBinding }),
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
  function assertRunAdmissionOpen(subject: 'run' | 'scheduler task'): void {
    if (runAdmissionClosed) {
      throw new BureauError(`Cannot create ${subject}: Bureau is shutting down.`, 'CONFLICT');
    }
  }
  // COR-690: a terminal run's toolbox leaves the tracked set only once its own
  // execution lifecycle is idle. A tool callback that ignored the run's abort
  // is still running inside it, and a later `shutdown()` must find and await it.
  function releaseRunToolboxWhenIdle(runToolbox: BureauToolbox): void {
    detachBestEffortPromise(runToolbox.whenIdle().then(() => runToolboxes.delete(runToolbox)));
  }
  function withBackgroundShutdownSignal(callerSignal: AbortSignal | undefined): AbortSignal {
    return callerSignal
      ? AbortSignal.any([callerSignal, backgroundShutdownController.signal])
      : backgroundShutdownController.signal;
  }
  function interruptedFields(
    reviewId: string,
  ): { interrupted: true; resolutionStartedAt: number | undefined } | Record<never, never> {
    return interruptedApprovals.has(reviewId)
      ? { interrupted: true, resolutionStartedAt: interruptedApprovals.get(reviewId) }
      : {};
  }
  function dropPendingApprovalOverride(reviewId: string): void {
    pendingApprovalOverrides.delete(reviewId);
    pendingApprovalRounds.delete(reviewId);
    interruptedApprovals.delete(reviewId);
    approvalRequestedAt.delete(reviewId);
    stopLazyExpirySweepWhenNoneHeld();
  }

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

  /** `undefined` for a non-durable bureau — nothing to persist against. */
  function getSessionInputMailbox(sessionId: string, incarnation: string): Mailbox | undefined {
    const storage = runtime.durableStorage;
    if (!runtime.durable || storage === undefined) return undefined;
    const cacheKey = `${sessionId}\u0000${incarnation}`;
    let mailbox = sessionInputMailboxes.get(cacheKey);
    if (!mailbox) {
      mailbox = createSessionInputMailbox(
        storage,
        sessionId,
        incarnation,
        sessionInputSessionBacklogLimit(),
        runtimeServices.clock.now,
      );
      sessionInputMailboxes.set(cacheKey, mailbox);
    }
    return mailbox;
  }

  /**
   * {@link getSessionInputMailbox}, or `undefined` when Weft could not carry
   * this session id as a command's target (over its identity limit). Such a
   * session still runs and steers, but admission has no mailbox to write to,
   * so `submitSessionInput` answers it `unsupported-capability` and no input
   * can ever be waiting for its runs.
   */
  function tryGetSessionInputMailbox(sessionId: string, incarnation: string): Mailbox | undefined {
    if (!isSessionInputSessionIdAddressable(sessionId)) return undefined;
    try {
      return getSessionInputMailbox(sessionId, incarnation);
    } catch {
      return undefined;
    }
  }

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

  /** The settlement in flight for each ended run: a run is settled once, however many paths report its end. */
  const sessionInputSettlementsByRun = new Map<string, Promise<void>>();

  /** Tracks a settlement, which never rejects, so shutdown lands it before it tears the stores down. */
  function trackSessionInputSettlement(settling: Promise<void>): void {
    inFlightSessionInputSettlements.add(settling);
    void settling.finally(() => inFlightSessionInputSettlements.delete(settling));
  }

  /**
   * Whether `runId` will still replay or re-run the step that appended its
   * input: the run is live in some process, or is starting. A run that is not
   * live has released its claims or will never resume.
   */
  async function isSessionRunLive(
    sessionId: string,
    incarnation: string,
    runId: string,
  ): Promise<boolean> {
    const live = await liveSessionRunIdsEverywhere(sessionId, incarnation, runId);
    return live.includes(runId);
  }

  /**
   * COR-1476 — the gate through which one of this session's durable runs
   * receives input `submitSessionInput` admitted while it is live. `undefined`
   * when the bureau has no durable mailbox, or the run has no recorded
   * incarnation, in which case there is nothing to deliver.
   *
   * The gate drains the mailbox of `incarnation`, the one the run started in
   * (`runSessionIncarnations`, which its first save or its recovery records,
   * or that same value read before the record is made). Each incarnation has
   * its own mailbox, so a session deleted and recreated under the same id
   * while the run is live leaves this gate draining the retired mailbox, which
   * its session's deletion cancelled and the sweep retires, and never the
   * recreated session's input: no reader checks an incarnation.
   */
  function sessionInputGateFor(
    sessionId: string,
    runId: string,
    incarnation: string | undefined,
  ): SessionInputGate | undefined {
    if (incarnation === undefined || sessionInputDeliveryStore === undefined) return undefined;
    const mailbox = tryGetSessionInputMailbox(sessionId, incarnation);
    if (mailbox === undefined) return undefined;
    const gate = createSessionInputDeliveryGate({
      sessionId,
      runId,
      incarnation,
      mailbox,
      deliveryStore: sessionInputDeliveryStore,
      isOwnerLive: (ownerRunId) => isSessionRunLive(sessionId, incarnation, ownerRunId),
      now: runtimeServices.clock.now,
      timers: runtimeServices.timers,
      signal: backgroundShutdownController.signal,
      onError: (error) =>
        diagnose({
          level: 'error',
          scope: 'session-input',
          message: `[bureau] A session-input lease of run "${runId}" in session "${sessionId}" could not be kept or retired: ${serializeUnknownError(error)}`,
          cause: error,
        }),
    });
    sessionInputGates.set(runId, { gate, sessionId });
    return gate;
  }

  /**
   * Hands a recovered durable run its session's input gate before replay
   * resumes, the way {@link recoverRunSteering} hands it its steering gate.
   */
  async function attachRecoveredSessionInput(
    sessionId: string,
    runId: string,
    services: DurableRunDeps,
    incarnation: string | undefined,
  ): Promise<void> {
    const gate = sessionInputGateFor(
      sessionId,
      runId,
      runSessionIncarnations.get(runId) ?? incarnation,
    );
    if (gate !== undefined) {
      services.options = { ...services.options, sessionId, sessionInput: gate };
    }
  }

  /**
   * The release half of a run's termination: disposes its gate, which returns
   * each lease it holds to the mailbox, and releases the run's unpromoted claims
   * so the next run can deliver them. Safe whenever it runs: an unpromoted input
   * is in no durable transcript. Needs no live bureau beyond its stores, so
   * shutdown runs it too, and never starts a run.
   */
  async function releaseSessionInputs(sessionId: string, runId: string): Promise<void> {
    const held = sessionInputGates.get(runId);
    sessionInputGates.delete(runId);
    try {
      await held?.gate.dispose?.();
      await sessionInputDeliveryStore?.release(sessionId, runId);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'session-input',
        message: `[bureau] Could not release the session input run "${runId}" held in session "${sessionId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  /**
   * COR-1476 — a run has ended, however it ended: completed, failed, aborted by
   * `abortRun`, cancelled by `cancelDurableRun`, or promoted but never started.
   * A run is settled once: every path that reports its end shares the one
   * settlement in flight. In this order, it
   *
   * 1. releases what it held (its gate's leases and its unpromoted claims),
   *    which reads no mailbox and so keeps the ordering below;
   * 2. writes its steering `run-ended` entry, the durable not-live write every
   *    process's `liveSessionRunIdsEverywhere` honours over the engine's status,
   *    retrying with a growing backoff until it is acknowledged, the bureau
   *    closes, or the log proves corrupt;
   * 3. catches up steering;
   * 4. reads the session's liveness without itself;
   * 5. cancels every open input whose turn is not in its checkpoint transcript,
   *    in admission order, so the client learns it was not delivered and
   *    resends it, unless another run of the session is live or starting, the
   *    bureau is closing, the write was never acknowledged, or liveness could
   *    not be read: that run's end, or the sweep, then decides. A turn the
   *    transcript holds was promoted by the write that saved it, and stays
   *    `promoted`.
   *
   * `submitSessionInput` orders itself the other way round, admission before
   * liveness, so one side always sees the other: see
   * `session-input-settlement.ts`.
   */
  function settleSessionInputsAfterRunEnd(sessionId: string, runId: string): Promise<void> {
    const inFlight = sessionInputSettlementsByRun.get(runId);
    if (inFlight !== undefined) return inFlight;
    const settling = settleSessionInputsOnce(sessionId, runId).finally(() => {
      sessionInputSettlementsByRun.delete(runId);
    });
    sessionInputSettlementsByRun.set(runId, settling);
    return settling;
  }

  async function settleSessionInputsOnce(sessionId: string, runId: string): Promise<void> {
    await releaseSessionInputs(sessionId, runId);
    const acknowledged = await recordRunEnded(sessionId, runId);
    if (!acknowledged || sessionInputSettlement === undefined || isSessionInputClosed()) return;
    // The cancel pass is over the mailbox of the incarnation the run started
    // in, like its gate and its terminal save; a run with no recorded
    // incarnation drained no mailbox and has nothing to settle.
    const incarnation = runSessionIncarnations.get(runId);
    if (incarnation === undefined) return;
    try {
      const session = await runtime.sessionStore?.load(sessionId);
      // A deleted or recreated session retired this incarnation: its mailbox
      // is nobody's, so whatever is open in it is cancelled without a liveness
      // read, which its steering log, gone with the incarnation, could not
      // answer anyway. The sweep does the same for what this misses.
      const retired = session === undefined || session.incarnation !== incarnation;
      if (!retired) {
        const steeringKv = durableSteeringStore();
        if (steeringKv !== undefined) {
          await enqueueSteering(sessionId, () =>
            catchUpSteering(steeringKv, sessionId, incarnation),
          );
        }
        const live = await liveSessionRunIdsEverywhere(sessionId, incarnation);
        if (live.some((liveRunId) => liveRunId !== runId)) return;
      }
      const delivered = await sessionInputCommandsInTranscript(runId);
      await sessionInputSettlement.cancelUndelivered(sessionId, incarnation, delivered);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'session-input',
        message: `[bureau] Could not settle the open session input of session "${sessionId}" after run "${runId}" ended; the sweep will: ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  /**
   * Makes sure `runId`'s steering `run-ended` entry is in the log, retrying the
   * write with a backoff that doubles from 10 ms to 2 s, and reports whether it
   * is. A run the log never promoted, or whose session is gone or recreated, was
   * never counted live from the log, so there is nothing to write and the answer
   * is yes. The answer is no when the bureau closes first, or when the log
   * proves corrupt, which no retry repairs: the input is left to the sweep. The
   * first failure is reported at once and later ones at most once a minute.
   */
  async function recordRunEnded(sessionId: string, runId: string): Promise<boolean> {
    const pending = steeringRunEndWrites.get(runId);
    steeringRunEndWrites.delete(runId);
    if (pending !== undefined) {
      try {
        await pending;
        return true;
      } catch {
        // Rejected: retried below until it lands.
      }
    }
    const steeringKv = durableSteeringStore();
    if (steeringKv === undefined) return true;
    let delay = SESSION_INPUT_RUN_END_RETRY_DELAY_MILLISECONDS;
    let lastReportedAt: number | undefined;
    for (let attempt = 1; ; attempt += 1) {
      if (isSessionInputClosed()) return false;
      try {
        const session = await runtime.sessionStore?.load(sessionId);
        // Gone, or recreated under the same id since the run started: the log
        // that promoted the run went with its incarnation, so there is nothing
        // to write, and the current incarnation's log never counted it live.
        const started = runSessionIncarnations.get(runId);
        if (session === undefined || (started !== undefined && session.incarnation !== started)) {
          return true;
        }
        const cursor = await enqueueSteering(sessionId, () =>
          catchUpSteering(steeringKv, sessionId, session.incarnation),
        );
        if (cursor.history.runs.get(runId) !== 'promoted') return true;
        await enqueueSteering(sessionId, () =>
          appendThenApplySteering(steeringKv, sessionId, session.incarnation, {
            type: 'run-ended',
            runId,
            now: runtimeServices.clock.nowISO(),
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof SteeringLogCorruptError) {
          diagnose({
            level: 'error',
            scope: 'session-input',
            message: `[bureau] The end of run "${runId}" in session "${sessionId}" cannot be recorded in a corrupt steering log; its open session input is left to the sweep: ${serializeUnknownError(error)}`,
            cause: error,
          });
          return false;
        }
        // Contention, a storage failure, or a session recreated under this
        // read: the next attempt reloads the session and refolds its log, so a
        // session that is gone or no longer promotes this run ends the loop.
        const now = runtimeServices.clock.now();
        if (
          lastReportedAt === undefined ||
          now - lastReportedAt >= SESSION_INPUT_RUN_END_DIAGNOSTIC_INTERVAL_MILLISECONDS
        ) {
          lastReportedAt = now;
          diagnose({
            level: 'error',
            scope: 'session-input',
            message: `[bureau] The end of run "${runId}" in session "${sessionId}" could not be recorded (attempt ${String(attempt)}); retrying before its session input is settled: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        // Shutdown ends the wait at once; the loop then sees the bureau closed.
        await Promise.race([sessionPersistenceSleep(delay), sessionInputClosing.promise]);
        delay = Math.min(delay * 2, SESSION_INPUT_RUN_END_RETRY_CAP_MILLISECONDS);
      }
    }
  }

  /** The mailbox commands whose user turns `runId`'s checkpoint transcript holds. */
  async function sessionInputCommandsInTranscript(runId: string): Promise<Set<string>> {
    const delivered = new Set<string>();
    const snapshot = await runtime.durable?.checkpointStore.loadConversation(runId);
    if (snapshot === undefined || snapshot === null) return delivered;
    for (const message of Conversation.from(snapshot, { runtime: runtimeServices }).getMessages()) {
      const commandId = message.metadata?.['sessionInputCommandId'];
      if (typeof commandId === 'string') delivered.add(commandId);
    }
    return delivered;
  }

  /** A run abandoned to another owner: stop keeping its leases alive, but keep its claims. */
  function abandonSessionInputGate(runId: string): void {
    const held = sessionInputGates.get(runId);
    sessionInputGates.delete(runId);
    void Promise.resolve(held?.gate.dispose?.()).catch((error: unknown) => {
      diagnose({
        level: 'error',
        scope: 'session-input',
        message: `[bureau] Could not stop the leases of abandoned run "${runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    });
  }

  /** Whether the bureau is shutting down, when open input is released, never cancelled. */
  function isSessionInputClosed(): boolean {
    return runAdmissionClosed || maintenanceAdmissionClosed;
  }

  /**
   * Retires the input a deleted session incarnation left pending: cancels what
   * is open in that incarnation's mailbox, and marks the incarnation so the
   * sweep keeps maintaining its mailbox until retention has emptied it, since
   * no run will drain a retired mailbox and its terminal records would
   * otherwise never retire. An admission that commits after this pass, under
   * the same marker, is cancelled by the sweep.
   */
  async function retireSessionInputs(sessionId: string, incarnation: string): Promise<void> {
    const mailbox = tryGetSessionInputMailbox(sessionId, incarnation);
    if (mailbox === undefined) return;
    await forEachOpenReceipt(mailbox, async (commandId) => {
      await mailbox.requestCancellation({ commandId, reason: 'the session was deleted' });
    });
    await sessionInputSettlement?.markOpen(sessionId, incarnation);
  }

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

  /**
   * A run whose local handle settled with no terminal event while the store still says `running`:
   * its engine lost a checkpoint race, was disposed, or saw another engine commit the run's
   * outcome, and `driveDurableRun` stayed write-free in each case. This process no longer drives
   * the run, so its liveness is the engine's, and it stops keeping the run's input leases alive
   * (COR-1476); the claims stay, since the owner may yet replay the steps that hold them.
   *
   * COR-1614 — when the durable run is already over, the run's record here ends with that outcome
   * as well ({@link settleRunEndedElsewhere}).
   */
  function settleAbandonedRun(sessionId: string, runId: string, activeRun: ActiveRun): void {
    if (store.getRun(runId)?.status !== 'running') return;
    settledLocalRunIds.add(runId);
    releaseSessionSteeringPoll(sessionId, runId);
    abandonSessionInputGate(runId);
    detachBestEffortPromise(settleRunEndedElsewhere(runId, activeRun));
  }

  /**
   * COR-1614 — ends this process's record of a run another process ended: another Bureau cancelled
   * it (`cancelDurableRun`) or timed it out (`Engine.timeout`) while this one drove it. The run
   * ends `aborted` or `error` on the store, so a stream a client opened here ends with the matching
   * terminal, the run stops counting as live and frees its concurrency slot, and this process stops
   * holding its `ActiveRun`.
   *
   * The end reaches the store only, never the run's emitter, and the store action it records is
   * marked `committedElsewhere`, which keeps it to this process's live frames. So no run hook,
   * terminal listener, session save, task record, audit record, or durable history entry comes
   * from here: the process that committed the outcome publishes what it publishes (a cancel's
   * session status), and an engine that reclaimed the run and ended it has its own driver for the
   * rest. A run whose durable state is not over (a lost checkpoint race), or cannot be read (a
   * disposed engine), stays as it was.
   */
  async function settleRunEndedElsewhere(runId: string, activeRun: ActiveRun): Promise<void> {
    let state: WorkflowState | null | undefined;
    try {
      state = await runtime.durable?.engine.get(runId);
    } catch {
      return;
    }
    const ending = state === null || state === undefined ? undefined : endedElsewhereAs(state);
    if (ending === undefined || store.getRun(runId)?.status !== 'running') return;
    store.settleRun(runId, ending.type, { error: ending.error, [COMMITTED_ELSEWHERE]: true });
    activeRuns.delete(activeRun);
    flowController?.settle(runId);
    queueMicrotask(() => releaseTerminalRunReviewState(runId));
  }

  /** `runtime.kv`, when this bureau keeps durable steering at all. */
  function durableSteeringStore(): ConditionalTextValueStore | undefined {
    return runtime.durable && runtime.durableStorage !== undefined ? runtime.kv : undefined;
  }

  /** Runs `operation` after every earlier log operation for `sessionId`. */
  function enqueueSteering<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = steeringQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    steeringQueues.set(sessionId, settled);
    void settled.then(() => {
      if (steeringQueues.get(sessionId) === settled) steeringQueues.delete(sessionId);
      return undefined;
    });
    return next;
  }

  /** The session's gate, created on first use (non-durable bureaus). */
  function getSessionSteeringGate(sessionId: string): BureauSteeringGate {
    let gate = steeringGates.get(sessionId);
    if (gate === undefined) {
      gate = createSteeringGate(sessionId, steeringCommandLedger, runtimeServices.clock);
      steeringGates.set(sessionId, gate);
    }
    return gate;
  }

  /**
   * Applies one logged event to `gate` through the same method the live
   * path calls, with the inputs the event recorded. Deterministic: the same
   * log folds to the same state in every process.
   */
  function applySteeringEvent(
    gate: BureauSteeringGate,
    refusals: Map<string, Map<string, SteeringRefusal>>,
    event: SteeringLogEvent,
    submitted?: Map<string, Map<string, SteeringRequestedValue>>,
    // What the log so far established, when the whole log is being folded:
    // events no process could have logged after it are corruption.
    history?: SteeringFoldHistory,
  ): SteeringCommandAdmissionOutcome | undefined {
    if (history !== undefined) checkSteeringHistory(gate.sessionId, history, event);
    switch (event.type) {
      case 'admit': {
        const outcome = gate.admit(event.command, {
          liveRunIds: event.liveRunIds,
          now: event.now,
        });
        const { principal, id } = event.command;
        if (outcome.outcome === 'rejected' || outcome.outcome === 'unsupported-capability') {
          // Stored as a copy: the returned outcome is the caller's to keep.
          nestedSet(refusals, principal, id, {
            command: event.command,
            outcome: structuredClone(outcome),
            refusedAt: event.now,
          });
        }
        // Accepted or refused alike: an exact retry of the submission must
        // be recognized whichever way the gate decided.
        if (event.submittedValue !== undefined && submitted !== undefined) {
          nestedSet(submitted, principal, id, structuredClone(event.submittedValue));
        }
        return outcome;
      }
      case 'refused': {
        const { principal, id, requestedValue } = event.command;
        nestedSet(refusals, principal, id, {
          command: event.command,
          outcome: structuredClone(event.outcome),
          refusedAt: event.now,
        });
        // A refusal decided after Bureau resolved the caller's selector keeps
        // that selector; one decided before resolution was logged exactly as
        // submitted, so a `policyRef` in it is what an exact retry must match,
        // even in a process that could now resolve that selector.
        if (submitted !== undefined && event.submittedValue !== undefined) {
          nestedSet(submitted, principal, id, structuredClone(event.submittedValue));
        } else if (
          submitted !== undefined &&
          'policyRef' in requestedValue &&
          requestedValue.policyRef !== undefined
        ) {
          nestedSet(submitted, principal, id, structuredClone(requestedValue));
        }
        return structuredClone(event.outcome);
      }
      case 'applied':
        // A run observes only versions the fold so far made visible to it:
        // not later ones, and not another run's run-scoped ones. Anything
        // above that is corruption, never a floor.
        if (
          event.configVersion > gate.getRunVisibleVersion(event.runId) ||
          // Nor below what it can report at all: a boundary reports a
          // version only once there is one, and never below the version
          // the run started at.
          event.configVersion < Math.max(1, gate.getRunBaseline(event.runId))
        ) {
          throw new SteeringLogCorruptError(
            `Steering log for session "${gate.sessionId}" records run "${event.runId}" applying version ${String(event.configVersion)}, which no admission before it issued to that run.`,
          );
        }
        gate.recordApplied(event.runId, event.configVersion, event.now);
        return undefined;
      case 'promoted':
        gate.promoteForNewRun(event.runId, event.now);
        return undefined;
      case 'run-ended':
        gate.failAcceptedForRun(event.runId, event.now);
        return undefined;
    }
  }

  function createSteeringFoldHistory(): SteeringFoldHistory {
    return { runs: new Map(), keys: new Set() };
  }

  /**
   * Fails closed on history no process could have logged. A run is promoted
   * once, observes versions (`applied`) only while promoted, and ends once
   * after its promotion. A key is decided once: its binding is written in
   * the same atomic batch as its decision, conditioned on there being none.
   * Folding anything else would fail, apply, or release real commands for
   * a run that never existed or already ended, or answer one key two ways.
   */
  function checkSteeringHistory(
    sessionId: string,
    history: SteeringFoldHistory,
    event: SteeringLogEvent,
  ): void {
    const corrupt = (what: string) =>
      new SteeringLogCorruptError(`Steering log for session "${sessionId}" records ${what}.`);
    if (event.type === 'admit' || event.type === 'refused') {
      const key = JSON.stringify([event.command.principal, event.command.id]);
      if (history.keys.has(key)) {
        throw corrupt(
          `a second decision for steering key "${event.command.principal}"/"${event.command.id}"`,
        );
      }
      history.keys.add(key);
      return;
    }
    const stage = history.runs.get(event.runId);
    if (event.type === 'promoted') {
      if (stage !== undefined) throw corrupt(`run "${event.runId}" promoted again`);
      history.runs.set(event.runId, 'promoted');
      return;
    }
    if (stage !== 'promoted') {
      const verb = event.type === 'applied' ? 'applying a version' : 'ending';
      throw corrupt(
        `run "${event.runId}" ${verb} ${stage === 'ended' ? 'after it ended' : 'without a promotion'}`,
      );
    }
    if (event.type === 'run-ended') history.runs.set(event.runId, 'ended');
  }

  /** Applies a logged event to a cursor's gate and its launch markers. */
  function applyToCursor(
    cursor: SteeringCursor,
    event: SteeringLogEvent,
  ): SteeringCommandAdmissionOutcome | undefined {
    if (event.type === 'promoted') cursor.starting.set(event.runId, event.now);
    if (event.type === 'run-ended') cursor.starting.delete(event.runId);
    return applySteeringEvent(
      cursor.gate,
      cursor.refusals,
      event,
      cursor.submitted,
      cursor.history,
    );
  }

  function nestedSet<T>(
    map: Map<string, Map<string, T>>,
    outer: string,
    inner: string,
    value: T,
  ): void {
    let byInner = map.get(outer);
    if (byInner === undefined) {
      byInner = new Map();
      map.set(outer, byInner);
    }
    byInner.set(inner, value);
  }

  /**
   * A retry of an accepted command, re-expressed as the command it retries
   * when it repeats the caller's original submission exactly (a `policyRef`
   * Bureau resolved at admission). Resolving the retry again could pick a
   * different coordinate, or fail, after the policy or catalog changed;
   * matching the submission keeps the retry an exact replay.
   */
  function asSubmittedRetry(
    ledger: ReturnType<typeof createSteeringCommandLedger>,
    refusals: Map<string, Map<string, SteeringRefusal>>,
    submitted: Map<string, Map<string, SteeringRequestedValue>>,
    command: ImplementedSteeringCommand,
    rawSubmission: SteeringRequestedValue = command.requestedValue,
  ): ImplementedSteeringCommand {
    const original = submitted.get(command.principal)?.get(command.id);
    if (original === undefined) return command;
    const decided =
      getSteeringLedgerEntry(ledger, command.principal, command.id)?.requestedValue ??
      refusals.get(command.principal)?.get(command.id)?.command.requestedValue;
    if (decided === undefined) return command;
    // Compared against what the caller sent, never against a value resolved
    // afresh: a changed policy must not turn an exact retry into a conflict.
    const asked = rawSubmission as Record<string, unknown>;
    const first = original as Record<string, unknown>;
    const same =
      asked['target'] === first['target'] &&
      asked['override'] === first['override'] &&
      asked['provider'] === first['provider'] &&
      asked['policyRef'] === first['policyRef'];
    return same ? { ...command, requestedValue: decided } : command;
  }

  /**
   * Folds every entry this process has not yet applied into the session's
   * gate. The fold starts over — a fresh gate and ledger, from entry one —
   * only when the session's incarnation changed (deleted and recreated).
   * The cursor advances per entry, so a failure partway through never
   * re-applies what was already applied.
   */
  async function catchUpSteering(
    kv: ConditionalTextValueStore,
    sessionId: string,
    incarnation: string,
  ): Promise<SteeringCursor> {
    let cursor = steeringCursors.get(sessionId);
    if (cursor !== undefined && cursor.incarnation !== incarnation) {
      // The cursor is replaced only for the session's current incarnation.
      // A request for one since deleted (a boundary or poll queued before a
      // recreation) must not discard the cursor and gate the new
      // incarnation's runs read.
      const current = await runtime.sessionStore?.load(sessionId);
      if (current?.incarnation !== incarnation) {
        throw new BureauError(
          `Session "${sessionId}" no longer has incarnation "${incarnation}".`,
          'CONFLICT',
        );
      }
      forgetSessionSteering(sessionId);
      cursor = undefined;
    }
    // Live runs hold this cursor's gate, so it is never replaced while its
    // incarnation lives — only re-registered if something unmapped it.
    if (cursor !== undefined && steeringGates.get(sessionId) !== cursor.gate) {
      steeringGates.set(sessionId, cursor.gate);
    }
    if (cursor === undefined) {
      const ledger = createSteeringCommandLedger();
      const gate = createSteeringGate(sessionId, ledger, runtimeServices.clock);
      steeringGates.set(sessionId, gate);
      cursor = {
        incarnation,
        gate,
        ledger,
        refusals: new Map(),
        submitted: new Map(),
        starting: new Map(),
        history: createSteeringFoldHistory(),
        head: { raw: null, sequence: 0 },
        applied: 0,
      };
      steeringCursors.set(sessionId, cursor);
    }
    const head = await readSteeringLogHead(kv, sessionId, incarnation);
    if (head.sequence < cursor.applied) {
      // Shorter than what this process already folded: the log was deleted
      // with its session by another process, or lost entries. Nothing may be
      // appended to it, and the cursor is kept, so every later read of this
      // incarnation fails the same way rather than refolding a shortened log
      // from zero as if it were whole. A deletion is told apart by the
      // caller, which finds the incarnation gone; a recreated session has a
      // new incarnation, which resets the cursor above.
      throw new SteeringLogCorruptError(
        `Steering log for session "${sessionId}" is shorter than the ${String(cursor.applied)} entries already folded from it.`,
      );
    }
    const events = await readSteeringLogEntries(
      kv,
      sessionId,
      incarnation,
      cursor.applied,
      head.sequence,
    );
    for (const event of events) {
      applyToCursor(cursor, event);
      cursor.applied += 1;
    }
    cursor.head = head;
    return cursor;
  }

  /** How often a session with a live durable run here re-reads its log. */
  const STEERING_POLL_MS = 2_000;

  /** Polls already running, which shutdown awaits before storage closes. */
  const inFlightSteeringPolls = new Set<Promise<void>>();

  function pollSessionSteering(sessionId: string, incarnation: string, runId: string): void {
    const kv = durableSteeringStore();
    const gate = steeringCursors.get(sessionId)?.gate;
    if (kv === undefined || gate === undefined) return;
    const existing = steeringPollers.get(sessionId);
    if (existing !== undefined && existing.incarnation === incarnation && existing.gate === gate) {
      existing.runIds.add(runId);
      return;
    }
    if (existing !== undefined) {
      stopSessionSteeringPoll(sessionId);
      // A new incarnation replaced the one it polled: that one was deleted.
      // Its runs here settle as its own deletion poll would have settled
      // them: one not paused is aborted, and the paused ones are released.
      if (existing.incarnation !== incarnation) {
        for (const displacedRunId of existing.runIds) {
          if (!existing.gate.forRun(displacedRunId).getDesiredState().paused) {
            abortRun(displacedRunId);
          }
        }
        existing.gate.settleForDeletion(runtimeServices.clock.nowISO());
      }
    }
    const timer = runtimeServices.timers.setInterval(() => {
      // One poll per session at a time: a slow backend skips ticks instead
      // of stacking reads behind one another.
      const current = steeringPollers.get(sessionId);
      if (current === undefined || current.inFlight !== undefined) return;
      const poll = pollSteeringOnce(kv, sessionId);
      current.inFlight = poll;
      inFlightSteeringPolls.add(poll);
      void poll.finally(() => {
        inFlightSteeringPolls.delete(poll);
        current.inFlight = undefined;
      });
    }, STEERING_POLL_MS);
    steeringPollers.set(sessionId, { incarnation, gate, runIds: new Set([runId]), timer });
  }

  async function pollSteeringOnce(kv: ConditionalTextValueStore, sessionId: string): Promise<void> {
    const poller = steeringPollers.get(sessionId);
    if (poller === undefined) return;
    try {
      const current = await runtime.sessionStore?.load(sessionId);
      if (current?.incarnation !== poller.incarnation) {
        // Deleted, or recreated, by another process. This process's runs of
        // it settle as a local deletion settles them: a run not paused is
        // aborted, and a paused one is released, since nothing can resume
        // it any more. Both finish without recreating the session: their
        // terminal saves are fenced to its incarnation.
        if (steeringPollers.get(sessionId) === poller) stopSessionSteeringPoll(sessionId);
        for (const runId of poller.runIds) {
          if (!poller.gate.forRun(runId).getDesiredState().paused) abortRun(runId);
        }
        poller.gate.settleForDeletion(runtimeServices.clock.nowISO());
        return;
      }
      // Replaced while this poll read the session (deleted and recreated,
      // with a new run polling it): folding the old incarnation now would
      // replace the new cursor and gate the recreated run reads.
      await enqueueSteering(sessionId, async () => {
        if (steeringPollers.get(sessionId) !== poller) return;
        await catchUpSteering(kv, sessionId, poller.incarnation);
      });
      poller.lastFailure = undefined;
    } catch (error) {
      const failure = serializeUnknownError(error);
      if (failure === poller.lastFailure) return;
      poller.lastFailure = failure;
      diagnose({
        level: 'warn',
        scope: 'steering',
        message: `[bureau] Could not read steering for session "${sessionId}"; its runs here will see commands from other processes once it can be read: ${failure}`,
      });
    }
  }

  /** Stops polling for `runId`, and for the session once no run is left. */
  function releaseSessionSteeringPoll(sessionId: string, runId: string): void {
    const poller = steeringPollers.get(sessionId);
    if (poller === undefined) return;
    poller.runIds.delete(runId);
    if (poller.runIds.size === 0) stopSessionSteeringPoll(sessionId);
  }

  function stopSessionSteeringPoll(sessionId: string): void {
    const poller = steeringPollers.get(sessionId);
    if (poller === undefined) return;
    runtimeServices.timers.clearInterval(poller.timer);
    steeringPollers.delete(sessionId);
  }

  /** Drops this process's folded view of a session. */
  function forgetSessionSteering(sessionId: string): void {
    const cursor = steeringCursors.get(sessionId);
    if (cursor !== undefined && steeringGates.get(sessionId) === cursor.gate) {
      steeringGates.delete(sessionId);
    }
    steeringCursors.delete(sessionId);
  }

  /**
   * Appends a non-admission event after catching up, then applies it. Every
   * non-admission change to a durable gate goes through here, so the local
   * gate only ever changes in log order.
   */
  async function appendThenApplySteering(
    kv: ConditionalTextValueStore,
    sessionId: string,
    incarnation: string,
    event: Exclude<SteeringLogEvent, { type: 'admit' | 'refused' }>,
  ): Promise<void> {
    for (let attempt = 0; attempt < STEERING_APPEND_ATTEMPTS; attempt += 1) {
      const cursor = await catchUpSteering(kv, sessionId, incarnation);
      // Refused before it is written, never after: history no process could
      // log (a run's boundary outside its promotion, a version this gate
      // never issued) would leave the log unfoldable everywhere.
      if (event.type === 'promoted' && cursor.history.runs.has(event.runId)) {
        throw new BureauError(
          `Run "${event.runId}" is already in the steering log of session "${sessionId}"; a run is promoted once.`,
          'CONFLICT',
        );
      }
      // Another process ended the run first: one that adopted it after this
      // process lost it, or ended its own view of it at the same moment. The
      // log has settled the run, so this process's later boundary for it
      // has nothing to record, and logging it would make the log unfoldable.
      if (event.type !== 'promoted' && cursor.history.runs.get(event.runId) === 'ended') return;
      if (event.type !== 'promoted' && cursor.history.runs.get(event.runId) !== 'promoted') {
        throw new BureauError(
          `Run "${event.runId}" cannot log "${event.type}" in session "${sessionId}": the steering log has no live promotion of it.`,
          'CONFLICT',
        );
      }
      if (
        event.type === 'applied' &&
        (event.configVersion > cursor.gate.getRunVisibleVersion(event.runId) ||
          event.configVersion < Math.max(1, cursor.gate.getRunBaseline(event.runId)))
      ) {
        throw new BureauError(
          `Run "${event.runId}" cannot have applied steering version ${String(event.configVersion)}: session "${sessionId}" has made only ${String(cursor.gate.getRunVisibleVersion(event.runId))} visible to it.`,
          'CONFLICT',
        );
      }
      const appended = await appendSteeringLogEvent(kv, sessionId, incarnation, cursor.head, event);
      if (appended.status === 'appended') {
        applyToCursor(cursor, event);
        cursor.applied += 1;
        cursor.head = appended.head;
        return;
      }
    }
    throw steeringContention(sessionId);
  }

  /**
   * Logs a run-boundary event (a run observed a version, or ended) and
   * applies it once logged, in the session's queue. The run's own step does
   * not wait on it: per-run applied tracking lives in the run's state, so a
   * boundary event reaching the gate a moment later changes nothing the
   * run itself reads. If logging fails for good, the event is dropped (never
   * applied to a gate the log does not reflect) and a `steering` diagnostic
   * reports it.
   */
  function logRunBoundarySteering(
    sessionId: string,
    gate: BureauSteeringGate,
    event: Extract<SteeringLogEvent, { type: 'applied' | 'run-ended' }>,
  ): void {
    if (event.type === 'run-ended') {
      steeringRunIncarnations.delete(event.runId);
      releaseSessionSteeringPoll(sessionId, event.runId);
    }
    const kv = durableSteeringStore();
    const cursor = steeringCursors.get(sessionId);
    if (kv === undefined || cursor === undefined || cursor.gate !== gate) {
      // Non-durable, or a gate no longer folded from the log (its session
      // was deleted or recreated): apply directly, as an in-memory gate does.
      applySteeringEvent(gate, new Map(), event);
      return;
    }
    const { incarnation } = cursor;
    const appended = enqueueSteering(sessionId, () =>
      appendThenApplySteering(kv, sessionId, incarnation, event),
    );
    appended.catch((error: unknown) => {
      // Not applied locally: the gate must never hold state the log lacks,
      // or later admissions here would decide differently from every other
      // process. Nothing waits on it — an ended run's pause waiters are
      // released by the run's own abort — so the cost is a stale command
      // state, which the diagnostic reports.
      diagnose({
        level: 'error',
        scope: 'steering',
        message: `[bureau] Could not log a steering "${event.type}" event for run "${event.runId}" in session "${sessionId}": ${serializeUnknownError(error)}`,
      });
    });
    // COR-1476 — the `run-ended` entry is the durable write that makes the run
    // not live to every process reading `liveSessionRunIdsEverywhere`. The run's
    // session-input settlement awaits it, and retries it if it rejected, before
    // it reads the session's mailbox: the ordering that keeps an admitted input
    // from being left open.
    if (event.type === 'run-ended') steeringRunEndWrites.set(event.runId, appended);
  }

  /**
   * Folds a recovered durable run's session log and hands the run its view of
   * the gate, before replay resumes. A failure fails the recovered workflow
   * (the recovery hook rethrows), and is diagnosed.
   */
  async function recoverRunSteering(
    sessionId: string,
    session: AgentSession | undefined,
    runId: string,
    services: DurableRunDeps,
  ): Promise<BureauSteeringGate | undefined> {
    const kv = durableSteeringStore();
    if (kv === undefined || session === undefined) return undefined;
    try {
      const cursor = await enqueueSteering(sessionId, () =>
        catchUpSteering(kv, sessionId, session.incarnation),
      );
      // Ended in the log a moment before its workflow's terminal state was
      // committed (the process died in between): it has nothing left to
      // steer, and resumes without a gate rather than failing.
      if (cursor.history.runs.get(runId) === 'ended') return undefined;
      if (cursor.history.runs.get(runId) !== 'promoted') {
        // A run `createRun` started durably is tagged with its session
        // incarnation and promoted in its log before its workflow starts.
        // Tagged but not promoted, the log no longer describes it (missing,
        // emptied, or ended for it): resuming on a default gate would
        // silently drop its steering, so it fails. A workflow without the
        // tag was started elsewhere (catalog dispatch, a schedule) and never
        // had steering; it resumes without a gate, as it always has.
        const workflow = await runtime.durable?.engine.get(runId);
        if (
          workflow?.tags?.includes(steeringSessionRunTag(sessionId, session.incarnation)) !== true
        ) {
          return undefined;
        }
        throw new SteeringLogCorruptError(
          `Steering log for session "${sessionId}" has no live promotion of recovered run "${runId}".`,
        );
      }
      services.options = {
        ...services.options,
        runId,
        steering: cursor.gate.forRun(runId),
      };
      return cursor.gate;
    } catch (error) {
      // Fails the recovered workflow rather than resuming it without its
      // durable steering: the log is the only record of its desired model,
      // pause, and identity, and running on defaults would ignore them.
      diagnose({
        level: 'error',
        scope: 'steering',
        message: `[bureau] Recovered run "${runId}" cannot resume: its session's steering log could not be folded: ${serializeUnknownError(error)}`,
      });
      throw error;
    }
  }

  /**
   * Removes steering logs whose session incarnation no longer exists — left
   * behind when a process died after a session's deletion committed but
   * before its log was deleted. Safe across processes: a log is keyed by
   * incarnation, so a live session's log (any process's) is never touched,
   * and a session recreated under the same id has a different incarnation.
   */
  async function sweepOrphanedSteeringLogs(): Promise<void> {
    const kv = durableSteeringStore();
    const sessionStore = runtime.sessionStore;
    if (kv === undefined || sessionStore === undefined) return;
    for (const { sessionId, incarnation } of await listSteeringLogIncarnations(kv)) {
      const session = await sessionStore.load(sessionId);
      if (session?.incarnation === incarnation) continue;
      await enqueueSteering(sessionId, () => deleteSteeringLog(kv, sessionId, incarnation));
    }
  }
  let steeringSweep: Promise<void> = Promise.resolve();

  function steeringContention(sessionId: string): BureauError {
    return new BureauError(
      `Steering log for session "${sessionId}" kept moving under ${String(STEERING_APPEND_ATTEMPTS)} consecutive append attempts.`,
      'CONFLICT',
    );
  }
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
  // COR-1421 — `engine.recoverAll()` resumes recovered workflows without
  // awaiting them, so recovered runs emit live frames while the rest of boot
  // still awaits, before `createBureau()` returns and a caller can subscribe.
  // Until the FIRST `frames` listener attaches, frames are
  // therefore retained: every frame emitted while a recovery pass runs (no
  // per-run attribution, so anything the pass starts is covered), and after the
  // pass the frames of the runs it reattached. Ordinary runs outside a pass are
  // never retained. That listener is replayed the retained frames in emission order
  // and the buffer closes for good. Replaying rather than deferring the resume
  // keeps delivery independent of how many awaits the boot tail contains.
  // The buffer holds at most BOOT_FRAME_BUFFER_LIMIT frames and evicts the
  // OLDEST past that, so a late subscriber sees the most recent history; a
  // reconnecting client still gets the rest through durable event history.
  // Emitter listeners are NOT replayed: they register before recovery through
  // `BureauOptions.onEvent`.
  const BOOT_FRAME_BUFFER_LIMIT = 1024;
  let recoveryPassActive = false;
  /** The boot repair of task histories (COR-1669), which `shutdown()` awaits before storage closes. */
  let taskResyncBootPass: Promise<void> | undefined;

  let liveFramesSubscribed = false;
  // Frames emitted while the first subscriber is being replayed queue behind
  // the remaining replay instead of interleaving with it.
  let frameReplayQueue: ServerFrame[] | undefined;
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

  function nextRunSeq(runId: string): number {
    const next = (runSequenceCounters.get(runId) ?? 0) + 1;
    runSequenceCounters.set(runId, next);
    return next;
  }

  /**
   * AB-15: seeds `runSequenceCounters` for a run reattached by
   * `engine.recoverAll()` so a pre-restart client cursor cannot suppress
   * post-restart frames. `runSequenceCounters` is in-memory only and this
   * bureau instance's store is rebuilt fresh on every boot (`store.register`
   * in {@link reattachRecoveredRun} attaches to a brand-new `RunState`), so
   * without seeding, `nextRunSeq` would restart a recovered run's sequence
   * at 1 — and a browser reconnecting with a pre-restart cursor like
   * `since: 25` would have every post-restart frame (runSeq 1, 2, 3, ...)
   * filtered out by `getFramesSince`/`LiveFrameBroker`, silently losing
   * them instead of replaying them.
   *
   * Seeding from the current wall-clock time (rather than 0) guarantees the
   * new generation's sequence numbers are far larger than anything handed
   * out in a previous process's lifetime, so old cursors always compare as
   * "already behind" and every post-restart frame is delivered — at worst a
   * client sees a handful of frames it already had (harmless; frame
   * application in the UI stores is idempotent per-field, not a strict
   * just-once contract), never a silent gap.
   */
  function seedRunSeqGeneration(runId: string): void {
    runSequenceCounters.set(runId, runtimeServices.clock.now());
  }

  function getRunSessionIdentifier(runState: { activeRun: ActiveRun }): string {
    return runSessionIdentifiers.get(runState.activeRun) ?? '';
  }

  /**
   * Resolves when a run that reported `run.error` dispatches the `run.completed` (or `run.aborted`)
   * that ends it, or its result settles without one (an abandoned durable run).
   */
  function whenErroredRunEnds(activeRun: ActiveRun): Promise<void> {
    return Promise.race([
      new Promise<void>((resolve) => {
        activeRun.once('run.completed', () => resolve());
        activeRun.once('run.aborted', () => resolve());
      }),
      activeRun.result.then(
        () => undefined,
        () => undefined,
      ),
    ]);
  }

  /**
   * Resolves once `activeRun` reaches ITS OWN terminal event — mirrors the
   * exact `run.completed` / `run.aborted` / `run.error` contract gateway
   * already wires (`run-lifecycle.ts`'s module doc), so a fourth listener
   * here observes the same terminal moment as every other terminal-run
   * consumer in this file. Only safe to call for an `activeRun` known NOT
   * to have already settled (callers check `activeRuns.has(...)` or
   * `runState.status === 'running'` first) — `once()` ties the listener to
   * `activeRun`'s own completion signal, which an already-terminal run has
   * already aborted, silently dropping a listener registered after the
   * fact per DOM `addEventListener` semantics.
   */
  function whenActiveRunTerminal(activeRun: ActiveRun): Promise<void> {
    return new Promise<void>((resolve) => {
      const settle = () => resolve();
      activeRun.once('run.completed', settle);
      activeRun.once('run.aborted', settle);
      activeRun.once('run.error', settle);
    });
  }

  function emitLiveFrame(frame: ServerFrame): void {
    // AB-96 codex review — a throwing `frames` listener must not
    // abort the caller. `emitLiveFrame` is invoked synchronously from run-setup
    // call sites (e.g. the `run-started` frame fires BEFORE `store.register` and
    // the terminal listeners are installed), so an unguarded throw here would
    // propagate out of `createRun`/`reattachRecoveredRun` and leave the run
    // launched-but-untracked: the session already persisted as `running`, the
    // `ActiveRun` already started, but never registered — stuck forever. Catch
    // and log per-listener instead, matching the isolation every other fan-out
    // in this file already gives its listeners (see `disposeRegisteredStreamListeners`
    // callers, `emitter.dispatch`).
    // Retained while a recovery pass runs (any frame: scheduled fires and
    // anything else the pass starts), and afterwards for the runs it reattached,
    // until the first subscriber. Frames of ordinary runs outside a pass are
    // never retained.
    if (
      !liveFramesSubscribed &&
      (recoveryPassActive || ('runId' in frame && bootFrameRunIds.has(frame.runId)))
    ) {
      bootFrameBuffer.push(frame);
      // Overflow evicts the oldest frame, keeping the most recent history.
      if (bootFrameBuffer.length > BOOT_FRAME_BUFFER_LIMIT) bootFrameBuffer.shift();
    }
    frameReplayQueue?.push(frame);
    for (const listener of liveFrameListeners) {
      deliverLiveFrame(listener, frame);
    }
  }

  function deliverLiveFrame(listener: (frame: ServerFrame) => void, frame: ServerFrame): void {
    try {
      listener(frame);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'live-frames',
        message: `[bureau] frames listener threw on a "${frame.type}" frame:`,
        cause: error,
      });
    }
  }

  /**
   * COR-1481 — the task registry behind `Bureau.tasks`. The host callbacks read
   * the run store and the catalog dispatcher lazily, at call time.
   */
  function liveTaskOf(taskId: string): LiveTask | undefined {
    const runState = store.getRun(taskId);
    if (runState !== undefined) {
      const summary = serializeRunState(
        runState,
        getRunSessionIdentifier(runState),
        runAttribution.get(taskId),
      );
      const stored = runState.status;
      const phase: LiveTask['phase'] =
        stored === 'running'
          ? abortingRunIds.has(taskId)
            ? 'aborting'
            : 'running'
          : stored === 'aborting'
            ? 'aborting'
            : stored;
      return {
        phase,
        finishReason: summary.finishReason,
        error: summary.error,
        updatedAt: runState.actions.at(-1)?.timestamp,
      };
    }
    return undefined;
  }

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
   * COR-1987 — keeps a task's pending wakeup on its record, so a reload can read it back: a
   * `schedule.wakeup` record sets it from the time the run announced, and the run parking on a
   * human wait clears it, because the run then waits for a person, not the clock. A wakeup that
   * has fired, or a run that ended, needs no write: the task's view shows a wakeup only while the
   * task is working and the time is still ahead.
   */
  function recordTaskWakeup(action: {
    readonly runId: string;
    readonly type: string;
    readonly detail: unknown;
  }): void {
    let wakeAt: number | null;
    if (action.type === 'schedule.wakeup') {
      const detail =
        action.detail !== null && typeof action.detail === 'object'
          ? (action.detail as Record<string, unknown>)
          : {};
      const announced = detail['wakeAt'];
      if (typeof announced !== 'number' || !Number.isFinite(announced)) return;
      wakeAt = announced;
    } else if (action.type === 'multiagent.human-wait.parked') {
      wakeAt = null;
    } else {
      return;
    }
    tasks.recordWakeup(action.runId, wakeAt).catch((error: unknown) => {
      diagnose({
        level: 'error',
        scope: 'task-registry',
        message: `[bureau] Could not record the wakeup of task "${action.runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    });
  }

  /** COR-1481 — records how a task ended, from the action that ended its run. */
  function recordTaskSettlement(action: {
    readonly runId: string;
    readonly type: string;
    readonly detail: unknown;
    readonly timestamp: number;
  }): void {
    // `run.error` is not a settlement of its own: Operative announces it before the
    // `run.completed` (or `run.aborted`) that ends the run and carries its finish reason, so
    // the one write comes from that. A `run.error` with no such end is another process's, which
    // `isCommittedElsewhere` keeps from reaching here.
    if (action.type !== 'run.completed' && action.type !== 'run.aborted') {
      return;
    }
    const detail =
      action.detail !== null && typeof action.detail === 'object'
        ? (action.detail as Record<string, unknown>)
        : {};
    const finishReason =
      typeof detail['finishReason'] === 'string' ? detail['finishReason'] : undefined;
    const status =
      action.type === 'run.completed' ? settledTaskState('completed', finishReason) : 'canceled';
    const failure = detail['error'];
    // Every cancellation terminal, a shutdown's abort included, follows its run's cleanup the
    // way an API cancellation does, so the task reports what the cleanup actually did.
    if (status === 'canceled') {
      const activeRun = store.getRun(action.runId)?.activeRun;
      if (activeRun !== undefined) void tasks.watchCleanup(action.runId, activeRun.closed());
    }
    void tasks
      .recordSettled(action.runId, {
        at: new Date(action.timestamp).toISOString(),
        status,
        finishReason: finishReason ?? (status === 'canceled' ? 'aborted' : null),
        message:
          status === 'failed' && failure !== undefined && failure !== null
            ? serializeUnknownError(failure).slice(0, 1000)
            : null,
      })
      .catch((error: unknown) => {
        diagnose({
          level: 'error',
          scope: 'task-registry',
          message: `[bureau] Could not record how task "${action.runId}" ended: ${serializeUnknownError(error)}`,
          cause: error,
        });
      });
  }

  /**
   * Announces one review once (`review.requested`), however many times its run reports it.
   * COR-1596: a schedule fire is not on the store, so its reviews are announced from where they
   * are registered, not from the store's action stream.
   */
  /**
   * COR-1613 — what a fire's durable history already says of its reviews, read once per run per
   * process: the ids requested, and the ids since closed. A process that replays a step finds the
   * dead one's requests here, which its own memory cannot hold.
   */
  async function readFireReviewHistory(runId: string): Promise<{
    requested: Set<string>;
    closed: Set<string>;
    /**
     * COR-1622 — the requests whose current round no decision has ended, by review id: the
     * candidates a canceled fire's boot repairs. A review's round advances only on a
     * `review.superseded` paired with that round's decision (a re-gate records the supersession,
     * then the decision of the round it leaves). A supersession with no decision after it ends the
     * request, as `closeAbandonedFireRequests` writes for a request a crashed attempt abandoned. A
     * request whose current round has a terminal event other than `review.canceled` is closed. A
     * lone `review.canceled` stays a candidate, flagged, because its audit half may be missing.
     */
    open: Map<string, { readonly round: number; readonly canceled: boolean }>;
  }> {
    const requested = new Set<string>();
    const closed = new Set<string>();
    const rounds = new Map<
      string,
      {
        round: number;
        decided: boolean;
        awaitingDecision: boolean;
        ended: boolean;
        canceled: boolean;
      }
    >();
    const open = new Map<string, { readonly round: number; readonly canceled: boolean }>();
    if (eventHistoryInstance === undefined) return { requested, closed, open };
    // The events this process dispatched are written asynchronously: wait for them first.
    await durableEventProducerInstance?.waitForActiveWrites({ kind: 'run', id: runId });
    let since: string | undefined;
    for (;;) {
      const page = await eventHistoryInstance.page(
        { kind: 'run', id: runId },
        { limit: 500, ...(since === undefined ? {} : { since }) },
      );
      if (!('events' in page)) break;
      for (const event of page.events) {
        const reviewId = (event.payload as { reviewId?: unknown } | null)?.reviewId;
        if (typeof reviewId !== 'string') continue;
        const state = rounds.get(reviewId) ?? {
          round: 0,
          decided: false,
          awaitingDecision: false,
          ended: false,
          canceled: false,
        };
        rounds.set(reviewId, state);
        if (event.kind === 'review.requested') requested.add(reviewId);
        else if (event.kind === 'review.canceled') {
          closed.add(reviewId);
          state.canceled = true;
        } else if (REVIEW_CLOSING_EVENT_KINDS.has(event.kind)) {
          closed.add(reviewId);
          if (state.awaitingDecision) {
            // The decision of the round a re-gate left: the next round is now the current one.
            state.round += 1;
            state.awaitingDecision = false;
            state.decided = false;
            state.canceled = false;
          } else {
            state.decided = true;
          }
        } else if (event.kind === REVIEW_SUPERSEDED_EVENT_KIND) {
          closed.add(reviewId);
          // A second supersession with no decision between them leaves the first one lone.
          if (state.awaitingDecision) state.ended = true;
          state.awaitingDecision = true;
        }
      }
      if (!page.hasMore || page.nextCursor === undefined) break;
      since = page.nextCursor;
    }
    for (const reviewId of requested) {
      const state = rounds.get(reviewId);
      if (state === undefined || state.ended || state.awaitingDecision || state.decided) continue;
      open.set(reviewId, { round: state.round, canceled: state.canceled });
    }
    return { requested, closed, open };
  }

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

  /** A review of the fire is held here, announced or restored: follow its history. */
  function followFireReviews(runId: string): void {
    fireReviewFollower?.follow(runId);
  }

  /** The fire's last review here was released: stop following its history. */
  function unfollowFireReviewsWhenNoneRemain(runId: string): void {
    if (holdsFireApproval(runId) || runHumanWaits.holds(runId)) return;
    fireReviewFollower?.unfollow(runId);
  }

  /**
   * COR-1613 — announces a fire's review once across processes. A replay that makes the same call
   * under the same id finds the dead process's request in the history and does not announce it
   * again; the in-memory set alone is lost with the process.
   */
  async function announceFireReview(
    runId: string,
    reviewId: string,
    kind: 'human-wait' | 'tool-approval',
    target: { signalName?: string; callId?: string },
  ): Promise<void> {
    followFireReviews(runId);
    // The request is announced after the read of what the history already says, and a close
    // written meanwhile waits for the same read (`fireReviewSeeds.pending`), so it follows the request.
    await fireReviewSeeds.ensure(runId);
    announceReview(runId, reviewId, kind, target);
  }

  /**
   * COR-1613 — closes, with `review.superseded`, each request a fire's history holds that its
   * checkpoint never committed and nothing closed: the request of an attempt that died between
   * announcing it and committing its step, whose replay made the call under another id. A review
   * the run still owns, or already closed, is left alone.
   */
  async function closeAbandonedFireRequests(runId: string): Promise<void> {
    const durable = runtime.durable;
    if (durable === undefined || eventHistoryInstance === undefined) return;
    await fireReviewSeeds.pending(runId);
    const history = await readFireReviewHistory(runId);
    const committed = committedFireReviewIds(
      runId,
      await durable.checkpointStore.loadSteps(runId, { strict: true }),
    );
    for (const reviewId of history.requested) {
      if (history.closed.has(reviewId) || committed.has(reviewId)) continue;
      const kind = reviewId.startsWith('human-wait:') ? 'human-wait' : 'tool-approval';
      emitter.dispatch(
        new ReviewSupersededEvent(reviewId, runId, REPLAY_SUPERSEDING_PRINCIPAL, kind),
      );
    }
  }

  function announceReview(
    runId: string,
    reviewId: string,
    kind: 'human-wait' | 'tool-approval',
    target: { signalName?: string; callId?: string },
  ): void {
    const announced = announcedReviewRequests.get(runId) ?? new Set<string>();
    announcedReviewRequests.set(runId, announced);
    if (announced.has(reviewId)) return;
    announced.add(reviewId);
    if (kind === 'tool-approval') ensureLazyExpirySweep();
    const owner = runAttribution.get(runId)?.principal ?? ANONYMOUS_LOCAL_OWNER;
    emitter.dispatch(new ReviewRequestedEvent(reviewId, runId, owner, kind, target));
    // COR-1754 — a park changes the task's view (it now waits on its requester) without writing
    // its record, so whoever waits on the task is told here, the one place a park is noticed.
    detachBestEffortPromise(tasks.announceChanged(runId));
  }

  /**
   * COR-1622 — whether the Bureau's own maintenance timer runs, and so sweeps expired reviews: the
   * same rule that starts it below. A Bureau without one (no durable engine, memory or audit
   * retention to drive) would never expire an approval it holds, so it keeps a timer of its own
   * for as long as it holds one. A `'manual'` host drives the sweep with `maintain`.
   */
  function automaticMaintenanceRuns(): boolean {
    const auditRetention = currentSettings()['retention.audit'];
    return (
      needsAutomaticMaintenance({
        durableEngine: Boolean(runtime.durable),
        memory: runtime.memory !== undefined,
        keyValueStore: Boolean(runtime.kv),
        activeAuditRetention: auditRetention !== undefined && auditRetention !== 'forever',
        activeNotificationRetention: currentSettings()['retention.notifications'] !== undefined,
        activeHookDeliveryRetention: currentSettings()['retention.hookDeliveries'] !== undefined,
      }) && options.maintenance !== 'manual'
    );
  }

  /**
   * Whether this process holds a tool approval, of a live run or a restored one, counting an
   * approval whose binding has run out and that no sweep has yet released (which
   * `listPendingReviews` leaves out) and one whose resolution is in flight (not yet recorded as
   * resolved). The sweep's timer stops when this is false and not before.
   */
  function holdsToolApproval(): boolean {
    const leftOrInvalid = (id: string): boolean =>
      resolvedReviewIds.has(id) || invalidApprovalReviewIds.has(id);
    for (const [runId, runState] of store.getState().runs) {
      if (catalogRunIds.has(runId)) continue;
      for (const step of runState.steps) {
        for (const result of step.results) {
          if (result.outcome !== 'action_required' || !result.pendingApproval) continue;
          if (!leftOrInvalid(`approval:${runId}:${result.pendingApproval.callId}`)) return true;
        }
      }
    }
    for (const id of pendingApprovalOverrides.keys()) if (!leftOrInvalid(id)) return true;
    return false;
  }

  /** The check every approval's leaving makes: with none held, the sweep's timer is not needed. */
  function stopLazyExpirySweepWhenNoneHeld(): void {
    if (lazyExpirySweepArmed && !holdsToolApproval()) stopLazyExpirySweep();
  }

  function stopLazyExpirySweep(): void {
    if (!lazyExpirySweepArmed) return;
    runtimeServices.timers.clearInterval(lazyExpirySweepTimer);
    lazyExpirySweepArmed = false;
  }

  /**
   * COR-1622 — arms the expiry sweep's own timer when this Bureau holds a tool approval and no
   * other timer sweeps for it. It stops itself on the first tick that finds none held, so an idle
   * process is never kept alive by it, and `shutdown` clears it.
   */
  function ensureLazyExpirySweep(): void {
    if (
      lazyExpirySweepArmed ||
      automaticRunOwnershipPruneTimerStarted ||
      automaticMaintenanceRuns()
    )
      return;
    if (options.maintenance === 'manual' || maintenanceAdmissionClosed) return;
    lazyExpirySweepArmed = true;
    lazyExpirySweepTimer = runtimeServices.timers.setInterval(() => {
      if (lazyExpirySweepPass !== undefined) return;
      const pass = (async () => {
        try {
          await sweepExpiredReviews();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Expired-review sweep failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        stopLazyExpirySweepWhenNoneHeld();
      })().finally(() => {
        lazyExpirySweepPass = undefined;
      });
      lazyExpirySweepPass = pass;
      detachBestEffortPromise(pass);
    }, EXPIRY_SWEEP_INTERVAL_MILLISECONDS);
  }

  /**
   * Announces a review becoming pending (`review.requested`), from the action that
   * created it: a human-wait park, or a step that ended with a tool call awaiting
   * approval. Reviews are derived from run state on read and have no event of their
   * own; this is the one place that notices the moment one appears. The id is the
   * id `listPendingReviews` mints for the same review. A park that recovery
   * reconstructs (it carries a seeded `parkOrdinal`) happened in an earlier
   * process, which announced it, so it is not announced again.
   */
  function announceReviewRequests(action: {
    readonly runId: string;
    readonly type: string;
    readonly detail: unknown;
  }): void {
    const detail =
      action.detail !== null && typeof action.detail === 'object'
        ? (action.detail as Record<string, unknown>)
        : undefined;
    const announce = (
      reviewId: string,
      kind: 'human-wait' | 'tool-approval',
      target: { signalName?: string; callId?: string },
    ): void => announceReview(action.runId, reviewId, kind, target);
    if (action.type === HumanWaitParkedEvent.type) {
      const signalName = detail?.['signalName'];
      const runState = store.getRun(action.runId);
      if (typeof signalName !== 'string' || signalName.length === 0 || runState === undefined) {
        return;
      }
      if (typeof detail?.['parkOrdinal'] === 'number') return;
      const ordinal = humanWaitParkOrdinal(action.runId, runState.actions);
      announce(`human-wait:${action.runId}:${signalName}:${ordinal}`, 'human-wait', { signalName });
      return;
    }
    if (action.type === 'step.completed' && Array.isArray(detail?.['results'])) {
      for (const result of detail['results'] as readonly unknown[]) {
        if (result === null || typeof result !== 'object') continue;
        const { outcome, pendingApproval } = result as {
          outcome?: unknown;
          pendingApproval?: { callId?: unknown };
        };
        const callId = pendingApproval?.callId;
        if (outcome !== 'action_required' || typeof callId !== 'string') continue;
        announce(`approval:${action.runId}:${callId}`, 'tool-approval', { callId });
      }
    }
  }

  /** A store action as the live `event` frame streams read. */
  function emitActionFrame(action: StoreActionEvent['action']): void {
    emitLiveFrame({
      type: 'event',
      runId: action.runId,
      event: action.type,
      detail: serializeActionDetail(action.type, action.detail),
      sequence: action.sequence,
      runSeq: nextRunSeq(action.runId),
      timestamp: action.timestamp,
    });
  }

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

  function requireSessionStore(): SessionStore {
    if (!runtime.sessionStore) {
      throw new BureauError(
        'No SessionStore configured (set options.storage)',
        'NOT_CONFIGURED',
        'persistence',
      );
    }
    return runtime.sessionStore;
  }

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
   * The run's `costBudget` with the chat's spend so far (COR-1915), or `undefined` when the agent
   * limits no chat. A chat with no session yet has spent nothing.
   */
  async function chatCostBudgetOf(
    sessionAgent: SessionAgentRun,
    sessionId: string,
    session: { readonly incarnation?: string | undefined } | undefined,
  ): Promise<NonNullable<RunOptions['costBudget']> | undefined> {
    const budget = sessionAgent?.options.costBudget;
    if (budget?.perChatUsd === undefined) return undefined;
    let spent = 0;
    if (session?.incarnation !== undefined) {
      try {
        spent = await chatSpendLedger.totalOf(sessionId, session.incarnation);
      } catch (error) {
        // COR-1933 — a typed refusal, not the store's own error: the caller branches on the code.
        diagnose({
          level: 'error',
          scope: 'chat-spend',
          message: `[bureau] Could not read the spend of chat "${sessionId}": ${serializeUnknownError(error)}`,
          cause: error,
        });
        throw new BureauError(
          `The spend of chat "${sessionId}" could not be read, so its run was not started: ${serializeUnknownError(error)}`,
          'STORAGE_UNAVAILABLE',
        );
      }
    }
    return { ...budget, priorChatSpendUsd: spent };
  }

  /**
   * Writes a chat run's spend to the chat's ledger (COR-1915), before the session records how the
   * run ended (COR-1933): a crash in between then leaves a session that still says `running`, which
   * recovery reattaches and replays into a ledger that already holds the record. A run with no
   * price on its requests spent nothing the ledger can count. The ledger writes a run's record
   * once, so a terminal event a recovery replays records nothing more, and a write that fails is
   * diagnosed by the ledger and never fails the run's settlement.
   */
  async function recordChatRunSpend(
    runId: string,
    sessionId: string,
    incarnation: string | undefined,
    spend: ChatRunSpend | undefined,
  ): Promise<void> {
    const usd = spend?.costEstimate?.totalCost;
    if (spend === undefined || usd === undefined || !Number.isFinite(usd) || usd <= 0) return;
    if (incarnation === undefined) return;
    try {
      const written = await chatSpendLedger.record({
        sessionId,
        incarnation,
        runId,
        agentName: spend.agentName,
        owner: spend.owner,
        usd,
        recordedAt: runtimeServices.clock.nowISO(),
      });
      // COR-1933 — a chat deleted while this run ran has had its records forgotten already, so
      // the one just written would stay behind. Checked AFTER the write: either the deletion
      // committed before this read and the record is removed here, or after it, and the
      // deletion's own `forget` runs after the write and removes it.
      if (written && runtime.sessionStore) {
        const session = await runtime.sessionStore.load(sessionId);
        if (session?.incarnation !== incarnation) {
          await chatSpendLedger.forget(sessionId, incarnation);
        }
      }
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'chat-spend',
        message: `[bureau] Could not record the spend of run "${runId}" in chat "${sessionId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  /**
   * Persists a run's terminal session state, then settles the session's input
   * (COR-1476): the settlement reads the session as the run left it.
   */
  function persistTerminalSession(
    saveSessionUpdate: () => Promise<unknown>,
    context: {
      runId: string;
      sessionId: string;
      status: 'completed' | 'error' | 'aborted';
      /** What the run spent, for the chat's ledger (COR-1915); written before the session's save. */
      spend?: ChatRunSpend;
    },
  ): void {
    // The incarnation is read now, with the terminal event, and not after the save: the map that
    // holds it is dropped when the run's records are, which can be before the save finishes.
    const spentIn = runSessionIncarnations.get(context.runId);
    // The spend is recorded BEFORE the session's end record (COR-1933), inside the tracked save,
    // so `drain()` waits for both and a crash between them is repaired by recovery's replay.
    // `recordChatRunSpend` never rejects, and a save retry finds the record already written.
    const spendRecorded = recordChatRunSpend(
      context.runId,
      context.sessionId,
      spentIn,
      context.spend,
    );
    const recorded = persistSessionUpdate(async () => {
      await spendRecorded;
      return saveSessionUpdate();
    }, context).then(() => settleSessionInputsAfterRunEnd(context.sessionId, context.runId));
    const settler = terminalSessionRecordSettlers.get(context.runId);
    terminalSessionRecordSettlers.delete(context.runId);
    if (settler !== undefined) {
      recorded.then(settler.resolve, settler.reject);
    } else {
      // A run nobody told us to expect: its record is this save.
      terminalSessionRecords.set(context.runId, recorded);
      void recorded
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          if (terminalSessionRecords.get(context.runId) === recorded) {
            terminalSessionRecords.delete(context.runId);
          }
        });
    }
    trackSessionInputSettlement(recorded);
  }

  /**
   * Makes `whenRunRecorded(runId)` wait from now on, until the run's terminal save has finished,
   * even when it is asked before the run has reached its end. A durable terminal event can reach a
   * reader before this process's own run listener has started the save.
   */
  function expectTerminalSessionRecord(runId: string): void {
    if (terminalSessionRecords.has(runId)) return;
    const record = Promise.withResolvers<void>();
    terminalSessionRecords.set(runId, record.promise);
    terminalSessionRecordSettlers.set(runId, { resolve: record.resolve, reject: record.reject });
    void record.promise
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (terminalSessionRecords.get(runId) === record.promise) {
          terminalSessionRecords.delete(runId);
        }
      });
  }

  /**
   * A run that is over without its terminal save ever starting: the engine lost a checkpoint
   * compare-and-swap, or was disposed, and abandoned the run to whoever owns it
   * (`driveDurableRun`), so no terminal listener ran. Whoever waits on its record is told it will
   * not come. Rejecting writes nothing, which the abandoned path requires: another engine over the
   * same store may own the run's outcome and records it itself. A run whose save did start has no
   * settler left, so this does nothing for it.
   */
  function abandonTerminalSessionRecord(runId: string): void {
    const settler = terminalSessionRecordSettlers.get(runId);
    if (settler === undefined) return;
    terminalSessionRecordSettlers.delete(runId);
    settler.reject(new TerminalSessionRecordAbandonedError(runId));
  }

  /**
   * Resolves once the session has recorded the end of `runId`, however long its save takes, and
   * at once for a run whose end is already recorded or is not this process's.
   *
   * Rejects with `TerminalSessionRecordAbandonedError` when the run ended without this process
   * saving its end: the engine lost a checkpoint compare-and-swap, or was disposed, and abandoned
   * the run to whoever owns it, or the Bureau shut down before the save began. It settles with the
   * run's result in those cases, never with a deadline. A save that starts and keeps failing does
   * not reject: it is diagnosed after its last attempt and resolves, so a reader should check that
   * the session holds what it needs. A reader in another process can read a session that does not
   * yet hold the run's final rows, because this resolves at once for a run it does not hold.
   */
  async function whenRunRecorded(runId: string): Promise<void> {
    await terminalSessionRecords.get(runId);
  }

  /**
   * The identifiers of the rows (conversation messages) `runId` itself took session input into, in
   * delivery order. Read from the durable delivery record, which commits with the transcript the
   * run saved, so it is the same answer before and after the session records the run's end. A
   * Bureau with no session mailbox delivered none.
   */
  async function sessionInputsDeliveredBy(
    runId: string,
    sessionId: string,
  ): Promise<readonly string[]> {
    if (sessionInputDeliveryStore === undefined) return [];
    const records = await sessionInputDeliveryStore.read(sessionId);
    return Object.values(records)
      .filter((record) => record.runId === runId && record.promotion !== undefined)
      .toSorted(
        (left, right) => (left.promotion?.providerTurn ?? 0) - (right.promotion?.providerTurn ?? 0),
      )
      .flatMap((record) =>
        record.promotion === undefined ? [] : [record.promotion.conversationMessageId],
      );
  }

  /** Resolves once every run-end session-input settlement already started has finished. */
  async function drainSessionInputSettlements(): Promise<void> {
    while (inFlightSessionInputSettlements.size > 0) {
      await Promise.allSettled(inFlightSessionInputSettlements);
    }
  }

  /**
   * COR-718 — a run's terminal save, pinned to the session incarnation the run
   * started in (`runSessionIncarnations`, recorded by its first save and restored
   * on recovery), whether or not durable steering is composed. The session may
   * have expired and been recreated under another owner while the run ran, and a
   * save that is not pinned would write the run's prompt and reply into that
   * owner's session. A run with no recorded incarnation never started in any
   * session this Bureau still knows, so its save goes nowhere.
   */
  function saveRunTerminalSession(
    runId: string,
    sessionId: string,
    conversation: Conversation,
    metadata: Record<string, JSONValue>,
    agentName?: string,
    baseConversationHistory?: ConversationHistory,
  ): Promise<AgentSession | undefined> {
    if (!runtime.sessionStore) return Promise.resolve(undefined);
    const incarnation = runSessionIncarnations.get(runId);
    if (incarnation === undefined) {
      diagnose({
        level: 'warn',
        scope: 'session',
        message: `[bureau] Run "${runId}" has no recorded session incarnation; its terminal save into session "${sessionId}" was skipped rather than written into a session it did not start in.`,
      });
      return Promise.resolve(undefined);
    }
    return saveSession(
      sessionId,
      conversation,
      metadata,
      agentName,
      baseConversationHistory,
      incarnation,
      runId,
    );
  }

  function reviewAuditOutboxAttachment(
    attachment: ReviewAuditAttachment | undefined,
  ): readonly { namespace: string; payload: JSONValue }[] {
    if (!attachment) return [];
    return [
      {
        namespace: REVIEW_AUDIT_OUTBOX_NAMESPACE,
        // `attachment.detail` is typed `unknown` to match `AuditTrail.record()`'s
        // own `detail` field (a `PendingReview` snapshot plus decision/reason
        // strings) — every existing out-of-band audit write already assumes
        // this shape is JSON-safe and passes it straight to `JSON.stringify`
        // with no further serialization (`writeOutOfBandRecord`), so this
        // cast asserts nothing new; it only carries that same, already-relied-
        // on assumption across the `SessionOutboxEntry.payload: JSONValue`
        // boundary.
        payload: attachment as unknown as JSONValue,
      },
    ];
  }

  async function persistPendingApprovalOverride(
    sessionId: string,
    reviewId: string,
    approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval'],
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    const serializedApproval = JSON.parse(JSON.stringify(approval)) as JSONValue;
    const round = pendingApprovalRounds.get(reviewId) ?? 0;
    await runtime.sessionStore.update(sessionId, (session) => ({
      ...session!,
      metadata: {
        ...session!.metadata,
        approvalResolutionStartedIds: omitStartedRecord(
          session!.metadata['approvalResolutionStartedIds'],
          reviewId,
        ),
        pendingApprovalOverrides: {
          ...(isJsonObject(session!.metadata['pendingApprovalOverrides'])
            ? session!.metadata['pendingApprovalOverrides']
            : {}),
          [reviewId]: serializedApproval,
        },
        // Written with the override in one update, so a round never outlives or
        // trails the approval it counts.
        pendingApprovalRounds: {
          ...(isJsonObject(session!.metadata['pendingApprovalRounds'])
            ? session!.metadata['pendingApprovalRounds']
            : {}),
          [reviewId]: round,
        },
      },
    }));
  }

  async function persistApprovalResolutionStarted(
    sessionId: string,
    reviewId: string,
    peerRecovery?: ApprovalPeerRecovery,
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    await runtime.sessionStore.update(sessionId, (session) => {
      if (!session) return session;
      const started = readApprovalResolutionStarted(
        session.metadata['approvalResolutionStartedIds'],
      );
      return {
        ...session,
        metadata: {
          ...session.metadata,
          approvalResolutionStartedIds: writeApprovalResolutionStarted(
            started.some((record) => record.id === reviewId)
              ? started.map((record) =>
                  record.id === reviewId && peerRecovery !== undefined
                    ? { ...record, peerRecovery }
                    : record,
                )
              : [
                  {
                    id: reviewId,
                    startedAt: runtimeServices.clock.now(),
                    ...(peerRecovery === undefined ? {} : { peerRecovery }),
                  },
                ],
          ),
        },
      };
    });
  }

  async function prunePersistedPendingApprovalOverrides(
    sessionId: string,
    reviewIdPrefix: string,
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    await runtime.sessionStore.update(sessionId, (session) => {
      if (!session) return session;
      const current = session.metadata['pendingApprovalOverrides'];
      const remaining =
        typeof current === 'object' && current !== null && !Array.isArray(current)
          ? omitKeysWithPrefix(current as Record<string, JSONValue>, reviewIdPrefix)
          : current;
      const currentStarted = session.metadata['approvalResolutionStartedIds'];
      const remainingStarted =
        currentStarted === undefined
          ? undefined
          : omitStartedRecordsWithPrefix(currentStarted, reviewIdPrefix);
      const currentRounds = session.metadata['pendingApprovalRounds'];
      const remainingRounds = isJsonObject(currentRounds)
        ? omitKeysWithPrefix(currentRounds, reviewIdPrefix)
        : currentRounds;
      return {
        ...session,
        metadata: {
          ...session.metadata,
          ...(remainingRounds === undefined ? {} : { pendingApprovalRounds: remainingRounds }),
          ...(remaining === undefined ? {} : { pendingApprovalOverrides: remaining }),
          ...(remainingStarted === undefined
            ? {}
            : { approvalResolutionStartedIds: remainingStarted }),
        },
      };
    });
  }

  async function retryRunDeletionPersistenceWrite(
    operation: 'pending-approvals' | 'resolved-reviews',
    sessionId: string,
    reviewIdPrefix: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        if (operation === 'pending-approvals') {
          await prunePersistedPendingApprovalOverrides(sessionId, reviewIdPrefix);
        } else {
          await prunePersistedResolvedReviewIds(sessionId, reviewIdPrefix);
        }
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

  async function prunePersistedInvalidApprovalReviewState(
    sessionId: string,
    runId: string,
    reviewId: string,
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    await runtime.sessionStore.update(sessionId, (session) => {
      if (!session) return session;
      const currentPending = session.metadata['pendingApprovalOverrides'];
      let persistedApprovalOverrides = currentPending;
      if (
        typeof currentPending === 'object' &&
        currentPending !== null &&
        !Array.isArray(currentPending)
      ) {
        const { [reviewId]: _removed, ...remaining } = currentPending as Record<string, JSONValue>;
        persistedApprovalOverrides = remaining;
      }

      let hasRemainingApprovalForRun = false;
      if (
        typeof persistedApprovalOverrides === 'object' &&
        persistedApprovalOverrides !== null &&
        !Array.isArray(persistedApprovalOverrides)
      ) {
        for (const id of Object.keys(persistedApprovalOverrides)) {
          if (id.startsWith(`approval:${runId}:`)) {
            hasRemainingApprovalForRun = true;
            break;
          }
        }
      }
      let lastRequestAuthorities = session.metadata['lastRequestAuthorities'];
      if (
        !hasRemainingApprovalForRun &&
        typeof lastRequestAuthorities === 'object' &&
        lastRequestAuthorities !== null &&
        !Array.isArray(lastRequestAuthorities)
      ) {
        const { [runId]: _removed, ...remainingAuthorities } = lastRequestAuthorities as Record<
          string,
          JSONValue
        >;
        lastRequestAuthorities = remainingAuthorities;
      }

      const currentRounds = session.metadata['pendingApprovalRounds'];
      return {
        ...session,
        metadata: {
          ...session.metadata,
          ...(persistedApprovalOverrides !== currentPending
            ? { pendingApprovalOverrides: persistedApprovalOverrides }
            : {}),
          ...(lastRequestAuthorities !== session.metadata['lastRequestAuthorities']
            ? { lastRequestAuthorities }
            : {}),
          // The round counts supersessions of an approval that is gone (COR-1596).
          ...(isJsonObject(currentRounds)
            ? { pendingApprovalRounds: omitKey(currentRounds, reviewId) }
            : {}),
        },
      };
    });
  }

  async function prunePersistedInvalidApprovalReviewStateWithRetry(
    sessionId: string,
    runId: string,
    reviewId: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        await prunePersistedInvalidApprovalReviewState(sessionId, runId, reviewId);
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

  async function persistPendingApprovalOverrideWithRetry(
    sessionId: string,
    reviewId: string,
    approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval'],
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        await persistPendingApprovalOverride(sessionId, reviewId, approval);
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

  async function persistApprovalResolutionStartedWithRetry(
    sessionId: string,
    reviewId: string,
    peerRecovery?: ApprovalPeerRecovery,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        await persistApprovalResolutionStarted(sessionId, reviewId, peerRecovery);
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

  function peerRecoveryForApproval(
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    input: ResolveReviewInput,
    request: ReviewDecisionRequest,
  ): ApprovalPeerRecovery | undefined {
    if (input.decision !== 'approve') return undefined;
    const revision = review.approval.approvalBinding?.toolDefinitionRevision;
    if (revision === undefined || !options.recoverableStartedApprovals?.has(revision)) {
      return undefined;
    }
    const effectiveArguments = Object.prototype.hasOwnProperty.call(input, 'arguments')
      ? input.arguments
      : review.approval.arguments;
    const argumentsRecord = isJsonObject(effectiveArguments as JSONValue)
      ? (effectiveArguments as Record<string, JSONValue>)
      : undefined;
    const message = argumentsRecord?.['message'];
    if (typeof message !== 'string' || message.trim().length === 0) return undefined;
    return {
      version: 1,
      toolDefinitionRevision: revision,
      durableOperationKey: `approval-resume:v1:${review.id}`,
      request,
      arguments: { message },
    };
  }

  async function persistReviewResolution(
    sessionId: string,
    reviewId: string,
    removePendingApproval: boolean,
    runId: string,
    // AB-391 (Codex P1 review finding, PR #601, "Distinguish concurrent
    // resolvers from commit retries"): this call's OWN decision identity,
    // persisted alongside `resolvedReviewIds` (as `resolvedReviewDecisions`)
    // so a later attempt that finds `reviewId` already resolved can tell
    // apart two cases that both look identical from `resolvedReviewIds`
    // alone: THIS SAME caller's own retry after an ambiguous commit (the
    // persisted decision matches), versus a DIFFERENT resolver's genuinely
    // different decision having already won a race (two Bureau instances
    // sharing a session store, both resolving the same still-pending
    // review). See the `resolvedReviewIds.includes(reviewId)` branch below.
    decision: 'approve' | 'deny' | 'reject',
    principal: string,
    reason: string | undefined,
    // AB-391: the decision's audit payload, appended as a `session.attachment`
    // outbox entry in the SAME `conditionalBatch` as this function's own
    // `sessionStore.update()` commit below — see `reviewAuditOutboxAttachment`.
    // Unlike this function, `persistPendingApprovalOverride` (the
    // tool-approval re-gate path) takes no such parameter: its commit writes
    // the REPLACEMENT approval, and coupling the superseded review's own
    // audit payload — which embeds its now-revoked ORIGINAL approval token —
    // into that same batch would put both tokens in one commit, a real
    // behavioral difference (see `recordReviewStatusTransition`'s own doc
    // comment on the `superseded` branch).
    auditAttachment?: ReviewAuditAttachment,
    // COR-1828: the tool the decision asked to remember. It joins the session's `approvalGrants`
    // in this same commit, so the grant and the decision land together or not at all.
    rememberTool?: string,
    /** Recovery-only guard evaluated against the fresh session immediately before its CAS write. */
    commitGuard?: () => Promise<boolean>,
    // AB-391 (Codex review finding, PR #601, "Detect when the resolution
    // update appends nothing"): returns whether the `sessionStore.update()`
    // call below actually committed — `false` when the updater returned
    // `undefined` (e.g. the session was concurrently deleted between this
    // review being read and this call running), in which case NEITHER the
    // resolution NOR the coupled `auditAttachment` outbox entry was
    // appended. A caller that ignored this return and unconditionally
    // treated the audit record as "already appended" would suppress the
    // fallback direct write in `recordReviewDecision` for a decision that
    // in fact recorded no durable audit trace at all.
  ): Promise<boolean> {
    if (!runtime.sessionStore) return false;
    // AB-391 (Codex P1 review finding, PR #601, "Avoid reattaching audits
    // after an ambiguous commit"): set by the updater below when this
    // `reviewId` is ALREADY present in the session's `resolvedReviewIds` —
    // meaning some earlier commit already durably landed this exact
    // decision (and its coupled audit attachment), most likely because a
    // prior call's `conditionalBatch` committed but the call back still
    // rejected (the fault-engine test helper's own `fail-after-commit`
    // boundary names exactly this ambiguous outcome: a lost
    // acknowledgement). The updater returns `undefined` in that case so
    // `sessionStore.update()` never calls `commit()` at all — no re-commit,
    // no second `session.attachment` outbox entry at a fresh ordinal (which
    // would carry a distinct `dedupeKey` from the one the earlier commit
    // already wrote, so the `dedupeKey` guard alone could not have caught
    // it). Detected HERE, inside the updater, rather than via a separate
    // read-then-decide check before retrying: the updater already reads the
    // CAS-fresh session body on every attempt (including a fresh call from
    // `persistReviewResolutionWithRetry`'s cleanup-pending retry path, not
    // just an in-loop retry of THIS call), so this is the one place that
    // sees every attempt's live state without an extra read.
    let alreadyLanded = false;
    let conflictingDecision: { decision?: string; principal?: string; reason?: string } | undefined;
    const committed = await runtime.sessionStore.update(
      sessionId,
      async (session) => {
        if (!session) return session;
        const currentResolved = session.metadata['resolvedReviewIds'];
        const persistedResolvedReviewIds: string[] = [];
        if (Array.isArray(currentResolved)) {
          for (const id of currentResolved) {
            if (typeof id === 'string') persistedResolvedReviewIds.push(id);
          }
        }
        if (persistedResolvedReviewIds.includes(reviewId)) {
          // AB-391 (Codex P1 review finding, PR #601, "Distinguish
          // concurrent resolvers from commit retries"): `resolvedReviewIds`
          // alone cannot tell this call's own ambiguous-commit retry apart
          // from a DIFFERENT resolver's already-won, genuinely different
          // decision — both look identical here. Compare against the
          // persisted decision identity instead. A resolution recorded
          // before this field existed (`prior === undefined`) is treated as
          // benign/own-retry, matching this fix's own backward-compatible
          // default.
          const currentDecisionsRaw = session.metadata['resolvedReviewDecisions'];
          const currentDecisions: Record<string, JSONValue> =
            typeof currentDecisionsRaw === 'object' &&
            currentDecisionsRaw !== null &&
            !Array.isArray(currentDecisionsRaw)
              ? (currentDecisionsRaw as Record<string, JSONValue>)
              : {};
          const priorRaw = ownEntry(currentDecisions, reviewId);
          const prior =
            typeof priorRaw === 'object' && priorRaw !== null && !Array.isArray(priorRaw)
              ? (priorRaw as Record<string, JSONValue>)
              : undefined;
          if (prior !== undefined) {
            const priorDecision =
              typeof prior['decision'] === 'string' ? prior['decision'] : undefined;
            const priorPrincipal =
              typeof prior['principal'] === 'string' ? prior['principal'] : undefined;
            const priorReason = typeof prior['reason'] === 'string' ? prior['reason'] : undefined;
            const isSameDecision =
              priorDecision === decision && priorPrincipal === principal && priorReason === reason;
            if (!isSameDecision) {
              conflictingDecision = {
                ...(priorDecision !== undefined ? { decision: priorDecision } : {}),
                ...(priorPrincipal !== undefined ? { principal: priorPrincipal } : {}),
                ...(priorReason !== undefined ? { reason: priorReason } : {}),
              };
              return undefined;
            }
          }
          alreadyLanded = true;
          return undefined;
        }
        const currentPending = session.metadata['pendingApprovalOverrides'];
        let persistedApprovalOverrides = currentPending;
        if (
          removePendingApproval &&
          typeof currentPending === 'object' &&
          currentPending !== null &&
          !Array.isArray(currentPending)
        ) {
          const { [reviewId]: _removed, ...remaining } = currentPending as Record<
            string,
            JSONValue
          >;
          persistedApprovalOverrides = remaining;
        }
        const run = store.getRun(runId);
        let hasRemainingReviews = false;
        for (const review of listPendingReviews()) {
          if (review.runId !== runId) continue;
          hasRemainingReviews = true;
          break;
        }
        let lastRequestAuthorities = session.metadata['lastRequestAuthorities'];
        const runHasEnded = run ? run.status !== 'running' : false;
        if (
          runHasEnded &&
          !hasRemainingReviews &&
          typeof lastRequestAuthorities === 'object' &&
          lastRequestAuthorities !== null &&
          !Array.isArray(lastRequestAuthorities)
        ) {
          const { [runId]: _removed, ...remainingAuthorities } = lastRequestAuthorities as Record<
            string,
            JSONValue
          >;
          lastRequestAuthorities = remainingAuthorities;
        }
        if (commitGuard !== undefined && !(await commitGuard())) return undefined;
        return {
          ...session,
          metadata: {
            ...session.metadata,
            approvalResolutionStartedIds: omitStartedRecord(
              session.metadata['approvalResolutionStartedIds'],
              reviewId,
            ),
            ...(rememberTool === undefined
              ? {}
              : {
                  approvalGrants: [
                    ...new Set([...approvalGrantsOf(session.metadata), rememberTool]),
                  ],
                }),
            // `resolvedReviewIds` is guaranteed to NOT already include
            // `reviewId` here — the `alreadyLanded`/`conflictingDecision`
            // early returns above handle that case before this object is
            // ever built.
            resolvedReviewIds: [...persistedResolvedReviewIds, reviewId],
            // AB-391: this call's own decision identity, persisted so a
            // LATER attempt that finds `reviewId` already resolved can
            // compare against it — see the `resolvedReviewIds.includes`
            // branch above.
            resolvedReviewDecisions: {
              ...(isJsonObject(session.metadata['resolvedReviewDecisions'])
                ? session.metadata['resolvedReviewDecisions']
                : {}),
              [reviewId]: {
                decision,
                principal,
                ...(reason !== undefined ? { reason } : {}),
              },
            },
            ...(removePendingApproval
              ? {
                  pendingApprovalOverrides: persistedApprovalOverrides,
                  // The round counts supersessions of an approval that is pending; a decided
                  // one has none to count (COR-1596).
                  ...(isJsonObject(session.metadata['pendingApprovalRounds'])
                    ? {
                        pendingApprovalRounds: omitKey(
                          session.metadata['pendingApprovalRounds'],
                          reviewId,
                        ),
                      }
                    : {}),
                }
              : {}),
            ...(removePendingApproval &&
            isJsonObject(session.metadata['approvalPeerRecoveryResults'])
              ? {
                  approvalPeerRecoveryResults: omitKey(
                    session.metadata['approvalPeerRecoveryResults'],
                    reviewId,
                  ),
                }
              : {}),
            ...(lastRequestAuthorities !== session.metadata['lastRequestAuthorities']
              ? { lastRequestAuthorities }
              : {}),
            // COR-1596: a fire is never on the store, so what ends with its approval is read
            // from the session's own record of the fire's approvals, which keeps the authority
            // while a sibling, one expired but not yet swept included, still holds it.
            ...(removePendingApproval && !run && scheduledFireApprovalRuns.has(runId)
              ? (withoutFireApprovals(session.metadata, runId, (id) => id === reviewId) ?? {})
              : {}),
          },
        };
      },
      { outbox: reviewAuditOutboxAttachment(auditAttachment) },
    );
    if (conflictingDecision) {
      // AB-391 (Codex P1 review finding, PR #601, "Distinguish concurrent
      // resolvers from commit retries"): a DIFFERENT resolver's decision
      // already durably won this review — this call made no partial
      // commitment of its own (the updater returned `undefined` before
      // building any candidate object), so reporting a fabricated success
      // here (the pre-fix behavior) would return a result, and dispatch a
      // live event, contradicting the sole durable audit record. Mirrors
      // the existing `reviewResolutionCleanupPending` CONFLICT shape
      // (`resolveReview`'s own "already resolved" throw) rather than
      // inventing a new error shape for the same underlying situation.
      throw new BureauError(
        `Review "${reviewId}" was already resolved as "${conflictingDecision.decision ?? 'unknown'}" by a different resolver`,
        'CONFLICT',
      );
    }
    if (alreadyLanded) return true;
    return committed !== undefined;
  }

  async function persistReviewResolutionWithRetry(
    sessionId: string,
    reviewId: string,
    removePendingApproval: boolean,
    runId: string,
    decision: 'approve' | 'deny' | 'reject',
    principal: string,
    reason: string | undefined,
    auditAttachment?: ReviewAuditAttachment,
    rememberTool?: string,
    commitGuard?: () => Promise<boolean>,
    // AB-391: see `persistReviewResolution`'s own doc comment on this
    // return value, including its `alreadyLanded` handling of an ambiguous
    // prior commit — that check runs on EVERY call to
    // `persistReviewResolution` below, including a retry in this loop AND a
    // wholly separate later call from the `reviewResolutionCleanupPending`
    // path, so this loop itself needs no extra ambiguous-commit handling of
    // its own.
  ): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        return await persistReviewResolution(
          sessionId,
          reviewId,
          removePendingApproval,
          runId,
          decision,
          principal,
          reason,
          auditAttachment,
          rememberTool,
          commitGuard,
        );
      } catch (error) {
        // AB-391 (Codex P1 review finding, PR #601, "Distinguish concurrent
        // resolvers from commit retries"): a genuine CONFLICT — a DIFFERENT
        // resolver's decision already durably won — is not transient, so
        // retrying would only re-throw the identical CONFLICT again. Fail
        // fast instead of burning the remaining attempts and their sleeps.
        if (error instanceof BureauError && error.code === 'CONFLICT') throw error;
        lastError = error;
        if (attempt < SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS) {
          await sessionPersistenceSleep(sessionPersistenceRetryDelayMilliseconds);
        }
      }
    }
    throw lastError;
  }

  async function prunePersistedResolvedReviewIds(
    sessionId: string,
    reviewIdPrefix: string,
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    await runtime.sessionStore.update(sessionId, (session) => {
      if (!session) return session;
      const current = session.metadata['resolvedReviewIds'];
      const currentDecisions = session.metadata['resolvedReviewDecisions'];
      const hasDecisions =
        typeof currentDecisions === 'object' &&
        currentDecisions !== null &&
        !Array.isArray(currentDecisions);
      if (!Array.isArray(current) && !hasDecisions) return session;
      const remainingReviewIds: string[] = [];
      if (Array.isArray(current)) {
        for (const id of current) {
          if (typeof id === 'string' && !id.startsWith(reviewIdPrefix)) {
            remainingReviewIds.push(id);
          }
        }
      }
      // AB-391 (Codex P2 review finding, PR #601, "Prune decision identities
      // with resolved review IDs"): `resolvedReviewDecisions` is a sibling
      // map keyed by the same review ids as `resolvedReviewIds` — pruning
      // one without the other leaves stale decision/principal/reason data
      // for deleted runs behind forever in a long-lived session.
      const remainingDecisions = hasDecisions
        ? omitKeysWithPrefix(currentDecisions as Record<string, JSONValue>, reviewIdPrefix)
        : currentDecisions;
      return {
        ...session,
        metadata: {
          ...session.metadata,
          ...(Array.isArray(current) ? { resolvedReviewIds: remainingReviewIds } : {}),
          ...(hasDecisions ? { resolvedReviewDecisions: remainingDecisions } : {}),
        },
      };
    });
  }

  function restoreResolvedReviewIds(metadata: unknown, runId: string): void {
    const metadataRecord =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
    const persistedIds = metadataRecord?.['resolvedReviewIds'];
    if (!Array.isArray(persistedIds)) return;
    for (const reviewId of persistedIds) {
      if (typeof reviewId === 'string' && reviewId.startsWith(`approval:${runId}:`)) {
        resolvedReviewIds.add(reviewId);
      }
      if (typeof reviewId === 'string' && reviewId.startsWith(`human-wait:${runId}:`)) {
        resolvedReviewIds.add(reviewId);
      }
    }
  }

  /**
   * COR-1596 — the review ids of the tool approvals a schedule fire's run has committed, read from
   * its checkpoint, which is the only source of truth for which of a fire's approvals exist,
   * whatever the fire's status. A fire writes its session as each step completes and commits the
   * step after, so the session can hold an approval the run never committed and, once recovered,
   * will not make again under the same call: what the session holds is a claim, and a reader of
   * it checks it here. `undefined` when the checkpoint cannot be read, which is diagnosed and
   * which no caller acts on: the session is left as it is for the next read.
   */
  async function readCommittedFireApprovals(
    runId: string,
    purpose: string,
  ): Promise<ReadonlySet<string> | undefined> {
    const durable = runtime.durable;
    if (durable === undefined) return undefined;
    try {
      // Strict: a tolerant read skips a step record that fails the parts check, and a step
      // skipped is a committed approval taken for an abandoned one.
      return committedFireApprovalIds(
        runId,
        await durable.checkpointStore.loadSteps(runId, { strict: true }),
      );
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Could not read what schedule fire "${runId}" committed, so ${purpose}: ${serializeUnknownError(error)}`,
        cause: error,
      });
      return undefined;
    }
  }

  /**
   * COR-1596 — whether the engine's own status for a run is that it was canceled. The engine
   * spells it `cancelled` (Weft's `WorkflowStatus`); Bureau's settlement and task states spell it
   * `canceled`. This is the one place the engine's spelling is compared, so a check written
   * against the wrong one cannot pass a test and fail in production.
   */
  function isEngineCancelled(status: string): boolean {
    return status === 'cancelled';
  }

  /**
   * COR-1596 — what the engine says of a fire, the truth for whether it was canceled, as the
   * checkpoint is the truth for which approvals it committed; no bookkeeping order decides either.
   * `ended` is any status but cancelled, terminal or not: those fires' committed approvals are
   * still the operator's to decide. `absent` is a run the engine no longer holds, and
   * `unreadable` one whose status could not be read, which is diagnosed once.
   */
  async function readFireEngineStatus(
    runId: string,
    consequence: string,
  ): Promise<'cancelled' | 'ended' | 'absent' | 'unreadable'> {
    const durable = runtime.durable;
    if (durable === undefined) return 'unreadable';
    try {
      const state = await durable.engine.get(runId);
      if (state === null) return 'absent';
      return isEngineCancelled(state.status) ? 'cancelled' : 'ended';
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Could not read the engine status of schedule fire "${runId}", so ${consequence}: ${serializeUnknownError(error)}`,
        cause: error,
      });
      return 'unreadable';
    }
  }

  /**
   * COR-1613 — the status a review's round was closed with in the audit trail: approved, denied,
   * rejected, expired, revoked or canceled, or `undefined` when no terminal record of the round
   * exists. A re-gated approval keeps its id across rounds and each round it leaves is recorded, so
   * a round's record closes that round alone; `superseded` is not terminal. The whole trail of the
   * run is read, a page at a time. Without an audit trail there is nothing to read.
   */
  async function terminalAuditStatusOf(review: CanceledReviewTarget): Promise<string | undefined> {
    if (auditTrailInstance === undefined) return undefined;
    const round = review.kind === 'tool-approval' ? review.round : undefined;
    let after: { timestampMs: number; sequence: number } | undefined;
    for (;;) {
      const page = await auditTrailInstance.query({
        runId: review.runId,
        limit: AUDIT_PAGE_SIZE,
        ...(after === undefined ? {} : { after }),
      });
      for (const record of page) {
        const status = closingStatusOfRound(record, review.id, round);
        if (status !== undefined) return status;
      }
      const last = page.at(-1);
      if (last === undefined || page.length < AUDIT_PAGE_SIZE) return undefined;
      after = { timestampMs: last.timestampMs, sequence: last.sequence ?? -1 };
    }
  }

  /**
   * COR-1622 — whether the durable history holds the `review.canceled` of a review's round, by the
   * deduplication key it is written with (COR-1621). The events this process dispatched are written
   * asynchronously, so they are waited for first. A history written before the key existed is not
   * found here, and a Bureau with no history has none to be missing it.
   */
  async function canceledRecordedInHistory(review: CanceledReviewTarget): Promise<boolean> {
    if (eventHistoryInstance === undefined) return true;
    const owner = { kind: 'run', id: review.runId } as const;
    await durableEventProducerInstance?.waitForActiveWrites(owner);
    return eventHistoryInstance.wasRecorded(
      owner,
      'review.canceled',
      reviewCanceledDedupeKey(review.id, review.round),
    );
  }

  /** The canceled closings in flight in this process, by review and round (COR-1613). */
  const closingCanceledReviews = new Map<string, Promise<void>>();

  /**
   * COR-1613 — closes a canceled fire's review, an approval or a human wait, in the audit trail
   * and the durable history, at most once: it writes only when the review has no terminal record
   * yet for its round. A process that died after the engine recorded the cancel and before this
   * write leaves the review open, and the next boot closes it here, so the guarantee holds across
   * sequential restarts (two peers booting at the same moment are out of scope). Within this
   * process the closing is fenced: a second caller for the same review, such as the cancel and
   * the settlement that follows it, waits for the first instead of reading the trail before the
   * first has written.
   */
  function closeCanceledFireReview(
    review: PendingReview,
    principal: string,
    known: { readonly historyHoldsCancel?: boolean } = {},
  ): Promise<void> {
    return closeCanceledReviewTarget(
      {
        id: review.id,
        runId: review.runId,
        kind: review.kind,
        round: review.kind === 'tool-approval' ? review.round : 0,
      },
      principal,
      () => review,
      known,
    );
  }

  /**
   * COR-1622 — closes a canceled review by what finding its records needs, and builds the review
   * (`full`) only when its audit record is to be written. A review that cannot be built is not
   * written from a guess: nothing is written, and the closing fails to be reported and retried at
   * the next boot.
   *
   * The history is already known to hold the review's `review.canceled` when `known` says so (read
   * at boot), so only its audit half is checked, and an event written before the deduplication key
   * existed is not written again.
   */
  function closeCanceledReviewTarget(
    target: CanceledReviewTarget,
    principal: string,
    full: () => PendingReview | undefined,
    known: { readonly historyHoldsCancel?: boolean } = {},
  ): Promise<void> {
    const key = `${target.id}:${target.round}`;
    const inFlight = closingCanceledReviews.get(key);
    if (inFlight !== undefined) return inFlight;
    const closing = (async () => {
      // COR-1622: the audit record and the history event are two writes, and either can be the one
      // that is missing (the history append failed, or the process died between them), so each is
      // checked on its own and only the missing one is written. A round another status closed is
      // left as it was decided.
      const status = await terminalAuditStatusOf(target);
      if (status !== undefined && status !== 'canceled') return;
      const auditMissing = status === undefined;
      const historyHoldsCancel =
        known.historyHoldsCancel === true || (await canceledRecordedInHistory(target));
      if (!auditMissing && historyHoldsCancel) return;
      const review = auditMissing ? full() : undefined;
      if (review !== undefined) {
        await recordReviewStatusTransition(review, 'canceled', principal, {
          audit: true,
          dispatch: !historyHoldsCancel,
        });
        return;
      }
      // Without an audit trail there is no record to build a review for.
      if (auditMissing && auditTrailInstance !== undefined) {
        throw new Error(
          `Review "${target.id}" cannot be rebuilt from what the fire committed, so its canceled record is not written`,
        );
      }
      // Only the history event is missing, and it needs no more than the review's identity.
      await fireReviewSeeds.pending(target.runId);
      emitter.dispatch(
        new ReviewCanceledEvent(target.id, target.runId, principal, target.kind, target.round),
      );
    })().finally(() => {
      closingCanceledReviews.delete(key);
    });
    closingCanceledReviews.set(key, closing);
    return closing;
  }

  /** COR-1613 — a canceled fire's parked human waits, read before they are forgotten. */
  async function closeCanceledFireHumanWaits(runId: string, principal: string): Promise<void> {
    for (const review of runHumanWaits.list()) {
      if (review.runId === runId) await closeCanceledFireReview(review, principal);
    }
  }

  /**
   * COR-1622 — the reviews of a canceled fire that nothing has closed, read at boot, closed once
   * each, whether or not the fire's task is settled (a settlement never waits for a close, so a
   * settled task can still hold an open request). Two sources make the list:
   *
   * - each request the fire's durable history holds that no closing has ended, at the round it
   *   stands at, which is how a close that failed once is retried: the audit record and the
   *   history event are checked on their own, and only the missing one is written;
   * - the human wait the fire's checkpoint ends on, for a wait whose request the history never
   *   got. The checkpoint is read strictly: a malformed latest step could name the wrong park, so
   *   it closes nothing, and a later boot with a readable checkpoint closes the right one.
   *
   * A task of another kind has none. Each review is closed on its own, so one that cannot be
   * leaves the others; the failures are reported, and the next boot tries again.
   */
  async function closeOpenReviewsOfCanceledFire(runId: string): Promise<void> {
    const record = await tasks.record(runId);
    const durable = runtime.durable;
    if (record === undefined || record.kind !== 'schedule-fire' || durable === undefined) return;
    const failures: string[] = [];
    // The fire's committed steps, read strictly: they are the only description of a canceled
    // review that is left (its session left with the cancel). A step that cannot be read could
    // name the wrong review, so it describes nothing, and a record that needs it is not written.
    let committed: ReturnType<typeof committedFireReviews> | undefined;
    let outstanding: ReturnType<typeof countCheckpointParks>['outstanding'];
    try {
      const steps = await durable.checkpointStore.loadSteps(runId, { strict: true });
      committed = committedFireReviews(runId, steps);
      outstanding = countCheckpointParks(steps).outstanding;
    } catch (error) {
      failures.push(`its checkpoint could not be read strictly: ${serializeUnknownError(error)}`);
    }
    const base = {
      runId,
      sessionId: record.contextId,
      agentName: record.agentName ?? undefined,
      requestedAt: Date.parse(record.createdAt) || 0,
      ageMilliseconds: 0,
      status: 'pending',
    } as const;
    /** The review the checkpoint committed under `id`, as the live revoke would have built it. */
    const rebuild = (target: CanceledReviewTarget): PendingReview | undefined => {
      const described = committed?.get(target.id);
      if (described === undefined || described.kind !== target.kind) return undefined;
      // The checkpoint holds only the approval its step first raised. A re-gated round's approval
      // lived in the session, which the cancel cleared, so a record built for it here would carry
      // round 0's reason and action under a later round. Such a round is reported, not written.
      if (described.kind === 'tool-approval' && target.round > 0) return undefined;
      return described.kind === 'tool-approval'
        ? {
            ...base,
            kind: 'tool-approval',
            id: target.id,
            approval: described.approval,
            round: target.round,
          }
        : {
            ...base,
            kind: 'human-wait',
            id: target.id,
            signalName: described.signalName,
            prompt: described.prompt,
            ...(described.inputSchema === undefined ? {} : { inputSchema: described.inputSchema }),
          };
    };
    const kindOf = (id: string): CanceledReviewTarget['kind'] =>
      id.startsWith('human-wait:') ? 'human-wait' : 'tool-approval';
    const candidates = new Map<string, CanceledReviewTarget>();
    // The candidates whose history already holds a `review.canceled`: their audit half is what may
    // be missing.
    const canceledInHistory = new Set<string>();
    try {
      const history = await readFireReviewHistory(runId);
      for (const [id, { round, canceled }] of history.open) {
        const kind = kindOf(id);
        candidates.set(id, { id, runId, kind, round: kind === 'human-wait' ? 0 : round });
        if (canceled) canceledInHistory.add(id);
      }
    } catch (error) {
      failures.push(`its history could not be read: ${serializeUnknownError(error)}`);
    }
    if (outstanding !== undefined) {
      const id = `human-wait:${runId}:${outstanding.signalName}:${outstanding.ordinal}`;
      if (!candidates.has(id)) candidates.set(id, { id, runId, kind: 'human-wait', round: 0 });
    }
    for (const target of candidates.values()) {
      try {
        await closeCanceledReviewTarget(target, 'system:run-abort', () => rebuild(target), {
          historyHoldsCancel: canceledInHistory.has(target.id),
        });
      } catch (error) {
        failures.push(`review "${target.id}" could not be closed: ${serializeUnknownError(error)}`);
      }
    }
    if (failures.length > 0) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Not every review of canceled schedule fire "${runId}" was closed, and the next boot tries again: ${failures.join('; ')}`,
      });
    }
  }

  /**
   * COR-1622 — the boot's retry of every canceled fire's open closes: the fires whose task is
   * settled as canceled, whose closes `reconcileTaskRecords` never reaches because it settles only
   * what is unsettled. A fire still unsettled is closed as it is settled.
   */
  async function retryCanceledFireCloses(): Promise<void> {
    for (let offset = 0; ;) {
      const page = await tasks.enumerate({ status: 'canceled', limit: 100, offset });
      for (const view of page.tasks) await closeOpenReviewsOfCanceledFire(view.id);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
  }

  /**
   * COR-1613 — the review a fire's persisted approval stands for, built from the session's own
   * record in the shape the live revoke builds, for the boot that has nothing in memory.
   */
  async function persistedFireApprovalReview(
    runId: string,
    sessionId: string,
    reviewId: string,
  ): Promise<Extract<PendingReview, { kind: 'tool-approval' }> | undefined> {
    const session = await runtime.sessionStore?.load(sessionId);
    const persisted = session?.metadata['pendingApprovalOverrides'];
    const approval = isJsonObject(persisted) ? ownEntry(persisted, reviewId) : undefined;
    if (session === undefined || !isJsonObject(approval)) return undefined;
    const rounds = session.metadata['pendingApprovalRounds'];
    const round = isJsonObject(rounds) ? ownEntry(rounds, reviewId) : undefined;
    return {
      kind: 'tool-approval',
      id: reviewId,
      runId,
      sessionId,
      agentName: session.agentName,
      approval: approval as unknown as Extract<
        PendingReview,
        { kind: 'tool-approval' }
      >['approval'],
      requestedAt: 0,
      ageMilliseconds: 0,
      status: 'pending',
      round: typeof round === 'number' ? round : 0,
    };
  }

  /**
   * The approval a session records as pending for a review, with the round it stands at (the
   * session decides: COR-1596), or `undefined` when it records none.
   */
  function persistedApprovalOf(
    metadata: Record<string, JSONValue> | undefined,
    reviewId: string,
  ):
    | { approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval']; round: number }
    | undefined {
    const persisted = metadata?.['pendingApprovalOverrides'];
    const approval = isJsonObject(persisted) ? ownEntry(persisted, reviewId) : undefined;
    if (!isJsonObject(approval)) return undefined;
    const rounds = metadata?.['pendingApprovalRounds'];
    const round = isJsonObject(rounds) ? ownEntry(rounds, reviewId) : undefined;
    return {
      approval: approval as unknown as Extract<
        PendingReview,
        { kind: 'tool-approval' }
      >['approval'],
      round: typeof round === 'number' && Number.isInteger(round) && round > 0 ? round : 0,
    };
  }

  function persistedPeerRecoveryResult(
    metadata: Record<string, JSONValue> | undefined,
    reviewId: string,
  ): ToolExecutionResult | undefined {
    const results = metadata?.['approvalPeerRecoveryResults'];
    const raw = isJsonObject(results) ? ownEntry(results, reviewId) : undefined;
    if (!isJsonObject(raw)) return undefined;
    if (
      typeof raw['callId'] !== 'string' ||
      typeof raw['toolCallId'] !== 'string' ||
      typeof raw['toolName'] !== 'string' ||
      (raw['outcome'] !== 'success' && raw['outcome'] !== 'error') ||
      !Object.prototype.hasOwnProperty.call(raw, 'content')
    )
      return undefined;
    return raw as unknown as ToolExecutionResult;
  }

  async function persistPeerRecoveryResult(
    sessionId: string,
    reviewId: string,
    result: ToolExecutionResult,
    commitGuard?: () => Promise<boolean>,
  ): Promise<boolean> {
    if (runtime.sessionStore === undefined) return false;
    const committed = await runtime.sessionStore.update(sessionId, async (session) => {
      if (session === undefined) return undefined;
      if (commitGuard !== undefined && !(await commitGuard())) return undefined;
      const results = isJsonObject(session.metadata['approvalPeerRecoveryResults'])
        ? session.metadata['approvalPeerRecoveryResults']
        : {};
      if (ownEntry(results, reviewId) !== undefined) {
        return persistedPeerRecoveryResult(session.metadata, reviewId) === undefined
          ? undefined
          : session;
      }
      return {
        ...session,
        metadata: {
          ...session.metadata,
          approvalPeerRecoveryResults: {
            ...results,
            [reviewId]: JSON.parse(JSON.stringify(result)) as JSONValue,
          },
        },
      };
    });
    return committed !== undefined;
  }

  /**
   * COR-1621 — takes the approval a peer re-gated into this process's own copy of the review: the
   * session holds it at a round beyond the one held here, so this process lists the round the
   * session holds, and its toolbox learns the binding that round was issued under, as a restore
   * teaches it. Does nothing when this process already holds that round or a later one (its own
   * re-gate recorded the event it is now hearing back). Returns whether the copy moved.
   */
  async function adoptPersistedApprovalRound(
    runId: string,
    reviewId: string,
    persisted: {
      approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval'];
      round: number;
    },
  ): Promise<boolean> {
    if (persisted.round <= (pendingApprovalRounds.get(reviewId) ?? 0)) return false;
    const restoreApproval = (
      runToolboxesByRunId.get(runId) as unknown as
        { restoreApproval?: (approval: SignedPendingToolApproval) => Promise<void> } | undefined
    )?.restoreApproval;
    if (restoreApproval !== undefined && persisted.approval.approvalBinding) {
      try {
        await restoreApproval.call(
          runToolboxesByRunId.get(runId),
          persisted.approval as SignedPendingToolApproval,
        );
      } catch (error) {
        if (!isTerminalApprovalBindingError(error)) throw error;
        diagnose({
          level: 'warn',
          scope: 'approval-recovery',
          message:
            `[bureau] The binding of round ${persisted.round} of approval "${reviewId}" could not be ` +
            'restored here, so approving it here will be refused.',
          cause: error,
        });
      }
    }
    // Moved only once the binding is restored: a restore that throws leaves this copy at the
    // round it held, so the next read of the session adopts the round again rather than finding
    // it already held and never restoring the binding.
    pendingApprovalOverrides.set(reviewId, persisted.approval);
    pendingApprovalRounds.set(reviewId, persisted.round);
    return true;
  }

  /**
   * COR-1621 — how long an approval or a wait is given to reach durable state before its absence
   * from it reads as another process having closed it. A review is registered in memory as its
   * step records it, and the session's own record of it can land a moment later, so a read of
   * durable state that finds it missing right then proves nothing.
   */
  const FIRE_REVIEW_PERSISTENCE_GRACE_MILLISECONDS = 30_000;

  /**
   * COR-1621 — the `eventKind` a re-read hands `releaseClosedReview` for a review the durable
   * state says is closed: there is no event, so it is not the name of one. `releaseClosedReview`
   * reads `review.approved` as a possible re-gate and anything else as a closing, and a re-read
   * has already settled which of the two the review is, so it must never match that kind.
   */
  const REREAD_CLOSURE = 'reread';

  /**
   * COR-1621 — reads a fire's reviews held here again from durable state, for the cases where
   * the events that would have said what happened are not to be trusted: the history's retention
   * overtook the subscription, or a reaction to an event failed past its retries. An approval the
   * session records as decided, or no longer records and is older than the grace a record needs
   * to land, is dropped as another process closed it; one the session holds at a later round is
   * refreshed; a human wait the engine no longer parks on is dropped the same way.
   */
  async function rereadFireReviews(runId: string): Promise<number | undefined> {
    const sessionId = terminalReviewSessions.get(runId)?.sessionId;
    const heldIds = Array.from(pendingApprovalOverrides.keys()).filter((id) =>
      id.startsWith(`approval:${runId}:`),
    );
    // One review that cannot be read again must not keep the fire's others from being: each is
    // tried, and the first failure is thrown after them all, so the pass still counts as failed.
    const failures: unknown[] = [];
    // When the youngest review that could not yet be verified has had its grace.
    let retryAt: number | undefined;
    const retryNoEarlierThan = (at: number): void => {
      retryAt = retryAt === undefined ? at : Math.max(retryAt, at);
    };
    if (heldIds.length > 0) {
      const sessions = runtime.sessionStore;
      // Nothing to read the approvals against: they cannot be verified, which is not the same as
      // the session being gone, so the fire stays marked and is tried again.
      if (sessionId === undefined || sessions === undefined) {
        throw new Error(
          `The approvals held of schedule fire "${runId}" cannot be verified against its session: ${
            sessions === undefined ? 'there is no session store' : 'no session is recorded for it'
          }`,
        );
      }
      const session = await sessions.load(sessionId);
      if (session === undefined) {
        // The session is gone (deleted by a peer): so are the approvals it held.
        for (const id of heldIds) {
          try {
            await tasks.reviewClosedElsewhere(runId, id, REREAD_CLOSURE);
          } catch (error) {
            failures.push(error);
          }
        }
      } else {
        const decided = Array.isArray(session.metadata['resolvedReviewIds'])
          ? new Set(stringValues(session.metadata['resolvedReviewIds']))
          : new Set<string>();
        for (const id of heldIds) {
          try {
            const persisted = persistedApprovalOf(session.metadata, id);
            if (persisted !== undefined && !decided.has(id)) {
              await adoptPersistedApprovalRound(runId, id, persisted);
              continue;
            }
            const requestedAt = approvalRequestedAt.get(id) ?? 0;
            if (
              decided.has(id) ||
              runtimeServices.clock.now() - requestedAt >=
                FIRE_REVIEW_PERSISTENCE_GRACE_MILLISECONDS
            ) {
              await tasks.reviewClosedElsewhere(runId, id, REREAD_CLOSURE);
            } else {
              // Not yet in the session, and young enough that it may not have landed: it is read
              // again when its grace ends, not counted as verified.
              retryNoEarlierThan(requestedAt + FIRE_REVIEW_PERSISTENCE_GRACE_MILLISECONDS);
            }
          } catch (error) {
            failures.push(error);
          }
        }
      }
    }
    try {
      const wait = await runHumanWaits.rereadClosed(
        runId,
        FIRE_REVIEW_PERSISTENCE_GRACE_MILLISECONDS,
      );
      if (wait.closed !== undefined) {
        await tasks.reviewClosedElsewhere(runId, wait.closed, REREAD_CLOSURE);
      }
      if (wait.retryAt !== undefined) retryNoEarlierThan(wait.retryAt);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw failures[0];
    return retryAt;
  }

  /** Whether this process still holds an approval of the fire: one that is expired counts. */
  function holdsFireApproval(runId: string): boolean {
    for (const id of pendingApprovalOverrides.keys()) {
      if (id.startsWith(`approval:${runId}:`)) return true;
    }
    return false;
  }

  /**
   * COR-1596 — takes the fire's approvals that `drop` names out of its session, durably, through
   * the one function that knows every key an approval is recorded under
   * (`withoutFireApprovals`). Retried like every post-decision session write.
   */
  async function pruneFireApprovalsFromSession(
    sessionId: string,
    runId: string,
    drop: (reviewId: string) => boolean,
  ): Promise<void> {
    const sessionStore = runtime.sessionStore;
    if (sessionStore === undefined) return;
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        await sessionStore.update(sessionId, (session) => {
          if (session === undefined) return undefined;
          const patch = withoutFireApprovals(session.metadata, runId, drop);
          return patch === undefined
            ? undefined
            : { ...session, metadata: { ...session.metadata, ...patch } };
        });
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

  /**
   * COR-1596 — the in-memory end of a fire's approval state, once it holds no approval: its
   * request context and toolbox (which keeps the fire's services alive), its entries in the maps,
   * and whoever follows its task is told. An approval that expired but was not yet swept still
   * counts as held, so a sibling's decision cannot strand it unswept. Synchronous, for the
   * resolution paths that cannot wait.
   */
  function endScheduledFireWhenNoApprovalRemains(runId: string): void {
    if (!scheduledFireApprovalRuns.has(runId) || holdsFireApproval(runId)) return;
    runRequestContexts.delete(runId);
    runToolboxesByRunId.delete(runId);
    releaseRunScope(runId);
    if (releaseScheduledFireReviews(scheduledFireReviewState, runId)) {
      detachBestEffortPromise(tasks.announceChanged(runId));
    }
    unfollowFireReviewsWhenNoneRemain(runId);
  }

  /**
   * COR-1596 — how one approval of a fire ends. Every way it can (decided, expired, canceled,
   * revoked, abandoned by a crash, found unrestorable) goes through
   * {@link releaseScheduledFireApproval}, and none prunes on its own, because the state is in two
   * homes (the session's metadata and this process's maps) and an ending that released one
   * forgot the other: resolve and expiry, then settle, then cancel each did, in turn.
   */
  type ScheduledFireApprovalEnding =
    'resolved' | 'expired' | 'canceled' | 'revoked' | 'removed' | 'abandoned' | 'invalid';

  /**
   * COR-1596 — ends one approval of a fire, in both homes. `durablyPruned` is set by a decision,
   * whose own session write already took the approval out in the same commit as the decision's
   * fence.
   */
  async function releaseScheduledFireApproval(
    runId: string,
    reviewId: string,
    ending: ScheduledFireApprovalEnding,
    scope: { sessionId?: string | undefined; durablyPruned?: boolean } = {},
  ): Promise<void> {
    const sessionId = scope.sessionId ?? terminalReviewSessions.get(runId)?.sessionId;
    const heldHere = pendingApprovalOverrides.has(reviewId) || scheduledFireApprovalRuns.has(runId);
    // Hidden from the list first, so the approval is not offered while the prune is in flight or
    // after it fails.
    if (ending === 'invalid') invalidApprovalReviewIds.add(reviewId);
    else if (ending !== 'abandoned' && heldHere) resolvedReviewIds.add(reviewId);
    // The in-memory override is dropped, and the fire ended, only once the session prune has
    // committed. A prune that fails leaves the override in memory and in the session, and the
    // fire's next release finds it through `fireApprovalIds` and retries (COR-1613).
    if (scope.durablyPruned !== true && sessionId !== undefined) {
      await pruneFireApprovalsFromSession(sessionId, runId, (id) => id === reviewId);
    }
    dropPendingApprovalOverride(reviewId);
    endScheduledFireWhenNoApprovalRemains(runId);
  }

  /** The review ids of a fire's approvals this process holds or its session records. */
  async function fireApprovalIds(runId: string, sessionId: string | undefined): Promise<string[]> {
    const prefix = `approval:${runId}:`;
    const ids = new Set(
      Array.from(pendingApprovalOverrides.keys()).filter((id) => id.startsWith(prefix)),
    );
    const session =
      sessionId === undefined ? undefined : await runtime.sessionStore?.load(sessionId);
    const persisted = session?.metadata['pendingApprovalOverrides'];
    if (isJsonObject(persisted)) {
      for (const id of Object.keys(persisted)) if (id.startsWith(prefix)) ids.add(id);
    }
    return Array.from(ids);
  }

  /**
   * COR-1596 — how a fire ends, and what it owes its approvals then. `settled` reconciles the
   * session with the checkpoint, the only source of truth for which approvals exist: each one the
   * run never committed ends as abandoned. `canceled` ends every approval, bindings revoked, so
   * none can be restored to run a tool for a run that was canceled. `removed` (the fire's task
   * left retention) ends whatever is left and retires the decision fence, which the task was the
   * last thing to name. Each ends through {@link releaseScheduledFireApproval}.
   */
  async function releaseScheduledFire(
    runId: string,
    ending: 'settled' | 'canceled' | 'removed',
    scope: { sessionId?: string | undefined } = {},
  ): Promise<void> {
    const recorded = scope.sessionId === undefined ? await tasks.record(runId) : undefined;
    const sessionId =
      scope.sessionId ?? terminalReviewSessions.get(runId)?.sessionId ?? recorded?.contextId;
    if (ending === 'canceled') {
      await revokePendingApprovalsForRun(runId, {
        status: 'canceled',
        principal: 'system:run-abort',
      });
    }
    // COR-1613: a request an attempt that never committed announced is closed.
    try {
      await closeAbandonedFireRequests(runId);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'durable-event-history',
        message: `[bureau] Could not close the abandoned review requests of schedule fire "${runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
    if (ending === 'settled') {
      const committed = await readCommittedFireApprovals(
        runId,
        'its session is not reconciled with it',
      );
      if (committed === undefined) return;
      for (const id of await fireApprovalIds(runId, sessionId)) {
        if (!committed.has(id)) {
          await releaseScheduledFireApproval(runId, id, 'abandoned', { sessionId });
        }
      }
      return;
    }
    // Canceled or removed: the fire takes no further step, and nothing of its approvals stays,
    // whatever revoked it first.
    endContinuingScheduledFire(scheduledFireReviewState, runId);
    for (const id of await fireApprovalIds(runId, sessionId)) {
      // COR-1613: an approval only the session still records (a boot found it) is closed before
      // it is released, so its request does not stay open in the history.
      if (ending === 'canceled' && sessionId !== undefined && !resolvedReviewIds.has(id)) {
        const review = await persistedFireApprovalReview(runId, sessionId, id);
        if (review !== undefined) await closeCanceledFireReview(review, 'system:run-abort');
      }
      await releaseScheduledFireApproval(
        runId,
        id,
        ending === 'canceled' ? 'canceled' : 'removed',
        {
          sessionId,
        },
      );
    }
    if (ending === 'removed' && sessionId !== undefined) {
      await prunePersistedResolvedReviewIds(sessionId, `approval:${runId}:`);
      await prunePersistedResolvedReviewIds(sessionId, `human-wait:${runId}:`);
    }
    endScheduledFireWhenNoApprovalRemains(runId);
  }

  /**
   * COR-1596 — which of a fire's persisted approvals a boot may restore, by the two truths: the
   * engine's status says whether the fire was canceled, and the checkpoint says which approvals
   * it committed. `'not-a-fire'` leaves a session run's approvals to the restore they always had;
   * `'none'` restores nothing, having released a canceled fire's approvals or, when the status
   * or the checkpoint cannot be read, having left them for the next boot; otherwise the committed
   * ids.
   */
  async function restorableBootApprovals(
    metadata: Record<string, JSONValue>,
    runId: string,
    sessionId: string,
  ): Promise<'not-a-fire' | 'none' | ReadonlySet<string>> {
    if (!isScheduledFireAuthority(metadata, runId)) return 'not-a-fire';
    const engineStatus = await readFireEngineStatus(
      runId,
      'its tool approvals are not restored this boot',
    );
    if (engineStatus === 'cancelled') {
      // The prune lands through the session's own record of the fire's approvals; none was ever
      // restored here, so there is no binding to revoke. The process that took the cancel may
      // have died before it wrote the review's `canceled` record, so the release closes each
      // approval it finds, once, from the session's own record of it (COR-1613).
      await releaseScheduledFire(runId, 'canceled', { sessionId });
      return 'none';
    }
    if (engineStatus === 'absent' || engineStatus === 'unreadable') return 'none';
    return (
      (await readCommittedFireApprovals(runId, 'its tool approvals are not restored this boot')) ??
      'none'
    );
  }

  function restorePendingApprovalOverrides(
    metadata: unknown,
    runId: string,
    committed?: ReadonlySet<string>,
  ): void {
    const metadataRecord =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
    const overrides = metadataRecord?.['pendingApprovalOverrides'];
    const resolutionStarted = readApprovalResolutionStarted(
      metadataRecord?.['approvalResolutionStartedIds'] as JSONValue | undefined,
    );
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) return;
    // A review the session records as decided is not pending, whatever override it still holds.
    const decidedReviewIds = new Set(
      Array.isArray(metadataRecord?.['resolvedReviewIds'])
        ? stringValues(metadataRecord['resolvedReviewIds'])
        : [],
    );
    const rounds = metadataRecord?.['pendingApprovalRounds'];
    for (const [reviewId, approval] of Object.entries(overrides as Record<string, unknown>)) {
      if (!reviewId.startsWith(`approval:${runId}:`)) continue;
      if (invalidApprovalReviewIds.has(reviewId)) continue;
      if (decidedReviewIds.has(reviewId)) continue;
      if (committed !== undefined && !committed.has(reviewId)) continue;
      if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
        // COR-1717: a started-but-uncommitted approval is listed again, marked interrupted. The
        // tool is never re-run here; resolving it runs the normal approval path once.
        const started = resolutionStarted.find((record) => record.id === reviewId);
        if (started !== undefined) interruptedApprovals.set(reviewId, started.startedAt);
        pendingApprovalOverrides.set(
          reviewId,
          approval as Extract<PendingReview, { kind: 'tool-approval' }>['approval'],
        );
        const round =
          typeof rounds === 'object' && rounds !== null && !Array.isArray(rounds)
            ? ownEntry(rounds as Record<string, unknown>, reviewId)
            : undefined;
        if (typeof round === 'number' && Number.isInteger(round) && round > 0) {
          pendingApprovalRounds.set(reviewId, round);
        }
      }
    }
    // COR-1622: a restored approval is held, and expires, like one raised here.
    if (pendingApprovalOverrides.size > 0) ensureLazyExpirySweep();
  }

  const peerRecoveryRetryKeys = new Set<string>();

  /** COR-2051 — attach to a journaled peer task after an approved resolution lost its caller. */
  async function recoverPeerApproval(
    sessionId: string,
    runId: string,
    initialMetadata: Record<string, JSONValue>,
  ): Promise<void> {
    const leaseTtlMilliseconds = 30_000;
    const started = readApprovalResolutionStarted(initialMetadata['approvalResolutionStartedIds']);
    for (const marker of started) {
      let journalEntry: PeerCallJournalEntry | undefined;
      try {
        const recovery = marker.peerRecovery;
        if (recovery === undefined || recovery.request.reviewId !== marker.id) continue;
        const session = await runtime.sessionStore?.load(sessionId);
        const currentMetadata = session?.metadata;
        const currentMarker = readApprovalResolutionStarted(
          currentMetadata?.['approvalResolutionStartedIds'],
        ).find((candidate) => candidate.id === marker.id);
        if (
          currentMarker?.peerRecovery === undefined ||
          currentMarker.peerRecovery.request.reviewId !== marker.id
        )
          continue;
        const currentRecovery = currentMarker.peerRecovery;
        const persisted = persistedApprovalOf(currentMetadata, marker.id);
        if (persisted === undefined || persisted.approval.callId === undefined) continue;
        if (
          persisted.round !== currentRecovery.request.round ||
          persisted.approval.approvalBinding?.toolDefinitionRevision !==
            currentRecovery.toolDefinitionRevision ||
          persisted.approval.approvalToken === undefined
        )
          continue;
        const adapter = options.recoverableStartedApprovals?.get(
          currentRecovery.toolDefinitionRevision,
        );
        if (adapter === undefined || adapter.version !== 1) continue;
        const restoreApproval = (
          runToolboxesByRunId.get(runId) as unknown as {
            restoreApproval?: (approval: SignedPendingToolApproval) => Promise<void>;
          }
        )?.restoreApproval;
        if (restoreApproval === undefined) continue;
        try {
          await restoreApproval(persisted.approval as SignedPendingToolApproval);
        } catch (error) {
          // A consumed binding is the expected post-attach state. Every other binding failure
          // (bad signature, expiry, revocation, or a missing state record) fails closed.
          if ((error as { code?: unknown })?.code !== 'already-consumed') continue;
        }
        const decision = await reviewDecisions.inspect(currentRecovery.request);
        if (decision.outcome !== 'matching' || decision.recorded) continue;
        const authority = runRequestContexts.get(runId);
        if (
          authority !== undefined &&
          isTransportIssuedAuthority(authority) &&
          (requestAuthorityValidator === undefined || !(await requestAuthorityValidator(authority)))
        )
          continue;
        const review: Extract<PendingReview, { kind: 'tool-approval' }> = {
          kind: 'tool-approval',
          id: marker.id,
          runId,
          sessionId,
          agentName: terminalReviewSessions.get(runId)?.agentName,
          approval: persisted.approval,
          requestedAt: 0,
          ageMilliseconds: 0,
          status: 'pending',
          round: persisted.round,
        };
        const policyToolbox = await skillPolicyToolboxOf(review, runToolboxesByRunId.get(runId));
        if (
          !policyToolbox.tools().some((tool) => tool.id === currentRecovery.toolDefinitionRevision)
        )
          continue;
        journalEntry = await peerCalls.read({
          parentRunId: runId,
          operationKey: currentRecovery.durableOperationKey,
        });
        if (
          journalEntry === undefined ||
          typeof journalEntry.taskId !== 'string' ||
          journalEntry.taskId.length === 0 ||
          typeof journalEntry.contextId !== 'string' ||
          journalEntry.contextId.length === 0 ||
          !/^[0-9a-f]{64}$/.test(journalEntry.requestDigest)
        )
          continue;

        const token = runtimeServices.identifiers.next('approval-recovery');
        const leaseOf = (
          leaseMetadata: Record<string, JSONValue>,
        ): Record<string, JSONValue> | undefined => {
          const leases = leaseMetadata['approvalPeerRecoveryLeases'];
          const lease = isJsonObject(leases) ? ownEntry(leases, marker.id) : undefined;
          return isJsonObject(lease) ? lease : undefined;
        };
        const leaseValue = (): Record<string, JSONValue> => ({
          token,
          round: persisted.round,
          expiresAt: runtimeServices.clock.now() + leaseTtlMilliseconds,
          operationKey: currentRecovery.durableOperationKey,
        });
        const acquireLease = async (): Promise<boolean> => {
          const committed = await runtime.sessionStore?.update(sessionId, (leaseSession) => {
            if (leaseSession === undefined) return undefined;
            const current = leaseOf(leaseSession.metadata);
            if (
              current !== undefined &&
              typeof current['expiresAt'] === 'number' &&
              current['expiresAt'] > runtimeServices.clock.now()
            )
              return undefined;
            const leases = isJsonObject(leaseSession.metadata['approvalPeerRecoveryLeases'])
              ? leaseSession.metadata['approvalPeerRecoveryLeases']
              : {};
            return {
              ...leaseSession,
              metadata: {
                ...leaseSession.metadata,
                approvalPeerRecoveryLeases: { ...leases, [marker.id]: leaseValue() },
              },
            };
          });
          return committed !== undefined;
        };
        const ownsLease = async (): Promise<boolean> => {
          const leaseSession = await runtime.sessionStore?.load(sessionId);
          const lease = leaseSession === undefined ? undefined : leaseOf(leaseSession.metadata);
          return (
            lease?.['token'] === token &&
            lease['round'] === persisted.round &&
            lease['operationKey'] === currentRecovery.durableOperationKey &&
            typeof lease['expiresAt'] === 'number' &&
            lease['expiresAt'] > runtimeServices.clock.now()
          );
        };
        const recoveryStateCurrent = async (): Promise<boolean> => {
          if (!(await ownsLease())) return false;
          const freshSession = await runtime.sessionStore?.load(sessionId);
          const freshMarker = readApprovalResolutionStarted(
            freshSession?.metadata['approvalResolutionStartedIds'],
          ).find((candidate) => candidate.id === marker.id);
          if (
            freshMarker?.peerRecovery === undefined ||
            freshMarker.peerRecovery.request.reviewId !== marker.id ||
            freshMarker.peerRecovery.durableOperationKey !== currentRecovery.durableOperationKey
          )
            return false;
          const freshApproval = persistedApprovalOf(freshSession?.metadata, marker.id);
          if (freshApproval === undefined || freshApproval.round !== currentRecovery.request.round)
            return false;
          const freshDecision = await reviewDecisions.inspect(currentRecovery.request);
          return freshDecision.outcome === 'matching' && !freshDecision.recorded;
        };
        const recoveryAuthorityCurrent = async (): Promise<boolean> => {
          const freshSession = await runtime.sessionStore?.load(sessionId);
          if (freshSession === undefined) return false;
          const context = recoveredRequestContextFromMetadata(
            freshSession.metadata,
            runId,
            sessionId,
            freshSession.agentName,
            runtimeServices.clock.now,
          );
          if (context === undefined) return workspace === undefined;
          if (!isTransportIssuedAuthority(context)) return true;
          return (
            requestAuthorityValidator !== undefined && (await requestAuthorityValidator(context))
          );
        };
        if (!(await acquireLease())) {
          const retryKey = `${sessionId}:${marker.id}:${String(persisted.round)}`;
          if (!peerRecoveryRetryKeys.has(retryKey)) {
            peerRecoveryRetryKeys.add(retryKey);
            runtimeServices.timers.setTimeout(() => {
              peerRecoveryRetryKeys.delete(retryKey);
              void (async () => {
                const retrySession = await runtime.sessionStore?.load(sessionId);
                if (retrySession !== undefined) {
                  await recoverPeerApproval(sessionId, runId, retrySession.metadata);
                }
              })().catch((error: unknown) => {
                diagnose({
                  level: 'warn',
                  scope: 'approval-recovery',
                  message: `[bureau] Peer approval recovery retry failed for "${marker.id}".`,
                  cause: error,
                });
              });
            }, leaseTtlMilliseconds + 1);
          }
          continue;
        }
        const controller = new AbortController();
        const renewal = runtimeServices.timers.setInterval(
          () => {
            void (async () => {
              const renewed = await runtime.sessionStore?.update(sessionId, (renewalSession) => {
                if (renewalSession === undefined) return undefined;
                const current = leaseOf(renewalSession.metadata);
                if (current?.['token'] !== token) return undefined;
                const leases = isJsonObject(renewalSession.metadata['approvalPeerRecoveryLeases'])
                  ? renewalSession.metadata['approvalPeerRecoveryLeases']
                  : {};
                return {
                  ...renewalSession,
                  metadata: {
                    ...renewalSession.metadata,
                    approvalPeerRecoveryLeases: { ...leases, [marker.id]: leaseValue() },
                  },
                };
              });
              if (renewed === undefined) controller.abort();
            })().catch((error: unknown) => {
              controller.abort();
              diagnose({
                level: 'warn',
                scope: 'approval-recovery',
                message: `[bureau] Peer approval recovery lease renewal failed for "${marker.id}"; attachment aborted.`,
                cause: error,
              });
            });
          },
          Math.max(1, Math.floor(leaseTtlMilliseconds / 3)),
        );
        try {
          if (!(await recoveryStateCurrent())) continue;
          const freshSession = await runtime.sessionStore?.load(sessionId);
          const freshApproval = persistedApprovalOf(freshSession?.metadata, marker.id);
          if (freshApproval === undefined) continue;
          let result = persistedPeerRecoveryResult(freshSession?.metadata, marker.id);
          if (result === undefined) {
            // The authority may be revoked during the lease/state reads above. Revalidate at the
            // last possible point before invoking the external attachment adapter.
            if (!(await recoveryAuthorityCurrent())) continue;
            result = await adapter.attach({
              sessionId,
              runId,
              reviewId: marker.id,
              callId: freshApproval.approval.callId,
              toolDefinitionRevision: currentRecovery.toolDefinitionRevision,
              durableOperationKey: currentRecovery.durableOperationKey,
              arguments: currentRecovery.arguments,
              journalEntry,
              signal: controller.signal,
            });
          }
          if (!(await recoveryStateCurrent())) continue;
          if (
            result === undefined ||
            result === null ||
            typeof result !== 'object' ||
            result.callId !== freshApproval.approval.callId ||
            result.toolCallId !== freshApproval.approval.callId ||
            result.toolName !== freshApproval.approval.toolName ||
            !Object.prototype.hasOwnProperty.call(result, 'content') ||
            (result.outcome !== 'success' && result.outcome !== 'error')
          )
            continue;
          const resultCheckpointed =
            persistedPeerRecoveryResult(freshSession?.metadata, marker.id) !== undefined ||
            (await persistPeerRecoveryResult(sessionId, marker.id, result, recoveryStateCurrent));
          if (!resultCheckpointed || !(await recoveryStateCurrent())) continue;
          const input: ResolveReviewInput = {
            id: marker.id,
            decision: 'approve',
            principal: currentRecovery.request.principal,
            round: currentRecovery.request.round,
            arguments: currentRecovery.arguments,
            ...(currentRecovery.request.reason === undefined
              ? {}
              : { reason: currentRecovery.request.reason }),
          };
          // COR-2299: scanned as the other approved-call write is, before the row is committed.
          const scannedResult = await scanApprovedToolResult(review, result);
          const materialized = await materializeToolResultAsync(scannedResult);
          const admitted = await admitApprovedToolResultMedia(review, scannedResult, materialized);
          const auditAttachment = buildReviewDecisionAuditRecord(
            review,
            'approve',
            input.principal,
            input.reason,
            [],
            currentRecovery.request.digest,
            await ownerForRecord(runId),
          );
          const committed = await runtime.sessionStore?.update(
            sessionId,
            async (finalSession) => {
              if (finalSession === undefined) return undefined;
              const lease = leaseOf(finalSession.metadata);
              if (
                lease?.['token'] !== token ||
                lease['round'] !== persisted.round ||
                lease['operationKey'] !== currentRecovery.durableOperationKey ||
                typeof lease['expiresAt'] !== 'number' ||
                lease['expiresAt'] <= runtimeServices.clock.now()
              )
                return undefined;
              const finalMarker = readApprovalResolutionStarted(
                finalSession.metadata['approvalResolutionStartedIds'],
              ).find((candidate) => candidate.id === marker.id);
              const currentApproval = persistedApprovalOf(finalSession.metadata, marker.id);
              if (
                finalMarker?.peerRecovery === undefined ||
                finalMarker.peerRecovery.durableOperationKey !==
                  currentRecovery.durableOperationKey ||
                currentApproval === undefined ||
                currentApproval.round !== persisted.round
              )
                return undefined;
              const finalDecision = await reviewDecisions.inspect(currentRecovery.request);
              if (finalDecision.outcome !== 'matching' || finalDecision.recorded) return undefined;
              const recoveredContext = recoveredRequestContextFromMetadata(
                finalSession.metadata,
                runId,
                sessionId,
                finalSession.agentName,
                runtimeServices.clock.now,
              );
              if (recoveredContext === undefined) return undefined;
              if (
                isTransportIssuedAuthority(recoveredContext) &&
                (requestAuthorityValidator === undefined ||
                  !(await requestAuthorityValidator(recoveredContext)))
              )
                return undefined;
              const leases = isJsonObject(finalSession.metadata['approvalPeerRecoveryLeases'])
                ? finalSession.metadata['approvalPeerRecoveryLeases']
                : {};
              const results = isJsonObject(finalSession.metadata['approvalPeerRecoveryResults'])
                ? finalSession.metadata['approvalPeerRecoveryResults']
                : {};
              const pending = isJsonObject(finalSession.metadata['pendingApprovalOverrides'])
                ? finalSession.metadata['pendingApprovalOverrides']
                : {};
              const rounds = isJsonObject(finalSession.metadata['pendingApprovalRounds'])
                ? finalSession.metadata['pendingApprovalRounds']
                : {};
              const resolved = Array.isArray(finalSession.metadata['resolvedReviewIds'])
                ? stringValues(finalSession.metadata['resolvedReviewIds'])
                : [];
              const priorDecisions = isJsonObject(finalSession.metadata['resolvedReviewDecisions'])
                ? finalSession.metadata['resolvedReviewDecisions']
                : {};
              return {
                ...finalSession,
                conversationHistory: resolveToolResult(
                  finalSession.conversationHistory,
                  currentApproval.approval.callId,
                  admitted,
                ),
                metadata: {
                  ...finalSession.metadata,
                  approvalResolutionStartedIds: omitStartedRecord(
                    finalSession.metadata['approvalResolutionStartedIds'],
                    marker.id,
                  ),
                  pendingApprovalOverrides: omitKey(pending, marker.id),
                  pendingApprovalRounds: omitKey(rounds, marker.id),
                  approvalPeerRecoveryResults: omitKey(results, marker.id),
                  approvalPeerRecoveryLeases: omitKey(leases, marker.id),
                  resolvedReviewIds: [...new Set([...resolved, marker.id])],
                  resolvedReviewDecisions: {
                    ...priorDecisions,
                    [marker.id]: {
                      decision: 'approve',
                      principal: input.principal,
                      ...(input.reason === undefined ? {} : { reason: input.reason }),
                    },
                  },
                },
              };
            },
            {
              outbox: reviewAuditOutboxAttachment({
                ...auditAttachment,
                decisionRequest: currentRecovery.request,
                detail: {
                  ...(auditAttachment.detail as Record<string, unknown>),
                  decisionRequest: currentRecovery.request,
                },
              }),
            },
          );
          if (committed === undefined) continue;
          markReviewResolvedLocally(review);
          await releaseDecidedReview(runId, marker.id);
          await recordReviewDecision(review, 'approve', input.principal, input.reason, {
            auditAlreadyAppended: true,
            answerDigest: currentRecovery.request.digest,
          });
          await recordApprovedCall(approvedCallAuditOf(review, persisted.approval, result));
        } finally {
          runtimeServices.timers.clearInterval(renewal);
          await runtime.sessionStore?.update(sessionId, (cleanupSession) => {
            if (cleanupSession === undefined) return undefined;
            const current = leaseOf(cleanupSession.metadata);
            if (current?.['token'] !== token) return undefined;
            const leases = isJsonObject(cleanupSession.metadata['approvalPeerRecoveryLeases'])
              ? cleanupSession.metadata['approvalPeerRecoveryLeases']
              : {};
            return {
              ...cleanupSession,
              metadata: {
                ...cleanupSession.metadata,
                approvalPeerRecoveryLeases: omitKey(leases, marker.id),
              },
            };
          });
        }
      } catch (error) {
        diagnose({
          level: 'warn',
          scope: 'approval-recovery',
          message: `[bureau] Peer approval recovery for "${marker.id}" did not complete; leaving it interrupted.`,
          cause: error,
        });
      }
    }
  }

  function persistedApprovalRunIds(metadata: unknown): Set<string> {
    const metadataRecord =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
    const runIds = new Set<string>();
    const lastRunId = metadataRecord?.['lastRunId'];
    if (typeof lastRunId === 'string') runIds.add(lastRunId);
    const pending = metadataRecord?.['pendingApprovalOverrides'];
    const authorities = metadataRecord?.['lastRequestAuthorities'];
    if (
      pending &&
      typeof pending === 'object' &&
      !Array.isArray(pending) &&
      authorities &&
      typeof authorities === 'object' &&
      !Array.isArray(authorities)
    ) {
      for (const authorityRunId of Object.keys(authorities)) {
        if (
          Object.keys(pending).some((reviewId) =>
            reviewId.startsWith(`approval:${authorityRunId}:`),
          )
        ) {
          runIds.add(authorityRunId);
        }
      }
    }
    return runIds;
  }

  async function restorePendingApprovalStates(
    toolbox: BureauToolbox,
    metadata: unknown,
    runId: string,
    sessionId: string,
    committed?: ReadonlySet<string>,
  ): Promise<void> {
    const restoreApproval = (
      toolbox as unknown as {
        restoreApproval?: (approval: SignedPendingToolApproval) => Promise<void>;
      }
    ).restoreApproval;
    if (!restoreApproval) return;
    const metadataRecord =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
    const overrides = metadataRecord?.['pendingApprovalOverrides'];
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) return;
    const decidedReviewIds = new Set(
      Array.isArray(metadataRecord?.['resolvedReviewIds'])
        ? stringValues(metadataRecord['resolvedReviewIds'])
        : [],
    );
    // A peer approval marker is written after the binding has been consumed by the original
    // process. `restoreApproval` quite correctly refuses consumed bindings, but removing the
    // persisted approval here would also remove the only durable handle the trusted adapter can
    // use to attach to the already-started task.
    const peerRecoveryIds = new Set(
      readApprovalResolutionStarted(
        metadataRecord?.['approvalResolutionStartedIds'] as JSONValue | undefined,
      )
        .filter((record) => record.peerRecovery !== undefined)
        .map((record) => record.id),
    );
    for (const [reviewId, approval] of Object.entries(overrides as Record<string, unknown>)) {
      if (!reviewId.startsWith(`approval:${runId}:`)) continue;
      if (decidedReviewIds.has(reviewId)) continue;
      if (committed !== undefined && !committed.has(reviewId)) continue;
      if (peerRecoveryIds.has(reviewId)) continue;
      if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
        if (!(approval as { approvalBinding?: unknown }).approvalBinding) continue;
        try {
          // COR-1872: the call resumes at the tool version its run recorded, or not at all.
          const unavailable = pinnedToolUnavailable(toolbox, approval);
          if (unavailable !== undefined) {
            // COR-1879: the plugin whose tool the run pinned reports the run it waited on.
            pluginRegistry.notePinnedUnavailable(unavailable.toolId, runId);
            throw unavailable;
          }
          await restoreApproval(approval as SignedPendingToolApproval);
        } catch (error) {
          if (
            !(error instanceof PinnedToolUnavailableError) &&
            !isTerminalApprovalBindingError(error)
          ) {
            throw error;
          }
          if (scheduledFireApprovalRuns.has(runId)) {
            await releaseScheduledFireApproval(runId, reviewId, 'invalid', { sessionId });
          } else {
            invalidApprovalReviewIds.add(reviewId);
            dropPendingApprovalOverride(reviewId);
            await prunePersistedInvalidApprovalReviewStateWithRetry(sessionId, runId, reviewId);
          }
          diagnose({
            level: 'warn',
            scope: 'approval-recovery',
            message:
              `[bureau] Failed to restore approval binding for "${reviewId}"` +
              (error instanceof PinnedToolUnavailableError
                ? ` (${error.reason}: ${error.toolId})`
                : '') +
              '; the affected review will remain unavailable while other runs recover.',
            cause: error,
          });
        }
      }
    }
  }

  /** COR-1620 — the active-skill snapshot of a restored run, read from its session. */
  function readRestoredSkillSnapshot(
    session: { readonly metadata: Record<string, JSONValue> } | undefined,
    runId: string,
    scheduledFire: boolean,
    agentHasSkills = false,
  ): Promise<SkillSnapshot> {
    return scheduledFire
      ? runtime.readCommittedScheduledSkillSnapshot(session, runId, true, agentHasSkills)
      : Promise.resolve(runtime.readSessionSkillSnapshot(session, runId, agentHasSkills));
  }

  /**
   * COR-1620 — the toolbox whose tools decide whether an approval's call is permitted by the
   * run's active skills. A live run's own toolbox is it. One that recovery built (a restored
   * approval's, a replayed fire's, a reattached session run's) is decided under the snapshot read
   * again now, so a failure that has cleared is not held against it: the same
   * toolbox when the snapshot is what it was built with, and one built with the snapshot read now
   * otherwise. When the snapshot cannot be verified, or a stored skill was refused on recovery,
   * or the run has no toolbox of its own and the base toolbox carries no skills, the approval is
   * refused with `CONFLICT`: it never runs without the policy that governed it.
   */
  async function skillPolicyToolboxOf(
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    registered: BureauToolbox | undefined,
  ): Promise<BureauToolbox> {
    const restored = registered === undefined ? undefined : recoveredSkillPolicyOf(registered);
    if (registered !== undefined && restored === undefined) return registered;
    if (review.sessionId === undefined) return registered ?? runtime.baseToolbox;
    const refuse = (reason: string): never => {
      throw new BureauError(
        `Cannot approve: the skill policy that governed this call could not be verified (${reason}).`,
        'CONFLICT',
      );
    };
    const scheduledFire = restored?.scheduledFire ?? scheduledFireApprovalRuns.has(review.runId);
    let snapshot: SkillSnapshot;
    let session: Awaited<ReturnType<NonNullable<typeof runtime.sessionStore>['load']>>;
    try {
      session = await runtime.sessionStore?.load(review.sessionId);
      snapshot = await readRestoredSkillSnapshot(
        session,
        review.runId,
        scheduledFire,
        agentSkillsRun(restored?.sessionAgent?.options.hooks) !== undefined,
      );
    } catch (error) {
      return refuse(`its snapshot could not be read: ${serializeUnknownError(error)}`);
    }
    if (snapshot.status === 'unverifiable') return refuse(snapshot.reason);
    const records = snapshot.records ?? [];
    if (registered === undefined || restored === undefined) {
      if (records.length > 0) {
        return refuse('the run has no toolbox of its own to enforce its active skills');
      }
      return runtime.baseToolbox;
    }
    if (restored.recoveredCleanly && JSON.stringify(records) === restored.recordsKey) {
      return registered;
    }
    // An agent's skill client carries the run's active set, so a policy read again is decided on
    // a client of its own: reusing the restored one would add to the set it already holds.
    let policyAgent = restored.sessionAgent;
    if (agentSkillsRun(policyAgent?.options.hooks) !== undefined) {
      const resolved = await resolveRecoveredSessionAgent(
        restored.agentName,
        review.runId,
        session?.metadata ?? {},
        review.sessionId,
      );
      if (resolved === 'unavailable') return refuse('its agent can no longer be resolved');
      policyAgent = resolved;
    }
    const policyRuntime = await runtime.createRunRuntime(
      {
        message:
          typeof session?.metadata['lastUserMessage'] === 'string'
            ? session.metadata['lastUserMessage']
            : '',
        sessionId: review.sessionId,
        runId: review.runId,
        agentName: restored.agentName,
        requestContext: runRequestContexts.get(review.runId),
      },
      {
        sessionAgent: policyAgent,
        sessionMetadata: session?.metadata,
        initialActiveSkillRecords: records,
        memoryOwner: resolveRunMemoryOwner(session?.metadata ?? {}, review.runId),
      },
    );
    const recovery = await policyRuntime.skillsRecovered;
    if (recovery.refused.length > 0) {
      return refuse(`a stored skill was refused on recovery: ${recovery.refused.join(', ')}`);
    }
    return policyRuntime.toolbox;
  }

  /**
   * COR-1577 — the catalog agent a recovered session run belongs to, and `'unavailable'` when the agent cannot be resolved, which is reported rather than
   * thrown so one run's lost agent never stops the rest of recovery.
   */
  async function resolveRecoveredSessionAgent(
    agentName: string,
    runId: string,
    metadata: Record<string, JSONValue>,
    sessionId: string,
  ): Promise<SessionAgentRun | undefined | 'unavailable'> {
    if (agentName === BUREAU_AGENT_NAME) {
      // COR-323 — the implicit Bureau-wide agent no longer exists: a run stored under it is
      // reported, not resumed on something it never named.
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message:
          `[bureau] Run "${runId}" belongs to the implicit "${BUREAU_AGENT_NAME}" agent, which ` +
          'no longer exists; it is not resumed.',
      });
      return 'unavailable';
    }
    // COR-1524: the definition THIS run started with. A session's metadata names only its latest
    // run's, and a session's runs may be of different agents, so the run's own reference decides
    // and the session's hash is what an older record without one falls back to.
    const reference = await fileAgents?.snapshots.reference(runId);
    const ownReference =
      reference !== undefined && reference.id === agentName ? reference : undefined;
    const recordedHash =
      ownReference === undefined
        ? metadata[SESSION_AGENT_DEFINITION_HASH_METADATA_KEY]
        : ownReference.hash;
    const resolution = await runtime.resolveSessionAgentRun(
      agentName,
      runId,
      resolveSessionOwner(metadata),
      {
        agentDefinitionHash: typeof recordedHash === 'string' ? recordedHash : undefined,
        // COR-1584: the revision the run's own reference recorded. Only a reference written before
        // references named one falls back to the session's metadata, which names its latest run's.
        definitionRevision:
          ownReference?.definitionRevision ?? sessionRecordedRevision(metadata, recordedHash),
      },
      { sessionId, metadata },
    );
    if (resolution.status === 'resolved') return resolution.run;
    diagnose({
      level: 'warn',
      scope: 'recovery',
      message:
        `[bureau] Run "${runId}" belongs to catalog agent "${agentName}", which could not be ` +
        `resolved (${resolution.status}); its restored state stays unavailable.`,
    });
    return 'unavailable';
  }

  async function restoreTerminalReviewSession(
    session: Pick<AgentSession, 'id' | 'agentName' | 'metadata' | 'updatedAt'>,
    restoredRunId?: string,
    committed?: ReadonlySet<string>,
  ): Promise<void> {
    const runId = restoredRunId ?? session.metadata['lastRunId'];
    if (
      typeof runId !== 'string' ||
      (runId === session.metadata['lastRunId'] && session.metadata['lastRunStatus'] === 'running')
    )
      return;
    const hasPendingOverride = Object.keys(
      (session.metadata['pendingApprovalOverrides'] as Record<string, unknown> | undefined) ?? {},
    ).some((reviewId) => reviewId.startsWith(`approval:${runId}:`));
    if (!hasPendingOverride) return;

    const requestContext = recoveredRequestContextFromMetadata(
      session.metadata,
      runId,
      session.id,
      session.agentName,
      runtimeServices.clock.now,
    );
    if (!requestContext) {
      const overrides = session.metadata['pendingApprovalOverrides'];
      if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
        for (const reviewId of Object.keys(overrides)) {
          if (!reviewId.startsWith(`approval:${runId}:`)) continue;
          invalidApprovalReviewIds.add(reviewId);
          dropPendingApprovalOverride(reviewId);
          await prunePersistedInvalidApprovalReviewStateWithRetry(session.id, runId, reviewId);
          diagnose({
            level: 'warn',
            scope: 'approval-recovery',
            message:
              `[bureau] Failed to restore request authority for "${reviewId}"; ` +
              'the affected review will remain unavailable while other runs recover.',
          });
        }
      }
      terminalReviewSessions.delete(runId);
      return;
    }
    const recoveredAgentName = requestContext.agentId ?? session.agentName;
    // COR-1577 — a named run's approvals resume against that agent's own tools. COR-323: so do a
    // schedule fire's, which runs as its named catalog agent.
    const scheduledFire = isScheduledFireAuthority(session.metadata, runId);
    const recoveredSessionAgent = await resolveRecoveredSessionAgent(
      recoveredAgentName,
      runId,
      session.metadata,
      session.id,
    );
    if (recoveredSessionAgent === 'unavailable') {
      terminalReviewSessions.delete(runId);
      return;
    }
    // COR-1613: the approval is decided under the run's active skills as of its last committed
    // snapshot, as the run that raised it would decide it now. A fire's are the ones its
    // committed steps recorded; a session run's are the last snapshot of its session. COR-1620:
    // a snapshot that cannot be verified restores no skills, and each approve reads it again.
    const skillSnapshot = await readRestoredSkillSnapshot(
      session,
      runId,
      scheduledFire,
      agentSkillsRun(recoveredSessionAgent?.options.hooks) !== undefined,
    );
    const initialActiveSkillRecords =
      skillSnapshot.status === 'verified' ? skillSnapshot.records : undefined;
    const runRuntime = await runtime.createRunRuntime(
      {
        message:
          typeof session.metadata['lastUserMessage'] === 'string'
            ? session.metadata['lastUserMessage']
            : '',
        sessionId: session.id,
        runId,
        agentName: recoveredAgentName,
        requestContext,
      },
      {
        sessionAgent: recoveredSessionAgent,
        sessionMetadata: session.metadata,
        initialActiveSkillRecords,
        memoryOwner: resolveRunMemoryOwner(session.metadata, runId),
      },
    );
    // The skills must be back before a call is decided under their policy.
    const skillRecovery = await runRuntime.skillsRecovered;
    recordRecoveredSkillPolicy(runRuntime.toolbox, {
      scheduledFire,
      agentName: recoveredAgentName,
      sessionAgent: recoveredSessionAgent,
      recordsKey: JSON.stringify(initialActiveSkillRecords ?? []),
      recoveredCleanly: skillSnapshot.status === 'verified' && skillRecovery.refused.length === 0,
    });
    const terminalReviewSession = terminalReviewSessions.get(runId);
    if (terminalReviewSession) {
      terminalReviewSessions.set(runId, {
        ...terminalReviewSession,
        agentName: recoveredAgentName,
      });
    }
    runRequestContexts.set(runId, requestContext);
    runToolboxesByRunId.set(runId, runRuntime.toolbox);
    if (scheduledFire) adoptRestoredScheduledFire(scheduledFireReviewState, runId);
    await restorePendingApprovalStates(
      runRuntime.toolbox,
      session.metadata,
      runId,
      session.id,
      committed,
    );
    if (
      !Array.from(pendingApprovalOverrides.keys()).some((reviewId) =>
        reviewId.startsWith(`approval:${runId}:`),
      )
    ) {
      terminalReviewSessions.delete(runId);
      runRequestContexts.delete(runId);
      runToolboxesByRunId.delete(runId);
      releaseRunScope(runId);
      releaseScheduledFireReviews(scheduledFireReviewState, runId);
      unfollowFireReviewsWhenNoneRemain(runId);
    } else if (scheduledFire) {
      // COR-1621: a restored approval of a fire can be closed by a peer, whose closing is in the
      // fire's history.
      followFireReviews(runId);
    }
  }

  function disposeRegisteredStreamListeners(listeners: Array<() => void>): void {
    while (listeners.length > 0) {
      const disposeListener = listeners.pop();
      disposeListener?.();
    }
  }

  /**
   * AB-15/AB-22: `bureau.run(name, input, options?)` — synchronous dispatch
   * to a named catalog agent. Independent of `createRunFromRequest` below:
   * this drives the catalog agent's OWN generate/tools/durability, not
   * `runtime`'s bureau-level composition.
   *
   * Synchronous throws are limited to unknown `name`, a disposed bureau, and
   * malformed `input`/`options` (validated up front, before any async work).
   * When this bureau has a durable engine composed AND the named agent
   * exposes the definition-resolution capability (AB-21's
   * `OPERATIVE_RESOLVE_RUN_OPTIONS`), the run is driven through that engine;
   * otherwise the agent's own in-memory `run()` is used directly. Either way
   * this function itself returns synchronously — the async work (resolving
   * run options, or awaiting the durable engine's setup) is deferred behind
   * `createDeferredAgentRun`.
   *
   * AB-240: the durable branch checkpoints the run through the engine (it is
   * discoverable via `bureau.listDurableRuns()` mid-flight — see
   * `bureau-run.test.ts`) AND persists its own recovery record — agent name,
   * `readGenerationProfile(agent).revision`, and the original `input` — via
   * `runtime.persistCatalogRunRecoveryRecord`, independent of the bureau
   * session record `createRunFromRequest` writes (a catalog dispatch has no
   * request context to draw an authority record from, and never owns a
   * bureau session). A process restart reattaches through
   * `runtime-composition.ts`'s `resolveRunServices` catalog branch, which
   * resolves that record back through `runtime.setCatalogAgentRunOptionsResolver`
   * — i.e. the SAME catalog agent's `OPERATIVE_RESOLVE_RUN_OPTIONS` a live
   * dispatch would have used, never the Bureau's default runtime
   * composition.
   */
  /**
   * AB-22 review fix: `catalogRuns` (declared near `activeRuns` above) needs
   * every handle `runAgent` hands back, on both the durable and direct
   * dispatch branches, so `dispose()` can abort a catalog run still in
   * flight the same way it already aborts bureau-owned `ActiveRun`s.
   * Untracked on terminal settlement so a long-lived bureau does not retain
   * one entry per historical run forever. The `store` entry such a run now
   * also has (COR-1302, `registerCatalogRun`) is released the same way, when
   * the run settles.
   *
   * This does NOT also untrack `runAttribution` (review finding
   * PRRT_kwDORvupsc6gUhzr): a settled catalog run's attribution must
   * survive its own settlement, matching `Bureau.createRun`'s session
   * record, which likewise lives until an explicit `deleteRun` — the
   * `eventHistory` authorization test above (`bureau-run.test.ts`) reads
   * `runAttribution` back AFTER `await run.result()` and requires it still
   * be there. `runAttribution.delete` for a catalog run's minted `runId`
   * only ever runs for a run that never actually dispatched (the
   * `AgentContractError` fallback and non-`AgentContractError` resolver
   * failure paths below), never for one that reached the durable engine and
   * settled. Catalog runs have no `deleteRun` equivalent to bound this the
   * way a bureau session's attribution is bounded: COR-1302 puts a live
   * catalog run on `store`, but releases it there as it settles without
   * touching its attribution, so `eventHistory` still resolves the settled
   * run for its owner. Giving catalog runs their own deletion surface remains
   * its own design problem, outside COR-1302 as it was outside AB-241.
   */

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
    if (!liveFramesSubscribed) bootFrameRunIds.add(runId);
    if (sessionIncarnation !== undefined) runSessionIncarnations.set(runId, sessionIncarnation);

    const recoveredRun = reattachDurableActiveRun(
      {
        engine: runtime.durable!.engine,
        checkpointStore: runtime.durable!.checkpointStore,
        // COR-625: same terminal checkpoint-retention step as the live path.
        // A run recovered after a restart still owes its cleanup.
        ...(durableTerminalCleanup() ? { terminalCleanup: runTerminalCheckpointCleanup } : {}),
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
        auditTrailInstance?.record({
          runId,
          type: 'run.recovered',
          detail: { sessionId },
          principal: RECOVERY_ACTOR,
        }),
      ),
    );
    restoreResolvedReviewIds(sessionMetadata, runId);
    restorePendingApprovalOverrides(sessionMetadata, runId);

    // AB-96 — wire the same versioned run-envelope forwarder the live-run path
    // uses. The recovered run's event surface is installed during Weft's awaited
    // recovery hook, before resumed user code advances, and `recoveredRun`'s
    // `addEventListener` is bound to that identical emitter — so subscribing
    // here surfaces every `step`/`tool-pre`/`tool-post`/notification frame a
    // resumed run produces, not just its terminal `run-finished`.
    const disposeRecoveredRunFrameForwarder = createRunFrameForwarder(
      runId,
      recoveredRun,
      (frame) => emitLiveFrame({ type: 'run-envelope', runId, frame }),
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
    detachBestEffortPromise(recoveredRun.result.catch(() => runTerminalCheckpointCleanup(runId)));
    // As for a fresh run: a handle that settles while the store still says
    // `running` (rejected, or abandoned to another owner) no longer drives
    // the run, so steering liveness asks the engine instead.
    detachBestEffortPromise(
      recoveredRun.result
        .catch(() => undefined)
        .finally(() => {
          abandonTerminalSessionRecord(runId);
          settleAbandonedRun(sessionId, runId, recoveredRun);
        }),
    );

    // Steered, and so counted as live for steering, only with a gate: the
    // incarnation alone (still passed to fence the terminal save) does not
    // make a run read commands or log its end.
    if (sessionIncarnation !== undefined && steeringGate !== undefined) {
      steeringRunIncarnations.set(runId, sessionIncarnation);
      pollSessionSteering(sessionId, sessionIncarnation, runId);
    }
    if (steeringGate !== undefined) {
      recoveredRun.addEventListener(SteeringAppliedEvent.type, (event) => {
        logRunBoundarySteering(sessionId, steeringGate, {
          type: 'applied',
          runId: event.effective.appliedAtRunId,
          configVersion: event.effective.configVersion,
          now: event.effective.appliedAt,
        });
      });
      const endSteering = (): void => {
        logRunBoundarySteering(sessionId, steeringGate, {
          type: 'run-ended',
          runId,
          now: runtimeServices.clock.nowISO(),
        });
      };
      recoveredRun.once('run.completed', endSteering);
      recoveredRun.once('run.aborted', endSteering);
    }

    expectTerminalSessionRecord(runId);
    recoveredRun.once('run.completed', (event) => {
      activeRuns.delete(recoveredRun);
      disposeRecoveredRunFrameForwarder();
      disposeRecoveredRunEventFeed();
      // COR-625: a terminal transition owes this run one checkpoint-
      // retention step whether or not anyone ever calls `closed()`.
      // Memoized per run id, so this and `closed()`'s own fold resolve the
      // SAME step. Fire-and-forget: the step records its own
      // acknowledgement durably and never rejects.
      void runTerminalCheckpointCleanup(runId);
      const completedConversation = event.conversation;
      const finishReason = event.finishReason;
      const lastRunStatus = isFailureFinishReason(finishReason) ? 'error' : 'completed';
      const lastError = isFailureFinishReason(finishReason) ? event.error : undefined;

      const report = buildTerminalReportFromCompletedEvent(runId, event);
      emitLiveFrame({
        type: 'run-envelope',
        runId,
        frame: createRunFinishedFrame({ runId, report }, runtimeServices.clock.now),
      });

      persistTerminalSession(
        () =>
          saveRunTerminalSession(runId, sessionId, completedConversation, {
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
      void runTerminalCheckpointCleanup(runId);
      const abortedConversation = event.conversation;

      const report = buildTerminalReportFromAbortedEvent(runId, {
        usage: event.usage,
        costEstimate: event.costEstimate,
        reason: event.reason,
        error: event.error,
        steps: store.getRun(runId)?.steps ?? [],
        conversation: event.conversation,
      });
      emitLiveFrame({
        type: 'run-envelope',
        runId,
        frame: createRunFinishedFrame({ runId, report }, runtimeServices.clock.now),
      });

      persistTerminalSession(
        // The reattach adapter reconstructs the abort RunResult from the run's
        // final checkpoint and threads it into RunAbortedEvent.conversation, so
        // use that directly instead of re-fetching the checkpoint snapshot.
        () =>
          saveRunTerminalSession(runId, sessionId, abortedConversation, {
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
    seedRunSeqGeneration(runId);
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
      currentRecoveryPerRunFailures?.push({ runId, reason: classification.rejection });
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
      await runHumanWaits.attach(
        info.workflowId,
        { agentName: info.input.agentName },
        info.services as DurableRunDeps,
      );
      // COR-1524: a recovered run is in no store and has no handle of its own, so its snapshot
      // reference settles from the catalog settlement hook, as it ends (see the subscription
      // beside the hook's creation).
      void info.handle.result().then(
        () => runHumanWaits.forget(info.workflowId),
        () => runHumanWaits.forget(info.workflowId),
      );
      catalogSettlements.follow(
        monitorRecoveredCatalogRun(
          info.handle,
          info.input.agentName,
          diagnose,
          (settlement) => catalogRunSettlements.publish(settlement),
          catalogDurableEnd,
          catalogSettlements,
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
    const recoveredSteeringGate = await recoverRunSteering(
      info.input.sessionId,
      loadedSession,
      info.workflowId,
      services,
    );
    // The incarnation `reattachRecoveredRun` records for the run below, read
    // here before it has.
    await attachRecoveredSessionInput(
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
    await restorePendingApprovalStates(
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
    const goalRecovery = await goalsComposition.recoverAtBoot();
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
    if (eventHistoryInstance === undefined || record.settled === undefined) return;
    const payload: ScheduleFireSettledPayload = {
      runId: record.taskId,
      status: record.settled.status,
    };
    const endedAt = Date.parse(record.settled.at);
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        await eventHistoryInstance.record(
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

  /**
   * Boot-single-shot: called at most once per bureau, either immediately
   * during `createBureau()` or once from the deferred-authority-validator
   * path (never both — `durableRecoveryStarted` guards it). Resolves a
   * {@link BureauRecoveryReport} aggregating this one pass's outcome; never
   * rejects (AB-242's decision record — recovery failure stays diagnostic,
   * `createBureau()` never rejects on it, in whole or in part).
   */
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
      await abandonedTaskSweeper.run();
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
        await closeOpenReviewsOfCanceledFire(taskId).catch((error: unknown) => {
          diagnose({
            level: 'error',
            scope: 'recovery',
            message: `[bureau] Could not close the reviews of canceled schedule fire "${taskId}": ${serializeUnknownError(error)}`,
            cause: error,
          });
        });
      }
      await tasks.recordSettled(taskId, {
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
    for (const record of await tasks.unsettled()) {
      if (store.getRun(record.taskId) !== undefined) continue;
      await settle(record.taskId, await durable.engine.get(record.taskId));
    }
    // COR-1946: what the durable state did not settle, and no durable workflow records, belongs to
    // the process that admitted it.
    await abandonedTaskSweeper.run();
    // COR-1594: a fire whose settlement was written but whose history event never was, because its
    // process died between the two, would leave a stream open on another process for ever. The
    // event is deduplicated per fire, so the ones that were appended are skipped by their marker.
    // A read that fails here is reported and leaves the pass to the next boot, and the steps after
    // it still run. It is a plain `try`, not a wrapped call, so the boot takes no extra turn.
    if (eventHistoryInstance !== undefined) {
      try {
        // Event retention removes an event together with its deduplication marker, so a fire
        // settled before its cutoff has neither, by design, and is not announced again at every
        // boot. Under `'forever'` nothing is retired, so there is no bound.
        const cutoff = eventRetentionCutoff();
        for (const record of await tasks.settledFires()) {
          if (cutoff !== undefined && Date.parse(record.settled?.at ?? '') < cutoff) continue;
          const owner = { kind: 'run', id: record.taskId } as const;
          if (
            await eventHistoryInstance.wasRecorded(
              owner,
              SCHEDULE_FIRE_SETTLED_EVENT_KIND,
              scheduleFireSettledDedupeKey(record.taskId),
            )
          ) {
            continue;
          }
          try {
            await appendFireSettledEvent(record);
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
    await retryCanceledFireCloses().catch((error: unknown) => {
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
        if ((await tasks.record(summary.id)) !== undefined) continue;
        const loaded = await runtime.loadCatalogRunRecoveryRecord(summary.id);
        const createdAt = new Date(summary.createdAt).toISOString();
        if (loaded.status === 'found' && loaded.record.taskOrigin !== undefined) {
          // The claim stores the origin the run's start recorded: the task is rebuilt from it.
          await tasks.recordAdmission(
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
        if (await isChildRun(summary.id)) continue;
        if (
          loaded.status !== 'found' ||
          loaded.record.goalAttempt !== undefined ||
          loaded.record.workflowStep !== undefined
        ) {
          continue;
        }
        await tasks.recordAdmission({
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

  async function recoverDurableRuns(): Promise<BureauRecoveryReport> {
    // COR-1421 — retain every live frame for the first subscriber while the
    // pass runs.
    recoveryPassActive = true;
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
      const repaired = taskResyncInstance?.repairAll().then(
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
        taskResyncBootPass = Promise.all([taskResyncBootPass, repaired]).then(() => undefined);
      }
      // COR-1945: a failed run whose process died after its settlement committed and before its
      // notification was written, or whose notification write failed, still has its outbox entry.
      // Held in the same boot pass, so the boot takes no extra turn and `shutdown()` waits for it.
      const notificationsRepaired = notificationsComposition.repair().then(
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
      taskResyncBootPass = Promise.all([taskResyncBootPass, notificationsRepaired]).then(
        () => undefined,
      );
      return report;
    } finally {
      recoveryPassActive = false;
    }
  }

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
      await drainOutbox();
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
      await childTopology.prepareRecovery();
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Could not load child relationships for recovery; durable run recovery continues: ${serializeUnknownError(error)}`,
        cause: error,
      });
    }

    if (!runtime.durable) {
      await childTopology.reconcileRecovery();
      // A goal's stored record is settled without an engine too: a marked
      // cancellation is committed, and what cannot be read back is reported.
      const goalFailures = dedupeRecoveryPerRunFailures(await recoverGoalsAtBoot());
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
      const failedCancellations = await sweepSuspendedSchedulerRuns(durable.engine);
      if (failedCancellations > 0) {
        // The sweep itself didn't throw, but real collision-risk residue
        // survived it (each rejection already diagnosed individually inside
        // sweepSuspendedSchedulerRuns) — an outcome of 'clean' would
        // misreport that. See sweepSuspendedSchedulerRuns's own doc comment.
        sweepFailure = {
          message: `${failedCancellations} suspended scheduler run(s) could not be cancelled during the sweep.`,
        };
        currentRecoverySweepFailure = sweepFailure;
      }
    } catch (error) {
      sweepFailure = { message: serializeUnknownError(error) };
      currentRecoverySweepFailure = sweepFailure;
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
    currentRecoveryPerRunFailures = [];
    currentRecoverySkippedRuns = [];

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
      currentRecoverySkippedRuns?.push({ runId: event.workflowId, type: event.workflowType });
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message: `[bureau] Left run "${event.workflowId}" of workflow type "${event.workflowType}" as it is: the type is not registered, so it will be recovered by a boot that registers it.`,
      });
    };
    durable.engine.addEventListener(WorkflowRecoverySkippedEvent.type, onRecoverySkipped);
    try {
      recoveredWorkflowHandler.resolve(onRecoveredWorkflow);
      const handles = await durable.engine.recoverAll({
        onRecoveredWorkflow,
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
            dispatchRecoveryClassification(handle.id, {
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
        if (await goalsComposition.ownsWorkflow(handle.id)) continue;

        // COR-1527: an instance of a workflow file carries a document's trigger, not an agent
        // run's input, so the classification below would read it as a foreign run and cancel it.
        // The workflow runtime registered its revision before this recovery; the engine resumes it.
        // COR-2009: a schedule tick carries what it records, and is the Bureau's own; the engine
        // resumes it too. Its id says what it is, so this costs no read.
        if (isScheduleTickRunId(handle.id)) continue;
        if (workflowRuntime !== undefined) {
          const instance = await durable.engine.get(handle.id);
          if (instance !== null && (await workflowRuntime.isWorkflowType(instance.type))) continue;
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
          classification = await skipRunFinishedByPeer(
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
        dispatchRecoveryClassification(handle.id, classification);
        dispatchRecoveryLeaseReleasedIfAny(handle.id);

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
              const reattachedSessionAgent = await resolveRecoveredSessionAgent(
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
            await restorePendingApprovalStates(
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
              fallbackSteeringGate = await recoverRunSteering(
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
            await attachRecoveredSessionInput(
              ownedSessionId!,
              handle.id,
              recoveredServices,
              classifiedIncarnation,
            );
          }
          reattachRecoveredRun(
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
          await reconstructHumanWaitReviewIfParked(handle.id);
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
                await settleSessionInputsAfterRunEnd(ownedSessionId, handle.id);
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
      await childTopology.reconcileRecovery();
      // COR-851 — every unfinished goal, now that its controller and its
      // attempt's run have both been resumed by `recoverAll()` above. Recovery
      // reports what it could not do rather than throwing.
      currentRecoveryPerRunFailures?.push(...(await recoverGoalsAtBoot()));
    }

    // COR-1934 — a deleted chat whose content purge a crash or a failure stopped.
    try {
      await chatContentPurge.sweep();
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
      await sessionInputSettlement?.sweep();
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Boot recovery could not sweep the pending session input: ${serializeUnknownError(error)}`,
        cause: error,
      });
    }

    const perRunFailures = dedupeRecoveryPerRunFailures(currentRecoveryPerRunFailures ?? []);
    const skippedRuns = currentRecoverySkippedRuns ?? [];
    currentRecoveryPerRunFailures = undefined;
    currentRecoverySweepFailure = undefined;
    currentRecoverySkippedRuns = undefined;
    const outcome: BureauRecoveryReport['outcome'] =
      sweepFailure || perRunFailures.length > 0 || skippedRuns.length > 0 ? 'partial' : 'clean';
    return {
      outcome,
      ...(sweepFailure ? { sweepFailure } : {}),
      perRunFailures,
      skippedRuns,
    };
  }

  /**
   * COR-1588 — the one reader of what a held run is attributed to: its recorded attribution,
   * with a `principal` it lacks filled from the handle's liveness owner. A live `bureau.run()`
   * dispatch that is not durable seeds no attribution, but its handle's liveness snapshot carries
   * the principal it was given. `runOwner` and every serialized `principal` (`RunSummary`,
   * `RunDetail`) read it here, so the owner the AG-UI mount authorizes on is the owner the run
   * reports.
   */
  function attributionOf(runId: string): RunAttribution | undefined {
    const recorded = runAttribution.get(runId);
    if (recorded?.principal !== undefined) return recorded;
    return recorded;
  }

  /**
   * COR-718 — the owner of record of a run: where it already lives
   * (`runAttribution`, rehydrated from the session's `lastRunOwningPrincipals`
   * after a restart), or a child run's own record. `undefined` for an id that
   * names no run this Bureau knows.
   */
  async function runOwner(runId: string): Promise<string | undefined> {
    if (runAttribution.get(runId) !== undefined || store.getRun(runId) !== undefined) {
      return ownerOrLocal(attributionOf(runId)?.principal);
    }
    const child = await childTopologyStore.get(runId);
    if (child !== undefined) return ownerOrLocal(child.principal);
    // A schedule fire's attribution is released when the fire settles. Its owner is
    // then the one its workflow was started with, which is the schedule's: the
    // engine keeps the fire's `ScheduledAgentRunInput`, `principal` included.
    if (!runtime.durable) return undefined;
    const fire = await runtime.durable.engine.get(runId);
    // COR-1527: an instance of a workflow file belongs to the deployment's owner of record, as the
    // file does.
    if (
      fire !== null &&
      fire !== undefined &&
      workflowRuntime !== undefined &&
      (await workflowRuntime.isWorkflowType(fire.type))
    ) {
      const input = fire.input;
      const origin =
        typeof input === 'object' && input !== null && 'origin' in input ? input.origin : undefined;
      if (isTaskOrigin(origin) && origin.kind === 'person') return origin.principal;
      return workflowRuntime.workflows.owner;
    }
    if (fire !== null && isScheduledAgentRunInput(fire.input)) {
      return ownerOrLocal(fire.input.principal);
    }
    // COR-1580: a session run another process created after this one booted. Its owner is the one
    // its session recorded for it, found through the session its durable input names.
    const sessionRunOwner = await persistedSessionRunOwner(runId, fire?.input);
    if (sessionRunOwner !== undefined) return sessionRunOwner;
    // COR-1579: a `bureau.run()` run another process holds is in none of the maps above, but its
    // durable recovery record names who started it.
    const catalog = await runtime.classifyCatalogRecoveredRun(runId);
    return catalog.attribution === undefined
      ? undefined
      : ownerOrLocal(catalog.attribution.principal);
  }

  /** The session a durable run's input names, as a session run's `createRun` recorded it. */
  function durableInputSessionId(input: unknown): string | undefined {
    const sessionId =
      typeof input === 'object' && input !== null
        ? (input as { sessionId?: unknown }).sessionId
        : undefined;
    return typeof sessionId === 'string' ? sessionId : undefined;
  }

  /**
   * COR-1580 — the owner a session recorded for one of its runs (`lastRunOwningPrincipals`), when
   * the run's durable input names that session; `undefined` when either is missing.
   */
  async function persistedSessionRunOwner(
    runId: string,
    input: unknown,
  ): Promise<string | undefined> {
    const sessionId = durableInputSessionId(input);
    if (sessionId === undefined || !runtime.sessionStore) return undefined;
    const session = await runtime.sessionStore.load(sessionId);
    if (session === undefined) return undefined;
    const principal = resolvePersistedRunOwningPrincipal(session.metadata, runId);
    if (principal === undefined) return undefined;
    // A deleted run keeps its session entry (so its `run.removed` event stays owned), but it has
    // no owner to authorize against: it fails closed as AB-313 decided, wherever it was deleted.
    const removed = await eventHistoryInstance?.latestDeletionMarker({ kind: 'run', id: runId });
    return removed === undefined ? ownerOrLocal(principal) : undefined;
  }

  /** COR-718 — the owner a schedule recorded in its `ScheduledAgentRunInput.principal`. */
  async function scheduleOwner(scheduleId: string): Promise<string | undefined> {
    if (!runtime.durable) return undefined;
    // COR-1527: a workflow file's schedule belongs to the deployment's owner of record.
    if (workflowRuntime !== undefined && (await workflowRuntime.scheduleExists(scheduleId))) {
      return workflowRuntime.workflows.owner;
    }
    const bytes = await runtime.durable.engine.storage.get(KEYS.schedule(scheduleId));
    if (!bytes) return undefined;
    const state: unknown = decode(bytes);
    const input =
      typeof state === 'object' && state !== null
        ? (state as { input?: unknown }).input
        : undefined;
    // Only an agent schedule has an owner; the local default applies to one that
    // names no principal, never to some other workflow's schedule on the same engine.
    return isScheduledAgentRunInput(input) ? ownerOrLocal(input.principal) : undefined;
  }

  /**
   * The stored input of an agent schedule, or `undefined` when there is no such schedule, when it
   * is a workflow file's (which runs no agent of its own), or when no durable engine is composed.
   */
  async function readScheduledAgentInput(
    scheduleId: string,
  ): Promise<ScheduledAgentRunInput | undefined> {
    if (!runtime.durable) return undefined;
    if (workflowRuntime !== undefined && (await workflowRuntime.scheduleExists(scheduleId))) {
      return undefined;
    }
    const bytes = await runtime.durable.engine.storage.get(KEYS.schedule(scheduleId));
    if (!bytes) return undefined;
    const state: unknown = decode(bytes);
    const input =
      typeof state === 'object' && state !== null
        ? (state as { input?: unknown }).input
        : undefined;
    return isScheduledAgentRunInput(input) ? input : undefined;
  }

  /**
   * The agent an agent schedule runs, read from the stored input beside the owner. Only the name
   * leaves here: the input's text is {@link getScheduleInputPreview}'s, and its session stays in
   * storage. A workflow file's schedule runs no agent of its own, so it has none.
   */
  async function getScheduleAgentName(scheduleId: string): Promise<string | undefined> {
    const stored = await readScheduledAgentInput(scheduleId);
    return stored?.agentName;
  }

  /**
   * The start of the text an agent schedule sends each fire, at most 500 characters and ending in
   * `…` when it was cut, so a schedule can be told by what it says (see
   * {@link scheduleInputPreview}); an input of media alone has none, and its schedule has no
   * preview.
   */
  /** COR-2009 — why a workflow file's schedule won't start: its file stopped parsing. */
  async function getScheduleBlocker(
    scheduleId: string,
  ): Promise<WorkflowScheduleBlocker | undefined> {
    return workflowRuntime?.scheduleBlocker(scheduleId);
  }

  async function getScheduleInputPreview(scheduleId: string): Promise<string | undefined> {
    const stored = await readScheduledAgentInput(scheduleId);
    if (stored === undefined) return undefined;
    return scheduleInputPreview(stored.input);
  }

  /** Whether every fire of an agent schedule continues one session; only the boolean leaves here. */
  async function getScheduleContinuesChat(scheduleId: string): Promise<boolean | undefined> {
    const stored = await readScheduledAgentInput(scheduleId);
    if (stored === undefined) return undefined;
    return stored.sessionId !== undefined;
  }

  async function sessionOwner(sessionId: string): Promise<string | undefined> {
    const session = await runtime.sessionStore?.load(sessionId);
    return session === undefined ? undefined : resolveSessionOwner(session.metadata);
  }

  async function ownerOf(resource: OwnedResource): Promise<string | undefined> {
    switch (resource.kind) {
      case 'run':
        return runOwner(resource.id);
      case 'session':
        return sessionOwner(resource.id);
      case 'goal': {
        const goal = await goalsComposition.goals.get(resource.id);
        return goal === undefined ? undefined : ownerOrLocal(goal.principal);
      }
      case 'schedule':
        return scheduleOwner(resource.id);
      case 'review': {
        const review = await getReview(resource.id);
        return review === undefined ? undefined : runOwner(review.runId);
      }
      case 'audit': {
        const { runId, detail } = resource;
        if (runId.startsWith(AUDIT_SCHEDULE_OWNER_PREFIX)) {
          return scheduleOwner(runId.slice(AUDIT_SCHEDULE_OWNER_PREFIX.length));
        }
        if (runId === AUDIT_HOST_OWNER_ID) {
          // COR-2009 — the host has no owner field: its own records (`host.started`) belong to the
          // deployment's owner, so the owner's audit log lists "Server started".
          return ownerOrLocal(undefined);
        }
        if (runId.startsWith(AUDIT_AGENT_OWNER_PREFIX)) {
          // COR-1526 — an agent file has no owner field: it belongs to the deployment's owner.
          return ownerOrLocal(undefined);
        }
        if (runId.startsWith(AUDIT_WORKER_DEPLOYMENT_OWNER_PREFIX)) {
          // COR-1813 — a worker deployment has no owner field: it belongs to the deployment's owner.
          return ownerOrLocal(undefined);
        }
        if (runId.startsWith(AUDIT_SKILL_SOURCE_OWNER_PREFIX)) {
          // COR-1818 — a skill source has no owner field: the owner who changed its trust is
          // recorded on the entry, and a record without one belongs to the deployment's owner.
          const recorded =
            typeof detail === 'object' && detail !== null
              ? (detail as { owner?: unknown }).owner
              : undefined;
          return typeof recorded === 'string' ? recorded : ownerOrLocal(undefined);
        }
        if (runId.startsWith(AUDIT_TOOL_SOURCE_OWNER_PREFIX)) {
          // COR-1930 — a saved tool source has no owner field: the owner who changed it is
          // recorded on the entry, and a record without one belongs to the deployment's owner.
          const recorded =
            typeof detail === 'object' && detail !== null
              ? (detail as { owner?: unknown }).owner
              : undefined;
          return typeof recorded === 'string' ? recorded : ownerOrLocal(undefined);
        }
        if (runId.startsWith(AUDIT_WORKFLOW_OWNER_PREFIX)) {
          // COR-1529 — a workflow file has no owner field: it belongs to the deployment's owner.
          return ownerOrLocal(undefined);
        }
        if (runId.startsWith(AUDIT_HOOK_OWNER_PREFIX)) {
          // COR-1939 — read from the entry, never from the hook, which may be gone.
          const recorded =
            typeof detail === 'object' && detail !== null
              ? (detail as { owner?: unknown }).owner
              : undefined;
          return typeof recorded === 'string' ? recorded : undefined;
        }
        if (runId.startsWith(AUDIT_SESSION_OWNER_PREFIX)) {
          // Read from the entry, never from the session: it may be gone, or
          // recreated under another owner since the deletion.
          const recorded =
            typeof detail === 'object' && detail !== null
              ? (detail as { owner?: unknown }).owner
              : undefined;
          return typeof recorded === 'string' ? recorded : undefined;
        }
        return runOwner(runId);
      }
    }
  }

  function getRun(id: string) {
    const runState = store.getRun(id);
    if (!runState) return undefined;

    return serializeRunDetail(runState, getRunSessionIdentifier(runState), attributionOf(id));
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
      return serializeRunState(runState, getRunSessionIdentifier(runState), attributionOf(id));
    }

    if (!abortingRunIds.has(id)) {
      abortingRunIds.set(id, runtimeServices.clock.now());
      runState.activeRun.abort(reason);
      // COR-1481 — the task records where its cleanup ended.
      void tasks.watchCleanup(id, runState.activeRun.closed());
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
      detachBestEffortPromise(childTopology.parentCancelled(id, reason));
    }

    return {
      ...serializeRunState(runState, getRunSessionIdentifier(runState), attributionOf(id)),
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
      ? getRunSessionIdentifier(runState)
      : (firesSession?.sessionId ?? '');
    const agentName = runState ? findRunAgentName(runState) : firesSession?.agentName;

    const toolApprovalReviews = new Map<
      string,
      Extract<PendingReview, { kind: 'tool-approval' }>
    >();
    for (const review of listPendingReviews()) {
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
        await closeCanceledFireReview(review, outcome.principal);
      } else {
        await recordReviewStatusTransition(review, outcome.status, outcome.principal);
      }
      // COR-1596: a fire's approval is revoked in both homes, or a restart brings it back to run
      // a tool for a run that was canceled.
      if (scheduledFireApprovalRuns.has(runId)) {
        await releaseScheduledFireApproval(runId, review.id, outcome.status);
      }
    }

    for (const review of listPendingReviews()) {
      if (review.kind !== 'human-wait' || review.runId !== runId) continue;
      resolvedReviewIds.add(review.id);
      await recordReviewStatusTransition(review, outcome.status, outcome.principal);
    }
    // COR-1613: a fire's parked human wait is not in the session list, and is closed with it.
    if (outcome.status === 'canceled') await closeCanceledFireHumanWaits(runId, outcome.principal);
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
    await surfaces?.removeTask(id);
    const sessionId = getRunSessionIdentifier(runState);
    const ownerPrincipal = runAttribution.get(id)?.principal;
    const ownerIncarnation = runSessionIncarnations.get(id);
    runSessionIdentifiers.delete(runState.activeRun);
    runAttribution.delete(id);
    runSessionIncarnations.delete(id);
    runRequestContexts.delete(id);
    for (const reviewId of pendingApprovalOverrides.keys()) {
      if (reviewId.startsWith(`approval:${id}:`)) dropPendingApprovalOverride(reviewId);
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
    await tasks.remove(id).catch((error: unknown) => {
      diagnose({
        level: 'error',
        scope: 'task-registry',
        message: `[bureau] Could not remove the task record of deleted run "${id}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    });
    await restoreRunOwnershipAfterEvent(id, sessionId, ownerPrincipal, ownerIncarnation);
    if (sessionId) {
      await retryRunDeletionPersistenceWrite('pending-approvals', sessionId, `approval:${id}:`);
      await retryRunDeletionPersistenceWrite('resolved-reviews', sessionId, `approval:${id}:`);
      await retryRunDeletionPersistenceWrite('resolved-reviews', sessionId, `human-wait:${id}:`);
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
      await runTerminalCheckpointCleanup(runId);
      // COR-772 — only a committed cancellation applies the child policy.
      await childTopology.parentCancelled(runId, 'Cancelled via cancelDurableRun');
      // COR-1476 — the run has ended: its session's input is settled here, so
      // the caller returns with the cancellation already reflected in every
      // receipt, and again by its terminal listener, which finds nothing left.
      if (inputSessionId !== undefined) {
        await settleSessionInputsAfterRunEnd(inputSessionId, runId);
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
    const sessionId = durableInputSessionId(durable?.input);
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
    const producer = durableEventProducerInstance;
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
              if (durableEventProducerInstance?.hasActiveWrite({ kind: 'run', id: runId }))
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
  // How long a claim protects an entry from being reclaimed by a different
  // drainer. Long enough to comfortably cover one pass's durable-write wait
  // (`waitForActiveWrites`) under ordinary load; short enough that a
  // crashed drainer's claim does not strand an entry for long. Not a
  // `BureauOptions` knob for the same reason `AUTOMATIC_RUN_OWNERSHIP_PRUNE_INTERVAL_MS`
  // above is not one — the issue's acceptance criteria name no configurable
  // lease duration.
  const OUTBOX_CLAIM_LEASE_MS = 30_000;
  // How often the renewal timer (below) extends an in-progress claim.
  // Comfortably shorter than the lease itself so a renewal always lands
  // well before the PRIOR grant would expire, even under one slow tick.
  const OUTBOX_CLAIM_RENEWAL_INTERVAL_MS = Math.floor(OUTBOX_CLAIM_LEASE_MS / 3);
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
  // Codex P1 review finding, PR #599, "Cap retry delays before passing them
  // to setTimeout": `atMs` comes from a WINNING peer's own `claim.until` —
  // which this bureau does not control (`outbox.claim()` is a public
  // `SessionStore` method any caller sharing this backend may invoke with
  // an arbitrarily distant `until`). Both Node's and Bun's timer
  // implementations silently truncate a delay beyond the int32 range
  // (~24.8 days) to roughly 1ms instead of throwing, so passing such a
  // delay straight to `setTimeout` would fire almost immediately, observe
  // the SAME still-live claim, and re-arm another overflowing timer — a
  // tight storage-polling loop for the entire remaining lease. Capping the
  // delay and re-checking the remaining time on each capped fire closes
  // this without ever passing an out-of-range delay to a real timer.
  const MAXIMUM_SETTIMEOUT_DELAY_MS = 2_147_483_647;
  function scheduleOutboxRetry(atMs: number): void {
    // Codex P2 review finding, PR #599, "Clear retry timers armed by the
    // drain awaited at shutdown": shutdown's own `outboxDrainInFlight`
    // await (below) can let an in-flight drain reach a peer-owned entry and
    // call back into this function AFTER shutdown already cleared any
    // PRIOR retry timer but BEFORE that await resolves — arming a NEW timer
    // shutdown never clears, which could later invoke a drain against
    // disposed storage. `maintenanceAdmissionClosed` flips to `true`
    // synchronously at the very start of shutdown, before that await, so
    // checking it here closes retry admission for the rest of shutdown
    // rather than requiring shutdown to clear the timer a second time.
    if (maintenanceAdmissionClosed) return;
    if (outboxRetryTimerArmedForMs !== undefined && outboxRetryTimerArmedForMs <= atMs) {
      // An earlier (or equal) retry is already armed — it covers this
      // case too, since a fresh drain pass re-evaluates from scratch.
      return;
    }
    if (outboxRetryTimerArmedForMs !== undefined) {
      runtimeServices.timers.clearTimeout(outboxRetryTimerHandle);
    }
    outboxRetryTimerArmedForMs = atMs;
    const remainingMs = Math.max(0, atMs - runtimeServices.clock.now());
    const delayMs = Math.min(remainingMs, MAXIMUM_SETTIMEOUT_DELAY_MS);
    outboxRetryTimerHandle = runtimeServices.timers.setTimeout(() => {
      // The delay above may have been CAPPED rather than the real
      // remaining wait — if `atMs` has not actually arrived yet, this fire
      // is early: re-arm for the (now shorter) remaining time instead of
      // draining prematurely. `outboxRetryTimerArmedForMs` is
      // cleared first so the re-arm below is not refused as a no-op by
      // this same function's own "earlier retry already armed" guard.
      outboxRetryTimerArmedForMs = undefined;
      if (runtimeServices.clock.now() < atMs) {
        scheduleOutboxRetry(atMs);
        return;
      }
      drainOutbox().catch((error: unknown) => {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Session outbox retry drain (scheduled after losing a claim to a live peer) failed: ${serializeUnknownError(error)}`,
        });
      });
    }, delayMs);
  }
  let outboxDrainInFlight: Promise<void> | undefined;
  // AB-389 (Codex P2 review finding, PR #598, "Re-run the drain when a
  // commit joins its completion edge"): a commit's trigger can arrive
  // exactly when an in-flight drain's last `pending()` call has already
  // returned empty and is about to return — that trigger's call below
  // joins `outboxDrainInFlight` (a promise already committed to
  // resolving), so its own newly-appended entry would otherwise sit
  // undrained until a later, unrelated trigger or maintenance tick (and
  // `performDeleteSession`'s own explicit await would return without the
  // durable fact it promises). Set synchronously by EVERY joiner — not
  // just the post-commit trigger — and checked, then reset, by the
  // in-flight drain itself right after its own pending-loop exits but
  // before it actually returns: any join that happens in that narrow
  // window forces one more full pass rather than being silently dropped.
  let outboxDrainRerunRequested = false;
  async function drainOutbox(): Promise<void> {
    if (outboxDrainInFlight) {
      outboxDrainRerunRequested = true;
      return outboxDrainInFlight;
    }
    // AB-389 (Codex P2 review finding, PR #598, "Recheck rerun requests
    // after the drain promise resolves"): the in-flight guard is cleared
    // INSIDE this same async function's own `finally`, synchronously right
    // after the do-while loop's last (non-awaited) exit check — never in a
    // separate `try { await drain } finally { ... }` wrapper one level up.
    // That extra layer used to introduce a real gap: the do-while exiting
    // (this promise settling) and the CALLER's `await drain` resuming to
    // run its own `finally` are two different microtask turns, and a
    // joiner's `drainOutbox()` call landing in between would see
    // `outboxDrainInFlight` still set, join this ALREADY-SETTLING
    // promise, and set `outboxDrainRerunRequested` — a flag nothing
    // would ever check again, since the do-while had already exited. With
    // the guard cleared here instead, there is no such gap: everything
    // from the do-while's condition evaluating false through this
    // `finally` running is one synchronous stretch (a try/finally
    // transition never yields to the microtask queue), so a joiner cannot
    // execute in between — it can only ever land during the single
    // `await` inside the loop, which the do-while's own re-check already
    // catches.
    outboxDrainInFlight = (async (): Promise<void> => {
      try {
        const outboxSessionStore = runtime.sessionStore;
        // Draining and dispatching happens whenever there is a session
        // store to drain, regardless of whether a durable event history
        // producer is configured — `bureau.addEventListener('session.deleted',
        // ...)` and `audit-trail.ts`'s own listener (a KV-only bureau with
        // no durable engine still has both) must keep receiving these
        // events exactly as they did when `SessionStore`/`deleteSession`
        // dispatched them directly. `durableEventProducerInstance` (not
        // `eventHistoryInstance` itself, which is what exposes
        // `waitForActiveWrites` — it exists exactly when
        // `eventHistoryInstance` does, both wired together further down
        // this function) is checked separately, only to decide whether
        // there is a durable write to wait for before acknowledging:
        // absent it, this bureau has no durable event history surface at
        // all, so there is nothing for AC1's "delete only after the
        // durable write settles" rule to apply to — acknowledging
        // immediately after dispatch is correct, not a gap.
        if (!outboxSessionStore) return;
        const producer = durableEventProducerInstance;
        do {
          outboxDrainRerunRequested = false;
          // Loop until one full pass finds nothing pending — an entry
          // appended by a commit that lands WHILE this pass is draining is
          // picked up by THIS pass rather than left for the next trigger.
          await drainOutboxPass(outboxSessionStore, producer);
          // Re-checked with no `await` between the pass above returning
          // and this read, so a join that set the flag at any point up to
          // and including this exact moment is observed.
        } while (outboxDrainRerunRequested);
      } finally {
        outboxDrainInFlight = undefined;
      }
    })();
    await outboxDrainInFlight;
  }

  async function drainOutboxPass(
    outboxSessionStore: SessionStore,
    producer: DurableEventProducer | undefined,
  ): Promise<void> {
    for (;;) {
      const pending: readonly SessionOutboxEntry[] = await outboxSessionStore.outbox.pending();
      if (pending.length === 0) return;
      for (const entry of pending) {
        // AB-391 (Codex P1 review finding, PR #601, "Stop before later
        // ordinals when an attachment is unknown"): `SessionStore.outbox`'s
        // own contract (`packages/operative/src/session/types.ts`) requires
        // replay "exactly once, in ordinal order" — a STORE-WIDE ordinal,
        // never a per-session one. An entry under a `session.attachment`
        // namespace THIS bureau version does not recognize may still be
        // meaningful to a different consumer (a future bureau version, or
        // a peer instance running one) that has not drained it yet, so it
        // is left pending rather than dropped — but letting this pass
        // advance PAST it to a later ordinal (the prior fix's `continue`)
        // breaks that same ordinal-order contract: a later `session.saved`
        // or `session.deleted` could reach durable history before an
        // earlier fact a peer's own consumer has not replayed yet. Stopping
        // the WHOLE pass here — exactly like the claim-contention branch
        // below — is the only way to leave an entry pending without also
        // reordering everything after it. A later trigger (this process's
        // own next tick, or a peer's) gets a fresh look at it.
        if (
          entry.kind === 'session.attachment' &&
          entry.namespace !== REVIEW_AUDIT_OUTBOX_NAMESPACE
        ) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Unrecognized session.attachment outbox entry namespace "${entry.namespace}" (ordinal ${entry.ordinal}); stopping this drain pass here, leaving it and every later ordinal pending, rather than dropping it or reordering past it, in case a different consumer recognizes it.`,
          });
          return;
        }
        // AB-390 — claim before replaying. A peer (this process's own
        // overlapping pass is impossible: `drainOutbox` is
        // single-flighted above; "peer" here means a DIFFERENT bureau
        // process sharing this backend) may already hold an unexpired
        // claim on this exact entry. Stopping the WHOLE pass here, rather
        // than continuing to a LATER ordinal, preserves AB-389's ordering
        // guarantee: replaying ordinal 2 while a peer still owns ordinal 1
        // would let `session.saved` reach durable history before
        // `session.created` for the same lineage. A later trigger — this
        // process's own next tick, or the peer finishing its own drain —
        // picks up where this pass stopped.
        const attempt = await outboxSessionStore.outbox.claim(entry.ordinal, {
          owner: outboxDrainOwner,
          until: runtimeServices.clock.now() + OUTBOX_CLAIM_LEASE_MS,
        });
        if (!attempt.claimed) {
          // Codex P1 review finding, PR #599, "Schedule a retry when a
          // live claim blocks recovery": `attempt.lease` — the CURRENT
          // winning claim as `claim()` itself just observed it, never this
          // pass's earlier `pending()` snapshot, which a peer's own
          // intervening `claim()` call could already have made stale (Codex
          // P1 review finding, PR #599, "Re-read the winning claim before
          // deciding not to retry") — names the blocking holder's own
          // lease. Wake this bureau's drain right when that lease is due
          // to expire, rather than depending on whichever unrelated
          // trigger happens to fire next.
          if (attempt.lease) scheduleOutboxRetry(attempt.lease.until);
          return;
        }
        const owner: DurableEventOwner = { kind: 'session', id: entry.sessionId };
        // Codex P1 review finding, PR #599, "Renew the claim while replay
        // is in flight": the stretch this `try` wraps — the durable write
        // `waitForActiveWrites` settles, `wasRecorded`, and the
        // audit-trail read-your-writes query — has no upper bound under
        // real backpressure or a slow backend. A claim taken once, before
        // any of that, can lapse mid-wait, letting a peer reclaim and
        // dispatch this SAME entry again before this drainer ever
        // discovers the lost claim at `acknowledge()` — recreating the
        // exact duplicate-delivery hazard this lease exists to close.
        // This timer renews the lease every
        // `OUTBOX_CLAIM_RENEWAL_INTERVAL_MS` for as long as this
        // drainer is still actively working the entry, and is always
        // cleared in `finally` — including on every early `return` below.
        const renewalTimerHandle = runtimeServices.timers.setInterval(() => {
          outboxSessionStore.outbox
            .claim(entry.ordinal, {
              owner: outboxDrainOwner,
              until: runtimeServices.clock.now() + OUTBOX_CLAIM_LEASE_MS,
            })
            .catch((error: unknown) => {
              diagnose({
                level: 'error',
                scope: 'durable-maintenance',
                message: `[bureau] Failed to renew the claim on session outbox entry ${entry.ordinal} while replaying it: ${serializeUnknownError(error)}`,
              });
            });
        }, OUTBOX_CLAIM_RENEWAL_INTERVAL_MS);
        let outcome: 'stop' | 'continue';
        try {
          outcome = await drainOutboxEntry(entry, owner, outboxSessionStore, producer);
        } finally {
          runtimeServices.timers.clearInterval(renewalTimerHandle);
        }
        if (outcome === 'stop') return;
      }
    }
  }
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
    if (!auditTrailInstance) return { audit: 0, reviews };
    const retention = currentSettings()['retention.audit'];
    if (!retention || retention === 'forever') return { audit: 0, reviews };

    await durableEventProducerInstance?.waitForAllActiveWrites();

    const now = runtimeServices.clock.now();
    const cutoff = now - retention.olderThan;
    const floorTimestamp = await eventHistoryInstance?.retentionFloorTimestamp();
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
    let retainedRunOwners = await eventHistoryInstance?.retainedRunOwnerIdsForAuditRetention();
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
          await durableEventProducerInstance?.waitForAllActiveWrites();
          retainedRunOwners =
            await eventHistoryInstance.refreshRetainedRunOwnerIds(retainedRunOwners);
          return retainedRunOwners.ownerIds.has(runId);
        }
      : undefined;

    const pruned = await auditTrailInstance.prune(effectiveCutoff, { protectRunId });
    // COR-1934 — the tombstones of runs purged before the same cutoff: an entry or event older
    // than it is pruned anyway.
    await chatContentPurge.pruneTombstones(effectiveCutoff);
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
      return await resolvedReviewStore.pruneBefore(
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
    if (!eventHistoryInstance) return;
    const cutoff = eventRetentionCutoff();
    if (cutoff === undefined) return;
    await eventHistoryInstance.retainBefore(cutoff);
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
    if (workflowRuntime === undefined) return;
    const retention = taskRetentionOf(currentSettings());
    if (retention === 'forever') return;
    await workflowRuntime.pruneSnapshots(runtimeServices.clock.now() - retention.olderThan);
  }

  async function retainAgentSnapshots(): Promise<void> {
    if (fileAgents === undefined) return;
    const retention = taskRetentionOf(currentSettings());
    if (retention === 'forever') return;
    await fileAgents.snapshots.pruneSettledBefore(
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
    if (fileAgents === undefined) return;
    await fileAgents.reconcile({
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
      await tasks.expireListings();
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
    const bound = (await runCreationLedger?.boundRunIds()) ?? new Set<string>();
    // COR-1481 — the records of tasks whose runs left the run store on their own
    // (a catalog run releases itself when it settles) age out here.
    // COR-1596: what a fire's decided approval keeps to fence a concurrent resolver ends with the
    // fire's task, which is the last thing that could name it.
    let removed = await tasks.expire(
      cutoff,
      bound,
      async (record) => {
        // COR-1670: whatever kind of task this was, its run's peer call records end with it.
        releasePeerCalls(record.taskId);
        if (record.kind === 'schedule-fire') {
          await releaseScheduledFire(record.taskId, 'removed', { sessionId: record.contextId });
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
          await surfaces?.removeTask(record.taskId);
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
        await deleteRun(runId);
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
    await auditTrailInstance
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

  // AB-390 — the claim-then-replay-then-acknowledge sequence for ONE
  // outbox entry, extracted so `drainOutboxPass` can wrap it in
  // the renewal-timer `try`/`finally` above without duplicating a return
  // path per verification step. Returns `'stop'` for every case that used
  // to `return` directly out of `drainOutboxPass` itself (the
  // caller propagates that into its OWN `return`, so "stop this entry"
  // and "stop the whole pass" remain exactly the same observable behavior
  // they were before this was split out) and `'continue'` once this
  // entry is fully acknowledged.
  /**
   * AB-391: narrows a `session.attachment` entry's opaque `JSONValue`
   * payload to the shape {@link buildReviewDecisionAuditRecord} produces —
   * the only payload shape this bureau ever appends under
   * {@link REVIEW_AUDIT_OUTBOX_NAMESPACE}.
   */
  function isReviewAuditAttachmentPayload(value: unknown): value is ReviewAuditAttachment {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    if (
      typeof record['runId'] === 'string' &&
      typeof record['type'] === 'string' &&
      'detail' in record &&
      typeof record['principal'] === 'string'
    ) {
      const request = record['decisionRequest'];
      if (request === undefined) return true;
      if (typeof request !== 'object' || request === null || Array.isArray(request)) return false;
      const candidate = request as Record<string, unknown>;
      return (
        typeof candidate['reviewId'] === 'string' &&
        typeof candidate['round'] === 'number' &&
        Number.isInteger(candidate['round']) &&
        (candidate['decision'] === 'approve' ||
          candidate['decision'] === 'deny' ||
          candidate['decision'] === 'reject') &&
        typeof candidate['principal'] === 'string' &&
        typeof candidate['digest'] === 'string' &&
        (candidate['reason'] === undefined || typeof candidate['reason'] === 'string')
      );
    }
    return false;
  }

  /**
   * AB-391: replays one `session.attachment` outbox entry — the durable
   * write this bureau's own review-transition code coupled to a
   * session-store commit (see the "review-transition audit records ride
   * the session outbox" section above) — into the real audit trail, then
   * acknowledges it.
   *
   * Idempotency is `AuditTrail.record`'s own `dedupeKey` — an atomic
   * storage-level compare-and-swap keyed by THIS entry's `sessionId` and
   * `ordinal` (Codex review finding, PR #601, "Make attachment replay
   * deduplication atomic": a read-before-write existence check, no matter
   * how it is scoped, has a race window between the read and the write
   * that two Bureau processes both reclaiming this entry after a lease
   * renewal race can land in, each seeing "not yet recorded" and each
   * durably writing — `dedupeKey` closes that window at the storage layer
   * rather than trying to narrow it in application code). A rejection
   * from `record()` here (a genuine storage failure, since `dedupeKey`
   * opts into propagating failures rather than swallowing them — see its
   * own doc comment) propagates out of this function uncaught, leaving
   * the entry claimed-but-unacknowledged for a later drain to retry,
   * exactly the "leave it pending" behavior a failed write always had.
   *
   * Only ever called for a `REVIEW_AUDIT_OUTBOX_NAMESPACE` entry —
   * `drainOutboxPass` stops the whole pass at (and never claims) any other
   * `session.attachment` namespace before reaching this function, so
   * there is no "unrecognized namespace" branch here to duplicate that
   * check.
   */
  async function drainOutboxAttachmentEntry(
    entry: Extract<SessionOutboxEntry, { kind: 'session.attachment' }>,
    outboxSessionStore: SessionStore,
  ): Promise<'stop' | 'continue'> {
    const acknowledge = async (): Promise<'stop' | 'continue'> => {
      const acknowledged = await outboxSessionStore.outbox.acknowledge(
        entry.ordinal,
        outboxDrainOwner,
      );
      if (!acknowledged) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Lost the claim on outbox entry ${entry.ordinal} (session.attachment for session "${entry.sessionId}") before acknowledging it; a different drainer reclaimed and will retire it.`,
        });
        return 'stop';
      }
      return 'continue';
    };

    // `REVIEW_AUDIT_OUTBOX_NAMESPACE` IS this bureau's own — this code is
    // the only writer of it, via `reviewAuditOutboxAttachment`, which
    // always produces the shape `isReviewAuditAttachmentPayload` checks
    // for. A payload under this namespace that fails that check is
    // corruption from THIS write path (or a hand-edited/fuzzed record),
    // not a forward-compatibility gap a future consumer could resolve —
    // there is no future version of this same namespace to defer to, so
    // dropping it (rather than leaving it to jam every future pass) is
    // the correct call.
    if (!isReviewAuditAttachmentPayload(entry.payload)) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] Malformed audit-record outbox entry payload (ordinal ${entry.ordinal}); acknowledging without replay.`,
      });
      return acknowledge();
    }
    const payload = entry.payload;
    if (auditTrailInstance) {
      await auditTrailInstance.record({
        runId: payload.runId,
        type: payload.type,
        detail: payload.detail,
        principal: payload.principal,
        timestampMs: entry.committedAtMs,
        dedupeKey: `session.attachment:${entry.sessionId}:${entry.ordinal}`,
      });
    }
    // COR-1828: the decision's resolved-review record rides the same replay, so a crash after the
    // session commit leaves it for the next drain, as it leaves the audit entry.
    await recordResolvedReview(payload, entry.committedAtMs);
    if (payload.decisionRequest !== undefined) {
      const recorded = await reviewDecisions.markRecorded(payload.decisionRequest);
      const inspection = recorded
        ? undefined
        : await reviewDecisions.inspect(payload.decisionRequest);
      if (!recorded && (inspection?.outcome !== 'matching' || !inspection.recorded)) {
        throw new Error(
          `could not mark review decision "${payload.decisionRequest.reviewId}" recorded before acknowledging its outbox entry`,
        );
      }
    }
    return acknowledge();
  }

  /** Releases an expired session's asset claims once its `session.deleted` entry drains; never rejects. */
  async function releaseExpiredSessionAssetClaims(entry: SessionOutboxEntry): Promise<void> {
    const key = `${entry.sessionId}\u0000${entry.incarnation}`;
    const expired = expiringSessions.get(key);
    if (expired === undefined) return;
    expiringSessions.delete(key);
    try {
      await releaseSessionGeneratedAssets(expired);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'assets',
        message: `[bureau] Could not release the asset claims of expired session "${entry.sessionId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  async function drainOutboxEntry(
    entry: SessionOutboxEntry,
    owner: DurableEventOwner,
    outboxSessionStore: SessionStore,
    producer: DurableEventProducer | undefined,
  ): Promise<'stop' | 'continue'> {
    if (entry.kind === 'session.attachment') {
      return drainOutboxAttachmentEntry(entry, outboxSessionStore);
    }
    // COR-718 — the deletion's audit entry carries the owner the session had, which
    // the audit listener reads synchronously, so it is loaded before the dispatch.
    if (
      entry.kind === 'session.deleted' &&
      !(await loadSessionDeletionOwner(entry.sessionId, entry.incarnation))
    ) {
      return 'stop';
    }
    // COR-713: every row that enters a session's history arrived in a commit this drain replays,
    // so this is where the rows' claims on the assets they reference are taken, and they are
    // taken BEFORE the entry is dispatched and acknowledged: the entry is the only cue that the
    // commit still needs its claims, so a claim that fails (or a process that exits first) leaves
    // it pending for the next pass. An expired session's claims are released here too once the
    // store has removed it; that only shortens an asset's life, so it runs beside the drain.
    if (entry.kind === 'session.created' || entry.kind === 'session.saved') {
      // A Bureau with no asset service has no claims to take, so it does not read the session at
      // all: a failing load cannot stop its drain, and the read costs nothing per entry.
      if (assetServiceHolder.current !== undefined) {
        try {
          const committed = await outboxSessionStore.load(entry.sessionId);
          if (committed !== undefined && committed.incarnation === entry.incarnation) {
            await claimSessionAssets(committed);
          }
        } catch (error) {
          // Only a transient failure reaches here: a claim that cannot succeed (a corrupt asset
          // record) was reported, remembered and skipped by `claimSessionAssets`, so it never
          // holds back the entry or the events behind it.
          diagnose({
            level: 'error',
            scope: 'assets',
            message: `[bureau] Could not claim the assets of session "${entry.sessionId}" for its outbox entry ${entry.ordinal}; leaving it pending for a later drain to retry: ${serializeUnknownError(error)}`,
            cause: error,
          });
          return 'stop';
        }
      }
    } else if (entry.kind === 'session.deleted') {
      trackSessionInputSettlement(releaseExpiredSessionAssetClaims(entry));
    }
    // AB-389 (Codex P2 review finding, PR #598, "Isolate subscriber
    // exceptions while draining the outbox"): `emitter.dispatch()`
    // fans out to two kinds of listener — `addEventListener`-registered
    // ones (this includes `durableEventProducerInstance`'s own
    // write-tracking listener, native-`EventTarget`-isolated per spec:
    // a throw there never reaches this call) and a public
    // `bureau.toObservable()` subscriber, which has NO such isolation
    // (`CompletableEventTarget.dispatchEvent` calls those directly, no
    // try/catch of its own — see that class's own doc comment on why
    // this is intentionally NOT fixed there: `active-run-adapter.ts`'s
    // OWN emitter relies on a throwing observer aborting its dispatch
    // call, an unrelated, already-tested contract this fix must not
    // disturb). Isolated HERE instead, scoped to exactly this call
    // site: because the native listener above already started
    // tracking its write synchronously before any observer runs, a
    // throw from a downstream OBSERVER can never un-start that write —
    // catching it here just stops one badly-behaved subscriber from
    // permanently wedging the RESERVED lowest-ordinal entry (returned
    // on every retry) and starving every later session lifecycle fact
    // behind it.
    try {
      switch (entry.kind) {
        case 'session.created':
          emitter.dispatch(
            new SessionCreatedEvent(
              entry.sessionId,
              entry.agentName,
              entry.incarnation,
              entry.ordinal,
              entry.committedAtMs,
            ),
          );
          break;
        case 'session.saved':
          emitter.dispatch(
            new SessionSavedEvent(
              entry.sessionId,
              entry.agentName,
              entry.incarnation,
              entry.ordinal,
              entry.committedAtMs,
            ),
          );
          break;
        case 'session.deleted':
          emitter.dispatch(
            new SessionDeletedEvent(
              entry.sessionId,
              entry.incarnation,
              entry.ordinal,
              entry.committedAtMs,
            ),
          );
          break;
      }
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] A bureau.toObservable() subscriber threw while replaying session outbox entry ${entry.ordinal} (${entry.kind} for session "${entry.sessionId}"); continuing the drain:`,
        cause: error,
      });
    }
    // Waits for the durable write THIS dispatch just started (and
    // any other write already in flight for the same owner) to
    // settle before acknowledging — never before. `dispatch()` calls
    // `durable-event-history.ts`'s listener synchronously, which
    // starts tracking the write before `dispatch()` itself returns,
    // so this snapshot-then-await always catches it.
    await producer?.waitForActiveWrites(owner);
    // AB-389 (Codex P1 review finding, PR #598, "Retain the outbox
    // entry when its durable write fails"): `waitForActiveWrites`
    // resolving proves only that the write SETTLED, never that it
    // SUCCEEDED — a storage failure is diagnosed and swallowed by the
    // write's own listener, never surfaced here. Verifying via
    // `wasRecorded` (the SAME dedupe identity `record()` itself checks
    // — this entry's own ordinal) before acknowledging closes that
    // gap: a failed write leaves the entry pending for a LATER drain
    // to retry, rather than being permanently discarded even though
    // nothing durable was ever recorded. Skipped entirely when there
    // is no durable event history to verify against (`eventHistoryInstance`
    // absent) — acknowledging immediately is correct there, per this
    // function's own doc comment on why `producer` alone gates the
    // wait above.
    if (eventHistoryInstance) {
      const wasRecorded = await eventHistoryInstance.wasRecorded(
        owner,
        entry.kind,
        String(entry.ordinal),
      );
      if (!wasRecorded) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Session outbox entry ${entry.ordinal} (${entry.kind} for session "${entry.sessionId}") was not durably recorded; leaving it pending for a later drain to retry.`,
        });
        // Stop this pass here, rather than spinning on the same
        // still-failing entry forever within this one call: a LATER,
        // distinct trigger (the next commit, or the next maintenance
        // tick) starts a fresh pass and gets a fresh chance at it.
        return 'stop';
      }
    }
    // AB-389 (Codex P1 review finding, PR #598, "Verify deletion audit
    // persistence before acknowledging"): `audit-trail.ts`'s own
    // `session.deleted` listener writes an out-of-band KV record
    // through the SAME swallow-and-diagnose discipline `sink()` uses
    // for durable history — a failed `kv.set()` never surfaces to this
    // drain. `eventHistoryInstance`'s own `wasRecorded` check above
    // verifies ONLY durable event history, which can be entirely
    // absent (a KV-only bureau with no durable engine) even though the
    // audit trail is configured and its write is the ONLY record of
    // this deletion. `query({ runId })` already waits for that
    // specific owner's in-flight write to settle (AB-228) before
    // reading back, so this both waits AND verifies in one call — a
    // bureau with no `runtime.kv` configured skips this entirely
    // (`query()` always returns `[]` there, which would otherwise read
    // as a permanent, un-retryable failure).
    if (entry.kind === 'session.deleted' && auditTrailInstance && runtime.kv) {
      const ownerRunId = auditTrailSessionOwnerId(entry.sessionId);
      const records = await auditTrailInstance.query({
        runId: ownerRunId,
        type: 'session.deleted',
      });
      const persisted = records.some((record) => {
        const detail = record.detail;
        return (
          typeof detail === 'object' &&
          detail !== null &&
          'incarnation' in detail &&
          detail.incarnation === entry.incarnation
        );
      });
      if (!persisted) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Session outbox entry ${entry.ordinal} (session.deleted for session "${entry.sessionId}") was not durably recorded in the audit trail; leaving it pending for a later drain to retry.`,
        });
        return 'stop';
      }
    }
    const acknowledged = await outboxSessionStore.outbox.acknowledge(
      entry.ordinal,
      outboxDrainOwner,
    );
    // AB-390 — a `false` here means a different owner reclaimed this
    // entry between this pass's `claim()` above and this point (this
    // owner's own lease must have lapsed under an unusually slow
    // durable write, outrunning even the renewal timer above). The
    // dispatch above already ran, so the current claimant's own
    // acknowledge (or a future one) retires the entry; continuing
    // this pass past a lost claim risks the same reordering hazard
    // the claim-before-replay check above exists to prevent.
    if (!acknowledged) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] Lost the claim on session outbox entry ${entry.ordinal} (${entry.kind} for session "${entry.sessionId}") before acknowledging it; a different drainer reclaimed and will retire it.`,
      });
      return 'stop';
    }
    // The audit entry is verified and the outbox entry acknowledged, so the side
    // record has done its work.
    if (entry.kind === 'session.deleted') {
      await removeSessionDeletionOwner(entry.sessionId, entry.incarnation);
    }
    return 'continue';
  }

  // COR-1629 — the authority the maintenance pass sweeps governed memory's retention under, built
  // once and only for a Bureau that has memory, so a Bureau without it calls nothing.
  const maintenanceMemoryAuthority = createMaintenanceMemoryAuthority(runtime.memory, bureauId);

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
    if (runtime.memory === undefined || maintenanceMemoryAuthority === undefined) {
      return Promise.resolve(0);
    }
    if (memoryRetentionSweepInFlight !== undefined) return memoryRetentionSweepInFlight;
    const memory = runtime.memory;
    const authority = maintenanceMemoryAuthority;
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
      return await notificationsComposition.prune(window.olderThan);
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
    if (window === undefined || hooksInstance === undefined) return 0;
    try {
      return await hooksInstance.prune(window.olderThan);
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
      const oldest = await listSessions({
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
        const report = await startSessionDeletion(chat.id, { idleBefore: cutoff });
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
    if (maintenanceAdmissionClosed) {
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
        await settingsComposition?.reload();
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
          await processLease.renew();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Could not renew the process lease: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        await abandonedTaskSweeper.run();
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
        await pruneStaleRunOwnership();
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Manual run-ownership pruning pass failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      try {
        await drainOutbox();
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
        await chatContentPurge.sweep();
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Manual deleted-chat purge pass failed: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      // COR-1664 — claims on assets whose run ended or whose session was deleted without a release.
      await reconcileAssetClaims();
      // COR-194 — a schedule transition whose record failed after its commit is retried here.
      try {
        await pauseInvalidSchedules();
        await recordPendingScheduleTransitions();
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
        await sessionInputSettlement?.sweep();
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
        await sweepExpiredReviews(now);
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
        await taskResyncInstance?.repairAll();
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
        await runCreationLedger?.prune();
        await forkLedger.prune();
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
      await memoryEmbedder?.reconcile();
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
      auditTrail: Boolean(auditTrailInstance),
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
    if (maintenanceAdmissionClosed) {
      throw new BureauError('Cannot remove expired records: bureau is shutting down', 'CONFLICT');
    }
    let removal: ExpiredRecordRemoval | undefined;
    const pass = (async () => {
      try {
        await settingsComposition?.reload();
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

  /** Starts the automatic maintenance timer. */
  function startAutomaticMaintenance(): void {
    automaticRunOwnershipPruneTimerStarted = true;
    automaticRunOwnershipPruneTimer = runtimeServices.timers.setInterval(() => {
      if (automaticRunOwnershipPruneCurrentPass) return;
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
          await settingsComposition?.reload();
        } catch (error: unknown) {
          diagnoseSettings(
            `[bureau] Automatic settings re-read failed: ${serializeUnknownError(error)}`,
            error,
          );
        }
        try {
          await pruneStaleRunOwnership();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Automatic run-ownership pruning pass failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        try {
          await drainOutbox();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Automatic session-outbox drain pass failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        // COR-1664 — claims on assets whose run ended or whose session was deleted without a release.
        await reconcileAssetClaims();
        // COR-194 — a schedule transition whose record failed after its commit is retried here.
        try {
          await pauseInvalidSchedules();
          await recordPendingScheduleTransitions();
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
          await chatContentPurge.sweep();
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
          await sessionInputSettlement?.sweep();
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
          await sweepExpiredReviews();
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
          await taskResyncInstance?.repairAll();
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
          await runCreationLedger?.prune();
          await forkLedger.prune();
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
        await memoryEmbedder?.reconcile();
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
        automaticRunOwnershipPruneCurrentPass = undefined;
      });
      automaticRunOwnershipPruneCurrentPass = pass;
      detachBestEffortPromise(pass);
    }, AUTOMATIC_RUN_OWNERSHIP_PRUNE_INTERVAL_MS);
  }

  async function listSessions(requestOptions?: SessionListOptions) {
    // COR-1911 — the contexts of agents being tried are not among a person's chats, goals and
    // fires unless they are asked for by origin.
    return requireSessionStore().list({
      excludeOrigins: ['try'],
      ...requestOptions,
    });
  }

  async function getSession(id: string) {
    return requireSessionStore().load(id);
  }

  // COR-1909: a title a person gave the session lives in its metadata, under a key of its own, so
  // clearing it is removing the key and the summary reads the derived title again. The write is
  // one `update()` that does not refresh `updatedAt`: a rename is not activity, and must not
  // reorder the listing or keep a session from expiring.
  async function renameSession(
    id: string,
    title: string | null,
    renameOptions?: { readonly incarnation?: string | undefined },
  ): Promise<AgentSession | undefined> {
    const sessions = requireSessionStore();
    if (runAdmissionClosed) {
      throw new BureauShuttingDownError(
        'Cannot rename: Bureau is shutting down.',
        runtimeServices.clock.nowISO(),
      );
    }
    const trimmed = title === null ? null : title.trim();
    if (trimmed !== null && (trimmed === '' || trimmed.length > SESSION_TITLE_OVERRIDE_LIMIT)) {
      throw new BureauError(
        `A session title is 1 to ${SESSION_TITLE_OVERRIDE_LIMIT} characters, or null to clear it`,
        'BAD_REQUEST',
      );
    }
    return sessions.update(
      id,
      (session) => {
        if (session === undefined) return undefined;
        if (
          renameOptions?.incarnation !== undefined &&
          session.incarnation !== renameOptions.incarnation
        ) {
          return undefined;
        }
        const { [SESSION_TITLE_METADATA_KEY]: _replaced, ...rest } = session.metadata;
        return {
          ...session,
          metadata: trimmed === null ? rest : { ...rest, [SESSION_TITLE_METADATA_KEY]: trimmed },
        };
      },
      { refreshActivity: false },
    );
  }

  // AB-228 (Codex P2 review finding, PR #566): two concurrent
  // `deleteSession(id)` calls can both observe a truthy `session` from
  // their own `sessionStore.load(id)` before either has actually deleted
  // it. Coalescing concurrent calls for the same id onto a single
  // in-flight promise makes exactly one of them actually run
  // `performDeleteSession`; every other concurrent caller within THIS
  // process awaits that same result instead of starting a second,
  // redundant run. A call that arrives strictly AFTER the first has
  // already settled (id reused, or genuinely deleting again) is
  // unaffected — the map entry is cleared in `finally`, so it starts a
  // fresh `performDeleteSession`. This in-flight map is a process-local
  // fast path only, not the source of truth for whether a durable
  // `session.deleted` record and notification should be produced: two
  // separate BUREAU PROCESSES sharing one persistent backend under the
  // supported `durableOwnership: { ownership: 'workflow-lease' }`
  // configuration do not share this map and can both reach
  // `performDeleteSession` for the same id at the same moment.
  //
  // AB-371: that cross-process race is resolved by `SessionStore.delete`
  // itself, whose contract now resolves `boolean` — `true` only for the
  // call whose own atomic delete-and-count actually removed a live
  // record, `false` for every other caller (already gone, or never
  // existed). `performDeleteSession` dispatches `SessionDeletedEvent` (and
  // so the durable audit record it feeds) only when `sessionStore.delete`
  // returns `true`, so exactly one of the two racing processes produces
  // the record and the notification, regardless of what either observed
  // from its own `sessionStore.load(id)` beforehand. The other cleanup in
  // this function (revoking approvals, aborting or releasing this
  // process's own live runs, discarding this process's steering gate)
  // still runs unconditionally for whichever process actually holds a
  // truthy `session` from its own load — each process only knows about
  // its own in-memory run state, so that cleanup could never be skipped
  // just because a peer process happened to win the durable delete.
  // AB-228 (Codex follow-up review finding, PR #566): the coalescing slot
  // above is released as soon as `sessionStore.delete(id)` itself commits
  // (`onStoreDeletionCommitted` below), NOT when the whole function
  // finally resolves. `performDeleteSession`'s tail after that point
  // (releasing a paused run's steering gate, awaiting its terminal event)
  // is cleanup for the OLD, now-actually-deleted incarnation — holding the
  // coalescing slot open through it would make a `deleteSession(id)` call
  // for a session RECREATED with the same id, arriving during that tail,
  // silently resolve against the OLD promise instead of ever deleting the
  // NEW session. `releaseCoalescing` is reset to a no-op the first time it
  // runs (either via the commit callback or the `finally` safety net for
  // the never-existed-session path / a thrown error before commit) so it
  // never double-clears an entry a later, unrelated call may already own.
  /**
   * COR-1934 — removes one run's durable workflow and its checkpoints. A workflow that is not
   * terminal is skipped by the engine's purge.
   */
  async function purgeDurableRun(runId: string): Promise<void> {
    const durable = runtime.durable;
    if (durable === undefined) return;
    // By exact id: a prefix purge would take `…-run-10` with `…-run-1`, and refuses a documented
    // custom child id such as `order:42`.
    const purged = await durable.engine.purgeById(runId);
    // `false` is also what a lost compare-and-set, a run that began again, or a finalizer still
    // owed answer. A workflow that is still stored is then the run's content left behind: the step
    // fails, so the pending record stays and the next pass retries, and its checkpoints stay with
    // it, since the id may by now be another run's.
    if (!purged && (await durable.engine.get(runId)) !== null) {
      throw new Error(`The durable workflow of run "${runId}" was not purged and is still stored`);
    }
    await durable.checkpointStore.clear(runId);
  }

  /** The statuses after which a durable workflow no longer changes. */
  const isTerminalDurableStatus = (status: string): boolean =>
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed-out';
  /**
   * COR-1934 — the runs the given runs delegated to, directly or through other children, breadth
   * first, so a child comes before its own children; none of the given runs is repeated.
   */
  async function descendantRunIdsOf(parents: readonly string[]): Promise<string[]> {
    const found: string[] = [];
    const seen = new Set(parents);
    const queue = [...parents];
    for (let index = 0; index < queue.length; index += 1) {
      for (const child of await childTopologyStore.listByParent(queue[index]!)) {
        if (seen.has(child.childRunId)) continue;
        seen.add(child.childRunId);
        found.push(child.childRunId);
        queue.push(child.childRunId);
      }
    }
    return found;
  }

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
   * COR-1934 — every run of a chat about to be deleted: the runs this process holds for it, the
   * runs its ownership map names (pruned once a run's history expires), and its task records,
   * the complete list. A list that cannot be read fails the delete before anything is removed,
   * because a partial one would leave a run's content behind for good.
   */
  async function chatRunIdsOf(session: AgentSession): Promise<string[]> {
    const runIds = new Set<string>();
    for (const [, runState] of store.getState().runs) {
      if (getRunSessionIdentifier(runState) === session.id) runIds.add(runState.id);
    }
    const owners = session.metadata['lastRunOwningPrincipals'];
    if (isPlainAuthorityRecord(owners)) for (const runId of Object.keys(owners)) runIds.add(runId);
    for (const taskId of await tasks.taskIdsOfContext(session.id, session.incarnation)) {
      runIds.add(taskId);
    }
    // Children the chat's runs delegated to hold its words too (COR-1934); the purge reads the
    // topology again on every pass, so one dispatched after this is found as well.
    for (const child of await descendantRunIdsOf([...runIds])) runIds.add(child);
    return [...runIds];
  }

  function deleteSession(
    id: string,
    deleteOptions?: {
      readonly incarnation?: string | undefined;
      readonly actor?: string | undefined;
    },
  ): Promise<ContextDeletionReport> {
    return startSessionDeletion(id, {
      incarnation: deleteOptions?.incarnation,
      actor: deleteOptions?.actor,
    });
  }

  /**
   * {@link deleteSession}, and for a retention sweep `idleBefore`: the chat is deleted only if,
   * read again under its thread lease, its last activity is still before that time and it has no
   * live task, and the store delete is then fenced to the incarnation read there. A chat that was
   * active since the sweep listed it is kept, with no tombstone, and deletes nothing.
   */
  async function startSessionDeletion(
    id: string,
    deleteOptions: {
      readonly incarnation?: string | undefined;
      readonly actor?: string | undefined;
      readonly idleBefore?: number | undefined;
    },
  ): Promise<ContextDeletionReport> {
    const existing = inFlightSessionDeletions.get(id);
    if (existing) return existing;
    let releaseCoalescing: (() => void) | undefined = () => {
      inFlightSessionDeletions.delete(id);
    };
    const deletion = performDeleteSession(
      id,
      deleteOptions.incarnation,
      () => {
        releaseCoalescing?.();
        releaseCoalescing = undefined;
      },
      deleteOptions.actor,
      deleteOptions.idleBefore,
    ).finally(() => {
      releaseCoalescing?.();
      releaseCoalescing = undefined;
    });
    inFlightSessionDeletions.set(id, deletion);
    return deletion;
  }

  /**
   * COR-718 — who owned a session at the moment it was deleted, kept for the
   * `session.deleted` audit entry. The deleted session's body is gone by the time
   * that entry is written (possibly in another process, after a restart), and its
   * id may be recreated under another owner, so the entry carries the owner in its
   * `detail`. Operative's session store knows nothing of owners, so Bureau writes
   * the owner to its own store, keyed by session id and incarnation, before the
   * store delete; the outbox drain reads it back into memory before it dispatches
   * the event, and removes it once the audit entry is verified and the outbox
   * entry acknowledged.
   *
   * It is written only when an audit trail exists to consume it, and a deletion,
   * by `deleteSession` or by the store's own `cleanup()`, does not go ahead when
   * it cannot be written: the audit entry would then have no owner, and nothing
   * could supply one afterwards. A crash between this write and the store delete,
   * between the acknowledgement and the removal, or a process that wrote the
   * record and then lost the delete to another process, leaves one small orphan
   * record. That is accepted, because the record is only ever read for its own
   * session id and incarnation. The `v1` prefix is where a future boot sweep
   * would look for them.
   */
  const SESSION_DELETION_OWNER_PREFIX = 'session-deletion-owner:v1:';

  /** Whether `error` is the strict UTF-8 decoder rejecting stored bytes, as opposed to the store failing. */
  function isInvalidEncodingError(error: unknown): boolean {
    return (
      error instanceof TypeError &&
      (error as { code?: unknown }).code === 'ERR_ENCODING_INVALID_ENCODED_DATA'
    );
  }

  function serializeSessionDeletionRecord(record: SessionDeletionRecord): string {
    return JSON.stringify({
      owner: record.owner ?? null,
      actor: record.actor ?? null,
      title: record.summary?.title ?? null,
      messageCount: record.summary?.messageCount ?? null,
    });
  }

  function parseSessionDeletionRecord(stored: string): SessionDeletionRecord {
    if (!stored.startsWith('{')) return { owner: stored, actor: undefined, summary: undefined };
    try {
      const parsed: unknown = JSON.parse(stored);
      if (typeof parsed !== 'object' || parsed === null) {
        return { owner: undefined, actor: undefined, summary: undefined };
      }
      const { owner, actor, title, messageCount } = parsed as Record<string, unknown>;
      return {
        owner: typeof owner === 'string' ? owner : undefined,
        actor: typeof actor === 'string' ? actor : undefined,
        summary:
          typeof messageCount === 'number'
            ? { title: typeof title === 'string' ? title : null, messageCount }
            : undefined,
      };
    } catch {
      return { owner: undefined, actor: undefined, summary: undefined };
    }
  }

  function sessionDeletionOwnerKey(sessionId: string, incarnation: string): string {
    return `${SESSION_DELETION_OWNER_PREFIX}${encodeURIComponent(sessionId)}:${incarnation}`;
  }

  async function recordSessionDeletionOwner(session: AgentSession, actor?: string): Promise<void> {
    const kvStore = runtime.kv;
    if (!auditTrailInstance || !kvStore) return;
    // A malformed owner names no one, so the entry is left without one.
    const owner = resolveSessionOwner(session.metadata);
    // The title and the count are what the chat was while it existed (COR-2018): the body is gone
    // by the time the entry is written, so they travel with the record the owner does.
    const { title, messageCount } = summarizeSession(session);
    const record: SessionDeletionRecord = { owner, actor, summary: { title, messageCount } };
    const key = sessionDeletionOwnerKey(session.id, session.incarnation);
    sessionDeletionOwners.set(key, record);
    try {
      await kvStore.set(key, serializeSessionDeletionRecord(record));
    } catch (error: unknown) {
      // The deletion does not go ahead without its owner: once the session is gone,
      // nothing can supply the owner its audit entry needs, in this process or any
      // other, so the caller is told and the session is left for it to retry.
      sessionDeletionOwners.delete(key);
      throw new Error(
        `Could not record the owner of session "${session.id}" before deleting it; the session was not deleted: ${serializeUnknownError(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * The steps before any session is removed, whether `deleteSession` removes it or an expiry
   * (`sessionStore.cleanup`) does, so the two cannot differ:
   *
   * - each session's owner is recorded for its deletion's audit entry; a record that cannot be
   *   written keeps every session;
   * - COR-1481: the user's message text does not outlive the context it belonged to, so each
   *   task of the incarnation keeps its status and cleanup and loses its history. This runs
   *   before the removal commits, so a failure leaves the context in place and a retry finds it.
   */
  async function prepareSessionsForRemoval(
    sessions: readonly AgentSession[],
    actor?: string,
  ): Promise<void> {
    for (const session of sessions) await recordSessionDeletionOwner(session, actor);
    for (const session of sessions) await tasks.clearHistory(session.id, session.incarnation);
  }

  /**
   * Reads the owner record back into memory before the deletion event is dispatched.
   * Resolves `true` when the read succeeded, whether it found a record or a definite
   * miss (a deletion that bypassed Bureau), and `false` when the read itself threw: the
   * caller must then leave the deletion pending, because acknowledging it would write
   * the audit entry without an owner and delete the only copy of it.
   */
  async function loadSessionDeletionOwner(
    sessionId: string,
    incarnation: string,
  ): Promise<boolean> {
    const kvStore = runtime.kv;
    if (!kvStore) return true;
    const key = sessionDeletionOwnerKey(sessionId, incarnation);
    if (sessionDeletionOwners.has(key)) return true;
    try {
      const stored = await kvStore.get(key);
      if (stored !== null) sessionDeletionOwners.set(key, parseSessionDeletionRecord(stored));
      return true;
    } catch (error: unknown) {
      // A record that is present but not valid text is a definite miss, like one that
      // is absent: nothing can ever read an owner from it, and retrying would jam
      // every later outbox entry behind it. It is audited without an owner and
      // removed with the rest. Only the strict decoder's own error code says so: a
      // bare `TypeError` is also what `fetch` throws when an HTTP-backed store is
      // unreachable, and that is the store failing, which is retried.
      if (isInvalidEncodingError(error)) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] The recorded owner of deleted session "${sessionId}" cannot be decoded; its deletion entry will have none: ${serializeUnknownError(error)}`,
          cause: error,
        });
        return true;
      }
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] Could not read the recorded owner of deleted session "${sessionId}"; leaving its deletion pending for a later drain to retry: ${serializeUnknownError(error)}`,
        cause: error,
      });
      return false;
    }
  }

  async function removeSessionDeletionOwner(sessionId: string, incarnation: string): Promise<void> {
    const key = sessionDeletionOwnerKey(sessionId, incarnation);
    sessionDeletionOwners.delete(key);
    try {
      await runtime.kv?.delete(key);
    } catch (error: unknown) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] Could not remove the owner record of deleted session "${sessionId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  /**
   * Marks every still-running run of session `id` as orphaned and aborts the ones
   * that are not paused, for a session that is about to be removed, by
   * `deleteSession` or by the store's own `cleanup()` (COR-718). Shared so that an
   * expiry is a deletion in this respect too: without it an expired session's run
   * would keep executing and write its terminal transcript into whatever session
   * the id names by then.
   *
   * The runs are found the same way `listRuns` attributes a run to a session, via
   * `getRunSessionIdentifier`, not the narrower `persistedApprovalRunIds` (AB-207).
   * Every still-live run is marked in `orphanedRunIds` BEFORE any of it is aborted
   * or released, so its eventual terminal `saveSession` call never resurrects the
   * record it belonged to (PR #430, "Prevent released runs from recreating deleted
   * sessions"), whichever way it settles. A run paused through the session's
   * steering gate is left for `settleForDeletion` to release rather than aborted
   * here, which keeps a usable control path until it terminates. The returned
   * `runTerminals` settle when each run's own terminal event has fired.
   */
  function abandonSessionRuns(id: string): {
    sessionRunIds: Set<string>;
    steeringGate: BureauSteeringGate | undefined;
    runTerminals: Array<Promise<void>>;
    /** COR-1481 — the tasks that were live when the session's deletion began, with their cleanup. */
    liveTasks: Array<{ taskId: string; closed: Promise<RunCleanupAcknowledgement> }>;
  } {
    const state = store.getState();
    const sessionRunIds = new Set<string>();
    for (const [, runState] of state.runs) {
      if (getRunSessionIdentifier(runState) === id) sessionRunIds.add(runState.id);
    }
    for (const runId of sessionRunIds) {
      const runState = store.getRun(runId);
      if (runState?.status === 'running') orphanedRunIds.add(runId);
    }
    const steeringGate = steeringGates.get(id);
    const runTerminals: Array<Promise<void>> = [];
    const liveTasks: Array<{ taskId: string; closed: Promise<RunCleanupAcknowledgement> }> = [];
    for (const runId of sessionRunIds) {
      const runState = store.getRun(runId);
      if (runState?.status !== 'running') continue;
      runTerminals.push(whenActiveRunTerminal(runState.activeRun));
      const closed = runState.activeRun.closed();
      void tasks.watchCleanup(runId, closed);
      liveTasks.push({ taskId: runId, closed });
      const isPaused = steeringGate?.forRun(runId).getDesiredState().paused ?? false;
      if (!isPaused) abortRun(runId);
    }
    return { sessionRunIds, steeringGate, runTerminals, liveTasks };
  }

  /**
   * COR-713: a session's rows claim every managed asset they reference (supplied or generated, user
   * or assistant) under holders keyed by the session and the row, so the asset policy's retention
   * floor cannot expire an asset a persisted row still points at, and a row copied into another
   * session is claimed there under that session's own holder. Every way a row enters a session's
   * history is a session commit, and every commit is replayed through the outbox drain, which
   * calls {@link claimSessionAssets}. The claim is the asset service's own `retain`; a claim that
   * cannot be made or released only changes how long an asset lives, so a failure is reported and
   * never fails the commit, the drain or the deletion.
   */
  const claimedRowAssets = new Set<string>();

  /**
   * Skips the claim pass has already warned about, so a session that records no owner reports each
   * one once for the life of the process instead of on every save.
   */
  const reportedOwnerlessSkips = new Set<string>();

  function rowClaimContext(session: AgentSession) {
    const service = assetServiceHolder.current;
    if (service === undefined) return undefined;
    // A session records its owner when it is created. One that records none is claimed as the
    // local principal, which cannot see an asset another principal owns (COR-1581).
    const ownerless = session.metadata[SESSION_OWNER_METADATA_KEY] === undefined;
    return {
      service,
      principalId: ownerOrLocal(resolveSessionOwner(session.metadata)),
      holderOf: (rowId: string) => sessionRowHolderId(session.id, session.incarnation, rowId),
      rows: Object.values(session.conversationHistory.messages),
      onFailure: (assetId: string, error: unknown, rowId: string) =>
        diagnose({
          level: 'error',
          scope: 'assets',
          message: isPermanentClaimFailure(error)
            ? `[bureau] Skipping the retention claim of session "${session.id}" on asset "${assetId}" in row "${rowId}" for as long as this process runs, because the asset's stored record is corrupt; once it is repaired, the claim is made by a later retain of the asset or by the session's next save after a restart (a restart alone does not replay it): ${serializeUnknownError(error)}`
            : `[bureau] Could not update the retention claim of session "${session.id}" on asset "${assetId}" in row "${rowId}": ${serializeUnknownError(error)}`,
          cause: error,
        }),
      // A release that fails only changes how long an asset lives, so it is reported and moves on.
      onReleaseFailure: (assetId: string, error: unknown, rowId: string) =>
        diagnose({
          level: 'error',
          scope: 'assets',
          message: `[bureau] Could not release the retention claim of session "${session.id}" on asset "${assetId}" in row "${rowId}": ${serializeUnknownError(error)}`,
          cause: error,
        }),
      // An asset the principal cannot see is skipped quietly when the session has an owner: a hook
      // can supply a reference its owner may not read. Without one, the skip is probably this.
      onSkipped: ownerless
        ? (assetId: string, error: unknown, rowId: string) => {
            const key = `${session.id}\u0000${session.incarnation}\u0000${rowId}\u0000${assetId}`;
            if (reportedOwnerlessSkips.has(key)) return;
            reportedOwnerlessSkips.add(key);
            diagnose({
              level: 'warn',
              scope: 'assets',
              message: `[bureau] Session "${session.id}" records no owner, so its claim on asset "${assetId}" in row "${rowId}" was made as the local principal and skipped: ${serializeUnknownError(error)}`,
              cause: error,
            });
          }
        : undefined,
    };
  }

  /**
   * Takes the claims of every row in a committed session. A claim that fails transiently is
   * reported and then thrown once every row has been tried, so the outbox drain leaves the commit's
   * entry unacknowledged and replays it: the entry is the only cue that a committed row still needs
   * its claim. A claim that fails permanently (a corrupt asset record) is reported and remembered
   * with the claims already taken, and never thrown: retrying it cannot help, and an entry held
   * back for it would hold back every session's events until someone repaired the asset store.
   */
  async function claimSessionAssets(session: AgentSession): Promise<void> {
    const context = rowClaimContext(session);
    if (context === undefined) return;
    let transientFailure: { error: unknown } | undefined;
    await claimRowAssets(
      context.service,
      context.principalId,
      context.holderOf,
      context.rows,
      {
        workspaceAuthority: runtimeWorkspaceOwnerAuthority(workspace, context.principalId),
        onFailure: (assetId, error, rowId) => {
          context.onFailure(assetId, error, rowId);
          if (!isPermanentClaimFailure(error)) transientFailure ??= { error };
        },
        onSkipped: context.onSkipped,
      },
      claimedRowAssets,
    );
    // COR-1664 — the session may have been deleted while its claims were being taken (a goal
    // handoff or a drain holds a snapshot loaded before the delete). The delete released what it
    // saw, so a claim taken after that is released here, from the asset side. A session deleted
    // after this check releases every claim already taken. It runs before a transient failure is
    // rethrown: a retain that succeeded earlier in the pass must not be stranded by a later one.
    let checkFailure: { error: unknown } | undefined;
    try {
      const stillLive = await runtime.sessionStore?.load(session.id);
      if (runtime.sessionStore !== undefined && stillLive?.incarnation !== session.incarnation) {
        await releaseClaimsByHolderPrefix(
          context.service,
          sessionRowHolderPrefix(session.id, session.incarnation),
          (claim, error) => context.onReleaseFailure(claim.assetId, error, claim.holderId),
          claimedRowAssets,
        );
      }
    } catch (error) {
      checkFailure = { error };
    }
    if (transientFailure !== undefined) throw transientFailure.error;
    if (checkFailure !== undefined) throw checkFailure.error;
  }

  /**
   * COR-1934 — the managed assets a session holds: the ones its rows reference, owned by the
   * session's owner, and the ones it holds a claim on, owned by whoever owns the asset. Read before
   * the delete, because the rows are gone by the time the purge runs and the delete releases the
   * claims. An asset it never claimed is found by its row, and one whose row compaction removed by
   * its claim.
   */
  async function chatAssetsOf(session: AgentSession): Promise<ChatAsset[]> {
    const context = rowClaimContext(session);
    if (context === undefined) return [];
    const found = new Map<string, ChatAsset>();
    for (const row of context.rows) {
      for (const assetId of managedAssetIdsOf(row)) {
        found.set(assetId, { assetId, ownerId: context.principalId });
      }
    }
    const claims = await heldClaimsOf(
      context.service,
      sessionRowHolderPrefix(session.id, session.incarnation),
    );
    for (const claim of claims) {
      // An asset the chat's owner only read (another principal's, shared with them) is that
      // principal's to keep or delete: the chat released its claim, and that is all it did.
      if (claim.ownerId !== context.principalId) continue;
      found.set(claim.assetId, { assetId: claim.assetId, ownerId: claim.ownerId });
    }
    return [...found.values()];
  }

  /**
   * COR-1934 — whose memory, and under which agent, the chat's runs wrote, named before the delete
   * because the task records that otherwise say so can be gone by the time the purge runs (a
   * `retention.tasks` shorter than memory's retention).
   */
  function chatMemoryPlacementsOf(
    session: AgentSession,
    runIds: readonly string[],
  ): RunMemoryPlacement[] {
    const placements = new Map<string, RunMemoryPlacement>();
    for (const runId of runIds) {
      const owner = resolveRunMemoryOwner(session.metadata, runId);
      placements.set(`${owner}\u0000${session.agentName}`, { owner, agentName: session.agentName });
    }
    return [...placements.values()];
  }

  async function releaseSessionGeneratedAssets(session: AgentSession): Promise<void> {
    const context = rowClaimContext(session);
    if (context === undefined) return;
    await releaseRowAssetClaims(
      context.service,
      context.principalId,
      context.holderOf,
      context.rows,
      context.onReleaseFailure,
      claimedRowAssets,
    );
    // COR-1664 — the walk above reaches only the rows the session holds now. A row compaction (or
    // a replaced history) removed still has its claim, so the deleted incarnation's whole holder
    // prefix is released from the asset side, at the deletion rather than at the next boot or
    // maintenance pass. Only this incarnation: an id recreated since has its own claims.
    await releaseClaimsByHolderPrefix(
      context.service,
      sessionRowHolderPrefix(session.id, session.incarnation),
      (claim, error) => context.onReleaseFailure(claim.assetId, error, claim.holderId),
      claimedRowAssets,
    );
  }

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

  /** Releases the claims of runs that ended and sessions that were deleted; never rejects. */
  async function reconcileAssetClaims(): Promise<void> {
    await assetClaimReconciler.reconcileRunClaims();
    await assetClaimReconciler.reconcileSessionClaims();
  }

  /**
   * COR-1986 — the thread's lease, taken for a delete. An AG-UI start or resume decides under the
   * same lease, so a delete and a start cannot interleave into a chat that is created again after
   * it was deleted. A held lease is waited for on the injected timers, for as long as its holder
   * renews it or until it expires; the wait ends with a `BureauShuttingDownError` once admission
   * closes. A Bureau with no durable store has no session to delete and takes no lease.
   */
  async function acquireThreadLeaseForDeletion(id: string): Promise<AgUiLease | undefined> {
    if (runtime.kv === undefined) return undefined;
    const threadLeases = createAgUiLeases({ kv: runtime.kv, runtime: runtimeServices });
    for (;;) {
      const lease = await threadLeases.acquire('thread', id);
      if (lease !== undefined) return lease;
      if (runAdmissionClosed) {
        throw new BureauShuttingDownError(
          'Cannot delete: Bureau is shutting down.',
          runtimeServices.clock.nowISO(),
        );
      }
      await new Promise<void>((resolve) => {
        runtimeServices.timers.setTimeout(resolve, THREAD_LEASE_RETRY_MILLISECONDS);
      });
    }
  }

  /**
   * Whether `session` is still past a retention cutoff: its last activity is before `idleBefore`
   * and no task of it is live, so deleting it cancels nothing a person is waiting on.
   */
  async function isIdleBefore(session: AgentSession, idleBefore: number): Promise<boolean> {
    if (Date.parse(session.updatedAt) >= idleBefore) return false;
    const activity = await tasks.activityOf(
      [session.id],
      new Map([[session.id, session.incarnation]]),
    );
    return activity.get(session.id) === 'idle';
  }

  /**
   * COR-1986 — reads the session to delete and, when there is one to delete, records that its id
   * was deleted BEFORE anything is removed, under the thread's lease. A tombstone that cannot be
   * written refuses the delete, so nothing is removed; one that was written is never taken back,
   * so a delete that fails after it leaves a chat that refuses starts and is finished by a retry.
   * Every chat is given one, a tried agent's included: its agent goes with it, but a start that
   * names the same thread id through a catalog agent would otherwise recreate it with every row.
   */
  async function loadSessionAndTombstone(
    id: string,
    expectedIncarnation: string | undefined,
    idleBefore: number | undefined,
  ): Promise<AgentSession | 'active' | undefined> {
    const sessionStore = requireSessionStore();
    const lease = await acquireThreadLeaseForDeletion(id);
    try {
      const session = await sessionStore.load(id);
      // COR-1481 — the caller authorized one incarnation of this id. An id reused since is
      // another context, and nothing of it is cancelled or deleted here.
      if (expectedIncarnation !== undefined && session?.incarnation !== expectedIncarnation) {
        return undefined;
      }
      // A retention sweep's expiry is decided again here, under the lease a chat start takes
      // before it adds a message, and before the tombstone, which is never taken back.
      if (
        session !== undefined &&
        idleBefore !== undefined &&
        !(await isIdleBefore(session, idleBefore))
      ) {
        return 'active';
      }
      if (session !== undefined && runtime.kv !== undefined) {
        await writeContextTombstone(runtime.kv, {
          version: 1,
          contextId: id,
          owner: resolveSessionOwner(session.metadata) ?? null,
          deletedAt: runtimeServices.clock.now(),
        });
      }
      return session;
    } finally {
      if (lease !== undefined) await releaseQuietly(lease);
    }
  }

  async function performDeleteSession(
    id: string,
    expectedIncarnation: string | undefined,
    onStoreDeletionCommitted: () => void,
    actor?: string,
    idleBefore?: number,
  ): Promise<ContextDeletionReport> {
    const sessionStore = requireSessionStore();
    const loaded = await loadSessionAndTombstone(id, expectedIncarnation, idleBefore);
    // A retention sweep's chat that was active since it was listed is kept.
    if (loaded === 'active') return { deleted: false, tasks: [] };
    const session = loaded;
    // A caller that named another incarnation than the stored one deletes nothing.
    if (expectedIncarnation !== undefined && session === undefined) {
      return { deleted: false, tasks: [] };
    }
    if (session) {
      // A sweep deletes the incarnation it found idle, never one created under the id since.
      const fencedIncarnation =
        expectedIncarnation ?? (idleBefore === undefined ? undefined : session.incarnation);
      // COR-1934 — before anything is removed: the purge that follows the commit is owed from here,
      // and a delete that cannot record it is refused, so the chat is deleted again whole.
      const runIds = await chatRunIdsOf(session);
      const deletedChat: DeletedChat = {
        sessionId: id,
        incarnation: session.incarnation,
        runIds,
        assets: await chatAssetsOf(session),
        memoryPlacements: chatMemoryPlacementsOf(session, runIds),
      };
      await chatContentPurge.record(deletedChat);
      await prepareSessionsForRemoval([session], actor);
      for (const runId of persistedApprovalRunIds(session.metadata)) {
        await revokePendingApprovalsForRun(runId, {
          status: 'revoked',
          principal: 'system:session-deletion',
        });
        for (const reviewId of pendingApprovalOverrides.keys()) {
          if (reviewId.startsWith(`approval:${runId}:`)) dropPendingApprovalOverride(reviewId);
        }
        for (const reviewId of invalidApprovalReviewIds) {
          if (reviewId.startsWith(`approval:${runId}:`)) invalidApprovalReviewIds.delete(reviewId);
        }
      }

      // AB-207: abort every NON-PAUSED run this session owns, found the same
      // way `listRuns` attributes a run to a session — via
      // `getRunSessionIdentifier` — not the narrower `persistedApprovalRunIds`
      // set above (a run with no pending approval was previously left
      // running past its session's deletion). A run currently paused via
      // this session's steering gate is deliberately left alone here: it is
      // RELEASED (not aborted) by `settleForDeletion` further down, exactly
      // as PR #430's P1 finding ("Prevent released runs from recreating
      // deleted sessions") already established — aborting it here instead
      // would abort-terminate it via a different path than that release,
      // regressing the "retain a usable control path until they terminate"
      // behavior that fix relies on. Every running run's own terminal event
      // (`run.completed`/`run.aborted`/`run.error`) — whether reached via
      // this abort or via the later release — is awaited AFTER
      // `settleForDeletion` runs, so this function's returned promise never
      // resolves while a session run is still cleanup-pending.
      const {
        sessionRunIds,
        steeringGate: steeringGateForAbort,
        runTerminals,
        liveTasks,
      } = abandonSessionRuns(id);
      // COR-1482: a schedule fire is a live task of its context too, though it is not in the run
      // store, so deleting the context stops it as it stops every other live task in it.
      for (const fire of await tasks.unsettledFiresOfContext(id, session.incarnation)) {
        const cancelled = await tasks.cancel(fire.taskId, 0).catch((error: unknown) => {
          diagnose({
            level: 'error',
            scope: 'task-registry',
            message: `[bureau] Could not cancel schedule fire "${fire.taskId}" with its context "${id}": ${serializeUnknownError(error)}`,
            cause: error,
          });
          return undefined;
        });
        if (cancelled === undefined || cancelled.receipt === 'rejected') continue;
        // A fire has no cleanup to acknowledge, so the stop is reported as one nothing confirms.
        // Followed here, so the receipt of this deletion says so even with no wait: left to the
        // caller's wait of zero, the acknowledgement would not have been seen yet and the stop
        // would read as a cleanup still pending.
        const closed: Promise<RunCleanupAcknowledgement> = Promise.resolve({
          status: 'unresolved',
          reason: 'unreachable',
        });
        await tasks.watchCleanup(fire.taskId, closed);
        liveTasks.push({ taskId: fire.taskId, closed });
      }

      // AB-228/AB-371/AB-384, superseded by AB-389: `session.deleted` used
      // to be dispatched directly, right here, immediately after
      // `sessionStore.delete` committed — a deliberate fire-and-forget
      // dispatch coupled to nothing but this call's own completion, built
      // on the `{ returnIncarnation: true }` overload specifically to avoid
      // a race on WHICH incarnation to stamp the event with. That whole
      // concern moves into the store itself: `sessionStore.delete` now
      // appends the `SessionOutboxEntry` — gated on the SAME atomic
      // delete-and-count this call awaits, carrying the SAME race-free
      // incarnation the old overload existed to obtain — in the SAME
      // `conditionalBatch` as the removal, and dispatches only the
      // best-effort `SessionOutboxAppendedEvent` drain trigger this bureau
      // already listens for. `drainOutbox` (below) replays the entry
      // as a fresh `SessionDeletedEvent` onto this SAME emitter, in ordinal
      // order against every other pending entry, once its own durable
      // write has settled — never before, and never merely because this
      // call returned. The plain `boolean` contract is all this call site
      // needs now.
      // COR-1476 — before the delete commits, so a session recreated under this
      // id can never have its own pending input cancelled here. Input admitted
      // in the gap before the delete is left for delivery to refuse by
      // incarnation. A failure must not keep the session from being deleted.
      await retireSessionInputs(id, session.incarnation).catch((error: unknown) => {
        diagnose({
          level: 'error',
          scope: 'session-input',
          message: `[bureau] Could not retire the pending session input of session "${id}" before deleting it: ${serializeUnknownError(error)}`,
          cause: error,
        });
      });
      // COR-1911 — a tried context's agent goes BEFORE the store delete, not after it: once the
      // delete commits, the id is free, and an owner who named the agent could start the id again
      // with it, a context nothing would ever clean up. Without the agent the id answers
      // NOT_FOUND. A delete that throws did not commit, so the context is still live and its
      // agent is held again.
      const triedAgent =
        sessionOriginOf(session.metadata) === 'try'
          ? tryAgents.take(session.agentName, id)
          : undefined;
      let removedLiveRecord: boolean;
      try {
        removedLiveRecord =
          fencedIncarnation === undefined
            ? await sessionStore.delete(id)
            : await sessionStore.delete(id, { expectedIncarnation: fencedIncarnation });
      } catch (error) {
        if (triedAgent !== undefined) tryAgents.hold(triedAgent);
        // The delete did not commit: the purge is not owed.
        await chatContentPurge.forget(deletedChat);
        throw error;
      }
      onStoreDeletionCommitted();
      if (!removedLiveRecord) await chatContentPurge.forget(deletedChat);
      // COR-1915 — the deleted chat's spend records go with it. A record left behind is ignored
      // anyway, since a chat recreated under the id has another incarnation, so a failure here is
      // diagnosed and never keeps the deletion from finishing.
      if (removedLiveRecord) {
        await chatSpendLedger.forget(id, session.incarnation).catch((error: unknown) => {
          diagnose({
            level: 'error',
            scope: 'chat-spend',
            message: `[bureau] Could not remove the spend records of deleted chat "${id}": ${serializeUnknownError(error)}`,
            cause: error,
          });
        });
      }
      if (removedLiveRecord) await releaseSessionGeneratedAssets(session);
      // AB-389 — drain right here, before anything below that can stall
      // (a genuinely stuck run's terminal await further down must never
      // block this durable fact from landing): this is the ONE call site
      // that can call `drainOutbox()` directly rather than relying
      // solely on the best-effort trigger, since it already knows a commit
      // just happened. Gated on `removedLiveRecord` — "immediately after
      // EACH COMMIT" means no commit, no direct drain: the losing side of
      // an AB-371 cross-process race removed nothing, so it must not also
      // race the winner's own drain for the SAME entry (both bureaus share
      // one persistent outbox, and neither `pending()` nor `acknowledge()`
      // claims an entry exclusively — see this function's own doc comment
      // below on the residual this leaves, for the maintenance-timer and
      // boot-recovery drain paths specifically, which are NOT gated on
      // having personally committed anything). `drainOutbox` is
      // idempotent and single-flighted regardless, so this never duplicates
      // work the trigger (fired synchronously inside `sessionStore.delete`
      // above, for the SAME winning call) might also be running.
      if (removedLiveRecord) {
        try {
          await drainOutbox();
        } catch (error) {
          // Same isolation as `recoverDurableRuns`'s own drain call: the
          // session removal above already committed — a drain failure
          // (this call's own attempt, or another pending entry's) must not
          // make `deleteSession()` itself appear to have failed when the
          // deletion it promised actually succeeded.
          diagnose({
            level: 'error',
            scope: 'recovery',
            message: `[bureau] Session outbox drain failed after deleteSession("${id}") committed; the deletion itself succeeded: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
      }

      // AB-67/AB-199 review findings (PR #430 — Codex P2): a deleted
      // session's steering gate — and its entries in the shared,
      // bureau-wide idempotency ledger — must not survive to be inherited
      // by a session id that gets reused later, or a stale
      // pause/configVersion/command-ledger entry would block or mis-replay
      // against the logically new session. Both removals happen ONLY AFTER
      // `sessionStore.delete` above has actually succeeded ("Keep the gate
      // until session deletion succeeds") — a rejected deletion leaves the
      // still-live session's gate and ledger entries untouched, rather than
      // orphaning a replacement gate a subsequent `submitSteeringCommand`
      // call would otherwise create.
      //
      // `settleForDeletion` runs FIRST, before the gate is discarded: a run
      // still paused when its session is deleted would otherwise have its
      // steering channel simply vanish with the gate — every later
      // `submitSteeringCommand` against the now-deleted session already
      // returns `not-found`, so nothing could ever resume it, and its
      // `runStep` would await a promise this gate's own closure held
      // forever (review finding, PR #430 — Codex P2, "Settle paused runs
      // before deleting their steering gate"). This is also the moment a
      // still-paused run above actually gets released, so `runTerminals`
      // must be awaited AFTER this call, not before it.
      steeringGateForAbort?.settleForDeletion(runtimeServices.clock.nowISO());
      steeringGateForAbort?.purgeFromLedger();
      // Only the gate settled above: if the id was recreated during the
      // awaits since, the new incarnation's gate (and the runs holding it)
      // must survive this deletion's cleanup.
      if (steeringGates.get(id) === steeringGateForAbort) steeringGates.delete(id);
      // The durable side gets the same treatment, for the same reason — a
      // reused session id must not inherit a deleted session's command
      // history — but scoped to the DELETED body's incarnation, captured
      // before the store delete. A session recreated under this id in the
      // meantime has a new incarnation and its own log, which this cleanup
      // never touches; this process's folded view is dropped only if it was
      // a view of the deleted incarnation.
      if (steeringCursors.get(id)?.incarnation === session.incarnation) {
        forgetSessionSteering(id);
      }
      const steeringKv = durableSteeringStore();
      if (steeringKv !== undefined) {
        // Best-effort, like the outbox drain above: the session is already
        // gone, so a failure here must not make the deletion look failed. The
        // log it leaves is removed by the boot sweep of orphaned logs.
        try {
          await enqueueSteering(id, () => deleteSteeringLog(steeringKv, id, session.incarnation));
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'steering',
            message: `[bureau] Session "${id}" was deleted, but its steering log could not be removed; the next boot sweep removes it: ${serializeUnknownError(error)}`,
          });
        }
      }

      await Promise.allSettled(runTerminals);

      for (const runId of sessionRunIds) {
        runRequestContexts.delete(runId);
        runToolboxesByRunId.delete(runId);
        releaseRunScope(runId);
        terminalReviewSessions.delete(runId);
        for (const [reviewId, cleanup] of reviewResolutionCleanupPending) {
          if (cleanup.runId === runId) reviewResolutionCleanupPending.delete(reviewId);
        }
      }
      // COR-1911 — a tried context takes the agent it was started with, and the runs it made,
      // with it: the other contexts' runs are history that retention ends.
      if (removedLiveRecord && sessionOriginOf(session.metadata) === 'try') {
        await discardTriedRuns(session, sessionRunIds);
      }
      // COR-1934 — the chat's content goes once its runs have ended, so their last events are in.
      // The deletion has committed: a failure is diagnosed, the pending record stays, and the next
      // maintenance pass or boot finishes the purge.
      if (removedLiveRecord) {
        try {
          await chatContentPurge.run(deletedChat);
        } catch (error) {
          diagnose({
            level: error instanceof ChatRunsNotEndedError ? 'warn' : 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Chat "${id}" was deleted, but its content could not be purged yet; a later maintenance pass retries: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
      }
      return { deleted: removedLiveRecord, tasks: liveTasks };
    }
    await sessionStore.delete(id);
    return { deleted: false, tasks: [] };
  }

  /**
   * Look up the current durable run id for a session. Used by signal/update/query
   * to route the operation to the correct workflow handle.
   *
   * Requires that `lastRunStatus` is `'running'`: completed, aborted, and error
   * sessions retain their `lastRunId` but targeting a terminal workflow with a
   * signal/update would silently mis-route or surface a low-level engine error
   * instead of the expected "no active run" response.
   */
  async function requireSessionRunId(sessionId: string): Promise<string> {
    const session = await requireSessionStore().load(sessionId);
    if (!session || inFlightSessionDeletions.has(sessionId)) {
      throw new BureauError(`Session not found: ${sessionId}`, 'NOT_FOUND');
    }
    const runId = session.metadata['lastRunId'];
    if (typeof runId !== 'string' || !runId) {
      throw new BureauError(`Session ${sessionId} has no active run`, 'NOT_FOUND');
    }
    const runStatus = session.metadata['lastRunStatus'];
    if (runStatus !== 'running') {
      throw new BureauError(`Session ${sessionId} has no active run`, 'NOT_FOUND');
    }
    return runId;
  }

  /**
   * COR-1579 — the delivery id the next `signalSession` call delivers under, set only by
   * {@link deliverHumanWaitDecision} for the synchronous start of that call. `resolveReview`
   * delivers a human-wait decision through the public `bureau.contexts.signal` (one seam, which a
   * host or test can observe), whose signature has no delivery id; the call reads and clears this
   * before its first `await`, so no other call can see it. A wrapper around `bureau.contexts.signal`
   * must therefore call through before it awaits anything, or the delivery goes out unkeyed.
   */
  let keyedSessionDelivery: string | undefined;

  /**
   * Deliver a human-wait decision on a session run keyed by its review id, so a retry or a
   * same-decision resolver in another process delivers it once (Weft deduplicates a keyed signal
   * by its accepted-response marker), and nothing is left buffered for the run's next park.
   */
  function deliverHumanWaitDecision(
    review: Extract<SessionPendingReview, { kind: 'human-wait' }>,
    payload: unknown,
  ): Promise<void> {
    keyedSessionDelivery = humanWaitDeliveryId(review.id);
    try {
      return bureau.contexts.signal(review.sessionId, review.signalName, payload);
    } finally {
      keyedSessionDelivery = undefined;
    }
  }

  async function signalSession(sessionId: string, name: string, payload?: unknown): Promise<void> {
    const signalId = keyedSessionDelivery;
    keyedSessionDelivery = undefined;
    if (!runtime.durable)
      throw new BureauError('Durable engine not configured', 'NOT_CONFIGURED', 'durable');
    const runId = await requireSessionRunId(sessionId);
    const requestContext = runRequestContexts.get(runId);
    if (
      requestContext &&
      isTransportIssuedAuthority(requestContext) &&
      (!requestAuthorityValidator || !(await requestAuthorityValidator(requestContext)))
    ) {
      throw new BureauError(
        'Cannot signal: the request authority is no longer current.',
        'CONFLICT',
      );
    }
    await (signalId === undefined
      ? runtime.durable.engine.signal(runId, name, payload)
      : runtime.durable.engine.signal(runId, name, payload, { signalId }));
    // AB-13 — a signal is how a human-wait park is released (directly, or via
    // `resolveReview`'s human-wait approve path). Reacquire the concurrency
    // slot `HumanWaitParkedEvent` freed. A no-op when this runId was never
    // parked (e.g. a signal delivered to a run that never called
    // `requestHumanInput`) or when no flow control is configured.
    flowController?.markResumed(runId);
  }

  /**
   * AB-42/AB-194 — admit a caller's session input. Pre-admission checks run
   * in AB-42's fixed order: authorization (`not-found`) first, then session
   * lifecycle (`session-terminal`), then capability/capacity
   * (`unsupported-capability`) — reversing the first two would let an
   * unauthorized caller learn a session exists.
   *
   * COR-435/COR-1476: on a durably-configured bureau an authorized request to
   * a non-terminal session is admitted to the session's mailbox (`admitted`,
   * `replayed`, `conflict`, or `backlog-exhausted`). An admitted input ends
   * `promoted` once a live run's step boundary appends its user turn (at most
   * once, in admission order within a run, keyed by the mailbox command, under
   * the input's own id, and promoted in the write that saves the turn), or
   * `canceled` when its run ends first, so the client resends it. Bureau never
   * starts a run to answer input: after the admission commits this method
   * reads the session's liveness, and with no run live or starting it cancels
   * the input itself and returns the re-read receipt (see
   * `session-input-settlement.ts`). `steer` and `queue` share that one FIFO
   * path. A bureau with no durable mailbox, or a session id too long to
   * address one, answers `unsupported-capability`.
   */
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

  function assertSessionInputAdmissionOpen(): void {
    if (runAdmissionClosed) {
      throw new BureauError('Cannot submit session input: Bureau is shutting down.', 'CONFLICT');
    }
  }

  async function submitSessionInput(
    sessionId: string,
    callerRequest: SessionInputAdmissionRequest,
  ): Promise<SessionInputAdmissionOutcome> {
    // Unlike signalSession, this does NOT throw
    // BureauError('NOT_CONFIGURED') when no session store is composed: an
    // ephemeral bureau (no persistence/storage) is a supported configuration,
    // and every sessionId is necessarily unknown in it — the correct outcome
    // per this method's own contract is `not-found`, not a throw.
    // A durable admission reads the engine and the log from its first await to
    // its last, so shutdown waits for the whole of it before it disposes
    // either; once shutdown starts, none begins, as for steering.
    assertSessionInputAdmissionOpen();
    // COR-716: a payload no run could read is refused here, at the contract's own door,
    // rather than admitted and then rejected without retry when a step boundary decodes it.
    try {
      parseSessionInputPayload(callerRequest.payload);
    } catch (error) {
      toBadRequest(
        `"payload" is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // COR-1661: `expiresAt` bounds how long the input may wait, so it must be an instant.
    if (
      callerRequest.expiresAt !== undefined &&
      Number.isNaN(Date.parse(callerRequest.expiresAt))
    ) {
      toBadRequest('"expiresAt" must be an ISO 8601 timestamp');
    }
    // The caller owns its payload and may edit it as soon as this call yields, but the
    // admission awaits the session, its liveness, and the mailbox before it persists.
    // Copy what was validated, now, and admit the copy.
    const request: SessionInputAdmissionRequest = {
      ...callerRequest,
      payload: snapshotPayload(callerRequest.payload),
    };
    const sessionStoreForInput = runtime.sessionStore;
    const session = sessionStoreForInput ? await sessionStoreForInput.load(sessionId) : undefined;
    // `session` truthy implies `sessionStoreForInput` was truthy above, but
    // TypeScript cannot carry that narrowing across the ternary into later
    // code — this makes it explicit rather than asserting it away.
    if (!session || !sessionStoreForInput) {
      return { outcome: 'not-found' };
    }
    // COR-1481: input to a context being deleted reads as input to one that is gone.
    if (inFlightSessionDeletions.has(sessionId)) return { outcome: 'not-found' };
    // COR-1661: input checked against an earlier incarnation of the context is input to a session
    // that is not there, whatever now answers to its id.
    if (request.incarnation !== undefined && request.incarnation !== session.incarnation) {
      return { outcome: 'not-found' };
    }
    // COR-301/COR-1569: the same live-run-aware checks steering makes,
    // across every process sharing this backend. A request carries no run
    // id, so authorization targets the session's sole live run.
    const preAdmission = await resolveLiveSessionPreAdmission(
      sessionId,
      session,
      request.principal,
    );
    if (preAdmission.verdict === 'not-found') return { outcome: 'not-found' };
    if (preAdmission.verdict === 'session-terminal') {
      return { outcome: 'session-terminal', sessionId };
    }

    // `tryGet...`, not `get...`: a session id Weft cannot address as a mailbox
    // resource (over 256 bytes) is a deployment limit, so it answers
    // `unsupported-capability` like a bureau with no mailbox rather than throwing.
    const sessionMailbox = tryGetSessionInputMailbox(sessionId, session.incarnation);
    const storage = runtime.durableStorage;
    const kv = runtime.kv;
    if (sessionMailbox === undefined || storage === undefined || kv === undefined) {
      return { outcome: 'unsupported-capability', reason: 'durable-mailbox-unavailable' };
    }
    // A mailbox exists only with the durable engine (`getSessionInputMailbox`),
    // and the engine with `kv` is what composes the settlement, so it is never
    // absent here; this only narrows the type, and fails loudly if the
    // composition above ever changes.
    if (sessionInputSettlement === undefined) {
      throw new Error('Session-input admission reached a bureau without its settlement.');
    }

    const id = request.id ?? runtimeServices.identifiers.next('session-input');
    const reservationKey = `${request.principal}\u0000session-input\u0000${id}`;

    const payload: PersistedSessionInput = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      incarnation: session.incarnation,
      payload: request.payload,
      ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
      ...(request.supersedes !== undefined ? { supersedes: request.supersedes } : {}),
    };

    // ORDERING (see `session-input-settlement.ts`): the session's marker is
    // written BEFORE the admission, so admitted input is never missing from the
    // sweep's index; the admission commits BEFORE liveness is read below, and the
    // ending run reads the mailbox only after its own not-live write, so one side
    // always sees the other. A failure writing the marker refuses the admission.
    // Checked again after the awaits above: a shutdown that started during them
    // must not find a new admission outside its drain.
    assertSessionInputAdmissionOpen();
    // One admission of a `(principal, id)` at a time in this process, each
    // answered on its own: a concurrent submission with another payload reads
    // the mailbox's `conflict`, and one for another session reads the
    // identity's. Nothing is coalesced into another call's receipt.
    const previous = inFlightSessionInputAdmissions.get(reservationKey);
    const runAdmission = (): Promise<SessionInputAdmissionAttemptOutcome> =>
      (async () => {
        await sessionInputSettlement.markOpen(sessionId, session.incarnation);
        return admitSessionInput({
          storage,
          kv,
          sessionMailbox,
          sessionId,
          incarnation: session.incarnation,
          id,
          principal: request.principal,
          deliveryMode: request.deliveryMode,
          payload,
          principalBacklogLimit: sessionInputPrincipalBacklogLimit(),
          sessionBacklogLimitForCrossSessionRead: sessionInputSessionBacklogLimit(),
          nowMs: runtimeServices.clock.now(),
        }).catch((error: unknown): SessionInputAdmissionAttemptOutcome => {
          // COR-1934: the chat was deleted and its mailbox purged while this admission was in
          // flight; it is refused as any input to a chat that is gone.
          if (error instanceof SessionInputMailboxPurgedError) return { outcome: 'not-found' };
          throw error;
        });
      })();
    const admission = (
      previous === undefined ? runAdmission() : previous.then(runAdmission, runAdmission)
    )
      .then(async (outcome): Promise<SessionInputAdmissionOutcome> => {
        if (outcome.outcome !== 'admitted') return outcome;
        const { receipt, commandId } = outcome;
        const admitted: SessionInputAdmissionOutcome = { outcome: 'admitted', receipt };
        if (sessionInputSettlement === undefined) return admitted;
        // The marker written before the admission can be removed in between by
        // a sweep that read it, found the mailbox still empty, and deleted it
        // after the admission committed. Bumping it again now, with the input
        // durable, keeps the session listed whatever happened to the first bump.
        try {
          await sessionInputSettlement.markOpen(sessionId, session.incarnation);
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'session-input',
            message: `[bureau] Could not re-mark session "${sessionId}" as having open input after admitting "${id}": ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        // Shutdown releases open input rather than cancelling it; the next
        // boot's recovered run delivers it, or the sweep cancels it.
        if (isSessionInputClosed()) return admitted;
        // COR-1476 — the admission above is committed. Only now is liveness
        // read, after catching up the steering log, so a run whose `run-ended`
        // entry another process wrote is not counted live. No run live or
        // starting means nothing will ever deliver the input, so it is
        // cancelled here and the caller reads `canceled`. A liveness read that
        // fails is answered the same way: an input admitted on a guess would
        // be left open.
        let live: readonly string[];
        try {
          const steeringKv = durableSteeringStore();
          if (steeringKv !== undefined) {
            await enqueueSteering(sessionId, () =>
              catchUpSteering(steeringKv, sessionId, session.incarnation),
            );
          }
          live = await liveSessionRunIdsEverywhere(sessionId, session.incarnation);
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'session-input',
            message: `[bureau] Could not read the live runs of session "${sessionId}" after admitting input "${id}"; the input is cancelled rather than left open: ${serializeUnknownError(error)}`,
            cause: error,
          });
          live = [];
        }
        if (live.length > 0) return admitted;
        try {
          await sessionMailbox.requestCancellation({
            commandId,
            reason: SESSION_INPUT_RUN_ENDED_REASON,
          });
          return {
            outcome: 'admitted',
            receipt: await readSessionInputReceipt(kv, sessionMailbox, sessionId, commandId),
          };
        } catch (error) {
          // Still open, and the marker written above lists it for the sweep.
          diagnose({
            level: 'error',
            scope: 'session-input',
            message: `[bureau] Could not cancel input "${id}" of session "${sessionId}", which no run is live to deliver: ${serializeUnknownError(error)}`,
            cause: error,
          });
          return admitted;
        }
      })
      .finally(() => {
        if (inFlightSessionInputAdmissions.get(reservationKey) === admission) {
          inFlightSessionInputAdmissions.delete(reservationKey);
        }
      });
    inFlightSessionInputAdmissions.set(reservationKey, admission);
    return admission;
  }

  /**
   * B06 (row 18k) — takes back one input its own principal admitted and no run has taken yet: a
   * follow-up the person removes before the run reaches it. The command is cancelled in the
   * session's mailbox, so no step boundary can claim it, and the answer says whether that landed
   * in time. A command a run already claimed is the run's: the gate keeps its lease, the step
   * appends the turn, and the cancellation only closes the command once the turn commits, so that
   * case is answered `delivered`, as is an input already promoted. Another principal's input, an
   * unknown id, and an unknown session or incarnation all answer `not-found`.
   */
  async function retractSessionInput(
    sessionId: string,
    request: SessionInputRetractionRequest,
  ): Promise<SessionInputRetractionOutcome> {
    assertSessionInputAdmissionOpen();
    const session = runtime.sessionStore ? await runtime.sessionStore.load(sessionId) : undefined;
    if (session === undefined) return { outcome: 'not-found' };
    if (request.incarnation !== undefined && request.incarnation !== session.incarnation) {
      return { outcome: 'not-found' };
    }
    const sessionMailbox = tryGetSessionInputMailbox(sessionId, session.incarnation);
    const kv = runtime.kv;
    if (sessionMailbox === undefined || kv === undefined) {
      return { outcome: 'unsupported-capability', reason: 'durable-mailbox-unavailable' };
    }
    const admitted = await sessionMailbox.receiptByIdempotencyKey(request.id);
    // An id is unique within its session whatever its principal, so another caller's input is
    // answered as one that is not there.
    if (admitted === null || admitted.caller !== request.principal) {
      return { outcome: 'not-found' };
    }
    const { commandId } = admitted;
    const before = await readSessionInputReceipt(kv, sessionMailbox, sessionId, commandId);
    if (before.state === 'promoted') return { outcome: 'delivered', receipt: before };
    const cancellation = await sessionMailbox.requestCancellation({
      commandId,
      reason: SESSION_INPUT_RETRACTED_REASON,
    });
    // `requested` is a command a step boundary holds. The boundary honors a cancellation that
    // landed before its last check by rejecting the command, so it is never appended; one that
    // landed after is closed once the turn commits, and the run has the input. The wait lets the
    // boundary settle the first kind, and the receipt, never the wait, says which it was: a turn
    // that appended the input is `promoted`, one the boundary rejected has ended undelivered, and a
    // command still open when the wait runs out is held by a step that is appending it.
    if (cancellation.status === 'requested') {
      await sessionMailbox
        .awaitCleanup({
          commandId,
          timeoutMs: SESSION_INPUT_RETRACT_SETTLE_MILLISECONDS,
          pollIntervalMs: 10,
        })
        .catch(() => undefined);
    }
    const receipt = await readSessionInputReceipt(kv, sessionMailbox, sessionId, commandId);
    const endedUndelivered =
      receipt.state === 'canceled' || receipt.state === 'failed' || receipt.state === 'expired';
    const heldByStep = cancellation.status === 'requested' && !endedUndelivered;
    return receipt.state === 'promoted' || heldByStep
      ? { outcome: 'delivered', receipt }
      : { outcome: 'retracted', receipt };
  }

  /**
   * B06 (row 20c) — forget the chat's "Allow for the rest of this chat" grants of `tools`, so Retry
   * on a reply that failed sends the turn again with the interrupted tool back behind its approval.
   * Only the session's metadata changes: every row of the conversation stays, and the failed
   * attempt is kept on record. Like a rename it is not activity, so `updatedAt` does not move.
   */
  async function forgetSessionGrants(
    id: string,
    tools: readonly string[],
    forgetOptions?: { readonly incarnation?: string | undefined },
  ): Promise<readonly string[] | undefined> {
    const sessions = requireSessionStore();
    if (runAdmissionClosed) {
      throw new BureauShuttingDownError(
        'Cannot forget grants: Bureau is shutting down.',
        runtimeServices.clock.nowISO(),
      );
    }
    let forgotten: readonly string[] | undefined;
    await sessions.update(
      id,
      (session) => {
        if (session === undefined) return undefined;
        if (
          forgetOptions?.incarnation !== undefined &&
          session.incarnation !== forgetOptions.incarnation
        ) {
          return undefined;
        }
        const without = withoutGrantsFor(session.metadata, tools);
        forgotten = without.forgotten;
        // Nothing to forget is no write: undefined leaves the session as it is.
        return without.metadata === session.metadata
          ? undefined
          : { ...session, metadata: without.metadata };
      },
      { refreshActivity: false },
    );
    return forgotten;
  }

  /**
   * AB-67/AB-199 — admit a `pause`/`resume` steering command. Pre-admission
   * checks reuse `submitSessionInput`'s fixed order (authorization, then
   * session lifecycle, then capability): an unauthorized caller or unknown
   * `sessionId` returns `not-found`; an authorized caller naming an
   * already-terminal session returns `session-terminal`. Every target other
   * than `pause`/`resume`, and a durably-configured bureau's `pause`/
   * `resume`, returns `unsupported-capability` before this session's
   * `SteeringGate` is ever consulted or created — see
   * `SteeringCommandAdmissionOutcome`'s doc comment for the exact reasons.
   */
  /** Durable steering submissions in progress, which shutdown awaits. */
  const inFlightSteeringSubmissions = new Set<Promise<SteeringCommandAdmissionOutcome>>();

  async function submitSteeringCommand(
    sessionId: string,
    request: SteeringCommandRequest,
  ): Promise<SteeringCommandAdmissionOutcome> {
    // Copied before anything awaits: every check and the decision itself
    // read this copy, so a caller changing its own request object later
    // cannot alter what was validated (its run, or its requested value).
    const snapshot = structuredClone(request);
    // A durable submission reads the engine and the log from its first
    // await to its last, so shutdown waits for the whole of it before it
    // disposes either; once shutdown starts, none begins.
    if (durableSteeringStore() === undefined) return admitSteeringRequest(sessionId, snapshot);
    if (runAdmissionClosed) {
      throw new BureauShuttingDownError(
        'Cannot steer: Bureau is shutting down.',
        runtimeServices.clock.nowISO(),
      );
    }
    const submission = admitSteeringRequest(sessionId, snapshot);
    inFlightSteeringSubmissions.add(submission);
    try {
      return await submission;
    } finally {
      inFlightSteeringSubmissions.delete(submission);
    }
  }

  /**
   * COR-1921 — why a session of `agentName`'s agent may not be switched to `override` because the
   * agent has `limits.cost` and the model's row has no price in the catalog, or `undefined` when
   * it may. The agent is a file agent, bound or `ephemeral` (tried): a code-defined agent has no
   * budget. The row judged is the one the agent's generate runs for the switch.
   */
  function unpricedSwitchRefusalOf(
    agentName: string,
    override: { readonly model: string; readonly provider?: string | undefined },
  ): string | undefined {
    const agent = agentCatalog.find(agentName) ?? tryAgents.peek(agentName);
    const budgeted = agent === undefined ? undefined : readFileAgentCostBudget(agent);
    if (budgeted === undefined) return undefined;
    return unpricedSwitchReason(
      budgeted.budget,
      allowedDescriptorsOfFileAgent(budgeted.models, models.catalog().descriptors),
      override,
    );
  }

  /**
   * COR-1559 — whether `agentName`'s agent allows a session to be switched to `override`: the
   * model must be one `bureau.agents.models` lists for it. A routed or opaque agent lists none, so
   * every override is refused; only an agent this Bureau cannot find is left to the deployment's
   * catalog, which the caller has already checked. A file agent's model must also be one the
   * host's resolver can set up: a model it cannot is not allowed.
   */
  function agentAllowsModel(
    agentName: string,
    override: { readonly model: string; readonly provider?: string | undefined },
  ): boolean {
    const agent = agentCatalog.find(agentName) ?? tryAgents.peek(agentName);
    if (agent === undefined) return true;
    const descriptors = models.catalog().descriptors;
    const allowed = describeAgentModels(agent, descriptors);
    if (!allowsModelOverride(allowed.models, override)) return false;
    if (readFileAgentBinding(agent) === undefined || options.models?.generate === undefined) {
      return true;
    }
    const row = descriptors.find(
      (descriptor) =>
        descriptor.model === override.model &&
        (override.provider === undefined || descriptor.provider === override.provider) &&
        allowsModelOverride(allowed.models, {
          model: descriptor.model,
          provider: descriptor.provider,
        }),
    );
    if (row === undefined) return false;
    try {
      models.generate(row);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * COR-1560 — the fork command ledger: an exact retry of `forkSession`, even after a restart,
   * returns the original result and creates nothing more. It keeps its entries in this Bureau's
   * store, or in memory for an ephemeral one, under a key prefix of its own.
   */
  const forkLedger = createForkLedger(runtime.kv, runtimeServices);
  /** Fork attempts this process is running, by ledger identity, so a concurrent retry waits for one. */
  const inFlightForks = new Map<string, { digest: string; result: Promise<ForkSessionResult> }>();

  async function forkSession(
    sessionId: string,
    request: ForkSessionRequest,
  ): Promise<ForkSessionResult> {
    if (runAdmissionClosed) {
      throw new BureauShuttingDownError(
        'Cannot fork: Bureau is shutting down.',
        runtimeServices.clock.nowISO(),
      );
    }
    const identity = {
      callerId: request.owner,
      target: sessionId,
      requestId: request.commandId,
      operationVersion: FORK_OPERATION_VERSION,
    };
    const digest = digestCommandPayload({ throughMessageId: request.throughMessageId });
    const key = JSON.stringify([identity.callerId, identity.target, identity.requestId]);
    const running = inFlightForks.get(key);
    if (running !== undefined) {
      if (running.digest !== digest) throw forkConflict(request);
      return running.result;
    }
    const attempt = runForkAttempt(sessionId, request, identity, digest);
    inFlightForks.set(key, { digest, result: attempt });
    try {
      return await attempt;
    } finally {
      inFlightForks.delete(key);
    }
  }

  function forkConflict(request: ForkSessionRequest): SessionForkRefusedError {
    return new SessionForkRefusedError(
      'command-conflict',
      `The command "${request.commandId}" was already used to branch from another message.`,
    );
  }

  async function runForkAttempt(
    sessionId: string,
    request: ForkSessionRequest,
    identity: Parameters<typeof forkLedger.claim>[0],
    digest: string,
  ): Promise<ForkSessionResult> {
    const sessions = runtime.sessionStore;
    if (sessions === undefined) {
      throw new BureauError('This Bureau keeps no sessions to branch.', 'BAD_REQUEST');
    }
    // A command already answered is answered again without judging the branch point afresh: the
    // parent may have changed since, and the retry must see what the first attempt made.
    const located = await forkLedger.locate(identity);
    const retained = located.state === 'retained' ? located.entry : undefined;
    if (retained?.state === 'completed' && retained.payloadDigest === digest) {
      return answerOfFork(retained.result);
    }
    const session = await sessions.load(sessionId);
    // COR-1911 — a tried chat has no agent to continue a branch with: its agent is held for it
    // alone, so a branch of it is a context that cannot run. It reads as one that does not exist.
    if (session === undefined || sessionOriginOf(session.metadata) === 'try') {
      throw new BureauError(`Session "${sessionId}" not found`, 'NOT_FOUND');
    }
    if (retained === undefined) {
      await assertBranchPoint(session, request.throughMessageId, {
        record: (runId) => tasks.record(runId),
        pendingApprovals: async (runId) => {
          const live = listPendingReviews()
            .filter((review) => review.kind === 'tool-approval' && review.runId === runId)
            .map((review) => review.id);
          const view = await tasks.get(runId);
          const durable = (view?.openWaits ?? [])
            .filter((wait) => wait.kind === 'tool-approval')
            .map((wait) => wait.reviewId);
          return [...new Set([...live, ...durable])];
        },
      });
    }
    const parentSteering = await getSessionSteering(sessionId);
    const parentRequest = await latestModelRequest(sessionId);
    let outcome: Awaited<ReturnType<typeof forkLedger.claim>>;
    try {
      outcome = await forkLedger.claim(identity, digest, {
        contextId: runtimeServices.identifiers.next('session'),
        override: parentRequest ?? parentSteering?.model ?? null,
        effort: parentSteering?.effort ?? null,
        permissionMode: parentSteering?.permissionMode ?? null,
      });
    } catch (error) {
      if (error instanceof BureauLedgerConflictError) throw forkConflict(request);
      throw error;
    }
    if (outcome.entry.state === 'completed') return answerOfFork(outcome.entry.result);
    const claim = outcome.entry.claim;
    // The identifier is the claim's, so an attempt that died after forking finds its fork, and one
    // that died before it makes the fork under the identifier the ledger already holds.
    try {
      await createSessionHandle(sessionId, {
        store: sessions,
        agentName: session.agentName,
        runtime: runtimeServices,
      }).fork({
        throughMessageId: request.throughMessageId,
        id: claim.contextId,
        owner: request.owner,
      });
    } catch (error) {
      // The parent was deleted, or the message with it, after the checks: nothing was created. The
      // command settles to that failure rather than staying pending, so a retry is refused alike.
      if (!(error instanceof ForkThroughMessageError)) throw error;
      // A fork before the first message names no message: the parent itself is what went away.
      const failure: ForkLedgerFailure = {
        failure:
          error.messageId === null
            ? { reason: 'context-not-found', message: error.message }
            : { reason: 'message-not-found', message: error.message },
      };
      await forkLedger.complete(outcome.entry, failure);
      return answerOfFork(failure);
    }
    const carried =
      claim.override === null
        ? null
        : await carryModelOverride(claim.contextId, {
            id: `${request.commandId}:model`,
            principal: request.owner,
            // As the parent asked: a policy reference is submitted as a reference, and resolved
            // afresh like any carried request; otherwise the explicit override.
            requestedValue:
              claim.override.policyRef === undefined
                ? {
                    target: 'model',
                    override: claim.override.model,
                    ...(claim.override.provider === null
                      ? {}
                      : { provider: claim.override.provider }),
                  }
                : { target: 'model', policyRef: claim.override.policyRef },
          });
    // COR-1935: the effort goes the same way. The claim keeps it, so a retry after a restart
    // carries the one the first attempt read, and a claim from before the field carries none.
    const carriedEffort =
      claim.effort === undefined || claim.effort === null
        ? null
        : await submitSteeringCommand(claim.contextId, {
            id: `${request.commandId}:effort`,
            principal: request.owner,
            requestedValue: { target: 'effort', override: claim.effort },
          });
    // COR-1936: and the permission mode, so a branch of a read-only chat is read-only.
    const carriedPermissionMode =
      claim.permissionMode === undefined || claim.permissionMode === null
        ? null
        : await submitSteeringCommand(claim.contextId, {
            id: `${request.commandId}:permission-mode`,
            principal: request.owner,
            requestedValue: { target: 'permission-mode', override: claim.permissionMode },
          });
    const result: ForkSessionResult = {
      contextId: claim.contextId,
      carriedOverride: carried,
      carriedEffort,
      carriedPermissionMode,
    };
    const completed = await forkLedger.complete(outcome.entry, result);
    return answerOfFork(completed.result);
  }

  /**
   * Admits the model a fork carries from its parent. An agent whose `limits.cost` cannot count the
   * model (COR-1921: its price left the catalog since) refuses it, and the fork answers the carry
   * as rejected, as it does a model the agent no longer allows, rather than failing half made.
   */
  async function carryModelOverride(
    contextId: string,
    request: SteeringCommandRequest,
  ): Promise<SteeringCommandAdmissionOutcome> {
    try {
      return await submitSteeringCommand(contextId, request);
    } catch (error) {
      if (!(error instanceof UnpricedSwitchRefusedError)) throw error;
      return {
        outcome: 'rejected',
        failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'policy-denied' },
      };
    }
  }

  /**
   * The session's latest admitted `model` request as it was made, from the steering record itself
   * (COR-1560): the accepted command with the highest version, and, where Bureau resolved a
   * `policyRef` into that command, the reference the caller submitted. A durable Bureau reads the
   * folded log; an in-process one reads its ledger and the references it kept. `undefined` when
   * the session has had no model request.
   */
  async function latestModelRequest(
    sessionId: string,
  ): Promise<ForkLedgerClaim['override'] | undefined> {
    const session = await runtime.sessionStore?.load(sessionId);
    if (session === undefined) return undefined;
    const kv = durableSteeringStore();
    let ledger: ReturnType<typeof createSteeringCommandLedger> = steeringCommandLedger;
    const gate = steeringGates.get(sessionId);
    let selectors: Map<string, Map<string, SteeringRequestedValue>> = (gate === undefined
      ? undefined
      : submittedSteeringValues.get(gate)) ?? new Map();
    if (kv !== undefined) {
      const cursor = await enqueueSteering(sessionId, () =>
        catchUpSteering(kv, sessionId, session.incarnation),
      );
      ledger = cursor.ledger;
      selectors = cursor.submitted;
    }
    let latest: { principal: string; id: string; version: number; at: string } | undefined;
    for (const [principal, commands] of ledger) {
      for (const [id, command] of commands) {
        if (command.sessionId !== sessionId || command.requestedValue.target !== 'model') continue;
        if (command.state !== 'accepted' && command.state !== 'applied') continue;
        if (
          latest === undefined ||
          command.configVersion > latest.version ||
          (command.configVersion === latest.version && command.requestedAt > latest.at)
        ) {
          latest = { principal, id, version: command.configVersion, at: command.requestedAt };
        }
      }
    }
    if (latest === undefined) return undefined;
    const resolved = ledger.get(latest.principal)?.get(latest.id)?.requestedValue;
    if (resolved?.target !== 'model' || resolved.override === undefined) return undefined;
    const selector = selectors.get(latest.principal)?.get(latest.id);
    const policyRef =
      selector !== undefined && 'policyRef' in selector ? selector.policyRef : undefined;
    return {
      provider: resolved.provider ?? null,
      model: resolved.override,
      ...(policyRef === undefined ? {} : { policyRef }),
    };
  }

  /** What a ledger result answers: the fork, or the refusal the command settled to. */
  function answerOfFork(result: ForkLedgerResult): ForkSessionResult {
    if ('failure' in result) {
      if (result.failure.reason === 'context-not-found') {
        throw new BureauError(result.failure.message, 'NOT_FOUND');
      }
      throw new SessionForkRefusedError(result.failure.reason, result.failure.message);
    }
    return structuredClone(result);
  }

  async function getSessionSteering(sessionId: string): Promise<SessionSteeringState | undefined> {
    const session = runtime.sessionStore ? await runtime.sessionStore.load(sessionId) : undefined;
    if (session === undefined) return undefined;
    const kv = durableSteeringStore();
    let gate: BureauSteeringGate | undefined;
    if (kv === undefined) {
      gate = steeringGates.get(sessionId);
    } else {
      try {
        const cursor = await enqueueSteering(sessionId, () =>
          catchUpSteering(kv, sessionId, session.incarnation),
        );
        gate = cursor.gate;
      } catch (error) {
        // A session deleted while its log was read has no steering to report.
        const afterFailure = await runtime.sessionStore?.load(sessionId);
        if (afterFailure?.incarnation !== session.incarnation) return undefined;
        throw error;
      }
    }
    const desired = gate?.getDesiredState();
    return {
      model:
        desired?.model === undefined
          ? null
          : { provider: desired.modelProvider ?? null, model: desired.model },
      effort: desired?.effort ?? null,
      permissionMode: desired?.permissionMode ?? null,
      configVersion: gate?.getConfigVersion() ?? 0,
    };
  }

  /**
   * COR-1937 — the context-window report of a context. Read-only: the history is the session's
   * persisted one, the instructions and tool schemas come from the agent (or, while this process
   * holds the context's latest run, that run's own toolbox), and the reported usage comes from the
   * latest step recorded for the context. No model is called and nothing is written.
   */
  async function getContextWindow(
    contextId: string,
    windowOptions?: { readonly incarnation?: string | undefined },
  ): Promise<ContextWindowReport | undefined> {
    // Read before the first await: the caller's options are not read again.
    const expectedIncarnation = windowOptions?.incarnation;
    const sessions = requireSessionStore();
    const session = await sessions.load(contextId);
    if (session === undefined) return undefined;
    if (expectedIncarnation !== undefined && session.incarnation !== expectedIncarnation) {
      return undefined;
    }
    const steering = await getSessionSteering(contextId);
    // Deleted while its steering was read.
    if (steering === undefined) return undefined;
    const agent = agentCatalog.find(session.agentName) ?? tryAgents.peek(session.agentName);
    const catalog = models.catalog().descriptors;
    const named =
      steering.model ?? (agent === undefined ? null : describeAgentModels(agent, catalog).default);
    const model =
      named === null
        ? undefined
        : catalog.find(
            (row) =>
              row.model === named.model &&
              (named.provider === null || row.provider === named.provider),
          );

    // Newest first; a context's latest step is the last step of its newest task that has one. One
    // page of `CONTEXT_WINDOW_TASK_SCAN_LIMIT` tasks bounds the reads of a report that clients
    // poll: a context whose newest tasks all ended before a step reports `usedReported: null`.
    const latest = await tasks.enumerate({
      contextId,
      limit: CONTEXT_WINDOW_TASK_SCAN_LIMIT,
      offset: 0,
    });
    let reported: ReportedStepUsage | undefined;
    for (const task of latest.tasks) {
      const liveStep = store.getRun(task.id)?.steps.at(-1);
      // A run this process no longer holds keeps its steps in the durable checkpoint.
      const checkpointed =
        liveStep === undefined ? await runtime.durable?.checkpointStore.loadSteps(task.id) : [];
      const step = liveStep ?? checkpointed?.at(-1);
      if (step === undefined) continue;
      reported = step.usage;
      break;
    }

    const liveToolbox = latest.tasks.map((task) => runToolboxesByRunId.get(task.id)).find(Boolean);
    let toolbox: Pick<AnyToolbox, 'tools'> | undefined = liveToolbox;
    if (toolbox === undefined && agent !== undefined && hasDefinitionResolver(agent)) {
      // The agent's own definition resolves to the toolbox a run of it would start with: a pure
      // build, no run and no model call.
      const resolved = await agent[OPERATIVE_RESOLVE_RUN_OPTIONS]('window', {});
      toolbox = resolved.toolbox;
    }
    const tools: ContextWindowTool[] = (toolbox?.tools() ?? []).map((tool) => {
      const described = tool.toJSON();
      return {
        name: described.name,
        description: described.description,
        input: described.input,
      };
    });

    // Every read above belongs to the incarnation loaded first: an id deleted and created again
    // while they ran is a different context, and this report would mix the two.
    const current = await sessions.load(contextId);
    if (current?.incarnation !== session.incarnation) return undefined;

    // A managed asset is sized from its descriptor as the session's owner, so no bytes are read.
    const assetService = assetServiceHolder.current;
    const owner = ownerOrLocal(sessionOwnerOf(session.metadata) ?? undefined);
    const resolvedSources =
      assetService === undefined
        ? undefined
        : await sizeManagedAssets(session.conversationHistory, async (assetId) => {
            const descriptor = await assetService.inspect(assetId, {
              id: owner,
              workspaceAuthority: runtimeWorkspaceOwnerAuthority(workspace, owner),
            });
            return {
              state: descriptor.state,
              custody: descriptor.custody,
              mediaType: descriptor.mediaType,
              byteLength: descriptor.byteLength,
            };
          });

    return buildContextWindow({
      history: session.conversationHistory,
      instructions: agent === undefined ? undefined : instructionsOf(agent),
      tools,
      model,
      catalog,
      reported,
      resolvedSources,
    });
  }

  /** The system instructions an agent was created with (`createAgent`'s `instructions`), if it declares any. */
  function instructionsOf(agent: object): string | undefined {
    const declared: unknown = Reflect.get(agent, 'instructions');
    return typeof declared === 'string' ? declared : undefined;
  }

  async function admitSteeringRequest(
    sessionId: string,
    request: SteeringCommandRequest,
  ): Promise<SteeringCommandAdmissionOutcome> {
    const session = runtime.sessionStore ? await runtime.sessionStore.load(sessionId) : undefined;
    if (!session) {
      return { outcome: 'not-found' };
    }

    // AB-67/AB-199 review finding (PR #430 — Codex P2): genuinely enumerate
    // this session's live runs through the store's own run registry, rather
    // than inferring cardinality/liveness from the single
    // `metadata['lastRunId']` field — a field that "identifies only the
    // most recently persisted writer, not the sole non-terminal run" under
    // real concurrent runs. `store.getState().runs` + `getRunSessionIdentifier`
    // is Bureau's own existing live-run registry (used identically by
    // `listRuns`/`listPendingReviews` above), not new infrastructure.
    // Computed BEFORE the terminal check below (review finding, PR #430 —
    // Codex P2, "Consult live runs before declaring the session terminal"):
    // `metadata['lastRunStatus']` reflects only the MOST RECENTLY persisted
    // run's own completion, which can go terminal while an OLDER, still
    // non-terminal concurrent run on the same session remains genuinely
    // live — a metadata-only check would reject a command explicitly
    // targeting that still-live run.
    //
    // Computed BEFORE the authorization check too (review finding, PR #430
    // — Codex P2, "Authorize against the targeted live run"): resolving
    // which run this command actually targets — the caller's own explicit
    // `runId`, or the session's sole live run when omitted — lets
    // authorization consult THAT run's own `lastRequestAuthorities` entry
    // directly, rather than a single-run default (`metadata['lastRunId']`),
    // which a DIFFERENT concurrent run's more recent terminal transition can
    // leave pointing at an unrelated, uncorrelated entry. COR-718: authorization
    // now compares the session's owner, which every run on it shares; the
    // targeting is kept for the liveness computation that follows.
    // This computation touches only the internal run registry, never
    // anything derived from `request.principal`, so it leaks nothing to an
    // unauthorized caller ahead of the `not-found` check below.
    // A request naming its run is authorized before anything else runs: the
    // backend-wide liveness query below must neither be triggered by, nor
    // leak its failures to, a caller who may not see this session.
    if (
      request.runId !== undefined &&
      !isSessionAuthorityAuthorized(session.metadata, request.principal, request.runId)
    ) {
      return { outcome: 'not-found' };
    }
    // A key the log already decided is answered by admission from the log,
    // which authorizes the caller against the run that answer discloses:
    // nothing here depends on which runs are live now, so a backend that is
    // unavailable must not stand between a retry and its recorded answer.
    // A new decision is checked here, and again inside admission.
    const keyAlreadyBound = await durableSteeringKeyIsBoundHere(
      sessionId,
      session.incarnation,
      request.principal,
      request.id,
    );
    let liveRunIds: string[] = [];
    if (!keyAlreadyBound) {
      const preAdmission = await resolveLiveSessionPreAdmission(
        sessionId,
        session,
        request.principal,
        request.runId,
        steersIdleSession(request.requestedValue),
      );
      if (preAdmission.verdict === 'not-found') return { outcome: 'not-found' };
      if (preAdmission.verdict === 'session-terminal') {
        return { outcome: 'session-terminal', sessionId };
      }
      liveRunIds = preAdmission.liveRunIds;
    }
    // A refusal Bureau decides here, before the gate, is logged like the
    // gate's own refusals on a durable session, so a caller-supplied id
    // stays decided: a later retry is answered from the log, not re-judged
    // against a catalog or policy that may have changed since.
    // Refused after a `policyRef` resolved, the logged command carries the
    // resolved value that was validated and refused, and the selector is
    // kept beside it, exactly as for an admission.
    const refuseSteering = async (
      outcome: SteeringRefusal['outcome'],
      resolvedFromSelector?: ImplementedSteeringCommand['requestedValue'],
    ): Promise<SteeringCommandAdmissionOutcome> => {
      const kv = durableSteeringStore();
      if (kv === undefined || request.id === undefined) return outcome;
      const refused: ImplementedSteeringCommand = {
        id: request.id,
        idOrigin: 'caller',
        sessionId,
        principal: request.principal,
        requestedValue: resolvedFromSelector ?? request.requestedValue,
        requestedAt: runtimeServices.clock.nowISO(),
        ...(request.expectedRevision !== undefined
          ? { expectedRevision: request.expectedRevision }
          : {}),
        ...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
        ...(request.runId !== undefined ? { runId: request.runId } : {}),
      };
      return enqueueSteering(sessionId, () =>
        admitDurableSteeringCommand(
          kv,
          session.incarnation,
          refused,
          () => liveSessionRunIdsEverywhere(sessionId, session.incarnation, request.runId),
          outcome,
          resolvedFromSelector === undefined ? undefined : request.requestedValue,
        ),
      );
    };
    // AB-200/AB-68: all seven targets reach the gate. `agent-identity` is
    // validated against the agents map below, and `model`/`provider`/
    // `effort` are validated against the model catalog; `route` is not,
    // because Bureau holds no routing table (see the `known` check below).
    // A configuration `policyRef` is first resolved through
    // `modelPolicy.users` (COR-1227). The gate then owns their
    // desired-state writes and per-run `configVersion` accounting.
    const steeringTarget = request.requestedValue.target;
    // A `policyRef` names a pre-approved policy only the AB-66 selector can
    // resolve into a concrete agent name. Until that resolution path exists
    // here, a `policyRef`-carrying command is unsupported rather than
    // guessed at — validating an unresolved reference against the agents
    // map would reject every legitimate policy name.
    if (steeringTarget === 'agent-identity' && request.requestedValue.policyRef !== undefined) {
      return refuseSteering({ outcome: 'unsupported-capability', reason: 'selector-unavailable' });
    }
    // A durably-configured bureau with no resolved storage backend cannot
    // persist a command, and admitting one into the in-memory gate would
    // silently lose it on restart — exactly what the durable contract
    // exists to prevent. That combination is not reachable through normal
    // composition (durable execution resolves ON only when a persistent
    // backend is configured), so this stays a guard rather than a path.
    if (runtime.durable && runtime.durableStorage === undefined) {
      return { outcome: 'unsupported-capability', reason: 'durable-steering-unavailable' };
    }
    // `SteeringRequestedValue`'s own contract: an agent-identity `override`
    // "must be a key of Bureau<D>'s agents map". Validated against the
    // construction-time snapshot every other agent lookup in this module
    // uses, so a name this Bureau cannot run is refused at admission rather
    // than surfacing as an unresolvable agent at the next run's step 0.
    //
    // `policy-denied`: this deployment's own catalog is what refuses the
    // change, which is what that reason already means. (COR-1559 has since
    // widened the union with `model-not-allowed`, `stale-revision` and
    // `shutting-down`, for the reasons that name something `policy-denied`
    // does not.)
    if (
      steeringTarget === 'agent-identity' &&
      !Object.hasOwn(agentsSnapshot, request.requestedValue.override)
    ) {
      return refuseSteering({
        outcome: 'rejected',
        failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'policy-denied' },
      });
    }

    // AB-200 — validate a configuration override against the live model
    // catalog, coordinate by coordinate.
    //
    // NOT through `models.plan`, and the reason is a real constraint
    // rather than a preference. `composePolicy`'s exact-override path
    // (`providers/policy.ts`'s `matchesOverride`) requires provider AND
    // model together — "a partially specified override cannot resolve to
    // one candidate, so it matches nothing" — and rejects any override
    // naming a `route`, because `route` is not a field `BackendDescriptor`
    // carries. A steering command addresses exactly one coordinate, so it
    // can never satisfy that path: routing every one of them through
    // `models.plan` would reject every legitimate single-coordinate
    // command as `no-candidate`. That is the catalog gap AB-65 names.
    //
    // What a steering override actually needs to answer is narrower: "is
    // this coordinate one the deployment knows about?" The accumulated
    // desired configuration is recomputed into a full plan at the runStep
    // selection boundary anyway (AB-250's revalidation), which is where
    // whole-backend coherence is decided. Admission's job is only to stop
    // a value the catalog has never heard of.
    //
    // The one cast: every target the gate cannot admit has already
    // returned above (the four configuration targets are admitted, and
    // `agent-identity` with a `policyRef` returned at the policyRef check),
    // so this value genuinely is one of the gate's accepted variants.
    // TypeScript cannot carry that narrowing across the intervening
    // statements because the checks are separate early returns rather than
    // one discriminating switch.
    let resolvedRequestedValue =
      request.requestedValue as ImplementedSteeringCommand['requestedValue'];
    if (isConfigurationTarget(steeringTarget)) {
      // Narrowing `steeringTarget` does not narrow `request.requestedValue`:
      // they are separate bindings, so the predicate above tells TypeScript
      // nothing about the value's own discriminant. Bind the narrowed view
      // once here rather than casting at each field access.
      const configurationRequest = request.requestedValue as Extract<
        SteeringRequestedValue,
        { target: 'route' | 'model' | 'provider' | 'effort' | 'permission-mode' }
      >;

      // COR-1227 — resolve a `policyRef` to a concrete coordinate.
      //
      // A policyRef names a key of `BureauModelPolicyOptions.users`, whose
      // own doc comment fixes that meaning: "Named policy profiles are keys
      // of `users`". Resolution reads that profile's coordinate for this
      // target and admits the concrete value, so the stored command records
      // what was actually chosen rather than an unresolved reference a
      // later reader would have to re-resolve against possibly-changed
      // configuration.
      //
      // Not through `models.plan`, for the reason the override path below
      // documents: `composePolicy`'s exact-override test needs provider and
      // model together and rejects routes outright, so a single-coordinate
      // request can never satisfy it.
      // `Effort` is a union of string literals, so `string` already
      // covers every coordinate this can hold.
      let override: string | undefined = configurationRequest.override;
      if (configurationRequest.policyRef !== undefined) {
        const users = modelPolicyOf(currentSettings())?.users;
        const profile =
          users !== undefined && Object.hasOwn(users, configurationRequest.policyRef)
            ? users[configurationRequest.policyRef]
            : undefined;
        if (profile === undefined) {
          // Unknown policy name. Distinct from the case below, and the
          // caller is entitled to tell them apart: one is a typo or a
          // decommissioned profile, the other is a profile that simply
          // says nothing about this coordinate.
          return refuseSteering({
            outcome: 'rejected',
            failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'policy-denied' },
          });
        }
        override =
          steeringTarget === 'model'
            ? profile.exactOverride?.model
            : steeringTarget === 'provider'
              ? profile.exactOverride?.provider
              : steeringTarget === 'route'
                ? profile.exactOverride?.route
                : // COR-1936: a policy profile states no permission mode, so there is nothing
                  // to resolve one from.
                  steeringTarget === 'permission-mode'
                  ? undefined
                  : // `effort` has a dedicated profile field beside the
                    // override, and it is the more natural place for a policy
                    // to express one — `exactOverride.effort` still wins when
                    // both are set, matching the override's name.
                    (profile.exactOverride?.effort ?? profile.defaultEffort);
        if (override === undefined) {
          // The profile exists but specifies nothing for this coordinate.
          // Admitting anything here would be inventing a value the policy
          // never stated.
          return refuseSteering({
            outcome: 'rejected',
            failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'policy-denied' },
          });
        }
        // The resolved value is admitted, not the reference. It still falls
        // through to the identical catalog check the `override` path uses
        // below, so a policy cannot admit a coordinate an override could
        // not — that is the authority guarantee, and it needs no second
        // mechanism.
        resolvedRequestedValue = (
          steeringTarget === 'effort'
            ? { target: 'effort', override: override as Effort }
            : steeringTarget === 'permission-mode'
              ? { target: 'permission-mode', override: override as PermissionMode }
              : { target: steeringTarget, override }
        ) satisfies ImplementedSteeringCommand['requestedValue'];
      }
      const { descriptors } = models.catalog();
      // COR-1559: a `model` override may name the provider that serves the model. It is held to
      // the catalog, and below to the agent, as the pair when it does, and as the name alone
      // (every record written before the field existed) when it does not.
      const overrideProvider =
        steeringTarget === 'model'
          ? (configurationRequest as { provider?: string | undefined }).provider
          : undefined;
      const known =
        steeringTarget === 'model'
          ? descriptors.some(
              (descriptor) =>
                descriptor.model === override &&
                (overrideProvider === undefined || descriptor.provider === overrideProvider),
            )
          : steeringTarget === 'provider'
            ? descriptors.some((descriptor) => descriptor.provider === override)
            : steeringTarget === 'effort'
              ? descriptors.some((descriptor) =>
                  descriptor.effort.portable.includes(override as Effort),
                )
              : // COR-1936: a permission mode is Bureau's own, not a catalog row.
                steeringTarget === 'permission-mode'
                ? (PERMISSION_MODES as readonly string[]).includes(override as string)
                : // `route`: a routing entry is configured on the generate
                  // function (`RoutingOptions.routes`), not in the model
                  // catalog, and Bureau does not hold that table. There is
                  // nothing here to validate against, so admission accepts
                  // the name and the routing layer rejects an unknown route
                  // at generate time. Recorded rather than faked: a
                  // membership test against a catalog that structurally
                  // cannot contain routes would reject every valid route.
                  true;
      if (!known) {
        return refuseSteering(
          {
            outcome: 'rejected',
            failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'policy-denied' },
          },
          configurationRequest.policyRef === undefined ? undefined : resolvedRequestedValue,
        );
      }
      // COR-1559: a model a caller names is also held to what the session's agent allows, decided
      // now rather than at a step boundary, and refused through the log like any refusal so a retry
      // is answered the same. Only a steering override is held to it: a model a policy profile
      // resolved is the profile's choice, and one the agent's own routing makes at a step never
      // passes through admission at all.
      if (
        steeringTarget === 'model' &&
        configurationRequest.policyRef === undefined &&
        override !== undefined &&
        !agentAllowsModel(session.agentName, { model: override, provider: overrideProvider })
      ) {
        return refuseSteering(
          {
            outcome: 'rejected',
            failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'model-not-allowed' },
          },
          configurationRequest.policyRef === undefined ? undefined : resolvedRequestedValue,
        );
      }
      // COR-1980: the model policy's deployment and Bureau layers bind a steering choice however it
      // was made, so a model every catalog row of which the policy forbids is refused now, as
      // `policy-denied`, rather than admitted for a step to fail on. A policy profile's resolved
      // model is held to it too: a profile cannot admit what an override could not. A name that
      // also matches an allowed row (another provider's) is admitted; the step judges the row it
      // uses. The policy is read live, so a command admitted before it tightened fails at its step.
      if (steeringTarget === 'model' && override !== undefined) {
        const policy = modelPolicyOf(currentSettings());
        const named = descriptors.filter(
          (descriptor) =>
            descriptor.model === override &&
            (overrideProvider === undefined || descriptor.provider === overrideProvider),
        );
        if (named.every((descriptor) => modelPolicyDenialOf(descriptor, policy) !== undefined)) {
          return refuseSteering(
            {
              outcome: 'rejected',
              failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'policy-denied' },
            },
            configurationRequest.policyRef === undefined ? undefined : resolvedRequestedValue,
          );
        }
      }
    }

    // COR-1921 — a budgeted agent is not switched to a model the catalog cannot price: counting
    // its steps at another model's rate would spend the budget unseen. A key the log already
    // decided (the durable log, or the in-memory ledger of a Bureau with none) is answered from
    // there and skips it. This refusal is a throw, so it is not logged: a retry of it is judged
    // again, and is admitted if the catalog has since gained a price.
    const inMemoryKeyBound =
      durableSteeringStore() === undefined &&
      request.id !== undefined &&
      getSteeringLedgerEntry(steeringCommandLedger, request.principal, request.id) !== undefined;
    if (
      resolvedRequestedValue.target === 'model' &&
      resolvedRequestedValue.override !== undefined &&
      !keyAlreadyBound &&
      !inMemoryKeyBound
    ) {
      const reason = unpricedSwitchRefusalOf(session.agentName, {
        model: resolvedRequestedValue.override,
        provider:
          'provider' in resolvedRequestedValue ? resolvedRequestedValue.provider : undefined,
      });
      if (reason !== undefined) throw new UnpricedSwitchRefusedError(reason);
    }

    const now = runtimeServices.clock.nowISO();
    const id = request.id ?? runtimeServices.identifiers.next('steering-command');
    const command: ImplementedSteeringCommand = {
      id,
      idOrigin: request.id !== undefined ? 'caller' : 'generated',
      sessionId,
      principal: request.principal,
      // For pause/resume/agent-identity this is `request.requestedValue`
      // unchanged, narrowed by the target early returns above. For the four
      // configuration targets it is the selector-resolved coordinate, so a
      // `policyRef` is admitted as the concrete value the plan chose.
      requestedValue: resolvedRequestedValue,
      requestedAt: now,
      ...(request.expectedRevision !== undefined
        ? { expectedRevision: request.expectedRevision }
        : {}),
      ...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
      ...(request.runId !== undefined ? { runId: request.runId } : {}),
    };

    const kv = durableSteeringStore();
    if (kv === undefined) {
      const gate = getSessionSteeringGate(sessionId);
      const outcome = gate.admit(command, { liveRunIds, now });
      if (
        outcome.outcome === 'accepted' &&
        'policyRef' in request.requestedValue &&
        request.requestedValue.policyRef !== undefined
      ) {
        let submitted = submittedSteeringValues.get(gate);
        if (submitted === undefined) {
          submitted = new Map();
          submittedSteeringValues.set(gate, submitted);
        }
        nestedSet(submitted, request.principal, id, request.requestedValue);
      }
      if (outcome.outcome === 'accepted') dispatchSteeringAccepted(sessionId, outcome);
      return outcome;
    }
    const outcome = await enqueueSteering(sessionId, () =>
      admitDurableSteeringCommand(
        kv,
        session.incarnation,
        command,
        () => liveSessionRunIdsEverywhere(sessionId, session.incarnation, request.runId),
        undefined,
        'policyRef' in request.requestedValue && request.requestedValue.policyRef !== undefined
          ? request.requestedValue
          : undefined,
      ),
    );
    if (outcome.outcome === 'accepted') dispatchSteeringAccepted(sessionId, outcome);
    return outcome;
  }

  /**
   * Whether `(principal, id)` is bound in this very session incarnation's
   * log, so admission can answer it from that log and authorize against
   * the run it discloses. A key bound in another session is not: its
   * answer would also reveal this session, so the caller is checked here
   * first like any new request. An unreadable binding reads as unbound
   * here; admission fails closed on it.
   */
  async function durableSteeringKeyIsBoundHere(
    sessionId: string,
    incarnation: string,
    principal: string,
    id: string | undefined,
  ): Promise<boolean> {
    const kv = durableSteeringStore();
    if (kv === undefined || id === undefined) return false;
    try {
      const stored = await readSteeringKeyBinding(kv, principal, id);
      return stored?.binding.sessionId === sessionId && stored.binding.incarnation === incarnation;
    } catch {
      return false;
    }
  }

  /**
   * COR-301/COR-1569 — the pre-admission verdict (AB-42's order:
   * authorization, then lifecycle) that steering and session input share,
   * decided against the session's live runs in every process sharing this
   * backend. A request without `namedRunId` is authorized against the
   * session's sole live run, wherever it runs, and a session with any live
   * run is not terminal, whichever run's terminal write set `lastRunStatus`.
   * Without a durable steering store, this process's runs are all there are.
   */
  async function resolveLiveSessionPreAdmission(
    sessionId: string,
    session: AgentSession,
    principal: string,
    namedRunId?: string,
    idleAllowed = false,
  ): Promise<{
    verdict: 'not-found' | 'session-terminal' | 'proceed';
    liveRunIds: string[];
  }> {
    const notFound = { verdict: 'not-found' as const, liveRunIds: [] as string[] };
    let liveRunIds: string[] = [];
    try {
      const steeringKv = durableSteeringStore();
      if (steeringKv === undefined) {
        liveRunIds = liveSessionRunIds(sessionId);
      } else {
        // Fold the log first: a run promoted elsewhere whose workflow does
        // not exist yet is known only from its `promoted` entry, and the
        // terminal decision below must count it.
        await enqueueSteering(sessionId, () =>
          catchUpSteering(steeringKv, sessionId, session.incarnation),
        );
        liveRunIds = await liveSessionRunIdsEverywhere(sessionId, session.incarnation, namedRunId);
      }
    } catch (error) {
      // Deleted meanwhile by another process: its log was read mid-deletion.
      const afterFailure = await runtime.sessionStore?.load(sessionId);
      if (afterFailure?.incarnation !== session.incarnation) return notFound;
      // A request naming its run sees the failure if it is still authorized
      // against that run on the session as it stands now.
      if (namedRunId !== undefined) {
        if (!isSessionAuthorityAuthorized(afterFailure.metadata, principal, namedRunId)) {
          return notFound;
        }
        throw error;
      }
      // An unscoped request's authority depends on which run is live, so a
      // failed query is masked until this caller is shown to be authorized
      // against the run this process can see.
      const localTarget = liveSessionRunIdsOfIncarnation(sessionId, session.incarnation);
      if (
        !isSessionAuthorityAuthorized(
          afterFailure.metadata,
          principal,
          localTarget.length === 1 ? localTarget[0] : undefined,
        )
      ) {
        return notFound;
      }
      throw error;
    }
    // The live runs were read across awaits that the session itself may
    // have changed under (a new sole run saved with its own authority), so
    // the caller is checked against the session as it stands after them.
    const afterLiveness =
      durableSteeringStore() === undefined ? session : await runtime.sessionStore?.load(sessionId);
    if (afterLiveness?.incarnation !== session.incarnation) return notFound;
    return {
      verdict: resolveSessionPreAdmission(
        afterLiveness.metadata,
        principal,
        liveRunIds,
        namedRunId,
        idleAllowed,
      ),
      liveRunIds,
    };
  }

  /**
   * This process's running runs of one session incarnation: a run of a
   * deleted incarnation still settling here is not the recreated session's.
   */
  function liveSessionRunIdsOfIncarnation(sessionId: string, incarnation: string): string[] {
    // Only runs steered from this incarnation's log: one started elsewhere
    // (catalog dispatch, a schedule, or recovered without a tag) never reads
    // the gate or logs its end, so a command bound to it could never apply.
    return liveSessionRunIds(sessionId).filter(
      (runId) =>
        !settledLocalRunIds.has(runId) && steeringRunIncarnations.get(runId) === incarnation,
    );
  }

  /** The ids of this process's runs on `sessionId` that are still running. */
  function liveSessionRunIds(sessionId: string): string[] {
    const liveRunIds: string[] = [];
    for (const [runId, runState] of store.getState().runs) {
      if (runState.status === 'running' && getRunSessionIdentifier(runState) === sessionId) {
        liveRunIds.push(runId);
      }
    }
    return liveRunIds;
  }

  /**
   * The session incarnation's live runs, as far as steering and session
   * input admission need to know them, in EVERY process sharing this backend: this process's own
   * running runs, plus non-terminal durable `agentRun` workflows tagged
   * with the session incarnation (`steeringSessionRunTag`), whichever
   * process runs them. A deleted incarnation's still-running workflows carry
   * a different tag and never count.
   *
   * Admission only ever asks three things of this set: is a named run in it,
   * is it empty, and does it hold exactly one run. So it is bounded rather
   * than enumerated: the named run is checked directly, and the tagged query
   * reads at most two other workflows — enough to tell none, one, and
   * ambiguous apart without paging over a result that can change between
   * pages. Without a durable engine, this process's view is all there is.
   */
  /**
   * How long after a run's start is saved it may still lack its workflow.
   * Launch writes the workflow moments later, so this only needs to outlast
   * a slow start, while staying far shorter than any workflow's retention.
   */
  const STEERING_RUN_START_WINDOW_MS = 60_000;

  async function liveSessionRunIdsEverywhere(
    sessionId: string,
    incarnation: string,
    namedRunId?: string,
  ): Promise<string[]> {
    // A run whose `run-ended` this process has folded is over, whatever the
    // engine still reports: its terminal state can lag the event. It is
    // never counted, so it cannot make liveness look conclusive either.
    const endedInLog = (runId: string) => {
      const folded = steeringCursors.get(sessionId);
      return folded?.incarnation === incarnation && folded.history.runs.get(runId) === 'ended';
    };
    const live = new Set<string>();
    const countLive = (runId: string) => {
      if (!endedInLog(runId)) live.add(runId);
    };
    for (const runId of liveSessionRunIdsOfIncarnation(sessionId, incarnation)) countLive(runId);
    const engine = runtime.durable?.engine;
    if (engine === undefined) return [...live].toSorted((left, right) => left.localeCompare(right));
    const tag = steeringSessionRunTag(sessionId, incarnation);
    // The same filter the tag listing applies: a live `agentRun` of this
    // incarnation. Another workflow type carrying the tag is not a run.
    // A saved start counts while its workflow is absent, or present and
    // live: it may have become visible after the listing above.
    const savedWorkflowHasEnded = async (runId: string) => {
      const workflow = await engine.get(runId);
      return workflow !== null && !isLiveSessionWorkflow(workflow);
    };
    const liveAndNotEnded = () => [...live].toSorted((left, right) => left.localeCompare(right));
    const isLiveSessionWorkflow = (workflow: {
      type: string;
      status: string;
      tags?: readonly string[];
    }) =>
      workflow.type === 'agentRun' &&
      ['pending', 'running', 'suspended'].includes(workflow.status) &&
      workflow.tags?.includes(tag) === true;
    if (namedRunId !== undefined && !live.has(namedRunId)) {
      const named = await engine.get(namedRunId);
      if (named !== null && isLiveSessionWorkflow(named)) countLive(namedRunId);
    }
    // Already conclusive without the listing: the named run is live, or
    // unscoped, two runs already make it ambiguous.
    if (namedRunId === undefined ? live.size >= 2 : live.has(namedRunId)) {
      return liveAndNotEnded();
    }
    const others = await engine.list({
      type: 'agentRun',
      status: ['pending', 'running', 'suspended'],
      tags: [tag],
      limit: 2,
    });
    for (const workflow of others.items) countLive(workflow.id);
    // A run is promoted in the log before its tagged workflow exists. Until
    // the engine has any record of it, it counts as starting from its own
    // `promoted` entry, folded into this session's cursor before admission —
    // but only within the launch window its promotion time bounds: a missing
    // workflow long after that is a finished one since purged, not one still
    // starting. Each run has its own marker, so concurrent starts all count.
    //
    // Admission needs only the named run's membership and whether any run is
    // live, or, unscoped, whether zero, one, or several are; the reads stop
    // as soon as that is known. A read either adds a run — a workflow not
    // yet created, or one that became queryable after the list above and is
    // still this incarnation's and live — or drops a marker whose workflow
    // ended, so each marker costs at most one read that adds nothing.
    const cursor = steeringCursors.get(sessionId);
    if (cursor?.incarnation === incarnation) {
      for (const [runId, promotedAt] of cursor.starting) {
        if (runtimeServices.clock.now() - Date.parse(promotedAt) > STEERING_RUN_START_WINDOW_MS) {
          cursor.starting.delete(runId);
        }
      }
      // The session is saved as running a run a moment before that run's
      // `promoted` entry is appended. In that gap the session's latest run
      // is starting too, bounded by its own start time like any marker.
      // Each run is saved as starting, in its own entry, a moment before its
      // `promoted` entry is appended; concurrent starts each keep theirs. In
      // that gap the run is starting too, bounded by its own start time like
      // any marker. The named run, if any, is read first.
      const countSavedStart = async () => {
        const saved = await runtime.sessionStore?.load(sessionId);
        if (saved?.incarnation !== incarnation) return;
        const starting = saved.metadata['steeringStartingRuns'];
        if (typeof starting !== 'object' || starting === null || Array.isArray(starting)) return;
        const entries = Object.entries(starting).toSorted(([left], [right]) =>
          left === namedRunId ? -1 : right === namedRunId ? 1 : 0,
        );
        for (const [savedRunId, savedStartedAt] of entries) {
          if (namedRunId === undefined ? live.size >= 2 : live.has(namedRunId)) return;
          if (
            typeof savedStartedAt === 'string' &&
            !live.has(savedRunId) &&
            !cursor.history.runs.has(savedRunId) &&
            runtimeServices.clock.now() - Date.parse(savedStartedAt) <=
              STEERING_RUN_START_WINDOW_MS &&
            !(await savedWorkflowHasEnded(savedRunId))
          ) {
            countLive(savedRunId);
          }
        }
      };
      // A named run not yet live can still be the saved start or one of
      // the markers; another run being live says nothing about it, so the
      // saved start is read first, then the named run's own marker.
      let namedChecked = namedRunId === undefined || !cursor.starting.has(namedRunId);
      if (namedRunId !== undefined && !live.has(namedRunId)) await countSavedStart();
      const known = () =>
        namedRunId === undefined
          ? live.size >= 2
          : live.has(namedRunId) || (namedChecked && live.size >= 1);
      const markers = [...cursor.starting.keys()];
      if (namedRunId !== undefined && !namedChecked) {
        markers.splice(markers.indexOf(namedRunId), 1);
        markers.unshift(namedRunId);
      }
      for (const runId of markers) {
        if (known()) break;
        if (live.has(runId)) continue;
        const workflow = await engine.get(runId);
        if (workflow === null || isLiveSessionWorkflow(workflow)) countLive(runId);
        else cursor.starting.delete(runId);
        if (runId === namedRunId) namedChecked = true;
      }
      if (namedRunId === undefined && !known()) await countSavedStart();
    }
    return liveAndNotEnded();
  }

  // AB-68: give `steering.accepted` its first production dispatch site.
  // Only the `accepted` transition is dispatched here, and deliberately:
  // `SteeringRejectedEvent`/`SteeringSupersededEvent`/`SteeringFailedEvent`
  // are documented as `accepted → X` transitions, so a PRE-admission
  // rejection (an unknown agent name, an ambiguous run) never reached
  // `accepted` and must not be reported as having left it. Those three
  // belong to the gate's own post-admission transitions.
  function dispatchSteeringAccepted(
    sessionId: string,
    outcome: Extract<SteeringCommandAdmissionOutcome, { outcome: 'accepted' }>,
  ): void {
    emitter.dispatch(
      new SteeringAcceptedEvent(sessionId, outcome.command.id, outcome.command.configVersion),
    );
  }

  /**
   * Durable admission, serialized per session in this process and against
   * other processes by the log head:
   *
   * 1. Catch the session's gate up with the log.
   * 2. Answer a reused `(principal, id)` from what the log already decided:
   *    the gate's ledger for an accepted command, the folded refusals for a
   *    refused one, or — for a key bound in another session — a fold of that
   *    session's log.
   * 3. Otherwise append the `admit` event, binding the key in the same
   *    atomic write, and only then apply it to the local gate. The outcome
   *    is whatever the gate decides from the recorded inputs, which is what
   *    every other process folding the log decides too. Losing the race to
   *    another process's append starts over from step 1.
   */
  async function admitDurableSteeringCommand(
    kv: ConditionalTextValueStore,
    incarnation: string,
    request: ImplementedSteeringCommand,
    liveRunIdsNow: () => Promise<string[]>,
    refusal?: SteeringRefusal['outcome'],
    submittedValueAsSent?: SteeringRequestedValue,
  ): Promise<SteeringCommandAdmissionOutcome> {
    // A private copy: the event appended, the event applied, and what the
    // caller may later mutate must never differ.
    // A revision JSON cannot represent (NaN, an infinity, a fraction, a
    // negative) can never equal a real configVersion, so it is the gate's own
    // `policy-denied` — decided after the usual idempotency lookup, and
    // logged without the unrepresentable field so the id stays decided.
    const revisionIsRepresentable =
      request.expectedRevision === undefined ||
      (Number.isSafeInteger(request.expectedRevision) && request.expectedRevision >= 0);
    const command = structuredClone(request);
    if (!revisionIsRepresentable)
      delete (command as { expectedRevision?: number }).expectedRevision;
    let decidedRefusal: SteeringRefusal['outcome'] | undefined = refusal;
    const submittedValue =
      submittedValueAsSent === undefined ? undefined : structuredClone(submittedValueAsSent);
    const { sessionId, principal, id } = command;
    for (let attempt = 0; attempt < STEERING_APPEND_ATTEMPTS; attempt += 1) {
      // Rechecked here, in the queue: another process may have deleted the
      // session since the caller loaded it.
      const current = await runtime.sessionStore?.load(sessionId);
      if (current?.incarnation !== incarnation) return { outcome: 'not-found' };
      let cursor: SteeringCursor;
      try {
        cursor = await catchUpSteering(kv, sessionId, incarnation);
      } catch (error) {
        // Deleted by another process while its log was being read: a missing
        // entry or a shrunken head is that deletion, not corruption.
        const afterFailure = await runtime.sessionStore?.load(sessionId);
        if (afterFailure?.incarnation !== incarnation) return { outcome: 'not-found' };
        // The failure is the caller's to see only while the caller is still
        // authorized here, on the session as it stands now: the request may
        // have waited in the queue, or skipped the up-front checks entirely
        // as an already-bound key.
        const localTarget = liveSessionRunIdsOfIncarnation(sessionId, incarnation);
        const target = command.runId ?? (localTarget.length === 1 ? localTarget[0] : undefined);
        if (!isSessionAuthorityAuthorized(afterFailure.metadata, principal, target)) {
          return { outcome: 'not-found' };
        }
        throw error;
      }
      const answered = answerSteeringRetry(
        cursor.ledger,
        cursor.refusals,
        asSubmittedRetry(cursor.ledger, cursor.refusals, cursor.submitted, command, submittedValue),
      );
      if (answered !== undefined) {
        // The folded answer stands only if the key's binding names this
        // key's own entry in this log: a binding pointing anywhere else is
        // corrupt, here exactly as for a key answered from another session.
        let bindingHolds: boolean;
        try {
          bindingHolds = await steeringBindingNamesOwnEntry(
            kv,
            sessionId,
            incarnation,
            principal,
            id,
          );
        } catch (error) {
          // A deletion by another process removes the entry mid-read: that
          // is the session going away, not corruption.
          const afterFailure = await runtime.sessionStore?.load(sessionId);
          if (afterFailure?.incarnation !== incarnation) return { outcome: 'not-found' };
          throw error;
        }
        // Authority may have changed while this waited in the queue or
        // folded the log: a replay is answered only to a caller still
        // authorized against the run it was decided for, read just now.
        const afterRead = await runtime.sessionStore?.load(sessionId);
        if (afterRead?.incarnation !== incarnation) return { outcome: 'not-found' };
        if (bindingHolds) {
          return isSessionAuthorityAuthorized(
            afterRead.metadata,
            principal,
            steeringAnswerRunId(answered, command),
          )
            ? answered
            : { outcome: 'not-found' };
        }
        // A mismatched binding is reported only to a caller still authorized
        // here; anyone else learns nothing beyond `not-found`.
        const localTarget = liveSessionRunIdsOfIncarnation(sessionId, incarnation);
        const target = command.runId ?? (localTarget.length === 1 ? localTarget[0] : undefined);
        if (!isSessionAuthorityAuthorized(afterRead.metadata, principal, target)) {
          return { outcome: 'not-found' };
        }
        throw new SteeringLogCorruptError(
          `Steering key "${principal}"/"${id}" was decided in session "${sessionId}", but its binding does not name that decision.`,
        );
      }
      if (!revisionIsRepresentable && decidedRefusal === undefined) {
        decidedRefusal = {
          outcome: 'rejected',
          failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'policy-denied' },
        };
      }
      // Only what the log parser can read back is ever appended: the command,
      // and with it the value the caller submitted, if one is kept.
      const probe: SteeringLogEvent =
        decidedRefusal === undefined
          ? {
              type: 'admit',
              command,
              liveRunIds: [],
              now: runtimeServices.clock.nowISO(),
              ...(submittedValue !== undefined ? { submittedValue } : {}),
            }
          : {
              type: 'refused',
              command,
              outcome: decidedRefusal,
              now: runtimeServices.clock.nowISO(),
              ...(submittedValue !== undefined ? { submittedValue } : {}),
            };
      if (!isReadableSteeringLogEvent(probe, sessionId)) {
        if (decidedRefusal !== undefined) return decidedRefusal;
        throw new BureauError('Malformed steering command.', 'BAD_REQUEST');
      }

      let expectedBinding: string | null = null;
      const stored = await readSteeringKeyBinding(kv, principal, id);
      if (stored !== undefined) {
        const { binding } = stored;
        const bindingSession =
          binding.sessionId === sessionId
            ? undefined
            : await runtime.sessionStore?.load(binding.sessionId);
        const live =
          binding.sessionId === sessionId
            ? binding.incarnation === incarnation
            : bindingSession?.incarnation === binding.incarnation;
        if (live) {
          let elsewhere: SteeringCommandAdmissionOutcome | undefined;
          try {
            elsewhere = await answerFromOtherSteeringLog(kv, binding, command, submittedValue);
          } catch (error) {
            if (!(error instanceof SteeringLogCorruptError)) throw error;
          }
          if (elsewhere !== undefined) {
            // The answer discloses the other session's command, so the caller
            // must still be authorized there, against that command's run, on
            // the session as it stands now.
            const boundNow = await runtime.sessionStore?.load(binding.sessionId);
            if (boundNow?.incarnation !== binding.incarnation) continue;
            if (
              !isSessionAuthorityAuthorized(
                boundNow.metadata,
                principal,
                steeringAnswerRunId(elsewhere, command),
              )
            ) {
              return { outcome: 'not-found' };
            }
            // It also tells the caller this session exists, so this session
            // gets the same checks as any request to it, as it stands now:
            // authority against the run the request targets, then whether
            // the session has ended.
            return answerCrossSessionInTarget(
              elsewhere,
              sessionId,
              incarnation,
              command,
              liveRunIdsNow,
            );
          }
          // The binding names a live session whose log does not account for
          // it — unless that session was deleted mid-fold, which is a race,
          // not corruption: decide again once the deletion is visible.
          const recheck = await runtime.sessionStore?.load(binding.sessionId);
          if (recheck?.incarnation !== binding.incarnation) continue;
          throw new SteeringLogCorruptError(
            `Steering key "${principal}"/"${id}" is bound to sequence ${String(binding.sequence)} of session "${binding.sessionId}", which does not admit it.`,
          );
        }
        // Bound by a session incarnation that no longer exists — a deletion
        // that died before removing it. Replaced atomically below.
        expectedBinding = stored.raw;
      }

      // Live runs and the clock are read now, on this attempt, not when the
      // caller queued: a run that ended (and logged it) while this waited
      // must not be bound, and a deadline is judged at the moment of decision.
      // Checked again as close to the append as possible. The log cannot
      // condition on the session record itself (it changes on every save),
      // so a deletion committing in the instant between this read and the
      // append can still win; the orphan it leaves is removed by the boot
      // sweep, and the admission is equivalent to one that landed just
      // before the deletion.
      // Liveness first, then the session: the backend-wide query is awaited,
      // and the session's terminal state must be read after it, not before.
      const liveRunIds = await liveRunIdsNow();
      const stillLive = await runtime.sessionStore?.load(sessionId);
      if (stillLive?.incarnation !== incarnation) return { outcome: 'not-found' };
      // The session's last run may have finished while this waited: the same
      // terminal check `submitSteeringCommand` made up front, made again.
      // The run this command binds to may have changed while it waited (its
      // run ended, another became the sole live one), so authority is
      // checked again against the run it will actually be decided for.
      const preAdmission = resolveSessionPreAdmission(
        stillLive.metadata,
        principal,
        liveRunIds,
        command.runId,
        steersIdleSession(command.requestedValue),
      );
      if (preAdmission === 'not-found') return { outcome: 'not-found' };
      if (preAdmission === 'session-terminal') return { outcome: 'session-terminal', sessionId };
      const now = runtimeServices.clock.nowISO();
      const event: Extract<SteeringLogEvent, { type: 'admit' | 'refused' }> =
        decidedRefusal === undefined
          ? {
              type: 'admit',
              command,
              liveRunIds,
              now,
              ...(submittedValue !== undefined ? { submittedValue } : {}),
            }
          : {
              type: 'refused',
              command,
              outcome: decidedRefusal,
              now,
              // A selector resolved before this refusal was decided is kept,
              // exactly as for an admission, so its exact retry still matches.
              ...(submittedValue !== undefined ? { submittedValue } : {}),
            };
      const appended = await appendSteeringLogEvent(
        kv,
        sessionId,
        incarnation,
        cursor.head,
        event,
        expectedBinding,
      );
      if (appended.status === 'appended') {
        const outcome = applyToCursor(cursor, event);
        cursor.applied += 1;
        cursor.head = appended.head;
        if (outcome === undefined) throw new Error('an admit event always yields an outcome');
        return outcome;
      }
    }
    throw steeringContention(sessionId);
  }

  /**
   * Answers a reused key bound in ANOTHER session from that session's own
   * log, folded into a throwaway gate: the original is there, in whatever
   * state it reached, so the retry gets the same `conflict` it would have
   * got in-process.
   */
  /**
   * Returns `answer`, decided in another session, only if this target
   * session still admits the caller: its live runs read now (a failed read
   * is masked unless the caller is authorized against the run it would
   * target), the caller authorized against the targeted run, and the
   * session not ended. Otherwise `not-found` or `session-terminal`.
   */
  async function answerCrossSessionInTarget(
    answer: SteeringCommandAdmissionOutcome,
    sessionId: string,
    incarnation: string,
    command: ImplementedSteeringCommand,
    liveRunIdsNow: () => Promise<string[]>,
  ): Promise<SteeringCommandAdmissionOutcome> {
    let liveRunIds: string[];
    try {
      liveRunIds = await liveRunIdsNow();
    } catch (error) {
      const afterFailure = await runtime.sessionStore?.load(sessionId);
      if (afterFailure?.incarnation !== incarnation) return { outcome: 'not-found' };
      const localTarget = liveSessionRunIdsOfIncarnation(sessionId, incarnation);
      const target = command.runId ?? (localTarget.length === 1 ? localTarget[0] : undefined);
      if (!isSessionAuthorityAuthorized(afterFailure.metadata, command.principal, target)) {
        return { outcome: 'not-found' };
      }
      throw error;
    }
    const targetNow = await runtime.sessionStore?.load(sessionId);
    if (targetNow?.incarnation !== incarnation) return { outcome: 'not-found' };
    const preAdmission = resolveSessionPreAdmission(
      targetNow.metadata,
      command.principal,
      liveRunIds,
      command.runId,
      steersIdleSession(command.requestedValue),
    );
    if (preAdmission === 'not-found') return { outcome: 'not-found' };
    if (preAdmission === 'session-terminal') return { outcome: 'session-terminal', sessionId };
    return answer;
  }

  /**
   * The run an idempotency answer was decided for: the original command's
   * bound run for a replay or conflict, else the request's own.
   */
  function steeringAnswerRunId(
    answer: SteeringCommandAdmissionOutcome,
    request: ImplementedSteeringCommand,
  ): string | undefined {
    if (answer.outcome === 'replayed') return answer.command.runId;
    if (answer.outcome === 'conflict') return answer.conflict.original.runId;
    return request.runId;
  }

  /**
   * Whether `(principal, id)`'s stored binding names this session
   * incarnation and, at its sequence, an `admit` or `refused` entry for that
   * same key.
   */
  async function steeringBindingNamesOwnEntry(
    kv: ConditionalTextValueStore,
    sessionId: string,
    incarnation: string,
    principal: string,
    id: string,
  ): Promise<boolean> {
    const stored = await readSteeringKeyBinding(kv, principal, id);
    if (
      stored === undefined ||
      stored.binding.sessionId !== sessionId ||
      stored.binding.incarnation !== incarnation
    ) {
      return false;
    }
    const { sequence } = stored.binding;
    const head = await readSteeringLogHead(kv, sessionId, incarnation);
    if (sequence > head.sequence) return false;
    const [named] = await readSteeringLogEntries(
      kv,
      sessionId,
      incarnation,
      sequence - 1,
      sequence,
    );
    return (
      named !== undefined &&
      (named.type === 'admit' || named.type === 'refused') &&
      named.command.principal === principal &&
      named.command.id === id
    );
  }

  async function answerFromOtherSteeringLog(
    kv: ConditionalTextValueStore,
    binding: SteeringKeyBinding,
    command: ImplementedSteeringCommand,
    submittedValue?: SteeringRequestedValue,
  ): Promise<SteeringCommandAdmissionOutcome | undefined> {
    const ledger = createSteeringCommandLedger();
    const refusals = new Map<string, Map<string, SteeringRefusal>>();
    const submitted = new Map<string, Map<string, SteeringRequestedValue>>();
    const gate = createSteeringGate(binding.sessionId, ledger, runtimeServices.clock);
    const head = await readSteeringLogHead(kv, binding.sessionId, binding.incarnation);
    const events = await readSteeringLogEntries(
      kv,
      binding.sessionId,
      binding.incarnation,
      0,
      head.sequence,
    );
    // The binding must name this key's own admission in that log; anything
    // else is a corrupt binding, never an answer.
    const named = events[binding.sequence - 1];
    if (
      named === undefined ||
      (named.type !== 'admit' && named.type !== 'refused') ||
      named.command.principal !== command.principal ||
      named.command.id !== command.id
    ) {
      throw new SteeringLogCorruptError(
        `Steering key "${command.principal}"/"${command.id}" is bound to sequence ${String(binding.sequence)} of session "${binding.sessionId}", which does not admit it.`,
      );
    }
    const history = createSteeringFoldHistory();
    for (const event of events) applySteeringEvent(gate, refusals, event, submitted, history);
    return answerSteeringRetry(
      ledger,
      refusals,
      asSubmittedRetry(ledger, refusals, submitted, command, submittedValue),
    );
  }

  function listPendingReviews(): SessionPendingReview[] {
    const now = runtimeServices.clock.now();
    const reviews: SessionPendingReview[] = [];
    const { runs } = store.getState();

    for (const [runId, runState] of runs) {
      // COR-1302: reviews stay scoped to `createRun`'s session-owned runs, as
      // they were before `bureau.run()` runs were registered on `store`.
      if (catalogRunIds.has(runId)) continue;
      const sessionId = getRunSessionIdentifier(runState);
      const agentName = findRunAgentName(runState);

      // Tool-approval: any step result still needing approval, across every
      // step (not just the last) — the run may have continued past it.
      const stepCompletedTimestamps = runState.actions
        .filter((action) => action.type === 'step.completed')
        .map((action) => action.timestamp);

      for (const [stepIndex, step] of runState.steps.entries()) {
        for (const result of step.results) {
          if (result.outcome !== 'action_required' || !result.pendingApproval) continue;
          const id = `approval:${runId}:${result.pendingApproval.callId}`;
          if (resolvedReviewIds.has(id) || invalidApprovalReviewIds.has(id)) continue;
          const approval = pendingApprovalOverrides.get(id) ?? result.pendingApproval;
          // AB-46 read-time filter: a tool-approval review past its binding's
          // `expiresAt` is excluded here with no write — `sweepExpiredReviews`
          // performs the write that transitions it to `'expired'`. An
          // unsigned approval (no `approvalBinding`) never expires this way.
          if (approval.approvalBinding !== undefined && approval.approvalBinding.expiresAt <= now) {
            continue;
          }
          const requestedAt = stepCompletedTimestamps[stepIndex] ?? now;
          reviews.push({
            kind: 'tool-approval',
            id,
            runId,
            sessionId,
            agentName,
            approval,
            requestedAt,
            ageMilliseconds: now - requestedAt,
            status: 'pending',
            round: pendingApprovalRounds.get(id) ?? 0,
            ...interruptedFields(id),
          });
        }
      }

      // Human-wait: the run is still parked iff it has a HumanWaitParkedEvent
      // action and its status is still 'running'. The park event fires
      // MID-step (from inside the `requestHumanInput` tool's `execute`,
      // called by `runStep`), so that same step's own trailing events —
      // `tools.executed`, `step.generated`, `step.completed` — are always
      // recorded AFTER it, even though the run is genuinely still parked at
      // that point (`ctx.waitForSignal` only runs once the whole step loop
      // exits). Requiring the park event to be the literal last action
      // therefore misses every real parked run — this instead takes the
      // MOST RECENT park event (a later step's `requestHumanInput` call
      // last-write-wins over an earlier one, mirroring the durable
      // workflow's own accumulation) and relies on `status === 'running'`
      // to exclude a run that has already resumed and finished — resuming
      // via `ctx.waitForSignal` runs the workflow straight through to
      // completion, so `runState.status` leaves `'running'` the moment a
      // parked run is actually resumed.
      let parkedAction: (typeof runState.actions)[number] | undefined;
      for (let index = runState.actions.length - 1; index >= 0; index--) {
        const action = runState.actions[index];
        if (action?.type === HumanWaitParkedEvent.type) {
          parkedAction = action;
          break;
        }
      }

      if (runState.status === 'running' && parkedAction !== undefined) {
        const rawDetail = parkedAction.detail;
        const detail: Record<string, unknown> | undefined =
          rawDetail !== null && typeof rawDetail === 'object'
            ? (rawDetail as Record<string, unknown>)
            : undefined;
        const signalName = detail?.['signalName'];
        if (typeof signalName === 'string' && signalName.length > 0) {
          // The park ordinal (the nth park of this run, 0-based) differentiates
          // repeated parks on the same signal, so a re-park after an earlier
          // park resolved is not suppressed by the earlier park's
          // `resolvedReviewIds` entry. Unlike a timestamp it is unique under a
          // frozen clock, and it survives recovery:
          // `reconstructHumanWaitReviewIfParked` seeds it from the durable
          // checkpoint's count of prior parks.
          const id = `human-wait:${runId}:${signalName}:${humanWaitParkOrdinal(runId, runState.actions)}`;
          if (!resolvedReviewIds.has(id)) {
            const promptValue = detail?.['prompt'];
            const prompt = typeof promptValue === 'string' ? promptValue : undefined;
            const inputSchema = humanInputSchemaOf(detail?.['inputSchema']);
            reviews.push({
              kind: 'human-wait',
              id,
              runId,
              sessionId,
              agentName,
              signalName,
              prompt,
              ...(inputSchema === undefined ? {} : { inputSchema }),
              requestedAt: parkedAction.timestamp,
              ageMilliseconds: now - parkedAction.timestamp,
              status: 'pending',
            });
          }
        }
      }
    }

    for (const [runId, terminalReview] of terminalReviewSessions) {
      for (const [reviewId, approval] of pendingApprovalOverrides) {
        if (!reviewId.startsWith(`approval:${runId}:`)) continue;
        if (resolvedReviewIds.has(reviewId) || invalidApprovalReviewIds.has(reviewId)) continue;
        if (reviews.some((review) => review.id === reviewId)) continue;
        if (approval.approvalBinding !== undefined && approval.approvalBinding.expiresAt <= now) {
          continue;
        }
        // COR-1596: each approval of a fire that continues is listed at its own time.
        const requestedAt = approvalRequestedAt.get(reviewId) ?? terminalReview.requestedAt;
        reviews.push({
          kind: 'tool-approval',
          id: reviewId,
          runId,
          sessionId: terminalReview.sessionId,
          agentName: terminalReview.agentName,
          approval,
          requestedAt,
          ageMilliseconds: now - requestedAt,
          status: 'pending',
          round: pendingApprovalRounds.get(reviewId) ?? 0,
          ...interruptedFields(reviewId),
        });
      }
    }

    return reviews;
  }

  /**
   * A review that was decided, whose session write has landed. A fire's approval ends through
   * {@link releaseScheduledFireApproval}, its decision's own commit having pruned the session
   * (`durablyPruned`), so a decision is one more ending through the one release; any other run's
   * review ends the way it always did.
   */
  async function releaseDecidedReview(runId: string, reviewId: string): Promise<void> {
    if (scheduledFireApprovalRuns.has(runId)) {
      await releaseScheduledFireApproval(runId, reviewId, 'resolved', { durablyPruned: true });
      return;
    }
    releaseTerminalRunReviewState(runId);
  }

  function releaseTerminalRunReviewState(runId: string): void {
    const runState = store.getRun(runId);
    // COR-1596: a fire's approvals outlive a run that was never on the store, and end only when
    // it holds none, an expired one not yet swept included.
    if (runState === undefined) {
      endScheduledFireWhenNoApprovalRemains(runId);
      return;
    }
    if (runState.status === 'running') return;
    for (const review of listPendingReviews()) {
      if (review.runId === runId) return;
    }
    runRequestContexts.delete(runId);
    runToolboxesByRunId.delete(runId);
    releaseRunScope(runId);
    recoveredRunIds.delete(runId);
  }

  /** Whether this process holds the run and it has not recorded its end. */
  function isRunStillGoing(runId: string): boolean {
    const runState = store.getRun(runId);
    if (runState === undefined) return false;
    return (
      (runState.status === 'running' || runState.status === 'aborting') &&
      terminalActionTimestamp(runState.actions) === undefined
    );
  }

  /**
   * COR-855 — writes the outcome of a resolved tool approval into the session's
   * conversation, replacing the pending `action_required` tool-result row in
   * place (its id and position stay). Bureau settles a run whose tool call needs
   * approval and runs the approved tool out of band, so nothing else ever
   * replaces that row, and the next run started on the session would be shown
   * the approval as still pending.
   *
   * The tool has already run (or been refused) by now, so a failure here cannot
   * undo the resolution: it is retried like every other post-resolution write,
   * then returned for `resolveReview` to throw once the decision is recorded.
   * Reporting success would let the next run start from the stale
   * `action_required` row and ask for the approval again. A Bureau with no
   * session store has no conversation to write.
   *
   * A run that is still going when its approval is resolved (one without
   * `stopWhen: pendingApproval()`) can write its own copy of the conversation
   * over this one at its terminal save, so a host serving approvals configures it.
   */
  /**
   * When each approved call ran, by review id (COR-2014): the Bureau runs an approved call itself
   * (`resumeApproval`), so it times the run, and the outcome it writes over the call's waiting row
   * says when the call ran rather than when it was asked for.
   */
  const approvalRunTimes = new Map<string, ToolTiming>();

  /**
   * The metadata the outcome's row is written with: the waiting row's own, with no time the asking
   * left on it, and the time the approved call ran when it ran.
   */
  function approvalOutcomeMetadata(
    waiting: Readonly<Record<string, JSONValue>> | undefined,
    ran: ToolTiming | undefined,
    decided: ApprovalDecisionRecord,
  ): Record<string, JSONValue> {
    const { [TOOL_TIMING_METADATA_KEY]: _asked, ...kept } = waiting ?? {};
    return {
      ...(ran === undefined ? kept : { ...kept, [TOOL_TIMING_METADATA_KEY]: { ...ran } }),
      // COR-2016: who decided and when, so a page that was not there can say so.
      ...approvalDecisionMetadata(decided),
    };
  }

  /**
   * The sentence the tool asked with, when it wrote one of its own: a message equal to the policy's
   * reason is the reason again, not a sentence the tool chose.
   */
  function askedOf(review: Extract<PendingReview, { kind: 'tool-approval' }>): string | undefined {
    const action = review.approval.action;
    const message = action?.type === 'approval' ? action.message : undefined;
    return message === undefined || message.trim() === '' || message === review.approval.reason
      ? undefined
      : message.trim();
  }

  /**
   * COR-2299 — the hook plan a catalog agent's run this process does not hold would run with:
   * Bureau's tier for the agent, the plugin tier, and the agent's own hooks, as a dispatch composes
   * them, each tracker seeded from the session's taint (`sessionTaint`) and writing a new one back.
   * An agent that cannot be resolved falls back to Bureau's own guardrails alone, so the result is
   * still scanned.
   */
  async function catalogRunHookPlan(
    runId: string,
    sessionTaint: SessionTaintSeam,
    reviewedAgentName: string | undefined,
  ): Promise<HookRegistry<OperativeHookMap>> {
    // A run this process restarted into has no attribution; its review still names the agent.
    const agentName = runAttribution.get(runId)?.agentName ?? reviewedAgentName;
    const agent = agentName === undefined ? undefined : agentCatalog.find(agentName);
    if (agent !== undefined && hasDefinitionResolver(agent)) {
      try {
        const resolved = await agent[OPERATIVE_RESOLVE_RUN_OPTIONS]('', {
          runId,
          sessionTaint,
          ...(agentName === undefined ? {} : { agentName }),
          ...catalogRunGuardrailsContext(agent),
        });
        return runtime.composeRunHooks({
          bureau: runtime.createBureauInvariantHooks(undefined, {
            agentResolvesGuardrails: resolvesOwnGuardrails(agent),
            sessionTaint,
          }),
          agent: resolved.hooks,
        });
      } catch {
        // Falls through to Bureau's own guardrails, which still scan the result.
      }
    }
    return runtime.composeRunHooks({
      bureau: runtime.createBureauInvariantHooks(undefined, { sessionTaint }),
      agent: undefined,
    });
  }

  /**
   * COR-2299 — an approved call runs outside the run's step, so its result reaches the session
   * without the run loop's `validateToolResult` scan. Scanned here with the run's own hook plan (a
   * run this process does not hold has one built from its agent, seeded from the session's
   * persisted taint), a hit writes the blocked result in its place, as the loop does, and taints
   * the session; the taint is stored before this returns. A scan that fails does the same
   * (COR-2300).
   */
  async function scanApprovedToolResult(
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    executed: ToolExecutionResult,
  ): Promise<ToolExecutionResult> {
    let conversation = new Conversation(undefined, { runtime: runtimeServices });
    let metadata: Record<string, JSONValue> | undefined;
    try {
      const stored = await runtime.sessionStore?.load(review.sessionId);
      if (stored !== undefined) {
        conversation = new Conversation(stored.conversationHistory, { runtime: runtimeServices });
        metadata = stored.metadata;
      }
    } catch {
      // The conversation only gives a detector its length; an unreadable session is scanned empty,
      // and starts untainted in memory (a taint it raises is still stored).
    }
    const seam = runtime.sessionTaintSeam(review.sessionId, review.runId, metadata);
    const hooks =
      runHookPlans.get(review.runId) ??
      (await catalogRunHookPlan(review.runId, seam, review.agentName));
    const firings: GuardrailFiring[] = [];
    const scanned = await scanToolResult(executed, {
      hooks,
      conversation,
      step: 0,
      reportGuardrail: (firing) => firings.push(firing),
    });
    if (scanned.blocked) {
      // A result a guardrail refused taints the session. The tracker that refused it stores the
      // taint when it holds the seam, which every agent tier does; a tier built without one (a
      // hand-written agent under Bureau's guardrails), a tripwire below the taint threshold, and a
      // scan that failed before a tracker could are stored here. A session that already holds a
      // taint keeps it (the write is compare-and-set), so this never publishes twice.
      const firing = firings[0];
      await seam.onTainted({
        reason: 'A guardrail refused the result of an approved call',
        detector: scanned.tripwire?.guardrailName ?? firing?.guardrailName ?? 'tool-result-scan',
        category:
          scanned.tripwire?.category ??
          firing?.category ??
          (scanned.failed === true ? 'detector-failure' : 'blocked-tool-result'),
        confidence: scanned.tripwire?.confidence ?? firing?.confidence ?? 1,
        step: 0,
        provenance: 'tool-result',
      });
      diagnose({
        level: 'warn',
        scope: 'guardrails',
        message: `[bureau] A guardrail blocked the result of the approved call "${review.approval.callId}" of run "${review.runId}"${scanned.tripwire === undefined ? '' : ' (tripwire)'}; the session holds the blocked result.`,
      });
    }
    return scanned.result;
  }

  /** {@link scanApprovedToolResult} for a result of unknown shape: only a tool's own is scanned. */
  async function scannedApprovedOutcome(
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    result: unknown,
  ): Promise<ToolExecutionResult> {
    return await scanApprovedToolResult(review, result as ToolExecutionResult);
  }

  async function writeApprovalOutcomeToSession(
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    input: ResolveReviewInput,
    result: unknown,
  ): Promise<ApprovalOutcomeNotWrittenError | undefined> {
    const sessionStore = runtime.sessionStore;
    if (!sessionStore) return undefined;
    const callId = review.approval.callId;
    const refusal = input.decision === 'reject' ? 'Tool call rejected' : 'Tool call denied';
    const message = input.reason === undefined ? refusal : `${refusal}: ${input.reason}`;
    const decidedAtISO = runtimeServices.clock.nowISO();
    const asked = askedOf(review);
    const outcome =
      input.decision === 'approve'
        ? await scannedApprovedOutcome(review, result)
        : {
            callId,
            toolCallId: callId,
            toolName: review.approval.toolName,
            outcome: 'error' as const,
            content: message,
            result: message,
          };
    let lastError: unknown;
    try {
      // Collected before the write: a resumed tool may stream its output.
      const materialized = await materializeToolResultAsync(outcome);
      const toolResult =
        input.decision === 'approve'
          ? await admitApprovedToolResultMedia(review, outcome, materialized)
          : materialized;
      // The run's own terminal save is in flight when its approval is resolved
      // at once; the row to replace is not stored until it lands.
      await sessionPersistence.drain();
      // Read after the drain: a run that has not settled has not stored its
      // conversation, so a missing row says nothing about whether the row exists.
      const stillGoing = isRunStillGoing(review.runId);
      // COR-1596: a fire that is to take another step writes its whole conversation back then,
      // from a copy that holds the approval's row as it was, so the outcome is lost as it is
      // for a session run that is still going, and the resolver is told the same way.
      const continuingFire = continuingScheduledFires.has(review.runId);
      for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
        try {
          let missing = false;
          await sessionStore.update(review.sessionId, (session) => {
            if (session === undefined) return undefined;
            const history = session.conversationHistory;
            const holdsRow = history.ids.some(
              (id) => getOwn(history.messages, id)?.toolResult?.callId === callId,
            );
            if (!holdsRow) {
              missing = true;
              return undefined;
            }
            const waiting = history.ids
              .map((id) => getOwn(history.messages, id))
              .find((row) => row?.toolResult?.callId === callId);
            const ran = input.decision === 'approve' ? approvalRunTimes.get(review.id) : undefined;
            return {
              ...session,
              conversationHistory: resolveToolResult(history, callId, toolResult, {
                metadata: approvalOutcomeMetadata(waiting?.metadata, ran, {
                  decision: input.decision,
                  decidedBy: input.principal,
                  decidedAt: decidedAtISO,
                  ...(input.reason === undefined ? {} : { reason: input.reason }),
                  ...(asked === undefined ? {} : { asked }),
                }),
              }),
            };
          });
          if (continuingFire) {
            lastError = new Error(
              'the fire has another step to take, and its write-back would put the pending row over this outcome',
            );
            break;
          }
          if (!missing) {
            approvalRunTimes.delete(review.id);
            return undefined;
          }
          // A conversation that never held a row for the call (a review restored
          // from persisted metadata alone) shows no approval as pending, so there is
          // nothing stale to replace. A run that is still going is different: its
          // row is not stored yet, and the terminal save would put the stale one
          // there, so the outcome is lost unless the caller is told.
          if (!stillGoing) {
            approvalRunTimes.delete(review.id);
            return undefined;
          }
          lastError = new Error(
            'the run is still going and has not stored the conversation the row is in',
          );
          break;
        } catch (error) {
          lastError = error;
          if (attempt < SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS) {
            await sessionPersistenceSleep(sessionPersistenceRetryDelayMilliseconds);
          }
        }
      }
    } catch (error) {
      lastError = error;
    }
    diagnose({
      level: 'error',
      scope: 'session-persistence',
      message: `[bureau] Could not write the outcome of review "${review.id}" into session "${review.sessionId}": ${serializeUnknownError(lastError)}. The conversation still shows the approval as pending.`,
    });
    // A fixed sentence: it reaches a client's screen, and the storage error's text
    // (which can name keys and paths) stays in the diagnostic above.
    return new ApprovalOutcomeNotWrittenError(APPROVAL_OUTCOME_NOT_WRITTEN_MESSAGE);
  }

  /**
   * COR-792 — an approved tool's media reaches the session as a run's does: admitted as the run
   * owner's managed assets, or the result becomes the error that names the refused part. The
   * session's own commit then claims the row's assets.
   */
  async function admitApprovedToolResultMedia(
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    executed: ToolExecutionResult,
    materialized: Awaited<ReturnType<typeof materializeToolResultAsync>>,
  ): Promise<Awaited<ReturnType<typeof materializeToolResultAsync>>> {
    if (materialized.parts === undefined) return materialized;
    const service = assetServiceHolder.current;
    const port =
      service === undefined
        ? undefined
        : createAssetGeneratedMediaAdmitter(
            service,
            ownerOrLocal(runAttribution.get(review.runId)?.principal),
          );
    const step = { step: 0, runId: review.runId };
    const [admitted] = await admitToolResultMedia(
      createStepGeneratedMediaAdmitter({ port, ...step, signal: new AbortController().signal }),
      [{ ...executed, content: materialized.content, parts: materialized.parts }],
      step,
    );
    return materializeToolResultAsync(admitted!);
  }

  /** What a session-path resolution claims in the durable decision record (COR-1579). */
  function sessionDecisionRequest(
    review: SessionPendingReview,
    input: ResolveReviewInput,
  ): ReviewDecisionRequest {
    if (review.kind === 'human-wait') {
      return humanWaitDecisionRequest(review.id, input, humanWaitDecisionPayload(input));
    }
    return {
      reviewId: review.id,
      round: review.round,
      decision: input.decision,
      principal: input.principal,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      digest: digestReviewDelivery(
        Object.prototype.hasOwnProperty.call(input, 'arguments') ? input.arguments : null,
      ),
    };
  }

  /**
   * Refuses to approve a session human wait whose run's authority is not current, before the
   * decision is claimed: a human wait's claim is never released, so a refusal must come first.
   * A process that holds the run checks the request context it recorded. A peer (COR-1579) has
   * none, so it rebuilds the context from the session's persisted authority, as recovery does,
   * and refuses when it cannot.
   */
  /**
   * Refuses a human-wait decision with `CONFLICT`, before anything is delivered, once the engine
   * reports the run settled: canceled by the engine, say, before this process's review list heard.
   * A signal to a settled workflow would be accepted and answered as success while deciding
   * nothing. The engine, not the review list, is the source of truth here, as for a catalog park
   * (`run-human-waits.ts`). A run the engine still holds is delivered to even when it is not yet
   * waiting on the signal: the review is listed when the run parks, before the engine records
   * the wait, and a signal sent in between is buffered for it. A run the engine has no workflow
   * for (one registered on the store by hand) is left to the delivery, as before.
   */
  async function assertHumanWaitRunUnsettled(
    review: Extract<SessionPendingReview, { kind: 'human-wait' }>,
  ): Promise<void> {
    const state = await runtime.durable?.engine.get(review.runId);
    if (state === undefined || state === null) return;
    if (!DURABLE_FORCIBLY_TERMINABLE_STATUSES.has(state.status)) {
      throw new BureauError(
        `Run "${review.runId}" has settled, so review "${review.id}" is closed`,
        'CONFLICT',
      );
    }
  }

  /**
   * The check `resolveReview` makes on a human wait this call is the first to decide: it is
   * delivered only to a run the engine has not settled ({@link assertHumanWaitRunUnsettled}). A
   * same-decision re-drive skips it, because its claimant may have delivered already and the keyed
   * signal lands at most once. A refusal gives up the claim this call wrote (nothing was
   * delivered) and the in-process resolving mark, then throws.
   */
  async function refuseSettledHumanWait(
    review: SessionPendingReview,
    claim: Awaited<ReturnType<typeof reviewDecisions.claim>>,
    claimRequest: ReviewDecisionRequest,
  ): Promise<void> {
    if (review.kind !== 'human-wait' || claim.outcome === 'same') return;
    try {
      await assertHumanWaitRunUnsettled(review);
    } catch (error) {
      if (claim.outcome === 'claimed') await releaseApprovalClaim(claimRequest, claim.value);
      resolvingReviewIds.delete(review.id);
      throw error;
    }
  }

  async function assertHumanWaitApprovalAuthority(
    review: Extract<SessionPendingReview, { kind: 'human-wait' }>,
    peer: boolean,
  ): Promise<void> {
    let requestContext = runRequestContexts.get(review.runId);
    if (peer) {
      const session = await runtime.sessionStore?.load(review.sessionId);
      requestContext =
        session === undefined
          ? undefined
          : recoveredRequestContextFromMetadata(
              session.metadata,
              review.runId,
              review.sessionId,
              session.agentName,
              runtimeServices.clock.now,
            );
      if (requestContext === undefined) {
        throw new BureauError(
          'Cannot approve: the request authority of a run another process holds cannot be rebuilt.',
          'CONFLICT',
        );
      }
    }
    if (
      requestContext &&
      isTransportIssuedAuthority(requestContext) &&
      (!requestAuthorityValidator || !(await requestAuthorityValidator(requestContext)))
    ) {
      throw new BureauError(
        'Cannot approve: the request authority is no longer current.',
        'CONFLICT',
      );
    }
  }

  /** Gives up an approval's claim, when this call holds one, without masking the call's outcome. */
  async function releaseApprovalClaim(
    request: ReviewDecisionRequest,
    value: string | undefined,
  ): Promise<void> {
    if (value === undefined) return;
    try {
      await reviewDecisions.release(request, value);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'approval',
        message: `[bureau] Could not release the decision record of review "${request.reviewId}"; a different decision stays refused until it is cleared: ${serializeUnknownError(error)}`,
      });
    }
  }

  /** Marks a decided review resolved in this process's own lists. */
  function markReviewResolvedLocally(review: SessionPendingReview): void {
    resolvedReviewIds.add(review.id);
    if (review.kind !== 'tool-approval') return;
    dropPendingApprovalOverride(review.id);
    if (
      !Array.from(pendingApprovalOverrides.keys()).some((reviewId) =>
        reviewId.startsWith(`approval:${review.runId}:`),
      )
    ) {
      terminalReviewSessions.delete(review.runId);
    }
  }

  /**
   * COR-1579 — a tool approval whose decision record another resolver already claimed with this
   * same decision. Armorer's single-use binding is single-use only inside one process, so this
   * caller never resumes the approval itself: until the claimant has persisted its resolution it
   * is still being resolved, and once it has, this caller answers as the claimant did, through the
   * persisted resolution (whose `alreadyLanded` handling appends no second audit entry).
   */
  async function answerSameApprovalDecision(
    review: Extract<SessionPendingReview, { kind: 'tool-approval' }>,
    input: ResolveReviewInput,
  ): Promise<ResolveReviewResult> {
    const session = await runtime.sessionStore?.load(review.sessionId);
    const decisions = session?.metadata['resolvedReviewDecisions'];
    if (!isJsonObject(decisions) || ownEntry(decisions, review.id) === undefined) {
      throw new BureauError(`Review with id "${review.id}" is already being resolved`, 'CONFLICT');
    }
    await persistReviewResolutionWithRetry(
      review.sessionId,
      review.id,
      true,
      review.runId,
      input.decision,
      input.principal,
      input.reason,
    );
    markReviewResolvedLocally(review);
    await releaseDecidedReview(review.runId, review.id);
    await recordReviewDecision(review, input.decision, input.principal, input.reason, {
      auditAlreadyAppended: true,
    });
    return {
      id: review.id,
      kind: review.kind,
      decision: input.decision,
      ...(input.decision === 'reject' ? { feedback: input.reason } : {}),
    };
  }

  /**
   * COR-1621: the check {@link refuseStaleApprovalRound} makes before a decision is claimed, made
   * again once it is held. A peer re-gates by writing the next round to the session and only then
   * releasing its claim of the round it left, so a claim of that round can land after this
   * process read the session and before the peer's release, or just after it. Once this process
   * holds the claim no one can re-gate the round, so the session read now is final. A refusal
   * here releases the claim through the failure path of the caller.
   */
  async function refuseStaleRoundOfHeldClaim(
    review: PendingReview,
    claimHeld: boolean,
    expectedRound: number | undefined,
  ): Promise<void> {
    if (!claimHeld || review.kind !== 'tool-approval') return;
    const session = await runtime.sessionStore?.load(review.sessionId);
    await refuseStaleApprovalRound(review, session?.metadata, { expectedRound, mayRetry: false });
  }

  /**
   * COR-1621: refuses a decision on a round of an approval that is behind the session's. The round
   * this process lists can be behind: a peer that re-gated the approval put the next round in the
   * session, and a decision claim is keyed by review id and round, so a decision on the stale round
   * would join the peer's claim of the round it left, or claim it afresh, and decide an approval
   * that is no longer the pending one. The round is read from the session by the caller, not
   * trusted from memory or from a subscription that may not have delivered the re-gate yet; a
   * stale round is refused with `CONFLICT` and this process's copy is refreshed.
   */
  async function refuseStaleApprovalRound(
    review: PendingReview,
    sessionMetadata: Record<string, JSONValue> | undefined,
    fence?: { readonly expectedRound: number | undefined; readonly mayRetry: boolean },
  ): Promise<'adopted' | undefined> {
    if (review.kind !== 'tool-approval') return undefined;
    const persisted = persistedApprovalOf(sessionMetadata, review.id);
    if (persisted === undefined || persisted.round <= review.round) return undefined;
    await adoptPersistedApprovalRound(review.runId, review.id, persisted);
    // COR-1659: a caller that names the round the session is at read the current one: this process
    // only lagged, and it has caught up, so the decision can be made afresh on the refreshed review.
    if (fence?.mayRetry === true && fence.expectedRound === persisted.round) return 'adopted';
    const message = `Review "${review.id}" was re-gated since it was listed (round ${review.round}, now ${persisted.round}); read it again before deciding it`;
    // A caller that named a round is told so by the typed refusal, not by a plain conflict.
    if (fence?.expectedRound !== undefined) throw new ReviewRoundChangedError(message);
    throw new BureauError(message, 'CONFLICT');
  }

  /**
   * COR-1659 — refuse a resolution whose `round` names a round the review is no longer at. A call
   * naming none is unfenced. A human wait has no rounds, so it is always at round 0.
   */
  function assertExpectedReviewRound(
    input: ResolveReviewInput,
    review: Pick<PendingReview, 'id' | 'kind'> & { readonly round?: number },
  ): void {
    if (input.round === undefined) return;
    const current = review.kind === 'tool-approval' ? (review.round ?? 0) : 0;
    if (input.round !== current) {
      throw new ReviewRoundChangedError(
        `Review "${review.id}" is at round ${current}, not the round ${input.round} you read; read it again before deciding`,
      );
    }
  }

  /**
   * COR-1659 — fence a decision on the round the caller read, once the session has been read and
   * `resolvingReviewIds` is held (so no other resolver here can supersede before the claim). The
   * round compared is the higher of this process's and the session's: this process can lag a peer
   * that re-gated. A caller that names the session's round is let through after this process
   * catches up (`'retry'`); any other round is refused with {@link ReviewRoundChangedError}.
   */
  async function fenceReviewRound(
    review: PendingReview,
    input: ResolveReviewInput,
    sessionMetadata: Record<string, JSONValue> | undefined,
    mayRetry: boolean,
  ): Promise<'retry' | undefined> {
    const caughtUp = await refuseStaleApprovalRound(review, sessionMetadata, {
      expectedRound: input.round,
      mayRetry,
    });
    if (caughtUp === 'adopted') return 'retry';
    assertExpectedReviewRound(input, review);
    return undefined;
  }

  /**
   * Refuses, before anything is decided or found, a `reject` without a reason (AB-46: for both review
   * kinds), and (COR-1828) a `remember` that is not the approval of a tool approval: a grant is the
   * consequence of approving, and only a tool has one to give.
   */
  function assertDecisionFitsInput(input: ResolveReviewInput): void {
    if (input.decision === 'reject' && (input.reason === undefined || input.reason.trim() === '')) {
      throw new BureauError('reject requires a reason', 'BAD_REQUEST');
    }
    if (
      input.remember === true &&
      (input.decision !== 'approve' || input.id.startsWith('human-wait:'))
    ) {
      throw new BureauError(
        'remember applies to approving a tool approval, and to nothing else',
        'BAD_REQUEST',
      );
    }
  }

  /**
   * COR-1942: a review this process no longer lists may be one someone decided. The peer's
   * follower drops its copy once it reads the decision from the shared history, so whether a late,
   * different decision answers `CONFLICT` (the decision record's answer while the peer still lists
   * the review) or `NOT_FOUND` must not depend on when that read lands. The resolved-review record
   * is keyed by the review id alone and outlives the task and the session's own fence, so it names
   * the decision. Only a decision that differs is refused as lost; repeating the decision made is
   * the documented `NOT_FOUND` of a resolved review. A review nothing recorded (expired, never
   * asked, or swept by `retention.audit`) has no decision to conflict with.
   */
  async function refuseLostDecisionOfGoneReview(input: ResolveReviewInput): Promise<void> {
    const decided = await resolvedReviewStore.get(input.id);
    if (
      decided !== undefined &&
      (decided.decision !== input.decision ||
        decided.decidedBy !== input.principal ||
        decided.reason !== input.reason)
    ) {
      throw new BureauError(`Review with id "${input.id}" is already resolved`, 'CONFLICT');
    }
  }

  /**
   * COR-2106 — the `executionContext` an approved call resumes with: what the run gives a call it
   * does not park (its child registry, delegated grant, parent signals, Bureau's invariants), from
   * the one function the step builds it with, and the run's id as the call's `parentRunId`. A run
   * this process does not hold has no options to build it from, but it is still Bureau's, so its
   * children still get Bureau's tier.
   */
  function approvedCallExecutionContext(runId: string): Record<string, unknown> {
    return {
      ...(runScopedContexts.get(runId) ?? bureauInvariantsField(runtime.bureauChildInvariants)),
      parentRunId: runId,
    };
  }

  /**
   * COR-1828 — what a decision's records keep beyond the decision itself. A human wait's approved
   * answer is kept as the digest the decision fence already took over its reference form
   * (`answerDigest`); a tool approval approved with `remember` names the tool its grant allows
   * (`rememberTool`).
   */
  function recordedByDecision(
    review: SessionPendingReview,
    input: ResolveReviewInput,
    digest: string,
  ): { answerDigest: string | undefined; rememberTool: string | undefined } {
    const approving = input.decision === 'approve';
    return {
      answerDigest: review.kind === 'human-wait' && approving ? digest : undefined,
      rememberTool:
        review.kind === 'tool-approval' && approving && input.remember === true
          ? // COR-1950: the id the approval is bound to, which carries the tool's version, so a
            // tool whose definition changed is not covered. An unsigned approval has none.
            (review.approval.approvalBinding?.toolDefinitionRevision ?? review.approval.toolName)
          : undefined,
    };
  }

  async function resolveReview(
    input: ResolveReviewInput,
    // COR-1579: the human wait of a session run another process holds, derived from durable
    // state by `resolveAnyReview` when this process lists no review under the id.
    derived?: Extract<SessionPendingReview, { kind: 'human-wait' }>,
    // COR-1659: set on the one re-entry after this process caught up with a peer's re-gate.
    afterCatchUp = false,
  ): Promise<ResolveReviewResult> {
    // AB-46: `reject` requires a non-empty `reason` for BOTH review kinds —
    // `resolveReview` is the validation boundary, so this throws before any
    // state change (before even finding the review), matching the gateway's
    // `POST /:id/reject` 400-on-missing-reason contract.
    assertDecisionFitsInput(input);
    const listed = listPendingReviews().find((candidate) => candidate.id === input.id);
    const review = listed ?? (derived?.id === input.id ? derived : undefined);
    if (!review) {
      const cleanup = reviewResolutionCleanupPending.get(input.id);
      if (cleanup) {
        assertExpectedReviewRound(input, cleanup.review);
        if (cleanup.decision !== input.decision) {
          throw new BureauError(`Review with id "${input.id}" is already resolved`, 'CONFLICT');
        }
        if (resolvingReviewIds.has(input.id)) {
          throw new BureauError(
            `Review with id "${input.id}" is already being resolved`,
            'CONFLICT',
          );
        }
        resolvingReviewIds.add(input.id);
        try {
          const cleanupAuditAttachment = buildReviewDecisionAuditRecord(
            cleanup.review,
            cleanup.decision,
            cleanup.principal,
            cleanup.reason,
            cleanup.secretAnswers,
            cleanup.answerDigest,
            cleanup.owner,
          );
          const cleanupAuditAppended = await persistReviewResolutionWithRetry(
            cleanup.sessionId,
            input.id,
            cleanup.kind === 'tool-approval',
            cleanup.runId,
            cleanup.decision,
            cleanup.principal,
            cleanup.reason,
            cleanupAuditAttachment,
            cleanup.rememberTool,
          );
          reviewResolutionCleanupPending.delete(input.id);
          await releaseDecidedReview(cleanup.runId, cleanup.review.id);
          if (cleanupAuditAppended) {
            // AB-391: the audit record above was appended in the SAME
            // commit as the resolution just persisted — replay it into the
            // real audit trail now, while this bureau is alive, rather
            // than leaving it for a later maintenance tick.
            //
            // Codex review finding, PR #601, "Isolate post-commit drain
            // failures from review resolution": the resolution commit
            // above has ALREADY succeeded — a transient failure in this
            // best-effort drain (a claim contention, a query error) must
            // never abort this call before it dispatches the live
            // ReviewApprovedEvent/ReviewDeniedEvent/ReviewRejectedEvent
            // below or returns its result. A failed drain here leaves the
            // attachment claimed-but-unacknowledged for a LATER drain
            // (this bureau's own next maintenance tick, or boot recovery
            // after a restart) to replay — it is never lost, only delayed.
            try {
              await drainOutbox();
            } catch (error) {
              diagnose({
                level: 'error',
                scope: 'durable-maintenance',
                message: `[bureau] Post-commit outbox drain failed after resolving review "${input.id}" from the cleanup-retry path; the audit record remains pending for a later drain: ${serializeUnknownError(error)}`,
              });
            }
          }
          // The first attempt ran the tool but could not persist the decision, so it
          // never wrote the outcome either: write it now, as that attempt would have.
          const cleanupOutcomeNotWritten =
            cleanup.review.kind === 'tool-approval'
              ? await writeApprovalOutcomeToSession(
                  cleanup.review,
                  {
                    id: input.id,
                    decision: cleanup.decision,
                    principal: cleanup.principal,
                    ...(cleanup.reason !== undefined ? { reason: cleanup.reason } : {}),
                  },
                  cleanup.result,
                )
              : undefined;
          await recordReviewDecision(
            cleanup.review,
            cleanup.decision,
            cleanup.principal,
            cleanup.reason,
            {
              auditAlreadyAppended: cleanupAuditAppended,
              secretAnswers: cleanup.secretAnswers,
              answerDigest: cleanup.answerDigest,
              owner: cleanup.owner,
            },
          );
          if (cleanupOutcomeNotWritten !== undefined) throw cleanupOutcomeNotWritten;
          return {
            id: input.id,
            kind: cleanup.kind,
            decision: cleanup.decision,
            ...(cleanup.kind === 'tool-approval' && cleanup.decision === 'reject'
              ? { feedback: cleanup.reason }
              : {}),
            ...(await grantFieldsOf(cleanup.rememberTool, cleanupAuditAppended, cleanup.review)),
          };
        } finally {
          resolvingReviewIds.delete(input.id);
        }
      }
      await refuseLostDecisionOfGoneReview(input);
      throw new BureauError(`No pending review with id "${input.id}"`, 'NOT_FOUND');
    }

    // COR-1920: nothing unsealed is digested or claimed.
    refuseUnsealedSecrets(review, humanWaitDecisionPayload(input), input.decision);
    if (resolvingReviewIds.has(review.id)) {
      throw new BureauError(`Review with id "${review.id}" is already being resolved`, 'CONFLICT');
    }
    resolvingReviewIds.add(review.id);

    let retryAfterCatchUp = false;
    try {
      // AB-391 (Codex P1 review finding, PR #601, "Fence concurrent
      // resolutions before performing the action"): everything below this
      // point — `resumeApproval`, `revokeApproval`, and the
      // `signalSession` calls that deliver an approve/deny/reject decision
      // — is an IRREVERSIBLE side effect: a tool can execute, an approval
      // binding is revoked, or a parked run resumes. `persistReviewResolution`
      // already detects a DIFFERENT resolver's already-won decision (see
      // its own doc comment), but it only runs AFTER all of that, once this
      // call is persisting its OWN decision. Two Bureau instances sharing a
      // session store, both resolving the same still-pending review with
      // DIFFERENT decisions, would otherwise let the LOSING call's
      // irreversible action run before it ever discovers it lost — an
      // approve could execute a tool even though the durable winner is a
      // deny. Checked here, before any action, so a losing call fails
      // before doing anything irreversible. This is a plain read
      // (`SessionStore.load`); a genuinely simultaneous pair, neither yet
      // committed, both pass it, and the durable decision record claimed
      // below (COR-1579) is what decides between them. This check only ever
      // fences a DIFFERENT decision — the same-decision retry case is
      // untouched, exactly as `persistReviewResolution`'s own `alreadyLanded`
      // handling already covers it.
      const existingSession = await runtime.sessionStore?.load(review.sessionId);
      const existingDecisionsRaw = existingSession?.metadata['resolvedReviewDecisions'];
      const existingDecisions: Record<string, JSONValue> =
        typeof existingDecisionsRaw === 'object' &&
        existingDecisionsRaw !== null &&
        !Array.isArray(existingDecisionsRaw)
          ? (existingDecisionsRaw as Record<string, JSONValue>)
          : {};
      const priorRaw = ownEntry(existingDecisions, review.id);
      const prior =
        typeof priorRaw === 'object' && priorRaw !== null && !Array.isArray(priorRaw)
          ? (priorRaw as Record<string, JSONValue>)
          : undefined;
      if (prior !== undefined) {
        const priorDecision = typeof prior['decision'] === 'string' ? prior['decision'] : undefined;
        const priorPrincipal =
          typeof prior['principal'] === 'string' ? prior['principal'] : undefined;
        const priorReason = typeof prior['reason'] === 'string' ? prior['reason'] : undefined;
        const isSameDecision =
          priorDecision === input.decision &&
          priorPrincipal === input.principal &&
          priorReason === input.reason;
        if (!isSameDecision) {
          throw new BureauError(
            `Review "${review.id}" was already resolved as "${priorDecision ?? 'unknown'}" by a different resolver`,
            'CONFLICT',
          );
        }
      }
      retryAfterCatchUp =
        (await fenceReviewRound(review, input, existingSession?.metadata, !afterCatchUp)) ===
        'retry';
    } catch (error) {
      resolvingReviewIds.delete(review.id);
      throw error;
    }
    if (retryAfterCatchUp) {
      resolvingReviewIds.delete(review.id);
      return resolveReview(input, derived, true);
    }

    // COR-1579: claim the decision durably before anything irreversible. See
    // `review-decision-record.ts` for which claims are kept and which released.
    const claimRequest = sessionDecisionRequest(review, input);
    // COR-1828: what the decision's records keep: see `recordedByDecision`.
    const { answerDigest, rememberTool } = recordedByDecision(review, input, claimRequest.digest);
    const decisionOwner = await ownerForRecord(review.runId);
    let claim: Awaited<ReturnType<typeof reviewDecisions.claim>>;
    try {
      if (review.kind === 'human-wait' && input.decision === 'approve') {
        await assertHumanWaitApprovalAuthority(review, listed === undefined);
      }
      claim = await reviewDecisions.claim(claimRequest);
      if (claim.outcome === 'conflict') {
        throw new BureauError(
          `Review "${review.id}" was already resolved as "${claim.decision ?? 'unknown'}" by a different resolver`,
          'CONFLICT',
        );
      }
    } catch (error) {
      resolvingReviewIds.delete(review.id);
      throw error;
    }
    if (claim.outcome === 'same' && review.kind === 'tool-approval') {
      try {
        return await answerSameApprovalDecision(review, input);
      } finally {
        resolvingReviewIds.delete(review.id);
      }
    }
    await refuseSettledHumanWait(review, claim, claimRequest);
    const heldApprovalClaim =
      claim.outcome === 'claimed' && review.kind === 'tool-approval' ? claim.value : undefined;
    // Set once a step that cannot be shown not to have acted has begun: a throw before it is a
    // proven pre-execution failure, which releases an approval's claim.
    let actionStarted = false;
    // COR-1920: what the audit entry says of each secret answer this delivery stored.
    let secretAnswerAudit: readonly SecretAnswerAuditEntry[] = [];
    // COR-2009: the audit record of the approved call, once it has run.
    let approvedCallAudit: ApprovedCallAudit | undefined;

    let result: unknown;
    let keepPending = false;
    try {
      await refuseStaleRoundOfHeldClaim(review, heldApprovalClaim !== undefined, input.round);
      if (review.kind === 'tool-approval') {
        // COR-1596: a fire canceled elsewhere (a peer process, a route that never reached this
        // one) still has its approval here until this is read; the engine's status says it was
        // canceled, so nothing runs and the approval ends, whatever order the bookkeeping landed.
        if (scheduledFireApprovalRuns.has(review.runId)) {
          const engineStatus = await readFireEngineStatus(
            review.runId,
            'its approval is not decided',
          );
          if (engineStatus === 'cancelled') {
            await releaseScheduledFire(review.runId, 'canceled');
            throw new BureauError(
              `Run "${review.runId}" was canceled, so review "${review.id}" is closed`,
              'CONFLICT',
            );
          }
          if (engineStatus === 'unreadable' && input.decision === 'approve') {
            throw new BureauError(
              'Cannot approve: whether the run was canceled cannot be read.',
              'CONFLICT',
            );
          }
        }
        // COR-1947: an approved call is decided again, under the chat's mode of the moment.
        const approvalToolbox =
          runToolboxesByRunId.get(review.runId) ??
          runtime.withChatPermission(runtime.baseToolbox, review.runId);
        if (input.decision === 'approve') {
          const { approval } = review;
          if (approval.approvalToken === undefined) {
            throw new BureauError(
              'Cannot approve: the toolbox that executed this tool call has no ' +
                'approvalSecret configured, so its pendingApproval was never signed.',
              'NOT_CONFIGURED',
              'approval',
            );
          }
          // COR-1613: the call is decided under the skills active now, which a restored approval
          // has again: a tool they no longer permit is not run, as a step would not run it.
          // COR-1620: under a snapshot read again now, and never without one that verifies.
          const policyToolbox = await skillPolicyToolboxOf(
            review,
            runToolboxesByRunId.get(review.runId),
          );
          // COR-1879: by id when the approval is bound to one, so an approval for `b:search` is not
          // let through by a skill that permits `a:search`, which shares the name `search`.
          const boundToolId = approval.approvalBinding?.toolDefinitionRevision;
          if (
            !policyToolbox
              .tools()
              .some((tool) =>
                boundToolId === undefined
                  ? formatToolName(tool.identity) === approval.toolName
                  : tool.id === boundToolId,
              )
          ) {
            throw new BureauError(
              `Cannot approve: tool "${approval.toolName}" is not permitted by the run's active skills.`,
              'CONFLICT',
            );
          }
          const approvalRequestContext = runRequestContexts.get(review.runId);
          if (
            approvalRequestContext &&
            isTransportIssuedAuthority(approvalRequestContext) &&
            !requestAuthorityValidator
          ) {
            throw new BureauError(
              'Cannot approve: the recovered request authority cannot be revalidated.',
              'CONFLICT',
            );
          }
          if (
            approvalRequestContext &&
            isTransportIssuedAuthority(approvalRequestContext) &&
            requestAuthorityValidator &&
            !(await requestAuthorityValidator(approvalRequestContext))
          ) {
            throw new BureauError(
              'Cannot approve: the request authority is no longer current.',
              'CONFLICT',
            );
          }
          const peerRecovery = peerRecoveryForApproval(review, input, claimRequest);
          await persistApprovalResolutionStartedWithRetry(
            review.sessionId,
            review.id,
            peerRecovery,
          );
          actionStarted = true;
          const approvedCallStartedAt = runtimeServices.clock.nowISO();
          result = await approvalToolbox.resumeApproval(
            { ...approval, approvalToken: approval.approvalToken },
            {
              ...(Object.prototype.hasOwnProperty.call(input, 'arguments')
                ? { arguments: input.arguments }
                : {}),
              ...(approvalRequestContext ? { requestContext: approvalRequestContext } : {}),
              // COR-1920: the approved call is the run's, so a secret answer it names resolves for
              // that run, as it would have had the call not waited for approval.
              // COR-2106: and so is the rest of the run's context (`approvedCallExecutionContext`).
              executionContext: approvedCallExecutionContext(review.runId),
              ...(peerRecovery === undefined
                ? {}
                : { durableOperationKey: peerRecovery.durableOperationKey }),
            },
          );
          approvalRunTimes.set(review.id, {
            startedAt: approvedCallStartedAt,
            endedAt: runtimeServices.clock.nowISO(),
          });

          // `resumeApproval` re-runs the tool's `beforeExecute` policy from
          // scratch — a policy that re-evaluates on edited arguments (or has
          // changed since the original request) can gate it again, returning
          // ANOTHER `action_required` instead of executing. The tool did not
          // run, so this id must stay resolvable: undo the resolved mark (the
          // same recovery the catch block below does for a thrown error) so
          // the review is not silently dropped from the queue while the tool
          // call remains genuinely pending approval.
          if (
            result !== null &&
            typeof result === 'object' &&
            'outcome' in result &&
            result.outcome === 'action_required'
          ) {
            const nextApproval = (result as Record<string, unknown>)['pendingApproval'];
            if (nextApproval && typeof nextApproval === 'object') {
              const replacementApproval = nextApproval as Extract<
                PendingReview,
                { kind: 'tool-approval' }
              >['approval'];
              // Publish the replacement locally before attempting durable
              // persistence. The original binding has already been consumed;
              // keeping it in memory after a persistence failure would make a
              // later retry reuse an invalid approval.
              pendingApprovalOverrides.set(review.id, replacementApproval);
              pendingApprovalRounds.set(review.id, review.round + 1);
              await persistPendingApprovalOverrideWithRetry(
                review.sessionId,
                review.id,
                replacementApproval,
              );
              // AB-46/AB-224: the re-gate produced a genuinely new
              // `pendingApproval` for the same `callId` — the ORIGINAL
              // review is superseded, attributed to the synthetic principal
              // `'system:supersession'`, while the replacement takes over
              // the same review id as a fresh `'pending'` entry (read live
              // from `pendingApprovalOverrides` by `listPendingReviews()`,
              // not written here).
              //
              // AB-391: `superseded` is deliberately NOT coupled to the
              // override write above through the outbox — the issue's own
              // "review transitions" list (`requested`/`resolved`/
              // `rejected`/`canceled`) never names it, and bundling it into
              // the SAME `conditionalBatch` as the replacement override
              // write would embed the ORIGINAL review (with its now-revoked
              // approval token) alongside the REPLACEMENT token in one
              // commit — a real, observable difference from every other
              // transition this issue closes, not just an implementation
              // detail. Keeps writing directly, exactly as before.
              await recordReviewStatusTransition(review, 'superseded', 'system:supersession');
            }
            keepPending = true;
            // COR-1579: the tool did not run, and the review is pending again under the next
            // round, so this round's claim is given up.
            await releaseApprovalClaim(claimRequest, heldApprovalClaim);
          } else if (
            result !== null &&
            typeof result === 'object' &&
            'outcome' in result &&
            result.outcome === 'error' &&
            resumeRefusedBeforeExecution(result)
          ) {
            const failedResult = result as {
              error?: { message?: string };
              errorMessage?: string;
            };
            await persistPendingApprovalOverrideWithRetry(
              review.sessionId,
              review.id,
              review.approval,
            );
            // COR-1579: a proven pre-execution failure: the binding was not consumed.
            await releaseApprovalClaim(claimRequest, heldApprovalClaim);
            throw new BureauError(
              `Cannot approve: ${failedResult.error?.message ?? failedResult.errorMessage ?? 'tool approval resume failed before execution admission.'}`,
              'CONFLICT',
            );
          } else {
            // Written once the decision is recorded, below, so the log reads approval, then the
            // call it let run.
            approvedCallAudit = approvedCallAuditOf(review, approval, result);
          }
        } else if (review.approval.approvalBinding && review.approval.approvalToken !== undefined) {
          await persistApprovalResolutionStartedWithRetry(review.sessionId, review.id);
          actionStarted = true;
          try {
            await approvalToolbox.revokeApproval(review.approval as SignedPendingToolApproval);
          } catch (error) {
            // A denial is still authoritative when the binding has expired or
            // was already consumed. Only an issued, revocable binding needs
            // revocation; failure to revoke stale state must not lose the
            // operator's denial decision.
            if (!isTerminalApprovalBindingError(error)) throw error;
            diagnose({
              level: 'warn',
              scope: 'approval',
              message: `[bureau] Denied approval "${review.id}" was already terminal or absent: ${serializeUnknownError(error)}`,
            });
          }
        }
      } else {
        // AB-46: a `human-wait` park is a genuine durable park
        // (`ctx.waitForSignal`) — unlike tool-approval, where "deny" has no
        // run to continue, denying or rejecting a human-wait review must
        // still deliver SOMETHING on `review.signalName` or the parked run
        // stays `running` forever. Approve delivers the caller's payload,
        // deny and reject their sentinels, all on the same channel. The
        // authority was checked before the claim; the delivery goes through
        // the public `bureau.contexts.signal` (one seam, not two ways to do the
        // same thing), keyed by the review id (COR-1579), so a same-decision
        // re-drive delivers once and nothing is left buffered for the next park.
        actionStarted = true;
        // COR-1920: the sealed secrets are stored for the run before the signal names them.
        const delivery = await prepareHumanWaitDelivery(
          review,
          humanWaitDecisionPayload(input),
          input.principal,
          input.decision,
        );
        secretAnswerAudit = delivery.audit;
        await deliverHumanWaitDecision(review, delivery.payload);
      }
    } catch (error) {
      if (!actionStarted) await releaseApprovalClaim(claimRequest, heldApprovalClaim);
      resolvingReviewIds.delete(review.id);
      throw error;
    }

    resolvingReviewIds.delete(review.id);
    // AB-391: `false` for the `keepPending` re-gate branch above — nothing
    // is persisted there, so `recordReviewDecision` below keeps writing the
    // audit record directly, exactly as it always has.
    let auditAlreadyAppended = false;
    if (!keepPending) {
      markReviewResolvedLocally(review);
      const auditAttachment = buildReviewDecisionAuditRecord(
        review,
        input.decision,
        input.principal,
        input.reason,
        secretAnswerAudit,
        answerDigest,
        decisionOwner,
      );
      try {
        auditAlreadyAppended = await persistReviewResolutionWithRetry(
          review.sessionId,
          review.id,
          review.kind === 'tool-approval',
          review.runId,
          input.decision,
          input.principal,
          input.reason,
          auditAttachment,
          rememberTool,
        );
      } catch (error) {
        // AB-391 (Codex P1 review finding, PR #601, "Distinguish concurrent
        // resolvers from commit retries"): a genuine CONFLICT here means a
        // DIFFERENT resolver's decision already durably won this review —
        // THIS call's own attempt made no partial commitment (the updater
        // returned `undefined` before building any candidate object), so
        // there is nothing to clean up and nothing for a future retry to
        // ever successfully complete: registering `reviewResolutionCleanupPending`
        // for it would only make every future call for this id re-throw the
        // identical CONFLICT via the cleanup branch above, forever. Rethrow
        // directly instead — every OTHER rejection here (a transient
        // storage failure, genuinely ambiguous) still registers cleanup as
        // before, since `resumeApproval` above may already have run and its
        // audit trace must not be lost.
        if (!(error instanceof BureauError && error.code === 'CONFLICT')) {
          reviewResolutionCleanupPending.set(review.id, {
            sessionId: review.sessionId,
            runId: review.runId,
            kind: review.kind,
            decision: input.decision,
            review,
            principal: input.principal,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            ...(result === undefined ? {} : { result }),
            secretAnswers: secretAnswerAudit,
            answerDigest,
            rememberTool,
            owner: decisionOwner,
          });
        }
        resolvingReviewIds.delete(review.id);
        throw error;
      }
      await releaseDecidedReview(review.runId, review.id);
      if (auditAlreadyAppended) {
        // AB-391: replay the just-appended audit record promptly, while
        // this bureau is alive, rather than leaving it for a later
        // trigger.
        //
        // Codex review finding, PR #601, "Isolate post-commit drain
        // failures from review resolution": the resolution commit above
        // has ALREADY succeeded — a transient failure in this best-effort
        // drain must never abort `resolveReview` before it dispatches the
        // live event below or returns its result. A failed drain leaves
        // the attachment claimed-but-unacknowledged for a later drain (a
        // maintenance tick, or boot recovery) to replay.
        try {
          await drainOutbox();
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Post-commit outbox drain failed after resolving review "${review.id}"; the audit record remains pending for a later drain: ${serializeUnknownError(error)}`,
          });
        }
      }
    }

    // COR-855: the outcome the run's conversation has to show before the next
    // run starts from it. A resolution the policy gated again executed nothing.
    const outcomeNotWritten =
      review.kind === 'tool-approval' && !keepPending
        ? await writeApprovalOutcomeToSession(review, input, result)
        : undefined;

    await recordReviewDecision(review, input.decision, input.principal, input.reason, {
      auditAlreadyAppended,
      secretAnswers: secretAnswerAudit,
      answerDigest,
      owner: decisionOwner,
      // COR-1828: a superseded call decided nothing, so it keeps no resolved-review record.
      decisionIsFinal: !keepPending,
    });
    await recordApprovedCall(approvedCallAudit);

    if (outcomeNotWritten !== undefined) throw outcomeNotWritten;

    return {
      id: review.id,
      kind: review.kind,
      decision: input.decision,
      result,
      ...(review.kind === 'tool-approval' && input.decision === 'reject'
        ? { feedback: input.reason }
        : {}),
      ...(keepPending ? { superseded: true as const } : {}),
      // COR-1828: stored with the decision's commit; a superseded call ran nothing, so none was.
      ...(await grantFieldsOf(rememberTool, !keepPending && auditAlreadyAppended, review)),
    };
  }

  /**
   * COR-1828, COR-1990 — the `remembered` and `loosened` fields of a resolution that was asked to
   * remember a tool: whether the grant was stored with the decision, and whether it makes the tool's
   * next ask in the chat be skipped, which a grant that was not stored never does. Nothing when no
   * tool was named.
   */
  async function grantFieldsOf(
    rememberTool: string | undefined,
    stored: boolean,
    review: PendingReview,
  ): Promise<{ remembered?: boolean; loosened?: boolean }> {
    if (rememberTool === undefined) return {};
    return { remembered: stored, loosened: stored && (await grantLoosensReview(review)) };
  }

  /**
   * COR-1990 — whether the grant a tool approval stored makes the tool's next ask in its chat be
   * skipped, read as the next call is decided: the agent's `approvals` for the tool and the
   * chat's permission mode now. Only an agent the file catalog builds reads a grant (that catalog is
   * the one place `approvalGrantsOfRun` is wired in), and that is a file agent and a tried agent,
   * which `files.ephemeral` builds the same way: a file agent is weighed by its file's definition,
   * and a tried agent by the definition it was built from, held in the `tryAgents` registry. A code
   * agent's toolbox and a plugin agent's belong to the host, which asks again whatever the chat
   * holds, so they answer `false`, as does a tried agent whose registry entry is gone (its context
   * was deleted): the Bureau cannot show the grant will be read, and a notice that promised
   * otherwise would fail open. The decision has committed, so a read that fails answers `false` and
   * never throws: the person is told the grant did not loosen the tool, and the grant is still held.
   */
  async function grantLoosensReview(review: PendingReview): Promise<boolean> {
    if (review.kind !== 'tool-approval') return false;
    try {
      const definition = await weighableDefinitionOf(review.agentName);
      // No definition to weigh: the grant is not read for this agent, so it loosens nothing.
      if (definition === undefined) return false;
      const catalog = new Map(Object.entries(agentToolCatalog));
      const tools = Object.fromEntries(
        (definition.tools ?? []).flatMap((name) => {
          const tool = catalog.get(name);
          return tool === undefined ? [] : [[name, tool]];
        }),
      );
      const mode = await permissionModeOfSession(
        review.sessionId,
        runSessionIncarnations.get(review.runId),
      );
      return grantLoosensTool({
        toolApproval: definition.approvals ?? undefined,
        tools,
        reportedName: review.approval.toolName,
        mode,
      });
    } catch {
      return false;
    }
  }

  /**
   * The tools and `approvals` of the agent `agentName` as its toolbox is built from them: a tried
   * agent's from the registry, a file agent's from its file, and nothing for any other agent.
   */
  async function weighableDefinitionOf(
    agentName: string | undefined,
  ): Promise<Pick<AgentFileDefinitionInput, 'tools' | 'approvals'> | undefined> {
    if (agentName === undefined) return undefined;
    if (isTryAgentName(agentName)) return tryAgents.definitionOf(agentName);
    const detail = await fileAgents?.files.detail(agentName);
    return detail?.definition ?? undefined;
  }

  /**
   * AB-391: builds the exact `AuditTrail.record()` payload a review
   * transition's durable write needs, WITHOUT writing it — used both to
   * append it as a `session.attachment` outbox entry (coupled to the
   * preceding session-store commit) and, for a path with no such commit to
   * couple to, to write it directly. Kept as one function so the two paths
   * can never drift on shape.
   */
  /**
   * COR-2009 — the audit record of an approved call that ran. It ran outside the run's step loop,
   * so the action stream that audits a run's own tool calls never sees it; the audit log's
   * "Refunded order 4472" is this record: the tool, its call, the review that approved it and how
   * it ended, never its arguments or result.
   */
  function approvedCallAuditOf(
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    approval: { readonly toolName: string; readonly callId: string },
    result: unknown,
  ): ApprovedCallAudit {
    const outcome =
      result !== null && typeof result === 'object' && 'outcome' in result
        ? result.outcome
        : undefined;
    return {
      runId: review.runId,
      type: 'tool.settled',
      detail: {
        agentName: review.agentName,
        toolName: approval.toolName,
        toolCallId: approval.callId,
        reviewId: review.id,
        ...(typeof outcome === 'string' ? { status: outcome } : {}),
      },
    };
  }

  /** Writes an approved call's audit record, when the resolution ran one. Best effort. */
  async function recordApprovedCall(audit: ApprovedCallAudit | undefined): Promise<void> {
    if (audit !== undefined) await auditTrailInstance?.record(audit);
  }

  function buildReviewDecisionAuditRecord(
    review: PendingReview,
    decision: 'approve' | 'deny' | 'reject',
    principal: string,
    reason?: string,
    secretAnswers: readonly SecretAnswerAuditEntry[] = [],
    // COR-1828: a human wait's approved answer as a digest over its reference form.
    answerDigest?: string,
    // COR-1828: the owner of record of the review's run, read while the run is live, so the
    // resolved-review record a replay writes later names it whatever became of the run.
    owner?: string,
  ): ReviewAuditAttachment {
    const secretFields = review.kind === 'human-wait' ? secretFieldsOfReview(review) : [];
    const decisionSuffix =
      decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'denied';
    return {
      runId: review.runId,
      type: `review.${review.kind}.${decisionSuffix}`,
      detail: {
        // The audit record names the review as it was asked, not the schema it asked with (COR-1487):
        // that already lives in the checkpoint, and up to 32 KiB of it would repeat in every record.
        // COR-1920: the fields it marked secret stay, so a retry after the review closed can still
        // keep them out of a digest.
        review:
          review.kind === 'human-wait'
            ? ({
                ...Object.fromEntries(
                  Object.entries(review).filter(([key]) => key !== 'inputSchema'),
                ),
                ...(secretFields.length > 0 ? { secretFields } : {}),
              } as unknown as PendingReview)
            : review,
        // The schema's absence is not the form's: this marker is how a closed wait is known to
        // have shown a form (COR-1674).
        ...(review.kind === 'human-wait' && review.inputSchema !== undefined
          ? { inputForm: true }
          : {}),
        decision,
        ...(reason !== undefined ? { reason } : {}),
        // COR-1920: a secret answer is named by its field and a digest of its ciphertext, never
        // by its value.
        ...(secretAnswers.length > 0 ? { secretAnswers } : {}),
        // COR-1828: what the resolved-review record keeps of the answer.
        ...(answerDigest !== undefined ? { answerDigest } : {}),
        ...(owner !== undefined ? { owner } : {}),
      },
      principal,
    };
  }

  /**
   * COR-1828 — keeps the record of a decided review, from the payload of the audit entry that
   * stands for the decision. Called by each writer of that entry, so the record is as durable as
   * the entry: a decision that rode the session commit is recorded when its outbox entry is
   * replayed (at `decidedAt`, the commit's time), and any other when its audit entry is written. A
   * payload that is not a decision (an expiry, a revocation) writes nothing. The owner rides in the
   * payload's `detail`, read while the run was live. A failure to write throws: on a replay it
   * leaves the outbox entry unacknowledged for the next drain, as a failed audit write does.
   */
  async function recordResolvedReview(
    payload: ReviewDecisionAuditPayload,
    decidedAt: number,
  ): Promise<void> {
    if (!payload.type.startsWith('review.')) return;
    const resolved = resolvedReviewOfAudit(payload, decidedAt);
    if (resolved === undefined) return;
    if (await resolvedReviewStore.record(resolved)) return;
    // A record already held is the same decision replayed, unless another decision won the review.
    const held = await resolvedReviewStore.get(resolved.review.id);
    if (
      held !== undefined &&
      (held.decision !== resolved.decision || held.decidedBy !== resolved.decidedBy)
    ) {
      diagnose({
        level: 'error',
        scope: 'audit-trail',
        message: `[bureau] The resolved-review record of "${resolved.review.id}" already holds ${held.decision} by "${held.decidedBy}"; ${resolved.decision} by "${resolved.decidedBy}" was not kept.`,
      });
    }
  }

  /** The owner of record a decision's records name: the run's, or the local owner of a run no one holds. */
  async function ownerForRecord(runId: string): Promise<string> {
    try {
      return (await runOwner(runId)) ?? ANONYMOUS_LOCAL_OWNER;
    } catch {
      return ANONYMOUS_LOCAL_OWNER;
    }
  }

  /** {@link recordResolvedReview} for a writer that cannot retry it: a failure is diagnosed, not thrown. */
  async function recordResolvedReviewBestEffort(
    payload: ReviewDecisionAuditPayload,
  ): Promise<void> {
    try {
      await recordResolvedReview(payload, runtimeServices.clock.now());
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'audit-trail',
        message: `[bureau] Could not keep the resolved-review record of "${payload.runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  async function recordReviewDecision(
    review: PendingReview,
    decision: 'approve' | 'deny' | 'reject',
    principal: string,
    reason?: string,
    // AB-391: `true` when the caller already appended this decision's audit
    // record as a `session.attachment` outbox entry (via
    // `persistReviewResolutionWithRetry`'s `auditAttachment` parameter) and
    // has drained it — the durable write already happened, or is pending a
    // later drain, so writing it again here would duplicate it. `false`
    // (the default) is the ONLY path with no preceding session-store commit
    // to couple to (`resolveReview`'s `keepPending` re-gate branch), where
    // the direct write below remains correct exactly as it always was.
    requestOptions?: {
      auditAlreadyAppended?: boolean;
      secretAnswers?: readonly SecretAnswerAuditEntry[] | undefined;
      answerDigest?: string | undefined;
      owner?: string | undefined;
      /**
       * COR-1828: `false` for a decision that left the review pending (a re-gated approval), whose
       * resolved-review record would name a decision nothing acted on and, being written once,
       * would hide the real one.
       */
      decisionIsFinal?: boolean;
    },
  ): Promise<void> {
    // COR-1622: a close follows the request it closes in the history, and the request of a fire's
    // first review waits for its seed read.
    await fireReviewSeeds.pending(review.runId);
    if (!requestOptions?.auditAlreadyAppended) {
      const directAudit = buildReviewDecisionAuditRecord(
        review,
        decision,
        principal,
        reason,
        requestOptions?.secretAnswers,
        requestOptions?.answerDigest,
        requestOptions?.owner ?? (await ownerForRecord(review.runId)),
      );
      await auditTrailInstance?.record(directAudit);
      // COR-1828: this entry rode no session commit, so no replay will keep the record.
      if (requestOptions?.decisionIsFinal !== false) {
        await recordResolvedReviewBestEffort(directAudit);
      }
    }

    // AB-224: the live counterpart of the durable write above — dispatched
    // alongside it, never instead of it, closing the live-side gap AB-87's
    // matrix named ("a typed review.*... family not built"). Carries only
    // id/runId/principal/kind; actor/decision content (arguments, reasons)
    // stays privileged to the durable audit trail per AB-87's redaction
    // column.
    if (decision === 'approve') {
      emitter.dispatch(new ReviewApprovedEvent(review.id, review.runId, principal, review.kind));
    } else if (decision === 'reject') {
      emitter.dispatch(new ReviewRejectedEvent(review.id, review.runId, principal, review.kind));
    } else {
      emitter.dispatch(new ReviewDeniedEvent(review.id, review.runId, principal, review.kind));
    }
    // COR-1577: a catalog run's review has no session whose ownership could need restoring.
    if (review.sessionId !== undefined) {
      await restoreRunOwnershipAfterEvent(
        review.runId,
        review.sessionId,
        runAttribution.get(review.runId)?.principal,
        runSessionIncarnations.get(review.runId),
      );
    }
  }

  /**
   * COR-1828 — the tools a person allowed for the rest of the chat `runId` belongs to, read from
   * the session's metadata when a tool call is decided. A run that no session holds (a
   * `bureau.run()` run, or one this process does not hold) has no chat, and a session that cannot be
   * read counts as having none, so the call asks.
   */
  async function approvalGrantsOfRun(runId: string): Promise<ReadonlySet<string>> {
    const sessions = runtime.sessionStore;
    if (sessions === undefined) return new Set();
    try {
      const sessionId = await sessionIdOfRun(runId);
      if (sessionId === undefined) return new Set();
      const session = await sessions.load(sessionId);
      return new Set(approvalGrantsOf(session?.metadata));
    } catch {
      return new Set();
    }
  }

  /**
   * The session `runId` belongs to, or `undefined` for a run no session holds. A run this process
   * holds names its session; one recovered after a restart is found by its task record, which
   * every session run writes before it starts.
   */
  async function sessionIdOfRun(runId: string): Promise<string | undefined> {
    const runState = store.getRun(runId);
    const live = runState === undefined ? '' : getRunSessionIdentifier(runState);
    const task = live !== '' ? undefined : await tasks.get(runId);
    return live !== '' ? live : task?.contextId;
  }

  /**
   * COR-1936 — the permission mode of the chat `runId` belongs to, read when a tool call is
   * decided: the mode the session's steering holds, caught up from the durable log first (so a
   * mode another process admitted is seen), so a steer is in force for the calls decided after it.
   * `undefined` for a run no session holds, which has no chat to steer. A chat that was never
   * steered is `on-changes`. A read that fails rejects, and the approval hook treats that as
   * `read-only`.
   *
   * COR-1955 — a child run reads the mode of the chat its record is stamped with
   * ({@link BureauChildChat}), the root of its delegation chain, and never of an ancestor: a parent
   * that ended and was retained away has no records left to find a chat by. A child cannot be put
   * to a person, so it is `askable: false`, and the stricter of the chat's mode and the child's own
   * `on-changes`: `allow-all` skips the asks of a chat's person, and a child has none. A child
   * whose chain started in no chat has no mode. A chat deleted since the child started rejects,
   * naming the chat, so the child is held to `read-only` and told why.
   */
  async function permissionModeOfRun(runId: string): Promise<ChatPermissionReading | undefined> {
    const child = await childTopologyStore.get(runId);
    if (child === undefined) return await permissionModeOfChatRun(runId);
    if (child.chat === undefined) return undefined;
    const { contextId, incarnation } = child.chat;
    const current = await runtime.sessionStore?.load(contextId);
    if (current?.incarnation !== incarnation) {
      throw new ChatPermissionUnavailableError(
        `the chat "${contextId}" this child run belongs to was deleted, so only read-only calls are allowed.`,
      );
    }
    const mode = await permissionModeOfSession(contextId, incarnation);
    return { mode: mode === 'allow-all' ? 'on-changes' : mode, askable: false };
  }

  /** The mode of the chat `runId` itself belongs to; `undefined` for a run no chat holds. */
  async function permissionModeOfChatRun(runId: string): Promise<PermissionMode | undefined> {
    if (runtime.sessionStore === undefined) return undefined;
    const sessionId = await sessionIdOfRun(runId);
    if (sessionId === undefined) return undefined;
    const incarnation = runSessionIncarnations.get(runId);
    const kv = durableSteeringStore();
    if (incarnation !== undefined && kv !== undefined) {
      // Pinned to the incarnation the run started in: a chat deleted, or deleted and recreated,
      // by another process rejects (the hook counts that as `read-only`) instead of reading
      // the replacement's mode, or none.
      const current = await runtime.sessionStore.load(sessionId);
      if (current?.incarnation !== incarnation) {
        throw new BureauError(
          `Session "${sessionId}" no longer has incarnation "${incarnation}".`,
          'CONFLICT',
        );
      }
    }
    // A run with no incarnation yet (a fresh schedule fire whose session does not exist) has no
    // chat to steer.
    return await permissionModeOfSession(sessionId, incarnation);
  }

  /** The mode a session's steering holds, `on-changes` before any was set. */
  async function permissionModeOfSession(
    sessionId: string,
    incarnation: string | undefined,
  ): Promise<PermissionMode> {
    // Read through the log catch-up, not the gate alone: another process on a shared durable
    // backend may have admitted a mode since this process last polled.
    const kv = durableSteeringStore();
    if (incarnation !== undefined && kv !== undefined) {
      const cursor = await enqueueSteering(sessionId, () =>
        catchUpSteering(kv, sessionId, incarnation),
      );
      return cursor.gate.getDesiredState().permissionMode ?? 'on-changes';
    }
    const steering = await getSessionSteering(sessionId);
    return steering?.permissionMode ?? 'on-changes';
  }

  /**
   * COR-1955 — the chat `parentRunId` runs in, as its children are stamped: its session and the
   * incarnation it started in. `undefined` for a run that belongs to no chat.
   */
  async function chatOfParentRun(parentRunId: string): Promise<BureauChildChat | undefined> {
    if (runtime.sessionStore === undefined) return undefined;
    const contextId = await sessionIdOfRun(parentRunId);
    if (contextId === undefined) return undefined;
    const known = runSessionIncarnations.get(parentRunId);
    const session = known === undefined ? await runtime.sessionStore.load(contextId) : undefined;
    const incarnation = known ?? session?.incarnation;
    return incarnation === undefined ? undefined : { contextId, incarnation };
  }

  /**
   * Derives a {@link ReviewStatus} from a `review.*` audit record's `type`
   * suffix (AB-46). `getReview` uses this to reconstruct a resolved review's
   * status from the chronologically-last matching audit entry. `resolveReview`
   * writes a `review.*.superseded` audit entry from `resumeApproval`'s
   * re-gate branch (AB-224, see `recordReviewStatusTransition` below) — the
   * case is handled explicitly here (rather than falling through to
   * `'denied'`) both for that write and for any externally-produced record.
   */
  function reviewStatusFromAuditType(type: string): ReviewStatus {
    switch (type.split('.').pop()) {
      case 'approved':
        return 'approved';
      case 'rejected':
        return 'rejected';
      case 'expired':
        return 'expired';
      case 'revoked':
        return 'revoked';
      case 'canceled':
        return 'canceled';
      case 'superseded':
        return 'superseded';
      case 'denied':
      default:
        return 'denied';
    }
  }

  /**
   * Writes a `review.<kind>.<status>` audit entry, and dispatches the live
   * `review.*` counterpart (AB-224), for a status transition that is NOT one
   * of `resolveReview`'s decision outcomes (approve/deny/reject) — namely
   * `sweepExpiredReviews`'s `'expired'` transition,
   * `revokePendingApprovalsForRun`'s `'canceled'`/`'revoked'` transitions,
   * and `resolveReview`'s own `resumeApproval` re-gate branch's `'superseded'`
   * transition (AB-46/AB-224). The durable write is a no-op when no audit
   * trail is configured, matching `recordReviewDecision`; the live dispatch
   * always fires regardless. `review` is embedded in `detail.review` with its
   * own `status` field forced to `status` — every caller passes a review
   * whose `status` still reads `'pending'` (it came from a live scan of
   * `listPendingReviews()`), and embedding that stale value verbatim would
   * make `detail.review.status` disagree with both the audit `type` and the
   * top-level `detail.status`, exactly the inconsistency `getReview`'s
   * audit-trail reconstruction and any other audit consumer must not see.
   */
  async function recordReviewStatusTransition(
    review: PendingReview,
    status: Exclude<ReviewStatus, 'pending' | 'approved' | 'denied' | 'rejected'>,
    principal: string,
    // COR-1622: `audit: false` leaves the audit record alone, because it is already there and the
    // history event is what is being written; `dispatch: false` writes no event, because the
    // history already holds it and the audit record is what is being written.
    parts: { readonly audit?: boolean; readonly dispatch?: boolean } = {},
  ): Promise<void> {
    // COR-1622: a close follows the request it closes in the history.
    await fireReviewSeeds.pending(review.runId);
    // AB-391: `expired` (`sweepExpiredReviews`), `revoked`/`canceled`
    // (`revokePendingApprovalsForRun`), and `superseded` (`resolveReview`'s
    // re-gate branch) each have no preceding session-store commit this
    // durable write could be coupled to via the outbox — see
    // `recordReviewDecision`'s own doc comment for the transitions that DO.
    // This keeps writing directly, exactly as before.
    // COR-1621: a canceled review round is closed once across instances, so its record carries the
    // key two instances that observe the same cancel of the same round share. Every other status is written as it
    // was. A keyed write rejects on a storage failure where the unkeyed one never does, so that
    // rejection is diagnosed here and the closing goes on, as a failed unkeyed write always did.
    const round = review.kind === 'tool-approval' ? review.round : 0;
    try {
      if (parts.audit !== false)
        await auditTrailInstance?.record({
          runId: review.runId,
          type: `review.${review.kind}.${status}`,
          detail: { review: { ...review, status }, status },
          principal,
          ...(status === 'canceled'
            ? { dedupeKey: reviewCanceledDedupeKey(review.id, round) }
            : {}),
        });
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'audit-trail',
        message: `[bureau] Could not record the ${status} closing of review "${review.id}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }

    // AB-224: live counterpart, same rationale as `recordReviewDecision`
    // above. `approve`/`deny`/`reject` never reach this function — they
    // dispatch from `recordReviewDecision` instead — so the switch below is
    // exhaustive over exactly `expired | revoked | canceled | superseded`.
    if (parts.dispatch !== false) {
      switch (status) {
        case 'expired':
          emitter.dispatch(new ReviewExpiredEvent(review.id, review.runId, principal, review.kind));
          break;
        case 'revoked':
          emitter.dispatch(new ReviewRevokedEvent(review.id, review.runId, principal, review.kind));
          break;
        case 'canceled':
          emitter.dispatch(
            new ReviewCanceledEvent(review.id, review.runId, principal, review.kind, round),
          );
          break;
        case 'superseded':
          emitter.dispatch(
            new ReviewSupersededEvent(review.id, review.runId, principal, review.kind),
          );
          break;
      }
    }
    // COR-1577: a catalog run's review has no session whose ownership could need restoring.
    if (review.sessionId !== undefined) {
      await restoreRunOwnershipAfterEvent(
        review.runId,
        review.sessionId,
        runAttribution.get(review.runId)?.principal,
        runSessionIncarnations.get(review.runId),
      );
    }
  }

  /**
   * The run a review id addresses. Ids are `approval:${runId}:${callId}` /
   * `human-wait:${runId}:${signalName}:${parkOrdinal}` — the run id is always the second
   * colon-delimited segment.
   */
  function reviewRunId(id: string): string | undefined {
    const [, runId] = id.split(':');
    return runId === undefined || runId === '' ? undefined : runId;
  }

  /**
   * COR-1579 — a run's pending human waits, derived from durable state. See the
   * {@link Bureau.pendingHumanWaitsOfRun} doc comment.
   */
  async function pendingHumanWaitsOfRun(runId: string): Promise<PendingHumanWaitReview[]> {
    // COR-2009: a workflow file's instance waiting at a review step.
    const workflowWaits = workflowReviewWaits.ofRun(runId);
    if (workflowWaits.length > 0) return workflowWaits;
    if (store.getRun(runId) !== undefined || runHumanWaits.holds(runId)) {
      const local: PendingReview[] = [...listPendingReviews(), ...runHumanWaits.list()];
      return local.filter(
        (review): review is PendingHumanWaitReview =>
          review.kind === 'human-wait' && review.runId === runId,
      );
    }
    const derived = await runHumanWaits.derive(runId);
    return derived === undefined ? [] : [derived];
  }

  /**
   * COR-1579 — the human wait `id` names when this process lists no review under it: the park of
   * a run another process holds, derived by its run id. `undefined` for anything this process
   * already answers for (a listed review, or one whose resolution is still being cleaned up).
   */
  async function derivedHumanWait(id: string): Promise<PendingHumanWaitReview | undefined> {
    if (!id.startsWith('human-wait:') || reviewResolutionCleanupPending.has(id)) return undefined;
    if (listPendingReviews().some((review) => review.id === id) || runHumanWaits.has(id)) {
      return undefined;
    }
    const runId = reviewRunId(id);
    if (runId === undefined) return undefined;
    const pending = await pendingHumanWaitsOfRun(runId);
    return pending.find((review) => review.id === id);
  }

  /**
   * COR-1804 — returns the input to resolve, or refuses, before any resolver claims the review, an
   * approval of a human wait whose `payload` does not satisfy the schema the wait was parked with (the model's per-call
   * `answerSchema`, else the author's per-signal one). Every answer reaches a human wait through
   * {@link resolveAnyReview}, so this is the one place the answer is judged, whichever path
   * (`bureau.reviews.resolve`, `tasks.respond`, an AG-UI resume) carried it. A wait with no schema
   * takes any answer, and a deny or reject carries none. The refusal changes nothing: the review
   * stays pending. A review this process cannot find is left to the resolver that reports it.
   */
  async function humanWaitAnswerFittingItsSchema(
    input: ResolveReviewInput,
  ): Promise<ResolveReviewInput> {
    if (input.decision !== 'approve') return input;
    // The caller owns `payload`, and this reads the review across awaits: the answer that is
    // checked is a copy taken now, and it is the copy that is delivered when a schema applies.
    let snapshot: unknown = input.payload;
    try {
      snapshot = structuredClone(input.payload);
    } catch {
      // Not cloneable, so not JSON: a schema refuses it below, and a wait without one takes it as given.
    }
    // COR-1920: a review that has closed is read back from the audit trail, which keeps the fields
    // its schema marked secret, so a same-decision retry seals them and digests alike.
    // A tool approval carries no answer, so only a human wait's id is looked up.
    if (!input.id.startsWith('human-wait:')) return input;
    const review = await getReview(input.id);
    // The shared gate (COR-1920): the answer names its review, which this path seals for.
    await gateSecretAnswer({ candidates: [input.id], read: async () => review, seals: true });
    if (review?.kind !== 'human-wait') return input;
    const sealed = await sealHumanWaitAnswer(review, snapshot);
    if (review.inputSchema === undefined) {
      return sealed.sealed === snapshot ? input : { ...input, payload: sealed.sealed };
    }
    const issues = validateReviewAnswer(review.inputSchema, sealed.plaintext);
    if (issues.length > 0) throw new ReviewAnswerInvalidError(issues);
    return snapshot === undefined ? input : { ...input, payload: sealed.sealed };
  }

  /**
   * COR-1920 — the answer to a human wait with each field its question marks secret sealed: the
   * plaintext, to check against the schema, and the sealed answer, to deliver or keep. An answer
   * with no secret field is both. Refused as `NOT_CONFIGURED` (`encryption`) when the Bureau has no
   * key or no storage to keep a secret in, and as a {@link ReviewAnswerInvalidError} when a field
   * holds a sealed answer that is not this question's.
   */
  async function sealHumanWaitAnswer(
    review: PendingHumanWaitReview,
    answer: unknown,
  ): Promise<{ readonly plaintext: unknown; readonly sealed: unknown }> {
    const fields = secretFieldsOfReview(review);
    if (fields.length === 0) return { plaintext: answer, sealed: answer };
    if (runtime.secretAnswers === undefined) {
      throw new BureauError(
        'This question asks for a secret, and the Bureau has no key or storage to keep one in (set "answerEncryption" and "storage").',
        'NOT_CONFIGURED',
        'encryption',
      );
    }
    const outcome = await runtime.secretAnswers.seal({ reviewId: review.id, fields, answer });
    if (!outcome.ok) throw new ReviewAnswerInvalidError(outcome.issues);
    return outcome;
  }

  /**
   * COR-1920 — refuses a human-wait approval whose payload holds a secret field unsealed. Both
   * delivery paths call it before their decision record digests the payload, so nothing of a
   * secret's plaintext is digested, claimed, or signalled. A deny or a reject delivers its own
   * marker, which carries no answer.
   */
  function refuseUnsealedSecrets(
    review: PendingReview,
    payload: unknown,
    decision: ResolveReviewInput['decision'],
  ): void {
    if (
      review.kind === 'human-wait' &&
      decision === 'approve' &&
      unsealedSecretFields(payload, secretFieldsOfReview(review)).length > 0
    ) {
      throw new BureauError(
        `Review "${review.id}" was answered with a secret that was not sealed`,
        'BAD_REQUEST',
      );
    }
  }

  /**
   * COR-1920 — stores the sealed secret answers a human-wait payload carries for the run that
   * asked, and returns the payload to signal, each reduced to its `{ secretRef }`, with what the
   * audit entry says of them. Both delivery paths call it after their decision is claimed and
   * before the signal: the record is written once, so every same-decision re-drive signals the
   * reference to the secret the first claimant stored.
   */
  async function prepareHumanWaitDelivery(
    review: PendingHumanWaitReview,
    payload: unknown,
    principal: string,
    decision: ResolveReviewInput['decision'],
  ): Promise<{ readonly payload: unknown; readonly audit: readonly SecretAnswerAuditEntry[] }> {
    // Checked again here, after the claim: a sealed payload is the only kind this stores.
    refuseUnsealedSecrets(review, payload, decision);
    if (!holdsSealedAnswer(payload)) return { payload, audit: [] };
    if (runtime.secretAnswers === undefined) {
      throw new BureauError(
        'This answer holds a secret, and the Bureau has no key or storage to keep one in.',
        'NOT_CONFIGURED',
        'encryption',
      );
    }
    try {
      return await runtime.secretAnswers.store(
        review,
        payload,
        runAttribution.get(review.runId)?.principal ?? principal,
      );
    } catch (error) {
      if (error instanceof SecretAnswerUnavailableError) {
        throw new BureauError(`Review "${review.id}" holds a secret it cannot store`, 'CONFLICT');
      }
      throw error;
    }
  }

  /**
   * `bureau.resolveReview`: a catalog park this process lists resolves through the engine by run
   * id (COR-1577), a park another process holds is derived first (COR-1579), and every other
   * review resolves through the session path.
   */
  async function resolveAnyReview(requested: ResolveReviewInput): Promise<ResolveReviewResult> {
    // COR-1828: the engine's human waits skip `resolveReview`, so the shape of the decision is refused here.
    assertDecisionFitsInput(requested);
    const input = await humanWaitAnswerFittingItsSchema(requested);
    if (runHumanWaits.has(input.id)) {
      assertExpectedReviewRound(input, { id: input.id, kind: 'human-wait' });
      return runHumanWaits.resolve(input);
    }
    // COR-2009: a workflow file's review step resolves through the engine by run id, fenced and
    // audited as a run's park is.
    const workflowWait = await workflowReviewOf(input.id);
    if (workflowWait !== undefined) {
      assertExpectedReviewRound(input, workflowWait);
      return resolveWorkflowReview(input, workflowWait);
    }
    const derived = await derivedHumanWait(input.id);
    // COR-1613: a schedule fire's wait goes through the engine by run id, as a catalog run's does,
    // though it names the session the fire runs in; a session run's keeps the session path.
    if (
      derived !== undefined &&
      (derived.sessionId === undefined || runHumanWaits.isDerivedFire(derived))
    ) {
      assertExpectedReviewRound(input, derived);
      return runHumanWaits.resolve(input, derived);
    }
    return resolveReview(
      input,
      derived?.sessionId === undefined ? undefined : { ...derived, sessionId: derived.sessionId },
    );
  }

  /**
   * COR-2009 — the workflow review `id` names. A review the session index lists, or one of a run
   * this process holds in its run store, is never a workflow's, and is answered without reading the
   * engine: an extra read would let the index hear of a settlement before its own path decides.
   */
  async function workflowReviewOf(id: string): Promise<PendingHumanWaitReview | undefined> {
    const held = workflowReviewWaits.find(id);
    if (held !== undefined) return held;
    const runId = reviewRunId(id);
    if (runId === undefined || store.getRun(runId) !== undefined) return undefined;
    if (listPendingReviews().some((review) => review.id === id)) return undefined;
    return workflowReviewWaits.lookup(id);
  }

  /**
   * COR-2009 — resolves the review of a workflow file's review step. The decision is claimed,
   * delivered on the step's signal, and audited by `runHumanWaits.resolve`, as a run's park is;
   * once it lands the review leaves the list, and a refusal reads the instance again, since the
   * engine then says the wait is over or the review was decided elsewhere.
   */
  async function resolveWorkflowReview(
    input: ResolveReviewInput,
    review: PendingHumanWaitReview,
  ): Promise<ResolveReviewResult> {
    let result: ResolveReviewResult;
    try {
      result = await runHumanWaits.resolve(input, review);
    } catch (error) {
      await workflowReviewWaits.refresh(review.runId).catch(() => undefined);
      throw error;
    }
    workflowReviewWaits.markResolved(review.id);
    return result;
  }

  /**
   * Look up one review by id, live or resolved (AB-46). See the
   * {@link Bureau.getReview} doc comment.
   */
  async function getReview(
    id: string,
  ): Promise<(PendingReview & ReviewResolutionFields) | undefined> {
    const pending = listPendingReviews().find((candidate) => candidate.id === id);
    if (pending) return pending;
    // COR-1577: the park of a `bureau.run()` run, which no session holds.
    const runWait = runHumanWaits.find(id);
    if (runWait) return runWait;
    // COR-2009: a workflow file's instance waiting at a review step.
    const workflowWait = await workflowReviewOf(id);
    if (workflowWait) return workflowWait;
    // COR-1579: the park of a run another process holds.
    const derived = await derivedHumanWait(id);
    if (derived) return derived;
    // COR-1828: the audit trail is where a closed review is read from, with what it was asked. A
    // Bureau with none, or whose trail no longer holds it, reads the review's own record, which
    // says who decided it and when and keeps what was asked and answered.
    const recorded = async (): Promise<(PendingReview & ReviewResolutionFields) | undefined> => {
      const found = await resolvedReviewStore.get(id);
      if (found === undefined) return undefined;
      return {
        ...found.review,
        resolvedBy: found.decidedBy,
        resolvedAt: found.decidedAt,
        ...(found.reason === undefined ? {} : { resolutionReason: found.reason }),
        ...(found.answerDigest === undefined ? {} : { answerDigest: found.answerDigest }),
        ...(found.secretRefs === undefined ? {} : { secretRefs: found.secretRefs }),
      };
    };
    if (!auditTrailInstance) return recorded();

    const runId = reviewRunId(id);
    if (!runId) return undefined;

    const records = await auditTrailInstance.query({ runId });
    let match: (typeof records)[number] | undefined;
    for (const record of records) {
      if (!record.type.startsWith('review.')) continue;
      const detail = record.detail;
      if (detail === null || typeof detail !== 'object') continue;
      // COR-1934: a deleted chat's entry keeps the review's identity and nothing it asked, so it
      // cannot stand for the review.
      if ((detail as Record<string, unknown>)['redacted'] === true) continue;
      const reviewDetail = (detail as Record<string, unknown>)['review'];
      if (reviewDetail === null || typeof reviewDetail !== 'object') continue;
      if ((reviewDetail as Record<string, unknown>)['id'] !== id) continue;
      // `query()` returns chronological (oldest-first) order — the last
      // match found in iteration order IS the chronologically-last one.
      match = record;
    }
    if (!match) return recorded();

    // A record written before `round` existed has none at runtime, whatever the type says.
    const reviewDetail = (match.detail as Record<string, unknown>)['review'] as PendingReview;
    // A decision says more than a closing does: its note, and what it kept of the answer.
    const decision = resolvedReviewOfAudit(
      { runId, type: match.type, detail: match.detail, principal: match.principal ?? '' },
      match.timestampMs,
    );
    return {
      ...reviewDetail,
      ...(reviewDetail.kind === 'tool-approval' ? { round: reviewDetail.round ?? 0 } : {}),
      status: reviewStatusFromAuditType(match.type),
      // Who decided it, and when, as the audit trail recorded the decision.
      ...(match.principal === undefined ? {} : { resolvedBy: match.principal }),
      resolvedAt: match.timestampMs,
      ...(decision?.reason === undefined ? {} : { resolutionReason: decision.reason }),
      ...(decision?.answerDigest === undefined ? {} : { answerDigest: decision.answerDigest }),
      ...(decision?.secretRefs === undefined ? {} : { secretRefs: decision.secretRefs }),
    };
  }

  /**
   * Expiry sweep (AB-46), run by every maintenance pass and by the lazy timer
   * armed while an approval is held: scans every tool-approval review past its
   * binding's `expiresAt` that is not already resolved, transitions each to
   * `status: 'expired'`, writes one `review.tool-approval.expired` audit entry
   * per review attributed to the synthetic principal `'system:expiry'`, and
   * returns the count swept. `human-wait` reviews are never swept — their
   * expiry is Weft's own wait timeout. `now` defaults to the bureau's own clock.
   */
  async function sweepExpiredReviews(now?: number): Promise<number> {
    const effectiveNow = now ?? runtimeServices.clock.now();
    let sweptCount = 0;
    const { runs } = store.getState();

    for (const [runId, runState] of runs) {
      // COR-1302: see `listPendingReviews`.
      if (catalogRunIds.has(runId)) continue;
      const sessionId = getRunSessionIdentifier(runState);
      const agentName = findRunAgentName(runState);
      const stepCompletedTimestamps = runState.actions
        .filter((action) => action.type === 'step.completed')
        .map((action) => action.timestamp);

      for (const [stepIndex, step] of runState.steps.entries()) {
        for (const result of step.results) {
          if (result.outcome !== 'action_required' || !result.pendingApproval) continue;
          const id = `approval:${runId}:${result.pendingApproval.callId}`;
          // A decision in flight owns the review: the next tick expires it if it lets go.
          if (resolvedReviewIds.has(id) || invalidApprovalReviewIds.has(id)) continue;
          if (resolvingReviewIds.has(id)) continue;
          const approval = pendingApprovalOverrides.get(id) ?? result.pendingApproval;
          if (approval.approvalBinding === undefined) continue;
          if (approval.approvalBinding.expiresAt > effectiveNow) continue;

          resolvedReviewIds.add(id);
          sweptCount += 1;
          const requestedAt = stepCompletedTimestamps[stepIndex] ?? effectiveNow;
          const review: PendingReview = {
            kind: 'tool-approval',
            id,
            runId,
            sessionId,
            agentName,
            approval,
            requestedAt,
            ageMilliseconds: effectiveNow - requestedAt,
            status: 'expired',
            round: pendingApprovalRounds.get(id) ?? 0,
          };
          await recordReviewStatusTransition(review, 'expired', EXPIRY_ACTOR);
        }
      }
    }

    // COR-1596: an approval of a run that is not on the store (a schedule fire's, or a session
    // run's the boot restored) is expired by the same rule, and its state ends with it.
    for (const [runId, terminalReview] of terminalReviewSessions) {
      for (const [id, approval] of pendingApprovalOverrides) {
        if (!id.startsWith(`approval:${runId}:`)) continue;
        if (resolvedReviewIds.has(id) || invalidApprovalReviewIds.has(id)) continue;
        if (resolvingReviewIds.has(id)) continue;
        if (approval.approvalBinding === undefined) continue;
        if (approval.approvalBinding.expiresAt > effectiveNow) continue;

        // Read before the drop, which deletes it: the record keeps the round the approval was at.
        const round = pendingApprovalRounds.get(id) ?? 0;
        const requestedAt = approvalRequestedAt.get(id) ?? terminalReview.requestedAt;
        resolvedReviewIds.add(id);
        sweptCount += 1;
        await recordReviewStatusTransition(
          {
            kind: 'tool-approval',
            id,
            runId,
            sessionId: terminalReview.sessionId,
            agentName: terminalReview.agentName,
            approval,
            requestedAt,
            ageMilliseconds: effectiveNow - requestedAt,
            status: 'expired',
            round,
          },
          'expired',
          EXPIRY_ACTOR,
        );
        if (scheduledFireApprovalRuns.has(runId)) {
          await releaseScheduledFireApproval(runId, id, 'expired');
        } else {
          dropPendingApprovalOverride(id);
          await prunePersistedInvalidApprovalReviewStateWithRetry(
            terminalReview.sessionId,
            runId,
            id,
          );
        }
      }
      if (
        !Array.from(pendingApprovalOverrides.keys()).some((id) =>
          id.startsWith(`approval:${runId}:`),
        )
      ) {
        terminalReviewSessions.delete(runId);
        releaseTerminalRunReviewState(runId);
      }
    }

    // Whatever this sweep released, the timer is only needed while an approval is still held.
    stopLazyExpirySweepWhenNoneHeld();
    return sweptCount;
  }

  /**
   * Under a workspace Bureau a schedule may continue only a chat its own owner holds, so a session
   * that is another owner's, or that does not exist, is answered as not found. Creating and
   * updating a schedule share this check, because every fire of one that fails it is `unavailable`.
   */
  async function refuseScheduleSessionOfAnotherOwner(
    sessionId: string,
    owner: string,
  ): Promise<void> {
    if (workspace !== undefined && (await sessionOwner(sessionId)) !== owner) {
      throw new BureauError('Session not found', 'NOT_FOUND');
    }
  }

  /**
   * Whether the owner may keep a schedule's recurring chat. A chat that is not made yet is theirs
   * to make, as the first fire of a schedule that Bureau named a chat for does; one that exists
   * must be theirs.
   */
  async function mayContinueScheduleSession(
    sessionId: string | undefined,
    owner: string,
  ): Promise<boolean> {
    if (sessionId === undefined) return true;
    const held = await sessionOwner(sessionId);
    return held === undefined || held === owner;
  }

  async function createSchedule(
    definition: DurableScheduleDefinition,
    scheduleOptions?: CreateScheduleOptions,
    // COR-1879 — the plugin whose host API creates the schedule; its `schedule.created` names it.
    source?: string,
  ): Promise<import('@lostgradient/weft').ScheduleSummary | undefined> {
    definition = structuredClone(definition);
    // A chat Bureau names itself is unguessable and not yet made, so it is not another owner's to
    // refuse: the schedule's first fire makes it, owned by the schedule's owner.
    const allocatedChat = definition.continueChat === true;
    if (allocatedChat) {
      if (definition.sessionId !== undefined) {
        throw new BureauError('"continueChat" and "sessionId" cannot both be given', 'BAD_REQUEST');
      }
      definition.sessionId = runtimeServices.identifiers.next('session');
    }
    if (definition.sessionId !== undefined) {
      rejectReservedIdentifier('"sessionId"', definition.sessionId.trim());
      // A schedule's session is made by its first fire when none exists yet. Only `.` and `..` are
      // refused for one that does not, so any other id costs no read of the store.
      if (unopenableNewSessionIdentifierReason('"sessionId"', definition.sessionId.trim())) {
        const held = await runtime.sessionStore?.load(definition.sessionId.trim());
        rejectUnopenableNewSessionIdentifier(
          '"sessionId"',
          definition.sessionId.trim(),
          held !== undefined,
        );
      }
    }
    const owner = ownerFromPrincipal(definition.principal, toBadRequest);
    if (definition.sessionId !== undefined && !allocatedChat) {
      await refuseScheduleSessionOfAnotherOwner(definition.sessionId.trim(), owner);
    }
    const workspaceAuthority =
      workspace === undefined ? undefined : await captureRunWorkspaceAuthority(workspace, owner);
    if (workspace !== undefined && workspaceAuthority === undefined)
      throw new BureauError('Workspace authority unavailable.', 'CONFLICT');
    if (!runtime.durable) return undefined;
    // COR-1667 — resolve the name the way a fire does (`agentCatalog.find`, which includes file
    // agents), so a typo is refused now instead of as `missing-agent` at the first fire. An agent
    // that goes missing later still fails at fire time, unchanged.
    if (agentCatalog.find(definition.agentName) === undefined) {
      throw new UnknownScheduleAgentError(definition.agentName);
    }
    // Register a native weft schedule that fires the `agentRun` workflow on each
    // tick. The fire path is wired through `resolveRunServices`' scheduled-fire
    // branch (see runtime-composition.ts): each tick builds fresh run deps from
    // the ScheduledAgentRunInput, seeds the prompt, and runs the agent (#109).
    //
    // Definition validation (blank recurring session, overlap 'allow' + recurring
    // session) lives in `createAgentSchedule` — the single chokepoint every caller
    // (bureau, AgentScheduler, the scheduleSelf tool) routes through — so it cannot
    // be bypassed. We surface its `InvalidScheduleError` as a BAD_REQUEST (400).
    //
    // Passing this bureau's own `emitter` here (unlike `pauseSchedule`/
    // `resumeSchedule`/`cancelSchedule` below, which dispatch directly) forwards
    // `createAgentSchedule`'s `AgentScheduledEvent` (`schedule.created`, AB-298)
    // straight onto it, exactly once for the fresh registration this call makes —
    // no separate dispatch needed here.
    const scheduler = createAgentScheduler({
      engine: runtime.durable.engine,
      // COR-1879: the internal variant a plugin's host API uses marks what it forwards.
      emitter:
        source === undefined
          ? emitter
          : { dispatch: (event) => emitter.dispatch(markEventSource(event, source)) },
    });
    // COR-1952: a schedule a hook-started run creates records the hook before it exists, under an
    // id minted here, so no fire can run before its origin is readable.
    const hookOrigin =
      scheduleOptions?.createdByRun === undefined || scheduleHookOrigins === undefined
        ? undefined
        : await hookOriginOfRun(scheduleOptions.createdByRun);
    const originId =
      hookOrigin === undefined ? undefined : runtimeServices.identifiers.next('schedule');
    if (originId !== undefined && hookOrigin !== undefined) {
      await scheduleHookOrigins!.recordSchedule(originId, hookOrigin);
    }
    let handle;
    try {
      handle = await scheduler.schedule(definition.agentName, {
        ...(originId === undefined ? {} : { id: originId }),
        spec: toScheduleSpec(definition.spec),
        input: definition.input,
        ...(definition.description !== undefined ? { description: definition.description } : {}),
        ...(definition.sessionId !== undefined ? { session: definition.sessionId } : {}),
        ...(definition.overlap !== undefined ? { overlap: definition.overlap } : {}),
        ...(definition.timeZone !== undefined ? { timeZone: definition.timeZone } : {}),
        principal: owner,
        ...(workspaceAuthority === undefined ? {} : { workspaceAuthority }),
      });
    } catch (error) {
      // Nothing was registered under the id, so its origin names no schedule.
      if (originId !== undefined) await scheduleHookOrigins?.clearSchedule(originId);
      if (error instanceof InvalidScheduleError) {
        toBadRequest(error.message);
      }
      throw error;
    }
    // The schedule is already registered at this point — a `describe()`
    // rejection here means only its locator (summary) is unavailable, not
    // that registration failed. Wrap it in a typed error naming the
    // `scheduleId` instead of letting `AgentScheduleHandle.describe()`'s bare
    // `Error('Schedule … no longer exists.')` propagate untyped.
    try {
      return await handle.describe();
    } catch (cause) {
      throw new ScheduleLocatorUnavailableError(handle.id, { cause });
    }
  }

  /**
   * COR-2009 — starts the schedule tick that records what the scheduler did, naming the schedule by
   * its description as it is now. Best effort: a tick that cannot be recorded is diagnosed and never
   * holds up the fire or the notice it records.
   */
  async function recordScheduleTick(
    scheduleId: string,
    tickOf: (scheduleName: string | null) => ScheduleTick,
  ): Promise<void> {
    const engine = runtime.durable?.engine;
    if (engine === undefined) return;
    try {
      const schedule = await engine.getSchedule(scheduleId);
      await startScheduleTick(engine, tickOf(schedule?.description ?? null));
    } catch (error) {
      diagnose({
        level: 'warn',
        scope: 'schedules',
        message: `[bureau] Could not record the schedule tick of schedule "${scheduleId}":`,
        cause: error,
      });
    }
  }

  async function getSchedule(
    scheduleId: string,
  ): Promise<import('@lostgradient/weft').ScheduleSummary | null | undefined> {
    if (!runtime.durable) return undefined;
    return runtime.durable.engine.getSchedule(scheduleId);
  }

  async function listSchedules(
    filter?: import('@lostgradient/weft').ScheduleFilter,
  ): Promise<
    | import('@lostgradient/weft').PaginatedResult<import('@lostgradient/weft').ScheduleSummary>
    | undefined
  > {
    if (!runtime.durable) return undefined;
    return runtime.durable.engine.listSchedules(filter);
  }

  /**
   * COR-1527 — a workflow file owns its schedule, so a write to it through the schedule methods is
   * answered as if the schedule did not exist; the workflow's own operations are the only way to
   * change it.
   */
  function refuseWorkflowSchedule(scheduleId: string): void {
    if (workflowRuntime !== undefined && parseWorkflowScheduleId(scheduleId) !== undefined) {
      throw new BureauError(`Schedule "${scheduleId}" does not exist`, 'NOT_FOUND');
    }
  }

  async function reassignSchedule(
    scheduleId: string,
    request: {
      readonly administrator: string;
      readonly targetOwner: string;
      readonly expectedRevision: number;
    },
  ): Promise<true | undefined> {
    const { administrator, targetOwner, expectedRevision } = request;
    if (workspace === undefined)
      throw new BureauError('Workspace authority unavailable.', 'CONFLICT');
    const durable = runtime.durable;
    if (durable === undefined) return undefined;
    const snapshot = await durable.engine.getSchedule(scheduleId);
    if (snapshot?.revision !== expectedRevision)
      throw new BureauError('Schedule revision changed.', 'CONFLICT');
    const input = await storedScheduleInput(durable.engine, scheduleId);
    if (
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input) ||
      (!isScheduledAgentRunInput(input) &&
        (parseWorkflowScheduleId(scheduleId) === undefined ||
          Reflect.get(input, 'kind') !== 'schedule'))
    )
      throw new BureauError('Schedule not found.', 'NOT_FOUND');
    const previous = workflowScheduleBinding(input).workspaceAuthority;
    if (previous === undefined || previous.workspaceId !== workspace.workspaceId)
      throw new BureauError('Workspace authority unavailable.', 'CONFLICT');
    const target = await resolveWorkspaceOwner(workspace, targetOwner);
    const admin = await resolveWorkspaceOwner(workspace, administrator);
    if (
      admin === undefined ||
      !admin.capabilities.includes('workspace:manage') ||
      target === undefined ||
      target.actorKind === 'service'
    )
      throw new BureauError('Workspace authority unavailable.', 'CONFLICT');
    const next = {
      version: 1 as const,
      workspaceId: target.workspaceId,
      actorId: target.actorId,
      authorizingOwner: target.owner,
      membershipRevision: target.membershipRevision,
    };
    const transition: PendingScheduleTransition = {
      kind: 'schedule.paused',
      scheduleId,
      committedAtMs: runtimeServices.clock.now(),
      reassignment: {
        workspaceId: workspace.workspaceId,
        previousActor: previous.actorId,
        nextActor: target.actorId,
        administrator: admin.actorId,
        previousRevision: expectedRevision,
        nextRevision: expectedRevision + 1,
      },
    };
    const key = scheduleTransitionKey(
      transition,
      runtimeServices.identifiers.next('schedule-transition'),
    );
    await durable.engine.replaceScheduleInput(
      scheduleId,
      { ...input, workspaceAuthority: next, authorityHold: 'reassigned' },
      {
        expectedRevision,
        additionalOperations: [scheduleTransitionOperation(key, transition)],
      },
    );
    try {
      await recordPendingScheduleTransitions(scheduleTransitionKeyPrefix(scheduleId));
    } catch {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: 'Schedule reassignment audit remains pending for maintenance.',
      });
    }
    return true;
  }

  async function pauseInvalidSchedule(scheduleId: string): Promise<void> {
    if (workspace === undefined || runtime.durable === undefined) return;
    const snapshot = await runtime.durable.engine.getSchedule(scheduleId);
    if (snapshot?.status !== 'active') return;
    const input = await storedScheduleInput(runtime.durable.engine, scheduleId);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return;
    if (!isScheduledAgentRunInput(input) && parseWorkflowScheduleId(scheduleId) === undefined) {
      if (snapshot.workflowType === 'agentRun')
        await runtime.durable.engine.pauseSchedule(scheduleId, {
          expectedRevision: snapshot.revision,
        });
      return;
    }
    let binding;
    try {
      binding = workflowScheduleBinding(input);
    } catch {
      await runtime.durable.engine.pauseSchedule(scheduleId, {
        expectedRevision: snapshot.revision,
      });
      return;
    }
    const authority = await recoverRunWorkspaceAuthority(
      workspace,
      binding.workspaceAuthority,
      isScheduledAgentRunInput(input) ? input.principal : 'anonymous:local',
    );
    const usableInput =
      !isScheduledAgentRunInput(input) ||
      (authority !== undefined &&
        (await mayContinueScheduleSession(input.sessionId, authority.authorizingOwner)) &&
        (await mayUseAutomationInput(
          input.input,
          runtime.mediaOptionsFor(authority.authorizingOwner, 'session').contentSourceResolver,
        )));
    if (authority !== undefined && binding.authorityHold === undefined && usableInput) {
      if (binding.workspaceAuthority === undefined)
        await runtime.durable.engine.replaceScheduleInput(
          scheduleId,
          { ...input, workspaceAuthority: authority },
          { expectedRevision: snapshot.revision, status: 'active' },
        );
      return;
    }
    await runtime.durable.engine.replaceScheduleInput(
      scheduleId,
      { ...input, authorityHold: binding.authorityHold ?? 'revoked' },
      { expectedRevision: snapshot.revision },
    );
  }

  async function pauseInvalidSchedules(): Promise<void> {
    if (workspace === undefined || runtime.durable === undefined) return;
    let offset = 0;
    for (;;) {
      const page = await runtime.durable.engine.listSchedules({ offset, limit: 100 });
      for (const schedule of page.items) await pauseInvalidSchedule(schedule.id);
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
  }

  async function pauseSchedule(
    scheduleId: string,
    guard?: ScheduleRevisionGuard,
  ): Promise<true | undefined> {
    const durable = runtime.durable;
    if (!durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    await transitionSchedule('schedule.paused', scheduleId, guard, (transition) =>
      durable.engine.pauseSchedule(scheduleId, transition),
    );
    return true;
  }

  async function resumeSchedule(
    scheduleId: string,
    guard?: ScheduleRevisionGuard,
  ): Promise<true | undefined> {
    const durable = runtime.durable;
    if (!durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    if (workspace === undefined) {
      await transitionSchedule('schedule.resumed', scheduleId, guard, (transition) =>
        durable.engine.resumeSchedule(scheduleId, transition),
      );
    } else {
      const snapshot = await durable.engine.getSchedule(scheduleId);
      const input = await readScheduledAgentInput(scheduleId);
      const authority = await validateRunWorkspaceAuthority(workspace, input?.workspaceAuthority);
      if (
        snapshot === null ||
        input === undefined ||
        authority === undefined ||
        !(await mayContinueScheduleSession(input.sessionId, authority.authorizingOwner)) ||
        !(await mayUseAutomationInput(
          input.input,
          runtime.mediaOptionsFor(authority.authorizingOwner, 'session').contentSourceResolver,
        ))
      ) {
        throw new BureauError('Workspace authority unavailable.', 'CONFLICT');
      }
      const { authorityHold: _hold, ...resumed } = input;
      await transitionSchedule('schedule.resumed', scheduleId, guard, (transition) =>
        durable.engine.replaceScheduleInput(scheduleId, resumed, {
          ...transition,
          expectedRevision: transition.expectedRevision ?? snapshot.revision,
          status: 'active',
        }),
      );
    }
    return true;
  }

  async function cancelSchedule(
    scheduleId: string,
    guard?: ScheduleRevisionGuard,
  ): Promise<true | undefined> {
    const durable = runtime.durable;
    if (!durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    await transitionSchedule('schedule.cancelled', scheduleId, guard, (transition) =>
      durable.engine.cancelSchedule(scheduleId, transition),
    );
    return true;
  }

  /**
   * COR-194 — commits a schedule transition with its pending record in the same storage write
   * (`schedule-transition-outbox.ts`), then records it. A transition Weft finds nothing to do for
   * (pausing a schedule that is not active, resuming an active one) writes nothing, the pending
   * record included, so it is neither recorded nor dispatched. A record that cannot be written
   * now stays pending for the boot pass, and the transition itself still succeeds: it committed.
   */
  async function transitionSchedule(
    kind: ScheduleTransitionKind,
    scheduleId: string,
    guard: ScheduleRevisionGuard | undefined,
    apply: (transition: import('@lostgradient/weft').ScheduleTransitionOptions) => Promise<void>,
  ): Promise<void> {
    const transition: PendingScheduleTransition = {
      kind,
      scheduleId,
      committedAtMs: runtimeServices.clock.now(),
    };
    const key = scheduleTransitionKey(
      transition,
      runtimeServices.identifiers.next('schedule-transition'),
    );
    await apply({
      ...scheduleTransitionOptions(guard),
      additionalOperations: [scheduleTransitionOperation(key, transition)],
    });
    // Everything after the commit is a failure to record, never a failure of the transition. The
    // schedule's whole pending queue is drained, so this transition is recorded behind any earlier
    // one still pending; when Weft wrote nothing, the queue holds nothing of this call's.
    try {
      await recordPendingScheduleTransitions(scheduleTransitionKeyPrefix(scheduleId));
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] Could not record ${kind} for schedule "${scheduleId}"; it stays pending for the next drain: ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  /**
   * COR-194 — records one pending schedule transition in durable history and the audit trail under
   * its own key as the dedupe key, removes the pending record, then dispatches the live event. A
   * write that fails rejects before the pending record is removed, so the transition is recorded
   * at a later attempt and, through the dedupe key, only once.
   */
  async function recordScheduleTransition(
    key: string,
    transition: PendingScheduleTransition,
  ): Promise<void> {
    // A scan's snapshot can be stale: another process's drain may have recorded and removed the
    // key since.
    if ((await runtime.durable!.engine.storage.get(key)) === null) return;
    const { kind, scheduleId, committedAtMs } = transition;
    const recordKind = transition.reassignment === undefined ? kind : 'schedule.reassigned';
    const detail = { scheduleId, ...transition.reassignment };
    await eventHistoryInstance?.record({ kind: 'schedule', id: scheduleId }, recordKind, detail, {
      dedupeKey: key,
      emittedAtMs: committedAtMs,
    });
    await auditTrailInstance?.record({
      runId: `${AUDIT_SCHEDULE_OWNER_PREFIX}${scheduleId}`,
      type: recordKind,
      detail,
      timestampMs: committedAtMs,
      dedupeKey: key,
    });
    await runtime.durable!.engine.storage.delete(key);
    const record = { dedupeKey: key, committedAtMs };
    try {
      emitter.dispatch(
        kind === 'schedule.paused'
          ? new SchedulePausedEvent(scheduleId, record)
          : kind === 'schedule.resumed'
            ? new ScheduleResumedEvent(scheduleId, record)
            : new ScheduleCancelledEvent(scheduleId, record),
      );
    } catch (error) {
      // A `bureau.toObservable()` subscriber has no isolation of its own (see `drainOutboxEntry`).
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] A bureau.toObservable() subscriber threw on ${kind} for schedule "${scheduleId}":`,
        cause: error,
      });
    }
  }

  /**
   * COR-194 — every drain this process runs, chained, so no two overlap: two drains of the same
   * schedule at once could record its transitions out of order, or one twice.
   */
  let scheduleTransitionDrains: Promise<void> = Promise.resolve();

  /**
   * COR-194 — records every schedule transition still pending under `prefix` (every schedule's,
   * or one schedule's for the live drain): one a process committed and did not live to record, one
   * whose record failed after its commit, or one just committed. Each schedule's transitions are
   * recorded in the order they committed, and a failure defers the rest of that schedule's to a
   * later pass, so its history is never written out of order. A record this build cannot read is
   * reported and kept, since a build that can may read it later.
   */
  function recordPendingScheduleTransitions(
    prefix: string = SCHEDULE_TRANSITION_KEY_PREFIX,
  ): Promise<void> {
    const drain = scheduleTransitionDrains.then(() => drainScheduleTransitions(prefix));
    // The chain carries on past a failed drain; the caller still sees the failure.
    scheduleTransitionDrains = drain.catch(() => undefined);
    return drain;
  }

  async function drainScheduleTransitions(prefix: string): Promise<void> {
    const durable = runtime.durable;
    if (!durable) return;
    const pending: Array<[string, Uint8Array]> = [];
    for await (const entry of durable.engine.storage.scan(prefix)) {
      pending.push(entry);
    }
    const deferredSchedules = new Set<string>();
    for (const [key, bytes] of pending) {
      const scheduleSegment = key.slice(SCHEDULE_TRANSITION_KEY_PREFIX.length).split(':')[0];
      if (deferredSchedules.has(scheduleSegment ?? '')) continue;
      const transition = decodeScheduleTransition(bytes);
      if (transition === undefined) {
        deferredSchedules.add(scheduleSegment ?? '');
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Left pending schedule transition "${key}" in place: this build cannot read it.`,
        });
        continue;
      }
      try {
        await recordScheduleTransition(key, transition);
      } catch (error) {
        deferredSchedules.add(scheduleSegment ?? '');
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Could not record pending ${transition.kind} for schedule "${transition.scheduleId}"; leaving it and the schedule's later transitions for the next drain: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
    }
  }

  /** What Weft's pause, resume, and cancel take for a guard: the revision, or nothing at all. */
  function scheduleTransitionOptions(
    guard: ScheduleRevisionGuard | undefined,
  ): { expectedRevision: number } | undefined {
    return guard?.expectedRevision === undefined
      ? undefined
      : { expectedRevision: guard.expectedRevision };
  }

  async function skipNextSchedule(
    scheduleId: string,
    guard?: ScheduleRevisionGuard,
    occurrence?: number,
  ): Promise<true | undefined> {
    if (!runtime.durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    await runtime.durable.engine.skipNextScheduleOccurrence(scheduleId, {
      ...scheduleTransitionOptions(guard),
      ...(occurrence === undefined ? {} : { occurrence }),
    });
    return true;
  }

  async function unskipSchedule(
    scheduleId: string,
    occurrence: number,
    guard?: ScheduleRevisionGuard,
  ): Promise<true | undefined> {
    if (!runtime.durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    await runtime.durable.engine.unskipScheduleOccurrence(scheduleId, {
      ...scheduleTransitionOptions(guard),
      occurrence,
    });
    return true;
  }

  async function runScheduleNow(
    scheduleId: string,
  ): Promise<import('@lostgradient/weft').ScheduleTriggerResult | undefined> {
    if (!runtime.durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    return runtime.durable.engine.triggerSchedule(scheduleId);
  }

  async function listScheduleMissed(
    scheduleId: string,
    read?: { readonly limit?: number | undefined },
  ): Promise<import('@lostgradient/weft').ScheduleMissedFire[] | null | undefined> {
    if (!runtime.durable) return undefined;
    return runtime.durable.engine.listScheduleMissedFires(
      scheduleId,
      read?.limit === undefined ? undefined : { limit: read.limit },
    );
  }

  async function updateSchedule(
    scheduleId: string,
    update: DurableScheduleUpdate,
    guard?: ScheduleRevisionGuard,
  ): Promise<true | undefined> {
    if (!runtime.durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    if (update.overlap !== undefined && update.overlap !== 'skip' && update.overlap !== 'allow') {
      throw new BureauError(
        `overlap policy '${String(update.overlap)}' is not supported by Bureau; only 'skip' and 'allow' are offered`,
        'BAD_REQUEST',
      );
    }
    const engine = runtime.durable.engine;
    if (update.continueChat === true && update.sessionId !== undefined) {
      throw new BureauError('"continueChat" and "sessionId" cannot both be given', 'BAD_REQUEST');
    }
    const changesRun =
      update.agentName !== undefined ||
      update.input !== undefined ||
      update.sessionId !== undefined ||
      update.continueChat === true;
    // The stored state is read for what an edit of the run needs (its input, the overlap and the
    // revision it was written at), and for the check that a recurring session is never combined
    // with overlapping fires.
    const bytes =
      changesRun || update.overlap === 'allow'
        ? await engine.storage.get(KEYS.schedule(scheduleId))
        : null;
    const stored: unknown = bytes ? decode(bytes) : undefined;
    const storedRecord =
      typeof stored === 'object' && stored !== null
        ? (stored as { input?: unknown; overlap?: unknown; revision?: unknown })
        : undefined;
    const storedInput = isScheduledAgentRunInput(storedRecord?.input)
      ? storedRecord.input
      : undefined;
    if (changesRun && storedInput === undefined) {
      throw new BureauError(`Schedule "${scheduleId}" does not exist`, 'NOT_FOUND');
    }
    const nextOverlap = update.overlap ?? storedRecord?.overlap;
    // A chat Bureau names itself is unguessable and not yet made (see `createSchedule`).
    const allocatedChat =
      update.continueChat === true ? runtimeServices.identifiers.next('session') : undefined;
    const nextSession =
      allocatedChat ??
      (update.sessionId === undefined ? storedInput?.sessionId : (update.sessionId ?? undefined));
    if (update.sessionId !== undefined && update.sessionId !== null) {
      const sessionId = update.sessionId.trim();
      rejectReservedIdentifier('"sessionId"', sessionId);
      if (unopenableNewSessionIdentifierReason('"sessionId"', sessionId)) {
        const held = await runtime.sessionStore?.load(sessionId);
        rejectUnopenableNewSessionIdentifier('"sessionId"', sessionId, held !== undefined);
      }
      // `changesRun` is true here, so the stored input was read and its principal is the owner.
      await refuseScheduleSessionOfAnotherOwner(sessionId, ownerOrLocal(storedInput?.principal));
    }
    // COR-323: a fire runs as its named agent and refuses a chat another agent began, so an
    // update that would leave the schedule's agent and its chat apart is refused now, not as an
    // `unavailable` at every fire after it.
    const nextAgent = update.agentName ?? storedInput?.agentName;
    if (allocatedChat === undefined && nextSession !== undefined && nextAgent !== undefined) {
      const held = await runtime.sessionStore?.load(nextSession);
      if (held !== undefined && held.agentName !== nextAgent) {
        throw new BureauError(
          `Schedule "${scheduleId}" would run agent "${nextAgent}" in a chat that belongs to agent "${held.agentName}". Start a new chat with the change, or keep the agent.`,
          'BAD_REQUEST',
        );
      }
    }
    if (nextOverlap === 'allow' && nextSession !== undefined) {
      // A recurring session is sequential: overlapping fires would interleave its turns, which is
      // why creating such a schedule refuses `allow` too.
      throw new BureauError(
        "overlap 'allow' is incompatible with a recurring session (fires must serialize)",
        'BAD_REQUEST',
      );
    }
    if (update.agentName !== undefined && agentCatalog.find(update.agentName) === undefined) {
      throw new UnknownScheduleAgentError(update.agentName);
    }
    if (update.input !== undefined && update.input.trim() === '') {
      throw new BureauError('"input" must be a non-empty string', 'BAD_REQUEST');
    }
    let nextInput: ScheduledAgentRunInput | undefined;
    if (changesRun && storedInput !== undefined) {
      const { sessionId: _kept, ...rest } = storedInput;
      nextInput = {
        ...rest,
        ...(update.agentName === undefined ? {} : { agentName: update.agentName }),
        ...(update.input === undefined
          ? {}
          : { input: replaceInputText(storedInput.input, update.input) }),
        ...(nextSession === undefined ? {} : { sessionId: nextSession }),
      };
    }
    // Whatever was read decided what this update may do (the input it rebuilds, and whether
    // `overlap` and a recurring chat may be combined), so the write is fenced to the revision that
    // was read when the caller named none: a change made since is refused, not overwritten. An
    // update of the overlap alone is fenced as well, or it could land on a chat another update gave
    // the schedule since, which leaves the combination that is refused above.
    const expectedRevision =
      guard?.expectedRevision ??
      (bytes !== null && typeof storedRecord?.revision === 'number'
        ? storedRecord.revision
        : undefined);
    await engine.updateSchedule(scheduleId, toScheduleSpec(update.spec), {
      ...(update.description === undefined ? {} : { description: update.description }),
      ...(update.overlap === undefined ? {} : { overlap: update.overlap }),
      ...(update.timeZone === undefined ? {} : { timeZone: update.timeZone }),
      ...(nextInput === undefined ? {} : { input: nextInput }),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
    return true;
  }

  /**
   * Every subsystem kind {@link BureauShutdownReport.owners} can report on.
   * `'heartbeat'` is reserved for the day Bureau composes one — see
   * `composedOwnerKinds` below, which decides which kinds actually get a row.
   */
  const ALL_SHUTDOWN_OWNER_KINDS = [
    'online-evals',
    'webhook-notifier',
    'audit-trail',
    'event-history',
    'assets',
    'durable-engine',
  ] as const;

  function shutdown(shutdownOptions?: BureauShutdownOptions): Promise<BureauShutdownReport> {
    // Idempotency guard: shutdown()/dispose() may be called more than once
    // (the harness does in tests, and `[Symbol.dispose]` may re-enter).
    // Disposing the engine and especially the raw Storage twice can close an
    // already-closed SQLite connection; a second call returns the first
    // call's already-cached report promise, ignoring whatever `policy` it
    // was given — the FIRST call's policy is what actually ran.
    if (shutdownPromise) return shutdownPromise;
    // COR-690: close run admission before anything below snapshots the active
    // runs or run toolboxes, so nothing admitted afterwards escapes the drain.
    runAdmissionClosed = true;
    sessionInputClosing.resolve();

    const policy: 'abort' | 'drain' | 'detach' = shutdownOptions?.policy ?? 'abort';
    const timeoutMilliseconds = shutdownOptions?.timeoutMilliseconds;
    // Capture the durable runs left for recovery at admission close: every one under 'detach',
    // and under 'abort' the ones this process recovered rather than started. The report
    // must count the same run identities that are still active when teardown
    // settles, not a stale size snapshot: a run may complete while shutdown
    // is waiting for workflow/toolbox/owner cleanup.
    const detachedRuns = new Set<ActiveRun>(
      runtime.durable && policy !== 'drain'
        ? [...activeRuns].filter((run) => policy === 'detach' || recoveredActiveRuns.has(run))
        : [],
    );

    // COR-1527: stop reacting to the workflow files at once, so nothing registers with an engine
    // that is about to be disposed; the chain below waits for the apply in progress first.
    const workflowClosed = workflowRuntime?.close();

    // Which owners this bureau actually composes — a report row is emitted
    // ONLY for a composed owner (2026-09-02 coordinator ruling).
    const composedOwnerKinds = ALL_SHUTDOWN_OWNER_KINDS.filter((kind) => {
      if (kind === 'online-evals') return Boolean(scorerSamplerInstance);
      if (kind === 'webhook-notifier') return Boolean(webhookNotifierInstance);
      if (kind === 'audit-trail') return Boolean(auditTrailInstance);
      if (kind === 'event-history') return Boolean(eventHistoryInstance);
      if (kind === 'assets') return Boolean(assetServiceInstance);
      return Boolean(runtime.durable);
    });
    const ownerOutcomes = new Map<
      (typeof ALL_SHUTDOWN_OWNER_KINDS)[number],
      CleanupAcknowledgement
    >();

    function buildReport(): BureauShutdownReport {
      const owners: BureauShutdownOwnerReport[] = composedOwnerKinds.map((kind) => ({
        kind,
        outcome: ownerOutcomes.get(kind) ?? 'unresolved',
      }));
      // A `.filter().length` per outcome (armorer's own `ExecutionCleanupReport`
      // shape) rather than one accumulating loop: every predicate runs for
      // every owner regardless of count, so `notRequired` reads as covered
      // even on a run with zero `'not-required'` owners today (the union
      // member is reserved per the shared vocabulary; no Bureau owner
      // currently produces it).
      return Object.freeze({
        admissionClosed: true,
        policy,
        detached: [...detachedRuns].filter((run) => activeRuns.has(run)).length,
        requested: owners.length,
        completed: owners.filter((owner) => owner.outcome === 'completed').length,
        failed: owners.filter((owner) => owner.outcome === 'failed').length,
        unresolved: owners.filter((owner) => owner.outcome === 'unresolved').length,
        notRequired: owners.filter((owner) => owner.outcome === 'not-required').length,
        owners: Object.freeze(owners),
      });
    }

    // Awaits `run()`, recording its outcome ('completed'/'failed') into
    // `ownerOutcomes`. Never throws — a rejecting owner drain is diagnosed
    // and recorded, not propagated, so one failing owner cannot skip the
    // unconditional backend teardown below (same isolation the pre-AB-207
    // `dispose()` already gave catalog-run `abort()` failures).
    async function settleOwner(
      kind: (typeof ALL_SHUTDOWN_OWNER_KINDS)[number],
      run: () => Promise<unknown>,
    ): Promise<void> {
      try {
        await run();
        ownerOutcomes.set(kind, 'completed');
      } catch (error) {
        ownerOutcomes.set(kind, 'failed');
        diagnose({
          level: 'error',
          scope: 'shutdown',
          message: `[bureau] Error during ${kind} shutdown: ${serializeUnknownError(error)}`,
        });
      }
    }

    // Resolves once every run in `terminals` has reached a terminal event,
    // or once `ABORTED_RUN_TERMINAL_GRACE_MILLISECONDS` has passed, whichever
    // comes first. The timer is cleared either way so it never outlives the
    // wait.
    async function awaitAbortedRunTerminals(terminals: Array<Promise<void>>): Promise<void> {
      if (terminals.length === 0) return;
      let graceTimer: RuntimeTimeoutHandle;
      const grace = new Promise<void>((resolve) => {
        graceTimer = runtimeServices.timers.setTimeout(
          resolve,
          ABORTED_RUN_TERMINAL_GRACE_MILLISECONDS,
        );
      });
      try {
        await Promise.race([Promise.all(terminals), grace]);
      } finally {
        runtimeServices.timers.clearTimeout(graceTimer);
      }
    }

    const chain = (async (): Promise<BureauShutdownReport> => {
      // COR-1527: a change being applied to the engine finishes while the engine is still there,
      // and nothing is applied after this, so the disposal below cannot race it.
      await workflowClosed;
      // Stop admission before touching runs. The canonical toolbox is the
      // owner of local execution lifecycle; await its shutdown as the
      // quiescence fence before releasing durable resources.
      runtime.baseToolbox.closeAdmission();
      for (const toolbox of runToolboxes) toolbox.closeAdmission();

      const runTerminals: Array<Promise<unknown>> = [];
      // Terminal events of the runs 'abort' aborts. Awaited, under a bound,
      // before the session-persistence drain below — see that await.
      const abortedRunTerminals: Array<Promise<void>> = [];
      // COR-1630 — the results of the catalog runs 'abort' aborts: each handle settling is what
      // starts that run's asset release, so the release is known only after it.
      const abortedCatalogRunResults: Array<Promise<void>> = [];
      const abortActiveRuns = policy === 'abort' || (policy === 'detach' && !runtime.durable);
      const abortCatalogRuns = policy === 'abort' || policy === 'detach';
      if (abortActiveRuns) {
        // Deliberately NOT awaited here (or anywhere gating the
        // unconditional engine/storage teardown below): a caller-owned
        // `ActiveRun` whose underlying provider call never honors its
        // `AbortSignal` (a hung dependency, not a well-behaved one) must
        // never be able to wedge the WHOLE shutdown chain open forever —
        // the critical backend teardown has to stay reachable regardless
        // of whether any individual run ever actually settles. A
        // well-behaved run's `abort()` drops its provider connection
        // immediately (see `active-run-adapter.ts`'s `abort()` doc), so its
        // terminal event — and any audit-trail/webhook-notifier write it
        // triggers — has ample opportunity to land during the real async
        // work the toolbox-shutdown await below already does, well before
        // the owner drains further down snapshot each subsystem's in-flight
        // writes.
        //
        // Each run's terminal listener is registered BEFORE its `abort()`,
        // which may dispatch `run.aborted` synchronously, and a member of
        // `activeRuns` has not dispatched a terminal event yet (its own
        // terminal listeners remove it first), as `whenActiveRunTerminal`
        // requires.
        for (const activeRun of activeRuns) {
          // A run this process recovered is left running for the next one, as under 'detach'.
          if (runtime.durable && recoveredActiveRuns.has(activeRun)) continue;
          abortedRunTerminals.push(whenActiveRunTerminal(activeRun));
          runsStoppedByShutdown.add(activeRun);
          activeRun.abort('Bureau disposed');
        }
        // A run that already reported its error is over; it is not aborted, only waited for
        // under the same bound, so its terminal session save starts before the engine goes.
        for (const erroredRun of erroredActiveRuns) {
          abortedRunTerminals.push(whenErroredRunEnds(erroredRun));
        }
        // AB-22 review fix: `bureau.run(...)` dispatches are tracked
        // separately (see `trackCatalogRun`) since a catalog `RunnableAgent`'s
        // returned handle is not necessarily backed by a bureau-owned
        // `ActiveRun` — its `abort()` can be arbitrary, untrusted code.
        // Snapshot before iterating (a synchronous catalog agent can settle
        // result() immediately from inside abort(), whose trackCatalogRun
        // cleanup deletes from catalogRuns mid-iteration), and isolate each
        // call: an in-flight custom handle throwing from abort() must not
        // reject this entire shutdown() before the unconditional teardown
        // below runs — that would skip toolbox shutdown, durable-engine
        // disposal, and storage closure, and since shutdownPromise is
        // already cached at this point, every subsequent shutdown()/dispose()
        // call would return the same rejection forever instead of ever
        // completing cleanup (review round 2, Codex).
      } else {
        // 'drain' waits caller-owned runs; 'detach' leaves durable caller-owned runs for recovery.
        for (const activeRun of activeRuns) {
          if (policy === 'drain') runTerminals.push(whenActiveRunTerminal(activeRun));
        }
        for (const erroredRun of erroredActiveRuns) {
          runTerminals.push(whenErroredRunEnds(erroredRun));
        }
      }
      if (abortCatalogRuns) {
        const currentCatalogRuns = [...catalogRuns];
        for (const catalogRun of currentCatalogRuns) {
          try {
            abortedCatalogRunResults.push(
              Promise.allSettled([catalogRun.result()]).then(() => undefined),
            );
          } catch {
            // A custom handle whose result() throws has no result to wait for; its abort() below
            // is still called, and its release, if any, is not waited for.
          }
        }
        for (const catalogRun of currentCatalogRuns) {
          try {
            catalogRun.abort('Bureau disposed');
          } catch (error) {
            diagnose({
              level: 'error',
              scope: 'shutdown',
              message: `[bureau] A catalog run's abort() threw during disposal; continuing teardown: ${serializeUnknownError(error)}`,
            });
          }
        }
      } else {
        // Catalog runs are caller-owned too, but unlike durable ActiveRuns they have no recovery
        // record, so detach retains the existing abort behavior for them.
        const currentCatalogRuns = [...catalogRuns];
        for (const catalogRun of currentCatalogRuns) {
          runTerminals.push(Promise.allSettled([catalogRun.result()]));
        }
      }
      const toolboxes = [
        ...new Set([runtime.baseToolbox, ...runToolboxes, ...runToolboxesByRunId.values()]),
      ];
      const toolboxPolicy = policy === 'detach' ? 'abort' : policy;
      const toolboxShutdownResults = await Promise.allSettled([
        ...toolboxes.map((toolbox) =>
          toolbox.shutdown({ policy: toolboxPolicy, reason: 'Bureau disposed' }),
        ),
        ...runTerminals,
      ]);
      for (const result of toolboxShutdownResults) {
        if (result.status === 'rejected') {
          diagnose({
            level: 'error',
            scope: 'shutdown',
            message: `[bureau] Error during toolbox shutdown: ${serializeUnknownError(result.reason)}`,
          });
        }
      }

      // COR-1476 — every run's session input is released: the leases go back to
      // the mailbox and the unpromoted claims are dropped, so the next boot
      // delivers them. Shutdown only releases; it never starts a run.
      for (const [runId, { sessionId }] of sessionInputGates) {
        await releaseSessionInputs(sessionId, runId);
      }

      // AB-363: stop the automatic-profile run-ownership pruning timer, if
      // one was started — `clearInterval` alone only cancels FUTURE ticks,
      // so a pass already in flight is also awaited here, before the
      // `eventHistoryInstance`/storage disposal further down this same
      // shutdown runs — otherwise that disposal could race an in-flight
      // pass still replaying the feed or mid-`sessionStore.update()`
      // (Codex review, PR #579, "Await running pruning passes before
      // backend teardown"). `pruneStaleRunOwnership()`'s own promise chain
      // already `.catch()`es every failure before this point, so awaiting
      // it here never throws.
      //
      // AB-389 (Codex P1 review finding, PR #598, "Await the chained drain
      // before aborting its producers"): this await MUST happen BEFORE
      // `backgroundShutdownController.abort()` below, not after — the pass
      // this awaits chains `drainOutbox()` onto `pruneStaleRunOwnership()`
      // (see the interval callback's own doc comment), and every session
      // lifecycle listener `createDurableEventProducer` registers checks
      // `signal?.aborted` and returns immediately once that shared signal
      // is aborted, recording nothing. Aborting first would let a pass
      // already inside `pruneStaleRunOwnership()` run its chained drain
      // AFTER the abort, dispatching outbox entries whose durable writes
      // never start — `wasRecorded` still leaves those entries pending for
      // a later drain (the safety net a redelivery relies on generally),
      // but there is no reason to manufacture that residual here when
      // simply awaiting first avoids it entirely.
      //
      // AB-388 (Codex review, PR #597, "Fence maintenance admission once
      // shutdown starts"): closed HERE, synchronously, before anything
      // below this line awaits — see `maintenanceAdmissionClosed`'s own
      // doc comment for why the ordering matters.
      maintenanceAdmissionClosed = true;
      // COR-772 — land every child-settlement write the run teardown above
      // produced before the audit trail and storage below go away. Only
      // writes already under way are awaited here, not a child's own result.
      // The bounded wait on child results for 'abort' shutdown comes below, so
      // a child that ignores its abort costs at most that bound.
      await childTopology.drain();
      // COR-851 — land every goal signal already being sent. A goal interrupted
      // by shutdown is deliberately left non-terminal for the next process.
      await goalsComposition.drain();
      // Land terminal session saves already under way before the outbox
      // drain await and `backgroundShutdownController.abort()` below: a save
      // committing after that abort leaves its `session.saved` entry
      // unrecorded. Its commit triggers the drain synchronously, so the
      // `outboxDrainInFlight` await then covers it. See `drain()` for why
      // this cannot wedge on a run; `timeoutMilliseconds` bounds a hung store.
      //
      // An aborted run's save starts later than that: its `run.aborted`
      // listener runs only once the run has unwound, which is usually after
      // the waits above have passed. So first give the runs 'abort' aborted
      // a bounded chance to reach their terminal event — each one's save
      // has started by the time it resolves, because its own terminal
      // listener was registered first — and a run that never honors its
      // abort only costs this bound, never a wedged shutdown.
      await awaitAbortedRunTerminals(abortedRunTerminals);
      // A child aborted by this shutdown records its `aborted` settlement only
      // once its own result arrives, which a durable child's fenced
      // cancellation makes later than the drain above looked. Wait for it,
      // under the same bound, so the audit trail is still open to take it. 'detach' aborts
      // children as 'abort' does, so it waits for them too.
      if (abortCatalogRuns && childTopology.awaitingSettlements() > 0) {
        await awaitAbortedRunTerminals([childTopology.settlementsKnown()]);
      }
      await childTopology.drain();
      await sessionPersistence.drain();
      await drainSessionInputSettlements();
      // COR-1630 — a catalog run that ended releases its asset claims, shutdown or not. The
      // aborted runs settle first, under the grace above, which starts their releases. A release
      // is storage work on a run that has ended, so it is awaited however long the database takes,
      // not under that grace: a release the grace cut short wrote against the asset service and the
      // pool after they closed below. Releases close in the step that finds none left
      // (`createCatalogAssetReleaseDrain`). A run whose durable record still reads in flight is
      // lost, not ended, and releases nothing (`catalog-run-asset-release.ts`).
      await awaitAbortedRunTerminals(abortedCatalogRunResults);
      await catalogAssetReleases.drain();
      if (automaticRunOwnershipPruneTimerStarted) {
        runtimeServices.timers.clearInterval(automaticRunOwnershipPruneTimer);
        automaticRunOwnershipPruneTimerStarted = false;
      }
      // COR-1622: the expiry sweep's own timer, and a pass still under way.
      stopLazyExpirySweep();
      await lazyExpirySweepPass;
      // AB-390 — the session-outbox retry timer (armed when this bureau
      // last lost a claim to a still-live peer) must not fire after
      // shutdown: a retry drain running post-teardown would race the very
      // cleanup this shutdown sequence exists to make orderly.
      if (outboxRetryTimerArmedForMs !== undefined) {
        runtimeServices.timers.clearTimeout(outboxRetryTimerHandle);
        outboxRetryTimerArmedForMs = undefined;
      }
      // Codex P2 review finding, PR #599, "Await retry drains that have
      // already fired during shutdown": `clearTimeout` above only prevents
      // a NOT-YET-FIRED retry timer from firing — it cannot un-fire one
      // whose callback already started (armed, then fired, in the window
      // before this shutdown sequence reached this line) and is still
      // running its own `drainOutbox()` call. Without this await,
      // shutdown would proceed to abort producers and dispose durable
      // event history storage while that drain is still dispatching
      // events or reading/writing storage concurrently with teardown.
      if (outboxDrainInFlight) {
        await outboxDrainInFlight;
      }
      if (automaticRunOwnershipPruneCurrentPass) {
        await automaticRunOwnershipPruneCurrentPass;
      }
      if (taskResyncBootPass) await taskResyncBootPass;
      // COR-1946: no further lease renewals or sweeps; the lease itself is removed last.
      processLease.halt();
      await abandonedTaskSweeper.close();
      // AB-388: drain any manual `maintain()` call(s) still in
      // flight — see `manualDurableMaintenancePasses`'s own doc comment
      // above. `allSettled` (never `all`): a rejection here is either
      // already diagnosed by the pass's own sub-pass try/catch, or is a
      // re-thrown `engineMaintenanceError` the ORIGINAL caller of
      // `maintain()` observes directly — `shutdown()` must
      // still complete backend teardown either way. Drained in the SAME
      // place, and for the SAME reason, as the automatic pass's own await
      // just above: both must settle before the shared signal aborts and
      // before backend teardown below.
      if (manualDurableMaintenancePasses.size > 0) {
        await Promise.allSettled(manualDurableMaintenancePasses);
      }
      // Bureau-owned background work is stopped/awaited identically under
      // BOTH policies (2026-09-02 coordinator ruling) — abort the shared
      // signal now, AFTER runs are aborted/drained, toolbox shutdown is
      // awaited above, and the pruning/outbox pass above has settled, so
      // an in-flight judge invocation / webhook delivery settles promptly
      // against the owner drains immediately below rather than being told
      // to abort before shutdown has even started (which would make the
      // audit trail's `if (signal?.aborted) return` above drop the very
      // `run.aborted`/`tool.*` records this shutdown produces).
      backgroundShutdownController.abort();

      // All pre-teardown is BEST-EFFORT, and the whole body is under an OUTER
      // try/finally so the critical backend teardown (engine → storage → store)
      // ALWAYS runs. The synchronous steps below are fallible —
      // `emitter.dispatch`/`emitter.complete` route through
      // `CompletableEventTarget.dispatchEvent`, which loops over `toObservable()`
      // subscribers WITHOUT a try/catch, so a subscriber whose `next`/`complete`
      // throws propagates straight back here. That path is reachable through the
      // public Bureau surface (`toObservable()`), so the synchronous pre-teardown
      // is wrapped to swallow-and-log: a throwing subscriber must not strand the
      // SQLite/LMDB handle behind the now-`true` `disposed` guard (a second
      // dispose no-ops), leaking it permanently. Covered by the
      // "toObservable subscriber throws during dispose" regression test.
      try {
        // `runtime.memory.close()` stays a detached best-effort call — it is
        // not one of the owners this issue's report covers (2026-09-02
        // ruling: scheduler, online-evals, webhook notifier, audit trail,
        // durable engine).
        if (runtime.memory) {
          detachBestEffortPromise(runtime.memory.close());
        }

        try {
          // Dispose every Bureau-owned background subsystem — AWAITED, not
          // detached (AB-207/AB-37): each is a report-tracked owner drain,
          // run concurrently, before emitting bureau.disposed so any
          // in-flight write/delivery/evaluation callback is unsubscribed
          // cleanly (the webhook notifier also abandons in-flight backoff
          // waits so a disposed bureau never fires a webhook late).
          const ownerDrains: Array<Promise<void>> = [];
          if (auditTrailInstance) {
            const auditTrail = auditTrailInstance;
            ownerDrains.push(settleOwner('audit-trail', () => auditTrail.dispose()));
          }
          if (eventHistoryInstance) {
            const eventHistory = eventHistoryInstance;
            const durableEventProducer = durableEventProducerInstance;
            ownerDrains.push(
              settleOwner('event-history', async () => {
                // The producer (its bureau-event listeners) is disposed
                // BEFORE the store it writes into, so no in-flight
                // `record()` call can start against an already-disposed
                // `FleetEventFeed` (AB-311).
                // The follower's subscription ends before the feed it reads is released.
                await fireReviewFollower?.dispose();
                if (durableEventProducer) await durableEventProducer.dispose();
                await eventHistory.dispose();
              }),
            );
          }
          if (webhookNotifierInstance) {
            const webhookNotifier = webhookNotifierInstance;
            ownerDrains.push(settleOwner('webhook-notifier', () => webhookNotifier.dispose()));
          }
          if (scorerSamplerInstance) {
            const scorerSampler = scorerSamplerInstance;
            ownerDrains.push(settleOwner('online-evals', () => scorerSampler.dispose()));
          }
          if (assetServiceInstance) {
            // COR-794: aborts every in-flight asset operation and awaits each
            // one's cleanup acknowledgement, and clears the collection timer.
            const assetService = assetServiceInstance;
            ownerDrains.push(
              settleOwner('assets', async () => {
                const report = await assetService.shutdown();
                // A work handle whose cleanup did not complete fails the owner, not just its report.
                const unclean = report.acknowledgements.filter(
                  ({ acknowledgement }) => acknowledgement.status !== 'completed',
                );
                if (unclean.length > 0) {
                  throw new Error(
                    `Asset work did not clean up: ${unclean.map(({ workId }) => workId).join(', ')}`,
                  );
                }
              }),
            );
          }
          await Promise.allSettled(ownerDrains);
          // COR-1481 — the settlement and cleanup writes of tasks whose runs have just ended land
          // before the storage they write to is closed.
          await tasks.flush();
          // COR-1631 — so do the freezes of the surfaces those settlements started.
          await surfaces?.flush();
          // COR-1941 — so do the notifications those settlements wrote.
          await notificationsComposition.drain();

          for (const stop of stopForwarding) stop();
          emitter.dispatch(new BureauDisposedEvent());
          storeSubscription.unsubscribe();
          // After `BureauDisposedEvent` is dispatched, so the feed records
          // its own last event before it stops recording. Unsubscribing
          // first, then disposing, ends every watcher: disposal aborts the
          // feed's lifetime signal, which each subscription is bound to.
          eventFeedSubscription.unsubscribe();
          notificationsComposition.stop();
          // Any run feed still registered goes with it — `run.removed` reaps
          // the runs a host deleted, and this covers the rest.
          for (const feedRunId of runEventFeeds.runIds()) {
            disposeRunEventFeed(feedRunId, runEventFeeds);
          }
          eventFeed.dispose();
          emitter.complete();
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'shutdown',
            message: `[bureau] Error during shutdown pre-teardown: ${serializeUnknownError(error)}`,
          });
        }
      } finally {
        // The per-run `resolveWorkflowServices` resolver is engine-scoped and is
        // released when the engine is disposed below — there is no module-global
        // reconstructor to clear here anymore.
        //
        // Dispose the durable run engine, then fence off the raw Storage, then the
        // store — each guarded so a throw in one stage does not skip the next (engine
        // dispose is synchronous and can throw in a degraded environment). The raw
        // Storage is the caller's: Bureau stops using it but never closes it, so the
        // caller closes it after this shutdown returns.
        try {
          // Observability dispose runs BEFORE engine dispose: it ends still-open
          // spans and unsubscribes the engine lifecycle listeners. If the engine
          // were disposed first, those listeners would already be gone, so the spans
          // they would have closed in response to the engine's terminal-disposal
          // events would leak instead. Best-effort — a throw here must not skip the
          // backend teardown below.
          try {
            runtime.durable?.observability?.dispose();
          } catch (error) {
            diagnose({
              level: 'error',
              scope: 'shutdown',
              message: `[bureau] Error disposing durable observability: ${serializeUnknownError(error)}`,
            });
          }
          // AB-207: prefer the async disposal path (`[Symbol.asyncDispose]`)
          // over the synchronous one — `RegistryAgnosticEngine` always
          // implements both `Disposable` and `AsyncDisposable`, so this
          // await genuinely observes the engine's own drain rather than
          // firing a sync teardown and moving on.
          // Steering admissions already queued read the engine's run
          // liveness, so they finish before it is disposed; admission closed
          // with `runAdmissionClosed`. Run-boundary appends queued while the
          // engine drains are awaited again below, before the backend closes.
          // The steering pollers stop first, so none queues a fold after it.
          for (const poller of steeringPollers.values()) {
            runtimeServices.timers.clearInterval(poller.timer);
          }
          steeringPollers.clear();
          // COR-1476 — session-input admissions in flight read the engine and
          // the log the same way, and are closed with `runAdmissionClosed` too.
          await Promise.allSettled([
            ...inFlightSteeringSubmissions,
            ...inFlightSessionInputAdmissions.values(),
            ...inFlightSteeringPolls,
            ...steeringQueues.values(),
          ]);
          if (runtime.durable) {
            const engine = runtime.durable.engine;
            await settleOwner('durable-engine', () => engine[Symbol.asyncDispose]());
          }
          // COR-1481 — disposing the engine is what ends a durable run that was still in flight,
          // and each run's `closed()` acknowledgement lands as it does. The cleanup the registry
          // follows is awaited, with the writes it starts, before the backend closes under them.
          // A run whose end is known after this records nothing (COR-2005): the tracker is closed.
          await catalogSettlements.settled();
          await tasks.idle();
          // COR-1631 — those settlements freeze their tasks' surfaces too; the freezes land
          // before the backend closes under them.
          await surfaces?.flush();
        } finally {
          // COR-2005 — `settled()` closed the tracker when it ran; this covers a drain that threw
          // before it did. A run that ends from here on records nothing: the storage is going away.
          catalogSettlements.close();
          // A run that ended in the drain without a save leaves no one to settle its record.
          for (const runId of terminalSessionRecordSettlers.keys()) {
            abandonTerminalSessionRecord(runId);
          }
          try {
            // Pending steering log appends (run-boundary events are logged
            // in the background) finish before the backend closes under
            // them. Each one reports its own failure as a diagnostic.
            await steeringSweep;
            await Promise.allSettled(steeringQueues.values());
            steeringQueues.clear();
            steeringCursors.clear();
          } finally {
            try {
              // An agent-directory scan in flight records file revisions in storage, so the
              // watcher stops and drains before storage closes under it (COR-1669).
              await fileAgents?.files.close();
            } finally {
              // COR-1946: removed after every task write of this shutdown, so a peer need not wait
              // for it to lapse; a failure only means the peer waits.
              await processLease.release().catch((error: unknown) => {
                diagnose({
                  level: 'error',
                  scope: 'shutdown',
                  message: `[bureau] Could not remove the process lease: ${serializeUnknownError(error)}`,
                  cause: error,
                });
              });
              try {
                // Bureau stops using the caller's storage, which the caller closes (COR-1767).
                runtime.stopUsingStorage();
              } finally {
                if (ownsStore) {
                  store.dispose();
                }
              }
            }
          }
        }
      }
      // COR-1524: stop watching the agent directory and wait for a scan in flight.
      await fileAgents?.files.close();
      return buildReport();
    })();

    // `shutdown()` is documented to never reject — every internal step above
    // is already best-effort (`settleOwner` catches and records failures),
    // but some unforeseen failure inside `chain` or the timeout sleep must not propagate through
    // `Promise.race`/the bare chain reference. This `.catch` is the single
    // fallback fence: diagnose, then resolve with the best-effort report
    // `buildReport()` can still produce from whatever `ownerOutcomes` were
    // recorded before the failure (review finding, PR #442).
    function settleNeverRejecting(
      promise: Promise<BureauShutdownReport>,
    ): Promise<BureauShutdownReport> {
      return promise.catch((error: unknown) => {
        diagnose({
          level: 'error',
          scope: 'shutdown',
          message: `[bureau] shutdown() settled via an unexpected rejection, falling back to a best-effort report: ${serializeUnknownError(error)}`,
        });
        return buildReport();
      });
    }

    if (timeoutMilliseconds === undefined) {
      detachBestEffortPromise(chain);
      shutdownPromise = settleNeverRejecting(chain);
    } else {
      // Aborted once `chain` itself settles (by either winning the race or
      // losing it) so the timer never outlives this call — a `shutdown()`
      // whose real teardown finishes well inside `timeoutMilliseconds` must
      // not hold a live `setTimeout` open for the remainder of that budget.
      // `detachBestEffortPromise`, not a bare `void`, on the SAME derived
      // `.finally()` promise this covers both: an unhandled rejection from
      // `chain` and the timer-abort side effect.
      const timeoutAbort = new AbortController();
      detachBestEffortPromise(chain.finally(() => timeoutAbort.abort()));
      shutdownPromise = settleNeverRejecting(
        Promise.race([
          chain,
          shutdownTimeoutSleep(timeoutMilliseconds, timeoutAbort.signal).then(() => buildReport()),
        ]),
      );
    }

    return shutdownPromise;
  }

  // Cached separately from `shutdownPromise`: `dispose()` must keep returning
  // the SAME promise reference on repeat calls (no externally observable
  // regression vs. the pre-AB-207 caller-visible contract) — `shutdown()`'s
  // own idempotency guard caches its own report promise, but each call to
  // `.then(() => undefined)` below would otherwise mint a new derived
  // promise every time.
  let disposePromise: Promise<void> | undefined;

  function dispose(): Promise<void> {
    if (!disposePromise) {
      disposePromise = shutdown({ policy: 'abort' }).then(() => undefined);
    }
    return disposePromise;
  }

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

  /**
   * COR-1302: registers the `ActiveRun` behind a `bureau.run()` dispatch on
   * `store` while it runs, so `getRun(run.id)`, `abortRun(run.id)`, and
   * `subscribeRunSnapshot` resolve the handle's id on both the direct and the
   * durable branch.
   * Before this runs, and for a catalog run that never builds an `ActiveRun`,
   * `getRun`/`abortRun` fall back to the unsettled handle (`findCatalogRun`).
   *
   * The run keeps everything else a catalog run had: no bureau session (its
   * session id reads `''`), no `activeRuns` entry (`catalogRuns` still drives
   * its shutdown), no listing, and no fan-out: its actions and its
   * registration and release stay off this bureau's event streams (see
   * `catalogRunIds` and the store subscription), so online evals, webhooks,
   * the audit trail, and durable event history see the runs they saw before.
   * Unlike a `createRun` run, it leaves `store` on its own once it settles;
   * see the release below.
   *
   * Its run event feed is attached before `store.register`, as
   * `createRunFromRequest` attaches one, and is disposed with the rest of the
   * run's per-run state when the run is released.
   *
   * A run recovered after a restart is not registered here: AB-240's recovery
   * path still hands it to the headless monitor in `onRecoveredWorkflow`.
   */
  function registerCatalogRun(activeRun: ActiveRun): void {
    const runId = activeRun.runId;
    if (store.getRun(runId)) return;
    catalogRunIds.add(runId);
    const detachRunEventFeed = attachRunEventFeed(runId, activeRun, runEventFeeds, {
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
    store.register(activeRun, runId);
    // Released once the run settles, as AB-22 releases its `catalogRuns`
    // entry, so a long-lived bureau does not keep one store entry per
    // historical `bureau.run()`. `removeRun`, not `deleteRun`: the run's
    // attribution stays, so `eventHistory`'s principal gate still resolves the
    // settled run for its owner (AB-241). Keyed to `result`, not `closed()`:
    // asking for `closed()` before the run settles would cost the handle's own
    // `closed()` its `not-required` fast path (AB-204). Registered here, ahead
    // of anything the returned handle chains onto `result`, so a caller that
    // has awaited `run.result()` already finds the run released.
    detachBestEffortPromise(
      activeRun.result.finally(() => {
        detachRunEventFeed();
        runHumanWaits.forget(runId);
        if (store.getRun(runId)?.activeRun === activeRun) store.removeRun(runId);
      }),
    );
  }

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

  /**
   * COR-1596 — registers a schedule fire's human waits and tool approvals as pending reviews,
   * live and recovered alike: the composition builds a fire's services the same way for a tick
   * and for a recovery, and hands them here before the fire takes a step.
   *
   * The human waits go through `runHumanWaits.attach`, the registration a recovered
   * `bureau.run()` run uses: neither has an `ActiveRun` on the store, and both are heard through
   * the emitter `attach` gives their services. The approvals go through the hook above.
   */
  async function registerScheduledFireReviews(
    fire: ScheduledFireServicesNotice,
    services: DurableRunDeps,
  ): Promise<void> {
    await runHumanWaits.attach(
      fire.runId,
      {
        agentName: fire.agentName,
        sessionId: fire.sessionId,
        announce: (reviewId, signalName) => {
          detachBestEffortPromise(
            announceFireReview(fire.runId, reviewId, 'human-wait', { signalName }).then(() =>
              tasks.announceChanged(fire.runId),
            ),
          );
        },
      },
      services,
    );
    // COR-1621: a park the fire's checkpoint restored is a review held here, which a peer can
    // answer.
    if (runHumanWaits.holds(fire.runId)) followFireReviews(fire.runId);
    // A fire's hook registry is built by `buildScheduledRunServices`; one that is missing would
    // leave the fire's approvals unlisted, so it is refused loudly, and the composition
    // diagnoses it.
    const hooks = services.options.hooks;
    if (hooks === undefined) {
      throw new Error(`Schedule fire "${fire.runId}" has no hook registry to list its approvals.`);
    }
    // COR-2298 — what the fire gives its tool calls, kept for the approved call that resumes later,
    // as a session run's is. Stored only once the fire holds an approval, so it is released with the
    // fire's other approval state (`endScheduledFireWhenNoApprovalRemains`).
    const fireScope = runScopedExecutionContextOf(services.options);
    // Registered after the merge `registerTrailingOnStep` documents avoiding (COR-1265), and
    // that is sound here: a fire's registry holds the Bureau's tier alone, so the merge's tier
    // offset is zero and the raw trailing priority lands exactly where a registration before the
    // merge would have put it. The hook only records in memory, so it needs no order against the
    // session write-back, which records the same approval durably.
    registerTrailingOnStep(
      hooks,
      'bureau:scheduled-fire-approvals',
      createScheduledFireApprovalHook(fire.runId, async (reviewId, approval, stepWasFinal) => {
        // A review the session records as decided stays decided across a replay that makes the
        // same call again (a decision made before the step committed): it is not listed.
        const session = await runtime.sessionStore?.load(fire.sessionId);
        const decided = session?.metadata['resolvedReviewIds'];
        if (Array.isArray(decided) && decided.includes(reviewId)) return;
        if (fireScope !== undefined) runScopedContexts.set(fire.runId, fireScope);
        registerScheduledFireApproval(
          scheduledFireReviewState,
          fire,
          services.toolbox,
          reviewId,
          approval,
          stepWasFinal,
        );
        await announceFireReview(fire.runId, reviewId, 'tool-approval', {
          callId: approval.callId,
        });
        detachBestEffortPromise(tasks.announceChanged(fire.runId));
      }),
    );
  }

  /**
   * COR-1868 — admits the task of a child run, a goal attempt or a workflow step, from its claim.
   * Called once the run's start has committed, so no task is ever listed for a run that did not
   * exist. A second admission (a continued claim, a re-run activity) is a no-op: the record is
   * written once.
   */
  async function admitSubordinateTask(run: SubordinateRun): Promise<void> {
    let claim: SubordinateClaim;
    if (run.local !== undefined) {
      claim = {
        agentName: run.agentName,
        principal: run.local.principal,
        input: run.local.input,
        taskOrigin: run.local.taskOrigin,
      };
    } else {
      const loaded = await runtime.loadCatalogRunRecoveryRecord(run.runId);
      if (loaded.status !== 'found' || loaded.record.taskOrigin === undefined) return;
      claim = { ...loaded.record, taskOrigin: loaded.record.taskOrigin };
    }
    await tasks.recordAdmission(
      subordinateTaskAdmission(run.runId, claim, {
        ownerOf: ownerOrLocal,
        originatingMessage: originatingMessageText,
        createdAt: await durableRunCreatedAt(run.runId),
      }),
    );
  }

  /**
   * COR-1868 — follows a subordinate run to its end. The task is admitted after the start
   * committed, then settled from the run's own end and from nothing else: the child topology, the
   * goal and the workflow keep their own settlements and never write the task.
   */
  function trackSubordinateRun(run: SubordinateRun): void {
    detachBestEffortPromise(
      run.started.then(
        (origin) => {
          // A claim written before COR-1868 holds no origin: the run stays a non-task.
          if (origin === undefined) return undefined;
          catalogSettlements.follow(
            publishFreshCatalogRun({
              handle: run.handle,
              agentName: run.agentName,
              admit: () => admitSubordinateTask(run),
              hook: catalogRunSettlements,
              followCleanup: (closed) => void tasks.watchCleanup(run.runId, closed),
              diagnose,
              durableEnd: catalogDurableEnd,
              tracker: catalogSettlements,
            }),
          );
          return undefined;
        },
        // The start never committed, so there is no run and no task.
        () => undefined,
      ),
    );
  }

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

  /**
   * COR-1527 — runs one `agent` step of a workflow file: a standalone durable run of the named
   * agent as the deployment's owner, under an id that is a function of the instance and the step.
   * A step a restart re-executes finds that run already in the engine (the boot recovery is
   * resuming it) and waits for it instead of starting a second; only a step with no run yet
   * starts one.
   */
  /**
   * The recorded state of a step's agent run once it has ended. `waitForDurableRun` refuses to wait
   * under `maintenance: 'manual'`, where nothing re-reads the store between maintenance
   * passes for an outside caller. This caller is the engine's own activity: the run is driven by
   * this engine's recovery, and its handle settles when maintenance drives it.
   */
  async function awaitWorkflowStepRun(runId: string) {
    if (options.maintenance !== 'manual') return waitForDurableRun(runId);
    const handle = runtime.durable?.engine.getHandle(runId);
    try {
      await handle?.result();
    } catch {
      // A run that failed or was cancelled rejects its result; its recorded state is read below.
    }
    return runtime.durable?.engine.get(runId);
  }

  async function runWorkflowAgentStep(request: AgentStepRequest): Promise<AgentStepResult> {
    const authority =
      workspace === undefined
        ? undefined
        : await validateRunWorkspaceAuthority(workspace, request.workspaceAuthority);
    if (workspace !== undefined && authority === undefined)
      throw new BureauError('Workspace authority unavailable.', 'CONFLICT');
    const owner = authority?.authorizingOwner ?? ANONYMOUS_LOCAL_OWNER;
    const engine = runtime.durable?.engine;
    if (engine === undefined) {
      throw new WorkflowAgentStepError(
        'agent-run-failed',
        request.agent,
        `Agent "${request.agent}" cannot run: this Bureau has no durable engine.`,
      );
    }
    const runId = workflowStepRunId(request.workflowId, request.stepAddress ?? request.step);
    if ((await engine.get(runId)) !== null) {
      // Adopt the run at this id only if it is this step's own: its recovery record carries the
      // step's marker. Anything else holding the id is not a run to take a result from.
      const claim = await runtime.loadCatalogRunRecoveryRecord(runId);
      if (
        claim.status !== 'found' ||
        claim.record.workflowStep?.workflowId !== request.workflowId ||
        claim.record.workflowStep.step !== request.step ||
        claim.record.workflowStep.stepAddress !== request.stepAddress ||
        claim.record.agentName !== request.agent ||
        claim.record.principal !== owner
      ) {
        throw new WorkflowAgentStepError(
          'agent-run-failed',
          request.agent,
          `The run id "${runId}" for step ${String(request.step)} of instance "${request.workflowId}" is held by another run, so the step cannot take a result from it.`,
        );
      }
      return agentStepResultFromState(request.agent, await awaitWorkflowStepRun(runId));
    }
    if (agentCatalog.find(request.agent) === undefined) {
      throw new WorkflowAgentStepError(
        'agent-not-found',
        request.agent,
        `Agent "${request.agent}" does not exist.`,
      );
    }
    let handle: ReturnType<typeof startWorkflowStepRun>;
    try {
      handle = startWorkflowStepRun({
        agentName: request.agent,
        input: request.message,
        runId,
        workflowStep: {
          workflowId: request.workflowId,
          step: request.step,
          ...(request.stepAddress === undefined ? {} : { stepAddress: request.stepAddress }),
        },
        principal: owner,
        ...(authority === undefined ? {} : { workspaceAuthority: authority }),
      });
    } catch (error) {
      throw new WorkflowAgentStepError(
        error instanceof BureauError && error.code === 'NOT_FOUND'
          ? 'agent-not-found'
          : 'agent-run-failed',
        request.agent,
        error instanceof Error ? error.message : String(error),
      );
    }
    return agentStepResultFromRun(request.agent, await handle.result());
  }

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

  /** COR-1670 — drops the peer call records of a run that was deleted; a failure only leaks them. */
  function releasePeerCalls(runId: string): void {
    detachBestEffortPromise(
      childTopologyStore.deletePeerCalls(runId).catch((error: unknown) => {
        diagnose({
          level: 'error',
          scope: 'child-topology',
          message: `[bureau] Could not remove the peer call records of run "${runId}": ${serializeUnknownError(error)}`,
          cause: error,
        });
      }),
    );
  }

  /**
   * What Bureau knows about a run that wants to own a child: another child
   * (nested delegation), a `createRun` run, or a durable `bureau.run` run.
   * `undefined` for anything else — `children.dispatch` reports that as
   * `not-found`.
   */
  async function resolveChildParent(parentRunId: string): Promise<ChildTopologyParent | undefined> {
    const attribution = runAttribution.get(parentRunId);
    // COR-1911 — a run of a tried agent starts no child, whatever tool asks: it is answered as a
    // run that does not exist, as any parent that cannot own children is.
    if (isTryAgentName(attribution?.agentName ?? '')) return undefined;
    const childParent = await childTopologyStore.get(parentRunId);
    let inheritedAuthority =
      runRequestContexts.get(parentRunId)?.authority.workspace ?? childParent?.workspaceAuthority;
    if (workspace !== undefined && inheritedAuthority === undefined) {
      const recovered = await runtime.loadCatalogRunRecoveryRecord(parentRunId);
      if (recovered.status === 'found') inheritedAuthority = recovered.record.workspaceAuthority;
    }
    const workspaceAuthority =
      workspace === undefined
        ? undefined
        : await validateRunWorkspaceAuthority(workspace, inheritedAuthority);
    if (workspace !== undefined && workspaceAuthority === undefined) return undefined;

    if (childParent) {
      return {
        ...(workspaceAuthority === undefined ? {} : { workspaceAuthority }),
        agentName: childParent.childAgentName,
        principal: ownerOrLocal(childParent.principal),
        live: childParent.status === 'running',
      };
    }
    // A `bureau.run()` run on `store` (COR-1302) is resolved below as it was
    // before it was registered there: through its durable workflow, or not
    // at all when it is not durable and so cannot own children.
    const runState = catalogRunIds.has(parentRunId) ? undefined : store.getRun(parentRunId);
    if (runState) {
      return {
        ...(workspaceAuthority === undefined ? {} : { workspaceAuthority }),
        agentName: attribution?.agentName ?? findRunAgentName(runState) ?? BUREAU_AGENT_NAME,
        principal: ownerOrLocal(attribution?.principal),
        live: runState.status === 'running',
        ...contextOfParent(getRunSessionIdentifier(runState)),
        ...(await chatStampOf(parentRunId)),
      };
    }
    const state = runtime.durable ? await runtime.durable.engine.get(parentRunId) : null;
    if (!state || !isAgentRunWorkflowInput(state.input)) return undefined;
    return {
      ...(workspaceAuthority === undefined ? {} : { workspaceAuthority }),
      agentName: state.input.agentName,
      principal: ownerOrLocal(attribution?.principal),
      live: DURABLE_FORCIBLY_TERMINABLE_STATUSES.has(state.status),
      ...contextOfParent(state.input.sessionId),
      ...(await chatStampOf(parentRunId)),
    };
  }

  /** {@link chatOfParentRun} as a field of a parent, absent for a run that belongs to no chat. */
  async function chatStampOf(parentRunId: string): Promise<{ readonly chat?: BureauChildChat }> {
    const chat = await chatOfParentRun(parentRunId);
    return chat === undefined ? {} : { chat };
  }

  /** The parent's session, as a child's task origin records it; absent when the parent has none. */
  function contextOfParent(sessionId: unknown): { readonly contextId?: string } {
    return typeof sessionId === 'string' && sessionId !== '' ? { contextId: sessionId } : {};
  }

  /**
   * COR-772 — whether `runId` already names a run or workflow this bureau
   * knows other than through a child record. A child's identifier becomes
   * its durable run identifier, so `children.dispatch` refuses one of these
   * rather than let a caller take over that run's attribution, recovery
   * record, or place in the topology.
   */
  async function isKnownRun(runId: string): Promise<boolean> {
    if (runAttribution.has(runId) || store.getRun(runId) !== undefined) return true;
    if (!runtime.durable) return false;
    if ((await runtime.durable.engine.get(runId)) !== null) return true;
    return runtime.isCatalogRecoveredRun(runId);
  }

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
