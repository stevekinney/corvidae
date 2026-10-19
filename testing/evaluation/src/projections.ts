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
 *   feedback is scrubbed of a held-out case's id, the expected answer,
 *   every reference material text, and every calibration example response,
 *   because a model judge's feedback may quote them verbatim.
 *
 * {@link toReviewerRunProjection} is the run part of the reviewer projection
 * on its own. A release gate records it for every trial as the evidence a
 * replay re-scores, and {@link fromReviewerRunProjection} rebuilds a run from
 * it that projects back to exactly the same JSON.
 *
 * A {@link TrialAggregate} is itself reviewer material: it keeps the case id,
 * every trial's unredacted feedback, and the typed errors. Its generator
 * projection is built from counts and criterion names alone, so no case id,
 * held-out status, or expected answer can reach the generator through it.
 */
import type {
  CostEstimate,
  FinishReason,
  JSONValue,
  RunResultBase,
  StepResult,
  TokenUsage,
} from '@lostgradient/operative';
import { deriveParts } from '@lostgradient/operative';
import { Conversation } from 'conversationalist';

import type { EvaluatorConfiguration } from './configuration';
import type { EvaluationCase } from './datasets';
import type { AggregateOutcome } from './disagreement';
import type { EvaluatorIdentity } from './identity';
import type { RubricResult } from './rubric';
import type { TrialAggregate } from './trials';
import type { CaseEvaluation, CaseVerdict, InfrastructureFailureReason } from './verdict';

export interface GeneratorProjection {
  readonly projection: 'generator';
  readonly verdict: CaseVerdict;
  readonly feedback: string;
  readonly failedHardCriteria: readonly string[];
}

/** The generator's view of repeated trials: an outcome, never a collapsed pass boolean. */
export interface AggregateGeneratorProjection {
  readonly projection: 'generator';
  readonly outcome: AggregateOutcome;
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
    // A public case's id is already known to the generator, and a short one
    // would redact unrelated words; only a held-out id is a secret.
    ...(evaluationCase.visibility === 'held-out' ? [evaluationCase.id] : []),
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

/** Names of every criterion whose hard gate failed in any scored trial, in configuration order. */
function failedHardCriteriaAcross(aggregate: TrialAggregate): string[] {
  const failed = new Set(
    aggregate.trials.flatMap((trial) =>
      trial.criteria
        .filter((criterion) => criterion.hardGate === 'failed')
        .map((criterion) => criterion.name),
    ),
  );
  return aggregate.statistics.criteria
    .map((criterion) => criterion.name)
    .filter((name) => failed.has(name));
}

function toAggregateGeneratorProjection(aggregate: TrialAggregate): AggregateGeneratorProjection {
  const { passes, trials } = aggregate.statistics.verdicts;
  const projection = { projection: 'generator', outcome: aggregate.outcome } as const;
  switch (aggregate.outcome) {
    case 'pass':
    case 'fail':
      return {
        ...projection,
        feedback: `${passes} of ${trials} trials passed.`,
        failedHardCriteria: failedHardCriteriaAcross(aggregate),
      };
    case 'disagreement':
      return {
        ...projection,
        feedback: `The evaluator’s trials disagreed: ${passes} of ${trials} passed. This is neither a pass nor a fail.`,
        failedHardCriteria: failedHardCriteriaAcross(aggregate),
      };
    case 'indeterminate':
      return {
        ...projection,
        feedback: 'The evaluator could not score every trial. This is not a verdict on the run.',
        failedHardCriteria: [],
      };
  }
}

export function toGeneratorProjection(evaluation: CaseEvaluation): GeneratorProjection;
export function toGeneratorProjection(aggregate: TrialAggregate): AggregateGeneratorProjection;
export function toGeneratorProjection(
  subject: CaseEvaluation | TrialAggregate,
): GeneratorProjection | AggregateGeneratorProjection {
  if ('outcome' in subject) return toAggregateGeneratorProjection(subject);
  return toCaseGeneratorProjection(subject);
}

function toCaseGeneratorProjection(evaluation: CaseEvaluation): GeneratorProjection {
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

/** The run facts of the reviewer projection: plain JSON a gate can record and a replay can rebuild from. */
export function toReviewerRunProjection(result: RunResultBase): ReviewerProjection['run'] {
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
    run: toReviewerRunProjection(evaluation.run),
    ...verdictFacts(evaluation),
  };
}

function rebuildError(description: ErrorDescription): Error {
  const error = new Error(description.message);
  error.name = description.name;
  return error;
}

/**
 * A run rebuilt from its reviewer projection, for scorers to re-score. It
 * carries exactly what the projection kept: the finish reason, the final
 * content, usage, cost, terminal error, schema validation, and every step's
 * content, tool calls, and tool results. Its conversation is empty, because
 * the projection never keeps one.
 */
export function fromReviewerRunProjection(run: ReviewerProjection['run']): RunResultBase {
  const conversation = new Conversation();
  const steps = run.trajectory.map((step, index): StepResult => ({
    step: step.step,
    conversation,
    content: step.content,
    // The projection keeps text only, so a step's parts are the one text part its content derives.
    parts: deriveParts(step.content),
    messageId: undefined,
    toolCalls: step.toolCalls.map(({ id, name, arguments: input }) => ({
      id,
      name,
      arguments: input,
    })),
    results: step.results.map(({ toolCallId, toolName, outcome, content }) => ({
      callId: toolCallId,
      toolCallId,
      toolName,
      outcome: outcome as StepResult['results'][number]['outcome'],
      content,
      result: content,
    })),
    final: index === run.trajectory.length - 1,
  }));
  const { error, costEstimate, schemaValidation } = run;
  return {
    conversation,
    steps,
    content: run.content,
    parts: steps.flatMap((step) => step.parts),
    usage: { ...run.usage },
    finishReason: run.finishReason,
    ...(error === undefined ? {} : { error: rebuildError(error) }),
    ...(costEstimate === undefined ? {} : { costEstimate }),
    ...(schemaValidation === undefined
      ? {}
      : {
          schemaValidation: {
            success: schemaValidation.success,
            ...(schemaValidation.error === undefined
              ? {}
              : { error: rebuildError(schemaValidation.error) }),
          },
        }),
  };
}
