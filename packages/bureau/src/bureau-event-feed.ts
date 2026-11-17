/**
 * A bureau's events, as a replay-plus-live feed.
 *
 * The same boundary `@lostgradient/operative`'s `run-event-feed.ts` draws, for the
 * same reasons, on the same Weft primitive — so a client watching a bureau
 * gets the cursors, replay, and resume semantics it already gets watching a
 * run or a workflow.
 *
 * ONE FEED PER BUREAU, not per run. Bureau's events are instance-scoped:
 * registration, recovery, disposal, and review lifecycle describe the
 * supervisor rather than any single run, so the feed is shaped like Weft's
 * fleet feed rather than its per-workflow one. A subscriber narrows with the
 * operation's `kinds` filter.
 *
 * @module bureau-event-feed
 */

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import {
  bindFeedLifetime,
  createInMemoryReplayLiveBackend,
  createReplayLiveFeed,
  type InMemoryReplayLiveBackend,
  type ReplayLiveFeed,
  type SequencedEventEnvelope,
} from '@lostgradient/weft';

import { eventSourceOf } from './event-source.ts';
import { PluginPublishedEvent } from './plugin-published-event.ts';
import { FRAMES_DROPPED_KIND, withFramesDroppedMarker } from './frames-dropped.ts';
import {
  publishableErrorCode,
  publishableErrorKind,
  publishableFinishReason,
  publishablePluginStatus,
  publishableProblemCodes,
  publishableSecretKey,
  publishableSteeringFailureReason,
  publishableToken,
} from './published-error-names.ts';
import {
  ActionEvent,
  AssetLifecycleEvent,
  BUREAU_ASSET_EVENT_KINDS,
  type BureauAssetEventKind,
  BureauDisposedEvent,
  type BureauEventMap,
  ChildWorkflowAbortedRecordedEvent,
  ChildWorkflowCompletedRecordedEvent,
  ChildWorkflowFailedRecordedEvent,
  ChildWorkflowStartedRecordedEvent,
  DecisionMadeEvent,
  HandoffOccurredRecordedEvent,
  HookPlanFailedRecordedEvent,
  SteeringAppliedRecordedEvent,
  SteeringCommandFailedEvent,
  SteeringCommandRejectedEvent,
  SteeringCommandSupersededEvent,
  DefinitionsChangedEvent,
  DiagnosticEvent,
  GOAL_EVENT_KINDS,
  type GoalEventKind,
  GoalLifecycleEvent,
  MemoryGovernanceEvent,
  NotificationCreatedEvent,
  PluginSecretRemovedEvent,
  PluginSecretSetEvent,
  PluginSettingsChangedEvent,
  PluginStatusChangedEvent,
  ScheduleMissedEvent,
  ScorerThresholdBreachedEvent,
  SessionTaintEvent,
  TaskCleanupAcknowledgedEvent,
  type TriggerEventKind,
  TriggerLifecycleEvent,
  RunAbortSettledEvent,
  RecoveryAttemptedEvent,
  RecoveryLeaseReleasedEvent,
  RecoveryRejectedEvent,
  ReviewApprovedEvent,
  ReviewRequestedEvent,
  ReviewCanceledEvent,
  ReviewDeniedEvent,
  ReviewExpiredEvent,
  ReviewRejectedEvent,
  ReviewRevokedEvent,
  ReviewSupersededEvent,
  BudgetThresholdRecordedEvent,
  RunAbortedOutcomeEvent,
  RunCompletedOutcomeEvent,
  RunFailedOutcomeEvent,
  RunGuardrailRecordedEvent,
  RunRegisteredEvent,
  RunTripwireRecordedEvent,
  ToolErrorRecordedEvent,
  ToolPolicyDeniedRecordedEvent,
  RunSettledEvent,
  RunRemovedEvent,
} from './events.ts';
import {
  type Action,
  AgentScheduledEvent,
  ScheduleAttemptedEvent,
  ScheduleCancelledEvent,
  ScheduleCompletedEvent,
  ScheduleFailedEvent,
  SchedulePausedEvent,
  ScheduleResumedEvent,
  ScheduleSkippedEvent,
  SessionCreatedEvent,
  SessionDeletedEvent,
  SessionSavedEvent,
  SteeringAcceptedEvent,
  WorkflowVersionMismatchEvent,
} from '@lostgradient/operative';
import {
  SkillActivatedEvent,
  SkillDeactivatedEvent,
  SkillFailedEvent,
  SkillLoadedEvent,
  SkillRejectedEvent,
} from './skills/events.ts';

export type BureauEventEnvelope = SequencedEventEnvelope & {
  readonly bureauId: string;
  readonly kind: string;
  readonly emittedAtMs: number;
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * The plugin whose contribution emitted the event (COR-1876). Absent, not `undefined`, on an event
   * from Bureau core. An envelope field, never a payload one: a payload key named `source` means
   * what its kind's catalog entry says.
   */
  readonly source?: string | undefined;
};

