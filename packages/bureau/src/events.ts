import type { PluginScoreOutcome } from '@lostgradient/interborough-plugin';
import type { EventMap } from '@lostgradient/lifecycle';
import type { ScheduleMissedFireReason } from '@lostgradient/weft';
import type {
  Action,
  AgentScheduledEvent,
  LivenessLeaseEvidence,
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
import type {
  SkillActivatedEvent,
  SkillDeactivatedEvent,
  SkillFailedEvent,
  SkillLoadedEvent,
  SkillRejectedEvent,
} from './skills';
import type { PluginProblemCode } from './plugins/plugin-problem-codes';
import type { PluginStatus } from './plugins/plugin-types';
import type { TaskCleanupState } from './task-registry';

/**
 * Fired when the store records an action from a run.
 */
export class ActionEvent extends Event {
  static readonly type = 'action' as const;

  readonly action: Action;

  constructor(action: Action) {
    super(ActionEvent.type);
    this.action = action;
  }
}

/**
 * A guardrail halted a run (`mode: 'tripwire'`), as the run recorded it (COR-2096). It wraps the
 * recorded action, like {@link ActionEvent}, and the event feed publishes only the guardrail's
 * identity from it: never the flagged text or the guardrail's `detail`.
 */
export class RunTripwireRecordedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'run.tripwire' as const;

  /** The action the run recorded. */
  readonly action: Action;

  constructor(action: Action) {
    super(RunTripwireRecordedEvent.type);
    this.action = action;
  }
}

/**
 * A `mode: 'validate'` guardrail acted on a step and the run went on (COR-2096), as the run
 * recorded it. The feed publishes the guardrail's identity and what it did, never the flagged text.
 */
export class RunGuardrailRecordedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'run.guardrail' as const;

  /** The action the run recorded. */
  readonly action: Action;

  constructor(action: Action) {
    super(RunGuardrailRecordedEvent.type);
    this.action = action;
  }
}

/**
 * A run's spend crossed one of its budget's warning fractions (COR-2096), as the run recorded it.
 * The feed publishes the fraction, the spend, the budget and the model, never request content.
 */
export class BudgetThresholdRecordedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'budget.threshold' as const;

  /** The action the run recorded. */
  readonly action: Action;

  constructor(action: Action) {
    super(BudgetThresholdRecordedEvent.type);
    this.action = action;
  }
}

/**
 * A tool call was refused by a policy (COR-2096), as the run recorded it. The feed publishes the
 * tool and the call, never the policy's free-text reason or the call's arguments.
 */
export class ToolPolicyDeniedRecordedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'tool.policy-denied' as const;

  /** The action the run recorded. */
  readonly action: Action;

  constructor(action: Action) {
    super(ToolPolicyDeniedRecordedEvent.type);
    this.action = action;
  }
}

/**
 * A tool call failed (COR-2096), as the run recorded it. The feed publishes the tool, the call and
 * the error's code when it is an identifier, never the error's message, cause or stack.
 */
export class ToolErrorRecordedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'tool.error' as const;

  /** The action the run recorded. */
  readonly action: Action;

  constructor(action: Action) {
    super(ToolErrorRecordedEvent.type);
    this.action = action;
  }
}

/**
 * A child run was dispatched by a run (COR-2097), as the parent run recorded it. The feed publishes
 * the parent, the child and the child's agent, never the prompt the child was given.
 */
export class ChildWorkflowStartedRecordedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'multiagent.child-workflow.started' as const;

  /** The action the parent run recorded. */
  readonly action: Action;

  constructor(action: Action) {
    super(ChildWorkflowStartedRecordedEvent.type);
    this.action = action;
  }
}

/** A child run ended cleanly (COR-2097), as the parent run recorded it. */
export class ChildWorkflowCompletedRecordedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'multiagent.child-workflow.completed' as const;

  /** The action the parent run recorded. */
  readonly action: Action;

  constructor(action: Action) {
    super(ChildWorkflowCompletedRecordedEvent.type);
    this.action = action;
  }
}

/**
 * A child run ended in a failure (COR-2097), as the parent run recorded it. The feed publishes the
 * finish reason when it is a member of the finish-reason enum, never the rejection's message the
 * run recorded beside it.
 */
export class ChildWorkflowFailedRecordedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'multiagent.child-workflow.failed' as const;

  /** The action the parent run recorded. */
  readonly action: Action;

  constructor(action: Action) {
    super(ChildWorkflowFailedRecordedEvent.type);
    this.action = action;
  }
}

/** A child run was aborted (COR-2097), as the parent run recorded it. The abort reason stays on the run. */
export class ChildWorkflowAbortedRecordedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'multiagent.child-workflow.aborted' as const;

  /** The action the parent run recorded. */
  readonly action: Action;

  constructor(action: Action) {
    super(ChildWorkflowAbortedRecordedEvent.type);
    this.action = action;
  }
}

/** A handoff tool transferred a run to another agent (COR-2097), as the run recorded it. */
export class HandoffOccurredRecordedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'multiagent.handoff.occurred' as const;

  /** The action the run recorded. */
  readonly action: Action;

  constructor(action: Action) {
    super(HandoffOccurredRecordedEvent.type);
    this.action = action;
  }
}

/**
 * Accepted steering commands were applied (COR-2097): a step observed their configuration, once the
 * steering log recorded that boundary, or a command was already in force when it was admitted. One
 * event covers every command one boundary applied. The feed publishes the session, never the
 * effective state the run stamped on the step. `action.runId` is the run whose boundary applied
 * them, and empty for a session-scoped command recorded applied at admission.
 */
export class SteeringAppliedRecordedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'steering.applied' as const;

  /** The action the run recorded. */
  readonly action: Action;

  constructor(action: Action) {
    super(SteeringAppliedRecordedEvent.type);
    this.action = action;
  }
}

/**
 * A hook of a run's plan threw (COR-2097), as the run recorded it. The feed publishes which
 * registration threw and an error code, never the error: its message and cause stay on the audit
 * record.
 */
export class HookPlanFailedRecordedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'hook-plan.failed' as const;

  /** The action the run recorded. */
  readonly action: Action;

  constructor(action: Action) {
    super(HookPlanFailedRecordedEvent.type);
    this.action = action;
  }
}

/** What a steering command did not do, and why: the part of a refusal, a supersession or a failure Bureau publishes. */
export interface SteeringOutcomeDetail {
  /** The session the command was sent to. */
  readonly sessionId: string;
  /** The command's id, when the command had one. */
  readonly commandId?: string | undefined;
  /** `SteeringCommandFailure.reason`; its `failedAt` and `supersededBy` are not published. */
  readonly failureReason: string;
}

/**
 * A steering command was refused at admission (COR-2097). A refusal that decides nothing (a command
 * that never reached the gate) is not announced, and a retry of a key the log already decided is
 * not announced again.
 */
export class SteeringCommandRejectedEvent extends Event implements SteeringOutcomeDetail {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'steering.rejected' as const;

  readonly sessionId: string;
  readonly commandId?: string | undefined;
  readonly failureReason: string;

