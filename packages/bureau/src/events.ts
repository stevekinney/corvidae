import type { EventMap } from '@lostgradient/lifecycle';
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
} from '@lostgradient/operative';
import type {
  SkillActivatedEvent,
  SkillDeactivatedEvent,
  SkillFailedEvent,
  SkillLoadedEvent,
  SkillRejectedEvent,
} from './skills';
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
 * Fired after a task's terminal state is committed to the task registry.
 * Unlike {@link RunRemovedEvent}, this does not mean that the run was deleted.
 */
export class RunSettledEvent extends Event {
  static readonly type = 'run.settled' as const;

  readonly runId: string;

  constructor(runId: string) {
    super(RunSettledEvent.type);
    this.runId = runId;
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
 * above is a local literal union rather than re-exported from `types.ts`.
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

/** The goal transitions the goal event projection records, each dispatched live as a {@link GoalLifecycleEvent}. */
export type GoalEventKind =
  | 'goal.started'
  | 'goal.attempt.started'
  | 'goal.attempt.validated'
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
  'goal.attempt.validated': [
    'goalRunId',
    'attemptId',
    'validatorIdentity',
    'outcomeKind',
    'feedbackDigest',
  ],
  'goal.succeeded': ['goalRunId', 'terminalReason'],
  'goal.exhausted': ['goalRunId', 'terminalReason'],
  'goal.canceled': ['goalRunId', 'terminalReason'],
  'goal.failed': ['goalRunId', 'terminalReason', 'validatorError'],
  'goal.recovered': ['goalRunId', 'controllerRestarts', 'status', 'transitionSeq'],
};

/** Every goal event kind, in the order a goal's history can hold them. */
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
 * a counted controller restart. Live observations only: the boot pass that re-projects every goal
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
      const value =
        field === 'validatorError' ? validatorErrorFields(recorded[field]) : recorded[field];
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

/** Which file catalog a {@link DefinitionsChangedEvent} reports on. */
export type DefinitionSourceKind = 'agents' | 'workflows';

/**
 * Fired on the bureau emitter after a rescan of the agent or workflow files changed what the
 * catalog holds (COR-1721), with the same identifiers its `onChange` listeners receive. `rejected`
 * names those of `added` and `changed` whose definition is invalid now and cannot run.
 */
export class DefinitionsChangedEvent extends Event {
  static readonly type = 'definitions.changed' as const;

  readonly source: DefinitionSourceKind;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly rejected: readonly string[];

  constructor(
    source: DefinitionSourceKind,
    change: {
      readonly added: readonly string[];
      readonly changed: readonly string[];
      readonly removed: readonly string[];
      readonly rejected: readonly string[];
    },
  ) {
    super(DefinitionsChangedEvent.type);
    this.source = source;
    this.added = [...change.added];
    this.changed = [...change.changed];
    this.removed = [...change.removed];
    this.rejected = [...change.rejected];
  }
}

/**
 * Fired on the bureau emitter when the durable engine reports that one of this Bureau's schedules
 * skipped occurrences it was too late for (COR-1721), copied from Weft's `ScheduleMissedFireEvent`.
 * Dispatched only when `bureau.schedules.get(scheduleId)` still returns the schedule, so it arrives
 * a turn after the engine's own event.
 */
export class ScheduleMissedEvent extends Event {
  static readonly type = 'schedule.missed' as const;

  readonly scheduleId: string;
  readonly missedCount: number;
  readonly windowStart: number;
  readonly windowEnd: number;

  constructor(scheduleId: string, missedCount: number, windowStart: number, windowEnd: number) {
    super(ScheduleMissedEvent.type);
    this.scheduleId = scheduleId;
    this.missedCount = missedCount;
    this.windowStart = windowStart;
    this.windowEnd = windowEnd;
  }
}

/**
 * Fired on the bureau emitter once a task's cleanup acknowledgement has been written to its record
 * (COR-1721). `cleanup` is the state `bureau.tasks.get(taskId).cleanup` now reads: `cleaned-up`,
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
  [RunRegisteredEvent.type]: RunRegisteredEvent;
  [RunSettledEvent.type]: RunSettledEvent;
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
  [ReviewRequestedEvent.type]: ReviewRequestedEvent;
  [ReviewApprovedEvent.type]: ReviewApprovedEvent;
  [ReviewDeniedEvent.type]: ReviewDeniedEvent;
  [ReviewRejectedEvent.type]: ReviewRejectedEvent;
  [ReviewExpiredEvent.type]: ReviewExpiredEvent;
  [ReviewRevokedEvent.type]: ReviewRevokedEvent;
  [ReviewCanceledEvent.type]: ReviewCanceledEvent;
  [ReviewSupersededEvent.type]: ReviewSupersededEvent;
  /**
   * AB-68. Only the `accepted` transition appears here: it is the one
   * steering transition Bureau's own admission verb produces. The
   * `rejected`/`superseded`/`failed` events are `accepted → X` transitions
   * owned by the gate's post-admission state machine, and `applied` is
   * dispatched by `runStep` onto the run emitter, not this one.
   */
  'steering.accepted': SteeringAcceptedEvent;
  'goal.started': GoalLifecycleEvent;
  'goal.attempt.started': GoalLifecycleEvent;
  'goal.attempt.validated': GoalLifecycleEvent;
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
  [ScheduleMissedEvent.type]: ScheduleMissedEvent;
  [TaskCleanupAcknowledgedEvent.type]: TaskCleanupAcknowledgedEvent;
  [DiagnosticEvent.type]: DiagnosticEvent;
}
