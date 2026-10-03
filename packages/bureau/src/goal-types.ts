/**
 * COR-851 — the public contract of `bureau.goals`, and the narrow engine view
 * its implementation files share.
 *
 * A Bureau goal is durable: its record (`GoalState`) lives in Bureau's key-value
 * store, its controller is a Weft workflow, and each attempt is a durable
 * catalog run. `bureau.goals` is the control plane over that record. Every
 * method resolves rather than throws for an outcome a caller can act on, and a
 * principal that does not own a goal reads exactly as a goal that does not
 * exist.
 */

import type {
  CleanupAcknowledgement,
  GoalBudget,
  GoalConversationPolicy,
  GoalIdentity,
  GoalRetryPolicy,
  GoalRunStatus,
  ValidatorIdentity,
} from '@lostgradient/operative';
import type { RegistryAgnosticEngine } from '@lostgradient/weft';

import type { GoalState } from './goal-state';

/** The slice of the durable engine the goal control plane drives. */
export type GoalEngine = Pick<
  RegistryAgnosticEngine,
  'get' | 'start' | 'signal' | 'cancel' | 'resume' | 'getHandle' | 'getFinalizerStatus'
>;

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface BureauGoalRequest<TName extends string = string> {
  /** The catalog agent that runs each attempt. It must be able to run durably. */
  readonly agentName: TName;
  readonly prompt: string;
  /** Stored with the objective. The `fresh-from-artifact` policy seeds each fresh conversation with it, and requires it. */
  readonly instructions?: string | undefined;
  readonly identity: GoalIdentity;
  /** Resolved from `BureauOptions.validators` by exact name and version. */
  readonly validator: ValidatorIdentity;
  readonly bounds: GoalBudget;
  /**
   * Defaults to `{ kind: 'continue' }`. Each policy keeps the goal's
   * conversation in the bureau's session store, so it survives a restart:
   *
   * - `continue`: every attempt runs in one session, and a retry's turn is the
   *   validator's feedback appended to the transcript.
   * - `fork-from-baseline`: attempt 0 runs in the goal's session and every retry
   *   runs in a fork of it through `throughRun`. A goal has no session before
   *   its first attempt, so the run a retry can fork through is run 0 and
   *   `create` rejects any other `throughRun` as `invalid-configuration`.
   * - `fresh-from-artifact`: every retry starts a new conversation from
   *   `instructions` and the validated handoff artifact, with no transcript.
   */
  readonly conversationPolicy?: GoalConversationPolicy | undefined;
  readonly retryPolicy?: GoalRetryPolicy | undefined;
  readonly validatorTimeoutMs?: number | undefined;
  readonly requireDeterministicValidation?: boolean | undefined;
  /** The principal that owns the goal; every later call is checked against it. */
  readonly principal?: string | undefined;
  /**
   * Makes `create` idempotent: the same request under the same id answers
   * `existing`, a different one answers `conflict`. Minted when omitted.
   */
  readonly goalRunId?: string | undefined;
}

export type BureauGoalCreateRejectionCode =
  /** No durable engine: a goal that could not survive a restart is never created. */
  | 'durable-unavailable'
  | 'shutdown'
  | 'agent-not-found'
  /** The agent has no durable resolver, so an attempt could not be recovered. */
  | 'agent-not-durable'
  | 'validator-missing'
  | 'validator-version-mismatch'
  /**
   * COR-638's budget, retry-policy, or conversation-policy rules refused the
   * request, or a `fresh-from-artifact` artifact failed COR-894's validation
   * (including that `BureauOptions.resolveFreshAttemptSource` cannot vouch for it).
   */
  | 'invalid-configuration'
  /**
   * The goal id cannot name the workflows and signals a goal is made of: it is
   * empty, it has a control character, or an identifier derived from it would pass Weft's
   * 128-byte limit (an over-long signal id is never delivered, so the goal
   * would wait forever).
   */
  | 'invalid-goal-run-id'
  | 'objective-too-large'
  /** The record stored under this id cannot be read. */
  | 'record-unreadable';

/** How the goal's controller workflow stood once `create` returned. */
export type BureauGoalControllerStart =
  | { readonly status: 'started' }
  /** The record exists but its workflow did not start; `recover()` starts it. */
  | { readonly status: 'start-failed'; readonly reason: string }
  /** The goal ended at creation (`unsupported-validation`), so there is no controller. */
  | { readonly status: 'not-needed' };