  constructor(detail: SteeringOutcomeDetail) {
    super(SteeringCommandRejectedEvent.type);
    this.sessionId = detail.sessionId;
    this.commandId = detail.commandId;
    this.failureReason = detail.failureReason;
  }
}

/** An accepted steering command was replaced by a later one for the same target (COR-2097). */
export class SteeringCommandSupersededEvent extends Event implements SteeringOutcomeDetail {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'steering.superseded' as const;

  readonly sessionId: string;
  readonly commandId?: string | undefined;
  readonly failureReason: string;

  constructor(detail: SteeringOutcomeDetail) {
    super(SteeringCommandSupersededEvent.type);
    this.sessionId = detail.sessionId;
    this.commandId = detail.commandId;
    this.failureReason = detail.failureReason;
  }
}

/** An accepted steering command could not be applied: its deadline passed or its run or session ended (COR-2097). */
export class SteeringCommandFailedEvent extends Event implements SteeringOutcomeDetail {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'steering.failed' as const;

  readonly sessionId: string;
  readonly commandId?: string | undefined;
  readonly failureReason: string;

  constructor(detail: SteeringOutcomeDetail) {
    super(SteeringCommandFailedEvent.type);
    this.sessionId = detail.sessionId;
    this.commandId = detail.commandId;
    this.failureReason = detail.failureReason;
  }
}

/**
 * Fired when a new run is registered in the store.
 */
export class RunRegisteredEvent extends Event {
  static readonly type = 'run.registered' as const;

  readonly runId: string;

  constructor(runId: string) {
    super(RunRegisteredEvent.type);
    this.runId = runId;
  }
}

/**
 * How a settled run ended, as the task registry names it (`settledTaskState`): a run that finished
 * without failing, a failure (`isFailureFinishReason`, or a settlement that says it failed), or an
 * abort.
 */
export type RunSettledStatus = 'completed' | 'failed' | 'canceled';

/**
 * Fired after a task's terminal state is committed to the task registry, after the one outcome
 * event ({@link RunCompletedOutcomeEvent}, {@link RunFailedOutcomeEvent} or
 * {@link RunAbortedOutcomeEvent}) that says how it ended. Unlike {@link RunRemovedEvent}, this does
 * not mean that the run was deleted.
 */
export class RunSettledEvent extends Event {
  static readonly type = 'run.settled' as const;

  readonly runId: string;
  /** How the run ended. */
  readonly status: RunSettledStatus;
  /** Why the run stopped, when the settlement recorded one. */
  readonly finishReason?: string | undefined;

  constructor(runId: string, status: RunSettledStatus, finishReason?: string) {
    super(RunSettledEvent.type);
    this.runId = runId;
    this.status = status;
    this.finishReason = finishReason;
  }
}

/**
 * Fired, once and just before {@link RunSettledEvent}, for a run that ended without failing and
 * without being aborted. A failed run never fires it: the feed's `run.completed` is the outcome,
 * where the `action` envelope with `actionType: 'run.completed'` is the run's own log entry.
 */
export class RunCompletedOutcomeEvent extends Event {
  /** The event type, and the published kind. */
  static readonly type = 'run.completed' as const;

  /** The run's identifier. */
  readonly runId: string;
  /** Why the run stopped, when the settlement recorded one. */
  readonly finishReason?: string | undefined;

  constructor(runId: string, finishReason?: string) {
    super(RunCompletedOutcomeEvent.type);
    this.runId = runId;
    this.finishReason = finishReason;
  }
}

/** What a live `RunErrorEvent` told that the task's settlement does not keep. */
export interface RunFailureDetail {
  /** The failing step's index; left out for a step that was reconstructed rather than observed. */
  readonly step?: number | undefined;
  /** `AgentRunError.code`. */
  readonly errorCode?: string | undefined;
  /** `AgentRunError.kind`. */
  readonly errorKind?: string | undefined;
}

/**
 * Fired, once and just before {@link RunSettledEvent}, for every run that ended in a failure
 * (`isFailureFinishReason`): an error, a tripwire, the step limit, a denied elicitation, a budget,
 * and a settlement written by the Bureau (`timed-out`, `deadline-exceeded`, `owner-lost`).
 *
 * It carries no error text: a failure is named by its finish reason, its kind (a member of the
 * error-kind enum) and its code (an identifier). The text is read through the authorized task read
 * (`bureau.tasks.get`, by `runId`), never from a pushed event (Revision 2026-11-16 of COR-2095).
 */
export class RunFailedOutcomeEvent extends Event {
  /** The event type, and the published kind. */
  static readonly type = 'run.error' as const;

  /** The run's identifier. */
  readonly runId: string;
  /** Why the run stopped; `error` when the settlement recorded none. */
  readonly finishReason: string;
  /** The failing step's index, when the run's own failure event named one that was observed. */
  readonly step?: number | undefined;
  /** `AgentRunError.code`, when the run's own failure event named it and it is an identifier. */
  readonly errorCode?: string | undefined;
  /** `AgentRunError.kind`, when the run's own failure event named it and it is a known kind. */
  readonly errorKind?: string | undefined;

  constructor(runId: string, finishReason: string, detail: RunFailureDetail = {}) {
    super(RunFailedOutcomeEvent.type);
    this.runId = runId;
    this.finishReason = finishReason;
    this.step = detail.step;
    this.errorCode = detail.errorCode;
    this.errorKind = detail.errorKind;
  }
}

/** Fired, once and just before {@link RunSettledEvent}, for a run that was aborted. */
export class RunAbortedOutcomeEvent extends Event {
  /** The event type, and the published kind. */
  static readonly type = 'run.aborted' as const;

  /** The run's identifier. */
  readonly runId: string;
  /** Why the run stopped, when the settlement recorded one. */
  readonly finishReason?: string | undefined;

  constructor(runId: string, finishReason?: string) {
    super(RunAbortedOutcomeEvent.type);
    this.runId = runId;
    this.finishReason = finishReason;
  }
}

/**
 * Fired when a run is removed from the store.
 */
export class RunRemovedEvent extends Event {
  static readonly type = 'run.removed' as const;

  readonly runId: string;

  constructor(runId: string) {
    super(RunRemovedEvent.type);
    this.runId = runId;
  }
}

/**
 * Fired when an aborted run's teardown has settled: its `activeRun.closed()` resolved and the run
 * left `internals.abortingTasks()`. `abortRun` returns before this, and the run's terminal status can
 * precede it, so a caller that must know the abort is fully finished (not merely that the run
 * stopped) waits for this rather than for a status.
 */
export class RunAbortSettledEvent extends Event {
  static readonly type = 'run.abort-settled' as const;

  readonly runId: string;

  constructor(runId: string) {
    super(RunAbortSettledEvent.type);
    this.runId = runId;
  }
}

/**
 * Fired when the bureau is disposed.
 */
export class BureauDisposedEvent extends Event {
  static readonly type = 'bureau.disposed' as const;

  constructor() {
    super(BureauDisposedEvent.type);
  }
}

/**
 * `classifyRecoveredRun`'s five possible outcomes (AB-90/ab90-09). Named here
 * rather than re-derived at each call site, so `RecoveryAttemptedEvent`'s
 * `verdict` field and `classifyRecoveredRun`'s own return type share one
 * definition.
 */
