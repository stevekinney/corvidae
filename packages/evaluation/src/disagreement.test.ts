import { describe, expect, test } from 'bun:test';

import {
  type AggregateOutcome,
  decideTrials,
  type JudgedCase,
  reconcileJudges,
  type TrialVerdict,
} from './disagreement';
import type { VariancePolicy } from './variance';

function policy(minimumPassFraction: number, maximumIntervalWidth: number): VariancePolicy {
  return { name: 'test-policy', version: '1', minimumPassFraction, maximumIntervalWidth };
}

function verdicts(...sequence: TrialVerdict['verdict'][]): TrialVerdict[] {
  return sequence.map((verdict, index) => ({ trial: index + 1, verdict }));
}

function repeat(verdict: TrialVerdict['verdict'], count: number): TrialVerdict['verdict'][] {
  return Array.from({ length: count }, () => verdict);
}

describe('decideTrials', () => {
  test('passes unanimous passing trials and fails unanimous non-passing ones', () => {
    const lenient = policy(0.6, 0.75);
    expect(decideTrials(verdicts('pass', 'pass', 'pass'), lenient)).toEqual({ outcome: 'pass' });
    expect(decideTrials(verdicts('fail', 'agent-failed', 'fail'), lenient)).toEqual({
      outcome: 'fail',
    });
  });

  test('passes a split that clears both the minimum pass fraction and the interval width', () => {
    // 9 of 10: pass fraction 0.9, Wilson interval about 0.386 wide.
    const decision = decideTrials(verdicts(...repeat('pass', 9), 'fail'), policy(0.8, 0.4));
    expect(decision).toEqual({ outcome: 'pass' });
  });

  test('reports a split below the minimum pass fraction as disagreement, with no pass boolean', () => {
    // 2 of 5: pass fraction 0.4.
    const trials = verdicts('pass', 'fail', 'pass', 'agent-failed', 'fail');
    const decision = decideTrials(trials, policy(0.6, 1));
    expect(decision).toEqual({
      outcome: 'disagreement',
      disagreement: { reasons: ['below-minimum-pass-fraction'], breakdown: trials },
    });
    expect(decision).not.toHaveProperty('pass');
    expect(decision).not.toHaveProperty('passed');
  });

  test('reports a split whose interval is too wide as disagreement', () => {
    // 2 of 3: pass fraction 0.667 clears 0.6, but the interval is about 0.731 wide.
    const trials = verdicts('pass', 'fail', 'pass');
    expect(decideTrials(trials, policy(0.6, 0.7))).toEqual({
      outcome: 'disagreement',
      disagreement: { reasons: ['interval-too-wide'], breakdown: trials },
    });
  });

  test('reports every reason a split misses the policy', () => {
    const trials = verdicts('fail', 'pass', 'fail');
    const decision = decideTrials(trials, policy(0.6, 0.7));
    expect(decision.outcome).toBe('disagreement');
    if (decision.outcome !== 'disagreement') throw new Error('Expected disagreement');
    expect(decision.disagreement.reasons).toEqual([
      'below-minimum-pass-fraction',
      'interval-too-wide',
    ]);
  });

  test('without a variance policy, requires unanimity', () => {
    expect(decideTrials(verdicts('pass', 'pass'), undefined)).toEqual({ outcome: 'pass' });
    expect(decideTrials(verdicts('fail'), undefined)).toEqual({ outcome: 'fail' });
    const trials = verdicts(...repeat('pass', 9), 'fail');
    expect(decideTrials(trials, undefined)).toEqual({
      outcome: 'disagreement',
      disagreement: { reasons: ['split-without-variance-policy'], breakdown: trials },
    });
  });

  test('refuses to decide from no trials', () => {
    expect(() => decideTrials([], policy(0.5, 1))).toThrow(RangeError);
  });
});

describe('reconcileJudges', () => {
  function judged(digest: string, outcome: AggregateOutcome, overrides: Partial<JudgedCase> = {}) {
    return {
      evaluator: { name: `judge-${digest}`, revision: 1, digest },
      caseId: 'case-france',
      datasetVersion: 'capitals-2026-09',
      codeRevision: 'a7679370',
      outcome,
      ...overrides,
    };
  }

  test.each<AggregateOutcome>(['pass', 'fail'])(
    'keeps an outcome both judges reach: %s',
    (outcome) => {
      const reconciliation = reconcileJudges([judged('a', outcome), judged('b', outcome)]);
      expect(reconciliation).toEqual({
        caseId: 'case-france',
        outcome,
        judges: [
          { evaluator: judged('a', outcome).evaluator, outcome },
          { evaluator: judged('b', outcome).evaluator, outcome },
        ],
      });
    },
  );

  test('reports judges that reach different verdicts as disagreement, not pass or fail', () => {
    const reconciliation = reconcileJudges([judged('a', 'pass'), judged('b', 'fail')]);
    expect(reconciliation.outcome).toBe('disagreement');
    expect(reconciliation.judges.map((judge) => judge.outcome)).toEqual(['pass', 'fail']);
    expect(reconciliation).not.toHaveProperty('pass');
  });

  test('keeps one judge’s own disagreement', () => {
    expect(reconcileJudges([judged('a', 'pass'), judged('b', 'disagreement')]).outcome).toBe(
      'disagreement',
    );
  });

  test('is indeterminate when any judge could not score the case', () => {
    expect(
      reconcileJudges([judged('a', 'disagreement'), judged('b', 'indeterminate')]).outcome,
    ).toBe('indeterminate');
  });

  test.each<[string, JudgedCase[]]>([
    ['fewer than two judges', [judged('a', 'pass')]],
    ['the same judge twice', [judged('a', 'pass'), judged('a', 'pass')]],
    ['different cases', [judged('a', 'pass'), judged('b', 'pass', { caseId: 'case-japan' })]],
    [
      'different dataset versions',
      [judged('a', 'pass'), judged('b', 'pass', { datasetVersion: 'capitals-2026-10' })],
    ],
    ['different code revisions', [judged('a', 'pass'), judged('b', 'pass', { codeRevision: 'b' })]],
  ])('rejects %s', (_label, cases) => {
    expect(() => reconcileJudges(cases)).toThrow(RangeError);
  });
});