type BureauEventProjection = {
  readonly kind: string;
  readonly tryProject: (event: unknown) => Readonly<Record<string, unknown>> | undefined;
};

function projection<TEvent>(
  kind: string,
  matches: (event: unknown) => event is TEvent,
  project: (event: TEvent) => Readonly<Record<string, unknown>>,
): BureauEventProjection {
  return { kind, tryProject: (event) => (matches(event) ? project(event) : undefined) };
}

const isInstance =
  <TEvent>(constructor: abstract new (...args: never[]) => TEvent) =>
  (event: unknown): event is TEvent =>
    event instanceof constructor;

/** A goal event of one kind; every goal kind shares {@link GoalLifecycleEvent}. */
const isGoalEvent =
  (kind: GoalEventKind) =>
  (event: unknown): event is GoalLifecycleEvent =>
    event instanceof GoalLifecycleEvent && event.type === kind;

/** The kinds every {@link TriggerLifecycleEvent} is published as. */
const TRIGGER_EVENT_KINDS: readonly TriggerEventKind[] = [
  'trigger.started',
  'trigger.stopped',
  'trigger.failed',
  'trigger.fired',
];

/** A trigger event of one kind; every trigger kind shares {@link TriggerLifecycleEvent}. */
const isTriggerEvent =
  (kind: TriggerEventKind) =>
  (event: unknown): event is TriggerLifecycleEvent =>
    event instanceof TriggerLifecycleEvent && event.type === kind;

/** An asset event of one kind; every forwarded asset kind shares {@link AssetLifecycleEvent}. */
const isAssetEvent =
  (kind: BureauAssetEventKind) =>
  (event: unknown): event is AssetLifecycleEvent =>
    event instanceof AssetLifecycleEvent && event.type === kind;