export type RecoveredRunVerdict =
  'reattach' | 'reattach-version-mismatch' | 'monitor' | 'cancel' | 'skip';

/**
 * Fired every time `classifyRecoveredRun` runs during boot recovery — for
 * every recovered handle, regardless of verdict — making today's
 * internal-only classification (AB-87's Recovery surface table) externally
 * observable for the first time. Dispatched immediately after the verdict is
 * computed, before any branch-specific handling (reattach, monitor, cancel).
 */
export class RecoveryAttemptedEvent extends Event {
  static readonly type = 'recovery.attempted' as const;

  readonly runId: string;
  readonly verdict: RecoveredRunVerdict;

  constructor(runId: string, verdict: RecoveredRunVerdict) {
    super(RecoveryAttemptedEvent.type);
    this.runId = runId;
    this.verdict = verdict;
  }
}

/**
 * Why `classifyRecoveredRun` positively rejected a recovered handle (its
 * `'cancel'` verdict) rather than reattaching, monitoring, or skipping it
 * pending confirmation. Mirrors `classifyRecoveredRun`'s own `'cancel'`
 * branches exactly — see `create-bureau.ts`'s `classifyRecoveredRunDetailed`,
 * the single source of truth both the verdict and this reason are derived
 * from in one pass, so the two can never drift.
 *
 * `'prepared-not-launched'` (COR-297) rejects a run its session still owns and
 * says is running, whose durable record is still `pending`: the process that
 * prepared it stopped before launching it, so it never executed and is
 * cancelled rather than reattached.
 */
export type RecoveryRejectionReason =
  | 'metadata-read-failed'
  | 'foreign-input'
  | 'session-absent'
  | 'session-run-mismatch'
  | 'session-not-running'
  | 'prepared-not-launched';

/**
 * Fired only when `classifyRecoveredRun`'s verdict is `'cancel'` — a
 * positive rejection, distinct from a successful reattachment (`'reattach'`/
 * `'reattach-version-mismatch'`), a headless `'monitor'`, or an indeterminate
 * `'skip'` (ownership could not be confirmed, so nothing is rejected).
 * Always dispatched after the corresponding `RecoveryAttemptedEvent` for the
 * same `runId`.
 */
export class RecoveryRejectedEvent extends Event {
  static readonly type = 'recovery.rejected' as const;

  readonly runId: string;
  readonly reason: RecoveryRejectionReason;

  constructor(runId: string, reason: RecoveryRejectionReason) {
    super(RecoveryRejectedEvent.type);
    this.runId = runId;
    this.reason = reason;
  }
}

/**
 * Fired when boot recovery observes that a Weft-held engine lease this run's
 * recovery depended on was released — projecting `Engine.getLeaseHealth()`'s
 * contested-with-holder-record shape (see
 * `liveness-projection.ts`'s `leaseEvidenceFromLostHealth`), never a
 * Bureau-owned lease of its own (AB-39's ownership map: Weft is sole owner of
 * lease state). Not dispatched for a currently-held, healthy lease, nor for
 * the sparsest contested shape (no holder record to relay) — both would
 * require fabricating evidence Weft did not actually report.
 */
export class RecoveryLeaseReleasedEvent extends Event {
  static readonly type = 'recovery.lease-released' as const;

  readonly runId: string;
  readonly lease: LivenessLeaseEvidence;

  constructor(runId: string, lease: LivenessLeaseEvidence) {
    super(RecoveryLeaseReleasedEvent.type);
    this.runId = runId;
    this.lease = lease;
  }
}

/**
 * The two {@link PendingReview} kinds a `review.*` event may report on.
 * Declared locally rather than imported from `./types` (which itself
 * imports {@link BureauEventMap} from this module) so this file stays free
 * of a type-only import cycle — the same reason {@link RecoveredRunVerdict}
 * above is a local literal union rather than re-exported from `bureau-types/facade.ts`.
 */
export type ReviewEventKind = 'tool-approval' | 'human-wait';

/**
 * Base of AB-224's `review.*` lifecycle event family (implementing AB-87's
 * event matrix and AB-46's `ReviewStatus` vocabulary). Carries only
 * `reviewId`, `runId`, `principal`, and `kind` — never the review's own
 * `approval`/`signalName`/`prompt`/decision `reason`, which stay privileged
 * per AB-87's redaction column and surface only through the durable audit
 * trail (`recordReviewDecision`/`recordReviewStatusTransition` in
 * `create-bureau.ts`), a separately-redacted surface.
 *
 * One event per non-`'pending'` `ReviewStatus` value; `pending` itself
 * dispatches no resolution event — per AB-87, "pending is the resting state
 * before any armorer signal fires". COR-1481 adds the one request event,
 * `review.requested`, for the moment a review becomes pending:
 *
 * | `ReviewStatus` | Event                |
 * | -------------- | --------------------- |
 * | `pending`      | `review.requested` (on entry only) |
 * | `approved`     | `review.approved`     |
 * | `denied`       | `review.denied`       |
 * | `rejected`     | `review.rejected`     |
 * | `expired`      | `review.expired`      |
 * | `revoked`      | `review.revoked`      |
 * | `canceled`     | `review.canceled`     |
 * | `superseded`   | `review.superseded`   |
 */
class ReviewLifecycleEvent extends Event {
  readonly reviewId: string;
  readonly runId: string;
  readonly principal: string;
  readonly kind: ReviewEventKind;

  constructor(
    type: string,
    reviewId: string,
    runId: string,
    principal: string,
    kind: ReviewEventKind,
  ) {
    super(type);
    this.reviewId = reviewId;
    this.runId = runId;
    this.principal = principal;
    this.kind = kind;
  }
}

/**
 * Fired once when a review becomes pending (COR-1481): a run parks on a human
 * wait, or a tool call needs approval. It is the one `review.*` event that is
 * not a resolution, and it exists so a task's durable history can show the task
 * entering `input-required`. `principal` is the run's owner. It carries the
 * review id and kind plus the identifier that addresses the wait (`signalName`
 * for a human wait, `callId` for an approval) and nothing the review holds: no
 * prompt text and no tool arguments.
 */
export class ReviewRequestedEvent extends ReviewLifecycleEvent {
  static readonly type = 'review.requested' as const;
  readonly signalName: string | undefined;
  readonly callId: string | undefined;

  constructor(
    reviewId: string,
    runId: string,
    principal: string,
    kind: ReviewEventKind,
    target: { readonly signalName?: string | undefined; readonly callId?: string | undefined } = {},
  ) {
    super(ReviewRequestedEvent.type, reviewId, runId, principal, kind);
    this.signalName = target.signalName;
    this.callId = target.callId;
  }
}

/** Fired when `reviews.resolve({ decision: 'approve' })` settles a review (AB-224). */
export class ReviewApprovedEvent extends ReviewLifecycleEvent {
  static readonly type = 'review.approved' as const;

  constructor(reviewId: string, runId: string, principal: string, kind: ReviewEventKind) {
    super(ReviewApprovedEvent.type, reviewId, runId, principal, kind);
  }
}