export type BureauGoalCreateOutcome =
  | {
      readonly outcome: 'created';
      readonly goal: GoalState;
      readonly controller: BureauGoalControllerStart;
    }
  /**
   * The id already names this exact request. Nothing was written, but a goal
   * that is not terminal is made sure to have its controller (a create that
   * died between recording the goal and starting it is healed by repeating
   * it); `controller` says how that stood.
   */
  | {
      readonly outcome: 'existing';
      readonly goal: GoalState;
      readonly controller?: BureauGoalControllerStart | undefined;
    }
  /**
   * The id already names a different request. Nothing was written. `goal` is
   * present only for a caller who may read that goal: a different principal's
   * request learns that the id is taken and nothing else.
   */
  | { readonly outcome: 'conflict'; readonly goal?: GoalState | undefined }
  | {
      readonly outcome: 'rejected';
      readonly code: BureauGoalCreateRejectionCode;
      readonly reason: string;
      /** For `validator-version-mismatch`: the versions that are registered. */
      readonly availableVersions?: readonly string[];
    };

// ---------------------------------------------------------------------------
// get, list, active, close
// ---------------------------------------------------------------------------

export interface BureauGoalQuery {
  /** Omitted is a trusted, internal call. */
  readonly principal?: string | undefined;
}

export interface BureauGoalListOptions extends BureauGoalQuery {
  readonly status?: GoalRunStatus | readonly GoalRunStatus[] | undefined;
}

/** The work a goal has in flight right now. */
export type BureauGoalActiveWork =
  | {
      readonly kind: 'attempt';
      readonly attemptId: string;
      readonly attemptIndex: number;
      /** The durable run that is the attempt; inspect it with `getDurableRun`. */
      readonly runId: string;
      readonly startedAt: string;
      /** The run's own workflow status, read now; `null` when it has no workflow. */
      readonly runStatus: string | null;
    }
  | {
      readonly kind: 'validation';
      readonly attemptId: string;
      readonly attemptIndex: number;
      readonly validator: ValidatorIdentity;
      readonly startedAt: string;
    };

export type BureauGoalCloseOutcome =
  /**
   * `closedAt` is set. The goal record and its workflow stay inspectable.
   * `cleanup` is the truthful result of applying the bureau's checkpoint
   * retention to the controller workflow's history: `not-required` when the
   * policy keeps everything or the goal never had a controller, `completed`
   * once pruned, and `unresolved` or `failed` when it could not be, which
   * `close()` again retries.
   */
  | {
      readonly outcome: 'closed';
      readonly goal: GoalState;
      readonly cleanup: CleanupAcknowledgement;
    }
  | { readonly outcome: 'not-terminal'; readonly goal: GoalState }
  /** Lost the write to concurrent writers too many times in a row; call again. */
  | { readonly outcome: 'contended'; readonly goal: GoalState }
  | { readonly outcome: 'not-found' };

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

export interface BureauGoalCancelOptions extends BureauGoalQuery {
  readonly reason?: string | undefined;
}

/** What `cancel()` could not yet read back as finished. */
export type BureauGoalCancellationWait =
  /** The goal record is not yet `canceled`. */
  | 'goal-record'
  /** The controller workflow has not reached a terminal status. */
  | 'controller'
  /** The controller's finalizer is pending or running, or its status could not be read. */
  | 'finalizer'
  /**
   * The controller's finalizer failed and the engine dead-lettered it, so it
   * will not be retried and waiting will not settle it. The goal is still
   * `canceled` and never reads as done: whatever the finalizer was to stop
   * (the active attempt's run) may be running and needs an operator.
   */
  | 'finalizer-failed'
  /** The in-flight attempt's run has not reached a terminal status. */
  | 'attempt-run';

/**
 * What a `cancel()` outcome means. It is an answer about durable state read
 * back after the request, never about a request merely having been sent.
 *
 * - `canceled`: a fresh read, taken after `engine.cancel` settled and the
 *   attempt was stopped, found the goal record `canceled`, the controller
 *   workflow terminal, its finalizer `succeeded` or not owed (a controller that
 *   ended on its own staged nothing to finalize), and the in-flight attempt's
 *   run terminal or absent. Nothing else is answered `canceled`.
 * - `cancellation-pending`: the cancellation marker is durably recorded, so the
 *   goal will end `canceled` and no controller transition can overtake it, but
 *   the read-back found something in `awaiting` still unfinished. `finalizer`
 *   (pending, running, or unreadable), `controller`, `attempt-run`, and
 *   `goal-record` are in progress: call `recover()` or `cancel()` again; both
 *   are idempotent. `finalizer-failed` is different: the engine dead-lettered
 *   the finalizer and will not retry it, so repeating `cancel()` re-reads the
 *   same failure and it is also written to the diagnostics. It is reported
 *   rather than hidden, and is never answered `canceled`.
 * - `already-terminal`: the goal had already ended for a reason other than
 *   cancellation; nothing was changed. A goal that ended `canceled` is never
 *   answered this way: its controller and attempt run are stopped again and
 *   read back, so a retry after `cancellation-pending` finishes the job and
 *   answers `canceled` or `cancellation-pending` like the first call did.
 * - `contended`: the marker could not be written because concurrent writers
 *   won the compare-and-swap every time the store retried. Nothing was
 *   recorded and nothing will cancel the goal; call `cancel()` again.
 * - `not-found`: no such goal, or one this principal does not own.
 *
 * What `canceled` does not say: a validator that was executing when the goal
 * was canceled is not told to stop. Durable validation runs with a signal that
 * never aborts (a shutdown is a crash for the next process to recover, not a
 * verdict), so it runs to completion and its verdict is discarded, because the
 * record accepts no transition but `canceled` once the marker is set. A
 * validator with side effects must therefore tolerate being run to completion.
 */
