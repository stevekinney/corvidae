/**
 * Per-kind criterion scoring. Each criterion in a configuration binds to
 * exactly one way of producing a score in `[0, 1]`:
 *
 * - `deterministic-assertion`: a caller-supplied predicate; `true` is 1 and
 *   `false` is 0. No model is in the loop.
 * - `heuristic`: a caller-supplied scoring function returning a number.
 * - `trajectory`: built in. It reads `RunResultBase.steps` and fails when a
 *   forbidden tool was called or a required tool never was, whatever the
 *   final `content` says.
 * - `policy`: a caller-supplied check that receives the `referenceMaterial`
 *   entry its criterion cites.
 * - `model-judge`: read from the case's single model-judge verdict.
 *
 * Scorers are code, so they live beside the configuration rather than in it;
 * {@link bindCriteria} rejects a configuration whose criteria and scorers do
 * not line up exactly. A scorer that throws or returns something other than
 * the score its kind promises is an evaluator infrastructure failure, never
 * a low score.
 */
import type { RunResultBase } from '@lostgradient/operative';

import type {
  ConfigurationIssue,
  CriterionConfiguration,
  EvaluatorConfiguration,
  ReferenceMaterialEntry,
} from './configuration';
import type { EvaluationCase } from './datasets';
import type { JudgeVerdict } from './judge';
import type { CriterionScore } from './rubric';
import { EvaluatorInfrastructureError } from './verdict';

/** What a scorer may inspect: the case (including its expected answer) and the completed run. */
export interface CriterionEvidence {
  readonly evaluationCase: EvaluationCase;
  readonly result: RunResultBase;
  /** Aborted when the evaluation exceeds its latency budget. */
  readonly signal: AbortSignal;
}

export interface PolicyEvidence extends CriterionEvidence {
  readonly reference: ReferenceMaterialEntry;
}

export type AssertionScorer = (evidence: CriterionEvidence) => boolean | Promise<boolean>;
export type HeuristicScorer = (evidence: CriterionEvidence) => number | Promise<number>;
export type PolicyScorer = (
  evidence: PolicyEvidence,
) => boolean | number | Promise<boolean | number>;

/** Caller-supplied scorers, keyed by the name of the criterion each one scores. */
export interface CriterionScorers {
  readonly assertions?: Readonly<Record<string, AssertionScorer>> | undefined;
  readonly heuristics?: Readonly<Record<string, HeuristicScorer>> | undefined;
  readonly policies?: Readonly<Record<string, PolicyScorer>> | undefined;
}

type ScorerGroup = keyof CriterionScorers;

const SCORER_GROUP_KINDS = {
  assertions: 'deterministic-assertion',
  heuristics: 'heuristic',
  policies: 'policy',
} as const satisfies Record<ScorerGroup, CriterionConfiguration['kind']>;

/** Everything one criterion's score may draw on while one case is scored. */
export interface ScoringContext {
  readonly evidence: CriterionEvidence;
  /**
   * The case's model-judge verdict. The evaluator calls the judge at most once
   * per case, and leaves this undefined when no generate function was injected.
   */
  readonly judge?: (() => Promise<JudgeVerdict>) | undefined;
}

export type CriterionBinding = (context: ScoringContext) => Promise<CriterionScore>;

/** Names of every tool the run called, across all of its steps, in call order. */
export function toolCallNames(result: RunResultBase): string[] {
  return result.steps.flatMap((step) => step.toolCalls.map((call) => call.name));
}

function criterionScore(
  criterion: CriterionConfiguration,
  score: number,
  rationale: string,
): CriterionScore {
  return {
    name: criterion.name,
    kind: criterion.kind,
    weight: criterion.weight,
    hardThreshold: criterion.hardThreshold,
    score,
    rationale,
  };
}

/** Which score shapes a caller scorer of a given kind may return. */
interface ScoreShape {
  readonly boolean: boolean;
  readonly number: boolean;
}

const ASSERTION_SHAPE: ScoreShape = { boolean: true, number: false };
const HEURISTIC_SHAPE: ScoreShape = { boolean: false, number: true };
const POLICY_SHAPE: ScoreShape = { boolean: true, number: true };

function toUnitScore(criterion: CriterionConfiguration, value: unknown, shape: ScoreShape): number {
  if (shape.boolean && typeof value === 'boolean') return value ? 1 : 0;
  if (shape.number && typeof value === 'number' && value >= 0 && value <= 1) return value;
  throw new EvaluatorInfrastructureError({
    reason: 'scorer-malformed-output',
    message: `Scorer for criterion "${criterion.name}" returned ${String(value)}, which is not a ${criterion.kind} score`,
    criterion: criterion.name,
  });
}

/** Binds a caller-supplied scorer, typing its throws and malformed returns as infrastructure failures. */
function callerBinding(
  criterion: CriterionConfiguration,
  shape: ScoreShape,
  scorer: (evidence: CriterionEvidence) => unknown,
  rationale: (score: number) => string,
): CriterionBinding {
  return async ({ evidence }) => {
    let value: unknown;
    try {
      value = await scorer(evidence);
    } catch (cause) {
      throw new EvaluatorInfrastructureError({
        reason: 'scorer-error',
        message: `Scorer for criterion "${criterion.name}" threw`,
        criterion: criterion.name,
        cause,
      });
    }
    const score = toUnitScore(criterion, value, shape);
    return criterionScore(criterion, score, rationale(score));
  };
}