/** Fired when `reviews.resolve({ decision: 'deny' })` settles a review (AB-224). */
export class ReviewDeniedEvent extends ReviewLifecycleEvent {
  static readonly type = 'review.denied' as const;

  constructor(reviewId: string, runId: string, principal: string, kind: ReviewEventKind) {
    super(ReviewDeniedEvent.type, reviewId, runId, principal, kind);
  }
}

/**
 * Fired when `reviews.resolve({ decision: 'reject' })` settles a review
 * (AB-224). Distinct from {@link ReviewDeniedEvent} — `reject` is AB-46's
 * new verb, never dispatched by the plain `deny` path.
 */
export class ReviewRejectedEvent extends ReviewLifecycleEvent {
  static readonly type = 'review.rejected' as const;

  constructor(reviewId: string, runId: string, principal: string, kind: ReviewEventKind) {
    super(ReviewRejectedEvent.type, reviewId, runId, principal, kind);
  }
}

/**
 * Fired when the expiry sweep transitions a tool-approval
 * review past its binding's `expiresAt` (AB-224). Always attributed to the
 * synthetic principal `'system:expiry'`.
 */
export class ReviewExpiredEvent extends ReviewLifecycleEvent {
  static readonly type = 'review.expired' as const;

  constructor(reviewId: string, runId: string, principal: string, kind: ReviewEventKind) {
    super(ReviewExpiredEvent.type, reviewId, runId, principal, kind);
  }
}

/**
 * Fired when `deleteRun`/`deleteSession` revoke a still-pending review via
 * `revokePendingApprovalsForRun` (AB-224). Attributed to
 * `'system:run-deletion'` or `'system:session-deletion'`. Distinct from
 * {@link ReviewCanceledEvent} — revoked fires only from explicit run/session
 * deletion, never from run abort.
 */
export class ReviewRevokedEvent extends ReviewLifecycleEvent {
  static readonly type = 'review.revoked' as const;

  constructor(reviewId: string, runId: string, principal: string, kind: ReviewEventKind) {
    super(ReviewRevokedEvent.type, reviewId, runId, principal, kind);
  }
}

/**
 * Fired when `abortRun`/`cancelDurableRun` cancel a still-pending review via
 * `revokePendingApprovalsForRun` (AB-224). Always attributed to the
 * synthetic principal `'system:run-abort'`. Distinct from
 * {@link ReviewRevokedEvent} — canceled fires only from run abort, never
 * from explicit run/session deletion. Because `abortRun` dispatches this
 * review-cancellation as a detached, best-effort promise rather than
 * awaiting it before the run's own terminal event, a `run.aborted` and its
 * accompanying `review.canceled` can land in either order relative to each
 * other on the bureau's `'action'`/event streams — never assume one
 * precedes the other.
 */
export class ReviewCanceledEvent extends ReviewLifecycleEvent {
  static readonly type = 'review.canceled' as const;
  /**
   * The round of the approval the cancel closed (COR-1621): a re-gated approval keeps its id and
   * each round it leaves is closed on its own, so the pair of id and round names one closing.
   * `undefined` for an event that states none, which is recorded without a deduplication key.
   */
  readonly round: number | undefined;

  constructor(
    reviewId: string,
    runId: string,
    principal: string,
    kind: ReviewEventKind,
    round?: number,
  ) {
    super(ReviewCanceledEvent.type, reviewId, runId, principal, kind);
    this.round = round;
  }
}

/**
 * Fired when `resumeApproval`'s re-gate produces a new `pendingApproval` for
 * the same `callId` (AB-224): the ORIGINAL tool-approval review is marked
 * `superseded` while a fresh `'pending'` review sharing the same id takes
 * its place. Always attributed to the synthetic principal
 * `'system:supersession'`.
 */
export class ReviewSupersededEvent extends ReviewLifecycleEvent {
  static readonly type = 'review.superseded' as const;

  constructor(reviewId: string, runId: string, principal: string, kind: ReviewEventKind) {
    super(ReviewSupersededEvent.type, reviewId, runId, principal, kind);
  }
}

/**
 * The goal transitions dispatched live as a {@link GoalLifecycleEvent}: each one the goal event
 * projection records, and `goal.attempt.evaluating`, `goal.feedback.recorded` and `goal.retrying`,
 * which are live only and never in a goal's durable history.
 */
export type GoalEventKind =
  | 'goal.started'
  | 'goal.attempt.started'
  | 'goal.attempt.evaluating'
  | 'goal.attempt.validated'
  | 'goal.feedback.recorded'
  | 'goal.retrying'
  | 'goal.succeeded'
  | 'goal.exhausted'
  | 'goal.canceled'
  | 'goal.failed'
  | 'goal.recovered';

/**
 * The fields each goal event carries: the identifiers, versions, statuses, counts, and digest
 * `goal-event-projection.ts` records for it. A field the recorded payload lacks is omitted.
 */
const GOAL_EVENT_FIELDS: Readonly<Record<GoalEventKind, readonly string[]>> = {
  'goal.started': ['goalRunId', 'goalIdentity'],
  'goal.attempt.started': ['goalRunId', 'attemptId', 'attemptIndex', 'runId'],
  'goal.attempt.evaluating': ['goalRunId', 'attemptId', 'attemptIndex', 'runId'],
  'goal.attempt.validated': [
    'goalRunId',
    'attemptId',
    'validatorIdentity',
    'outcomeKind',
    'feedbackDigest',
    'judgedBy',
  ],
  // COR-2097: a failing verdict's digest and the retry it led to; live only, so the audit log never holds them.
  'goal.feedback.recorded': ['goalRunId', 'attemptId', 'feedbackDigest'],
  'goal.retrying': ['goalRunId', 'attemptIndex', 'retryReason'],
  'goal.succeeded': ['goalRunId', 'terminalReason'],
  'goal.exhausted': ['goalRunId', 'terminalReason'],
  'goal.canceled': ['goalRunId', 'terminalReason'],
  'goal.failed': ['goalRunId', 'terminalReason', 'validatorError'],
  'goal.recovered': ['goalRunId', 'controllerRestarts', 'status', 'transitionSeq'],
};

/** Every goal event kind, in the order a goal produces them. */
export const GOAL_EVENT_KINDS = Object.keys(GOAL_EVENT_FIELDS) as readonly GoalEventKind[];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A failed goal's validator error, reduced to its `kind` and `code`: its message never travels. */
function validatorErrorFields(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  return { kind: value['kind'], code: value['code'] };
}

/**
 * Fired on the bureau emitter when a goal write commits a transition the goal event projection
 * records (COR-1721): its creation, an attempt starting or being validated, a terminal decision, or
 * a counted controller restart. Also fired, as `goal.attempt.evaluating`, when an attempt's run has
 * finished and its validator starts (COR-1781); that one is live only, because the goal's record
 * already says it is evaluating and its history records the verdict. Live observations only: the boot pass that re-projects every goal
 * into the durable history dispatches nothing, and a duplicate delivery of a transition the store
 * already holds is observed and dispatched again, so a listener treats these as at-least-once.
 *
 * `payload` holds the recorded fields for `type` and nothing else; `goal.failed` keeps its
 * validator error's `kind` and `code` and drops the message, which stays behind `bureau.goals.get`.
 */
