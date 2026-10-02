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
  /** Required by the `fresh-from-artifact` conversation policy. */
  readonly instructions?: string | undefined;
  readonly identity: GoalIdentity;
  /** Resolved from `BureauOptions.validators` by exact name and version. */
  readonly validator: ValidatorIdentity;
  readonly bounds: GoalBudget;
  /** Defaults to `{ kind: 'continue' }`. */
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
  /** COR-638's budget, retry-policy, or conversation-policy rules refused the request. */
  | 'invalid-configuration'
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
  /** The id already names this exact request. Nothing was written. */
  | { readonly outcome: 'existing'; readonly goal: GoalState }
  /** The id already names a different request. Nothing was written. */
  | { readonly outcome: 'conflict'; readonly goal: GoalState }
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
  /** `closedAt` is set. The goal record and its workflow stay inspectable. */
  | { readonly outcome: 'closed'; readonly goal: GoalState }
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
  /** The controller's finalizer is pending, running, or failed. */
  | 'finalizer'
  /** The in-flight attempt's run has not reached a terminal status. */
  | 'attempt-run';

/**
 * What a `cancel()` outcome means. It is an answer about durable state read
 * back after the request, never about a request merely having been sent.
 *
 * - `canceled`: a fresh read, taken after `engine.cancel` settled and the
 *   attempt was stopped, found the goal record `canceled`, the controller
 *   workflow terminal, its finalizer settled or not owed, and the in-flight
 *   attempt's run terminal or absent.
 * - `cancellation-pending`: the cancellation marker is durably recorded, so the
 *   goal will end `canceled` and no controller transition can overtake it, but
 *   the read-back found something in `awaiting` still unfinished. Call
 *   `recover()` or `cancel()` again; both are idempotent.
 * - `already-terminal`: the goal had already ended; nothing was changed.
 * - `not-found`: no such goal, or one this principal does not own.
 */
export type BureauGoalCancelOutcome =
  | { readonly outcome: 'canceled'; readonly goal: GoalState }
  | {
      readonly outcome: 'cancellation-pending';
      readonly goal: GoalState;
      readonly awaiting: readonly BureauGoalCancellationWait[];
    }
  | { readonly outcome: 'already-terminal'; readonly goal: GoalState }
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
 *   controller) was completed by committing `canceled`.
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
   * first, so a crash between the two is healed by `recover()`.
   */
  create(request: BureauGoalRequest<TName>): Promise<BureauGoalCreateOutcome>;
  get(goalRunId: string, query?: BureauGoalQuery): Promise<GoalState | undefined>;
  /** Terminal and closed goals are included. Oldest first. */
  list(options?: BureauGoalListOptions): Promise<GoalState[]>;
  /** The attempt run or validation execution in flight, or `undefined` when none is. */
  active(goalRunId: string, query?: BureauGoalQuery): Promise<BureauGoalActiveWork | undefined>;
  cancel(goalRunId: string, options?: BureauGoalCancelOptions): Promise<BureauGoalCancelOutcome>;
  /**
   * One goal when an id is named, otherwise the boot sweep over every goal that
   * is not terminal. Idempotent, and never throws.
   */
  recover(goalRunId?: string, query?: BureauGoalQuery): Promise<BureauGoalRecoveryReport>;
  /** Terminal goals only. */
  close(goalRunId: string, query?: BureauGoalQuery): Promise<BureauGoalCloseOutcome>;
}
