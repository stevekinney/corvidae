/**
 * The case verdict union (COR-896, "Result classes"). Four outcomes, never
 * collapsed into one bit:
 *
 * - `pass`: the run reached `stop-condition` and the rubric passed.
 * - `fail`: the run reached `stop-condition` and the rubric failed. This and
 *   `agent-failed` are the only outcomes that describe the evaluated system.
 * - `agent-failed`: the run ended with any other finish reason, so no
 *   criterion is scored.
 * - `infrastructure-failure`: the evaluator's own machinery (a judge or a
 *   scorer) threw, timed out, or returned output that failed its schema. It
 *   carries a typed {@link EvaluatorInfrastructureError}; it is never scored
 *   as a failing case and never retried into a pass.
 *
 * Aggregate-level `disagreement` belongs to the repeated-trial slice.
 */
import type { FinishReason, RunResultBase } from '@lostgradient/operative';

import type { EvaluatorConfiguration } from './configuration';
import type { EvaluationCase } from './dataset';
import type { EvaluatorIdentity } from './identity';
import type { RubricResult } from './rubric';

/**
 * The version of the {@link CaseEvaluation} shape this package emits. A
 * configuration declaring any other `resultSchemaVersion` is rejected, so a
 * stored record's version always names the shape that decodes it.
 */
export const EVALUATION_RESULT_SCHEMA_VERSION = 1;

export type AgentFailureReason = Exclude<FinishReason, 'stop-condition'>;

export const AGENT_FAILURE_REASONS = [
  'maximum-steps',
  'aborted',
  'error',
  'elicitation-denied',
  'budget-exceeded',
  'tripwire',
] as const satisfies readonly AgentFailureReason[];
// Fails to compile if operative adds a finish reason this list does not name.
const AGENT_FAILURE_REASONS_ARE_EXHAUSTIVE: Exclude<
  AgentFailureReason,
  (typeof AGENT_FAILURE_REASONS)[number]
> extends never
  ? true
  : never = true;
void AGENT_FAILURE_REASONS_ARE_EXHAUSTIVE;

export function isAgentFailureReason(reason: FinishReason): reason is AgentFailureReason {
  return reason !== 'stop-condition';
}

export const INFRASTRUCTURE_FAILURE_REASONS = [
  'judge-error',
  'judge-malformed-output',
  'scorer-error',
  'scorer-malformed-output',
  'latency-budget-exceeded',
] as const;

export type InfrastructureFailureReason = (typeof INFRASTRUCTURE_FAILURE_REASONS)[number];

export interface EvaluatorInfrastructureErrorOptions {
  readonly reason: InfrastructureFailureReason;
  readonly message: string;
  /** The criterion being scored when the machinery failed, when there was one. */
  readonly criterion?: string | undefined;
  readonly cause?: unknown;
}

/** The evaluator could not produce a score. Distinct from any verdict about the evaluated run. */
export class EvaluatorInfrastructureError extends Error {
  override readonly name = 'EvaluatorInfrastructureError';
  readonly reason: InfrastructureFailureReason;
  readonly criterion: string | undefined;

  constructor(options: EvaluatorInfrastructureErrorOptions) {
    super(options.message, { cause: options.cause });
    this.reason = options.reason;
    this.criterion = options.criterion;
  }
}

/** Facts every case evaluation carries, whatever its verdict. */
export interface CaseEvaluationBase {
  readonly resultSchemaVersion: number;
  readonly evaluator: EvaluatorIdentity;
  readonly configuration: EvaluatorConfiguration;
  readonly evaluationCase: EvaluationCase;
  readonly run: RunResultBase;
}

export interface ScoredCaseEvaluation extends CaseEvaluationBase {
  readonly verdict: 'pass' | 'fail';
  readonly rubric: RubricResult;
  /** Feedback for the evaluated system. Projected through `toGeneratorProjection` before it leaves. */
  readonly feedback: string;
}

export interface AgentFailedCaseEvaluation extends CaseEvaluationBase {
  readonly verdict: 'agent-failed';
  readonly finishReason: AgentFailureReason;
}

export interface InfrastructureFailureCaseEvaluation extends CaseEvaluationBase {
  readonly verdict: 'infrastructure-failure';
  readonly error: EvaluatorInfrastructureError;
}

export type CaseEvaluation =
  ScoredCaseEvaluation | AgentFailedCaseEvaluation | InfrastructureFailureCaseEvaluation;

export type CaseVerdict = CaseEvaluation['verdict'];