export class GoalLifecycleEvent extends Event {
  declare readonly type: GoalEventKind;
  readonly goalRunId: string;
  readonly payload: Readonly<Record<string, unknown>>;

  constructor(kind: GoalEventKind, recorded: Readonly<Record<string, unknown>>) {
    super(kind);
    const payload: Record<string, unknown> = {};
    for (const field of GOAL_EVENT_FIELDS[kind]) {
      const held = Object.hasOwn(recorded, field) ? recorded[field] : undefined;
      const value = field === 'validatorError' ? validatorErrorFields(held) : held;
      if (value !== undefined) payload[field] = value;
    }
    this.goalRunId = String(recorded['goalRunId']);
    this.payload = Object.freeze(payload);
  }
}

/** The asset events Bureau also dispatches on its own emitter, beside `bureau.assets.subscribe`. */
export type BureauAssetEventKind =
  'asset.upload.started' | 'asset.upload.purged' | 'asset.blob.purged' | 'asset.expired';

/** The asset event kinds forwarded onto the bureau emitter. */
export const BUREAU_ASSET_EVENT_KINDS: readonly BureauAssetEventKind[] = [
  'asset.upload.started',
  'asset.upload.purged',
  'asset.blob.purged',
  'asset.expired',
];

/**
 * Fired on the bureau emitter for each {@link BureauAssetEventKind} the asset service delivers to
 * `bureau.assets.subscribe` (COR-1721), carrying that event's own fields: its `sequence` and `at`,
 * and whichever of `assetId`, `revision`, `state`, `principal`, `uploadId`, and `digest` it set.
 */
export class AssetLifecycleEvent extends Event {
  declare readonly type: BureauAssetEventKind;
  /** The asset event's own sequence number, from `bureau.assets.subscribe`; not the feed's. */
  readonly sequence: number;
  readonly at: string;
  readonly assetId: string | undefined;
  readonly revision: number | undefined;
  readonly state: string | undefined;
  readonly principal: string | undefined;
  readonly uploadId: string | undefined;
  readonly digest: string | undefined;

  constructor(
    kind: BureauAssetEventKind,
    event: {
      readonly sequence: number;
      readonly at: string;
      readonly assetId?: string | undefined;
      readonly revision?: number | undefined;
      readonly state?: string | undefined;
      readonly principal?: string | undefined;
      readonly uploadId?: string | undefined;
      readonly digest?: string | undefined;
    },
  ) {
    super(kind);
    this.sequence = event.sequence;
    this.at = event.at;
    this.assetId = event.assetId;
    this.revision = event.revision;
    this.state = event.state;
    this.principal = event.principal;
    this.uploadId = event.uploadId;
    this.digest = event.digest;
  }
}

/** The kinds of {@link TriggerLifecycleEvent}. */
export type TriggerEventKind =
  'trigger.started' | 'trigger.stopped' | 'trigger.failed' | 'trigger.fired';

/** What became of one fire of a contributed trigger, as `trigger.fired` names it. */
export type TriggerFireOutcome = 'started' | 'duplicate' | 'skipped' | 'refused';

/**
 * COR-2250 — what a workflow file's contributed trigger did in this Bureau: its listener started
 * (`listening`, `waiting-for-secret`, or `ready` for a kind that only receives), stopped (its file
 * was paused or removed, or another Bureau sharing the storage took it over, COR-2167), or failed,
 * and what became of each fire. It names the file, the kind (`plugin:name`), the kind's version,
 * and, for a fire, its outcome, the run it started or found, and the code of a refusal; for a
 * failure, the listener's code. Never the payload, the idempotency key, or any error text.
 */
export class TriggerLifecycleEvent extends Event {
  declare readonly type: TriggerEventKind;
  readonly workflowId: string;
  /** The contributed kind, `plugin:name`. */
  readonly trigger: string;
  /** The kind's own version, else its plugin's, as of when the listener or the call started. */
  readonly version: string;
  /** `trigger.fired` only. */
  readonly outcome: TriggerFireOutcome | undefined;
  /** The run a `started` or `duplicate` fire names. */
  readonly runId: string | undefined;
  /**
   * An identifier (`^[A-Z][A-Z0-9_]{0,63}$`): why a `trigger.failed` listener failed
   * (`START_FAILED`, `CONFIGURATION_REFUSED`), or why a `refused` fire was refused.
   */
  readonly errorCode: string | undefined;

  constructor(
    kind: TriggerEventKind,
    event: {
      readonly workflowId: string;
      readonly trigger: string;
      readonly version: string;
      readonly outcome?: TriggerFireOutcome | undefined;
      readonly runId?: string | undefined;
      readonly errorCode?: string | undefined;
    },
  ) {
    super(kind);
    this.workflowId = event.workflowId;
    this.trigger = event.trigger;
    this.version = event.version;
    this.outcome = event.outcome;
    this.runId = event.runId;
    this.errorCode = event.errorCode;
  }
}

/** Which file catalog a {@link DefinitionsChangedEvent} reports on. */
export type DefinitionCatalogKind = 'agents' | 'workflows';

/**
 * Fired on the bureau emitter after a rescan of the agent or workflow files changed what the
 * catalog holds (COR-1721), with the same identifiers its `onChange` listeners receive. `rejected`
 * names those of `added` and `changed` whose definition is invalid now and cannot run.
 */
export class DefinitionsChangedEvent extends Event {
  static readonly type = 'definitions.changed' as const;

  /** Which file catalog changed. Named `catalog`, not `source`: `source` is the envelope's plugin name. */
  readonly catalog: DefinitionCatalogKind;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly rejected: readonly string[];

  constructor(
    catalog: DefinitionCatalogKind,
    change: {
      readonly added: readonly string[];
      readonly changed: readonly string[];
      readonly removed: readonly string[];
      readonly rejected: readonly string[];
    },
  ) {
    super(DefinitionsChangedEvent.type);
    this.catalog = catalog;
    this.added = [...change.added];
    this.changed = [...change.changed];
    this.removed = [...change.removed];
    this.rejected = [...change.rejected];
  }
}

/**
 * Fired on the bureau emitter when the durable engine reports that one of this Bureau's schedules
 * skipped occurrences (COR-1721), copied from Weft's `ScheduleMissedFireEvent`: `reason` `late` for
 * occurrences the schedule was too late for, `dst-gap` for a wall-clock time its time zone's clock
 * skipped when it sprang forward (COR-1820). Dispatched only when `bureau.schedules.get(scheduleId)` still returns the schedule, so it arrives
 * a turn after the engine's own event.
 */
export class ScheduleMissedEvent extends Event {
  static readonly type = 'schedule.missed' as const;

  readonly scheduleId: string;
  readonly missedCount: number;
  readonly windowStart: number;
  readonly windowEnd: number;
  /** Why the occurrences were missed, as Weft reports it. */
  readonly reason: ScheduleMissedFireReason;

  constructor(
    scheduleId: string,
    missedCount: number,
    windowStart: number,
    windowEnd: number,
    reason: ScheduleMissedFireReason,
  ) {
    super(ScheduleMissedEvent.type);
    this.scheduleId = scheduleId;
    this.missedCount = missedCount;
    this.windowStart = windowStart;
    this.windowEnd = windowEnd;
    this.reason = reason;
  }
}

