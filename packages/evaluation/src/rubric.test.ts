import { describe, expect, test } from 'bun:test';

import { applyRubric, type CriterionScore } from './rubric';

function score(
  name: string,
  value: number,
  weight: number,
  hardThreshold?: number,
): CriterionScore {
  return {
    name,
    kind: 'heuristic',
    weight,
    score: value,
    rationale: `${name} scored ${value}`,
    ...(hardThreshold === undefined ? {} : { hardThreshold }),
  };
}

describe('applyRubric', () => {
  test('computes the weight-normalized total and passes at or above the threshold', () => {
    const rubric = applyRubric([score('a', 1, 3), score('b', 0.5, 1)], 0.875);
    expect(rubric.weightedTotal).toBe(0.875);
    expect(rubric.passThreshold).toBe(0.875);
    expect(rubric.passed).toBe(true);
    expect(rubric.failedHardCriteria).toEqual([]);
    expect(rubric.criteria.map((criterion) => criterion.hardGate)).toEqual([
      'not-applicable',
      'not-applicable',
    ]);
  });

  test('fails when the weighted total is below the threshold', () => {
    const rubric = applyRubric([score('a', 0.5, 1), score('b', 0.5, 1)], 0.6);
    expect(rubric.weightedTotal).toBe(0.5);
    expect(rubric.passed).toBe(false);
  });

  test('a failed hard-threshold criterion fails the rubric even when every other criterion scores 1.0', () => {
    const rubric = applyRubric(
      [score('a', 1, 10), score('b', 1, 10), score('gate', 0.9, 0.001, 1)],
      0.5,
    );
    expect(rubric.weightedTotal).toBeGreaterThan(0.99);
    expect(rubric.failedHardCriteria).toEqual(['gate']);
    expect(rubric.criteria.map((criterion) => criterion.hardGate)).toEqual([
      'not-applicable',
      'not-applicable',
      'failed',
    ]);
    expect(rubric.passed).toBe(false);
  });

  test('a criterion that meets its hard threshold exactly passes its gate', () => {
    const rubric = applyRubric([score('gate', 0.7, 1, 0.7)], 0.7);
    expect(rubric.criteria[0]?.hardGate).toBe('passed');
    expect(rubric.passed).toBe(true);
  });
});
