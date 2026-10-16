/**
 * The goal-controller evaluator adapter (COR-896, "How a goal controller
 * consumes evaluator evidence"; COR-638, "Validator contract"). A goal
 * controller hands the adapter one finished attempt's `RunResult` and gets
 * back a {@link GoalEvaluatorVerdict} it can act on directly. The verdict's
 * `kind` is exactly COR-638's `ValidatorOutcome` kind union, and an error's
 * `kind` is exactly its `ValidatorErrorKind`; `goal-adapter.test-d.ts` holds
 * both equalities at compile time. This package takes no dependency on any
 * goal-controller type: the coupling runs one way, through the verdict.
 *
 * One call runs the configured case through `runTrials`, the only case
 * executor, whose subject replays the attempt's result, so the attempt is
 * judged `repetitions` times and nothing is ever retried. The aggregate
 * outcome then maps without ever turning evaluator trouble into a pass:
 *
 * - `pass` and `fail` are the aggregate's own unanimous or policy-backed
 *   decision. A `fail` is retryable only when the configuration explicitly
 *   says so with `retryableOnFailure`, and never when a hard criterion the
 *   configuration marks non-retryable failed.
 * - `indeterminate` is evaluator disagreement: the trials ran but split past
 *   the variance policy, so there is no pass or fail to report.
 * - `error` is an evaluator infrastructure failure in any trial. Its kind
 *   comes from the first failure's typed reason.
 * - `unavailable` means the evaluator never started: it could not be loaded,
 *   or the configuration names a case or a non-retryable criterion the
 *   evaluator does not have.
 * - `canceled` means the goal controller aborted the call. The trial in
 *   flight finishes, no later trial scores the attempt, and nothing is
 *   recorded.
 *
 * Every verdict that ran to completion is backed by one `evaluation-run`
 * record appended to the history, and names it in `evidenceReference`. When
 * that record cannot be written, the verdict is an `error`: a verdict with
 * no durable evidence is never handed to a goal controller.
 *
 * `feedback` is what a goal controller may show the next attempt, so it is
 * exactly `toGeneratorProjection(aggregate).feedback`, which is built from
 * trial counts alone. No expected answer, reference material, held-out case
 * id, criterion weight, or judge identity can reach it. Error and
 * unavailable messages are built from typed reasons, criterion names, and
 * dataset identity for the same reason; the raw failure stays on `cause`.
 */
import {
  createDefaultRuntimeServices,
  type RunResultBase,
  type RuntimeServices,
} from '@lostgradient/operative';

import type { Evaluator } from './evaluator';
import { type EvaluationHistory, toEvaluationRunRecord } from './history';
import { toGeneratorProjection } from './projections';
import { runTrials, type TrialAggregate, type TrialSubject } from './trials';
import type { InfrastructureFailureReason } from './verdict';

/** COR-638's `ValidatorErrorKind`. */
export type GoalEvaluatorErrorKind = 'load' | 'contract' | 'execute' | 'timeout' | 'output';

export type GoalEvaluatorErrorCode =
  | InfrastructureFailureReason
  | 'evaluator-unloadable'
  | 'unknown-case'
  | 'not-a-hard-criterion'
  | 'history-unwritable';

/** Why the evaluator could not judge the attempt. Shaped like COR-638's `ValidatorError`. */
export interface GoalEvaluatorError {
  readonly kind: GoalEvaluatorErrorKind;
  readonly code: GoalEvaluatorErrorCode;
  /** Built from typed facts only, so it never quotes a protected string. */
  readonly message: string;
  /** The underlying failure, for a reviewer. Never generator material. */
  readonly cause?: unknown;
}