/**
 * Fired on the bureau emitter once a task's cleanup acknowledgement has been written to its record
 * (COR-1721): for every task whose run's `closed()` Bureau follows, a canceled one or not. `cleanup` is the state `bureau.tasks.get(taskId).cleanup` now reads: `cleaned-up`,
 * `cleanup-failed`, `cleanup-unresolved`, or `unknown-outcome`. Not dispatched when the write fails
 * or the task record is gone.
 */
export class TaskCleanupAcknowledgedEvent extends Event {
  static readonly type = 'task.cleanup-acknowledged' as const;

  readonly taskId: string;
  readonly cleanup: TaskCleanupState;

  constructor(taskId: string, cleanup: TaskCleanupState) {
    super(TaskCleanupAcknowledgedEvent.type);
    this.taskId = taskId;
    this.cleanup = cleanup;
  }
}

/**
 * Fired on the bureau emitter once a notification is written (COR-1941), whoever wrote it: Bureau
 * for a failed run, a review waiting or a budget exceeded, or the host through
 * `bureau.notifications.create`. It names the notification and its kind and nothing else, not its
 * owner and not its text; a client that watches the feed reads its own notifications with
 * `bureau.notifications.list`. A `create` that finds its `dedupeKey` already used writes nothing and
 * dispatches nothing.
 */
export class NotificationCreatedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'notification.created' as const;

  /** The identifier of the notification that was written. */
  readonly notificationId: string;
  /** Its kind, such as `run.failed`. */
  readonly notificationKind: string;

  constructor(notificationId: string, notificationKind: string) {
    super(NotificationCreatedEvent.type);
    this.notificationId = notificationId;
    this.notificationKind = notificationKind;
  }
}

/**
 * Fired on the bureau emitter for each diagnostic the Bureau reports through `onDiagnostic` (or the
 * console, when that is unset), carrying its `level` and `scope` and never its message or cause
 * (COR-1721). A diagnostic raised before the emitter exists, by the event feed's own recorder, or
 * while a `diagnostic` event is being dispatched reaches the sink only.
 */
export class DiagnosticEvent extends Event {
  static readonly type = 'diagnostic' as const;

  readonly level: 'warn' | 'error';
  readonly scope: string;

  constructor(level: 'warn' | 'error', scope: string) {
    super(DiagnosticEvent.type);
    this.level = level;
    this.scope = scope;
  }
}

/**
 * Fired once a `bureau.decisions.decide` decision has been written to the audit trail (COR-2249):
 * how it ended (`answered`, `refused` or `error`), which kind it was, the catalog row that
 * answered and the path it answered by (neither for a refusal that no model reached; a policy
 * denial names the row alone), and the task it was asked for. It names no request, value,
 * rationale, schema, principal, provider or routing identifier.
 */
export class DecisionMadeEvent extends Event {
  /** The event kind, as the event feed publishes it, and the audit record's type. */
  static readonly type = 'decision.made' as const;

  /** The decision's kind: `boolean`, `choice`, `structured`, and so on. */
  readonly kind: string;
  /** How the decision ended. */
  readonly outcome: 'answered' | 'refused' | 'error';
  /** The row that answered, `<provider>/<model>`, when one did or one was refused. */
  readonly row?: string | undefined;
  /** How it answered: through a row that declares the kind, through a row's `generate`, or the fallback. */
  readonly path?: 'native' | 'adapter' | 'fallback' | undefined;
  /** The task the decision was asked for, when it was asked for one. */
  readonly taskId?: string | undefined;

  constructor(decision: {
    readonly kind: string;
    readonly outcome: 'answered' | 'refused' | 'error';
    readonly row?: string | undefined;
    readonly path?: 'native' | 'adapter' | 'fallback' | undefined;
    readonly taskId?: string | undefined;
  }) {
    super(DecisionMadeEvent.type);
    this.kind = decision.kind;
    this.outcome = decision.outcome;
    this.row = decision.row;
    this.path = decision.path;
    this.taskId = decision.taskId;
  }
}

/**
 * A secret a plugin declared was stored (COR-2098), as the host reported it through
 * `BureauOptions.hostEvents`. It names the plugin and the key the plugin declares, and carries
 * nothing of the value: not the value, its length, a digest of it or a prefix.
 */
export class PluginSecretSetEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'secret.set' as const;

  /** The plugin that declared the secret. */
  readonly plugin: string;
  /** The key the plugin declared. */
  readonly key: string;

  constructor(plugin: string, key: string) {
    super(PluginSecretSetEvent.type);
    this.plugin = plugin;
    this.key = key;
  }
}

/** A secret a plugin declared was removed (COR-2098), as the host reported it. */
export class PluginSecretRemovedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'secret.removed' as const;

  /** The plugin that declared the secret. */
  readonly plugin: string;
  /** The key the plugin declared. */
  readonly key: string;

  constructor(plugin: string, key: string) {
    super(PluginSecretRemovedEvent.type);
    this.plugin = plugin;
    this.key = key;
  }
}

/**
 * A plugin's persisted choices were written (COR-2098), as the host reported it: whether it is
 * enabled, and whether a restart applies what is stored. It carries no configuration value.
 */
export class PluginSettingsChangedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'plugin.settings-changed' as const;

  /** The plugin. */
  readonly plugin: string;
  /** Whether the plugin is enabled in the persisted choices. */
  readonly enabled: boolean;
  /** Whether the persisted choices differ from the ones the running host loaded. */
  readonly restartRequired: boolean;

  constructor(plugin: string, enabled: boolean, restartRequired: boolean) {
    super(PluginSettingsChangedEvent.type);
    this.plugin = plugin;
    this.enabled = enabled;
    this.restartRequired = restartRequired;
  }
}

/**
 * A plugin's status changed after a write (COR-2098), as the host reported it: the status it was
 * last published at, the status now, and the codes of the problems it lists. A problem's message,
 * path and key are never part of it.
 */
export class PluginStatusChangedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'plugin.status-changed' as const;

  /** The plugin. */
  readonly plugin: string;
  /** The status the plugin was last reported at. */
  readonly previousStatus: PluginStatus;
  /** The status it has now. */
  readonly status: PluginStatus;
  /** The distinct codes of the problems it lists, in the order it lists them. */
  readonly problemCodes: readonly PluginProblemCode[];

  constructor(
    plugin: string,
    previousStatus: PluginStatus,
    status: PluginStatus,
    problemCodes: readonly PluginProblemCode[],
  ) {
    super(PluginStatusChangedEvent.type);
    this.plugin = plugin;
    this.previousStatus = previousStatus;
    this.status = status;
    this.problemCodes = problemCodes;
  }
}

/**
 * Fired once a scorer's score of a run has been recorded on the audit trail and breaches the
 * scorer's rule: a `fail`, or a score below its `alertThreshold` (COR-2251). It names the run, the
 * scorer and its version, the outcome and the score when there is one. It names no message, no
 * threshold, no digest and nothing of the run's content: the scorer's text stays on the
 * `scorer.recorded` audit record.
 */