function trajectoryBinding(
  criterion: Extract<CriterionConfiguration, { kind: 'trajectory' }>,
): CriterionBinding {
  return async ({ evidence }) => {
    const called = new Set(toolCallNames(evidence.result));
    const forbidden = criterion.forbiddenTools.filter((tool) => called.has(tool));
    const missing = criterion.requiredTools.filter((tool) => !called.has(tool));
    const violations = [
      ...(forbidden.length > 0 ? [`Called forbidden tools: ${forbidden.join(', ')}.`] : []),
      ...(missing.length > 0 ? [`Never called required tools: ${missing.join(', ')}.`] : []),
    ];
    return violations.length === 0
      ? criterionScore(criterion, 1, 'Tool trajectory satisfied its constraints.')
      : criterionScore(criterion, 0, violations.join(' '));
  };
}

function modelJudgeBinding(criterion: CriterionConfiguration): CriterionBinding {
  return async ({ judge }) => {
    if (judge === undefined) {
      throw new EvaluatorInfrastructureError({
        reason: 'judge-error',
        message: `No model judge is available to score criterion "${criterion.name}"`,
        criterion: criterion.name,
      });
    }
    const verdict = await judge();
    const judged = verdict.scores.get(criterion.name);
    if (judged === undefined) {
      throw new EvaluatorInfrastructureError({
        reason: 'judge-malformed-output',
        message: `Model judge returned no score for criterion "${criterion.name}"`,
        criterion: criterion.name,
      });
    }
    return criterionScore(criterion, judged.score, judged.rationale);
  };
}

function missingScorer(index: number, group: ScorerGroup, name: string): ConfigurationIssue {
  return {
    path: ['criteria', index],
    message: `No ${group} scorer is bound to criterion "${name}"`,
  };
}

/**
 * Binds every criterion to its scorer, in configuration order, and reports
 * each criterion without a scorer and each scorer without a matching
 * criterion of its kind.
 */
export function bindCriteria(
  configuration: EvaluatorConfiguration,
  scorers: CriterionScorers,
): {
  readonly bindings: readonly CriterionBinding[];
  readonly issues: readonly ConfigurationIssue[];
} {
  const bindings: CriterionBinding[] = [];
  const issues: ConfigurationIssue[] = [];
  for (const [index, criterion] of configuration.criteria.entries()) {
    switch (criterion.kind) {
      case 'deterministic-assertion': {
        const scorer = scorers.assertions?.[criterion.name];
        if (scorer === undefined) issues.push(missingScorer(index, 'assertions', criterion.name));
        else
          bindings.push(
            callerBinding(criterion, ASSERTION_SHAPE, scorer, (held) =>
              held === 1 ? 'Assertion held.' : 'Assertion did not hold.',
            ),
          );
        break;
      }
      case 'heuristic': {
        const scorer = scorers.heuristics?.[criterion.name];
        if (scorer === undefined) issues.push(missingScorer(index, 'heuristics', criterion.name));
        else
          bindings.push(
            callerBinding(
              criterion,
              HEURISTIC_SHAPE,
              scorer,
              (score) => `Heuristic scored ${score}.`,
            ),
          );
        break;
      }
      case 'trajectory':
        bindings.push(trajectoryBinding(criterion));
        break;
      case 'policy': {
        const scorer = scorers.policies?.[criterion.name];
        const reference = configuration.referenceMaterial.entries.find(
          (entry) => entry.id === criterion.referenceMaterialId,
        );
        if (reference === undefined) {
          issues.push({
            path: ['criteria', index, 'referenceMaterialId'],
            message: `Policy criterion cites unknown reference material "${criterion.referenceMaterialId}"`,
          });
        } else if (scorer === undefined) {
          issues.push(missingScorer(index, 'policies', criterion.name));
        } else {
          bindings.push(
            callerBinding(
              criterion,
              POLICY_SHAPE,
              (evidence) => scorer({ ...evidence, reference }),
              (score) => `Policy "${reference.id}" scored ${score}.`,
            ),
          );
        }
        break;
      }
      case 'model-judge':
        bindings.push(modelJudgeBinding(criterion));
        break;
    }
  }
  for (const group of Object.keys(SCORER_GROUP_KINDS) as ScorerGroup[]) {
    for (const name of Object.keys(scorers[group] ?? {})) {
      const bound = configuration.criteria.some(
        (criterion) => criterion.name === name && criterion.kind === SCORER_GROUP_KINDS[group],
      );
      if (!bound) {
        issues.push({
          path: ['scorers', group, name],
          message: `No ${SCORER_GROUP_KINDS[group]} criterion is named "${name}"`,
        });
      }
    }
  }
  return { bindings, issues };
}