export type BureauGoalCancelOutcome =
  | { readonly outcome: 'canceled'; readonly goal: GoalState }
  | {
      readonly outcome: 'cancellation-pending';
      readonly goal: GoalState;
      readonly awaiting: readonly BureauGoalCancellationWait[];
    }
  | { readonly outcome: 'already-terminal'; readonly goal: GoalState }
  | { readonly outcome: 'contended'; readonly goal: GoalState }
  | { readonly outcome: 'not-found' };

// ---------------------------------------------------------------------------
// recover
// ---------------------------------------------------------------------------

/**
 * What recovery did for one goal.
 *
 * - `started`: no controller workflow existed (a crash between writing the
 *   record and starting it), so one was started.
 * - `restarted`: the controller ended abnormally while the goal was not
 *   terminal, so a new one was started from the record and `controllerRestarts`
 *   advanced.
 * - `running`: a controller is alive, under this engine or another; recovery
 *   only reconciled the attempt behind it.
 * - `canceled`: an operator's cancellation (or an engine-level cancel of the
 *   controller) was completed by committing `canceled`, and a fresh read found
 *   the controller and the attempt's run terminal.
 * - `cancellation-pending`: `canceled` was committed, but the read found the
 *   controller, its finalizer, or the attempt's run not yet terminal (see
 *   `detail`); `cancel()` or `recover()` again finishes it.
 * - `unsupported-validation`: the goal had not started, and its validator cannot
 *   supply the deterministic evidence it requires, so recovery ended it
 *   `failed`/`unsupported-validation` without starting a controller.
 * - `already-terminal`, `not-found`: nothing to do.
 * - `unrecoverable`: the controller has already been restarted the maximum
 *   number of times. The goal is left exactly as it is; no terminal reason is
 *   invented for it.
 */
export type BureauGoalRecoveryOutcome =
  | 'started'
  | 'restarted'
  | 'running'
  | 'canceled'
  | 'cancellation-pending'
  | 'unsupported-validation'
  | 'already-terminal'
  | 'not-found'
  | 'unrecoverable';

/** What recovery did about the attempt a `running` goal was waiting on. */
export type BureauGoalAttemptRecovery =
  /** The attempt's run is alive; its terminal signal will be forwarded when it ends. */
  | 'watching'
  /** The attempt's run had already ended, so its terminal signal was sent again. */
  | 'signal-resent'
  /** The attempt's run never started, so it was started now. */
  | 'run-started'
  /** The attempt's run could not be reconciled; see `detail`. */
  | 'failed';

export interface BureauGoalRecoveryEntry {
  readonly goalRunId: string;
  readonly outcome: BureauGoalRecoveryOutcome;
  readonly attempt?: BureauGoalAttemptRecovery | undefined;
  readonly detail?: string | undefined;
}

export interface BureauGoalRecoveryReport {
  readonly goals: readonly BureauGoalRecoveryEntry[];
  /** Goals recovery could not process at all. Never thrown. */
  readonly failures: readonly { readonly goalRunId: string; readonly reason: string }[];
}

// ---------------------------------------------------------------------------
// The control plane
// ---------------------------------------------------------------------------

export interface BureauGoals<TName extends string = string> {
  /**
   * Persists the goal, then starts its controller. The record is written
   * first, so a crash between the two is healed by `recover()` or by repeating
   * this call with the same id.
   */
  create(request: BureauGoalRequest<TName>): Promise<BureauGoalCreateOutcome>;
  get(goalRunId: string, query?: BureauGoalQuery): Promise<GoalState | undefined>;
  /** Terminal and closed goals are included. Oldest first. */
  list(options?: BureauGoalListOptions): Promise<GoalState[]>;
  /** The attempt run or validation execution in flight, or `undefined` when none is. */
  active(goalRunId: string, query?: BureauGoalQuery): Promise<BureauGoalActiveWork | undefined>;
  cancel(goalRunId: string, options?: BureauGoalCancelOptions): Promise<BureauGoalCancelOutcome>;
  /**
   * One goal when an id is named, otherwise the sweep over every goal that is
   * not terminal and that the principal may see (all of them when it is
   * omitted). Idempotent, and never throws.
   */
  recover(goalRunId?: string, query?: BureauGoalQuery): Promise<BureauGoalRecoveryReport>;
  /** Terminal goals only. Idempotent; each call re-applies the checkpoint retention. */
  close(goalRunId: string, query?: BureauGoalQuery): Promise<BureauGoalCloseOutcome>;
}