export class ScorerThresholdBreachedEvent extends Event {
  /** The event kind, as the event feed publishes it. */
  static readonly type = 'scorer.threshold-breached' as const;

  /** The run that was scored. */
  readonly runId: string;
  /** The scorer's name. */
  readonly scorerName: string;
  /** The scorer's version. */
  readonly scorerVersion: string;
  /** How the scorer judged the run: a validator outcome kind. */
  readonly outcome: PluginScoreOutcome;
  /** The score from 0 to 1, when the scorer gave one. */
  readonly score?: number | undefined;

  constructor(breach: {
    readonly runId: string;
    readonly scorerName: string;
    readonly scorerVersion: string;
    readonly outcome: PluginScoreOutcome;
    readonly score?: number | undefined;
  }) {
    super(ScorerThresholdBreachedEvent.type);
    this.runId = breach.runId;
    this.scorerName = breach.scorerName;
    this.scorerVersion = breach.scorerVersion;
    this.outcome = breach.outcome;
    this.score = breach.score;
  }
}

/**
 * Fired on the bureau emitter for each notification the governed memory in `BureauOptions.memory`
 * hands its subscribers (COR-1723): every ledger event a write, read, denial, share, quarantine,
 * deletion, retention sweep, or policy change appends, after the governed call that raised it has
 * stored its change. `notificationType` is the ledger event's own type (for example
 * `memory.write.admitted`), since `type` is this event's kind. It carries the notification's
 * `outcome`, `tenantId`, `at`, `recordIds`, and `operationId` when it has one, and never record
 * content, a protected reason, a diagnostic, or the acting principal.
 */
export class MemoryGovernanceEvent extends Event {
  static readonly type = 'memory.governance' as const;

  readonly notificationType: string;
  readonly outcome: string;
  readonly tenantId: string;
  readonly at: number;
  readonly recordIds: readonly string[];
  readonly operationId: string | undefined;

  constructor(notification: {
    readonly type: string;
    readonly outcome: string;
    readonly tenantId: string;
    readonly at: number;
    readonly recordIds: readonly string[];
    readonly operationId?: string | undefined;
  }) {
    super(MemoryGovernanceEvent.type);
    this.notificationType = notification.type;
    this.outcome = notification.outcome;
    this.tenantId = notification.tenantId;
    this.at = notification.at;
    this.recordIds = [...notification.recordIds];
    this.operationId = notification.operationId;
  }
}

/**
 * Fired on the bureau emitter once per session, when a run's guardrails first taint it and the
 * taint is stored in the session (COR-2105). It names the session and the run, the detector, where
 * the flagged content came from, and the detector's confidence; it never carries the flagged text
 * or the detector's own detail. A later run of the same session starts tainted and does not fire it
 * again. It is published after the taint is stored, at most once: a process that stops between the
 * two stores the taint (which is what matters) and drops the event. `runId` is the run's id, or the
 * session's for a recovered run that has none.
 */
export class SessionTaintEvent extends Event {
  /** The event name: `session.tainted`. */
  static readonly type = 'session.tainted' as const;

  /** The session that is now tainted. */
  readonly sessionId: string;
  /** The run whose guardrails tainted it. */
  readonly runId: string;
  /** The detector that fired. */
  readonly detector: string;
  /** Where the flagged content came from, such as `user-input` or `tool-result`. */
  readonly provenance: string;
  /** The detector's confidence, from 0 to 1. */
  readonly confidence: number;

  constructor(taint: {
    readonly sessionId: string;
    readonly runId: string;
    readonly detector: string;
    readonly provenance: string;
    readonly confidence: number;
  }) {
    super(SessionTaintEvent.type);
    this.sessionId = taint.sessionId;
    this.runId = taint.runId;
    this.detector = taint.detector;
    this.provenance = taint.provenance;
    this.confidence = taint.confidence;
  }
}

/**
 * Maps event type strings to their corresponding Event subclasses.
 *
 * `schedule.created`/`paused`/`resumed`/`cancelled`/`failed`/`completed`
 * (AB-223/AB-298) are defined in `@lostgradient/operative` (alongside
 * `schedule.wakeup`) rather than here, but dispatched on THIS bureau-level
 * emitter — not a per-run operative emitter — because a schedule
 * create/pause/resume/cancel and a scheduled fire's terminal outcome are
 * bureau-level facts with no owning per-run surface (scheduled fires are
 * headless; see `runtime-composition.ts`'s `buildScheduledRunServices`).
 * `schedule.created` reaches this emitter differently from the other five:
 * `bureau.schedules.create` passes this bureau's own `emitter` into
 * `createAgentScheduler`, so `createAgentSchedule` (AB-298) dispatches
 * directly onto it, rather than `create-bureau.ts` dispatching a second copy
 * itself the way `pauseSchedule`/`resumeSchedule`/`cancelSchedule` do.
 *
 * `session.deleted` (`SessionDeletedEvent`, AB-228) is the same shape of
 * bureau-level fact: `deleteSession` dispatches it directly onto this
 * emitter once a live session is actually deleted, with no owning per-run
 * surface to carry it — see `create-bureau.ts`'s `deleteSession` and
 * `audit-trail.ts`'s dedicated `sessionDeletedListener` for the durable
 * write this closes.
 *
 * `session.created`/`session.saved` (`SessionCreatedEvent`/
 * `SessionSavedEvent`, AB-384) reach this emitter differently again:
 * `@lostgradient/operative`'s `SessionStore` dispatches them on its OWN
 * `events` target as `save()`/`update()` commits succeed, and
 * `create-bureau.ts` forwards each onto this bureau-level emitter (fresh
 * instances, the same forwarding shape `scheduleFireEvents` above uses) —
 * see `durable-event-history.ts`'s dedicated `sessionCreatedListener`/
 * `sessionSavedListener` for the durable write this makes possible.
 */