/** Copies the fields an object sets, leaving out each one that is `undefined`. */
function definedFields(
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/** The fields a recorded action's `detail` holds, or none when it is not an object. */
function detailOf(action: Action): Readonly<Record<string, unknown>> {
  return action.detail !== null && typeof action.detail === 'object'
    ? (action.detail as Readonly<Record<string, unknown>>)
    : {};
}

/** A string field of a recorded action's detail, or `undefined` when it is anything else. */
function detailString(detail: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = Object.hasOwn(detail, key) ? detail[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** A finite number field of a recorded action's detail, or `undefined` when it is anything else. */
function detailNumber(detail: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = Object.hasOwn(detail, key) ? detail[key] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * What a guardrail's recorded event publishes (COR-2096): the guardrail, what it found, where it
 * looked and how sure it was. The guardrail's `detail`, which can quote the flagged text, is never read.
 */
function projectGuardrail(action: Action): Record<string, unknown> {
  const detail = detailOf(action);
  return {
    runId: action.runId,
    step: detailNumber(detail, 'step'),
    guardrailName: detailString(detail, 'guardrailName'),
    category: detailString(detail, 'category'),
    phase: detailString(detail, 'phase'),
    confidence: detailNumber(detail, 'confidence'),
  };
}

/**
 * What the four `multiagent.child-workflow.*` kinds publish (COR-2097): the parent run that
 * recorded the event, the child and the child's agent. The parent is the run the action belongs to,
 * never the `parentRunId` the dispatching tool wrote into the event, because a hook and a workspace
 * read the run the id names, and only the id the store holds is one they can resolve. The child's
 * prompt (`input`) and the reason it ended are not read here.
 */
function projectChild(action: Action): Record<string, unknown> {
  const detail = detailOf(action);
  return {
    parentRunId: action.runId,
    childRunId: detailString(detail, 'childRunId'),
    childAgentName: detailString(detail, 'childAgentName'),
  };
}

/** What a registrant's hook id, hook point or a version publishes as when it is not one token. */
const FALLBACK_TOKEN = 'UNKNOWN';

/** The code a `run.error` publishes for a failure whose own code is not an identifier. */
const FALLBACK_RUN_ERROR_CODE = 'UNKNOWN';

/**
 * The error code a recorded `tool.error` publishes: the error's own `code` when it is an
 * identifier (upper-case letters, digits and underscores), and `INTERNAL_ERROR` otherwise, which is
 * the code Armorer gives a failure that names none. A code with any other shape could be free text.
 */
function toolErrorCode(error: unknown): string {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? (error as { readonly code: unknown }).code
      : undefined;
  return publishableErrorCode(code, 'INTERNAL_ERROR');
}

/**
 * A settled review, projected identically whichever verb settled it.
 *
 * `reviewKind` rather than `kind`, deliberately. The review classes carry
 * their own `kind` field (which sort of review it was), and the envelope
 * already uses `kind` for the event type. Two different meanings under one
 * name in nested objects is a reliable way to read the wrong one.
 */
function projectReview(event: {
  reviewId: string;
  runId: string;
  principal: string;
  kind: string;
}): Readonly<Record<string, unknown>> {
  return {
    reviewId: event.reviewId,
    runId: event.runId,
    principal: event.principal,
    reviewKind: event.kind,
  };
}

export type DeclaredKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/** Classifies every declared Bureau event as publishable or explicitly denied. */
export const BUREAU_EVENT_CLASSIFICATION = {
  action: 'published',
  'run.tripwire': 'published',
  'run.guardrail': 'published',
  'budget.threshold': 'published',
  'tool.policy-denied': 'published',
  'tool.error': 'published',
  'multiagent.child-workflow.started': 'published',
  'multiagent.child-workflow.completed': 'published',
  'multiagent.child-workflow.failed': 'published',
  'multiagent.child-workflow.aborted': 'published',
  'multiagent.handoff.occurred': 'published',
  'steering.applied': 'published',
  'hook-plan.failed': 'published',
  'run.registered': 'published',
  'run.settled': 'published',
  'run.completed': 'published',
  'run.error': 'published',
  'run.aborted': 'published',
  'run.removed': 'published',
  'run.abort-settled': 'published',
  'bureau.disposed': 'published',
  'recovery.attempted': 'published',
  'recovery.rejected': 'published',
  'recovery.lease-released': 'published',
  'schedule.created': 'published',
  'schedule.paused': 'published',
  'schedule.resumed': 'published',
  'schedule.cancelled': 'published',
  'schedule.failed': 'published',
  'schedule.completed': 'published',
  'schedule.attempted': 'published',
  'schedule.skipped': 'published',
  'skill.loaded': 'published',
  'skill.activated': 'published',
  'skill.deactivated': 'published',
  'skill.rejected': 'published',
  'skill.failed': 'published',
  'session.created': 'published',
  'session.saved': 'published',
  'session.deleted': 'published',
  'session.tainted': 'published',
  'review.requested': 'published',
  'review.approved': 'published',
  'review.denied': 'published',
  'review.rejected': 'published',
  'review.expired': 'published',
  'review.revoked': 'published',
  'review.canceled': 'published',
  'review.superseded': 'published',
  'steering.accepted': 'published',
  'steering.rejected': 'published',
  'steering.superseded': 'published',
  'steering.failed': 'published',
  'workflow.version-mismatch': 'published',
  'goal.started': 'published',
  'goal.attempt.started': 'published',
  'goal.attempt.evaluating': 'published',
  'goal.attempt.validated': 'published',
  'goal.feedback.recorded': 'published',
  'goal.retrying': 'published',
  'goal.succeeded': 'published',
  'goal.exhausted': 'published',
  'goal.canceled': 'published',
  'goal.failed': 'published',
  'goal.recovered': 'published',
  'asset.upload.started': 'published',
  'asset.upload.purged': 'published',
  'asset.blob.purged': 'published',
  'asset.expired': 'published',
  'definitions.changed': 'published',
  'trigger.started': 'published',
  'trigger.stopped': 'published',
  'trigger.failed': 'published',
  'trigger.fired': 'published',
  'schedule.missed': 'published',
  'task.cleanup-acknowledged': 'published',
  'notification.created': 'published',
  diagnostic: 'published',
  'memory.governance': 'published',
  'decision.made': 'published',
  'secret.set': 'published',
  'secret.removed': 'published',
  'plugin.settings-changed': 'published',
  'plugin.status-changed': 'published',
  'scorer.threshold-breached': 'published',
} as const satisfies Record<DeclaredKeys<BureauEventMap>, 'published' | { denied: string }>;

export type PublishedBureauEventKind = {
  [K in DeclaredKeys<BureauEventMap>]: (typeof BUREAU_EVENT_CLASSIFICATION)[K] extends 'published'
    ? K
    : never;
}[DeclaredKeys<BureauEventMap>];

const PROJECTIONS: readonly BureauEventProjection[] = [
  projection(ActionEvent.type, isInstance(ActionEvent), (event) => ({
    // `detail` is `unknown` and caller-supplied, so the log's shape crosses
    // but its contents do not.
    sequence: event.action.sequence,
    runId: event.action.runId,
    actionType: event.action.type,
    timestamp: event.action.timestamp,
  })),
  // The five events a run records (COR-2096), published from the recorded action field by field:
  // never the guardrail's detail, a policy's reason, a tool's arguments or an error's message.
  projection(RunTripwireRecordedEvent.type, isInstance(RunTripwireRecordedEvent), (event) =>
    definedFields(projectGuardrail(event.action)),
  ),
  projection(RunGuardrailRecordedEvent.type, isInstance(RunGuardrailRecordedEvent), (event) =>
    definedFields({
      ...projectGuardrail(event.action),
      action: detailString(detailOf(event.action), 'action'),
    }),
  ),
  projection(
    BudgetThresholdRecordedEvent.type,
    isInstance(BudgetThresholdRecordedEvent),
    (event) => {
      const detail = detailOf(event.action);
      return definedFields({
        runId: event.action.runId,
        step: detailNumber(detail, 'step'),
        threshold: detailNumber(detail, 'threshold'),
        currentCost: detailNumber(detail, 'currentCost'),
        budget: detailNumber(detail, 'budget'),
        model: detailString(detail, 'model'),
      });
    },
  ),
  projection(
    ToolPolicyDeniedRecordedEvent.type,
    isInstance(ToolPolicyDeniedRecordedEvent),
    (event) => {
      const detail = detailOf(event.action);
      return definedFields({
        runId: event.action.runId,
        step: detailNumber(detail, 'step'),
        toolName: detailString(detail, 'toolName'),
        toolCallId: detailString(detail, 'toolCallId'),
      });
    },
  ),
  projection(ToolErrorRecordedEvent.type, isInstance(ToolErrorRecordedEvent), (event) => {
    const detail = detailOf(event.action);
    return definedFields({
      runId: event.action.runId,
      step: detailNumber(detail, 'step'),
      toolName: detailString(detail, 'toolName'),
      toolCallId: detailString(detail, 'toolCallId'),
      errorCode: toolErrorCode(Object.hasOwn(detail, 'error') ? detail['error'] : undefined),
    });
  }),
  // What a run records of its children, its handoffs, its steering and its hook plan (COR-2097),
  // published field by field: never a child's prompt, a rejection's message, a steering command's
  // effective state, or a hook's error.
  projection(
    ChildWorkflowStartedRecordedEvent.type,
    isInstance(ChildWorkflowStartedRecordedEvent),
    (event) => definedFields(projectChild(event.action)),
  ),
  projection(
    ChildWorkflowCompletedRecordedEvent.type,
    isInstance(ChildWorkflowCompletedRecordedEvent),
    (event) => definedFields(projectChild(event.action)),
  ),
  projection(
    ChildWorkflowFailedRecordedEvent.type,
    isInstance(ChildWorkflowFailedRecordedEvent),
    (event) =>
      definedFields({
        ...projectChild(event.action),
        // `reason` is the child's finish reason, or the message of a rejection: the message never crosses.
        finishReason: publishableFinishReason(
          detailString(detailOf(event.action), 'reason'),
          'error',
        ),
      }),
  ),
  projection(
    ChildWorkflowAbortedRecordedEvent.type,
    isInstance(ChildWorkflowAbortedRecordedEvent),
    (event) => definedFields(projectChild(event.action)),
  ),
  projection(
    HandoffOccurredRecordedEvent.type,
    isInstance(HandoffOccurredRecordedEvent),
    (event) => {
      const detail = detailOf(event.action);
      return definedFields({
        runId: event.action.runId,
        sourceAgentName: detailString(detail, 'sourceAgentName'),
        targetAgentName: detailString(detail, 'targetAgentName'),
      });
    },
  ),
  projection(SteeringAppliedRecordedEvent.type, isInstance(SteeringAppliedRecordedEvent), (event) =>
    definedFields({ sessionId: detailString(detailOf(event.action), 'sessionId') }),
  ),
  projection(HookPlanFailedRecordedEvent.type, isInstance(HookPlanFailedRecordedEvent), (event) => {
    const detail = detailOf(event.action);
    return definedFields({
      runId: event.action.runId,
      hookId: publishableToken(detailString(detail, 'hookId')) ?? FALLBACK_TOKEN,
      hookName: publishableToken(detailString(detail, 'hookName')) ?? FALLBACK_TOKEN,
      source: publishableToken(detailString(detail, 'source')),
      errorCode: toolErrorCode(Object.hasOwn(detail, 'error') ? detail['error'] : undefined),
    });
  }),
  // A steering command's refusal, supersession or failure (COR-2097): the session, the command and
  // the gate's reason from a closed list; never the requested value, the successor's id or a time.
  ...[SteeringCommandRejectedEvent, SteeringCommandSupersededEvent, SteeringCommandFailedEvent].map(
    (EventClass) =>
      projection(EventClass.type, isInstance(EventClass), (event) =>
        definedFields({
          sessionId: event.sessionId,
          commandId: publishableToken(event.commandId),
          failureReason: publishableSteeringFailureReason(event.failureReason),
        }),
      ),
  ),
  // The durable engine's own event (COR-2097), named for what it is: the workflow, and the version
  // it was checkpointed under and the one it resumes under. A version that is not one token is not
  // published.
  projection(WorkflowVersionMismatchEvent.type, isInstance(WorkflowVersionMismatchEvent), (event) =>
    definedFields({
      workflowId: event.runId,
      storedVersion: publishableToken(event.storedVersion) ?? FALLBACK_TOKEN,
      registeredVersion: publishableToken(event.registeredVersion) ?? FALLBACK_TOKEN,
    }),
  ),
  projection(RunRegisteredEvent.type, isInstance(RunRegisteredEvent), (event) => ({
    runId: event.runId,
  })),
  projection(RunSettledEvent.type, isInstance(RunSettledEvent), (event) =>
    definedFields({
      runId: event.runId,
      status: event.status,
      finishReason: event.finishReason,
    }),
  ),
  projection(RunCompletedOutcomeEvent.type, isInstance(RunCompletedOutcomeEvent), (event) =>
    definedFields({ runId: event.runId, finishReason: event.finishReason }),
  ),
  // No error text (COR-2095, Revision 2026-11-16): a failure is named by its finish reason, a kind
  // from the error-kind enum and a code that is an identifier, each checked again here at the
  // boundary. The text is read through the authorized task read by `runId`, never from a pushed
  // event, and the error object, its cause and its stack are never part of the event.
  projection(RunFailedOutcomeEvent.type, isInstance(RunFailedOutcomeEvent), (event) =>
    definedFields({
      runId: event.runId,
      finishReason: event.finishReason,
      step: event.step,
      errorKind: publishableErrorKind(event.errorKind),
      errorCode:
        event.errorCode === undefined
          ? undefined
          : publishableErrorCode(event.errorCode, FALLBACK_RUN_ERROR_CODE),
    }),
  ),
  projection(RunAbortedOutcomeEvent.type, isInstance(RunAbortedOutcomeEvent), (event) =>
    definedFields({ runId: event.runId, finishReason: event.finishReason }),
  ),
  projection(RunRemovedEvent.type, isInstance(RunRemovedEvent), (event) => ({
    runId: event.runId,
  })),
  projection(BureauDisposedEvent.type, isInstance(BureauDisposedEvent), () => ({})),
  projection(RecoveryAttemptedEvent.type, isInstance(RecoveryAttemptedEvent), (event) => ({
    runId: event.runId,
    verdict: event.verdict,
  })),
  projection(RecoveryRejectedEvent.type, isInstance(RecoveryRejectedEvent), (event) => ({
    runId: event.runId,
    reason: event.reason,
  })),
  projection(RecoveryLeaseReleasedEvent.type, isInstance(RecoveryLeaseReleasedEvent), (event) => ({
    // The lease evidence itself is Weft's projection of engine health and is
    // not reshaped here; a subscriber that needs it reads the run.
    runId: event.runId,
  })),
  projection(RunAbortSettledEvent.type, isInstance(RunAbortSettledEvent), (event) => ({
    runId: event.runId,
  })),
  projection(AgentScheduledEvent.type, isInstance(AgentScheduledEvent), (event) => ({
    agentName: event.agentName,
    scheduleId: event.scheduleId,
    sessionId: event.sessionId,
  })),
  projection(SchedulePausedEvent.type, isInstance(SchedulePausedEvent), (event) => ({
    scheduleId: event.scheduleId,
    dedupeKey: event.dedupeKey,
    committedAtMs: event.committedAtMs,
  })),
  projection(ScheduleResumedEvent.type, isInstance(ScheduleResumedEvent), (event) => ({
    scheduleId: event.scheduleId,
    dedupeKey: event.dedupeKey,
    committedAtMs: event.committedAtMs,
  })),
  projection(ScheduleCancelledEvent.type, isInstance(ScheduleCancelledEvent), (event) => ({
    scheduleId: event.scheduleId,
    dedupeKey: event.dedupeKey,
    committedAtMs: event.committedAtMs,
  })),
  projection(ScheduleFailedEvent.type, isInstance(ScheduleFailedEvent), (event) => ({
    scheduleId: event.scheduleId,
    runId: event.runId,
    status: 'failed',
  })),
  projection(ScheduleCompletedEvent.type, isInstance(ScheduleCompletedEvent), (event) => ({
    scheduleId: event.scheduleId,
    runId: event.runId,
    status: 'completed',
  })),
  projection(ScheduleAttemptedEvent.type, isInstance(ScheduleAttemptedEvent), (event) => ({
    scheduleId: event.scheduleId,
    occurrence: event.occurrence,
  })),
  projection(ScheduleSkippedEvent.type, isInstance(ScheduleSkippedEvent), (event) => ({
    scheduleId: event.scheduleId,
    occurrence: event.occurrence,
    blockingRunId: event.blockingRunId,
    policy: event.policy,
  })),
  projection(SkillLoadedEvent.type, isInstance(SkillLoadedEvent), (event) => ({
    skillName: event.skillName,
    runId: event.correlation.runId,
    sessionId: event.correlation.sessionId,
    traceId: event.correlation.traceId,
    agentName: event.correlation.agentName,
    sourceId: event.correlation.sourceId,
    artifactDigest: event.correlation.artifactDigest,
    status: 'loaded',
  })),
  projection(SkillActivatedEvent.type, isInstance(SkillActivatedEvent), (event) => ({
    skillName: event.skillName,
    runId: event.correlation.runId,
    sessionId: event.correlation.sessionId,
    traceId: event.correlation.traceId,
    agentName: event.correlation.agentName,
    sourceId: event.correlation.sourceId,
    artifactDigest: event.correlation.artifactDigest,
    status: 'activated',
  })),
  projection(SkillDeactivatedEvent.type, isInstance(SkillDeactivatedEvent), (event) => ({
    skillName: event.skillName,
    runId: event.correlation.runId,
    sessionId: event.correlation.sessionId,
    traceId: event.correlation.traceId,
    agentName: event.correlation.agentName,
    sourceId: event.correlation.sourceId,
    artifactDigest: event.correlation.artifactDigest,
    status: 'deactivated',
  })),
  projection(SkillRejectedEvent.type, isInstance(SkillRejectedEvent), (event) => ({
    skillName: event.skillName,
    reason: event.reason,
    rule: event.rule,
    runId: event.correlation.runId,
    sessionId: event.correlation.sessionId,
    traceId: event.correlation.traceId,
    agentName: event.correlation.agentName,
    sourceId: event.correlation.sourceId,
    artifactDigest: event.correlation.artifactDigest,
    status: 'rejected',
  })),
  projection(SkillFailedEvent.type, isInstance(SkillFailedEvent), (event) => ({
    skillName: event.skillName,
    runId: event.correlation.runId,
    sessionId: event.correlation.sessionId,
    traceId: event.correlation.traceId,
    agentName: event.correlation.agentName,
    sourceId: event.correlation.sourceId,
    artifactDigest: event.correlation.artifactDigest,
    status: 'failed',
  })),
  projection(SessionCreatedEvent.type, isInstance(SessionCreatedEvent), (event) => ({
    sessionId: event.sessionId,
    agentName: event.agentName,
    incarnation: event.incarnation,
    ordinal: event.ordinal,
    committedAtMs: event.committedAtMs,
  })),
  projection(SessionSavedEvent.type, isInstance(SessionSavedEvent), (event) => ({
    sessionId: event.sessionId,
    agentName: event.agentName,
    incarnation: event.incarnation,
    ordinal: event.ordinal,
    committedAtMs: event.committedAtMs,
  })),
  projection(SessionDeletedEvent.type, isInstance(SessionDeletedEvent), (event) => ({
    sessionId: event.sessionId,
    incarnation: event.incarnation,
    ordinal: event.ordinal,
    committedAtMs: event.committedAtMs,
  })),
  projection(SteeringAcceptedEvent.type, isInstance(SteeringAcceptedEvent), (event) => ({
    sessionId: event.sessionId,
    commandId: event.commandId,
    configVersion: event.configVersion,
    status: 'accepted',
  })),
  projection(ReviewRequestedEvent.type, isInstance(ReviewRequestedEvent), projectReview),
  projection(ReviewApprovedEvent.type, isInstance(ReviewApprovedEvent), projectReview),
  projection(ReviewDeniedEvent.type, isInstance(ReviewDeniedEvent), projectReview),
  projection(ReviewRejectedEvent.type, isInstance(ReviewRejectedEvent), projectReview),
  projection(ReviewExpiredEvent.type, isInstance(ReviewExpiredEvent), projectReview),
  projection(ReviewRevokedEvent.type, isInstance(ReviewRevokedEvent), projectReview),
  projection(ReviewCanceledEvent.type, isInstance(ReviewCanceledEvent), projectReview),
  projection(ReviewSupersededEvent.type, isInstance(ReviewSupersededEvent), projectReview),
  // The event already holds only the recorded fields its kind publishes; `goal.failed` has no
  // validator message to drop by the time it gets here (see `GoalLifecycleEvent`).
  ...GOAL_EVENT_KINDS.map((kind) =>
    projection(kind, isGoalEvent(kind), (event) => ({ ...event.payload })),
  ),
  ...BUREAU_ASSET_EVENT_KINDS.map((kind) =>
    projection(kind, isAssetEvent(kind), (event) =>
      definedFields({
        sequence: event.sequence,
        at: event.at,
        assetId: event.assetId,
        revision: event.revision,
        state: event.state,
        principal: event.principal,
        uploadId: event.uploadId,
        digest: event.digest,
      }),
    ),
  ),
  projection(DefinitionsChangedEvent.type, isInstance(DefinitionsChangedEvent), (event) => ({
    catalog: event.catalog,
    added: [...event.added],
    changed: [...event.changed],
    removed: [...event.removed],
    rejected: [...event.rejected],
  })),
  // COR-2250: the file, the kind, its version, and for a fire its outcome, run and refusal code;
  // never the payload or the idempotency key, which the event does not hold.
  ...TRIGGER_EVENT_KINDS.map((kind) =>
    projection(kind, isTriggerEvent(kind), (event) =>
      definedFields({
        workflowId: event.workflowId,
        trigger: event.trigger,
        version: event.version,
        outcome: event.outcome,
        runId: event.runId,
        errorCode: event.errorCode,
      }),
    ),
  ),
  projection(ScheduleMissedEvent.type, isInstance(ScheduleMissedEvent), (event) => ({
    scheduleId: event.scheduleId,
    missedCount: event.missedCount,
    windowStart: event.windowStart,
    windowEnd: event.windowEnd,
    reason: event.reason,
  })),
  projection(
    TaskCleanupAcknowledgedEvent.type,
    isInstance(TaskCleanupAcknowledgedEvent),
    (event) => ({ taskId: event.taskId, cleanup: event.cleanup }),
  ),
  // The notification's identifier and kind only: not its owner, title, body or link.
  projection(NotificationCreatedEvent.type, isInstance(NotificationCreatedEvent), (event) => ({
    notificationId: event.notificationId,
    kind: event.notificationKind,
  })),
  // Level and scope only: a diagnostic's message and cause can carry error text and stacks.
  projection(DiagnosticEvent.type, isInstance(DiagnosticEvent), (event) => ({
    level: event.level,
    scope: event.scope,
  })),
  // Identifiers, the detector, where the content came from, and a confidence: never the flagged
  // text or the detector's detail (COR-2105).
  projection(SessionTaintEvent.type, isInstance(SessionTaintEvent), (event) => ({
    sessionId: event.sessionId,
    runId: event.runId,
    detector: event.detector,
    provenance: event.provenance,
    confidence: event.confidence,
  })),
  // Identifiers, statuses, and a timestamp: the notification is already redacted, and the event
  // keeps no principal, correlation, or record content.
  projection(MemoryGovernanceEvent.type, isInstance(MemoryGovernanceEvent), (event) =>
    definedFields({
      type: event.notificationType,
      outcome: event.outcome,
      tenantId: event.tenantId,
      at: event.at,
      recordIds: [...event.recordIds],
      operationId: event.operationId,
    }),
  ),
  // What a host reports of its plugins and their secrets (COR-2098), checked again here: the
  // plugin and the key a plugin declared, flags, and the status and problem codes from their lists.
  // Never a secret's value, its length, a digest or a prefix of it, a configuration value or a
  // problem's message, none of which the event holds.
  projection(PluginSecretSetEvent.type, isInstance(PluginSecretSetEvent), (event) =>
    definedFields({
      plugin: publishableToken(event.plugin),
      key: publishableSecretKey(event.key),
    }),
  ),
  projection(PluginSecretRemovedEvent.type, isInstance(PluginSecretRemovedEvent), (event) =>
    definedFields({
      plugin: publishableToken(event.plugin),
      key: publishableSecretKey(event.key),
    }),
  ),
  projection(PluginSettingsChangedEvent.type, isInstance(PluginSettingsChangedEvent), (event) =>
    definedFields({
      plugin: publishableToken(event.plugin),
      enabled: event.enabled,
      restartRequired: event.restartRequired,
    }),
  ),
  projection(PluginStatusChangedEvent.type, isInstance(PluginStatusChangedEvent), (event) =>
    definedFields({
      plugin: publishableToken(event.plugin),
      previousStatus: publishablePluginStatus(event.previousStatus),
      status: publishablePluginStatus(event.status),
      problemCodes: publishableProblemCodes(event.problemCodes) ?? [],
    }),
  ),
  // The decision's kind, how it ended, the row that answered and the path, and the task: never the
  // request, the value, the rationale, the schema, the principal, the provider and model as the
  // model reported them, the routing id or the audit record's reason (COR-2249).
  projection(DecisionMadeEvent.type, isInstance(DecisionMadeEvent), (event) =>
    definedFields({
      kind: event.kind,
      outcome: event.outcome,
      row: event.row,
      path: event.path,
      taskId: event.taskId,
    }),
  ),
  // The run, the scorer's name and version, the outcome kind and the score when there is one: never
  // the scorer's message, its threshold, its digest or anything of the run's content (COR-2251).
  projection(ScorerThresholdBreachedEvent.type, isInstance(ScorerThresholdBreachedEvent), (event) =>
    definedFields({
      runId: event.runId,
      scorerName: event.scorerName,
      scorerVersion: event.scorerVersion,
      outcome: event.outcome,
      score: event.score,
    }),
  ),
];

/** Every event kind this feed publishes, derived from the exhaustive classification. */
export const PUBLISHED_BUREAU_EVENT_KINDS = Object.entries(BUREAU_EVENT_CLASSIFICATION)
  .filter(([, classification]) => classification === 'published')
  .map(([kind]) => kind) as unknown as readonly [
  PublishedBureauEventKind,
  ...PublishedBureauEventKind[],
];

/** Every event kind this feed knows how to publish, as declared by the registry. */
export const publishedBureauEventKinds: readonly string[] = PROJECTIONS.map((entry) => entry.kind);

/** Projects one dispatched event, or `undefined` when it has no projection. */
export function projectBureauEvent(
  event: unknown,
): { kind: string; payload: Readonly<Record<string, unknown>> } | undefined {
  // COR-2224: a plugin's declared kind is dynamic, so it has no entry in the registry above.
  if (event instanceof PluginPublishedEvent) return { kind: event.type, payload: event.payload };
  for (const entry of PROJECTIONS) {
    const payload = entry.tryProject(event);
    if (payload !== undefined) return { kind: entry.kind, payload };
  }
  return undefined;
}

export type BureauEventFeed = {
  readonly feed: ReplayLiveFeed<BureauEventEnvelope>;
  /**
   * Aborts when the feed is disposed, so a live subscription ends instead of
   * going quiet — disposing a feed otherwise unhooks its subscribers without
   * waking them. Every subscription `feed` hands out is already bound to
   * this signal by Weft's `bindFeedLifetime`; a caller needs it only to ask
   * whether the feed is still live.
   */
  readonly signal: AbortSignal;
  /**
   * How many live subscriptions `feed` holds right now (COR-1731): one per `feed.subscribe` that
   * has not ended, however it ended. A replay-only read (`feed.replay`) holds none.
   */
  subscriberCount(): number;
  publish(event: unknown): BureauEventEnvelope | undefined;
  dispose(): void;
};

export type BureauEventFeedOptions = {
  bureauId: string;
  maxEvents?: number;
  /**
   * How many live envelopes one subscriber may fall behind before its buffer
   * overflows. Defaults to Weft's. An overflow yields one
   * {@link FRAMES_DROPPED_KIND} marker and the stream continues (COR-1477).
   */
  liveBufferSize?: number;
  now?: () => number;
  /**
   * Called synchronously with each envelope after it is appended, so a consumer that must see every
   * published event as it happens (COR-1939's hooks) needs no subscription that could fall behind.
   * A listener that throws is ignored.
   */
  onPublish?: (envelope: BureauEventEnvelope) => void;
};

export function createBureauEventFeed(options: BureauEventFeedOptions): BureauEventFeed {
  // `NaN` or `Infinity` would make the overflow check (`length >= size`) never
  // fire, and the live buffer of a slow subscriber would grow without bound.
  const liveBufferSize = options.liveBufferSize;
  if (
    liveBufferSize !== undefined &&
    !(Number.isSafeInteger(liveBufferSize) && liveBufferSize >= 0)
  ) {
    throw new RangeError(
      `Bureau event feed liveBufferSize must be a non-negative integer, got ${liveBufferSize}.`,
    );
  }
  const now = options.now ?? createDefaultRuntimeServices().clock.now;
  const backend: InMemoryReplayLiveBackend<BureauEventEnvelope> =
    createInMemoryReplayLiveBackend<BureauEventEnvelope>({
      ...(options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents }),
      createGapEnvelope: ({ requestedCursor, firstRetainedSequence, continuationCursor }) => ({
        sequence: firstRetainedSequence - 1,
        cursor: continuationCursor,
        bureauId: options.bureauId,
        kind: 'feed.gap',
        emittedAtMs: now(),
        payload: { requestedCursor, firstRetainedSequence },
      }),
    });
  // COR-1731: the backend is where a live subscription is registered and released, so counting
  // there sees every subscriber and releases it however its stream ended.
  const liveSubscribers = new Set<object>();
  const subscribeLive = backend.subscribeLive.bind(backend);
  backend.subscribeLive = (listener) => {
    const release = subscribeLive(listener);
    const token = {};
    liveSubscribers.add(token);
    return () => {
      liveSubscribers.delete(token);
      release();
    };
  };
  const lifetime = new AbortController();
  const feed = withFramesDroppedMarker(
    bindFeedLifetime(
      createReplayLiveFeed<BureauEventEnvelope>(
        backend,
        options.liveBufferSize === undefined ? {} : { liveBufferSize: options.liveBufferSize },
      ),
      lifetime.signal,
    ),
    lifetime.signal,
    // Positioned at the last event the reader received, so resuming from the
    // marker's cursor skips nothing. It names no projection, so it is not in
    // `PUBLISHED_BUREAU_EVENT_KINDS` and a `kinds` filter never hides it.
    ({ sequence: lastSequence, cursor }) => ({
      sequence: lastSequence,
      cursor,
      bureauId: options.bureauId,
      kind: FRAMES_DROPPED_KIND,
      emittedAtMs: now(),
      payload: {},
    }),
  );
  let sequence = 0;

  return {
    feed,
    signal: lifetime.signal,
    subscriberCount: () => liveSubscribers.size,
    publish(event) {
      const projected = projectBureauEvent(event);
      if (projected === undefined) return undefined;
      const source = eventSourceOf(event);
      const envelope: BureauEventEnvelope = {
        sequence,
        cursor: backend.encodeCursor?.(sequence) ?? String(sequence),
        bureauId: options.bureauId,
        kind: projected.kind,
        emittedAtMs: now(),
        payload: projected.payload,
        ...(source === undefined ? {} : { source }),
      };
      sequence += 1;
      backend.append(envelope);
      try {
        options.onPublish?.(envelope);
      } catch {
        // A listener must not break the feed it listens to.
      }
      return envelope;
    },
    dispose() {
      // Before the backend, so a subscriber observes the abort rather than a
      // silently emptied log.
      lifetime.abort();
      feed.dispose();
      backend.dispose();
      // The backend drops its listeners without calling their release, so none is held now.
      liveSubscribers.clear();
    },
  };
}
