/**
 * The two inspection surfaces over a {@link CaseEvaluation}, following
 * `toRedactedRunResultSummary`'s discipline in `@lostgradient/operative`:
 * one broad projection for people who may see everything, and one narrow
 * projection that is safe to hand back to the evaluated system.
 *
 * - {@link toReviewerProjection} is for the human calibrator and the gate's
 *   own audit record. It carries every inspectable fact, including the
 *   configuration's protected prompt material, reference material, and the
 *   case's expected answer, as plain JSON.
 * - {@link toGeneratorProjection} is for the generator (the evaluated system,
 *   or any prompt fed back to it as retry context). It carries only the
 *   verdict, the feedback text, and the names of failing hard criteria. The
 *   feedback is scrubbed of the expected answer, every reference material
 *   text, and every calibration example response, because a model judge's
 *   feedback may quote them verbatim.
 */
import type {
  CostEstimate,
  FinishReason,
  JSONValue,
  RunResultBase,
  TokenUsage,
} from '@lostgradient/operative';

import type { EvaluatorConfiguration } from './configuration';
import type { EvaluationCase } from './dataset';
import type { EvaluatorIdentity } from './identity';
import type { RubricResult } from './rubric';
import type { CaseEvaluation, CaseVerdict, InfrastructureFailureReason } from './verdict';

export interface GeneratorProjection {
  readonly projection: 'generator';
  readonly verdict: CaseVerdict;
  readonly feedback: string;
  readonly failedHardCriteria: readonly string[];
}

export interface ErrorDescription {
  readonly name: string;
  readonly message: string;
}

export interface TrajectoryStep {
  readonly step: number;
  readonly content: string;
  readonly toolCalls: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments: JSONValue;
  }[];
  readonly results: readonly {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly outcome: string;
    readonly content: JSONValue;
  }[];
}

export interface ReviewerProjection {
  readonly projection: 'reviewer';
  readonly verdict: CaseVerdict;
  readonly resultSchemaVersion: number;
  readonly evaluator: EvaluatorIdentity;
  readonly configuration: EvaluatorConfiguration;
  readonly case: EvaluationCase;
  readonly run: {
    readonly finishReason: FinishReason;
    readonly content: string;
    readonly usage: TokenUsage;
    readonly trajectory: readonly TrajectoryStep[];
    readonly error?: ErrorDescription | undefined;
    readonly costEstimate?: CostEstimate | undefined;
    readonly schemaValidation?:
      { readonly success: boolean; readonly error?: ErrorDescription | undefined } | undefined;
  };
  readonly rubric?: RubricResult | undefined;
  readonly feedback?: string | undefined;
  readonly infrastructureError?:
    | {
        readonly reason: InfrastructureFailureReason;
        readonly message: string;
        readonly criterion?: string | undefined;
      }
    | undefined;
}

const REDACTED = '[redacted]';

function describeError(error: unknown): ErrorDescription {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: typeof error, message: String(error) };
}

/** The strings the generator must never see verbatim, longest first. */
function protectedTexts(evaluation: CaseEvaluation): string[] {
  const { configuration, evaluationCase } = evaluation;
  return [
    evaluationCase.expected,
    ...configuration.referenceMaterial.entries.map((entry) => entry.text),
    ...configuration.examples.map((example) => example.response),
  ]
    .filter((text) => text.length > 0)
    .toSorted((left, right) => right.length - left.length);
}

function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => redacted.split(secret).join(REDACTED), text);
}

export function toGeneratorProjection(evaluation: CaseEvaluation): GeneratorProjection {
  switch (evaluation.verdict) {
    case 'pass':
    case 'fail':
      return {
        projection: 'generator',
        verdict: evaluation.verdict,
        feedback: redact(evaluation.feedback, protectedTexts(evaluation)),
        failedHardCriteria: evaluation.rubric.failedHardCriteria,
      };
    case 'agent-failed':
      return {
        projection: 'generator',
        verdict: evaluation.verdict,
        feedback: `The run ended with finish reason "${evaluation.finishReason}" before its criteria could be scored.`,
        failedHardCriteria: [],
      };
    case 'infrastructure-failure':
      return {
        projection: 'generator',
        verdict: evaluation.verdict,
        feedback: 'The evaluator could not score this run. This is not a verdict on the run.',
        failedHardCriteria: [],
      };
  }
}

function projectTrajectory(result: RunResultBase): TrajectoryStep[] {
  return result.steps.map((step) => ({
    step: step.step,
    content: step.content,
    toolCalls: step.toolCalls.map(({ id, name, arguments: input }) => ({
      id,
      name,
      arguments: input,
    })),
    results: step.results.map(({ toolCallId, toolName, outcome, content }) => ({
      toolCallId,
      toolName,
      outcome,
      content,
    })),
  }));
}

function projectRun(result: RunResultBase): ReviewerProjection['run'] {
  const { schemaValidation } = result;
  return {
    finishReason: result.finishReason,
    content: result.content,
    usage: result.usage,
    trajectory: projectTrajectory(result),
    ...(result.error === undefined ? {} : { error: describeError(result.error) }),
    ...(result.costEstimate === undefined ? {} : { costEstimate: result.costEstimate }),
    ...(schemaValidation === undefined
      ? {}
      : {
          schemaValidation: {
            success: schemaValidation.success,
            ...(schemaValidation.error === undefined
              ? {}
              : { error: describeError(schemaValidation.error) }),
          },
        }),
  };
}

function verdictFacts(evaluation: CaseEvaluation): Partial<ReviewerProjection> {
  switch (evaluation.verdict) {
    case 'pass':
    case 'fail':
      return { rubric: evaluation.rubric, feedback: evaluation.feedback };
    case 'agent-failed':
      return {};
    case 'infrastructure-failure': {
      const { reason, message, criterion } = evaluation.error;
      return {
        infrastructureError: { reason, message, ...(criterion === undefined ? {} : { criterion }) },
      };
    }
  }
}

export function toReviewerProjection(evaluation: CaseEvaluation): ReviewerProjection {
  return {
    projection: 'reviewer',
    verdict: evaluation.verdict,
    resultSchemaVersion: evaluation.resultSchemaVersion,
    evaluator: evaluation.evaluator,
    configuration: evaluation.configuration,
    case: evaluation.evaluationCase,
    run: projectRun(evaluation.run),
    ...verdictFacts(evaluation),
  };
}