export interface BureauEventMap extends EventMap {
  [ActionEvent.type]: ActionEvent;
  /** A guardrail halted a run (COR-2096). */
  [RunTripwireRecordedEvent.type]: RunTripwireRecordedEvent;
  /** A validate-mode guardrail acted on a step (COR-2096). */
  [RunGuardrailRecordedEvent.type]: RunGuardrailRecordedEvent;
  /** A run's spend crossed a budget fraction (COR-2096). */
  [BudgetThresholdRecordedEvent.type]: BudgetThresholdRecordedEvent;
  /** A tool call was refused by a policy (COR-2096). */
  [ToolPolicyDeniedRecordedEvent.type]: ToolPolicyDeniedRecordedEvent;
  /** A tool call failed (COR-2096). */
  [ToolErrorRecordedEvent.type]: ToolErrorRecordedEvent;
  /** A run dispatched a child run (COR-2097). */
  [ChildWorkflowStartedRecordedEvent.type]: ChildWorkflowStartedRecordedEvent;
  /** A child run ended cleanly (COR-2097). */
  [ChildWorkflowCompletedRecordedEvent.type]: ChildWorkflowCompletedRecordedEvent;
  /** A child run ended in a failure (COR-2097). */
  [ChildWorkflowFailedRecordedEvent.type]: ChildWorkflowFailedRecordedEvent;
  /** A child run was aborted (COR-2097). */
  [ChildWorkflowAbortedRecordedEvent.type]: ChildWorkflowAbortedRecordedEvent;
  /** A handoff tool transferred a run to another agent (COR-2097). */
  [HandoffOccurredRecordedEvent.type]: HandoffOccurredRecordedEvent;
  /** Accepted steering commands were applied (COR-2097). */
  [SteeringAppliedRecordedEvent.type]: SteeringAppliedRecordedEvent;
  /** A hook of a run's plan threw (COR-2097). */
  [HookPlanFailedRecordedEvent.type]: HookPlanFailedRecordedEvent;
  [RunRegisteredEvent.type]: RunRegisteredEvent;
  [RunSettledEvent.type]: RunSettledEvent;
  /** A run ended without failing and without being aborted (COR-2095). */
  [RunCompletedOutcomeEvent.type]: RunCompletedOutcomeEvent;
  /** A run failed (COR-2095). */
  [RunFailedOutcomeEvent.type]: RunFailedOutcomeEvent;
  /** A run was aborted (COR-2095). */
  [RunAbortedOutcomeEvent.type]: RunAbortedOutcomeEvent;
  [RunRemovedEvent.type]: RunRemovedEvent;
  [RunAbortSettledEvent.type]: RunAbortSettledEvent;
  [BureauDisposedEvent.type]: BureauDisposedEvent;
  [RecoveryAttemptedEvent.type]: RecoveryAttemptedEvent;
  [RecoveryRejectedEvent.type]: RecoveryRejectedEvent;
  [RecoveryLeaseReleasedEvent.type]: RecoveryLeaseReleasedEvent;
  'schedule.created': AgentScheduledEvent;
  'schedule.paused': SchedulePausedEvent;
  'schedule.resumed': ScheduleResumedEvent;
  'schedule.cancelled': ScheduleCancelledEvent;
  'schedule.failed': ScheduleFailedEvent;
  'schedule.completed': ScheduleCompletedEvent;
  'schedule.attempted': ScheduleAttemptedEvent;
  'schedule.skipped': ScheduleSkippedEvent;
  // Skill lifecycle (COR-767), dispatched by the `@lostgradient/bureau/skills` tools and
  // forwarded onto this emitter by `create-bureau.ts`.
  'skill.loaded': SkillLoadedEvent;
  'skill.activated': SkillActivatedEvent;
  'skill.deactivated': SkillDeactivatedEvent;
  'skill.rejected': SkillRejectedEvent;
  'skill.failed': SkillFailedEvent;
  'session.created': SessionCreatedEvent;
  'session.saved': SessionSavedEvent;
  'session.deleted': SessionDeletedEvent;
  /** A session was tainted for the first time (COR-2105). */
  [SessionTaintEvent.type]: SessionTaintEvent;
  [ReviewRequestedEvent.type]: ReviewRequestedEvent;
  [ReviewApprovedEvent.type]: ReviewApprovedEvent;
  [ReviewDeniedEvent.type]: ReviewDeniedEvent;
  [ReviewRejectedEvent.type]: ReviewRejectedEvent;
  [ReviewExpiredEvent.type]: ReviewExpiredEvent;
  [ReviewRevokedEvent.type]: ReviewRevokedEvent;
  [ReviewCanceledEvent.type]: ReviewCanceledEvent;
  [ReviewSupersededEvent.type]: ReviewSupersededEvent;
  /** AB-68. The `accepted` transition: the one steering transition Bureau's own admission verb produces. */
  'steering.accepted': SteeringAcceptedEvent;
  /** COR-2097. A command was refused at admission, with the gate's own reason. */
  [SteeringCommandRejectedEvent.type]: SteeringCommandRejectedEvent;
  /** COR-2097. An accepted command was replaced by a later one for the same target. */
  [SteeringCommandSupersededEvent.type]: SteeringCommandSupersededEvent;
  /** COR-2097. An accepted command could not be applied: its deadline passed or its run or session ended. */
  [SteeringCommandFailedEvent.type]: SteeringCommandFailedEvent;
  /**
   * COR-2097. A recovered run's checkpointed workflow version differs from the registered one: the
   * durable engine's own event, forwarded once the Bureau can announce it.
   */
  'workflow.version-mismatch': WorkflowVersionMismatchEvent;
  'goal.started': GoalLifecycleEvent;
  'goal.attempt.started': GoalLifecycleEvent;
  /** COR-1781 — an attempt's run finished and its validator started. Live only: never in the goal's history. */
  'goal.attempt.evaluating': GoalLifecycleEvent;
  'goal.attempt.validated': GoalLifecycleEvent;
  /** COR-2097 — a failing verdict's feedback was recorded, as a digest. Live only. */
  'goal.feedback.recorded': GoalLifecycleEvent;
  /** COR-2097 — a failed attempt will be followed by another. Live only. */
  'goal.retrying': GoalLifecycleEvent;
  'goal.succeeded': GoalLifecycleEvent;
  'goal.exhausted': GoalLifecycleEvent;
  'goal.canceled': GoalLifecycleEvent;
  'goal.failed': GoalLifecycleEvent;
  'goal.recovered': GoalLifecycleEvent;
  'asset.upload.started': AssetLifecycleEvent;
  'asset.upload.purged': AssetLifecycleEvent;
  'asset.blob.purged': AssetLifecycleEvent;
  'asset.expired': AssetLifecycleEvent;
  [DefinitionsChangedEvent.type]: DefinitionsChangedEvent;
  /** COR-2250 — what a workflow file's contributed trigger did, and each fire's outcome. */
  'trigger.started': TriggerLifecycleEvent;
  'trigger.stopped': TriggerLifecycleEvent;
  'trigger.failed': TriggerLifecycleEvent;
  'trigger.fired': TriggerLifecycleEvent;
  [ScheduleMissedEvent.type]: ScheduleMissedEvent;
  [TaskCleanupAcknowledgedEvent.type]: TaskCleanupAcknowledgedEvent;
  /** A notification was written (COR-1941). */
  [NotificationCreatedEvent.type]: NotificationCreatedEvent;
  [DiagnosticEvent.type]: DiagnosticEvent;
  [MemoryGovernanceEvent.type]: MemoryGovernanceEvent;
  /** A decision was made and written to the audit trail (COR-2249). */
  [DecisionMadeEvent.type]: DecisionMadeEvent;
  /** A plugin's secret was stored, as the host reported it (COR-2098). */
  [PluginSecretSetEvent.type]: PluginSecretSetEvent;
  /** A plugin's secret was removed, as the host reported it (COR-2098). */
  [PluginSecretRemovedEvent.type]: PluginSecretRemovedEvent;
  /** A plugin's persisted choices were written, as the host reported it (COR-2098). */
  [PluginSettingsChangedEvent.type]: PluginSettingsChangedEvent;
  /** A plugin's status changed after a write, as the host reported it (COR-2098). */
  [PluginStatusChangedEvent.type]: PluginStatusChangedEvent;
  /** A scorer's score of a run breached the scorer's rule (COR-2251). */
  [ScorerThresholdBreachedEvent.type]: ScorerThresholdBreachedEvent;
}
