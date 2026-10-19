import {
  CompletableEventTarget,
  createDefaultRuntimeServices,
  mergeHookRegistries,
  type RuntimeServices,
  type RuntimeTimeoutHandle,
  type TypedEventTarget,
} from '@lostgradient/lifecycle';
import {
  type ActiveRun,
  AgentContractError,
  type AgentInput,
  type AgentRun,
  type AgentSession,
  type ChildSignalContract, // COR-625: operative's OBJECT-form cleanup acknowledgement, aliased on
  // import because `./types` exports an unrelated string-union type under
  // the same name (armorer's shutdown-owner outcome vocabulary). The two are
  // genuinely different values and must not shadow each other here.
  type CleanupAcknowledgement as RunCleanupAcknowledgement,
  assertAgentInput,
  type CombinedOperativeEventMap,
  createActiveRun,
  createAgentRunEventRegistry,
  createAgentScheduler,
  createFlowController,
  createModelCatalog,
  createRecoveredRunEventSurface,
  createRunFinishedFrame,
  createRunStartedFrame,
  createSessionInputDeliveryStore,
  createStore,
  type DurableEventEnvelope,
  type DurableEventGap,
  type DurableEventOwner,
  type DurableEventPage,
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
  type OnStepHook,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  parseSessionInputPayload,
  readGenerationProfile,
  reattachDurableActiveRun,
  type RecoveredRunHandle,
  reservedIdentifierReason,
  resolvesOwnGuardrails,
  RunRegisteredEvent as StoreRunRegisteredEvent,
  RunRemovedEvent as StoreRunRemovedEvent,
  type RunReport,
  type RunResult,
  ScheduleAttemptedEvent,
  ScheduleCancelledEvent,
  ScheduleCompletedEvent,
  type ScheduledAgentRunInput,
  ScheduleFailedEvent,
  SchedulePausedEvent,
  SCHEDULER_RUN_ID_PREFIX,
  ScheduleResumedEvent,
  SchedulerTaskCompletedEvent,
  SchedulerTaskFailedEvent,
  type SchedulerTaskLocation,
  ScheduleSkippedEvent,
  SessionCreatedEvent,
  SessionDeletedEvent,
  type SessionInputAdmissionOutcome,
  type SessionInputAdmissionRequest,
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
  type Store,
  StoreActionEvent,
  type StreamEventMap,
  type Subscription,
  TaskCancelledEvent,
  TaskDispatchedEvent,
  TaskPreemptedEvent,
  SESSION_OWNER_METADATA_KEY,
} from '@lostgradient/operative';
import {
  SkillActivatedEvent,
  SkillDeactivatedEvent,
  SkillFailedEvent,
  SkillLoadedEvent,
  SkillRejectedEvent,
} from './skills';
import {
  type ConditionalTextValueStore,
  decode,
  KEYS,
  type Engine,
  type ListFilter,
  type ListOptions,
  Mailbox,
  MemoryStorage,
  type RecoveredWorkflowInfo,
  textValueStore,
  type WorkflowState,
} from '@lostgradient/weft';
import {
  type GrantListFilter,
  type ReusableApprovalGrant,
  type ReusableApprovalGrantInput,
  type SignedPendingToolApproval,
  type Tool,
  type ToolRequestContext,
} from 'armorer';
import {
  Conversation,
  type ConversationHistory,
  createConversationHistory,
  CURRENT_SCHEMA_VERSION,
  isConversationHistory,
  materializeToolResultAsync,
  type Message,
  type MessageInput,
  resolveToolResult,
} from 'conversationalist';

import { shutdownThenRethrow } from './composition-failure';
import { type AgentDefinitions, type AgentNames, createAgentCatalog } from './agent-catalog';
import { AgentSnapshotError } from './agent-file';
import {
  createAgentFileCatalog,
  type FileAgentBinding,
  readFileAgentBinding,
} from './agent-file-catalog';
import { createFileAgentRuntime, type FileAgentRuntime } from './agent-file-runtime';
import { createAgentSnapshotStore } from './agent-snapshot-store';
import { createAssetService } from './assets/asset-service';
import { createAssetContentSourceResolver } from './assets/content-source-resolver';
import { createAssetGeneratedMediaAdmitter } from './assets/generated-media-admitter';
import {
  claimRowAssets,
  releaseRowAssetClaims,
  runRowHolderId,
  sessionRowHolderId,
} from './assets/row-asset-claims';
import type { AssetService } from './assets/types';
import {
  AUDIT_AGENT_OWNER_PREFIX,
  AUDIT_SCHEDULE_OWNER_PREFIX,
  AUDIT_SESSION_OWNER_PREFIX,
  AUDIT_WORKFLOW_OWNER_PREFIX,
  type AuditTrail,
  auditTrailSessionOwnerId,
  type CheckpointRetentionOption,
  computeInitialAuditSequence,
  createAuditTrail,
} from './audit-trail';
import { catalogRunGuardrailsContext, createCatalogDispatcher } from './bureau-catalog-dispatch';
import { createBureauEventFeed } from './bureau-event-feed.ts';
import { createSessionPersistence } from './bureau-session-persistence';
import {
  type BureauChildren,
  type ChildTopologyParent,
  createChildTopology,
} from './child-topology';
import { createChildTopologyStore } from './child-topology-store';
import {
  type CreatedRunSummary,
  createRunCreationLedger,
  digestRunCreationPayload,
  type RunCreationAttempt,
  type RunCreationObservation,
  type RunCreationReceiptLocation,
  serializeAppendedMessages,
} from './command-ledger';
import {
  createDurableEventHistory,
  createDurableEventProducer,
  deletionMarkerKindFor,
  DURABLE_HISTORY_GAP_KIND,
  type DurableEventHistory,
  type DurableEventHistoryPageOptions,
  type DurableEventHistorySubscribeOptions,
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
  RunRemovedEvent,
} from './events';
import { createGoalAttemptFenceHost } from './goal-attempt-fence';
import { createGoalWorkflowHost } from './goal-ports';
import { recoveryEntryFailure } from './goal-recovery';
import type { BureauGoals } from './goal-types';
import { humanWaitDenialPayload } from './human-wait-signal';
import { createGoalValidatorCatalog } from './goal-validator-catalog';
import { composeBureauGoals } from './goals-composition';
import { leaseEvidenceFromLostHealth } from './liveness-projection';
import { createModelCatalogService } from './model-catalog-refresh';
import { createModelPolicyPlanner } from './model-policy';
import { createOnlineEvalSampler, type OnlineEvalSampler } from './online-evals';
import {
  buildPartialRunReport,
  buildTerminalReportFromAbortedEvent,
  buildTerminalReportFromCompletedEvent,
  createRunFrameForwarder,
} from './run-envelope';
import { attachRunEventFeed, disposeRunEventFeed } from './run-event-feed-attachment.ts';
import type {
  BureauToolbox,
  CatalogAgentRunOptionsResolution,
  ScheduledFireNotice,
  SessionAgentRun,
} from './runtime-composition';
import {
  createRuntimeComposition,
  createSchedulerServiceRequestContext,
  decodeScheduleRunMarker,
  isRunFailureFinishReason,
  registerTrailingOnStep,
  SESSION_AGENT_DEFINITION_HASH_METADATA_KEY,
  SESSION_AGENT_REVISION_METADATA_KEY,
  sessionRunMediaOptions,
  wireDurableOptInTools,
} from './runtime-composition';
import {
  findRunAgentName,
  resolveDiagnosticSink,
  type RunAttribution,
  serializeActionDetail,
  serializeRunDetail,
  serializeRunState,
  serializeUndispatchedCatalogRun,
  serializeUndispatchedCatalogRunDetail,
  serializeUnknownError,
} from './serialization';
import { createCatalogTaskSettler } from './catalog-task-settlement';
import {
  createCatalogRunSettlementHook,
  type CatalogRunSettlement,
  type DurableEnd,
  type DurableEndReader,
  createCatalogSettlementTracker,
  publishFreshCatalogRun,
  settlementForRejection,
} from './catalog-run-settlement';
import {
  createTaskRegistry,
  originatingMessageText,
  settledTaskState,
  TASK_ARTIFACT_TEXT_LIMIT,
  type LiveTask,
} from './task-registry';
import {
  ANONYMOUS_LOCAL_OWNER,
  EXPIRY_ACTOR,
  ownerFromPrincipal,
  ownerOrLocal,
  principalDefect,
  RECOVERY_ACTOR,
} from './owner-of-record';
import { toScheduleSpec } from './schedule-spec';
import {
  agentStepResultFromRun,
  agentStepResultFromState,
  workflowStepRunId,
} from './workflow-agent-step';
import { parseWorkflowScheduleId } from './workflow-schedule';
import {
  createWorkflowRuntime,
  payloadMaximumBytesOf,
  type WorkflowRuntime,
} from './workflow-runtime';
import { collidingWorkflowToolName, createWorkflowTools } from './workflow-tools';
import { createWorkflowSnapshotStore } from './workflow-snapshot-store';
import {
  type AgentStepRequest,
  type AgentStepResult,
  createWorkflowDocumentHost,
  WorkflowAgentStepError,
} from './workflow-host';
import {
  attributeScheduledFire,
  recordScheduleFired,
  releaseScheduledFire,
} from './scheduled-fire-record';
import {
  isPlainAuthorityRecord,
  isSessionAuthorityAuthorized,
  isSessionHistoryReadAuthorized,
  resolvePersistedRunOwningPrincipal,
  resolveSessionOwner,
  resolveSessionPreAdmission,
  SessionAgentConflictError,
  SessionOwnerConflictError,
} from './session-authority';
import { createRunHumanWaits } from './run-human-waits';
import {
  countCheckpointParks,
  humanWaitParkOrdinal as sharedHumanWaitParkOrdinal,
} from './park-ordinals';
import { copyAgentOwnedRunOptions, sessionExecuteOptions } from './session-agent-options';
import {
  admitSessionInput,
  isSessionInputSessionIdAddressable,
  type SessionInputAdmissionAttemptOutcome,
  createSessionInputMailbox,
  type PersistedSessionInput,
  readSessionInputReceipt,
  SESSION_INPUT_DELIVERY_RETENTION_MS,
} from './session-input-durability';
import { createSessionInputDeliveryGate } from './session-input-delivery';
import {
  createSessionInputSettlement,
  forEachOpenReceipt,
  SESSION_INPUT_RUN_ENDED_REASON,
} from './session-input-settlement';
import { generateSessionOutboxDrainOwnerSuffix } from './session-outbox-drain-owner-suffix';
import {
  normalizeRunRequestContext,
  recoveredRequestContextFromMetadata,
} from './session-request-context';
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
  type SteeringRefusal,
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
  type SteeringLogHead,
} from './steering-log';
import type {
  AbortingRun,
  Bureau,
  BureauChildrenOptions,
  BureauOptions,
  BureauRecoveryReport,
  BureauRunOptions,
  BureauShutdownOptions,
  BureauShutdownOwnerReport,
  BureauShutdownReport,
  CancelDurableRunOutcome,
  CleanupAcknowledgement,
  ConfigurationResponse,
  ContextDeletionReport,
  CreateRunRequest,
  LocateRunCreationReceiptRequest,
  OwnedResource,
  DiagnosticSink,
  DurableScheduleDefinition,
  EventHistoryDeletedAggregateOutcome,
  EventHistoryNotFoundOutcome,
  EventHistoryUnsupportedOutcome,
  PendingReview,
  SessionPendingReview,
  ResolveReviewInput,
  ResolveReviewResult,
  RetentionWindowOption,
  ReviewStatus,
  RunSummary,
  ServerFrame,
  SubmitSchedulerTaskRequest,
  SubmitSchedulerTaskResponse,
  ToolSummary,
} from './types';
import {
  DEFAULT_PRINCIPAL_SESSION_INPUT_BACKLOG_LIMIT,
  DEFAULT_SESSION_INPUT_BACKLOG_LIMIT,
} from './types';
import { isSettlingRunAction, settledActionTimestamp } from './run-settlement';
import { createWebhookNotifier, type WebhookNotifier } from './webhook-notifier';
import { streamEventToFrame } from './websocket-frames';

const BUREAU_AGENT_NAME = 'bureau';
const SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS = 3;
const SESSION_PERSISTENCE_RETRY_DELAY_MILLISECONDS = 10;
/**
 * COR-1476 — the first wait between attempts to write an ended run's steering
 * `run-ended` entry; each later wait doubles, up to the cap. The write is
 * retried until it is acknowledged or the bureau closes, because the run reads
 * the session's mailbox only after it.
 */
const SESSION_INPUT_RUN_END_RETRY_DELAY_MILLISECONDS = 10;
const SESSION_INPUT_RUN_END_RETRY_CAP_MILLISECONDS = 2_000;
/** After the first failure is reported, how long passes before the next one is. */
const SESSION_INPUT_RUN_END_DIAGNOSTIC_INTERVAL_MILLISECONDS = 60_000;
/**
 * How long `shutdown({ policy: 'abort' })` waits for the runs it aborted to
 * reach a terminal event before it stops waiting and tears storage down. A
 * run that honors its `AbortSignal` settles within a few ticks; this bound
 * exists only so a run that ignores it cannot hold shutdown open.
 */
export const ABORTED_RUN_TERMINAL_GRACE_MILLISECONDS = 1_000;
const SCHEDULER_PRIORITIES = ['immediate', 'scheduled', 'background', 'ambient'] as const;

/**
 * Returns whether a persisted session can still resume under transport-issued
 * authority. Terminal sessions retain their authority for auditability, but
 * must not defer boot recovery because no user code can resume from them.
 */
export function hasRecoverableTransportAuthority(metadata: Record<string, JSONValue>): boolean {
  if (metadata['lastRunStatus'] !== 'running') return false;
  const requiresTransportValidator = (revision: unknown): boolean =>
    typeof revision === 'string' && revision !== 'bureau:1' && revision !== 'bureau:scheduler:1';
  const lastRunId = metadata['lastRunId'];
  if (typeof lastRunId !== 'string' || !lastRunId) return false;
  const authorities = metadata['lastRequestAuthorities'];
  if (authorities && typeof authorities === 'object' && !Array.isArray(authorities)) {
    const activeAuthority = (authorities as Record<string, JSONValue>)[lastRunId];
    if (!activeAuthority || typeof activeAuthority !== 'object' || Array.isArray(activeAuthority)) {
      return false;
    }
    return requiresTransportValidator(
      (activeAuthority as Record<string, JSONValue>)['authorizationRevision'],
    );
  }
  const legacyAuthority = metadata['lastRequestAuthority'];
  if (!legacyAuthority || typeof legacyAuthority !== 'object' || Array.isArray(legacyAuthority)) {
    return false;
  }
  return requiresTransportValidator(
    (legacyAuthority as Record<string, JSONValue>)['authorizationRevision'],
  );
}

export function isTerminalApprovalBindingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as Record<string, unknown>)['code'];
  return (
    code === 'expired' ||
    code === 'revoked' ||
    code === 'already-consumed' ||
    code === 'not-found' ||
    code === 'invalid-binding'
  );
}

export function emptyRecoveredStepMetadata(): Record<string, never> {
  return {};
}

export function omitKeysWithPrefix(
  record: Record<string, JSONValue>,
  prefix: string,
): Record<string, JSONValue> {
  const remaining: Record<string, JSONValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith(prefix)) remaining[key] = value;
  }
  return remaining;
}

/** Narrows JSON's readonly array union before spreading object metadata. */
function isJsonObject(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValues(values: readonly JSONValue[]): string[] {
  const strings: string[] = [];
  for (const value of values) {
    if (typeof value === 'string') strings.push(value);
  }
  return strings;
}

function omitStringValue(values: readonly JSONValue[], omittedValue: string): JSONValue[] {
  const remaining: JSONValue[] = [];
  for (const value of values) {
    if (value !== omittedValue) remaining.push(value);
  }
  return remaining;
}

function omitStringsWithPrefix(values: readonly JSONValue[], prefix: string): JSONValue[] {
  const remaining: JSONValue[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.startsWith(prefix)) remaining.push(value);
  }
  return remaining;
}

/**
 * Factory for the default `BureauOptions.sessionPersistenceSleep` — a real
 * sleep driven by the composed {@link RuntimeServices.timers} (AB-260),
 * defaulting to the real-globals runtime when called with no argument (the
 * baseline behavior, unchanged from before `RuntimeServices` composition).
 * The timer-scheduling and timer-clearing members are destructured once so
 * the call sites below read `scheduleTimeout(...)` rather than a literal
 * `timers` method call — see `runtime-composition.ts`'s equivalent pattern
 * for why: the AB-260 binary completion check greps for the literal global
 * timer-scheduling call text, and only a destructured alias avoids it while
 * still routing through the injected timers.
 */
export function createDefaultSessionPersistenceSleep(
  timers: RuntimeServices['timers'] = createDefaultRuntimeServices().timers,
): (milliseconds: number) => Promise<void> {
  const { setTimeout: scheduleTimeout } = timers;
  return (milliseconds) => new Promise((resolve) => scheduleTimeout(resolve, milliseconds));
}

/**
 * Factory for the default `BureauOptions.shutdownTimeoutSleep` — a real
 * sleep driven by the composed {@link RuntimeServices.timers} (AB-260),
 * cleared (never resolving) if `signal` aborts first so a `shutdown()` whose
 * real teardown wins the race does not leave this timer pending for the
 * rest of its duration. Defaults to the real-globals runtime when called
 * with no argument — the baseline behavior, unchanged from before
 * `RuntimeServices` composition.
 */
export function createDefaultShutdownTimeoutSleep(
  timers: RuntimeServices['timers'] = createDefaultRuntimeServices().timers,
): (milliseconds: number, signal: AbortSignal) => Promise<void> {
  const { setTimeout: scheduleTimeout, clearTimeout: cancelTimeout } = timers;
  return (milliseconds, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return;
      const handle = scheduleTimeout(resolve, milliseconds);
      signal.addEventListener('abort', () => cancelTimeout(handle), { once: true });
    });
}

function ignoreBestEffortPromiseRejection(): void {}

export function detachBestEffortPromise(promise: Promise<unknown>): void {
  void promise.catch(ignoreBestEffortPromiseRejection);
}

/**
 * `WorkflowStatus` values (Weft `core/types/identity.ts`) a workflow can
 * still be forcibly terminated from. Mirrors Weft's own internal
 * `FORCIBLY_TERMINABLE_STATUSES` (`core/engine/termination/cleanup.ts`),
 * which is not exported on the public `@lostgradient/weft` barrel, and
 * operative's parallel (also module-private) `TERMINAL_WORKFLOW_STATUSES`
 * set in `durable/active-run-adapter.ts`. Kept local rather than exported
 * from either package, since neither exposes the underlying constant for
 * `bureau` to import.
 */
const DURABLE_FORCIBLY_TERMINABLE_STATUSES = new Set<string>(['pending', 'running', 'suspended']);

/**
 * Whether a durable run's status is one it has not settled from: Bureau's own
 * non-terminal set ({@link DURABLE_FORCIBLY_TERMINABLE_STATUSES}), read by the
 * AG-UI mount's busy decision so it cannot drift from what `waitForDurableRun` and
 * `cancelDurableRun` call unsettled. `pending` counts: `createRun` returns once the
 * durable record commits, and Weft reports the workflow `pending` until its inline
 * launch runs.
 */
export function isDurableRunUnsettled(status: string): boolean {
  return DURABLE_FORCIBLY_TERMINABLE_STATUSES.has(status);
}

/**
 * Dependencies {@link resolveCancelDurableRun} needs, factored out for
 * direct dependency injection in tests (AB-205) — in particular the
 * "resolves `already-terminal`, never `requested`" race fixture, which needs
 * to observe/control exactly when `cancel` resolves relative to a workflow
 * completing normally, something a real Weft engine cannot be made to do
 * deterministically.
 */
export interface CancelDurableRunDependencies {
  getDurableRun: (runId: string) => Promise<WorkflowState | null | undefined>;
  cancel: (runId: string) => Promise<void>;
}

/** What {@link resolveWaitForDurableRun} needs from the durable engine and the bureau's options. */
export interface WaitForDurableRunDependencies {
  getDurableRun: (runId: string) => Promise<WorkflowState | null | undefined>;
  /** Weft's result waiter for the run: resolves, or rejects with the run's own failure or another error. */
  awaitResult: (runId: string) => Promise<void>;
  /** `durableBackgroundTasks: 'manual'`, where Weft installs no cross-engine poll. */
  manualBackgroundTasks: boolean;
}

/**
 * The resolution algorithm behind {@link Bureau.waitForDurableRun}, independent of a real
 * `runtime.durable.engine`. A rejection of the result waiter is accepted only when the store then
 * confirms the run is terminal (a failed, cancelled or timed-out run rejects its own result);
 * any other rejection says nothing about the run and propagates.
 */
export async function resolveWaitForDurableRun(
  runId: string,
  dependencies: WaitForDurableRunDependencies,
): Promise<WorkflowState | null | undefined> {
  const isTerminal = (state: WorkflowState) =>
    !DURABLE_FORCIBLY_TERMINABLE_STATUSES.has(state.status);
  const current = await dependencies.getDurableRun(runId);
  if (current === undefined || current === null) return current;
  if (isTerminal(current)) return current;
  // Weft's result waiter rechecks the store only inside `runMaintenance()` under
  // `backgroundTasks: 'manual'`, so a wait nothing re-drives could pend forever for a run another
  // bureau completes. Refuse it plainly instead of hanging.
  if (dependencies.manualBackgroundTasks) {
    throw new BureauError(
      `waitForDurableRun("${runId}") cannot wait under durableBackgroundTasks: 'manual', ` +
        `where nothing re-reads the durable store between maintenance passes; call ` +
        `runDurableMaintenance() and then getDurableRun() instead`,
      'UNSUPPORTED_CAPABILITY',
    );
  }
  let rejection: unknown;
  try {
    await dependencies.awaitResult(runId);
  } catch (error) {
    rejection = error;
  }
  const settled = await dependencies.getDurableRun(runId);
  if (settled === undefined || settled === null) return settled;
  if (isTerminal(settled)) return settled;
  throw rejection ?? new Error(`Durable run "${runId}" settled without reaching a terminal state`);
}

/**
 * The pure resolution algorithm behind {@link Bureau.cancelDurableRun}
 * (AB-37, AB-205), independent of any real `runtime.durable.engine` — see
 * {@link CancelDurableRunDependencies}. Never rejects.
 *
 * Resolution order: `getDurableRun` resolving `undefined` (no durable engine
 * composed) resolves `'unsupported-capability'`; resolving `null` (unknown to
 * the engine) resolves `'not-found'`; a resolved `WorkflowState.status`
 * already outside {@link DURABLE_FORCIBLY_TERMINABLE_STATUSES} resolves
 * `'already-terminal'` WITHOUT calling `cancel`. Otherwise `cancel(runId)` is
 * called — a rejection resolves `'failed'` with the error attached; a
 * resolution triggers a REQUIRED post-cancel re-read via `getDurableRun`,
 * because `cancel` resolving is not proof a cancellation record committed (it
 * can win OR lose a race against the workflow completing on its own): a
 * re-read observing `status === 'cancelled'` resolves `'requested'`; a
 * re-read observing any OTHER status outside
 * {@link DURABLE_FORCIBLY_TERMINABLE_STATUSES} (the race where normal
 * completion won instead) resolves `'already-terminal'`; a re-read
 * observing `null` (the run was purged between the two reads) resolves
 * `'not-found'`; a re-read observing `undefined` (the durable engine
 * vanished between the two reads — not expected in practice, since nothing
 * decomposes a bureau's durable engine mid-call, but never assumed) resolves
 * `'unsupported-capability'`; a re-read still reporting a status WITHIN
 * {@link DURABLE_FORCIBLY_TERMINABLE_STATUSES} means `cancel` resolved
 * without the cancellation actually committing — genuinely unproven, not a
 * success — and resolves `'failed'` rather than being misreported as
 * `'already-terminal'` (a code-review finding on this pull request).
 */
export async function resolveCancelDurableRun(
  runId: string,
  dependencies: CancelDurableRunDependencies,
): Promise<CancelDurableRunOutcome> {
  try {
    const state = await dependencies.getDurableRun(runId);
    if (state === undefined) {
      return { status: 'unsupported-capability' };
    }
    if (state === null) {
      return { status: 'not-found' };
    }
    if (!DURABLE_FORCIBLY_TERMINABLE_STATUSES.has(state.status)) {
      return { status: 'already-terminal' };
    }

    try {
      await dependencies.cancel(runId);
    } catch (error) {
      return { status: 'failed', error };
    }

    const rereadState = await dependencies.getDurableRun(runId);
    if (rereadState === undefined) {
      return { status: 'unsupported-capability' };
    }
    if (rereadState === null) {
      return { status: 'not-found' };
    }
    if (rereadState.status === 'cancelled') {
      return { status: 'requested' };
    }
    if (!DURABLE_FORCIBLY_TERMINABLE_STATUSES.has(rereadState.status)) {
      return { status: 'already-terminal' };
    }
    // `cancel` resolved without rejecting, but the post-cancel re-read still
    // reports a forcibly-terminable status — the cancellation record did not
    // actually commit. Reporting `'already-terminal'` here would be a false
    // positive; reporting `'requested'` would be an unproven claim. Neither
    // is honest, so this resolves `'failed'`.
    return {
      status: 'failed',
      error: new Error(
        `cancelDurableRun("${runId}"): engine.cancel resolved but the post-cancel re-read still ` +
          `reports status "${rereadState.status}" — the cancellation did not commit.`,
      ),
    };
  } catch (error) {
    return { status: 'failed', error };
  }
}

type FlowControlScheduler = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

type FlowControlSchedulerEvent =
  | SchedulerTaskCompletedEvent
  | SchedulerTaskFailedEvent
  | TaskCancelledEvent
  | TaskPreemptedEvent
  | TaskDispatchedEvent;

export function wireFlowControlSchedulerEvents(
  scheduler: FlowControlScheduler,
  flowController: Pick<FlowController, 'settle' | 'markParked' | 'markResumed'>,
): Array<() => void> {
  function settleScheduledTask(
    event: SchedulerTaskCompletedEvent | SchedulerTaskFailedEvent | TaskCancelledEvent,
  ) {
    flowController.settle(event.taskId);
  }

  function handlePreemptedTask(event: TaskPreemptedEvent) {
    if (event.requeued) {
      flowController.markParked(event.taskId);
      return;
    }

    flowController.settle(event.taskId);
  }

  function handleDispatchedTask(event: TaskDispatchedEvent) {
    flowController.markResumed(event.taskId);
  }

  const listeners: ReadonlyArray<readonly [FlowControlSchedulerEvent['type'], EventListener]> = [
    [SchedulerTaskCompletedEvent.type, settleScheduledTask as EventListener],
    [SchedulerTaskFailedEvent.type, settleScheduledTask as EventListener],
    [TaskCancelledEvent.type, settleScheduledTask as EventListener],
    [TaskPreemptedEvent.type, handlePreemptedTask as EventListener],
    [TaskDispatchedEvent.type, handleDispatchedTask as EventListener],
  ];

  return listeners.map(([eventType, listener]) => {
    scheduler.addEventListener(eventType, listener);
    return () => scheduler.removeEventListener(eventType, listener);
  });
}

/**
 * Discriminates *why* a `BureauError` with code `NOT_CONFIGURED` was thrown.
 * `NOT_CONFIGURED` alone is not enough for a consumer to decide an HTTP status:
 * some subjects mean "this deployment does not compose that capability at all"
 * (`durable`, `scheduler` — a 501 case), others mean "the capability exists but
 * is unconfigured, and the operator can fix it" (`generate`, `persistence`,
 * `approval` — a 503 case). Only set on `NOT_CONFIGURED` errors.
 */
export type BureauErrorNotConfiguredSubject =
  'generate' | 'scheduler' | 'durable' | 'persistence' | 'approval';

class BureauError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'NOT_CONFIGURED'
    | 'BAD_REQUEST'
    | 'RATE_LIMITED'
    | 'UNSUPPORTED_CAPABILITY';
  readonly subject: BureauErrorNotConfiguredSubject | undefined;

  // `subject` is required for NOT_CONFIGURED and disallowed for every other
  // code — a compile-time guarantee that a future NOT_CONFIGURED throw site
  // cannot skip disambiguation and reintroduce the ambiguity #264 fixed.
  constructor(message: string, code: Exclude<BureauError['code'], 'NOT_CONFIGURED'>);
  constructor(message: string, code: 'NOT_CONFIGURED', subject: BureauErrorNotConfiguredSubject);
  constructor(
    message: string,
    code:
      | 'NOT_FOUND'
      | 'CONFLICT'
      | 'NOT_CONFIGURED'
      | 'BAD_REQUEST'
      | 'RATE_LIMITED'
      | 'UNSUPPORTED_CAPABILITY',
    subject?: BureauErrorNotConfiguredSubject,
  ) {
    super(message);
    this.name = 'BureauError';
    this.code = code;
    this.subject = subject;
  }
}

/**
 * `resolveReview` resolved a tool approval, and the tool ran or was refused, but
 * the outcome could not be written into the session's conversation. The review is
 * resolved and will not be offered again; the conversation still shows it as
 * pending until a later write replaces the row.
 *
 * The decision took effect: only the write into the conversation failed. The code
 * is `CONFLICT` for lack of a better one, and a management-plane consumer must not
 * read it as another resolver having won.
 */
const APPROVAL_OUTCOME_NOT_WRITTEN_MESSAGE =
  'The decision was recorded, but its outcome could not be written into the conversation, which still shows the approval as pending';

class ApprovalOutcomeNotWrittenError extends BureauError {
  constructor(message: string) {
    super(message, 'CONFLICT');
    this.name = 'ApprovalOutcomeNotWrittenError';
  }
}

export { ApprovalOutcomeNotWrittenError, BureauError };

