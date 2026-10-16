/**
 * Rubric scoring: a weight-normalized total over every criterion, plus hard
 * per-criterion gates. A criterion with a `hardThreshold` whose score falls
 * below it fails the rubric regardless of the weighted total (COR-896,
 * "a `false` on a hard-threshold criterion fails the evaluator regardless of
 * weighted total"), so a heavily weighted set of perfect scores can never
 * paper over a single failed gate.
 */
import type { CriterionKind } from './configuration';

/** One criterion's score in `[0, 1]`, before the rubric applies its gates. */
export interface CriterionScore {
  readonly name: string;
  readonly kind: CriterionKind;
  readonly weight: number;
  readonly hardThreshold?: number | undefined;
  readonly score: number;
  readonly rationale: string;
}

export type HardGateOutcome = 'passed' | 'failed' | 'not-applicable';

export interface CriterionResult extends CriterionScore {
  readonly hardGate: HardGateOutcome;
}

export interface RubricResult {
  readonly criteria: readonly CriterionResult[];
  /** `Σ(weight × score) / Σ weight`, in `[0, 1]`. */
  readonly weightedTotal: number;
  readonly passThreshold: number;
  /** Names of every criterion whose score fell below its hard threshold, in rubric order. */
  readonly failedHardCriteria: readonly string[];
  /** True only when no hard gate failed and the weighted total reached the threshold. */
  readonly passed: boolean;
}

function hardGate(score: CriterionScore): HardGateOutcome {
  if (score.hardThreshold === undefined) return 'not-applicable';
  return score.score >= score.hardThreshold ? 'passed' : 'failed';
}

export function applyRubric(
  scores: readonly CriterionScore[],
  passThreshold: number,
): RubricResult {
  const criteria = scores.map((score) => ({ ...score, hardGate: hardGate(score) }));
  const totalWeight = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  const weightedTotal =
    criteria.reduce((sum, criterion) => sum + criterion.weight * criterion.score, 0) / totalWeight;
  const failedHardCriteria = criteria
    .filter((criterion) => criterion.hardGate === 'failed')
    .map((criterion) => criterion.name);
  return {
    criteria,
    weightedTotal,
    passThreshold,
    failedHardCriteria,
    passed: failedHardCriteria.length === 0 && weightedTotal >= passThreshold,
  };
}