export type GoalEvaluatorVerdict =
  | {
      readonly kind: 'pass';
      readonly feedback: string;
      /** The id of the appended `evaluation-run` record. */
      readonly evidenceReference: string;
    }
  | {
      readonly kind: 'fail';
      readonly feedback: string;
      /** Hard criteria that failed in any trial, in configuration order. */
      readonly failedHardCriteria: readonly string[];
      readonly retryable: boolean;
      readonly evidenceReference: string;
    }
  | {
      readonly kind: 'error';
      readonly error: GoalEvaluatorError;
      /** Present when the failed evaluation's record was appended. */
      readonly evidenceReference?: string;
    }
  | {
      readonly kind: 'unavailable';
      readonly error: GoalEvaluatorError;
      readonly reason: string;
    }
  | { readonly kind: 'canceled' }
  | {
      readonly kind: 'indeterminate';
      readonly reason: string;
      readonly feedback: string;
      readonly evidenceReference: string;
    };

export interface GoalEvaluatorConfiguration {
  /**
   * Resolves the evaluator that judges each attempt, usually
   * `() => createEvaluator(options)`. It is called once per verdict, so a
   * caller that wants one evaluator for every attempt returns the same
   * promise each time. A rejection makes that verdict `unavailable`.
   */
  readonly loadEvaluator: () => Promise<Evaluator>;
  /** The case in the evaluator's dataset whose input and expected answer state the goal. */
  readonly caseId: string;
  /** Whether a `fail` may be retried. Required: there is no default retry. */
  readonly retryableOnFailure: boolean;
  /**
   * Hard criteria whose failure makes a `fail` non-retryable whatever
   * `retryableOnFailure` says. Each must name a criterion with a hard
   * threshold, or the evaluator is `unavailable`.
   */
  readonly nonRetryableCriteria: readonly string[];
}

export interface CreateGoalEvaluatorAdapterOptions {
  readonly configuration: GoalEvaluatorConfiguration;
  /** Where each completed evaluation is appended as its evidence. */
  readonly history: EvaluationHistory;
  /**
   * Draws trial seeds and record ids, and stamps and times each record.
   * Defaults to the real-globals runtime services.
   */
  readonly runtime?:
    Pick<RuntimeServices, 'clock' | 'identifiers' | 'monotonic' | 'random'> | undefined;
}

export interface GoalEvaluationOptions {
  /** Aborted by the goal controller to cancel this validation. */
  readonly signal: AbortSignal;
}

/** Judges one finished goal attempt. Resolves with a verdict; it never retries. */
export type GoalEvaluatorAdapter = (
  runResult: RunResultBase,
  options: GoalEvaluationOptions,
) => Promise<GoalEvaluatorVerdict>;

const ERROR_KINDS = {
  'judge-error': 'execute',
  'judge-malformed-output': 'output',
  'scorer-error': 'execute',
  'scorer-malformed-output': 'output',
  'latency-budget-exceeded': 'timeout',
  'subject-error': 'execute',
} as const satisfies Record<InfrastructureFailureReason, GoalEvaluatorErrorKind>;

const CANCELED: GoalEvaluatorVerdict = Object.freeze({ kind: 'canceled' });

function unavailable(error: GoalEvaluatorError): GoalEvaluatorVerdict {
  return { kind: 'unavailable', error, reason: error.message };
}

/** The contract violation that keeps `evaluator` from judging this goal, if any. */
function contractViolation(
  configuration: GoalEvaluatorConfiguration,
  evaluator: Evaluator,
): GoalEvaluatorError | undefined {
  const { dataset } = evaluator;
  if (!dataset.cases.some((entry) => entry.id === configuration.caseId)) {
    return {
      kind: 'contract',
      code: 'unknown-case',
      // The case may be held out, so the message names the dataset, never the case.
      message: `The goal names a case that is not in dataset "${dataset.id}" version "${dataset.version}".`,
    };
  }
  const { criteria, name } = evaluator.configuration;
  for (const criterion of configuration.nonRetryableCriteria) {
    const hard = criteria.some(
      (entry) => entry.name === criterion && entry.hardThreshold !== undefined,
    );
    if (!hard) {
      return {
        kind: 'contract',
        code: 'not-a-hard-criterion',
        message: `Criterion "${criterion}" is marked non-retryable but is not a hard criterion of evaluator "${name}".`,
      };
    }
  }
  return undefined;
}