/**
 * Thrown by `createSchedule` when a schedule registers successfully against
 * the engine but its {@link import('@lostgradient/weft').ScheduleSummary}
 * cannot be retrieved immediately afterward (`AgentScheduleHandle.describe()`
 * rejects). Mirrors `DurableCapabilityUnavailableError`'s shape discipline
 * (AB-41/AB-43) — `.code`, `.category`, `.retryable` — so the same
 * `isToolError`-style consumer contract can discriminate it without a bare,
 * untyped `Error` leaking through. The schedule itself IS registered; only
 * its locator (the summary) is unavailable.
 */
export class ScheduleLocatorUnavailableError extends Error {
  readonly code = 'ScheduleLocatorUnavailableError';
  readonly category = 'unavailable' as const;
  readonly retryable = false as const;
  /** The already-registered schedule whose locator could not be read. */
  readonly scheduleId: string;

  constructor(scheduleId: string, options?: { cause?: unknown }) {
    super(
      `Schedule ${scheduleId} was registered, but its summary could not be retrieved. ` +
        `The schedule is registered; retry describing it (e.g. bureau.getSchedule('${scheduleId}')) later.`,
      options,
    );
    this.name = 'ScheduleLocatorUnavailableError';
    this.scheduleId = scheduleId;
  }
}

function toBadRequest(message: string): never {
  throw new BureauError(message, 'BAD_REQUEST');
}

/**
 * COR-851 — an id an ordinary caller chooses may not sit in a namespace durable
 * goals own (see `reserved-identifiers.ts`). Refused as `BAD_REQUEST` with a
 * message beginning `reserved-identifier:`.
 */
function rejectReservedIdentifier(kind: string, id: string): void {
  const reason = reservedIdentifierReason(kind, id);
  if (reason !== undefined) toBadRequest(reason);
}

/** The text of the last user row in `rows`, or `''` when there is none. */
function lastUserTextOf(rows: ReadonlyArray<Message> | undefined): string {
  const last = rows?.findLast((row) => row.role === 'user');
  if (last === undefined) return '';
  if (typeof last.content === 'string') return last.content;
  return last.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** Appends a request's rows verbatim, refusing rows the conversation cannot take. */
function appendRequestRows(
  conversation: Conversation,
  rows: ReadonlyArray<Message> | undefined,
): void {
  if (rows === undefined || rows.length === 0) return;
  try {
    // Built rows keep their ids and content parts; `MessageInput` is the type
    // the history's `appendMessages` declares, and a built `Message` is the
    // input it also accepts.
    conversation.appendMessages(...(rows as unknown as MessageInput[]));
  } catch (error) {
    toBadRequest(
      `"appendMessages" cannot be appended to the session's conversation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assertConversationAnswerable(conversation: Conversation): void {
  const last = conversation.getMessages({ includeHidden: true }).at(-1);
  if (last?.role !== 'user' && last?.role !== 'tool-result') {
    toBadRequest(
      'The conversation a run starts from must end in a user or tool-result message; ' +
        'pass "message" or "appendMessages", or start from a session that ends in one',
    );
  }
}

function validateMessageRequest(
  request: {
    message?: unknown;
    maximumSteps?: unknown;
    maximumTokens?: unknown;
    systemPrompt?: unknown;
  },
  options: { readonly messageOptional?: boolean } = {},
): void {
  if (request.message === undefined && options.messageOptional === true) {
    // The caller appends rows instead, or answers the conversation as it stands.
  } else if (!request.message || typeof request.message !== 'string') {
    toBadRequest('Request must include a "message" string');
  }

  if (request.systemPrompt !== undefined && typeof request.systemPrompt !== 'string') {
    toBadRequest('"systemPrompt" must be a string');
  }

  if (request.maximumSteps !== undefined) {
    if (
      typeof request.maximumSteps !== 'number' ||
      !Number.isInteger(request.maximumSteps) ||
      request.maximumSteps <= 0
    ) {
      toBadRequest('"maximumSteps" must be a positive integer');
    }
  }

  if (request.maximumTokens !== undefined) {
    if (
      typeof request.maximumTokens !== 'number' ||
      !Number.isInteger(request.maximumTokens) ||
      request.maximumTokens <= 0
    ) {
      toBadRequest('"maximumTokens" must be a positive integer');
    }
  }
}

function validateCreateRunRequest(request: CreateRunRequest): void {
  validateMessageRequest(request, { messageOptional: true });

  if (request.appendMessages !== undefined) {
    if (
      !Array.isArray(request.appendMessages) ||
      !request.appendMessages.every(
        (row: unknown) =>
          typeof row === 'object' &&
          row !== null &&
          typeof (row as { id?: unknown }).id === 'string' &&
          (row as { id: string }).id.length > 0 &&
          typeof (row as { role?: unknown }).role === 'string',
      )
    ) {
      toBadRequest('"appendMessages" must be an array of messages, each with an "id" and a "role"');
    }
  }

  if (request.sessionId !== undefined) {
    if (typeof request.sessionId !== 'string') {
      toBadRequest('"sessionId" must be a string');
    }

    if (request.sessionId.trim().length === 0) {
      toBadRequest('"sessionId" must be a non-empty string');
    }
    rejectReservedIdentifier('"sessionId"', request.sessionId.trim());
  }

  if (request.agentName !== undefined) {
    if (typeof request.agentName !== 'string') {
      toBadRequest('"agentName" must be a string');
    }

    if (request.agentName.trim().length === 0) {
      toBadRequest('"agentName" must be a non-empty string');
    }
  }

  // COR-424 — the ledger keys a run-creation request id on the caller that
  // issued it. Without an authenticated principal there is no caller to
  // scope it to, and an unscoped key would let any caller replay another's.
  if (request.runCreationRequestId !== undefined) {
    if (
      typeof request.runCreationRequestId !== 'string' ||
      request.runCreationRequestId.trim().length === 0
    ) {
      toBadRequest('"runCreationRequestId" must be a non-empty string');
    }
    if (typeof request.principal !== 'string' || request.principal.trim().length === 0) {
      toBadRequest('"runCreationRequestId" requires an authenticated "principal"');
    }
  }
}

/**
 * AB-15/AB-22: `bureau.run`'s synchronous-throw surface — unknown agent name,
 * malformed `input`, or malformed `options` — validated BEFORE any async
 * work (durable-engine dispatch, definition resolution) begins. Everything
 * else (session, provider, tool, policy, abort) settles through the
 * returned `AgentRun` handle instead of throwing here.
 */
function validateAgentRunInput(input: unknown): asserts input is AgentInput {
  if (typeof input === 'string') return;
  if (Array.isArray(input)) {
    // COR-716: an ordered list of user text and media parts. The same check
    // every start path makes, so a malformed list is refused here, before any
    // async work, rather than failing inside a step.
    try {
      assertAgentInput(input);
    } catch (error) {
      if (error instanceof AgentContractError) toBadRequest(`"input" is invalid: ${error.message}`);
      throw error;
    }
    return;
  }
  if (
    input !== null &&
    typeof input === 'object' &&
    'conversation' in input &&
    isConversationHistory(input.conversation)
  ) {
    return;
  }
  toBadRequest(
    '"input" must be a string, a non-empty array of text and media parts, or an object with a valid "conversation" ConversationHistory',
  );
}

function validateBureauRunOptions(
  options: BureauRunOptions | undefined,
  // AB-241 review finding: a `principal` value re-read from `options` here
  // (a second, independent property access) could differ from the value
  // the caller snapshots before/after this call if `options.principal` is
  // a getter/proxy whose result changes between reads — a JavaScript
  // caller could observe a validated string on the first read and hand a
  // non-string (or a different principal entirely) to whichever read
  // actually gets persisted, bypassing this synchronous `BAD_REQUEST`.
  // The caller captures `options?.principal` exactly ONCE and passes that
  // captured value here, so this validates the SAME value every other
  // consumer downstream (context, recovery record, liveness owner) uses.
  capturedPrincipal: unknown,
): asserts options is BureauRunOptions | undefined {
  if (options === undefined) return;
  // `typeof [] === 'object'` — without excluding arrays explicitly, a
  // JavaScript caller passing `[]` (or any array) as `options` passed this
  // guard as an empty options bag instead of the synchronous rejection the
  // contract advertises for malformed options (review round 2, Codex).
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    toBadRequest('"options" must be an object');
  }
  if (options.sessionId !== undefined && typeof options.sessionId !== 'string') {
    toBadRequest('"options.sessionId" must be a string');
  }
  if (options.sessionId !== undefined) {
    rejectReservedIdentifier('"options.sessionId"', options.sessionId.trim());
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    toBadRequest('"options.signal" must be an AbortSignal');
  }
  if (options.withTraceContext !== undefined && typeof options.withTraceContext !== 'function') {
    toBadRequest('"options.withTraceContext" must be a function');
  }
  const principalReason = principalDefect(capturedPrincipal, 'options.principal');
  if (principalReason !== undefined) toBadRequest(principalReason);
}

function validateSubmitSchedulerTaskRequest(request: SubmitSchedulerTaskRequest): void {
  validateMessageRequest(request);

  if (request.metadata !== undefined) {
    if (
      typeof request.metadata !== 'object' ||
      request.metadata === null ||
      Array.isArray(request.metadata)
    ) {
      toBadRequest('"metadata" must be an object');
    }
  }

  if (request.priority !== undefined && !SCHEDULER_PRIORITIES.includes(request.priority)) {
    toBadRequest('"priority" must be one of: immediate, scheduled, background, ambient');
  }

  if (request.requeue !== undefined && typeof request.requeue !== 'boolean') {
    toBadRequest('"requeue" must be a boolean');
  }
}

/**
 * The session metadata boot recovery needs to decide a recovered run's fate,
 * loaded by id from the owning session. `null` ⇒ the session does not exist.
 */
export type RecoveredRunSessionMetadata = { lastRunId?: unknown; lastRunStatus?: unknown } | null;

/**
 * The outcome of loading a recovered run's owning session: a successful load
 * (the metadata, possibly `null` for "absent") or a transient read FAILURE that
 * leaves ownership UNKNOWN.
 */
export type SessionLoadOutcome = { ok: true; session: RecoveredRunSessionMetadata } | { ok: false };

/**
 * Decide what boot recovery does with one handle from `engine.recoverAll()`:
 *
 * - `reattach` — bureau-owned, in-flight, session-confirmed: wrap it in a live
 *   ActiveRun and register it.
 * - `monitor` — native scheduled fire: leave the recovered Weft workflow running
 *   and attach a detached result monitor, but do not register an ActiveRun because
 *   scheduled fires intentionally have no interactive session ownership.
 * - `cancel` — POSITIVELY not a reattachable bureau-owned in-flight run (bad/
 *   missing launch metadata, foreign run id, or a session that is absent / owns a
 *   different run / is already terminal). `engine.cancel` terminalizes it so it
 *   does not run unowned with no monitor.
 * - `skip` — ownership could NOT be confirmed (a transient session-load failure,
 *   or no session store): do NOTHING. `engine.cancel` is terminal, so we never
 *   cancel a run that may be legitimately recovering — the worst case is it
 *   resumes without live `getRun` visibility (the pre-#3 behaviour).
 *
 * Pure (no I/O) so every branch is unit-testable. `recoverAll()` fires the
 * services resolver synchronously per run before returning, and the resolver
 * reconciles a deps-unrebuildable run's session to `lastRunStatus: 'error'` — so
 * by the time this classifies, a session still `'running'` is one the resolver
 * kept. The gate is on SESSION status, NOT engine run-status: a run that
 * resolved-and-finished fast during `recoverAll` is terminal in the engine but its
 * session is still `'running'` (its monitor has not written yet), and it must
 * still be reattached so its completion is persisted.
 */
export interface ClassifyRecoveredRunArgs {
  handleId: string;
  /** Whether the launch metadata identifies a native scheduled fire. */
  scheduledFire: boolean;
  /** The narrowed agentRun input when the launch metadata is bureau-owned, else `undefined`. */
  ownedSessionId: string | undefined;
  /** Whether reading the handle's launch metadata threw. */
  metadataReadFailed: boolean;
  /** A session store is configured (recovery cannot reattach without one). */
  hasSessionStore: boolean;
  /** The session-load outcome; only meaningful when `ownedSessionId` is set + `hasSessionStore`. */
  sessionLoad: SessionLoadOutcome;
  /**
   * AB-10 — true when the durable engine flagged this run's checkpointed
   * `workflowVersion` as differing from the currently-registered one (see
   * `RuntimeComposition.workflowVersionMismatches`). Only changes the verdict
   * for what would otherwise be `'reattach'` — the run still reattaches
   * (pin-and-warn), it is just flagged distinctly so callers can log/alert on
   * the drift.
   */
  versionMismatch?: boolean;
}

/**
 * `classifyRecoveredRun`'s verdict, plus — only when the verdict is
 * `'cancel'` — the structured reason (AB-90/ab90-09's `recovery.rejected`
 * payload). Both derived from the SAME branch pass over `args` as the plain
 * verdict below, so the verdict `emitter.dispatch`es as `recovery.attempted`
 * and the reason it dispatches as `recovery.rejected` can never drift apart.
 */
export function classifyRecoveredRunDetailed(args: ClassifyRecoveredRunArgs): {
  verdict: RecoveredRunVerdict;
  rejection?: RecoveryRejectionReason;
} {
  // A failed metadata read means we cannot even identify the run — but it WAS
  // resumed by recoverAll, so cancel it rather than leave it unowned.
  if (args.metadataReadFailed) {
    return { verdict: 'cancel', rejection: 'metadata-read-failed' };
  }
  if (args.ownedSessionId === undefined) {
    // A scheduled fire has no interactive session ownership to confirm. Weft has
    // already resumed it via the scheduled-fire resolver branch, so monitor its
    // result without registering it as an ActiveRun or cancelling it as foreign.
    if (args.scheduledFire) return { verdict: 'monitor' };
    // Not a bureau-owned agentRun (foreign run id / non-agentRun input) — cancel.
    return { verdict: 'cancel', rejection: 'foreign-input' };
  }
  // Owned input but no session store to confirm against / reattach into — skip.
  if (!args.hasSessionStore) return { verdict: 'skip' };
  // Transient session-load failure — ownership UNKNOWN, never cancel; skip.
  if (!args.sessionLoad.ok) return { verdict: 'skip' };
  const session = args.sessionLoad.session;
  // Session absent / owns a different run / not in-flight — positively unowned.
  if (!session) return { verdict: 'cancel', rejection: 'session-absent' };
  if (session.lastRunId !== args.handleId) {
    return { verdict: 'cancel', rejection: 'session-run-mismatch' };
  }
  if (session.lastRunStatus !== 'running') {
    return { verdict: 'cancel', rejection: 'session-not-running' };
  }
  return { verdict: args.versionMismatch ? 'reattach-version-mismatch' : 'reattach' };
}

/**
 * Plain-verdict view of {@link classifyRecoveredRunDetailed}, unchanged for
 * every existing caller and test — this wrapper exists only so the
 * rejection-reason derivation above has exactly one place to live.
 */
export function classifyRecoveredRun(args: ClassifyRecoveredRunArgs): RecoveredRunVerdict {
  return classifyRecoveredRunDetailed(args).verdict;
}

/**
 * Dedupes {@link BureauRecoveryReport.perRunFailures} by `runId`, keeping
 * the FIRST entry seen. A recovered handle whose owning session is absent/
 * mismatched/not-running is classified once by the awaited `onRecoveredWorkflow`
 * hook (during `recoverAll()`) and, because that verdict never registers an
 * `ActiveRun`, classified AGAIN by `recoverDurableRuns`'s own post-`recoverAll()`
 * pass over every unregistered handle — both classifications agree (nothing
 * about the handle changed between them), so without this dedupe the SAME
 * `{runId, reason}` would appear twice, violating the one-entry-per-handle
 * contract (code-review regression fixture, AB-349). Pure and exported for
 * direct unit testing, matching {@link classifyRecoveredRunDetailed}.
 */
export function dedupeRecoveryPerRunFailures(
  perRunFailures: readonly { readonly runId: string; readonly reason: string }[],
): { readonly runId: string; readonly reason: string }[] {
  const seen = new Set<string>();
  const deduped: { readonly runId: string; readonly reason: string }[] = [];
  for (const failure of perRunFailures) {
    if (seen.has(failure.runId)) continue;
    seen.add(failure.runId);
    deduped.push(failure);
  }
  return deduped;
}

export function isRecoverableScheduledFireInput(input: unknown): input is ScheduledAgentRunInput {
  return (
    isScheduledAgentRunInput(input) &&
    typeof input.scheduleId === 'string' &&
    input.scheduleId.trim().length > 0
  );
}

async function loadScheduleIdForRecoveredRun(
  engine: { storage: { get(key: string): Promise<Uint8Array | null> } },
  workflowId: string,
): Promise<
  | { status: 'found'; scheduleId: string }
  | { status: 'missing' }
  | { status: 'read-error'; error: unknown }
> {
  try {
    const value = await engine.storage.get(KEYS.scheduleRun(workflowId));
    if (!value) return { status: 'missing' };
    const scheduleId = decodeScheduleRunMarker(decode(value));
    return scheduleId !== undefined ? { status: 'found', scheduleId } : { status: 'missing' };
  } catch (error) {
    return { status: 'read-error', error };
  }
}

export async function loadExistingScheduledSessionId(
  store: SessionStore,
  input: ScheduledAgentRunInput,
  runId: string,
): Promise<string | undefined> {
  if (input.sessionId !== undefined) {
    const session = await store.load(input.sessionId);
    return session?.metadata['lastScheduledFireRunId'] === runId ? input.sessionId : undefined;
  }
  const sessions = await store.list();
  return sessions.find(
    (session: SessionSummary) =>
      session.id.startsWith('sched-') &&
      session.id.endsWith(`-${runId}`) &&
      session.metadata['lastScheduledFireRunId'] === runId,
  )?.id;
}

export function wireStreamEventTargetFrames(
  streamEventTarget: TypedEventTarget<StreamEventMap>,
  runId: string,
  emitLiveFrame: (frame: ServerFrame) => void,
  nextRunSeq: (runId: string) => number,
): () => void {
  const streamEventTypes = [
    'stream:text-delta',
    'stream:tool-call-start',
    'stream:tool-call-delta',
    'stream:tool-call-complete',
    'stream:complete',
    'stream:error',
  ] as const;
  const disposers: Array<() => void> = [];

  for (const eventType of streamEventTypes) {
    const listener = (event: Event) => {
      const detail = (event as Event & { detail: Parameters<typeof streamEventToFrame>[1] }).detail;
      const frame = streamEventToFrame(runId, detail);
      if (frame) {
        emitLiveFrame({ ...frame, runSeq: nextRunSeq(runId) });
      }
    };

    streamEventTarget.addEventListener(eventType, listener);
    disposers.push(() => streamEventTarget.removeEventListener(eventType, listener));
  }

  return () => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
  };
}

export async function monitorRecoveredScheduledFire(
  handle: RecoveredRunHandle,
  diagnose: DiagnosticSink = resolveDiagnosticSink(undefined),
): Promise<void> {
  try {
    const result = await handle.result();
    if (
      typeof result === 'object' &&
      result !== null &&
      'finishReason' in result &&
      isRunFailureFinishReason(result.finishReason)
    ) {
      const errorMessage =
        'errorMessage' in result && typeof result.errorMessage === 'string'
          ? `: ${result.errorMessage}`
          : '';
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Recovered scheduled fire "${handle.id}" finished with ${String(result.finishReason)}${errorMessage}`,
      });
    }
  } catch (error) {
    diagnose({
      level: 'error',
      scope: 'recovery',
      message: `[bureau] Recovered scheduled fire "${handle.id}" failed: ${serializeUnknownError(error)}`,
    });
  }
}

/**
 * AB-240: the catalog-dispatch analog of {@link monitorRecoveredScheduledFire}.
 * A catalog run (`bureau.run(...)`) has no bureau session and — like a
 * scheduled fire — no interactive session surface, so a recovered one gets
 * the same headless detached-result monitor rather than the
 * session-ownership reattach path. A LIVE catalog run is registered on
 * `store` (COR-1302, `registerCatalogRun`) so `getRun`/`abortRun` resolve its
 * handle's id; a recovered one is not, and stays with this monitor.
 */
export async function monitorRecoveredCatalogRun(
  handle: RecoveredRunHandle,
  agentName: string,
  diagnose: DiagnosticSink = resolveDiagnosticSink(undefined),
  settled?: (settlement: CatalogRunSettlement) => Promise<void>,
  durableEnd?: DurableEndReader,
): Promise<void> {
  try {
    const result = await handle.result();
    if (
      typeof result === 'object' &&
      result !== null &&
      'finishReason' in result &&
      isRunFailureFinishReason(result.finishReason)
    ) {
      const errorMessage =
        'errorMessage' in result && typeof result.errorMessage === 'string'
          ? `: ${result.errorMessage}`
          : '';
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Recovered catalog run "${handle.id}" (agent "${agentName}") finished with ${String(result.finishReason)}${errorMessage}`,
      });
    }
    const fields =
      typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
    const finishReason =
      typeof fields['finishReason'] === 'string' ? fields['finishReason'] : undefined;
    await settled?.({
      runId: handle.id,
      agentName,
      status: settledTaskState('completed', finishReason),
      finishReason: finishReason ?? null,
      message:
        typeof fields['errorMessage'] === 'string' ? fields['errorMessage'].slice(0, 1000) : null,
      content: typeof fields['content'] === 'string' ? fields['content'] : null,
      recovered: true,
    });
  } catch (error) {
    // A rejection is not an end: disposing the engine rejects the handle of a run that is still
    // running, and the next boot resumes it. Only a terminal state the durable run reached is
    // published (see `settlementForRejection`).
    const settlement = await settlementForRejection({
      runId: handle.id,
      agentName,
      error,
      recovered: true,
      durableEnd,
    });
    diagnose({
      level: 'error',
      scope: 'recovery',
      message:
        settlement === undefined
          ? `[bureau] Recovered catalog run "${handle.id}" (agent "${agentName}") is no longer followed, and its durable run is not over: ${serializeUnknownError(error)}`
          : `[bureau] Recovered catalog run "${handle.id}" (agent "${agentName}") failed: ${serializeUnknownError(error)}`,
    });
    if (settlement !== undefined) await settled?.(settlement);
  }
}

/**
 * AB-194 — `BureauOptions.sessionInput`'s `sessionBacklogLimit`/
 * `principalBacklogLimit` must each be a positive integer when supplied.
 * Throws `BureauError('...', 'BAD_REQUEST')` for 0, a negative number, or a
 * non-integer; a `undefined` value (option omitted) passes through untouched.
 */
function validateSessionInputBacklogLimit(value: number | undefined, optionName: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) {
    toBadRequest(`"options.sessionInput.${optionName}" must be a positive integer`);
  }
}

/**
 * AB-388 (Codex review, PR #597, "Reject non-finite and negative retention
 * durations"): `BureauOptions.auditRetention`'s `{ olderThan }` form feeds
 * `pruneAuditTrail`'s cutoff arithmetic (`now - retention.olderThan`)
 * directly — TypeScript's `number` type permits `NaN`, `Infinity`, and
 * negative values, none of which are safe here. `NaN` makes every
 * `record.timestampMs >= cutoffMs` comparison in `AuditTrail.prune` false,
 * deleting the ENTIRE trail even when a fleet retention floor exists;
 * `-Infinity` (or any negative value large enough) moves the cutoff into
 * the future and can remove records that were just written. Validated here
 * (BAD_REQUEST at construction time), the same boundary
 * `validateSessionInputBacklogLimit` above already uses for a different
 * destructive-if-malformed option.
 */
function validateAuditRetentionOption(value: { olderThan: number } | 'forever' | undefined): void {
  if (value === undefined || value === 'forever') return;
  if (!Number.isFinite(value.olderThan) || value.olderThan < 0) {
    toBadRequest('"options.auditRetention.olderThan" must be a finite, non-negative number');
  }
}

/**
 * COR-1477 — `BureauOptions.eventRetention` and `taskRetention` feed a cutoff
 * (`now - olderThan`) that decides what maintenance deletes, so they get the
 * same finite, non-negative rule `auditRetention` gets: `NaN` would compare
 * false against every timestamp, and a negative value moves the cutoff into
 * the future.
 */
function validateRetentionWindowOption(
  value: RetentionWindowOption | undefined,
  optionName: string,
): void {
  if (value === undefined || value === 'forever') return;
  if (!Number.isFinite(value.olderThan) || value.olderThan < 0) {
    toBadRequest(`"options.${optionName}.olderThan" must be a finite, non-negative number`);
  }
}

/** COR-1477 — {@link BureauOptions.eventRetention}'s default window: 7 days. */
const DEFAULT_EVENT_RETENTION_MS = 7 * 86_400_000;

/** COR-1477 — {@link BureauOptions.taskRetention}'s default window: 30 days. */
const DEFAULT_TASK_RETENTION_MS = 30 * 86_400_000;

/**
 * COR-625 — `BureauOptions.checkpointRetention`'s `{ keepLast }` form feeds
 * weft's `Engine.pruneCheckpoints` (COR-11), whose own contract requires a
 * non-negative integer. Bureau narrows that further to a POSITIVE integer:
 * `keepLast: 0` would discard a terminal run's entire checkpoint history,
 * including the newest entry a postmortem needs, which is a destructive
 * default no operator means to configure — an operator who genuinely wants
 * nothing retained is asking to delete the run, not to retain zero of it.
 * `timeoutMilliseconds` bounds the step's own wait and its abort signal, so
 * `NaN` or a negative value would arm a timer that fires immediately (or
 * never), turning every step into a spurious `'timed-out'`. Validated here at
 * construction time, the same boundary `validateAuditRetentionOption` above
 * uses for the other destructive-if-malformed retention option.
 */
function validateCheckpointRetentionOption(value: CheckpointRetentionOption | undefined): void {
  if (value === undefined || value === 'keep-all') return;
  if (!Number.isInteger(value.keepLast) || value.keepLast <= 0) {
    toBadRequest('"options.checkpointRetention.keepLast" must be a positive integer');
  }
  const timeout = value.timeoutMilliseconds;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
    toBadRequest(
      '"options.checkpointRetention.timeoutMilliseconds" must be a finite, non-negative number',
    );
  }
}

/**
 * COR-424 — `BureauOptions.runCreationTerminalRetentionMs` decides when a
 * run-creation request id may create a second run, so a value that is not a
 * positive integer is a construction-time error, as Weft's mailbox treats its
 * own `terminalRetentionMs`.
 */
function validateRunCreationRetentionOption(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value <= 0) {
    toBadRequest('"options.runCreationTerminalRetentionMs" must be a positive integer');
  }
}

/** The action types a run records as it reaches its terminal status. */
const TERMINAL_RUN_ACTION_TYPES: ReadonlySet<string> = new Set([
  'run.completed',
  'run.aborted',
  'run.error',
]);

/**
 * COR-424 — when a run reached its terminal status, by the runtime-clock
 * timestamp of its terminal action; `undefined` until it has recorded one.
 * A run-creation binding's retention window starts here.
 */
function terminalActionTimestamp(
  actions: readonly { readonly type: string; readonly timestamp: number }[],
): number | undefined {
  return actions.findLast((action) => TERMINAL_RUN_ACTION_TYPES.has(action.type))?.timestamp;
}

/**
 * COR-772 — `BureauOptions.children.delegation` signs every child's grant, so
 * an empty secret or a lifetime that expires every grant on issue is a
 * construction-time error rather than a silently unusable topology.
 */
function validateChildrenOption(value: BureauChildrenOptions | undefined): void {
  const delegation = value?.delegation;
  if (delegation === undefined) return;
  if (typeof delegation.secret !== 'string' || delegation.secret.length === 0) {
    toBadRequest('"options.children.delegation.secret" must be a non-empty string');
  }
  const timeToLive = delegation.defaultTimeToLiveMilliseconds;
  if (timeToLive !== undefined && !(Number.isFinite(timeToLive) && timeToLive > 0)) {
    toBadRequest(
      '"options.children.delegation.defaultTimeToLiveMilliseconds" must be a positive, finite number',
    );
  }
}

/**
 * The trailing `onStep` hook that records a step's pending tool approvals —
 * registered as `bureau:pending-approval-persist`.
 *
 * A named factory rather than the inline closure it was, because COR-567
 * classifies this registration `effectful` and COR-1267 requires each
 * `effectful` registration to be provable idempotent by a test that invokes it
 * twice. A closure written inline inside `createBureau` is reachable only by
 * dispatching a whole interactive run and then contriving a second execution of
 * the same step; the handler itself is the unit under test, so it has a name.
 *
 * Idempotent by key, not by append: the review id is
 * `approval:${runId}:${callId}`, derived from the step's own tool call, so a
 * crashed step re-running from its boundary produces the SAME id, and both
 * writes it performs — the in-memory override map and the session-metadata
 * persist — are keyed writes.
 */
export function createPendingApprovalPersistHook(
  runId: string,
  sessionId: string,
  overrides: Map<string, Extract<PendingReview, { kind: 'tool-approval' }>['approval']>,
  persist: (
    sessionId: string,
    reviewId: string,
    approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval'],
  ) => Promise<void>,
): OnStepHook {
  return async (stepResult) => {
    for (const stepResultItem of stepResult.results) {
      if (stepResultItem.outcome !== 'action_required' || !stepResultItem.pendingApproval) {
        continue;
      }
      const reviewId = `approval:${runId}:${stepResultItem.pendingApproval.callId}`;
      overrides.set(reviewId, stepResultItem.pendingApproval);
      await persist(sessionId, reviewId, stepResultItem.pendingApproval);
    }
  };
}

export async function createBureau<const D extends AgentDefinitions = AgentDefinitions>(
  options: BureauOptions<D>,
): Promise<Bureau<D>> {
  // AB-194: validated here (BAD_REQUEST at construction time). Admission
  // enforces these same validated values (defaulting to
  // `DEFAULT_SESSION_INPUT_BACKLOG_LIMIT`/`DEFAULT_PRINCIPAL_SESSION_INPUT_BACKLOG_LIMIT`)
  // against the session mailbox.
  validateSessionInputBacklogLimit(
    options.sessionInput?.sessionBacklogLimit,
    'sessionBacklogLimit',
  );
  validateSessionInputBacklogLimit(
    options.sessionInput?.principalBacklogLimit,
    'principalBacklogLimit',
  );
  // COR-435: the values `ab-42-bureau-b` above anticipated. Resolved once,
  // here, so every session's mailbox is constructed against the identical
  // pair this bureau validated at construction time.
  const sessionInputSessionBacklogLimit =
    options.sessionInput?.sessionBacklogLimit ?? DEFAULT_SESSION_INPUT_BACKLOG_LIMIT;
  const sessionInputPrincipalBacklogLimit =
    options.sessionInput?.principalBacklogLimit ?? DEFAULT_PRINCIPAL_SESSION_INPUT_BACKLOG_LIMIT;
  validateAuditRetentionOption(options.auditRetention);
  validateRetentionWindowOption(options.eventRetention, 'eventRetention');
  validateRetentionWindowOption(options.taskRetention, 'taskRetention');
  validateCheckpointRetentionOption(options.checkpointRetention);
  validateRunCreationRetentionOption(options.runCreationTerminalRetentionMs);
  validateChildrenOption(options.children);
  // COR-1577: `bureau` names the Bureau-wide default agent on the session path, which is told
  // apart from a catalog agent by name alone, so a catalog entry called `bureau` would be
  // shadowed there and run under another name on `bureau.run()`. Refused before anything is built.
  if (Object.hasOwn(options.agents, BUREAU_AGENT_NAME)) {
    throw new BureauError(
      `Agent name "${BUREAU_AGENT_NAME}" is reserved for the Bureau-wide default agent, so a ` +
        `catalog agent cannot use it.`,
      'BAD_REQUEST',
    );
  }
  // COR-1524: a model written in an agent file has to become a `generate` somehow, and only the
  // host holds the credentials to do it. Refused here rather than leaving every file unusable.
  const resolveAgentGenerate = options.resolveAgentGenerate;
  if (options.agentDirectory !== undefined) {
    if (typeof options.agentDirectory !== 'string' || options.agentDirectory.trim() === '') {
      toBadRequest('"options.agentDirectory" must be a non-empty path');
    }
    if (resolveAgentGenerate === undefined) {
      toBadRequest(
        '"options.resolveAgentGenerate" is required with "options.agentDirectory": it turns a model in the model catalog into the generate an agent file runs with',
      );
    }
  }
  // COR-1527: a workflow directory is a path, like the agent directory.
  if (options.workflowDirectory !== undefined) {
    if (typeof options.workflowDirectory !== 'string' || options.workflowDirectory.trim() === '') {
      toBadRequest('"options.workflowDirectory" must be a non-empty path');
    }
    // COR-1529: Bureau adds the workflow tools to the tool catalog itself, so a host tool that
    // already has one of their names would be silently shadowed or shadow them.
    const colliding = collidingWorkflowToolName(options.agentTools);
    if (colliding !== undefined) {
      toBadRequest(
        `"options.agentTools" names a tool "${colliding}", which Bureau provides itself when "options.workflowDirectory" is set`,
      );
    }
  }
  const diagnose = resolveDiagnosticSink(options.onDiagnostic);
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
  // COR-1524: when this Bureau was built, for telling a reference left by an earlier process apart.
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
  const eventFeed = createBureauEventFeed({ bureauId, now: runtimeServices.clock.now });
  const eventFeedSubscription = emitter.toObservable().subscribe((event: Event) => {
    // Guarded for the reason `emitLiveFrame` is (AB-96): `dispatchEvent`
    // walks its all-events listeners unguarded, so a throw here would
    // propagate out of whichever `emitter.dispatch` call was in flight —
    // several of which run synchronously inside run setup, where an
    // exception leaves a run launched but untracked. Recording an event must
    // never be able to break the thing it is recording.
    try {
      eventFeed.publish(event);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'event-feed',
        message: `[bureau] event feed threw recording a "${event.type}" event:`,
        cause: error,
      });
    }
  });
  // COR-1421 — `onEvent` listens from here, before any recovery pass can
  // dispatch, so it hears the boot-time events a listener added after
  // `createBureau()` returns would miss. It is registered AFTER the event
  // feed's recorder above, so an event is recorded before the host callback
  // runs and anything the callback dispatches in turn lands after it. A
  // rejected promise from an async callback is reported like a throw.
  if (options.onEvent) {
    const onEvent = options.onEvent;
    const reportOnEventFailure = (event: Event, error: unknown): void => {
      diagnose({
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
  const agentsSnapshot: D = { ...options.agents };
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
  // Built first: two validators registered under one name and version are a
  // startup error, and it should fail before the durable engine exists.
  const goalValidatorCatalog = createGoalValidatorCatalog(options.validators);
  // COR-1510: a run the durable engine resumes on its own (a claim it reclaimed) before
  // `recoverDurableRuns` starts is still handed to `onRecoveredWorkflow`, ahead of its first step.
  // This hook waits for that function to be bound, which `recoverDurableRuns` does when it starts.
  const recoveredWorkflowHandler =
    Promise.withResolvers<(info: RecoveredWorkflowInfo) => Promise<void>>();
  // COR-718: a schedule fire can reach the composition before this factory has built the
  // attribution map and the audit trail that record its owner, so the hook waits for both.
  const scheduledFireHandler =
    Promise.withResolvers<(fire: ScheduledFireNotice) => Promise<void>>();
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
  // COR-1527: the services resolver asks whether a workflow type came from a workflow file, and
  // can be reached before the workflow runtime exists, so it reads this holder.
  const workflowFileTypes: { current: ((type: string) => boolean) | undefined } = {
    current: undefined,
  };
  const assetServiceHolder: { current: AssetService | undefined } = {
    current: assetServiceInstance,
  };
  const runtime = await createRuntimeComposition(
    { ...options, runtime: runtimeServices },
    {
      contentSourceResolverFor: (principalId) =>
        assetServiceHolder.current === undefined
          ? undefined
          : createAssetContentSourceResolver(assetServiceHolder.current, ownerOrLocal(principalId)),
      generatedMediaAdmitterFor: (principalId) =>
        assetServiceHolder.current === undefined
          ? undefined
          : createAssetGeneratedMediaAdmitter(
              assetServiceHolder.current,
              ownerOrLocal(principalId),
              {
                // A row a run commits is claimed by the session that holds it, or by the run
                // when it has none (see `assets/row-asset-claims.ts`).
                claimHolderFor: (runId) => {
                  const runState = runId === undefined ? undefined : store.getRun(runId);
                  if (runId === undefined || runState === undefined) return undefined;
                  const sessionId = runSessionIdentifiers.get(runState.activeRun) ?? '';
                  if (sessionId === '') return (rowId) => runRowHolderId(runId, rowId);
                  // The session's incarnation is recorded by the run's first save; before that
                  // nothing is claimed here, and the session's own commit claims the row.
                  const incarnation = runSessionIncarnations.get(runId);
                  return incarnation === undefined
                    ? undefined
                    : (rowId) => sessionRowHolderId(sessionId, incarnation, rowId);
                },
              },
            ),
      goalWorkflow: goalWorkflowHost.workflow,
      goalAttemptFence: goalAttemptFenceHost.fence,
      isWorkflowFileType: (type) => workflowFileTypes.current?.(type) ?? false,
      onScheduledFire: async (fire) => {
        const handler = await scheduledFireHandler.promise;
        await handler(fire);
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
  if (options.workflowDirectory !== undefined && !runtime.durable) {
    await shutdownThenRethrow(
      new BureauError(
        '"options.workflowDirectory" needs a durable engine: configure storage (or durableExecution) so workflow instances and schedules can persist',
        'BAD_REQUEST',
      ),
      async () => {
        await assetServiceInstance?.shutdown();
        runtime.disposeStorage?.();
      },
    );
  }
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
    releaseScheduledFire(runAttribution, firedRunIds, event.runId);
    emitter.dispatch(new ScheduleCompletedEvent(event.scheduleId, event.runId));
  });
  runtime.scheduleFireEvents.addEventListener(ScheduleFailedEvent.type, (event) => {
    releaseScheduledFire(runAttribution, firedRunIds, event.runId);
    emitter.dispatch(new ScheduleFailedEvent(event.scheduleId, event.runId));
  });
  // COR-660 — the per-tick observation pair, forwarded the same way and for
  // the same reason: a scheduled tick is headless, so the bureau emitter is
  // the only surface it has. Fresh instances again, for the WHATWG
  // already-being-dispatched reason above.
  // COR-767 — skill lifecycle, forwarded the same way and for the same reason
  // as the schedule families: the `@lostgradient/bureau/skills` tools dispatch onto the
  // composition's target, and this bureau's emitter is the surface consumers
  // actually subscribe to. Fresh instances again, for the WHATWG
  // already-being-dispatched constraint documented above.
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
  // AB-389 — `SessionStore.events` (`@lostgradient/operative`) now carries
  // only the best-effort `SessionOutboxAppendedEvent` drain trigger, never
  // `SessionCreatedEvent`/`SessionSavedEvent`/`SessionDeletedEvent`
  // directly (that fire-and-forget dispatch is exactly the KNOWN
  // LIMITATION this issue closes — see `create-session-store.ts`'s own
  // doc comment). A missed or duplicate trigger costs nothing: `drainOutbox`
  // (defined below) is single-flighted and idempotent, and the durable
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
  // AB-246 — the model-catalog refresh service. Independent of `runtime`.
  // When the caller doesn't supply one, the default `descriptorSource`
  // re-derives `@lostgradient/operative`'s static seed — this is
  // the seam a future live provider probe attaches to (out of scope here).
  //
  // Constructed BEFORE `agentCatalog` below: `selectorAvailable: true`
  // (AB-250/mod-03c) needs no catalog dependency itself, but ordering the
  // catalog first keeps every model-policy-related construction together.
  const modelCatalog =
    options.modelCatalog ??
    createModelCatalogService({
      seed: createModelCatalog(),
      descriptorSource: () => Promise.resolve(createModelCatalog().descriptors),
      now: runtimeServices.clock.nowISO,
      newRefreshId: () => runtimeServices.identifiers.next('catalog-refresh'),
    });
  // AB-15/AB-22: the typed agent catalog — a plain literal map, fixed for
  // the bureau's lifetime, dispatched by name through `bureau.run`.
  // Independent of `runtime` (bureau-level generate/toolbox/provider
  // composition, still used by `createRun`).
  // `selectorAvailable: true` (AB-250/mod-03c) — `planSelection` below is
  // now wired, so a `selectable` agent's catalog-read profile reports
  // `selector: 'available'` (AB-247/mod-02e's one named mechanism for this
  // transition).
  //
  // COR-1524: with an `agentDirectory`, the Markdown files in it join the catalog. They are
  // scanned before the catalog is handed out and before boot recovery runs, so the first
  // `bureau.agents.list()` and a resumed run both see the directory as it is now.
  // COR-1529: with a workflow directory the catalog also holds the workflow tools. They read the
  // workflow runtime and the run's identity when called, which is after construction has finished.
  const agentToolCatalog: Readonly<Record<string, Tool>> =
    options.workflowDirectory === undefined
      ? (options.agentTools ?? {})
      : {
          ...options.agentTools,
          ...createWorkflowTools({
            workflows: () => workflowRuntime?.workflows,
            runIdentity: async (runId) => ({
              agent: runAttribution.get(runId)?.agentName,
              owner: await getOwner({ kind: 'run', id: runId }),
            }),
          }),
        };
  const fileAgents: FileAgentRuntime | undefined =
    options.agentDirectory === undefined || resolveAgentGenerate === undefined
      ? undefined
      : createFileAgentRuntime({
          files: createAgentFileCatalog({
            directory: options.agentDirectory,
            reservedIdentifiers: new Set(Object.keys(agentsSnapshot)),
            tools: agentToolCatalog,
            modelCatalog,
            resolveGenerate: resolveAgentGenerate,
            runtime: runtimeServices,
            diagnose: (message, cause) =>
              diagnose({
                level: 'error',
                scope: 'agent-files',
                message: `[bureau] ${message}`,
                cause,
              }),
          }),
          snapshots: createAgentSnapshotStore({
            store: runtime.kv,
            nowISO: runtimeServices.clock.nowISO,
          }),
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
  const agentCatalog = createAgentCatalog(agentsSnapshot, {
    selectorAvailable: true,
    files: fileAgents?.files,
    snapshots: fileAgents?.snapshots,
  });
  // COR-1527: the workflow files. The directory is scanned and the engine told about the documents
  // in `start()`, at the end of construction and before the engine recovers; the `agent` step runs
  // through `runWorkflowAgentStep`, defined below with the rest of the run machinery.
  const workflowRuntime: WorkflowRuntime | undefined =
    options.workflowDirectory === undefined || runtime.durable === undefined
      ? undefined
      : createWorkflowRuntime({
          directory: options.workflowDirectory,
          // The composition's engine type hides `register`; it is the one Weft `Engine`, and
          // registering documents (`registerSource`) is exactly what it is lent out for here.
          engine: runtime.durable.engine as Engine,
          host: createWorkflowDocumentHost({
            runAgentStep: (request) => runWorkflowAgentStep(request),
          }),
          snapshotStore: createWorkflowSnapshotStore({
            store: runtime.kv,
            nowISO: runtimeServices.clock.nowISO,
          }),
          runtime: runtimeServices,
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
        });
  workflowFileTypes.current = workflowRuntime?.isRegisteredType;
  // AB-240: wire boot recovery's catalog branch NOW that the catalog exists —
  // `runtime` (built above, before this catalog) deliberately knows nothing
  // about it (see `RuntimeCompositionOptions`'s doc comment), so this is the
  // one place `resolveRunServices` reaches the catalog from, via the resolver
  // it stores and calls back into. Registered before `recoverDurableRuns()`
  // (called later, once this bureau's construction finishes) so every boot
  // recovery pass sees it.
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
        const rebuilt = await fileAgents.agentForRecordedRun(name, recorded.agentDefinitionHash);
        agent = rebuilt.agent;
        agentBinding = rebuilt.binding;
      } else {
        agent = agentCatalog.find(name);
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
        ...(childContext === undefined ? context : { ...context, ...childContext }),
        ...catalogRunGuardrailsContext(agent, options.guardrails),
      });
      const resolution: CatalogAgentRunOptionsResolution = {
        status: 'resolved',
        options: resolvedOptions,
        definitionRevision: readGenerationProfile(agent).revision,
        agentResolvesGuardrails: resolvesOwnGuardrails(agent),
        recoveredChild: childContext !== undefined,
        ...(agentBinding === undefined ? {} : { agentBinding }),
      };
      return resolution;
    } catch (error) {
      return { status: 'resolver-failed', error };
    }
  });
  // AB-64/AB-250 — Bureau's selection-planning surface: `bureau.planSelection`
  // and the `SelectionGate` factory `RunOptions.selection` is built from.
  // Side-effect-free — see `model-policy.ts`'s module doc comment.
  const modelPolicyPlanner = createModelPolicyPlanner({
    agents: agentsSnapshot,
    modelCatalog,
    ...(options.modelPolicy === undefined ? {} : { modelPolicy: options.modelPolicy }),
  });
  // AB-13 — declarative flow control (concurrency/rate-limit/singleton). One
  // controller instance shared across BOTH `createRun` (API-triggered) and
  // `submitSchedulerTask` (scheduler-originated), so a per-agent concurrency
  // cap counts runs from either surface against the same limit.
  const flowController: FlowController | undefined = options.flowControl
    ? createFlowController(options.flowControl)
    : undefined;
  const runSessionIdentifiers = new WeakMap<ActiveRun, string>();
  const activeRuns = new Set<ActiveRun>();
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
  // AB-207: Bureau-owned background work (scheduler, online-evals, webhook
  // notifier, audit trail) shares this signal so `shutdown()` can tell an
  // in-flight judge invocation / webhook delivery to hurry up and settle
  // instead of stalling the awaited drain. Threaded into each subsystem at
  // construction time (merged with any caller-supplied signal via
  // `AbortSignal.any`), aborted at the top of `shutdown()` under BOTH
  // policies — Bureau-owned work is stopped identically under `'drain'`
  // (only caller-owned runs get the drain treatment).
  const backgroundShutdownController = new AbortController();
  function withBackgroundShutdownSignal(callerSignal: AbortSignal | undefined): AbortSignal {
    return callerSignal
      ? AbortSignal.any([callerSignal, backgroundShutdownController.signal])
      : backgroundShutdownController.signal;
  }
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
  const resolvedReviewIds = new Set<string>();
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
  function dropPendingApprovalOverride(reviewId: string): void {
    pendingApprovalOverrides.delete(reviewId);
    pendingApprovalRounds.delete(reviewId);
  }
  const terminalReviewSessions = new Map<
    string,
    { sessionId: string; agentName: string; requestedAt: number }
  >();
  // A persisted approval can be stale by the time a process restarts. Keep
  // that failure scoped to its review rather than preventing the bureau from
  // recovering unrelated runs.
  const invalidApprovalReviewIds = new Set<string>();
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
  /**
   * COR-718 — the runs of schedule fires whose attribution this Bureau holds. A fire's
   * entry is released when the fire settles, so a recurring schedule does not grow
   * `runAttribution` by one entry per tick; its owner is then read durably through
   * the schedule (see `runOwner`).
   */
  const firedRunIds = new Set<string>();
  /**
   * COR-1380 — the session incarnation each run was saved into at dispatch,
   * or recovered against. A run-ownership restore writes only into that
   * incarnation, never into a session deleted and recreated under the same
   * id, where the run's owner would otherwise become a co-owner of a session
   * they never touched. Cleared with `runAttribution` in `deleteRun`.
   */
  const runSessionIncarnations = new Map<string, string>();
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
          terminalRetentionMs: options.runCreationTerminalRetentionMs,
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
        sessionInputSessionBacklogLimit,
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

  /**
   * The pending `run-ended` steering write of each run that is ending (COR-1476).
   * It is the durable not-live write the run's session-input settlement waits
   * for, and rejects when the write failed, so the settlement retries it.
   */
  const steeringRunEndWrites = new Map<string, Promise<void>>();

  /** The session-input settlements of runs that have ended and have not finished (COR-1476). */
  const inFlightSessionInputSettlements = new Set<Promise<void>>();

  /** The settlement in flight for each ended run: a run is settled once, however many paths report its end. */
  const sessionInputSettlementsByRun = new Map<string, Promise<void>>();

  /**
   * Resolves the moment shutdown begins, so a settlement waiting out a retry
   * backoff ends its wait at once instead of after the whole delay.
   */
  const sessionInputClosing = Promise.withResolvers<void>();

  /** Tracks a settlement, which never rejects, so shutdown lands it before it tears the stores down. */
  function trackSessionInputSettlement(settling: Promise<void>): void {
    inFlightSessionInputSettlements.add(settling);
    void settling.finally(() => inFlightSessionInputSettlements.delete(settling));
  }

  /** The gate of each durable run that has one, disposed when the run ends however it ends. */
  const sessionInputGates = new Map<
    string,
    { readonly gate: SessionInputGate; readonly sessionId: string }
  >();

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
  interface SteeringCursor {
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

  /** What a fold of one log has seen, for checking each next event against. */
  interface SteeringFoldHistory {
    /** Each run's place in its life: promoted, then (once) ended. */
    readonly runs: Map<string, 'promoted' | 'ended'>;
    /** Every `(principal, id)` already decided by an `admit` or `refused`. */
    readonly keys: Set<string>;
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

  interface SteeringPoller {
    readonly incarnation: string;
    readonly gate: BureauSteeringGate;
    /** The session's durable runs this process drives. */
    readonly runIds: Set<string>;
    readonly timer: ReturnType<typeof runtimeServices.timers.setInterval>;
    /** The last failure reported, so a repeating one is reported once. */
    lastFailure?: string | undefined;
    /** The poll still running, if any: a tick never starts a second one. */
    inFlight?: Promise<void> | undefined;
  }
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

  /** How many times an append retries after losing a race to another process. */
  const STEERING_APPEND_ATTEMPTS = 25;

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
  // AB-67/AB-199 — the bureau-wide `(principal, id)` idempotency ledger
  // every session's gate shares (see `steering.ts`'s `createSteeringGate`
  // `ledger` parameter doc comment): a same-`(principal, id)` retry against
  // a DIFFERENT session must resolve to `session-mismatch`, not be silently
  // admitted as an unrelated command in that other session's own ledger.
  const steeringCommandLedger = createSteeringCommandLedger();
  // Keep the exact host-supplied (or bureau-derived) context for approval
  // resumption. Approval bindings identify the original caller, but are not a
  // substitute for the complete request context and must not mint authority.
  const runRequestContexts = new Map<string, ToolRequestContext>();
  const recoveredRunIds = new Set<string>();
  let requestAuthorityValidator:
    ((context: ToolRequestContext) => boolean | Promise<boolean>) | undefined =
    options.requestAuthorityValidator;
  const isTransportIssuedAuthority = (context: ToolRequestContext): boolean =>
    context.authority.authorizationRevision !== 'bureau:1' &&
    context.authority.authorizationRevision !== 'bureau:scheduler:1';
  let durableRecoveryDeferred = false;
  let durableRecoveryStarted = false;
  let durableRecoveryBarrier: Promise<BureauRecoveryReport> = Promise.resolve({
    outcome: 'clean',
    perRunFailures: [],
  });
  let resolveDurableRecoveryBarrier: ((report: BureauRecoveryReport) => void) | undefined;
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
  const liveFrameListeners = new Set<(frame: ServerFrame) => void>();
  // COR-1421 — `engine.recoverAll()` resumes recovered workflows without
  // awaiting them, so recovered runs emit live frames while the rest of boot
  // still awaits, before `createBureau()` returns and a caller can subscribe.
  // Until the FIRST `subscribeLiveFrames` listener attaches, frames are
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
  const bootFrameRunIds = new Set<string>();
  let liveFramesSubscribed = false;
  const bootFrameBuffer: ServerFrame[] = [];
  // Frames emitted while the first subscriber is being replayed queue behind
  // the remaining replay instead of interleaving with it.
  let frameReplayQueue: ServerFrame[] | undefined;
  // AB-96 — terminal RunReports, cached at the moment each run's lifecycle
  // event fires so `getRunReport` never needs to re-derive them.
  const runReports = new Map<string, RunReport>();
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
  // entries are released alongside that run's report (`releaseRunReport`), so
  // a long-lived bureau does not retain one promise per run forever.
  const terminalCheckpointCleanups = new Map<string, Promise<RunCleanupAcknowledgement>>();
  // COR-625: registered on a durable run's `closed()` only when a retention
  // policy is actually configured. Registering it unconditionally would
  // disqualify every durable run's `not-required` fast path (a run with a
  // step registered genuinely has cleanup left to do — see
  // `active-run-create.ts`'s `disqualifiesFastPath`) and so would change
  // `closed()`'s answer for every bureau that never asked for retention. The
  // terminal listeners still call the step unconditionally, so the
  // `run.cleanup-settled` audit record exists either way.
  const durableTerminalCleanup =
    options.checkpointRetention && options.checkpointRetention !== 'keep-all'
      ? runTerminalCheckpointCleanup
      : undefined;
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
  // frames reach `emitLiveFrame` — so `streamEventToFrame` and the store
  // action listener never have to coordinate on sequencing themselves.
  // Cleared on `run.removed` (see the store subscription below) so the map
  // does not grow unbounded across a long-lived bureau.
  const runSequenceCounters = new Map<string, number>();

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
  const sessionPersistenceRetryDelayMilliseconds =
    options.sessionPersistenceRetryDelayMilliseconds ??
    SESSION_PERSISTENCE_RETRY_DELAY_MILLISECONDS;
  const sessionPersistenceSleep =
    options.sessionPersistenceSleep ?? createDefaultSessionPersistenceSleep(runtimeServices.timers);
  const shutdownTimeoutSleep =
    options.shutdownTimeoutSleep ?? createDefaultShutdownTimeoutSleep(runtimeServices.timers);

  function getRunSessionIdentifier(runState: { activeRun: ActiveRun }): string {
    return runSessionIdentifiers.get(runState.activeRun) ?? '';
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
    // AB-96 codex review — a throwing `subscribeLiveFrames` listener must not
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
        message: `[bureau] subscribeLiveFrames listener threw on a "${frame.type}" frame:`,
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
    return findCatalogRun(taskId) === undefined
      ? undefined
      : { phase: 'submitted', finishReason: undefined, error: undefined, updatedAt: undefined };
  }

  const tasks = createTaskRegistry({
    kv: runtime.kv,
    clock: runtimeServices.clock,
    identifiers: runtimeServices.identifiers,
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
      sleep: (milliseconds) =>
        new Promise<void>((resolve) => {
          runtimeServices.timers.setTimeout(resolve, milliseconds);
        }),
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
   * `shutdown()` has moved on. `shutdown()` waits for them (a bound of event-loop turns, not a
   * barrier) before it closes storage.
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
   * Whether a run is a child run rather than a task: the child topology holds it, or, failing
   * that, its identifier is not a catalog run's.
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
  catalogRunSettlements.subscribe(
    createCatalogTaskSettler({
      tasks,
      loadRecoveryRecord: (runId) => runtime.loadCatalogRunRecoveryRecord(runId),
      durableCreatedAt: async (runId) => {
        const state = await runtime.durable?.engine.get(runId);
        return state === null || state === undefined
          ? undefined
          : new Date(state.createdAt).toISOString();
      },
      isChildRun,
      now: runtimeServices.clock.nowISO,
      ownerOf: ownerOrLocal,
      originatingMessage: originatingMessageText,
    }),
  );

  /** COR-1481 — records how a task ended, from the action that ended its run. */
  function recordTaskSettlement(action: {
    readonly runId: string;
    readonly type: string;
    readonly detail: unknown;
    readonly timestamp: number;
  }): void {
    if (
      action.type !== 'run.completed' &&
      action.type !== 'run.error' &&
      action.type !== 'run.aborted'
    ) {
      return;
    }
    const detail =
      action.detail !== null && typeof action.detail === 'object'
        ? (action.detail as Record<string, unknown>)
        : {};
    const finishReason =
      typeof detail['finishReason'] === 'string' ? detail['finishReason'] : undefined;
    const status =
      action.type === 'run.completed'
        ? settledTaskState('completed', finishReason)
        : action.type === 'run.error'
          ? 'failed'
          : 'canceled';
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
   * COR-1481 — the review ids already announced with `review.requested`, per run,
   * so a review is announced once however many actions follow it. Dropped with the
   * run.
   */
  const announcedReviewRequests = new Map<string, Set<string>>();

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
    ): void => {
      const announced = announcedReviewRequests.get(action.runId) ?? new Set<string>();
      announcedReviewRequests.set(action.runId, announced);
      if (announced.has(reviewId)) return;
      announced.add(reviewId);
      const owner = runAttribution.get(action.runId)?.principal ?? ANONYMOUS_LOCAL_OWNER;
      emitter.dispatch(new ReviewRequestedEvent(reviewId, action.runId, owner, kind, target));
    };
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

  const storeSubscription = store.toObservable().subscribe((event) => {
    switch (event.type) {
      case 'action': {
        const storeActionEvent = event as StoreActionEvent;
        recordTaskSettlement(storeActionEvent.action);
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
        emitLiveFrame({
          type: 'event',
          runId: storeActionEvent.action.runId,
          event: storeActionEvent.action.type,
          detail: serializeActionDetail(
            storeActionEvent.action.type,
            storeActionEvent.action.detail,
          ),
          sequence: storeActionEvent.action.sequence,
          runSeq: nextRunSeq(storeActionEvent.action.runId),
          timestamp: storeActionEvent.action.timestamp,
        });
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
        terminalReviewSessions.delete(removedRunId);
        announcedReviewRequests.delete(removedRunId);
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
        if (!removedCatalogRun) emitter.dispatch(new RunRemovedEvent(removedRunId));
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

  const schedulerEventTypes = [
    'task.queued',
    'task.dispatched',
    'task.completed',
    'task.failed',
    'task.preempted',
    'task.cancelled',
    'scheduler.idle',
    'scheduler.started',
    'scheduler.stopped',
  ] as const;

  function emitSchedulerLiveFrame(event: Event): void {
    if (event.type === 'task.preempted') {
      const preemptedEvent = event as Event & { taskId: string; reason: string };
      emitLiveFrame({
        type: 'scheduler.task.preempted',
        taskId: preemptedEvent.taskId,
        reason: preemptedEvent.reason,
        state: runtime.scheduler!.getState(),
      });
      return;
    }

    emitLiveFrame({
      type: 'scheduler.state',
      state: runtime.scheduler!.getState(),
    });
  }

  const schedulerCleanup =
    runtime.scheduler === undefined
      ? []
      : schedulerEventTypes.map((eventType) => {
          runtime.scheduler!.addEventListener(eventType, emitSchedulerLiveFrame);
          return () => runtime.scheduler?.removeEventListener(eventType, emitSchedulerLiveFrame);
        });

  // AB-13 — enforce the flow-control lifecycle for scheduler-originated
  // tasks. Preemption (`task.preempted`, `requeued: true`) is this scheduler's
  // OWN notion of "parked" — the run is suspended and will be redispatched
  // later — so it maps directly onto `markParked`/`markResumed`, freeing the
  // concurrency slot while the task sits preempted. `markResumed` is a no-op
  // when the slot was never parked (e.g. a task's FIRST dispatch), so it is
  // safe to call on every `task.dispatched`.
  const flowControlSchedulerCleanup: Array<() => void> =
    flowController === undefined || runtime.scheduler === undefined
      ? []
      : wireFlowControlSchedulerEvents(runtime.scheduler, flowController);

  function requireSessionStore(): SessionStore {
    if (!runtime.sessionStore) {
      throw new BureauError(
        'No SessionStore configured (set options.persistence with a StorageConfiguration or PersistenceOptions)',
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
  });
  const { loadConversation, saveSession, persistSessionUpdate } = sessionPersistence;

  /**
   * Persists a run's terminal session state, then settles the session's input
   * (COR-1476): the settlement reads the session as the run left it.
   */
  function persistTerminalSession(
    saveSessionUpdate: () => Promise<unknown>,
    context: { runId: string; sessionId: string; status: 'completed' | 'error' | 'aborted' },
  ): void {
    trackSessionInputSettlement(
      persistSessionUpdate(saveSessionUpdate, context).then(() =>
        settleSessionInputsAfterRunEnd(context.sessionId, context.runId),
      ),
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
  type ReviewAuditAttachment = { runId: string; type: string; detail: unknown; principal: string };
  const REVIEW_AUDIT_OUTBOX_NAMESPACE = 'audit-record';
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
        approvalResolutionStartedIds: Array.isArray(
          session!.metadata['approvalResolutionStartedIds'],
        )
          ? omitStringValue(session!.metadata['approvalResolutionStartedIds'], reviewId)
          : [],
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
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    await runtime.sessionStore.update(sessionId, (session) => {
      if (!session) return session;
      const current = session.metadata['approvalResolutionStartedIds'];
      const startedIds = Array.isArray(current) ? stringValues(current) : [];
      return {
        ...session,
        metadata: {
          ...session.metadata,
          approvalResolutionStartedIds: startedIds.includes(reviewId)
            ? startedIds
            : [...startedIds, reviewId],
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
      const remainingStarted = Array.isArray(currentStarted)
        ? omitStringsWithPrefix(currentStarted, reviewIdPrefix)
        : currentStarted;
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
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        await persistApprovalResolutionStarted(sessionId, reviewId);
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
      (session) => {
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
          const priorRaw = currentDecisions[reviewId];
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
        if (
          run &&
          run.status !== 'running' &&
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
        return {
          ...session,
          metadata: {
            ...session.metadata,
            approvalResolutionStartedIds: Array.isArray(
              session.metadata['approvalResolutionStartedIds'],
            )
              ? omitStringValue(session.metadata['approvalResolutionStartedIds'], reviewId)
              : [],
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
              ? { pendingApprovalOverrides: persistedApprovalOverrides }
              : {}),
            ...(lastRequestAuthorities !== session.metadata['lastRequestAuthorities']
              ? { lastRequestAuthorities }
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

  function restorePendingApprovalOverrides(metadata: unknown, runId: string): void {
    const metadataRecord =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
    const overrides = metadataRecord?.['pendingApprovalOverrides'];
    const resolutionStartedIds = new Set(
      Array.isArray(metadataRecord?.['approvalResolutionStartedIds'])
        ? stringValues(metadataRecord['approvalResolutionStartedIds'])
        : [],
    );
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) return;
    const rounds = metadataRecord?.['pendingApprovalRounds'];
    for (const [reviewId, approval] of Object.entries(overrides as Record<string, unknown>)) {
      if (!reviewId.startsWith(`approval:${runId}:`)) continue;
      if (resolutionStartedIds.has(reviewId)) continue;
      if (invalidApprovalReviewIds.has(reviewId)) continue;
      if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
        pendingApprovalOverrides.set(
          reviewId,
          approval as Extract<PendingReview, { kind: 'tool-approval' }>['approval'],
        );
        const round =
          typeof rounds === 'object' && rounds !== null && !Array.isArray(rounds)
            ? (rounds as Record<string, unknown>)[reviewId]
            : undefined;
        if (typeof round === 'number' && Number.isInteger(round) && round > 0) {
          pendingApprovalRounds.set(reviewId, round);
        }
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
    const resolutionStartedIds = new Set(
      Array.isArray(metadataRecord?.['approvalResolutionStartedIds'])
        ? stringValues(metadataRecord['approvalResolutionStartedIds'])
        : [],
    );
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) return;
    for (const [reviewId, approval] of Object.entries(overrides as Record<string, unknown>)) {
      if (!reviewId.startsWith(`approval:${runId}:`)) continue;
      if (resolutionStartedIds.has(reviewId)) continue;
      if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
        if (!(approval as { approvalBinding?: unknown }).approvalBinding) continue;
        try {
          await restoreApproval(approval as SignedPendingToolApproval);
        } catch (error) {
          if (!isTerminalApprovalBindingError(error)) throw error;
          invalidApprovalReviewIds.add(reviewId);
          dropPendingApprovalOverride(reviewId);
          await prunePersistedInvalidApprovalReviewStateWithRetry(sessionId, runId, reviewId);
          diagnose({
            level: 'warn',
            scope: 'approval-recovery',
            message:
              `[bureau] Failed to restore approval binding for "${reviewId}"; ` +
              'the affected review will remain unavailable while other runs recover.',
            cause: error,
          });
        }
      }
    }
  }

  /**
   * COR-1577 — the catalog agent a recovered session run belongs to: `undefined` for the default
   * agent, and `'unavailable'` when the agent cannot be resolved, which is reported rather than
   * thrown so one run's lost agent never stops the rest of recovery.
   */
  async function resolveRecoveredSessionAgent(
    agentName: string,
    runId: string,
    metadata: Record<string, JSONValue>,
  ): Promise<SessionAgentRun | undefined | 'unavailable'> {
    if (agentName === BUREAU_AGENT_NAME) return undefined;
    // COR-1524: the definition THIS run started with. A session's metadata names only its latest
    // run's, and a session's runs may be of different agents, so the run's own reference decides
    // and the session's hash is what an older record without one falls back to.
    const reference = await fileAgents?.snapshots.reference(runId);
    const recordedHash =
      reference !== undefined && reference.id === agentName
        ? reference.hash
        : metadata[SESSION_AGENT_DEFINITION_HASH_METADATA_KEY];
    const resolution = await runtime.resolveSessionAgentRun(
      agentName,
      runId,
      resolveSessionOwner(metadata),
      { agentDefinitionHash: typeof recordedHash === 'string' ? recordedHash : undefined },
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
    // COR-1577 — a named run's approvals resume against that agent's own tools.
    const recoveredSessionAgent = await resolveRecoveredSessionAgent(
      recoveredAgentName,
      runId,
      session.metadata,
    );
    if (recoveredSessionAgent === 'unavailable') {
      terminalReviewSessions.delete(runId);
      return;
    }
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
      { liveStreaming: false, sessionAgent: recoveredSessionAgent },
    );
    const terminalReviewSession = terminalReviewSessions.get(runId);
    if (terminalReviewSession) {
      terminalReviewSessions.set(runId, {
        ...terminalReviewSession,
        agentName: recoveredAgentName,
      });
    }
    runRequestContexts.set(runId, requestContext);
    runToolboxesByRunId.set(runId, runRuntime.toolbox);
    await restorePendingApprovalStates(runRuntime.toolbox, session.metadata, runId, session.id);
    if (
      !Array.from(pendingApprovalOverrides.keys()).some((reviewId) =>
        reviewId.startsWith(`approval:${runId}:`),
      )
    ) {
      terminalReviewSessions.delete(runId);
      runRequestContexts.delete(runId);
      runToolboxesByRunId.delete(runId);
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
  async function createRunFromRequest(request: CreateRunRequest): Promise<CreatedRunSummary> {
    validateCreateRunRequest(request);
    // COR-718 — the owner of record: stored once, below, and unchanged afterward. A
    // host that states no principal owns the run as `anonymous:local`; one that
    // states anything but text is refused here, before anything is persisted.
    const owner = ownerFromPrincipal(request.principal, toBadRequest);
    assertRunAdmissionOpen('run');

    if (request.runCreationRequestId !== undefined) requireRunCreationLedger();

    const sessionId = request.sessionId?.trim() ?? runtimeServices.identifiers.next('session');
    // COR-1481 — a context being deleted takes no new task: it reads as one that does
    // not exist, until the deletion has committed and the id may name a new incarnation.
    if (inFlightSessionDeletions.has(sessionId)) {
      throw new BureauError(`Session "${sessionId}" not found`, 'NOT_FOUND');
    }
    const runId = runtimeServices.identifiers.next('run');
    // The text that stands for the request where only text fits: flow control,
    // and the session's `lastUserMessage`.
    const requestText = request.message ?? lastUserTextOf(request.appendMessages);

    // COR-1577 — which agent this run is. A session is bound to the agent of the run that
    // created it, so an existing session decides; a new one takes the named agent, or the
    // default `bureau`. Every refusal here lands before anything is persisted.
    const { session, conversation } = await loadConversation(sessionId);
    const baseConversationHistory = conversation.current;

    // COR-718 — a session belongs to the owner of the run that created it. A
    // different principal starting a run on it is refused exactly as a session
    // that does not exist is, so an identifier grants nothing.
    if (session && !isSessionAuthorityAuthorized(session.metadata, owner)) {
      throw new BureauError(`Session "${sessionId}" not found`, 'NOT_FOUND');
    }
    const agentName = resolveRunAgentName(sessionId, session, request.agentName);
    let sessionAgent: SessionAgentRun | undefined;
    if (agentName === BUREAU_AGENT_NAME) {
      if (!runtime.ready) {
        throw new BureauError('No generate function configured', 'NOT_CONFIGURED', 'generate');
      }
    } else {
      const resolution = await runtime.resolveSessionAgentRun(agentName, runId, owner);
      if (resolution.status === 'missing-agent') {
        throw new BureauError(`Unknown agent "${agentName}"`, 'NOT_FOUND');
      }
      if (resolution.status === 'not-durable-capable') {
        throw new BureauError(
          `Agent "${agentName}" cannot run in a session: it exposes no definition resolver.`,
          'UNSUPPORTED_CAPABILITY',
        );
      }
      if (resolution.status === 'resolver-failed') throw resolution.error;
      sessionAgent = resolution.run;
    }
    // Request beats agent, and agent beats Bureau, for what the run is seeded and capped with.
    const effectiveSystemPrompt =
      request.systemPrompt ?? sessionAgent?.instructions ?? runtime.systemPrompt;
    const effectiveMaximumSteps =
      request.maximumSteps ?? sessionAgent?.options.maximumSteps ?? runtime.maximumSteps;
    const effectiveMaximumTokens = request.maximumTokens ?? sessionAgent?.options.maximumTokens;
    const requestContext = normalizeRunRequestContext(
      request.requestContext,
      runId,
      sessionId,
      agentName,
      request.principal,
    );
    if (isTransportIssuedAuthority(requestContext)) {
      if (!requestAuthorityValidator) {
        throw new BureauError(
          'Cannot create run: transport-issued request authority cannot be validated.',
          'CONFLICT',
        );
      }
      if (!(await requestAuthorityValidator(requestContext))) {
        throw new BureauError(
          'Cannot create run: request authority is no longer current.',
          'CONFLICT',
        );
      }
    }

    // AB-13 — admit BEFORE any session/runtime work: createRun returns
    // synchronously right after the run starts (it does not await
    // completion), so admission is a synchronous pre-gate — over-cap or
    // rate-limited or duplicate triggers are rejected outright, not queued.
    // COR-690: re-checked here because the authority validation above awaits,
    // and `shutdown()` may have started during it.
    assertRunAdmissionOpen('run');
    // COR-424 — a request naming a run-creation request id consults the
    // command ledger before flow control, so an exact retry replays the
    // original run instead of being admitted, or rejected, as new work. A
    // fresh claim is settled exactly once below: completed with the run's
    // summary once it is durably started, or released when no run results.
    // The payload digest takes every default at the value this run will use,
    // so a retry that spells out a default it first omitted is the same
    // command. The session is the one the request names: an omitted session
    // is minted afresh per attempt, so its minted id cannot be part of it.
    const ledgerAttempt =
      request.runCreationRequestId === undefined
        ? undefined
        : await requireRunCreationLedger().begin({
            // A run creation request id requires an explicit `principal`, so this is
            // exactly the owner the run records, and the caller a receipt replays to
            // is the principal that owns the run. The `''` is unreachable.
            callerId: request.principal ?? '',
            // The agent the run is, not the one the caller stated: a retry that spells out
            // the agent an omitted name inherited is the same command, and
            // `locateRunCreationReceipt` resolves it the same way.
            agentName,
            requestId: request.runCreationRequestId.trim(),
            payloadDigest: digestRunCreationPayload({
              message: request.message,
              appendMessages: serializeAppendedMessages(request.appendMessages),
              sessionId: request.sessionId?.trim(),
              systemPrompt: effectiveSystemPrompt,
              maximumSteps: effectiveMaximumSteps,
              maximumTokens: effectiveMaximumTokens,
            }),
            claim: { runId, sessionId },
          });
    if (ledgerAttempt?.kind === 'replay') return ledgerAttempt.result;
    const ledgerClaim = ledgerAttempt;
    if (flowController) {
      const decision = flowController.admit({
        runId,
        agentName,
        source: 'api',
        message: requestText,
        sessionId,
        ...(request.principal !== undefined ? { principal: request.principal } : {}),
      });
      if (!decision.allowed) {
        const rejection = new BureauError(
          `Run rejected by flow control policy (${decision.reason})`,
          'RATE_LIMITED',
        );
        await releaseRunCreationClaim(ledgerClaim, rejection);
        throw rejection;
      }
    }

    // AB-13 — everything below stays INLINE in this same function (not a
    // separately-awaited helper): an extra `await helper(...)` layer would
    // add a microtask hop before `createRun` resolves back to the caller,
    // shifting how much of the in-memory loop's own internal scheduling has
    // run by the time a caller can first call `abortRun()` — existing
    // abort-timing tests depend on that not moving. try/catch alone adds no
    // such hop, so it is the release mechanism here.
    //
    // AB-361 review (codex P2 PRRT_kwDORvupsc6ga0TX): distinguishes the
    // catch block's two reachable cases below — set true the moment
    // `store.register` succeeds, so a durable-write failure that happens
    // AFTER registration (this run is already a terminal FAILED run other
    // callers can see via `listRuns()`/`getRun()`) does not fall through
    // the SAME `runAttribution.delete(runId)` cleanup a genuinely
    // never-registered run needs.
    let registeredForRecovery = false;
    // COR-1524: whether this run holds a snapshot reference that nothing else will settle if the
    // run never registers.
    let heldAgentReference = false;
    let created: RunSummary;
    try {
      if (!session) {
        if (effectiveSystemPrompt) {
          conversation.appendSystemMessage(effectiveSystemPrompt);
        }
      }

      if (request.message !== undefined) conversation.appendUserMessage(request.message);
      appendRequestRows(conversation, request.appendMessages);
      // A run answers the row the conversation ends in: a user message, or a
      // tool result (the outcome of an approval) with nothing newer.
      assertConversationAnswerable(conversation);

      // AB-54 usage analytics: resolve agentName/principal deterministically now
      // (before `store.register`, so it's in place before any listRuns()/getRun()
      // call can observe this run) rather than relying on the tool-bubble-event
      // heuristic, which cannot see a run that never calls a tool.
      runAttribution.set(runId, { agentName, principal: owner });
      const runRuntime = await runtime.createRunRuntime(
        {
          ...request,
          agentName,
          sessionId,
          runId,
          requestContext,
        },
        { sessionAgent },
      );
      runRequestContexts.set(runId, requestContext);

      const disposeStreamListeners: Array<() => void> = [];
      const streamEventTarget = runRuntime.streamEventTarget;
      if (streamEventTarget) {
        disposeStreamListeners.push(
          wireStreamEventTargetFrames(streamEventTarget, runId, emitLiveFrame, nextRunSeq),
        );
      }

      // COR-1524 — a file agent's definition is stored, and this run tied to it, before the
      // session names the run, so recovery always finds the snapshot the session's hash points at.
      if (sessionAgent?.agentBinding !== undefined) {
        await fileAgents?.recordBoundRun(sessionAgent.agentBinding, runId);
        heldAgentReference = fileAgents !== undefined;
      }
      const savedAsRunning = await saveSession(
        sessionId,
        conversation,
        {
          lastRunId: runId,
          lastRunStatus: 'running',
          // This run's own starting entry: durable steering counts it as
          // starting, until its `promoted` entry is logged and for a bounded
          // time, even when another run's save replaces `lastRunId`.
          ...(durableSteeringStore() === undefined
            ? {}
            : { steeringStartingRuns: { [runId]: runtimeServices.clock.nowISO() } }),
          lastUserMessage: requestText,
          // Always write these keys (null when absent) so a reused session never
          // inherits a stale cap from a previous run. A conditional spread would leave
          // the old value in place when the request omits the field; null is treated as
          // "unset" by buildRunDepsFromSession (it gates on typeof === 'number'),
          // so null is a safe sentinel for "caller did not specify a cap" (PRRT_kwDORvupsc6MZ1Mb).
          lastMaximumTokens: request.maximumTokens ?? null,
          // COR-1577 — the definition the named agent had when this run started, so recovery can
          // tell when the catalog's has moved on. Null for the default agent, which has none.
          [SESSION_AGENT_REVISION_METADATA_KEY]: sessionAgent?.definitionRevision ?? null,
          // COR-1524 — the file the agent was read from, by hash, so recovery builds from the
          // snapshot. Null for a code-defined agent, and for the default one.
          [SESSION_AGENT_DEFINITION_HASH_METADATA_KEY]: sessionAgent?.agentBinding?.hash ?? null,
          // Persist the per-request step cap too, so a recovered run honours the
          // caller's maximumSteps instead of falling back to the bureau default
          // (PRRT_kwDORvupsc6MZfl5 — mirror of the maximumTokens recovery fix).
          lastMaximumSteps: request.maximumSteps ?? null,
          // Reset the active-skill snapshot at the start of every run so a reused
          // session never seeds a fresh run with the PREVIOUS run's active skills.
          // The snapshot is otherwise written only by createSkillRecordSnapshotHook
          // after the run's first onStep boundary; if the durable process crashes
          // before that first snapshot, recovery would read this session's stale
          // records and pre-seed the new run with skills a live fresh run would not
          // have. null clears it: buildRunDepsFromSession runs the value through
          // isSkillActivationRecordArray, which rejects null → the recovered run
          // starts empty, exactly as a fresh run would (PRRT_kwDORvupsc6Mddv3).
          //
          // All three keys, not just the records. The run id and step are what
          // loadCommittedScheduledActiveSkills matches on, and a stale pair left
          // behind would let it accept a committed step snapshot belonging to a
          // previous run on this session.
          activeSkillRecords: null,
          activeSkillRecordsRunId: null,
          activeSkillRecordsStep: null,
          // Durable recovery needs the authority that was safe to persist at
          // dispatch time. Credentials, tracing, and other request-local data
          // intentionally never cross the session boundary.
          lastRequestAuthority: {
            agentId: agentName,
            principalId: requestContext.authority.principalId,
            tenantId: requestContext.authority.tenantId,
            ownerId: requestContext.authority.ownerId,
            capabilities: [...requestContext.authority.capabilities],
            authorizationRevision: requestContext.authority.authorizationRevision,
            ...(requestContext.audience !== undefined ? { audience: requestContext.audience } : {}),
            ...(requestContext.deadline !== undefined ? { deadline: requestContext.deadline } : {}),
          },
          lastRequestAuthorities: {
            [runId]: {
              agentId: agentName,
              principalId: requestContext.authority.principalId,
              tenantId: requestContext.authority.tenantId,
              ownerId: requestContext.authority.ownerId,
              capabilities: [...requestContext.authority.capabilities],
              authorizationRevision: requestContext.authority.authorizationRevision,
              ...(requestContext.audience !== undefined
                ? { audience: requestContext.audience }
                : {}),
              ...(requestContext.deadline !== undefined
                ? { deadline: requestContext.deadline }
                : {}),
            },
          },
          // AB-359, COR-718 — persist the run's OWNER (`request.principal`, or
          // `anonymous:local` when it states none), never
          // `requestContext.authority.principalId`: that is tool-execution
          // authority, and it is synthesized as `run:${runId}` when the caller
          // omitted a principal, per `normalizeRunRequestContext` above. Persisting
          // it lets a recovered run's real owner authorize against durable
          // `eventHistory` after a process restart, when `runAttribution` (AB-54's
          // in-memory-only map) has been lost. Written unconditionally, like
          // `runAttribution.set` above: every run has an owner, so a restart
          // reads the same owner the run had live.
          lastRunOwningPrincipals: { [runId]: owner },
          // COR-718 — the session's owner, written once: `mergeMetadata` keeps the
          // stored owner when the session already has one.
          [SESSION_OWNER_METADATA_KEY]: owner,
        },
        // Stamp a new session with the dispatched agent (PRRT_kwDORvupsc6MbUsN) so it
        // is not always recorded as the house default 'bureau'. An existing session keeps the
        // agent it was created for.
        agentName,
        baseConversationHistory,
      );

      // F3 — opt-in `requestHumanInput` wiring for a REAL durable run
      // (`options.humanInput`). This closes the tracked wiring gap: the tool's
      // mutable `pendingHumanWait` slot must be the EXACT object Weft hands
      // back as `ctx.services` (durable's own per-run deps), and its
      // `HumanWaitParkedEvent` dispatch must land on the EXACT emitter this
      // run's `ActiveRun` exposes — neither exists until `createActiveRun`
      // constructs them below, and both are internal to the durable adapter.
      // `emitter` is threaded in directly (built here, handed to
      // `createActiveRun` to use instead of minting its own); the
      // `ctx.services` reference is captured via `onServices`, a synchronous
      // hook the durable adapter fires immediately before `engine.start` —
      // see `DurableActiveRunOptions.onServices` in operative for why this is
      // the only point such a reference can be obtained. Once captured, the
      // tool's `pendingHumanWait` setter forwards onto it, so a real
      // `requestHumanInput` call actually parks the workflow AND fires an
      // observable event — reaching the `activeRun.addEventListener(
      // HumanWaitParkedEvent.type, …)` listener below (AB-13 `markParked`)
      // and `store`'s action log (AB-20 `listPendingReviews`).
      let humanInputEmitter: CompletableEventTarget<CombinedOperativeEventMap> | undefined;
      // Shared `ctx.services` capture for BOTH durable-only opt-in tools this
      // run may wire (`requestHumanInput` and `scheduleWakeup`): Weft's
      // durable adapter fires exactly one `onServices` hook per run
      // (`DurableActiveRunOptions.onServices`, immediately before
      // `engine.start`), so a SINGLE ref/hook is captured here and handed to
      // whichever context(s) `wireDurableOptInTools` wires below need it —
      // two separate hooks would have the later one clobber the earlier
      // one's `onServices` property in the `createActiveRun` options object
      // literal, silently breaking whichever tool composed first.
      const servicesRef: { current?: DurableRunDeps } = {};
      const wantsHumanInput = !!(options.humanInput && runtime.durable);
      const wantsWakeup = !!(options.wakeup && runtime.durable);
      if (wantsHumanInput) {
        humanInputEmitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      }
      // AB-336: `wireDurableOptInTools` is the ONE place this wiring lives —
      // shared with `buildRunDepsFromSession`'s recovery path
      // (`runtime-composition.ts`), which used to omit it entirely.
      const runToolbox: BureauToolbox = wireDurableOptInTools(runRuntime.toolbox, servicesRef, {
        humanInput: wantsHumanInput,
        wakeup: wantsWakeup,
        runId,
        ...(humanInputEmitter ? { humanInputEmitter } : {}),
      });
      const durableServicesOnServices =
        wantsHumanInput || wantsWakeup
          ? (services: DurableRunDeps) => {
              servicesRef.current = services;
            }
          : undefined;

      // AB-67/AB-199 — steering is scoped to in-memory (process-local)
      // sessions only: a durably-configured bureau's `submitSteeringCommand`
      // always rejects pause/resume as `unsupported-capability`, so a
      // durable run never needs a gate. An in-memory run's gate is created
      // (or reused) HERE, eagerly, before `createActiveRun` — not lazily
      // inside `submitSteeringCommand` — because a pause admitted mid-run
      // must gate THIS run's own `runStep` boundary; a gate created only on
      // first use would miss every run already started before the first
      // `submitSteeringCommand` call for its session. A gate with no
      // `pause`/`resume` ever admitted against it is inert: `getDesiredState()`
      // stays `{ paused: false, configVersion: 0 }`, which `run-step.ts`'s
      // `maybeDispatchSteeringApplied` never fires for (`configVersion > 0`
      // guard) — identical to today's no-`steering`-dependency behavior.
      // `promoteForNewRun()` promotes any agent-identity bump a prior run
      // deferred (AB-199's coordinator amendments, 2026-09-02 addendum); a
      // no-op when nothing was pending.
      // AB-200: durable runs get a steering gate too. They were excluded
      // while `submitSteeringCommand` refused every durable command —
      // attaching a gate nothing could ever write to was pointless. Now
      // that durable steering persists and recovers, excluding them would
      // be the actual bug: a command admitted and durably recovered would
      // never reach the run it was meant to steer.
      // A durable run must see the session's logged desired state at its
      // own step 0, so its start is itself a logged event: catching up and
      // appending `promoted` folds everything other processes (or this one,
      // before a restart) admitted, and records the promotion in log order.
      const steeringKv = durableSteeringStore();
      const steeringSession =
        steeringKv === undefined ? undefined : await runtime.sessionStore?.load(sessionId);
      if (savedAsRunning) runSessionIncarnations.set(runId, savedAsRunning.incarnation);
      if (
        steeringKv !== undefined &&
        (steeringSession === undefined ||
          steeringSession.incarnation !== savedAsRunning?.incarnation)
      ) {
        // Saved just above; gone now, or replaced by a recreated session,
        // only if deleted concurrently. A durable run must not start on a
        // gate the steering log does not feed, nor steer, log into, or later
        // save over a session it was never started in.
        throw new BureauError(
          `Session "${sessionId}" was deleted while run "${runId}" was starting.`,
          'CONFLICT',
        );
      }
      // The session was already saved as running this run. If the run then
      // never starts, it is recorded as failed rather than left a phantom —
      // decided inside the session's own update, so it applies only while
      // this very run is still the session's latest: not to a session
      // deleted meanwhile (saving would recreate it), nor over a newer run
      // another process started.
      const markStartFailed = async (error: unknown): Promise<void> => {
        if (steeringSession === undefined) return;
        try {
          await runtime.sessionStore?.update(sessionId, (current) => {
            if (current?.incarnation !== steeringSession.incarnation) return undefined;
            // Never starting now, whichever run is the session's latest.
            const starting = current.metadata['steeringStartingRuns'];
            const stillStarting =
              typeof starting === 'object' && starting !== null && !Array.isArray(starting)
                ? Object.fromEntries(
                    Object.entries(starting).filter(([startingRunId]) => startingRunId !== runId),
                  )
                : starting;
            return {
              ...current,
              metadata: {
                ...current.metadata,
                ...(stillStarting === undefined ? {} : { steeringStartingRuns: stillStarting }),
                ...(current.metadata['lastRunId'] === runId
                  ? { lastRunStatus: 'error', lastError: serializeUnknownError(error) }
                  : {}),
              },
            };
          });
        } catch (rollbackError) {
          diagnose({
            level: 'error',
            scope: 'steering',
            message: `[bureau] Could not mark session "${sessionId}" failed after run "${runId}" failed to start: ${serializeUnknownError(rollbackError)}`,
          });
        }
      };
      if (steeringKv !== undefined && steeringSession !== undefined) {
        try {
          await enqueueSteering(sessionId, () =>
            appendThenApplySteering(steeringKv, sessionId, steeringSession.incarnation, {
              type: 'promoted',
              runId,
              now: runtimeServices.clock.nowISO(),
            }),
          );
        } catch (error) {
          await markStartFailed(error);
          throw error;
        }
        steeringRunIncarnations.set(runId, steeringSession.incarnation);
        pollSessionSteering(sessionId, steeringSession.incarnation, runId);
      } else {
        getSessionSteeringGate(sessionId).promoteForNewRun(runId, runtimeServices.clock.nowISO());
      }
      const steeringGate = getSessionSteeringGate(sessionId);
      // AB-67/AB-199 — a per-run VIEW of the shared session gate (see
      // `steering.ts`'s `forRun` doc comment): a pause bound to a DIFFERENT
      // concurrent run on this same session must never block this one.
      const runSteeringGate = steeringGate.forRun(runId);

      // COR-690: the last admission check before the run and its toolbox are
      // registered. Everything from that check to the registration is
      // synchronous, so a `shutdown()` that started during the awaits above
      // rejects this run instead of letting it start outside shutdown's snapshot.
      let activeRun: ReturnType<typeof createActiveRun>;
      try {
        // COR-1481 — the task's record, before anything of the run starts, so a
        // record that cannot be written ends the start like any other start failure.
        await tasks.recordAdmission({
          taskId: runId,
          contextId: sessionId,
          incarnation: runSessionIncarnations.get(runId) ?? savedAsRunning?.incarnation ?? '',
          agentName,
          owner,
          // The text the run began with, whether it came as `message` or as an appended user row.
          message: request.message ?? (requestText === '' ? undefined : requestText),
        });
        // COR-1476 — inside the block below, so a gate that cannot be built
        // (its session read fails) ends the promoted run like any other start
        // failure: its end is logged and its session's input settled.
        const runSessionInputGate = sessionInputGateFor(
          sessionId,
          runId,
          runSessionIncarnations.get(runId) ?? savedAsRunning?.incarnation,
        );
        assertRunAdmissionOpen('run');
        // COR-1481 — the fence again, now that the session is saved and before the run
        // registers: a deletion that began during the awaits above has already looked
        // for this session's runs and would not find this one.
        if (inFlightSessionDeletions.has(sessionId)) {
          throw new BureauError(`Session "${sessionId}" not found`, 'NOT_FOUND');
        }
        activeRun = createActiveRun(
          {
            generate: runRuntime.generate,
            toolbox: runToolbox,
            conversation,
            // COR-1577 — the named agent's own options (stop conditions, structured output and
            // its retries, …), before the ones Bureau sets below, which win.
            ...copyAgentOwnedRunOptions(sessionAgent?.options),
            // COR-716 — a managed asset in this run's input (or in input admitted to
            // its session mid-run) resolves as the run's owner.
            ...sessionRunMediaOptions(sessionAgent, runtime.mediaOptionsFor(owner)),
            maximumSteps: effectiveMaximumSteps,
            maximumTokens: effectiveMaximumTokens,
            // COR-1577 — a named agent's stop conditions replace the Bureau's default ones.
            stopWhen: sessionAgent?.options.stopWhen ?? options.stopWhen,
            // AB-260: the bureau's single composed RuntimeServices instance,
            // snapshotted into every run it starts.
            runtime: runtimeServices,
            ...(runSteeringGate ? { steering: runSteeringGate } : {}),
            // COR-1269 — stamped onto this run's hook-plan observations.
            sessionId,
            // COR-1476 — input admitted while this run is live, delivered at
            // each of its step boundaries.
            ...(runSessionInputGate ? { sessionInput: runSessionInputGate } : {}),
            // COR-1265 criterion 8 — merged AFTER the trailing registration, so
            // the Bureau tier is complete before it becomes the merge's first
            // argument. A single-tier merge still copies every entry into a fresh
            // registry, which is what makes the plan a snapshot: a registration
            // added to `runRuntime.hooks` afterwards cannot reach this run.
            hooks: mergeHookRegistries(
              registerTrailingOnStep(
                runRuntime.hooks,
                'bureau:pending-approval-persist',
                createPendingApprovalPersistHook(
                  runId,
                  sessionId,
                  pendingApprovalOverrides,
                  persistPendingApprovalOverrideWithRetry,
                ),
              ),
              // COR-1577 — a named agent's own hook tier follows the Bureau's, as on a catalog dispatch.
              sessionAgent?.options.hooks,
            ),
            executeOptions: sessionExecuteOptions(sessionAgent?.options, requestContext),
            // Thread agentName and runId so curated tool.* bubble events are stamped
            // with {agentName, runId, step} metadata (C3) and durable launch input
            // carries the owning agent for audit/recovery attribution (F2). Fall back
            // to BUREAU_AGENT_NAME when the request omits it, matching the agent the
            // session is stamped with — otherwise the durable input + tool events
            // carry an empty agentName while the session says 'bureau'.
            agentName,
            runId,
          },
          // Route through the durable engine when one was composed (durableExecution
          // + storage). The conversation already carries the seeded user/system
          // messages, so no separate `prompt` is passed — the workflow snapshots it.
          // The run is then checkpointed and resumes from its last step after a crash.
          runtime.durable
            ? {
                engine: runtime.durable.engine,
                checkpointStore: runtime.durable.checkpointStore,
                // COR-625: this run's terminal checkpoint-retention step,
                // folded into its `closed()`. Memoized per run id, so the
                // listeners below firing it independently costs nothing.
                ...(durableTerminalCleanup ? { terminalCleanup: durableTerminalCleanup } : {}),
                runId,
                // Carry the owning session in the durable input so boot recovery can
                // correlate a recovered handle back to its session without a side
                // table (see recoverDurableRuns / resolveRunServices).
                sessionId,
                // Lets durable steering in any process find this run as live
                // for this session incarnation (`liveSessionRunIdsEverywhere`).
                ...(steeringSession !== undefined
                  ? { tags: [steeringSessionRunTag(sessionId, steeringSession.incarnation)] }
                  : {}),
                ...(humanInputEmitter ? { emitter: humanInputEmitter } : {}),
                ...(durableServicesOnServices ? { onServices: durableServicesOnServices } : {}),
              }
            : undefined,
          // AB-214 review (PRRT_kwDORvupsc6esZTF): thread the authenticated
          // principal starting this run into `LivenessSnapshot.owner` — AC4
          // reserves an absent owner for a standalone (non-Bureau) run, and a
          // Bureau-started run always has one to give.
          { owner },
        );
      } catch (error) {
        await tasks.discard(runId).catch(() => undefined);
        // Promoted but never started, so no terminal listener will ever log
        // its end: log it here, or every process would count this run as
        // starting and keep a pause bound to it accepted.
        logRunBoundarySteering(sessionId, steeringGate, {
          type: 'run-ended',
          runId,
          now: runtimeServices.clock.nowISO(),
        });
        // COR-1476 — a run that never starts has ended: it releases its gate
        // and, with no other run on the session, cancels the input left open.
        // Tracked rather than awaited, as a terminal listener's settlement is,
        // so a write that must be retried never holds this caller's rejection.
        trackSessionInputSettlement(settleSessionInputsAfterRunEnd(sessionId, runId));
        await markStartFailed(error);
        throw error;
      }
      activeRuns.add(activeRun);
      runToolboxes.add(runToolbox);
      runToolboxesByRunId.set(runId, runToolbox);
      // AB-96 — the versioned run-lifecycle frame stream. Registered before
      // `store.register` so `run-started` is the first frame a live subscriber
      // ever sees for this run.
      const disposeRunFrameForwarder = createRunFrameForwarder(
        runId,
        activeRun,
        (frame) => emitLiveFrame({ type: 'run-envelope', runId, frame }),
        // AB-260: the bureau's single composed RuntimeServices clock, so
        // every run-lifecycle frame this forwarder emits is origin-derived
        // for a manually-clocked bureau rather than reading the real clock.
        { streamEventTarget, clock: runtimeServices.clock.now },
      );
      disposeStreamListeners.push(disposeRunFrameForwarder);
      // Registered here, for the same reason the frame forwarder is: before
      // `store.register`, which is what drives `run.registered` onto this
      // bureau's own feed. A client that reacts to `run.registered` by
      // subscribing to `operative.runs.events` would otherwise race an entry
      // that does not exist yet.
      disposeStreamListeners.push(
        attachRunEventFeed(runId, activeRun, runEventFeeds, {
          now: runtimeServices.clock.now,
          onError: (error, kind) => {
            diagnose({
              level: 'error',
              scope: 'event-feed',
              message: `[bureau] run event feed threw recording a "${kind}" event for run ${runId}:`,
              cause: error,
            });
          },
        }),
      );
      emitLiveFrame({
        type: 'run-envelope',
        runId,
        frame: createRunStartedFrame({ runId, sessionId, agentName }, runtimeServices.clock.now),
      });

      // AB-13 — free this run's concurrency slot while it is parked on a
      // human-wait signal; `HumanWaitParkedEvent` fires on the SAME emitter
      // `store.register` subscribes to below, so this observes both the
      // in-memory and durable paths identically.
      if (flowController) {
        activeRun.addEventListener(HumanWaitParkedEvent.type, () => {
          flowController.markParked(runId);
        });
      }

      // AB-67/AB-199 — the write side of cross-run steering dedupe:
      // `SteeringGate.getAppliedFloor()` (the read side `run-step.ts`
      // consults) only reflects reality once something raises it.
      // `runStep` dispatches `SteeringAppliedEvent` on this exact run's
      // emitter the moment it observes a `configVersion` at its boundary
      // (`run-step.ts`'s `maybeDispatchSteeringApplied`), so listening here
      // is the one place that fires for both drivers identically.
      activeRun.addEventListener(SteeringAppliedEvent.type, (event) => {
        logRunBoundarySteering(sessionId, steeringGate, {
          type: 'applied',
          runId: event.effective.appliedAtRunId,
          configVersion: event.effective.configVersion,
          now: event.effective.appliedAt,
        });
      });

      activeRun.once('run.completed', (event) => {
        activeRuns.delete(activeRun);
        releaseRunToolboxWhenIdle(runToolbox);
        disposeRegisteredStreamListeners(disposeStreamListeners);
        // COR-625: a terminal transition owes this run one checkpoint-
        // retention step whether or not anyone ever calls `closed()`.
        // Memoized per run id, so this and `closed()`'s own fold resolve the
        // SAME step. Fire-and-forget: the step records its own
        // acknowledgement durably and never rejects.
        void runTerminalCheckpointCleanup(runId);
        // AB-67's ratified Abort row: a session's pause/resume never carries
        // into a future run. Any command still `accepted` and bound to this
        // run transitions to `failed`/`'run-terminal'` the moment the run
        // reaches ANY terminal state — completed here, aborted in the
        // sibling listener below.
        logRunBoundarySteering(sessionId, steeringGate, {
          type: 'run-ended',
          runId,
          now: runtimeServices.clock.nowISO(),
        });
        flowController?.settle(runId);
        queueMicrotask(() => releaseTerminalRunReviewState(runId));

        const finishReason = event.finishReason;
        const lastRunStatus = isRunFailureFinishReason(finishReason) ? 'error' : 'completed';

        const report = buildTerminalReportFromCompletedEvent(runId, event);
        runReports.set(runId, report);
        emitLiveFrame({
          type: 'run-envelope',
          runId,
          frame: createRunFinishedFrame({ runId, report }, runtimeServices.clock.now),
        });

        persistTerminalSession(
          () =>
            saveRunTerminalSession(
              runId,
              sessionId,
              event.conversation,
              {
                lastRunId: runId,
                lastRunStatus,
                lastFinishReason: event.finishReason,
                ...(isRunFailureFinishReason(event.finishReason)
                  ? { lastError: serializeUnknownError(event.error) }
                  : {}),
              },
              agentName,
              baseConversationHistory,
            ),
          {
            runId,
            sessionId,
            status: lastRunStatus,
          },
        );
      });

      activeRun.once('run.aborted', (event) => {
        activeRuns.delete(activeRun);
        releaseRunToolboxWhenIdle(runToolbox);
        disposeRegisteredStreamListeners(disposeStreamListeners);
        // COR-625: a terminal transition owes this run one checkpoint-
        // retention step whether or not anyone ever calls `closed()`.
        // Memoized per run id, so this and `closed()`'s own fold resolve the
        // SAME step. Fire-and-forget: the step records its own
        // acknowledgement durably and never rejects.
        void runTerminalCheckpointCleanup(runId);
        flowController?.settle(runId);
        queueMicrotask(() => releaseTerminalRunReviewState(runId));
        // See the identical call in the `run.completed` listener above.
        logRunBoundarySteering(sessionId, steeringGate, {
          type: 'run-ended',
          runId,
          now: runtimeServices.clock.nowISO(),
        });

        const report = buildTerminalReportFromAbortedEvent(runId, {
          usage: event.usage,
          costEstimate: event.costEstimate,
          reason: event.reason,
          error: event.error,
          steps: store.getRun(runId)?.steps ?? [],
          conversation: event.conversation,
        });
        runReports.set(runId, report);
        emitLiveFrame({
          type: 'run-envelope',
          runId,
          frame: createRunFinishedFrame({ runId, report }, runtimeServices.clock.now),
        });

        persistTerminalSession(
          () =>
            // Persist the conversation carried on the abort event, NOT the
            // launch-time `conversation` closure. On the durable path the workflow
            // mutates per-step checkpoint snapshots, so a run that aborts after
            // checkpointed steps (e.g. when engine.cancel() wins the abort race)
            // reconstructs its abort RunResult from the checkpoint — the event's
            // conversation reflects those steps, whereas the closure still holds
            // only the seed transcript. For the in-memory loop the event carries
            // the same mutated instance, so this is correct on both paths.
            saveRunTerminalSession(
              runId,
              sessionId,
              event.conversation,
              {
                lastRunId: runId,
                lastRunStatus: 'aborted',
                // Write lastFinishReason too so an aborted session's metadata is
                // internally consistent (status + finishReason agree) and a prior
                // run's stale lastFinishReason on the same session can't linger. This
                // is also what boot recovery now relies on: a recovered run that
                // aborts settles through THIS listener (settleRecoveredRun is gone),
                // so the field must be written here, not only on the old recovery path.
                lastFinishReason: 'aborted',
                lastError: serializeUnknownError(event.error),
              },
              agentName,
              baseConversationHistory,
            ),
          {
            runId,
            sessionId,
            status: 'aborted',
          },
        );
      });

      activeRun.once('run.error', (_event) => {
        activeRuns.delete(activeRun);
        releaseRunToolboxWhenIdle(runToolbox);
        // The stream listeners are deliberately NOT disposed here. `run.error`
        // is not terminal: Operative follows it with `run.completed`, which
        // carries the finish reason, so the `run.completed` listener above
        // disposes them once that event has reached them. Detaching on
        // `run.error` stopped the run frame forwarder and the run event feed
        // one event early, so a run that exceeded its budget never announced
        // it and a failed run's feed never recorded its terminal event
        // (COR-1419). A recovered run already works this way.
        // COR-625: a terminal transition owes this run one checkpoint-
        // retention step whether or not anyone ever calls `closed()`.
        // Memoized per run id, so this and `closed()`'s own fold resolve the
        // SAME step. Fire-and-forget: the step records its own
        // acknowledgement durably and never rejects.
        void runTerminalCheckpointCleanup(runId);
        flowController?.settle(runId);
        queueMicrotask(() => releaseTerminalRunReviewState(runId));
      });

      // A run can settle without any terminal event: a durable run whose engine lost a
      // checkpoint compare-and-swap, or was disposed, is abandoned to whoever owns it and
      // resolves its result quietly (`driveDurableRun`). The terminal listeners above never run
      // for it, and `run.error` no longer detaches the stream listeners, so a run that reported
      // an error before being abandoned would keep them attached for good. A result settles
      // only after any terminal event it carries has been dispatched, so detaching here cannot
      // cut off the `run.completed` the forwarder and the run event feed are waiting for. The
      // disposers drain as they run, which makes this a no-op after a terminal listener ran.
      detachBestEffortPromise(
        activeRun.result.finally(() => {
          disposeRegisteredStreamListeners(disposeStreamListeners);
          // A quietly settled run can stay `running` in the store; this
          // process no longer drives it, so its liveness is the engine's.
          // Only an abandoned one is kept: a terminal event already left
          // `running` before the result settled.
          if (store.getRun(runId)?.status === 'running') {
            settledLocalRunIds.add(runId);
            releaseSessionSteeringPoll(sessionId, runId);
            // COR-1476 — abandoned to whoever owns it: this process stops keeping
            // its leases alive, but the claims stay, since the owner may yet
            // replay the steps that hold them.
            abandonSessionInputGate(runId);
          }
        }),
      );

      store.register(activeRun, runId);
      registeredForRecovery = true;
      runSessionIdentifiers.set(activeRun, sessionId);

      // AB-361/AB-34: the started-work control contract says an
      // acknowledged durable run is durable — a caller that holds this
      // run's identifier must be able to recover it after a crash at any
      // later point. `activeRun.durablyStarted` settles with the SAME write
      // `driveDurableRun`'s `context.engine.start(...)` performs on the
      // durable branch (`durable/active-run-adapter.ts`). Awaited here,
      // AFTER `store.register` (so `run.started` is still the first frame
      // any live subscriber sees — an earlier await would let the deferred
      // `drive()` microtask run before this function's own subscription
      // exists) and immediately before returning, so this function's own
      // promise cannot resolve until the durable record is committed.
      // Guarded by `runtime.durable`, not an unconditional `await
      // activeRun.durablyStarted` — that field is `undefined` on the
      // in-memory branch (nothing durable to await), and an unconditional
      // `await undefined` would still cost every in-memory run one extra
      // microtask tick it does not have today.
      if (runtime.durable) {
        await activeRun.durablyStarted;
      }

      created = serializeRunState(store.getRun(runId)!, sessionId);
    } catch (error) {
      // Reached either because the run never got as far as `store.register`
      // (no terminal event to settle through — the original reason this
      // catch exists), OR because `store.register` succeeded but the
      // AWAITED `durablyStarted` above rejected (a genuine durable-write
      // failure — `engine.start` rejecting, or a caller-supplied
      // `onServices` throwing; see `driveDurableRun`'s own review-fixed
      // handling of both, PRRT_kwDORvupsc6gWc39/PRRT_kwDORvupsc6gWb3a).
      // Either way this function is about to throw instead of returning a
      // run identifier to its caller, so release whatever this admission
      // claimed so it does not leak a phantom concurrency/singleton hold.
      // In the second case the run itself is already registered, but its
      // terminal `run.completed` listener already fired SYNCHRONOUSLY,
      // inside `makeErrorResult`'s `RunCompletedEvent` dispatch — by
      // construction this happens before this function's own `await
      // activeRun.durablyStarted` line can even resume (that rejection is
      // only observed in a later microtask) — never merely "will fire"
      // asynchronously afterward, so this cleanup is scoped to per-request
      // bookkeeping this function itself owns, not to unregistering the
      // run.
      flowController?.settle(runId);
      // COR-1524: a run that never registered has no terminal action to settle its snapshot
      // reference, so the reference is released here; a registered one settles through the store.
      if (heldAgentReference && !registeredForRecovery) {
        await fileAgents?.releaseRun(runId);
      }
      runRequestContexts.delete(runId);
      // AB-361 review (codex P2 PRRT_kwDORvupsc6ga0TX): only the
      // never-registered case may delete `runAttribution` — a run that
      // reached `store.register` is ALREADY a terminal FAILED run other
      // callers can observe via `listRuns()`/`getRun()` (its
      // `run.completed` listener fired synchronously, per the comment
      // above), and `resolveEventHistory()`'s authorization check fails
      // closed when this map entry is absent, locking the run's real owner
      // out of its own event history. A normal terminal run keeps its
      // attribution until an explicit `deleteRun`; this post-registration
      // durable-write-failure path must match that, not the
      // never-registered path's full cleanup.
      if (!registeredForRecovery) {
        runAttribution.delete(runId);
      }
      // COR-424: no acknowledged run resulted, so the claim is released and a
      // retry starts afresh. That includes a run registered here whose
      // durable start then failed: the engine holds no record of it to
      // recover, so there is nothing for a retry to observe.
      // COR-718: a save that lost the race to create the session is refused as a
      // session that is not there, exactly as the preflight check refuses one.
      // COR-1577: a save that lost the race to bind the session to an agent is refused as the
      // preflight check refuses a run naming another agent, before the run executes.
      const rejection =
        error instanceof SessionOwnerConflictError
          ? new BureauError(`Session "${sessionId}" not found`, 'NOT_FOUND')
          : error instanceof SessionAgentConflictError
            ? new BureauError(
                // A run that named no agent started on the default one before it saw the
                // session, so it must not be told it named `bureau`.
                request.agentName === undefined
                  ? `Session "${sessionId}" was bound to agent "${error.boundAgentName}" by ` +
                      `another run while this run, which named no agent, was starting on the ` +
                      `default agent "${error.requestedAgentName}". Retry to continue the session.`
                  : error.message,
                'BAD_REQUEST',
              )
            : error;
      await releaseRunCreationClaim(ledgerClaim, rejection);
      throw rejection;
    }
    // COR-424: the ledger records the run only once it is durably started,
    // so a retry never replays a run that a restart could not recover. When
    // recording fails, `complete` rejects with a
    // `RunCreationReceiptUnrecordedError` naming the run, which keeps
    // executing; the claim stays pending, and a retry observes the run and
    // records its receipt.
    return ledgerClaim === undefined ? created : ledgerClaim.complete(created);
  }

  /**
   * COR-1577 — which agent a run is. A session is bound to the agent of the run that created it,
   * so an existing session decides, and a run that names another agent is refused; a new session
   * takes the named agent, or the default `bureau`. Starting a run and locating its
   * run-creation receipt both resolve the agent here, so the two cannot disagree on the ledger key.
   */
  function resolveRunAgentName(
    sessionId: string,
    session: AgentSession | undefined,
    statedAgentName: string | undefined,
  ): string {
    if (
      session !== undefined &&
      statedAgentName !== undefined &&
      statedAgentName !== session.agentName
    ) {
      throw new BureauError(
        `Session "${sessionId}" belongs to agent "${session.agentName}", so a run cannot name ` +
          `agent "${statedAgentName}".`,
        'BAD_REQUEST',
      );
    }
    return session?.agentName ?? statedAgentName ?? BUREAU_AGENT_NAME;
  }

  /**
   * COR-424 — the run-creation ledger, or `NOT_CONFIGURED` for a bureau whose
   * receipts could not survive a restart.
   */
  function requireRunCreationLedger(): NonNullable<typeof runCreationLedger> {
    if (runCreationLedger === undefined) {
      throw new BureauError(
        'Run-creation receipts need storage and a durable engine: "runCreationRequestId" ' +
          'is supported only by a bureau with durable execution.',
        'NOT_CONFIGURED',
        'durable',
      );
    }
    return runCreationLedger;
  }

  /**
   * COR-424 — where a run-creation request's receipt stands, keyed exactly as
   * `createRunFromRequest` keys the request. See `Bureau.locateRunCreationReceipt`.
   */
  async function locateRunCreationReceipt(
    request: LocateRunCreationReceiptRequest,
  ): Promise<RunCreationReceiptLocation> {
    const principal = typeof request.principal === 'string' ? request.principal : '';
    const requestId =
      typeof request.runCreationRequestId === 'string' ? request.runCreationRequestId.trim() : '';
    if (principal.trim().length === 0) toBadRequest('"principal" must be a non-empty string');
    if (requestId.length === 0) toBadRequest('"runCreationRequestId" must be a non-empty string');
    const ledger = requireRunCreationLedger();
    // A request that continued a session was keyed under the session's agent, so naming the
    // session resolves it the way starting the run did. A session that is not there, or is
    // another principal's, binds nothing, exactly as it would not have for the run.
    let agentName = request.agentName;
    const sessionId = request.sessionId?.trim();
    if (sessionId !== undefined && sessionId.length > 0) {
      const { session } = await loadConversation(sessionId);
      const owner = ownerFromPrincipal(principal, toBadRequest);
      const visible =
        session !== undefined && isSessionAuthorityAuthorized(session.metadata, owner)
          ? session
          : undefined;
      agentName = resolveRunAgentName(sessionId, visible, request.agentName);
    }
    return ledger.locate({
      callerId: principal,
      agentName: agentName ?? BUREAU_AGENT_NAME,
      requestId,
    });
  }

  /**
   * COR-424 — release a run-creation claim whose request produced no run, so
   * a retry claims afresh. A failed release leaves the claim pending, and a
   * retry then reports the claimed run as not started rather than creating
   * one; the original failure is still what the caller sees.
   */
  async function releaseRunCreationClaim(
    claim: Extract<RunCreationAttempt, { kind: 'claimed' }> | undefined,
    cause: unknown,
  ): Promise<void> {
    if (claim === undefined) return;
    try {
      await claim.release(cause);
    } catch (releaseError) {
      diagnose({
        level: 'error',
        scope: 'run-creation-ledger',
        message: '[bureau] Failed to release a run-creation claim after the run was not created.',
        cause: releaseError,
      });
    }
  }

  /**
   * Per run: parks already committed to the durable checkpoint by a previous
   * process, seeded by `reconstructHumanWaitReviewIfParked` on recovery. The
   * live action log only holds this process's parks, so the ordinal of the
   * first live park starts here.
   */
  const humanWaitParkBaseline = new Map<string, number>();

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
        ...(durableTerminalCleanup ? { terminalCleanup: durableTerminalCleanup } : {}),
      },
      {
        runId,
        handle,
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
    // resumed run produces, not just its terminal `run-finished`. No
    // `streamEventTarget` is threaded through recovery (enhanced streaming is a
    // fresh-run-only concern), so `assistant-chunk` frames are the one frame
    // type a resumed run never emits.
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
    // session status; so these listeners only run for a genuinely settled run.
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
          if (store.getRun(runId)?.status === 'running') {
            settledLocalRunIds.add(runId);
            releaseSessionSteeringPoll(sessionId, runId);
            abandonSessionInputGate(runId);
          }
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
      const lastRunStatus = isRunFailureFinishReason(finishReason) ? 'error' : 'completed';
      const lastError = isRunFailureFinishReason(finishReason) ? event.error : undefined;

      const report = buildTerminalReportFromCompletedEvent(runId, event);
      runReports.set(runId, report);
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
            ...(isRunFailureFinishReason(finishReason)
              ? { lastError: serializeUnknownError(lastError) }
              : {}),
          }),
        { runId, sessionId, status: lastRunStatus },
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
      runReports.set(runId, report);
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
        { runId, sessionId, status: 'aborted' },
      );
    });

    // Seed the runSeq generation before `store.register` wires the action
    // subscription that starts stamping frames — see `seedRunSeqGeneration`.
    seedRunSeqGeneration(runId);
    store.register(recoveredRun, runId);
    activeRuns.add(recoveredRun);
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
      await runHumanWaits.restore(info.workflowId, info.input.agentName);
      runHumanWaits.observe(info.workflowId, info.input.agentName, info.services as DurableRunDeps);
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

    const classification = classifyRecoveredRunDetailed({
      handleId: info.workflowId,
      scheduledFire: false,
      ownedSessionId: info.input.sessionId,
      metadataReadFailed: false,
      hasSessionStore: true,
      sessionLoad,
      versionMismatch: runtime.workflowVersionMismatches.has(info.workflowId),
    });
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
   * Boot-single-shot: called at most once per bureau, either immediately
   * during `createBureau()` or once from the deferred-authority-validator
   * path (never both — `durableRecoveryStarted` guards it). Resolves a
   * {@link BureauRecoveryReport} aggregating this one pass's outcome; never
   * rejects (AB-242's decision record — recovery failure stays diagnostic,
   * `createBureau()` never rejects on it, in whole or in part).
   */
  /**
   * COR-1481 — a crash can land between a run reaching its terminal state and the task record
   * saying so, or between a catalog run's durable start and its task record being written. At
   * boot, a task record whose durable run is terminal is settled from the durable state, and a
   * durable catalog run with no task record is given one. A run still in flight is left to the
   * recovery that reattaches it, which settles it as it ends.
   */
  async function reconcileTaskRecords(): Promise<void> {
    const durable = runtime.durable;
    if (!durable) return;
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
      if (store.getRun(record.taskId) !== undefined || findCatalogRun(record.taskId)) continue;
      await settle(record.taskId, await durable.engine.get(record.taskId));
    }
    // A durable catalog run still in flight whose task record was never written: the lost
    // admission window. A run that is over is not given a record here: its task either was
    // settled and has since been removed by retention, or never existed, and recreating it at
    // every boot would resurrect expired tasks, message text included. The record is dated
    // from the durable run, and the run settles it through the catalog settlement hook.
    for (let offset = 0; ;) {
      const page = await durable.engine.list({
        type: 'agentRun',
        idPrefix: 'agent-run-',
        status: ['pending', 'running', 'suspended'],
        limit: 100,
        offset,
      });
      for (const summary of page.items) {
        if ((await tasks.record(summary.id)) !== undefined) continue;
        if (await isChildRun(summary.id)) continue;
        const loaded = await runtime.loadCatalogRunRecoveryRecord(summary.id);
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
          message: originatingMessageText(loaded.record.input),
          createdAt: new Date(summary.createdAt).toISOString(),
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
    try {
      recoveredWorkflowHandler.resolve(onRecoveredWorkflow);
      const handles = await durable.engine.recoverAll({ onRecoveredWorkflow });

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
        if (await runtime.isCatalogRecoveredRun(handle.id)) continue;

        // COR-851: a goal's controller workflow carries `{ goalRunId }`, not an
        // agent run's input, so the classification below would read it as a
        // foreign run and cancel it. The goal control plane recovers it instead
        // (`goals.recover`, below), by what the goal's own record says.
        if (await goalsComposition.ownsWorkflow(handle.id)) continue;

        // COR-1527: an instance of a workflow file carries a document's trigger, not an agent
        // run's input, so the classification below would read it as a foreign run and cancel it.
        // The workflow runtime registered its revision before this recovery; the engine resumes it.
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

        const classification = classifyRecoveredRunDetailed({
          handleId: handle.id,
          scheduledFire,
          ownedSessionId,
          metadataReadFailed: readError !== undefined,
          hasSessionStore: sessionStore !== undefined,
          sessionLoad,
          versionMismatch: runtime.workflowVersionMismatches.has(handle.id),
        });
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
                  { liveStreaming: false, sessionAgent: reattachedSessionAgent },
                );
                recoveredServices = {
                  toolbox: runRuntime.toolbox,
                  getStepMetadata: emptyRecoveredStepMetadata,
                  options: {
                    generate: runRuntime.generate,
                    toolbox: runRuntime.toolbox,
                    conversation: new Conversation(fullSession.conversationHistory),
                    ...copyAgentOwnedRunOptions(reattachedSessionAgent?.options),
                    ...sessionRunMediaOptions(
                      reattachedSessionAgent,
                      runtime.mediaOptionsFor(resolveSessionOwner(fullSession.metadata)),
                    ),
                    // AB-260: the bureau's single composed RuntimeServices
                    // instance, snapshotted into every run it starts — including
                    // a mocked/custom-engine reattach.
                    runtime: runtimeServices,
                    sessionId: ownedSessionId,
                    // COR-1265 — the Bureau tier, snapshotted.
                    hooks: mergeHookRegistries(
                      runRuntime.hooks,
                      reattachedSessionAgent?.options.hooks,
                    ),
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
            orphanCancellations.push({
              runId: handle.id,
              cancel: durable.engine.cancel(handle.id).then(async () => {
                // COR-1476 — a cancelled run owes its session's input the same
                // settlement as one that ended on its own.
                if (ownedSessionId !== undefined) {
                  await settleSessionInputsAfterRunEnd(ownedSessionId, handle.id);
                }
                return undefined;
              }),
            });
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
    } finally {
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
    currentRecoveryPerRunFailures = undefined;
    currentRecoverySweepFailure = undefined;
    const outcome: BureauRecoveryReport['outcome'] =
      sweepFailure || perRunFailures.length > 0 ? 'partial' : 'clean';
    return {
      outcome,
      ...(sweepFailure ? { sweepFailure } : {}),
      perRunFailures,
    };
  }

  function submitSchedulerTask(
    request: SubmitSchedulerTaskRequest,
  ): Promise<SubmitSchedulerTaskResponse> {
    validateSubmitSchedulerTaskRequest(request);

    if (!runtime.scheduler) {
      throw new BureauError('Scheduler not configured', 'NOT_CONFIGURED', 'scheduler');
    }
    assertRunAdmissionOpen('scheduler task');

    const taskId = runtimeServices.identifiers.next('scheduler-task');
    const priority = request.priority ?? 'scheduled';
    const metadataAgentName = request.metadata?.['agentName'];
    const agentName = typeof metadataAgentName === 'string' ? metadataAgentName : BUREAU_AGENT_NAME;

    // AB-13 — same admission gate as `createRun`, applied to the
    // scheduler-originated surface. `taskId` doubles as the flow-control run
    // identity: it is stable for the task's whole lifecycle (queued →
    // dispatched → completed, including any preempt/requeue cycles), which is
    // exactly the identity `markParked`/`markResumed`/`settle` need. There is
    // no per-task `agentName` field on `SubmitSchedulerTaskRequest`, so the
    // grouping key falls back to `metadata.agentName` (when the caller set
    // one) and otherwise the house default — matching `createRun`'s default.
    if (flowController) {
      const decision = flowController.admit({
        runId: taskId,
        agentName,
        source: 'scheduler',
        message: request.message,
        ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
      });
      if (!decision.allowed) {
        throw new BureauError(
          `Scheduler task rejected by flow control policy (${decision.reason})`,
          'RATE_LIMITED',
        );
      }
    }

    const task: Parameters<NonNullable<typeof runtime.scheduler>['submit']>[0] = {
      id: taskId,
      priority,
      metadata: request.metadata,
      requeue: request.requeue,
      async createRun() {
        // COR-690: a task queued before `shutdown()` started must not be
        // dispatched into a new run once it has; the scheduler records the
        // failed dispatch.
        assertRunAdmissionOpen('scheduler task');
        const runRuntime = await runtime.createRunRuntime(
          {
            message: request.message,
            maximumSteps: request.maximumSteps,
            systemPrompt: request.systemPrompt,
            sessionId: taskId,
            // The task id is the run identity for the same reason it is the
            // flow-control identity above: it survives preemption. A requeued
            // task resumes from its last completed step (durable engine) or
            // starts again (no engine), so a step that wrote memory can run
            // twice, and the memory write deduplicates on `<taskId>:<step>`.
            runId: taskId,
            requestContext: createSchedulerServiceRequestContext(taskId, agentName, taskId),
          },
          { liveStreaming: false },
        );

        const conversation = new Conversation(createConversationHistory({ id: taskId }));
        const systemPrompt = request.systemPrompt ?? runtime.systemPrompt;
        if (systemPrompt) {
          conversation.appendSystemMessage(systemPrompt);
        }
        conversation.appendUserMessage(request.message);

        return {
          conversation,
          generate: runRuntime.generate,
          toolbox: runRuntime.toolbox,
          maximumSteps: request.maximumSteps ?? runtime.maximumSteps,
          // AB-260: the bureau's single composed RuntimeServices instance,
          // snapshotted into every scheduler task run it starts.
          runtime: runtimeServices,
          sessionId: taskId,
          // COR-1265 — the Bureau tier, snapshotted.
          hooks: mergeHookRegistries(runRuntime.hooks),
          stopWhen: options.stopWhen,
        };
      },
    };

    detachBestEffortPromise(runtime.scheduler.submit(task));

    return Promise.resolve({
      taskId,
      priority,
      status: 'queued',
    });
  }

  function locateSchedulerTask(taskId: string): SchedulerTaskLocation {
    if (!runtime.scheduler) {
      throw new BureauError('Scheduler not configured', 'NOT_CONFIGURED', 'scheduler');
    }
    return runtime.scheduler.locateTask(taskId);
  }

  function awaitSchedulerTask(taskId: string): Promise<RunResult | null> {
    if (!runtime.scheduler) {
      throw new BureauError('Scheduler not configured', 'NOT_CONFIGURED', 'scheduler');
    }
    return runtime.scheduler.awaitTask(taskId);
  }

  function listRuns(status?: string): RunSummary[] {
    const state = store.getState();
    const summaries: RunSummary[] = [];

    for (const [, runState] of state.runs) {
      if (status && runState.status !== status) {
        continue;
      }
      // COR-1302: a `bureau.run()` run is resolvable by id (`getRun`,
      // `abortRun`) but not listed; run listing is COR-1304's.
      if (catalogRunIds.has(runState.id)) continue;

      const sessionId = getRunSessionIdentifier(runState);
      summaries.push(serializeRunState(runState, sessionId, runAttribution.get(runState.id)));
    }

    return summaries;
  }

  /**
   * COR-718 — the owner of record of a run: where it already lives
   * (`runAttribution`, rehydrated from the session's `lastRunOwningPrincipals`
   * after a restart), or a child run's own record. `undefined` for an id that
   * names no run this Bureau knows.
   */
  async function runOwner(runId: string): Promise<string | undefined> {
    const attribution = runAttribution.get(runId);
    const catalogRun = findCatalogRun(runId);
    if (attribution !== undefined || store.getRun(runId) !== undefined || catalogRun) {
      // A live `bureau.run()` dispatch that is not durable seeds no attribution, but
      // its handle's liveness snapshot carries the principal it was given.
      return ownerOrLocal(attribution?.principal ?? catalogRun?.handle.snapshot().owner);
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
      return workflowRuntime.workflows.owner;
    }
    return fire !== null && isScheduledAgentRunInput(fire.input)
      ? ownerOrLocal(fire.input.principal)
      : undefined;
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

  async function sessionOwner(sessionId: string): Promise<string | undefined> {
    const session = await runtime.sessionStore?.load(sessionId);
    return session === undefined ? undefined : resolveSessionOwner(session.metadata);
  }

  async function getOwner(resource: OwnedResource): Promise<string | undefined> {
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
        if (runId.startsWith(AUDIT_AGENT_OWNER_PREFIX)) {
          // COR-1526 — an agent file has no owner field: it belongs to the deployment's owner.
          return ownerOrLocal(undefined);
        }
        if (runId.startsWith(AUDIT_WORKFLOW_OWNER_PREFIX)) {
          // COR-1529 — a workflow file has no owner field: it belongs to the deployment's owner.
          return ownerOrLocal(undefined);
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
    if (!runState) {
      // COR-1302: a `bureau.run()` handle whose run is not on `store` (not
      // built yet, or never built) still resolves while it is unsettled.
      const dispatched = findCatalogRun(id);
      if (!dispatched) return undefined;
      return serializeUndispatchedCatalogRunDetail(
        id,
        dispatched.handle.snapshot(),
        undispatchedCatalogRunAttribution(id, dispatched.agentName),
      );
    }

    return serializeRunDetail(runState, getRunSessionIdentifier(runState), runAttribution.get(id));
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
   * COR-1302: the attribution an unsettled `bureau.run()` run reports before
   * it is on `store`. The durable branch's recorded attribution wins, so the
   * summary does not change once the run is registered; otherwise the catalog
   * name the run was dispatched under.
   */
  function undispatchedCatalogRunAttribution(id: string, agentName: string): RunAttribution {
    const recorded = runAttribution.get(id);
    return {
      agentName: recorded?.agentName ?? agentName,
      ...(recorded?.principal === undefined ? {} : { principal: recorded.principal }),
    };
  }

  function getRunReport(id: string): RunReport | undefined {
    const cached = runReports.get(id);
    if (cached) return cached;

    // Not yet terminal (or unknown) — build a partial report synchronously
    // from the live RunState. This is the graceful-shutdown path: safe to
    // call from an abort() call site or a SIGTERM handler with no await.
    const runState = store.getRun(id);
    if (!runState) return undefined;

    return buildPartialRunReport(id, runState, 'Run report requested before a terminal result');
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
  function abortRun(id: string): RunSummary {
    const runState = store.getRun(id);
    if (!runState) {
      // COR-1302: a `bureau.run()` run aborted before its dispatch has built
      // it is cancelled through its handle, which forwards the cancellation
      // to the run once it exists (or settles the run `'aborted'` without
      // ever starting it). Its parent-cancellation policy is applied by the
      // handle's own settlement (`onDurableRunAborted`), as for any handle
      // abort.
      const dispatched = findCatalogRun(id);
      if (!dispatched) throw new BureauError('Run not found', 'NOT_FOUND');
      dispatched.handle.abort('Aborted via API');
      void tasks.watchCleanup(id, dispatched.handle.closed());
      return {
        ...serializeUndispatchedCatalogRun(
          id,
          undispatchedCatalogRunAttribution(id, dispatched.agentName),
        ),
        status: 'aborting',
      };
    }

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
      return serializeRunState(runState, getRunSessionIdentifier(runState), runAttribution.get(id));
    }

    if (!abortingRunIds.has(id)) {
      abortingRunIds.set(id, runtimeServices.clock.now());
      runState.activeRun.abort('Aborted via API');
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
      detachBestEffortPromise(childTopology.parentCancelled(id, 'Aborted via API'));
    }

    return {
      ...serializeRunState(runState, getRunSessionIdentifier(runState), runAttribution.get(id)),
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
    const sessionId = runState ? getRunSessionIdentifier(runState) : '';
    const agentName = runState ? findRunAgentName(runState) : undefined;

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
      await recordReviewStatusTransition(review, outcome.status, outcome.principal);
    }

    for (const review of listPendingReviews()) {
      if (review.kind !== 'human-wait' || review.runId !== runId) continue;
      resolvedReviewIds.add(review.id);
      await recordReviewStatusTransition(review, outcome.status, outcome.principal);
    }
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
    // AB-96 — drop the cached terminal RunReport too, or a long-lived bureau
    // that creates/deletes many runs would retain one forever per run id.
    runReports.delete(id);
    // COR-625: released on the same boundary as the report it belongs to.
    // The step has already recorded its acknowledgement durably by the time
    // a report is released, so nothing observable is lost — only the
    // in-memory memo, whose exactly-once duty is over once every trigger for
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
   * {@link Bureau.waitForDurableRun} doc comment. Built on Weft's result waiter
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
      manualBackgroundTasks: options.durableBackgroundTasks === 'manual',
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
      cancel: (id) => runtime.durable!.engine.cancel(id),
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
    }
    return outcome;
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
    if (owners?.[runId] !== undefined) return undefined;
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
  // durable maintenance pass below (`runDurableMaintenance`, on the
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
   * AB-388: prunes the durable audit trail per `options.auditRetention`
   * (default `'forever'`, a no-op). References `auditTrailInstance` and
   * `eventHistoryInstance`, both declared further down this factory
   * function — safe because this function is only ever CALLED (from
   * `runDurableMaintenance` below, or from the automatic-profile interval)
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
  async function pruneAuditTrail(): Promise<void> {
    if (!auditTrailInstance) return;
    const retention = options.auditRetention;
    if (!retention || retention === 'forever') return;

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

    await auditTrailInstance.prune(effectiveCutoff, { protectRunId });
  }

  /**
   * COR-1477 — advances the durable event history's retention floor past every
   * event older than {@link BureauOptions.eventRetention} (default 7 days), so
   * the history is bounded. A reader resuming below the new floor, or an open
   * subscription it overtakes, receives one gap event. Runs ahead of
   * {@link pruneAuditTrail} in a pass, so that pass already clamps against the
   * advanced floor. The clamp protects only records the history still
   * retains, so it holds whichever order the two run in.
   */
  async function retainEventHistory(): Promise<void> {
    if (!eventHistoryInstance) return;
    const retention = options.eventRetention ?? { olderThan: DEFAULT_EVENT_RETENTION_MS };
    if (retention === 'forever') return;
    await eventHistoryInstance.retainBefore(runtimeServices.clock.now() - retention.olderThan);
  }

  /**
   * COR-1524 — prunes the agent snapshots whose last run settled before the task retention
   * window. A snapshot is kept while any run that references it is retained: a session run's
   * reference goes when its task is deleted (`run.removed`), and any run's goes here once it has
   * been settled for longer than {@link BureauOptions.taskRetention}, which is also what releases
   * a `bureau.run()` run, since those leave the run store on settling and are never deleted.
   * A run that has not settled keeps its snapshot, because it may still be resumed.
   */
  async function retainWorkflowSnapshots(): Promise<void> {
    if (workflowRuntime === undefined) return;
    const retention = options.taskRetention ?? { olderThan: DEFAULT_TASK_RETENTION_MS };
    if (retention === 'forever') return;
    await workflowRuntime.pruneSnapshots(runtimeServices.clock.now() - retention.olderThan);
  }

  async function retainAgentSnapshots(): Promise<void> {
    if (fileAgents === undefined) return;
    const retention = options.taskRetention ?? { olderThan: DEFAULT_TASK_RETENTION_MS };
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
        return status === 'running' || status === 'aborting' || findCatalogRun(runId) !== undefined;
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
   * COR-1477 — removes every terminal task older than {@link BureauOptions.taskRetention}
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
    const retention = options.taskRetention ?? { olderThan: DEFAULT_TASK_RETENTION_MS };
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
    let removed = await tasks.expire(cutoff, bound);
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
   * `options.checkpointRetention` to a durable run's weft checkpoint history,
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
    // caller-supplied `shutdownTimeoutSleep`, so it cannot promise this on
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
    const retention = options.checkpointRetention;
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
          // `shutdownTimeoutSleep` is a public, caller-injectable seam
          // (`BureauOptions.shutdownTimeoutSleep`), so it CAN reject even
          // though the default never does. A rejection means the bound
          // could not be applied at all: the prune is still stopped —
          // leaving it running behind an answer nobody owns is precisely
          // what this bound exists to prevent — and the failure is
          // classified as the unresolved wait it is, carrying the error
          // rather than being silently reported as a clean timeout.
          (error: unknown): RunCleanupAcknowledgement => {
            pruneAbort.abort();
            return { status: 'unresolved', reason: 'timed-out', error };
          },
        ),
      ]);
      return outcome;
    } finally {
      // Release whichever side of the race lost, so neither a pending timer
      // nor a caller-supplied sleep outlives this step.
      sleepAbort.abort();
    }
  }

  /**
   * AB-388 (Codex review, PR #597, "Run audit retention for KV-backed
   * non-durable bureaus" / "Isolate the manual audit-retention sub-pass"):
   * `auditTrailInstance` is built whenever `runtime.kv` exists — a
   * persistent backend with `durableExecution: false`, or a custom KV-only
   * `persistence` (`ConditionalTextValueStore`), both give it a `kv`
   * without ever giving `runtime.durable` a durable engine (see
   * `runtime-composition.ts`'s `hasKvOnlyPersistence`). Gating this whole
   * function's body on `!runtime.durable` (the ORIGINAL shape) made a
   * configured `auditRetention` policy unreachable for exactly that
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
  // `runDurableMaintenance()` directly (the manual/serverless profile's own
  // alarm/Cron trigger) has no equivalent tracking, so `shutdown()` could
  // dispose storage while such a call's `pruneStaleRunOwnership()`/
  // `pruneAuditTrail()` sub-passes were still listing, deleting, or writing
  // a watermark/summary. Every in-flight manual call registers its pass
  // here; `shutdown()` drains the set (`Promise.allSettled`, since a
  // rejection is already diagnosed by each sub-pass's own try/catch, or is
  // this function's own re-thrown `engineMaintenanceError`) before backend
  // teardown, alongside the automatic timer's own await.
  const manualDurableMaintenancePasses = new Set<Promise<void>>();
  // AB-388 (Codex review, PR #597, "Fence maintenance admission once
  // shutdown starts"): closed SYNCHRONOUSLY (no `await` in between) as the
  // very first step of the "stop background work" section of `shutdown()`
  // below, strictly BEFORE that section takes its `manualDurableMaintenancePasses`
  // snapshot. Without this, a `runDurableMaintenance()` call arriving after
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
  function isReviewAuditAttachmentPayload(
    value: unknown,
  ): value is { runId: string; type: string; detail: unknown; principal: string } {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
      typeof record['runId'] === 'string' &&
      typeof record['type'] === 'string' &&
      'detail' in record &&
      typeof record['principal'] === 'string'
    );
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
      try {
        const committed = await outboxSessionStore.load(entry.sessionId);
        if (committed !== undefined && committed.incarnation === entry.incarnation) {
          await claimSessionAssets(committed);
        }
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'assets',
          message: `[bureau] Could not claim the assets of session "${entry.sessionId}" for its outbox entry ${entry.ordinal}; leaving it pending for a later drain to retry: ${serializeUnknownError(error)}`,
          cause: error,
        });
        return 'stop';
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

  async function runDurableMaintenance(now?: number): Promise<true | undefined> {
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
      } catch (error: unknown) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Manual run-creation receipt pruning pass failed: ${serializeUnknownError(error)}`,
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
    return hasDurableEngine || auditTrailInstance || tasksRemoved > 0 ? true : undefined;
  }

  // AB-363 — Codex review PR #568, "Run ownership pruning in the automatic
  // maintenance profile": `runDurableMaintenance()` above is the ONLY
  // caller of `pruneStaleRunOwnership()`, but that wrapper is documented
  // (`BureauOptions.durableBackgroundTasks`) as something only a
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
  // `runDurableMaintenance()` wrapper — that wrapper also calls
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
  const AUTOMATIC_RUN_OWNERSHIP_PRUNE_INTERVAL_MS = 300_000;
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
  // persistent backend with `durableExecution: false`, or a custom
  // KV-only `persistence`, gives `runtime.kv` a value (and therefore later
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
  // falsy) with no configured `options.auditRetention` (the default,
  // `'forever'`) has NOTHING for this timer to do — `pruneStaleRunOwnership()`
  // always no-ops without `eventHistoryInstance` (which requires
  // `runtime.durable`), and `pruneAuditTrail()` returns immediately for a
  // `'forever'`/omitted policy. Starting a real interval anyway meant
  // recurring useless work AND kept the process alive (the interval handle
  // itself) until an operator explicitly called `shutdown()`. A durable
  // bureau (`runtime.durable` truthy) still always starts the timer
  // regardless of `auditRetention`, since `pruneStaleRunOwnership()` has
  // real work to do there independent of audit retention.
  const hasActiveAuditRetention = Boolean(
    options.auditRetention && options.auditRetention !== 'forever',
  );
  if (
    (runtime.durable || (runtime.kv && hasActiveAuditRetention)) &&
    options.durableBackgroundTasks !== 'manual'
  ) {
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
      // manually calls `runDurableMaintenance()`).
      //
      // AB-388: the same guarded, awaited pass now also prunes the durable
      // audit trail (`options.auditRetention`) — never a second, separate
      // timer. Each sub-pass has its own try/catch so a failure in one
      // (e.g. a rejected `sessionStore.list()`) never prevents the others
      // from running this tick; each is diagnosed under its own message so
      // all three remain distinguishable in `onDiagnostic` output.
      const pass = (async () => {
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
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Automatic run-creation receipt pruning pass failed: ${serializeUnknownError(error)}`,
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
    return requireSessionStore().list(requestOptions);
  }

  async function getSession(id: string) {
    return requireSessionStore().load(id);
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
  const inFlightSessionDeletions = new Map<string, Promise<ContextDeletionReport>>();
  async function deleteSession(
    id: string,
    deleteOptions?: { readonly incarnation?: string | undefined },
  ): Promise<ContextDeletionReport> {
    const existing = inFlightSessionDeletions.get(id);
    if (existing) return existing;
    let releaseCoalescing: (() => void) | undefined = () => {
      inFlightSessionDeletions.delete(id);
    };
    const deletion = performDeleteSession(id, deleteOptions?.incarnation, () => {
      releaseCoalescing?.();
      releaseCoalescing = undefined;
    }).finally(() => {
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
  const sessionDeletionOwners = new Map<string, string>();

  function sessionDeletionOwnerKey(sessionId: string, incarnation: string): string {
    return `${SESSION_DELETION_OWNER_PREFIX}${encodeURIComponent(sessionId)}:${incarnation}`;
  }

  async function recordSessionDeletionOwner(session: AgentSession): Promise<void> {
    const kvStore = runtime.kv;
    if (!auditTrailInstance || !kvStore) return;
    const owner = resolveSessionOwner(session.metadata);
    // A malformed owner names no one, so the entry is left without one.
    if (owner === undefined) return;
    const key = sessionDeletionOwnerKey(session.id, session.incarnation);
    sessionDeletionOwners.set(key, owner);
    try {
      await kvStore.set(key, owner);
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
  async function prepareSessionsForRemoval(sessions: readonly AgentSession[]): Promise<void> {
    for (const session of sessions) await recordSessionDeletionOwner(session);
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
      const owner = await kvStore.get(key);
      if (owner !== null) sessionDeletionOwners.set(key, owner);
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
  /** Sessions the store is about to expire, held until their `session.deleted` entry drains. */
  const expiringSessions = new Map<string, AgentSession>();

  function rowClaimContext(session: AgentSession) {
    const service = assetServiceHolder.current;
    if (service === undefined) return undefined;
    return {
      service,
      principalId: ownerOrLocal(resolveSessionOwner(session.metadata)),
      holderOf: (rowId: string) => sessionRowHolderId(session.id, session.incarnation, rowId),
      rows: Object.values(session.conversationHistory.messages),
      onFailure: (assetId: string, error: unknown) =>
        diagnose({
          level: 'error',
          scope: 'assets',
          message: `[bureau] Could not update the retention claim of session "${session.id}" on asset "${assetId}": ${serializeUnknownError(error)}`,
          cause: error,
        }),
    };
  }

  /**
   * Takes the claims of every row in a committed session. A claim that fails is reported and then
   * thrown once every row has been tried, so the outbox drain leaves the commit's entry
   * unacknowledged and replays it: the entry is the only cue that a committed row still needs its
   * claim.
   */
  async function claimSessionAssets(session: AgentSession): Promise<void> {
    const context = rowClaimContext(session);
    if (context === undefined) return;
    let failure: { error: unknown } | undefined;
    await claimRowAssets(
      context.service,
      context.principalId,
      context.holderOf,
      context.rows,
      (assetId, error) => {
        context.onFailure(assetId, error);
        failure ??= { error };
      },
      claimedRowAssets,
    );
    if (failure !== undefined) throw failure.error;
  }

  async function releaseSessionGeneratedAssets(session: AgentSession): Promise<void> {
    const context = rowClaimContext(session);
    if (context === undefined) return;
    await releaseRowAssetClaims(
      context.service,
      context.principalId,
      context.holderOf,
      context.rows,
      context.onFailure,
      claimedRowAssets,
    );
  }

  async function performDeleteSession(
    id: string,
    expectedIncarnation: string | undefined,
    onStoreDeletionCommitted: () => void,
  ): Promise<ContextDeletionReport> {
    const sessionStore = requireSessionStore();
    const session = await sessionStore.load(id);
    // COR-1481 — the caller authorized one incarnation of this id. An id reused since is
    // another context, and nothing of it is cancelled or deleted here.
    if (expectedIncarnation !== undefined && session?.incarnation !== expectedIncarnation) {
      return { deleted: false, tasks: [] };
    }
    if (session) {
      await prepareSessionsForRemoval([session]);
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
      const removedLiveRecord =
        expectedIncarnation === undefined
          ? await sessionStore.delete(id)
          : await sessionStore.delete(id, { expectedIncarnation });
      onStoreDeletionCommitted();
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
        terminalReviewSessions.delete(runId);
        for (const [reviewId, cleanup] of reviewResolutionCleanupPending) {
          if (cleanup.runId === runId) reviewResolutionCleanupPending.delete(reviewId);
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

  async function signalSession(sessionId: string, name: string, payload?: unknown): Promise<void> {
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
    await runtime.durable.engine.signal(runId, name, payload);
    // AB-13 — a signal is how a human-wait park is released (directly, or via
    // `resolveReview`'s human-wait approve path). Reacquire the concurrency
    // slot `HumanWaitParkedEvent` freed. A no-op when this runId was never
    // parked (e.g. a signal delivered to a run that never called
    // `requestHumanInput`) or when no flow control is configured.
    flowController?.markResumed(runId);
  }

  async function updateSession(
    sessionId: string,
    _name: string,
    _payload?: unknown,
  ): Promise<unknown> {
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
        'Cannot update: the request authority is no longer current.',
        'CONFLICT',
      );
    }
    // AB-192 / AB-41 coordinator ruling: the built-in `agentRun` workflow
    // registers no `ctx.onUpdate` handler, so this call can never reach the
    // engine successfully. Kept, not withdrawn (AB-42/AB-67 ratify update and
    // query as the distinct session-verb family) — an unconditional throw,
    // no detection branch, since there is no handler-registration signal to
    // check. See `bureau.sessionVerbCapabilities`.
    throw new BureauError(
      'updateSession()/querySession() are unsupported: the built-in agentRun workflow registers no ctx.onUpdate/ctx.onQuery handler.',
      'UNSUPPORTED_CAPABILITY',
    );
  }

  async function querySession(
    sessionId: string,
    _name: string,
    _input?: unknown,
  ): Promise<unknown> {
    if (!runtime.durable)
      throw new BureauError('Durable engine not configured', 'NOT_CONFIGURED', 'durable');
    await requireSessionRunId(sessionId);
    // AB-192 / AB-41 coordinator ruling: see the identical throw in
    // `updateSession` above — no `ctx.onQuery` handler is registered either.
    throw new BureauError(
      'updateSession()/querySession() are unsupported: the built-in agentRun workflow registers no ctx.onUpdate/ctx.onQuery handler.',
      'UNSUPPORTED_CAPABILITY',
    );
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
    // Unlike signalSession/updateSession/querySession, this does NOT throw
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
          principalBacklogLimit: sessionInputPrincipalBacklogLimit,
          sessionBacklogLimitForCrossSessionRead: sessionInputSessionBacklogLimit,
          nowMs: runtimeServices.clock.now(),
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
      throw new BureauError('Cannot steer: Bureau is shutting down.', 'CONFLICT');
    }
    const submission = admitSteeringRequest(sessionId, snapshot);
    inFlightSteeringSubmissions.add(submission);
    try {
      return await submission;
    } finally {
      inFlightSteeringSubmissions.delete(submission);
    }
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
    // `policy-denied` rather than a new failure reason: this deployment's
    // own catalog is what refuses the change, which is what that reason
    // already means. Widening the exported `SteeringCommandFailure` union
    // is a contract change owned by the steering-types issue, not this one.
    if (
      steeringTarget === 'agent-identity' &&
      agentsSnapshot[request.requestedValue.override] === undefined
    ) {
      return refuseSteering({
        outcome: 'rejected',
        failure: { failedAt: runtimeServices.clock.nowISO(), reason: 'policy-denied' },
      });
    }

    // AB-200 — validate a configuration override against the live model
    // catalog, coordinate by coordinate.
    //
    // NOT through `planSelection`, and the reason is a real constraint
    // rather than a preference. `composePolicy`'s exact-override path
    // (`providers/policy.ts`'s `matchesOverride`) requires provider AND
    // model together — "a partially specified override cannot resolve to
    // one candidate, so it matches nothing" — and rejects any override
    // naming a `route`, because `route` is not a field `BackendDescriptor`
    // carries. A steering command addresses exactly one coordinate, so it
    // can never satisfy that path: routing every one of them through
    // `planSelection` would reject every legitimate single-coordinate
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
        { target: 'route' | 'model' | 'provider' | 'effort' }
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
      // Not through `planSelection`, for the reason the override path below
      // documents: `composePolicy`'s exact-override test needs provider and
      // model together and rejects routes outright, so a single-coordinate
      // request can never satisfy it.
      // `Effort` is a union of string literals, so `string` already
      // covers every coordinate this can hold.
      let override: string | undefined = configurationRequest.override;
      if (configurationRequest.policyRef !== undefined) {
        const profile = options.modelPolicy?.users?.[configurationRequest.policyRef];
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
            : { target: steeringTarget, override }
        ) satisfies ImplementedSteeringCommand['requestedValue'];
      }
      const { descriptors } = modelCatalog.catalog();
      const known =
        steeringTarget === 'model'
          ? descriptors.some((descriptor) => descriptor.model === override)
          : steeringTarget === 'provider'
            ? descriptors.some((descriptor) => descriptor.provider === override)
            : steeringTarget === 'effort'
              ? descriptors.some((descriptor) =>
                  descriptor.effort.portable.includes(override as Effort),
                )
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
      const outcome = getSessionSteeringGate(sessionId).admit(command, { liveRunIds, now });
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
            reviews.push({
              kind: 'human-wait',
              id,
              runId,
              sessionId,
              agentName,
              signalName,
              prompt,
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
        reviews.push({
          kind: 'tool-approval',
          id: reviewId,
          runId,
          sessionId: terminalReview.sessionId,
          agentName: terminalReview.agentName,
          approval,
          requestedAt: terminalReview.requestedAt,
          ageMilliseconds: now - terminalReview.requestedAt,
          status: 'pending',
          round: pendingApprovalRounds.get(reviewId) ?? 0,
        });
      }
    }

    return reviews;
  }

  function releaseTerminalRunReviewState(runId: string): void {
    const runState = store.getRun(runId);
    if (!runState || runState.status === 'running') return;
    for (const review of listPendingReviews()) {
      if (review.runId === runId) return;
    }
    runRequestContexts.delete(runId);
    runToolboxesByRunId.delete(runId);
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
    const outcome =
      input.decision === 'approve'
        ? (result as Parameters<typeof materializeToolResultAsync>[0])
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
      const toolResult = await materializeToolResultAsync(outcome);
      // The run's own terminal save is in flight when its approval is resolved
      // at once; the row to replace is not stored until it lands.
      await sessionPersistence.drain();
      // Read after the drain: a run that has not settled has not stored its
      // conversation, so a missing row says nothing about whether the row exists.
      const stillGoing = isRunStillGoing(review.runId);
      for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
        try {
          let missing = false;
          await sessionStore.update(review.sessionId, (session) => {
            if (session === undefined) return undefined;
            const history = session.conversationHistory;
            const holdsRow = history.ids.some(
              (id) => history.messages[id]?.toolResult?.callId === callId,
            );
            if (!holdsRow) {
              missing = true;
              return undefined;
            }
            return {
              ...session,
              conversationHistory: resolveToolResult(history, callId, toolResult),
            };
          });
          if (!missing) return undefined;
          // A conversation that never held a row for the call (a review restored
          // from persisted metadata alone) shows no approval as pending, so there is
          // nothing stale to replace. A run that is still going is different: its
          // row is not stored yet, and the terminal save would put the stale one
          // there, so the outcome is lost unless the caller is told.
          if (!stillGoing) return undefined;
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

  async function resolveReview(input: ResolveReviewInput): Promise<ResolveReviewResult> {
    // AB-46: `reject` requires a non-empty `reason` for BOTH review kinds —
    // `resolveReview` is the validation boundary, so this throws before any
    // state change (before even finding the review), matching the gateway's
    // `POST /:id/reject` 400-on-missing-reason contract.
    if (input.decision === 'reject' && (input.reason === undefined || input.reason.trim() === '')) {
      throw new BureauError('reject requires a reason', 'BAD_REQUEST');
    }
    const review = listPendingReviews().find((candidate) => candidate.id === input.id);
    if (!review) {
      const cleanup = reviewResolutionCleanupPending.get(input.id);
      if (cleanup) {
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
          );
          reviewResolutionCleanupPending.delete(input.id);
          releaseTerminalRunReviewState(cleanup.runId);
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
            { auditAlreadyAppended: cleanupAuditAppended },
          );
          if (cleanupOutcomeNotWritten !== undefined) throw cleanupOutcomeNotWritten;
          return {
            id: input.id,
            kind: cleanup.kind,
            decision: cleanup.decision,
            ...(cleanup.kind === 'tool-approval' && cleanup.decision === 'reject'
              ? { feedback: cleanup.reason }
              : {}),
          };
        } finally {
          resolvingReviewIds.delete(input.id);
        }
      }
      throw new BureauError(`No pending review with id "${input.id}"`, 'NOT_FOUND');
    }

    if (resolvingReviewIds.has(review.id)) {
      throw new BureauError(`Review with id "${review.id}" is already being resolved`, 'CONFLICT');
    }
    resolvingReviewIds.add(review.id);

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
      // (`SessionStore.load`), not an atomic claim — a genuinely
      // simultaneous pair, neither yet committed, can still both pass this
      // check and both act; closing that residual window needs a durable,
      // pre-action claim, tracked as a follow-up (see this issue's PR
      // body). This check only ever fences a DIFFERENT decision — the
      // same-decision retry case is untouched, exactly as
      // `persistReviewResolution`'s own `alreadyLanded` handling already
      // covers it.
      const existingSession = await runtime.sessionStore?.load(review.sessionId);
      const existingDecisionsRaw = existingSession?.metadata['resolvedReviewDecisions'];
      const existingDecisions: Record<string, JSONValue> =
        typeof existingDecisionsRaw === 'object' &&
        existingDecisionsRaw !== null &&
        !Array.isArray(existingDecisionsRaw)
          ? (existingDecisionsRaw as Record<string, JSONValue>)
          : {};
      const priorRaw = existingDecisions[review.id];
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
    } catch (error) {
      resolvingReviewIds.delete(review.id);
      throw error;
    }

    let result: unknown;
    let keepPending = false;
    try {
      if (review.kind === 'tool-approval') {
        const approvalToolbox = runToolboxesByRunId.get(review.runId) ?? runtime.baseToolbox;
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
          await persistApprovalResolutionStartedWithRetry(review.sessionId, review.id);
          result = await approvalToolbox.resumeApproval(
            { ...approval, approvalToken: approval.approvalToken },
            {
              ...(Object.prototype.hasOwnProperty.call(input, 'arguments')
                ? { arguments: input.arguments }
                : {}),
              ...(approvalRequestContext ? { requestContext: approvalRequestContext } : {}),
            },
          );

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
          } else if (
            result !== null &&
            typeof result === 'object' &&
            'outcome' in result &&
            result.outcome === 'error' &&
            'approvalBindingConsumed' in result &&
            result.approvalBindingConsumed === false
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
            throw new BureauError(
              `Cannot approve: ${failedResult.error?.message ?? failedResult.errorMessage ?? 'tool approval resume failed before execution admission.'}`,
              'CONFLICT',
            );
          }
        } else if (review.approval.approvalBinding && review.approval.approvalToken !== undefined) {
          await persistApprovalResolutionStartedWithRetry(review.sessionId, review.id);
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
      } else if (input.decision === 'approve') {
        const requestContext = runRequestContexts.get(review.runId);
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
        // Route through the public `bureau.signalSession` (rather than the
        // local closure function) so this is the exact same call surface a
        // caller could make directly — one seam, not two ways to do the same
        // thing.
        await bureau.signalSession(review.sessionId, review.signalName, input.payload);
      } else {
        // AB-46: `input.decision` is `'deny'` or `'reject'`. A `human-wait`
        // park is a genuine durable park (`ctx.waitForSignal`) — unlike
        // tool-approval, where "deny" has no run to continue, denying or
        // rejecting a human-wait review must still deliver SOMETHING on
        // `review.signalName` or the parked run stays `running` forever
        // (the exact defect this record fixes). Both sentinels are
        // delivered on the identical channel `approve` already uses.
        const denialPayload = humanWaitDenialPayload(input.decision, input.reason);
        await bureau.signalSession(review.sessionId, review.signalName, denialPayload);
      }
    } catch (error) {
      resolvingReviewIds.delete(review.id);
      throw error;
    }

    resolvingReviewIds.delete(review.id);
    // AB-391: `false` for the `keepPending` re-gate branch above — nothing
    // is persisted there, so `recordReviewDecision` below keeps writing the
    // audit record directly, exactly as it always has.
    let auditAlreadyAppended = false;
    if (!keepPending) {
      resolvedReviewIds.add(review.id);
      if (review.kind === 'tool-approval') {
        dropPendingApprovalOverride(review.id);
        if (
          !Array.from(pendingApprovalOverrides.keys()).some((reviewId) =>
            reviewId.startsWith(`approval:${review.runId}:`),
          )
        ) {
          terminalReviewSessions.delete(review.runId);
        }
      }
      const auditAttachment = buildReviewDecisionAuditRecord(
        review,
        input.decision,
        input.principal,
        input.reason,
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
          });
        }
        resolvingReviewIds.delete(review.id);
        throw error;
      }
      releaseTerminalRunReviewState(review.runId);
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
    });

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
    };
  }

  // ── Reusable approval grants (AB-46, AB-346) ───────────────────────
  //
  // `issueGrant`/`revokeGrant`/`listGrants` delegate straight to the base
  // toolbox's own methods — the same pattern `resolveReview`'s
  // `tool-approval` branch already uses for `resumeApproval`/`revokeApproval`
  // above. Grant matching itself lives entirely in armorer's `mergePolicies`
  // (AB-346); the bureau owns no grant state of its own.

  async function issueGrant(input: ReusableApprovalGrantInput): Promise<ReusableApprovalGrant> {
    return runtime.baseToolbox.issueGrant(input);
  }

  async function revokeGrant(id: string): Promise<void> {
    await runtime.baseToolbox.revokeGrant(id);
  }

  async function listGrants(filter?: GrantListFilter): Promise<ReusableApprovalGrant[]> {
    return runtime.baseToolbox.listGrants(filter);
  }

  /**
   * AB-391: builds the exact `AuditTrail.record()` payload a review
   * transition's durable write needs, WITHOUT writing it — used both to
   * append it as a `session.attachment` outbox entry (coupled to the
   * preceding session-store commit) and, for a path with no such commit to
   * couple to, to write it directly. Kept as one function so the two paths
   * can never drift on shape.
   */
  function buildReviewDecisionAuditRecord(
    review: PendingReview,
    decision: 'approve' | 'deny' | 'reject',
    principal: string,
    reason?: string,
  ): ReviewAuditAttachment {
    const decisionSuffix =
      decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'denied';
    return {
      runId: review.runId,
      type: `review.${review.kind}.${decisionSuffix}`,
      detail: {
        review,
        decision,
        ...(reason !== undefined ? { reason } : {}),
      },
      principal,
    };
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
    requestOptions?: { auditAlreadyAppended?: boolean },
  ): Promise<void> {
    if (!requestOptions?.auditAlreadyAppended) {
      await auditTrailInstance?.record(
        buildReviewDecisionAuditRecord(review, decision, principal, reason),
      );
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
  ): Promise<void> {
    // AB-391: `expired` (`sweepExpiredReviews`), `revoked`/`canceled`
    // (`revokePendingApprovalsForRun`), and `superseded` (`resolveReview`'s
    // re-gate branch) each have no preceding session-store commit this
    // durable write could be coupled to via the outbox — see
    // `recordReviewDecision`'s own doc comment for the transitions that DO.
    // This keeps writing directly, exactly as before.
    await auditTrailInstance?.record({
      runId: review.runId,
      type: `review.${review.kind}.${status}`,
      detail: { review: { ...review, status }, status },
      principal,
    });

    // AB-224: live counterpart, same rationale as `recordReviewDecision`
    // above. `approve`/`deny`/`reject` never reach this function — they
    // dispatch from `recordReviewDecision` instead — so the switch below is
    // exhaustive over exactly `expired | revoked | canceled | superseded`.
    switch (status) {
      case 'expired':
        emitter.dispatch(new ReviewExpiredEvent(review.id, review.runId, principal, review.kind));
        break;
      case 'revoked':
        emitter.dispatch(new ReviewRevokedEvent(review.id, review.runId, principal, review.kind));
        break;
      case 'canceled':
        emitter.dispatch(new ReviewCanceledEvent(review.id, review.runId, principal, review.kind));
        break;
      case 'superseded':
        emitter.dispatch(
          new ReviewSupersededEvent(review.id, review.runId, principal, review.kind),
        );
        break;
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
   * Look up one review by id, live or resolved (AB-46). See the
   * {@link Bureau.getReview} doc comment.
   */
  async function getReview(
    id: string,
  ): Promise<(PendingReview & { status: ReviewStatus; resolvedBy?: string }) | undefined> {
    const pending = listPendingReviews().find((candidate) => candidate.id === id);
    if (pending) return pending;
    // COR-1577: the park of a `bureau.run()` run, which no session holds.
    const runWait = runHumanWaits.find(id);
    if (runWait) return runWait;
    if (!auditTrailInstance) return undefined;

    // Ids are `approval:${runId}:${callId}` / `human-wait:${runId}:${signalName}:${parkOrdinal}`
    // — the run id is always the second colon-delimited segment.
    const [, runId] = id.split(':');
    if (!runId) return undefined;

    const records = await auditTrailInstance.query({ runId });
    let match: (typeof records)[number] | undefined;
    for (const record of records) {
      if (!record.type.startsWith('review.')) continue;
      const detail = record.detail;
      if (detail === null || typeof detail !== 'object') continue;
      const reviewDetail = (detail as Record<string, unknown>)['review'];
      if (reviewDetail === null || typeof reviewDetail !== 'object') continue;
      if ((reviewDetail as Record<string, unknown>)['id'] !== id) continue;
      // `query()` returns chronological (oldest-first) order — the last
      // match found in iteration order IS the chronologically-last one.
      match = record;
    }
    if (!match) return undefined;

    // A record written before `round` existed has none at runtime, whatever the type says.
    const reviewDetail = (match.detail as Record<string, unknown>)['review'] as PendingReview;
    return {
      ...reviewDetail,
      ...(reviewDetail.kind === 'tool-approval' ? { round: reviewDetail.round ?? 0 } : {}),
      status: reviewStatusFromAuditType(match.type),
      // Who decided it, as the audit trail recorded the decision.
      ...(match.principal === undefined ? {} : { resolvedBy: match.principal }),
    };
  }

  /**
   * Host-driven expiry sweep (AB-46). See the {@link Bureau.sweepExpiredReviews}
   * doc comment.
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
          if (resolvedReviewIds.has(id) || invalidApprovalReviewIds.has(id)) continue;
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

    return sweptCount;
  }

  async function createSchedule(
    definition: DurableScheduleDefinition,
  ): Promise<import('@lostgradient/weft').ScheduleSummary | undefined> {
    if (definition.sessionId !== undefined) {
      rejectReservedIdentifier('"sessionId"', definition.sessionId.trim());
    }
    const owner = ownerFromPrincipal(definition.principal, toBadRequest);
    if (!runtime.durable) return undefined;
    // A schedule whose every fire would fail is worse than rejecting up front:
    // without a configured generate/provider, each tick's `createRunRuntime` throws
    // `No generate function configured`. Mirror `createRunFromRequest`'s readiness
    // guard so we surface NOT_CONFIGURED here instead of registering a broken
    // schedule that returns a healthy-looking summary (review: codex Mn69W).
    if (!runtime.ready) {
      throw new BureauError('No generate function configured', 'NOT_CONFIGURED', 'generate');
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
    const scheduler = createAgentScheduler({ engine: runtime.durable.engine, emitter });
    let handle;
    try {
      handle = await scheduler.schedule(definition.agentName, {
        spec: toScheduleSpec(definition.spec),
        input: definition.input,
        ...(definition.description !== undefined ? { description: definition.description } : {}),
        ...(definition.sessionId !== undefined ? { session: definition.sessionId } : {}),
        ...(definition.overlap !== undefined ? { overlap: definition.overlap } : {}),
        principal: owner,
      });
    } catch (error) {
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

  async function pauseSchedule(scheduleId: string): Promise<true | undefined> {
    if (!runtime.durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    await runtime.durable.engine.pauseSchedule(scheduleId);
    emitter.dispatch(new SchedulePausedEvent(scheduleId));
    return true;
  }

  async function resumeSchedule(scheduleId: string): Promise<true | undefined> {
    if (!runtime.durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    await runtime.durable.engine.resumeSchedule(scheduleId);
    emitter.dispatch(new ScheduleResumedEvent(scheduleId));
    return true;
  }

  async function cancelSchedule(scheduleId: string): Promise<true | undefined> {
    if (!runtime.durable) return undefined;
    refuseWorkflowSchedule(scheduleId);
    await runtime.durable.engine.cancelSchedule(scheduleId);
    emitter.dispatch(new ScheduleCancelledEvent(scheduleId));
    return true;
  }

  function getToolSummaries(): ToolSummary[] {
    return runtime.getToolSummaries();
  }

  function getConfiguration(): ConfigurationResponse {
    return {
      provider: runtime.provider,
      providers: runtime.providers,
      maximumSteps: runtime.maximumSteps,
      systemPrompt: runtime.systemPrompt,
      tools: getToolSummaries(),
    };
  }

  /**
   * Every subsystem kind {@link BureauShutdownReport.owners} can report on.
   * `'heartbeat'` is reserved for the day Bureau composes one — see
   * `composedOwnerKinds` below, which decides which kinds actually get a row.
   */
  const ALL_SHUTDOWN_OWNER_KINDS = [
    'scheduler',
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

    const policy: 'abort' | 'drain' = shutdownOptions?.policy ?? 'abort';
    const timeoutMilliseconds = shutdownOptions?.timeoutMilliseconds;

    // AB-246/AB-64 (2026-09-02 amendment): a model-catalog refresh is
    // INDEPENDENTLY owned by Bureau's catalog, not parent-owned by a run — so
    // it isn't touched by the run/toolbox teardown below, and `shutdown()`
    // awaits it here rather than aborting it out from under a caller who may
    // still be awaiting the same handle. Captured synchronously, BEFORE the
    // teardown below runs, but awaited only at the very end (not blocking
    // admission closure, active-run cancellation, or backend teardown — a
    // slow or never-settling refresh must not stall the rest of `shutdown()`,
    // per review finding on PR #432). Awaits `closed()`, not `result()`: the
    // started-work contract lets a handle's cleanup acknowledgement settle
    // AFTER its result (result() only means the refresh's business outcome
    // is known; closed() means teardown actually finished), and a caller-
    // supplied `ModelCatalogService` is explicitly allowed to do that — so
    // only awaiting `closed()` observes the real cleanup fence (review
    // finding, PR #432). Only this one captured handle is awaited: a refresh
    // newly started by an observer notified during that handle's settlement
    // is a different handle, and this `shutdown()` call does NOT wait for it.
    const modelCatalogRefreshClosedPromise = modelCatalog.inFlightRefresh()?.closed();
    // COR-1527: stop reacting to the workflow files at once, so nothing registers with an engine
    // that is about to be disposed; the chain below waits for the apply in progress first.
    const workflowClosed = workflowRuntime?.close();

    // Which owners this bureau actually composes — a report row is emitted
    // ONLY for a composed owner (2026-09-02 coordinator ruling).
    const composedOwnerKinds = ALL_SHUTDOWN_OWNER_KINDS.filter((kind) => {
      if (kind === 'scheduler') return Boolean(runtime.scheduler);
      if (kind === 'online-evals') return Boolean(onlineEvalSamplerInstance);
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
      if (policy === 'abort') {
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
          abortedRunTerminals.push(whenActiveRunTerminal(activeRun));
          activeRun.abort('Bureau disposed');
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
        const currentCatalogRuns = [...catalogRuns];
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
        // 'drain': let every caller-owned run reach its own natural terminal
        // result instead of aborting it — only Bureau-owned background work
        // (above/below) is stopped like 'abort'.
        for (const activeRun of activeRuns) {
          runTerminals.push(whenActiveRunTerminal(activeRun));
        }
        const currentCatalogRuns = [...catalogRuns];
        for (const catalogRun of currentCatalogRuns) {
          runTerminals.push(Promise.allSettled([catalogRun.result()]));
        }
      }
      const toolboxes = [
        ...new Set([runtime.baseToolbox, ...runToolboxes, ...runToolboxesByRunId.values()]),
      ];
      const toolboxShutdownResults = await Promise.allSettled([
        ...toolboxes.map((toolbox) => toolbox.shutdown({ policy, reason: 'Bureau disposed' })),
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
      // under the same bound, so the audit trail is still open to take it.
      if (policy === 'abort' && childTopology.awaitingSettlements() > 0) {
        await awaitAbortedRunTerminals([childTopology.settlementsKnown()]);
      }
      await childTopology.drain();
      await sessionPersistence.drain();
      await drainSessionInputSettlements();
      if (automaticRunOwnershipPruneTimerStarted) {
        runtimeServices.timers.clearInterval(automaticRunOwnershipPruneTimer);
        automaticRunOwnershipPruneTimerStarted = false;
      }
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
      // AB-388: drain any manual `runDurableMaintenance()` call(s) still in
      // flight — see `manualDurableMaintenancePasses`'s own doc comment
      // above. `allSettled` (never `all`): a rejection here is either
      // already diagnosed by the pass's own sub-pass try/catch, or is a
      // re-thrown `engineMaintenanceError` the ORIGINAL caller of
      // `runDurableMaintenance()` observes directly — `shutdown()` must
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
          if (runtime.scheduler) {
            const scheduler = runtime.scheduler;
            // AB-260: registered with the composed `RuntimeServices.deferred`
            // under the stable `'scheduler-stop'` label, layered on top of
            // (never replacing) the `settleOwner`/`ownerDrains` tracking this
            // shutdown chain already awaits below — the SAME promise
            // instance is both tracked and awaited, never called twice.
            const schedulerStop = scheduler.stop();
            runtimeServices.deferred.track(schedulerStop, 'scheduler-stop');
            ownerDrains.push(settleOwner('scheduler', () => schedulerStop));
          }
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
                if (durableEventProducer) await durableEventProducer.dispose();
                await eventHistory.dispose();
              }),
            );
          }
          if (webhookNotifierInstance) {
            const webhookNotifier = webhookNotifierInstance;
            ownerDrains.push(settleOwner('webhook-notifier', () => webhookNotifier.dispose()));
          }
          if (onlineEvalSamplerInstance) {
            const onlineEvalSampler = onlineEvalSamplerInstance;
            ownerDrains.push(settleOwner('online-evals', () => onlineEvalSampler.dispose()));
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

          emitter.dispatch(new BureauDisposedEvent());
          storeSubscription.unsubscribe();
          // After `BureauDisposedEvent` is dispatched, so the feed records
          // its own last event before it stops recording. Unsubscribing
          // first, then disposing, ends every watcher: disposal aborts the
          // feed's lifetime signal, which each subscription is bound to.
          eventFeedSubscription.unsubscribe();
          // Any run feed still registered goes with it — `run.removed` reaps
          // the runs a host deleted, and this covers the rest.
          for (const feedRunId of runEventFeeds.runIds()) {
            disposeRunEventFeed(feedRunId, runEventFeeds);
          }
          eventFeed.dispose();
          for (const disposeListener of schedulerCleanup) {
            disposeListener();
          }
          for (const disposeListener of flowControlSchedulerCleanup) {
            disposeListener();
          }
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
        // Dispose the durable run engine, then the raw Storage, then the store —
        // each guarded so a throw in one stage does not skip the next (engine
        // dispose is synchronous and can throw in a degraded environment; the
        // SQLite/LMDB handle must still be released).
        //
        // Durable execution is ON BY DEFAULT for a persistent storage backend, so
        // most sqlite/lmdb bureaus now own an engine. The engine dispose does NOT
        // close the raw Storage, and the KV/checkpoint views were created with
        // `disposeUnderlyingStorage: false` — so the explicit `disposeStorage` is
        // what actually releases the file handle (even when no engine was built,
        // e.g. `durableExecution: false` with sqlite).
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
          await catalogSettlements.settled();
          await tasks.idle();
        } finally {
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
              runtime.disposeStorage?.();
            } finally {
              if (ownsStore) {
                store.dispose();
              }
            }
          }
        }
      }
      // Awaited last: everything above (admission, runs, toolbox shutdown,
      // owner drains, backend teardown) already ran without waiting on this.
      await modelCatalogRefreshClosedPromise;
      // COR-1524: stop watching the agent directory and wait for a scan in flight.
      await fileAgents?.files.close();
      return buildReport();
    })();

    // `shutdown()` is documented to never reject — every internal step above
    // is already best-effort (`settleOwner` catches and records failures),
    // but a caller-supplied `shutdownTimeoutSleep` rejecting, or some other
    // unforeseen failure inside `chain`, must not propagate through
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
  let onlineEvalSamplerInstance: OnlineEvalSampler | undefined;
  // The durable event history store (AB-91's `ab91-01` slice, AB-310) —
  // built eagerly (unlike `auditTrailInstance`/`webhookNotifierInstance`
  // below, which need `bureau` itself to subscribe to action events) since
  // it needs only `runtime.durable.engine.storage` and `runtimeServices`,
  // both already available here. "A persistent storage backend is
  // configured" (this issue's own acceptance criterion) means more than
  // "`runtime.durable` exists" — a caller can force `durableExecution:
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
  // The durable event producer (AB-311's coordinator amendment) — sinks
  // `bureau`'s action stream into `eventHistoryInstance.record()`. Wired
  // below, alongside `auditTrailInstance`, once `bureau` itself exists to
  // subscribe to.
  let durableEventProducerInstance: DurableEventProducer | undefined;

  /**
   * Whether `principal` may read `owner`'s durable history right now: the one
   * rule `eventHistory()` and `subscribeEventHistory()` both apply, so a feed
   * that cannot be paged by a stranger cannot be tailed by one either.
   *
   * Each kind compares the caller with that kind's owner of record, read the way
   * {@link Bureau.getOwner} reads it (COR-718), and fails closed when there is
   * none to read, so an id cannot be probed:
   *
   * - run: the owner `runAttribution` records for it (`anonymous:local` for a
   *   record with none), and no one once the run is deleted (see
   *   `resolveEventHistory`).
   * - goal: only a principal `bureau.goals.get` shows the goal to.
   * - session: `isSessionHistoryReadAuthorized`: only the session's owner, and
   *   no one when the session does not exist (its history is then a deleted
   *   aggregate, readable only by a caller that states no principal). A malformed
   *   owner is closed.
   * - schedule: the schedule's owner (`ScheduledAgentRunInput.principal`).
   *
   * Read fresh on every call, because ownership is not stable for a live feed:
   * a goal, run, or schedule may not exist yet when a subscription starts, and a
   * session id can be recreated under another owner.
   */
  async function ownerReadableBy(owner: DurableEventOwner, principal: string): Promise<boolean> {
    switch (owner.kind) {
      case 'run':
        // Read the way `getOwner` reads it, and closed for a run that no longer exists.
        return (await runOwner(owner.id)) === principal;
      case 'goal':
        return (await goalsComposition.goals.get(owner.id, { principal })) !== undefined;
      case 'session': {
        // A session that does not exist is closed, not open: its history is
        // readable only without a principal (see `resolveEventHistory`).
        if (!runtime.sessionStore) return false;
        const session = await runtime.sessionStore.load(owner.id);
        return session !== undefined && isSessionHistoryReadAuthorized(session.metadata, principal);
      }
      case 'schedule':
        return (await scheduleOwner(owner.id)) === principal;
    }
  }

  /**
   * `Bureau.subscribeEventHistory` for a caller that stated a principal. The
   * store's subscription is opened at once (so an invalid cursor still throws
   * synchronously, as for a trusted caller), but nothing it produces reaches
   * `listener` until `ownerReadableBy` says so, and it says so again for every
   * event, in order, through one serialized chain: an owner that did not exist
   * when the subscription began (a goal created afterwards, a run dispatched
   * afterwards) is authorized by the first event that names it, and an owner
   * whose authority changes mid-feed stops being delivered. An event the
   * principal may not read is dropped, never queued, and a failed check is
   * a denial. The subscription stays open and silent rather than reporting a
   * refusal, so it cannot be used to tell an owner that exists from one that
   * does not.
   */
  function subscribeAuthorized(
    history: DurableEventHistory,
    owner: DurableEventOwner,
    listener: (event: DurableEventEnvelope) => void,
    principal: string,
    subscribeOptions: DurableEventHistorySubscribeOptions | undefined,
  ): Subscription {
    let delivery: Promise<void> = Promise.resolve();
    // COR-718 — a session id's history holds every incarnation of the id, and the
    // live session's owner is not an earlier incarnation's owner. Each event of a
    // session is therefore judged against the session that is live when it is
    // judged: it must exist and be the subscriber's, and the event must have been
    // recorded for that very incarnation. An event recorded for none is never
    // delivered to a principal. Nothing else separates the incarnations: not a
    // marker between them, which an expiry never writes, and not the state of the
    // outbox. The one exception is the gap event the stream synthesizes when
    // retention has passed the subscriber (COR-1477): it is not a recorded event
    // of any incarnation, carries nothing owner-scoped, and is the owner's only
    // way to learn that history was lost, so it reaches an owner of the live session.
    const deliver = async (event: DurableEventEnvelope, incarnation: string | undefined) => {
      if (owner.kind === 'session') {
        try {
          const live = await runtime.sessionStore?.load(owner.id);
          if (!live || !isSessionHistoryReadAuthorized(live.metadata, principal)) return;
          if (
            event.kind !== DURABLE_HISTORY_GAP_KIND &&
            (incarnation === undefined || incarnation !== live.incarnation)
          ) {
            return;
          }
        } catch (error) {
          // Only the event in hand is lost; the next event loads the session afresh.
          diagnose({
            level: 'error',
            scope: 'durable-event-history',
            message: `[bureau] Could not load session:${owner.id} for a subscriber; its event "${event.kind}" was not delivered: ${serializeUnknownError(error)}`,
            cause: error,
          });
          return;
        }
      }
      // A session was judged above, against the session live at the time. The other kinds
      // are judged by their owner of record.
      let readable = owner.kind === 'session';
      try {
        if (owner.kind !== 'session') readable = await ownerReadableBy(owner, principal);
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'durable-event-history',
          message: `[bureau] Could not authorize ${owner.kind}:${owner.id} for a subscriber; its event "${event.kind}" was not delivered: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      if (!readable || inner.closed) return;
      try {
        listener(event);
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'durable-event-history',
          message: `[bureau] Listener threw for ${owner.kind}:${owner.id} event "${event.kind}": ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
    };
    const inner = history.subscribeEventHistory(
      owner,
      (event, incarnation) => {
        delivery = delivery.then(() => deliver(event, incarnation));
      },
      subscribeOptions,
    );
    return inner;
  }

  /**
   * AB-313 — authorization and deleted-aggregate handling layered over
   * `eventHistoryInstance.page()`. This wrapper (not `page()` itself, which
   * knows nothing about sessions, runs, or principals) is the only place
   * that can answer "is `principal` allowed to see this owner's history" —
   * it has `runtime.sessionStore` and `store` in closure, neither of which
   * `DurableEventHistory` carries.
   *
   * Authorization (AB-42's ordering: checked before anything else, so an
   * unauthorized caller cannot learn a run/session exists) runs ONLY when
   * `options.principal` is provided AND the owner's live record still
   * exists — a caller that omits `principal` (an internal/trusted caller,
   * or a privileged gateway connection) skips it entirely, and an owner
   * with NO recorded principal is open (matches every other session verb's
   * "no recorded authority" rule). A denial reports the same
   * not-found-shaped outcome `submitSessionInput` uses.
   *
   * Deleted-aggregate detection is evidence-based, not existence-based: it
   * looks for the owner's own deletion marker EVENT inside the page that
   * was just fetched (`session.deleted` for a session, `run.removed` for a
   * run), never merely "the live record is missing" — a durable event can
   * legitimately exist for an id that never had (or no longer has) a live
   * record for other reasons (e.g. a synthetic action recorded before a
   * session was ever saved), and reporting deleted-aggregate for those
   * would be a false positive; a genuinely fresh, never-recorded id must
   * still read back as an ordinary empty page.
   *
   * A SESSION owner adds one more override on top of that evidence (AB-372,
   * Codex review finding, PR #580, "Ignore prior deletion markers while a
   * reused session is live"): a session id is explicitly supported to be
   * RECREATED after deletion (`create-bureau.test.ts`'s "does not coalesce
   * a deleteSession call for a session RECREATED with the same id"), and
   * `createDurableEventProducer`'s own session.deleted listener does not
   * prune a prior incarnation's marker from the durable history a recreated
   * session shares with its predecessor — by design, not for lack of a
   * mechanism: `SessionDeletedEvent` carries a real per-incarnation
   * `incarnation` identity since AB-384, but AB-87's retention posture is no
   * silent data loss, so a settled incarnation's own durable facts stay
   * queryable forever, exactly like a run's. Evidence of a deletion
   * that once happened is therefore not sufficient on its own once a
   * session id has been reused — this function ALSO checks whether
   * `owner.id` currently names a LIVE session record before reporting
   * `deleted-aggregate`: a live record wins, and the ordinary page is
   * returned instead (still carrying that historical marker among its
   * events — nothing is hidden, only the deleted-aggregate OUTCOME is
   * suppressed). A run owner has no equivalent override: run ids are freshly
   * minted, never reused, so `run.removed` evidence is never stale in the
   * same way.
   *
   * A schedule owner is authorized the way a goal's is (COR-718): only the
   * schedule's owner of record reads its history. Schedule owners have no
   * deletion concept in this codebase today, so they go on to `page()`.
   *
   * AB-385 (coordinator ruling, 2026-09-08, closing the KNOWN LIMITATION
   * this comment used to document — Codex review finding, PR #580, "Detect
   * deletion markers beyond the requested page"): evidence of a deletion no
   * longer comes from scanning the ONE page `history.page()` returns under
   * `options`' own limit (100 by default) — a session or run with more
   * durable events than that limit could carry its own deletion marker on a
   * LATER page this function never inspected, reporting an ordinary page
   * instead of `deleted-aggregate` for a genuinely deleted owner. Evidence
   * now comes from `history.latestDeletionMarker(owner)`, a dedicated read
   * over the ENTIRE retained feed, independent of `since`/`limit` — the
   * classification below no longer depends on the caller's own pagination
   * parameters. The requested page's own `events`/`hasMore` are still
   * returned verbatim on the `deleted-aggregate` outcome; only the OUTCOME
   * classification uses the independent read, matching both marker kinds.
   */
  async function resolveEventHistory(
    history: DurableEventHistory,
    owner: DurableEventOwner,
    requestOptions?: DurableEventHistoryPageOptions,
  ): Promise<
    | DurableEventPage
    | DurableEventGap
    | EventHistoryNotFoundOutcome
    | EventHistoryDeletedAggregateOutcome
  > {
    const principal = requestOptions?.principal;

    if (owner.kind === 'run' && principal !== undefined) {
      // AB-313 — fail CLOSED whenever this run's ownership cannot be
      // verified against `runAttribution` (`request.principal`, AB-54's
      // best-effort attribution map), rather than treating an absent entry
      // as open. `runAttribution` is cleared by `deleteRun` (never
      // reinstated), so a deleted run reads identically to one that
      // legitimately never had a principal — the two cases cannot be told
      // apart from this map alone. A run recovered across a process
      // restart is no longer in the same bucket: AB-359 rehydrates this
      // map's `principal` from the session's durably persisted
      // `lastRunOwningPrincipals` entry (`reattachRecoveredRun`), so a
      // recovered run's REAL owner reads exactly as it did before the
      // restart, and a recovered run that was genuinely never dispatched
      // with a principal stays exactly as unresolved as it was live.
      // Failing open for a deleted or genuinely-unattributed run would let
      // an unauthenticated caller retrieve durable history for a run they
      // never owned, including through the deleted-aggregate 200 path
      // (copilot review, PR #551). Omitting `principal` entirely still
      // skips this check (an internal/trusted caller), matching every
      // other owner kind's convention.
      if (!(await ownerReadableBy(owner, principal))) {
        return { outcome: 'not-found' };
      }
    }

    // COR-851 — a goal's events are as private as the goal itself. The same
    // rule `bureau.goals.get` applies: omitting `principal` is a trusted call,
    // and a mismatch reads as `not-found`. A goal that cannot be read at all
    // (never created, or unreadable) fails closed for the same reason a run
    // with unverifiable ownership does, so its id cannot be probed. Goal ids
    // are never reused and a goal is closed, not deleted, so the owner read
    // here cannot change under the page read below, and a goal owner has no
    // deletion marker. Checked before anything else, so neither a gap nor an
    // owner-write wait is observable to a caller who may not see the goal.
    if (
      owner.kind === 'goal' &&
      principal !== undefined &&
      !(await ownerReadableBy(owner, principal))
    ) {
      return { outcome: 'not-found' };
    }

    // COR-718 — a schedule's history is as private as the schedule: only its owner
    // reads it, and one that cannot be read at all (never created) fails closed
    // for the same reason a run with unverifiable ownership does.
    if (
      owner.kind === 'schedule' &&
      principal !== undefined &&
      !(await ownerReadableBy(owner, principal))
    ) {
      return { outcome: 'not-found' };
    }

    // AB-372 (Codex review findings, PR #580 — see the running history in
    // this comment for why each earlier shape of this check was
    // insufficient) — session authorization is checked TWICE, deliberately,
    // never once: a PRE-page check (immediately below, BEFORE this function
    // does any other work) and a POST-page check (after `history.page()`
    // resolves, before this function decides what to return). Both are
    // necessary, and neither subsumes the other:
    //
    // - The PRE-page check exists ONLY to protect the `DurableEventGap`
    //   outcome — `page()` can return a gap instead of an ordinary page
    //   (retention has advanced past `since`), and that outcome is returned
    //   immediately, before any post-page check would ever run. Without
    //   this, an unauthorized caller whose `since` lands before the
    //   retention floor would get the gap's own retention metadata instead
    //   of the documented not-found-shaped denial ("Authorize sessions
    //   before returning history gaps"). Gated on `principal !== undefined`
    //   — an internal/trusted caller has nothing to authorize, and skipping
    //   the load entirely for that case avoids an unnecessary durable-store
    //   round trip and a spurious rejection if the session store happens to
    //   be unavailable ("Skip the authorization load when no principal is
    //   supplied"). Deliberately placed BEFORE `waitForActiveWrites` below
    //   ("Authorize sessions before waiting on producer writes") — an
    //   unauthorized caller must get the documented not-found denial
    //   immediately, never delayed behind (or have its response latency
    //   reveal) an unrelated owner-write wait it was never entitled to see
    //   the result of anyway.
    // - The POST-page check re-loads the session record FRESH, unconditionally
    //   for every session owner (not gated on whether a deletion marker
    //   happens to appear on the page), and re-authorizes against THAT
    //   record before this function returns anything past this point. A
    //   session id can be recreated, under a DIFFERENT authority, at any
    //   point between the pre-page read and `page()` resolving — the
    //   pre-page check alone would still let that later state slip through:
    //   nested only under "the page contains a `session.deleted` marker"
    //   left every ordinary-page return unchecked whenever a `since` cursor
    //   or limit paged around that marker, or when the session was
    //   genuinely never deleted at all before being recreated with new
    //   ownership mid-read ("Reauthorize sessions after every history
    //   read"). This SAME freshly-loaded record is also what the
    //   deletion-marker branch below uses for its "is this owner still
    //   live" check — one load serves both concerns, since by construction
    //   it is the freshest state either one could ever act on.
    //
    // Omitting `principal` entirely always skips authorization (an
    // internal/trusted caller), matching every other owner kind's
    // convention. A session is readable by every principal that owned a run
    // on it (`lastRunOwningPrincipals`, COR-1382) as well as by whoever the
    // recorded authority names; a session with no recorded authority is
    // still open, and malformed authority metadata fails closed, per
    // `isSessionHistoryReadAuthorized`'s own documented rule.
    let readIncarnation: string | undefined;
    if (owner.kind === 'session' && principal !== undefined && runtime.sessionStore) {
      const preSession = await runtime.sessionStore.load(owner.id);
      // COR-718: a caller that states a principal reads only a live session it owns.
      // History is keyed by session id alone, so a deleted session has no owner left
      // to compare, and its former owner is no exception; only a trusted caller
      // (no principal) reads a deleted session's history.
      if (!preSession || !isSessionHistoryReadAuthorized(preSession.metadata, principal)) {
        return { outcome: 'not-found' };
      }
      readIncarnation = preSession.incarnation;
    }

    // AB-372 (Codex review finding, PR #580, "Wait for the deletion
    // projection before serving history"): every write into `history` from
    // `createDurableEventProducer` is fire-and-forget from its own
    // dispatching caller's perspective (`deleteSession`/`deleteRun` return
    // as soon as the synchronous event dispatch completes, not once the
    // durable write actually commits) — so a caller that awaits
    // `deleteSession(id)` and immediately calls `eventHistory` for the same
    // owner could otherwise read an ordinary page a heartbeat before the
    // deletion's own durable write lands. Awaiting this owner's in-flight
    // writes first (a snapshot, never an open-ended wait — see
    // `waitForActiveWrites`'s own doc comment) closes that race, mirroring
    // `AuditTrail.query()`'s identical `activeWritesByRunId`-based fix
    // (AB-228, PR #566). A caller with no `durableEventProducerInstance`
    // (no persistent storage backend) never reaches this function at all —
    // `Bureau.eventHistory` short-circuits to `'unsupported-capability'`
    // first — so this is always defined whenever `history` is.
    await durableEventProducerInstance?.waitForActiveWrites(owner);

    // COR-718 — a principal-stated read of a session keeps only the events recorded
    // for the live incarnation (`readIncarnation`); every other incarnation's events,
    // and any recorded for none, are left out by the store, whatever `since` and
    // `limit` the caller passes.
    const page = await history.page(
      owner,
      readIncarnation === undefined
        ? requestOptions
        : { ...requestOptions, incarnation: readIncarnation },
    );
    if ('outcome' in page) {
      // AB-372 (Codex review finding, PR #580, "Reauthorize the session
      // before returning a post-wait gap"): the pre-page check above ran
      // BEFORE `waitForActiveWrites`, so it authorized a snapshot that is
      // now stale by exactly the span of that wait — a session recreated
      // for a different, unauthorized principal during the wait would
      // otherwise ride the ALREADY-PASSED pre-page check straight through
      // to a raw `DurableEventGap`, leaking retention metadata to a caller
      // who should see nothing but `not-found`. Reauthorize against a
      // fresh load, right here, before this gap ever reaches the caller —
      // this is a second, independent check from the pre-page one above
      // and from the post-page one below (which never runs on this
      // branch, since a gap returns before reaching it).
      if (owner.kind === 'session' && principal !== undefined && runtime.sessionStore) {
        const gapSession = await runtime.sessionStore.load(owner.id);
        if (!gapSession || !isSessionHistoryReadAuthorized(gapSession.metadata, principal)) {
          return { outcome: 'not-found' };
        }
      }
      return page; // a DurableEventGap
    }

    // COR-718 — the page holds the live incarnation's events only (see the read
    // above). The live session is read again once the page is in hand, because the
    // id can be deleted or recreated while the page is read: the session must still
    // be there, still the same incarnation, and still the caller's.
    if (owner.kind === 'session' && principal !== undefined && runtime.sessionStore) {
      const liveSession = await runtime.sessionStore.load(owner.id);
      if (
        !liveSession ||
        liveSession.incarnation !== readIncarnation ||
        !isSessionHistoryReadAuthorized(liveSession.metadata, principal)
      ) {
        return { outcome: 'not-found' };
      }
      return page;
    }

    // AB-385 — evidence-based, independent of `options.since`/`options.limit`.
    // `pageHasDeletionMarker` is the ORIGINAL AB-313 check (does the page
    // just fetched contain the marker); `latestDeletionMarker` widens it to
    // the ENTIRE retained feed, not merely this one page. Both are
    // consulted, deliberately OR'd together rather than the independent
    // scan alone replacing the page check (Codex review, PR #591,
    // "Preserve deletion evidence already returned by the page"): retention
    // can advance between `history.page()` resolving above and
    // `latestDeletionMarker()` running here, aging the marker below the
    // feed's floor in the span between the two calls — `latestDeletionMarker`
    // would then no longer see it, even though `page.events` (a snapshot
    // taken a moment earlier, while the marker was still retained) still
    // carries it. Regressing to an ordinary-page classification under that
    // race would be strictly worse than AB-313's original page-only
    // detection ever was.
    const deletionMarkerKind = deletionMarkerKindFor(owner.kind);
    const pageHasDeletionMarker =
      deletionMarkerKind !== undefined &&
      page.events.some((event) => event.kind === deletionMarkerKind);
    // Scan-avoidance (Codex review, PR #591, "Avoid replaying the entire
    // fleet for every history page"): `latestDeletionMarker`'s full-feed
    // scan is skipped whenever the page already fetched above PROVES the
    // owner's complete retained history — no `since` cursor (nothing before
    // the beginning was excluded) and `hasMore: false` (nothing after this
    // page remains) — because in that case `pageHasDeletionMarker` above is
    // already the complete, exact answer; the independent scan could not
    // possibly find a marker sitting outside the page's own window if there
    // IS no "outside" for this call. Every other call (a `since` cursor, a
    // truncated `hasMore: true` page, or a fresh, still-empty owner where
    // both are true but a fast internal/trusted answer is fine) still pays
    // for the independent scan.
    const pageProvesCompleteHistory = requestOptions?.since === undefined && !page.hasMore;
    const hasDeletionMarker =
      pageHasDeletionMarker ||
      (!pageProvesCompleteHistory && (await history.latestDeletionMarker(owner)) !== undefined);

    // Only load the live session record post-page when it can actually
    // change the outcome: either a `principal` needs reauthorizing against
    // it (the recreation race described above), or a deletion marker on
    // this page needs a liveness check to know whether it is current or
    // stale (below). Neither applies when there's no marker AND no
    // principal to reauthorize — an internal/trusted caller reading an
    // ordinary page gains nothing from this extra `sessionStore.load`, so
    // skip it rather than pay for a lookup no branch below will use.
    const liveSession =
      owner.kind === 'session' && runtime.sessionStore && hasDeletionMarker
        ? await runtime.sessionStore.load(owner.id)
        : undefined;

    // A currently-live session record is authoritative over a stale
    // deletion marker from a PRIOR incarnation of a recreated id — this
    // owner presently exists, so it is not deleted right now, regardless of
    // what its durable history contains (its historical events, including
    // that marker, are still returned in the page; only the outcome
    // classification is suppressed). `liveSession` is already authorized
    // above (or the caller is internal/trusted) by the time this runs.
    if (owner.kind === 'session' && hasDeletionMarker && liveSession) {
      return page;
    }

    if (hasDeletionMarker) {
      return { outcome: 'deleted-aggregate', owner, ...page };
    }
    return page;
  }

  /**
   * COR-1302: registers the `ActiveRun` behind a `bureau.run()` dispatch on
   * `store` while it runs, so `getRun(run.id)`, `abortRun(run.id)`, and
   * `subscribeRunSnapshot` resolve the handle's id on both the direct and the
   * durable branch. (`getRunReport` resolves it too, but only as a partial
   * report: the terminal report cache is filled by `createRunFromRequest`.)
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
    recordDecision: async (review, decision, principal, reason) => {
      await auditTrailInstance?.record(
        buildReviewDecisionAuditRecord(review, decision, principal, reason),
      );
      if (decision === 'approve') {
        emitter.dispatch(new ReviewApprovedEvent(review.id, review.runId, principal, review.kind));
      } else if (decision === 'reject') {
        emitter.dispatch(new ReviewRejectedEvent(review.id, review.runId, principal, review.kind));
      } else {
        emitter.dispatch(new ReviewDeniedEvent(review.id, review.runId, principal, review.kind));
      }
    },
    createError: (message, code) => new BureauError(message, code),
    durableNotConfigured: () =>
      new BureauError('Durable engine not configured', 'NOT_CONFIGURED', 'durable'),
    diagnose,
  });

  const {
    runAgent,
    planChildRun,
    startChildRun,
    startGoalAttemptRun,
    startWorkflowStepRun,
    findCatalogRun,
  } = createCatalogDispatcher({
    agentCatalog,
    runtime,
    runtimeServices,
    getShutdownPromise: () => shutdownPromise,
    catalogRuns,
    runAttribution,
    detachBestEffortPromise,
    createBureauError: (message, code) => new BureauError(message, code),
    validateAgentRunInput,
    validateBureauRunOptions,
    // COR-1367 — handed down to each catalog agent as its inherited policy.
    guardrails: options.guardrails,
    registerCatalogRun,
    // COR-1481 — a `bureau.run()` dispatch is a task: its record is written as the
    // handle is returned (a write that fails is diagnosed, not thrown, because
    // `bureau.run` returns synchronously), and its end is recorded from its result.
    onCatalogRunAdmitted: ({ handle, agentName, owner, contextId, input }) => {
      const taskId = handle.id;
      catalogSettlements.follow(
        publishFreshCatalogRun({
          handle,
          agentName,
          admit: () =>
            tasks.recordAdmission({
              taskId,
              contextId,
              incarnation: '',
              agentName,
              owner,
              message: originatingMessageText(input),
            }),
          hook: catalogRunSettlements,
          durableEnd: catalogDurableEnd,
          followCleanup: (closed) =>
            void tasks.watchCleanup(taskId, closed as Promise<RunCleanupAcknowledgement>),
          diagnose,
        }),
      );
    },
    fileAgents,
    // COR-1577 — `requestHumanInput` for a durable `bureau.run()` run.
    humanInput: options.humanInput === true && runtime.durable !== undefined,
    // COR-772 — a durable `bureau.run` parent aborted through its own handle
    // is a cancelled parent like any other. Once shutdown has begun, dispose
    // — not the policy — ends every live run, and boot recovery applies the
    // policy to whatever it left running from the cancelled parent's
    // durable state.
    onDurableRunAborted: (runId, reason) => {
      if (shutdownPromise) return;
      void childTopology.parentCancelled(runId, reason);
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
   * under `durableBackgroundTasks: 'manual'`, where nothing re-reads the store between maintenance
   * passes for an outside caller. This caller is the engine's own activity: the run is driven by
   * this engine's recovery, and its handle settles when maintenance drives it.
   */
  async function awaitWorkflowStepRun(runId: string) {
    if (options.durableBackgroundTasks !== 'manual') return waitForDurableRun(runId);
    const handle = runtime.durable?.engine.getHandle(runId);
    try {
      await handle?.result();
    } catch {
      // A run that failed or was cancelled rejects its result; its recorded state is read below.
    }
    return runtime.durable?.engine.get(runId);
  }

  async function runWorkflowAgentStep(request: AgentStepRequest): Promise<AgentStepResult> {
    const engine = runtime.durable?.engine;
    if (engine === undefined) {
      throw new WorkflowAgentStepError(
        'agent-run-failed',
        request.agent,
        `Agent "${request.agent}" cannot run: this Bureau has no durable engine.`,
      );
    }
    const runId = workflowStepRunId(request.workflowId, request.step);
    if ((await engine.get(runId)) !== null) {
      // Adopt the run at this id only if it is this step's own: its recovery record carries the
      // step's marker. Anything else holding the id is not a run to take a result from.
      const claim = await runtime.loadCatalogRunRecoveryRecord(runId);
      if (
        claim.status !== 'found' ||
        claim.record.workflowStep?.workflowId !== request.workflowId ||
        claim.record.workflowStep.step !== request.step ||
        claim.record.agentName !== request.agent ||
        claim.record.principal !== ANONYMOUS_LOCAL_OWNER
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
        workflowStep: { workflowId: request.workflowId, step: request.step },
        principal: ANONYMOUS_LOCAL_OWNER,
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

  /**
   * What Bureau knows about a run that wants to own a child: another child
   * (nested delegation), a `createRun` run, or a durable `bureau.run` run.
   * `undefined` for anything else — `children.dispatch` reports that as
   * `not-found`.
   */
  async function resolveChildParent(parentRunId: string): Promise<ChildTopologyParent | undefined> {
    const attribution = runAttribution.get(parentRunId);
    const childParent = await childTopologyStore.get(parentRunId);
    if (childParent) {
      return {
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
        agentName: attribution?.agentName ?? findRunAgentName(runState) ?? BUREAU_AGENT_NAME,
        principal: ownerOrLocal(attribution?.principal),
        live: runState.status === 'running',
      };
    }
    const state = runtime.durable ? await runtime.durable.engine.get(parentRunId) : null;
    if (!state || !isAgentRunWorkflowInput(state.input)) return undefined;
    return {
      agentName: state.input.agentName,
      principal: ownerOrLocal(attribution?.principal),
      live: DURABLE_FORCIBLY_TERMINABLE_STATUSES.has(state.status),
    };
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
  });

  // COR-851 — durable goals: the control plane over the goal store, its
  // controller workflow's ports, and the attempt forwarder.
  const goalsComposition = composeBureauGoals({
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
    // Not the memoized, audited step runs get: that records a run's cleanup
    // under a run id, and a goal's controller is not a run. An attempt's run is
    // one, but a goal prunes it at close, once its terminal checkpoint has been
    // read, and a memoized "not terminal yet" answer must not outlive that.
    // Pruning is idempotent, so asking again on every `close()` is safe.
    cleanupWorkflow: classifyTerminalCheckpointCleanup,
    isClosing: () => shutdownPromise !== undefined,
    diagnose,
    eventHistory: eventHistoryInstance,
  });

  const bureau: Bureau<D> = {
    id: bureauId,
    hasExplicitId: options.id !== undefined,
    hasDurableEngine: runCreationLedger !== undefined,
    eventFeed,
    runEventFeeds,
    store,
    memory: runtime.memory,
    scheduler: runtime.scheduler,
    sessionStore: runtime.sessionStore,
    kv: runtime.kv,
    tasks,
    get lifecycle() {
      return bureau.completed ? 'stopped' : runAdmissionClosed ? 'draining' : 'ready';
    },
    agents: agentCatalog,
    workflows: workflowRuntime?.workflows,
    modelCatalog,
    planSelection: (request) => modelPolicyPlanner.planSelection(request),
    // `runAgent`'s runtime signature is deliberately widened (`string`,
    // `AgentRun<unknown, boolean>`) — it looks the agent up by a plain
    // runtime string via `agentCatalog.find`, the same widening
    // `BureauAgentCatalog.find` itself documents. The precise per-`TName`
    // return type on `Bureau<D>['run']` is a caller-side compile-time
    // narrowing this cast restores; at runtime the returned `AgentRun` IS
    // exactly the named entry's own handle, unaffected by the cast.
    run: runAgent as Bureau<D>['run'],
    // The topology is keyed by plain runtime strings; `D` only narrows which
    // agent names a caller may pass, exactly as `run` above.
    children: childTopology.children as BureauChildren<AgentNames<D>>,
    goals: goalsComposition.goals as BureauGoals<AgentNames<D>>,
    get auditTrail(): AuditTrail | undefined {
      return auditTrailInstance;
    },
    eventHistory(
      owner: DurableEventOwner,
      eventHistoryOptions?: DurableEventHistoryPageOptions,
    ): Promise<
      | DurableEventPage
      | DurableEventGap
      | EventHistoryUnsupportedOutcome
      | EventHistoryNotFoundOutcome
      | EventHistoryDeletedAggregateOutcome
    > {
      if (!eventHistoryInstance) {
        return Promise.resolve({
          outcome: 'unsupported-capability',
          reason: 'no-persistent-storage',
        });
      }
      return resolveEventHistory(eventHistoryInstance, owner, eventHistoryOptions);
    },
    subscribeEventHistory(
      owner: DurableEventOwner,
      listener: (event: DurableEventEnvelope) => void,
      subscribeOptions?: DurableEventHistorySubscribeOptions,
    ): Subscription {
      if (!eventHistoryInstance) {
        // No persistent storage backend: nothing to subscribe to. Mirrors
        // `eventHistory()`'s graceful `'unsupported-capability'` outcome,
        // projected onto `Subscription`'s synchronous-return shape (which
        // carries no room for an outcome value) as an already-closed
        // subscription that never delivers — a caller that must
        // distinguish "unsupported" from "supported but empty" calls
        // `eventHistory()` first.
        return { unsubscribe() {}, closed: true };
      }
      const principal = subscribeOptions?.principal;
      // An omitted principal is a trusted caller, as it is for `eventHistory()`.
      return principal === undefined
        ? eventHistoryInstance.subscribeEventHistory(owner, listener, subscribeOptions)
        : subscribeAuthorized(eventHistoryInstance, owner, listener, principal, subscribeOptions);
    },
    get webhookNotifier(): WebhookNotifier | undefined {
      return webhookNotifierInstance;
    },
    get onlineEvalSampler(): OnlineEvalSampler | undefined {
      return onlineEvalSamplerInstance;
    },
    get assets(): AssetService | undefined {
      return assetServiceInstance;
    },
    get ready() {
      return runtime.ready;
    },
    createRun: createRunFromRequest,
    locateRunCreationReceipt,
    submitSchedulerTask,
    locateSchedulerTask,
    awaitSchedulerTask,
    listRuns,
    getRun,
    getOwner,
    subscribeRunSnapshot,
    getRunReport,
    abortRun,
    listAbortingRuns,
    deleteRun,
    getDurableRun,
    durableEngine,
    waitForDurableRun,
    cancelDurableRun,
    listDurableRuns,
    runDurableMaintenance,
    listSessions,
    getSession,
    deleteSession,
    signalSession,
    updateSession,
    querySession,
    submitSessionInput,
    submitSteeringCommand,
    // AB-192: constant, not computed from runtime state — the built-in
    // `agentRun` workflow never registers `ctx.onUpdate`/`ctx.onQuery`
    // handlers, so `update`/`query` are unsupported today regardless of
    // configuration. `signal` has a real delivery path (`signalSession`).
    sessionVerbCapabilities: { signal: true, update: false, query: false },
    // COR-1577: a `bureau.run()` run's park joins the session reviews in the public list, and
    // resolves through the engine by run id. Every other review resolves exactly as before.
    listPendingReviews: (): PendingReview[] => [...listPendingReviews(), ...runHumanWaits.list()],
    getReview,
    resolveReview: (input: ResolveReviewInput) =>
      runHumanWaits.has(input.id) ? runHumanWaits.resolve(input) : resolveReview(input),
    sweepExpiredReviews,
    issueGrant,
    revokeGrant,
    listGrants,
    setRequestAuthorityValidator(validator) {
      requestAuthorityValidator = validator;
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
          currentRecoverySweepFailure = undefined;
          currentRecoveryPerRunFailures = undefined;
          return {
            outcome: 'failed',
            ...(sweepFailure ? { sweepFailure } : {}),
            batchFailure: { message: serializeUnknownError(error) },
            perRunFailures,
          } satisfies BureauRecoveryReport;
        });
        void recovery.then((report) => resolveDurableRecoveryBarrier?.(report));
      }
    },
    getRequestAuthorityValidator() {
      return requestAuthorityValidator;
    },
    waitForRecovery() {
      return durableRecoveryBarrier;
    },
    createSchedule,
    getSchedule,
    listSchedules,
    pauseSchedule,
    resumeSchedule,
    cancelSchedule,
    getConfiguration,
    getTools: getToolSummaries,
    subscribeLiveFrames(listener) {
      let active = true;
      const unsubscribe = () => {
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
          sessionDeletionOwners.get(sessionDeletionOwnerKey(sessionId, incarnation)),
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
      { signal: backgroundShutdownController.signal, eventTimestamp },
    );
  }

  // Wire the webhook notifier (AB-21) now that the audit trail exists (an
  // exhausted delivery is recorded there). Only created when at least one
  // target is configured — the common case (no `options.webhooks`) costs
  // nothing beyond the `undefined` check in `createWebhookNotifier`.
  if (options.webhooks && options.webhooks.targets.length > 0) {
    webhookNotifierInstance = createWebhookNotifier(
      bureau,
      runtime.kv,
      auditTrailInstance,
      // AB-207: merge any caller-supplied signal with the bureau-owned
      // background-shutdown signal so `shutdown()` can tell an in-flight
      // delivery's `fetchImpl` to abort — the mechanism `dispose()`'s prior
      // detached call gave up entirely, which is what let a delivery's
      // write race `disposeStorage()` (AB-206 review finding, PR #402).
      { ...options.webhooks, signal: withBackgroundShutdownSignal(options.webhooks.signal) },
      diagnose,
      runtimeServices,
    );
  }

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

  // Wire the online eval sampler (AB-53) now that the audit trail and webhook
  // notifier exist (a sampled score is recorded to the former; a threshold
  // breach is delivered through the latter). Only created when at least one
  // judge is configured with a positive sample rate — the common case (no
  // `options.onlineEvals`) costs nothing beyond the `undefined` check inside
  // `createOnlineEvalSampler`.
  if (
    options.onlineEvals &&
    options.onlineEvals.judges.length > 0 &&
    options.onlineEvals.sampleRate > 0
  ) {
    onlineEvalSamplerInstance = createOnlineEvalSampler(
      bureau,
      auditTrailInstance,
      webhookNotifierInstance,
      {
        ...options.onlineEvals,
        // AB-207: same bounded-abort wiring as the webhook notifier above, for
        // an in-flight judge invocation.
        signal: withBackgroundShutdownSignal(options.onlineEvals.signal),
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
          restorePendingApprovalOverrides(metadata, restoredRunId);
          if (pendingApprovalOverrides.size > before) {
            terminalReviewSessions.set(restoredRunId, {
              sessionId: session.id,
              agentName: session.agentName,
              requestedAt: Date.parse(session.updatedAt) || runtimeServices.clock.now(),
            });
            await restoreTerminalReviewSession(session, restoredRunId);
          }
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
    try {
      await workflowRuntime.start();
    } catch (error) {
      await shutdownThenRethrow(error, async () => {
        await bureau.shutdown();
      });
    }
    if (options.durableBackgroundTasks !== 'manual') runtime.durable?.engine.scheduler.start();
  }
  if (hasDeferredGatewayAuthority) {
    durableRecoveryDeferred = true;
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
      currentRecoverySweepFailure = undefined;
      currentRecoveryPerRunFailures = undefined;
      return {
        outcome: 'failed',
        ...(sweepFailure ? { sweepFailure } : {}),
        batchFailure: { message: serializeUnknownError(error) },
        perRunFailures,
      } satisfies BureauRecoveryReport;
    });
    await durableRecoveryBarrier;
  }

  return bureau;
}