/** A subject whose every run resolves with the attempt's result, until the goal controller aborts. */
function replay(runResult: RunResultBase, signal: AbortSignal): TrialSubject {
  return {
    run: () => ({
      result: async () => {
        signal.throwIfAborted();
        return runResult;
      },
    }),
  };
}

function trialError(aggregate: Extract<TrialAggregate, { outcome: 'indeterminate' }>) {
  const [first] = aggregate.errors;
  const { reason, criterion } = first!;
  const on = criterion === undefined ? '' : ` on criterion "${criterion}"`;
  return {
    kind: ERROR_KINDS[reason],
    code: reason,
    message: `The evaluator could not score ${aggregate.errors.length} of ${aggregate.repetitions} trials (first: ${reason}${on}). This is not a verdict on the attempt.`,
    cause: first,
  } satisfies GoalEvaluatorError;
}

function toVerdict(
  configuration: GoalEvaluatorConfiguration,
  aggregate: TrialAggregate,
  evidenceReference: string,
): GoalEvaluatorVerdict {
  const { feedback, failedHardCriteria } = toGeneratorProjection(aggregate);
  switch (aggregate.outcome) {
    case 'pass':
      return { kind: 'pass', feedback, evidenceReference };
    case 'fail': {
      const nonRetryable = new Set(configuration.nonRetryableCriteria);
      const retryable =
        configuration.retryableOnFailure &&
        !failedHardCriteria.some((criterion) => nonRetryable.has(criterion));
      return { kind: 'fail', feedback, failedHardCriteria, retryable, evidenceReference };
    }
    case 'disagreement':
      return {
        kind: 'indeterminate',
        reason: `The evaluator’s trials disagreed: ${aggregate.disagreement.reasons.join(', ')}.`,
        feedback,
        evidenceReference,
      };
    case 'indeterminate':
      return { kind: 'error', error: trialError(aggregate), evidenceReference };
  }
}

/**
 * Returns the adapter a goal controller calls once per finished attempt.
 * See the module documentation for how each verdict kind arises.
 */
export function createGoalEvaluatorAdapter(
  options: CreateGoalEvaluatorAdapterOptions,
): GoalEvaluatorAdapter {
  const { configuration, history } = options;
  const runtime = options.runtime ?? createDefaultRuntimeServices();

  return async (runResult, { signal }) => {
    if (signal.aborted) return CANCELED;
    let evaluator: Evaluator;
    try {
      evaluator = await configuration.loadEvaluator();
    } catch (cause) {
      return unavailable({
        kind: 'load',
        code: 'evaluator-unloadable',
        message: 'The evaluator could not be loaded.',
        cause,
      });
    }
    const violation = contractViolation(configuration, evaluator);
    if (violation !== undefined) return unavailable(violation);

    const startedAt = runtime.monotonic.now();
    const aggregate = await runTrials({
      evaluator,
      caseId: configuration.caseId,
      subject: () => replay(runResult, signal),
      runtime,
    });
    // Once the goal controller has aborted, nothing about this call is recorded.
    if (signal.aborted) return CANCELED;

    let evidenceReference: string;
    try {
      const record = toEvaluationRunRecord({
        id: runtime.identifiers.next('goal-evaluation'),
        recordedAt: runtime.clock.nowISO(),
        evaluator,
        aggregates: [aggregate],
        latencyMilliseconds: runtime.monotonic.now() - startedAt,
      });
      const appended = await history.append(record);
      evidenceReference = appended.record.id;
    } catch (cause) {
      return {
        kind: 'error',
        error: {
          kind: 'execute',
          code: 'history-unwritable',
          message:
            'The evaluation finished but its evidence could not be recorded, so it is not a verdict on the attempt.',
          cause,
        },
      };
    }
    return toVerdict(configuration, aggregate, evidenceReference);
  };
}
