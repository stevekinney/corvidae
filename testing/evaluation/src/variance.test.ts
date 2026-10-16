import { describe, expect, test } from 'bun:test';

import tenTrialScores from './fixtures/variance/ten-trial-scores.json';
import {
  narrowestIntervalWidth,
  summarizeProportion,
  summarizeScores,
  variancePolicySchema,
  WILSON_Z_95,
  wilsonInterval,
} from './variance';

const TOLERANCE = 1e-9;

function expectWithin(actual: number | null, expected: number): void {
  expect(actual).not.toBeNull();
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(TOLERANCE);
}

function fixtureSamples(): { score: number; passed: boolean }[] {
  return tenTrialScores.scores.map((score) => ({
    score,
    passed: score >= tenTrialScores.threshold,
  }));
}

describe('summarizeScores', () => {
  test('matches the committed ten-trial fixture to within 1e-9', () => {
    const statistics = summarizeScores(fixtureSamples());
    const { expected } = tenTrialScores;
    expect(statistics.trials).toBe(expected.trials);
    expect(statistics.passes).toBe(expected.passes);
    expectWithin(statistics.passFraction, expected.passFraction);
    expectWithin(statistics.meanScore, expected.meanScore);
    expectWithin(statistics.sampleVariance, expected.sampleVariance);
    expectWithin(statistics.standardDeviation, expected.standardDeviation);
    expectWithin(statistics.wilsonInterval?.lower ?? null, expected.wilsonInterval.lower);
    expectWithin(statistics.wilsonInterval?.upper ?? null, expected.wilsonInterval.upper);
    expectWithin(statistics.wilsonInterval?.width ?? null, expected.wilsonInterval.width);
  });

  test('reports no variance from a single trial rather than a variance of zero', () => {
    const statistics = summarizeScores([{ score: 0.8, passed: true }]);
    expect(statistics).toMatchObject({
      trials: 1,
      passes: 1,
      passFraction: 1,
      meanScore: 0.8,
      sampleVariance: null,
      standardDeviation: null,
    });
    expect(statistics.wilsonInterval?.upper).toBe(1);
  });

  test('reports nothing but the count when no trial was scored', () => {
    expect(summarizeScores([])).toEqual({
      trials: 0,
      passes: 0,
      passFraction: null,
      wilsonInterval: null,
      meanScore: null,
      sampleVariance: null,
      standardDeviation: null,
    });
  });

  test('reports a zero variance for identical scores', () => {
    const statistics = summarizeScores([
      { score: 0.5, passed: false },
      { score: 0.5, passed: false },
    ]);
    expect(statistics.sampleVariance).toBe(0);
    expect(statistics.standardDeviation).toBe(0);
    expect(statistics.wilsonInterval?.lower).toBe(0);
  });
});

describe('summarizeProportion', () => {
  test('gives the pass fraction and its Wilson interval', () => {
    const statistics = summarizeProportion(9, 10);
    expect(statistics.trials).toBe(10);
    expect(statistics.passes).toBe(9);
    expect(statistics.passFraction).toBe(0.9);
    expectWithin(statistics.wilsonInterval?.lower ?? null, 0.5958499732047616);
    expectWithin(statistics.wilsonInterval?.upper ?? null, 0.9821237869049271);
  });

  test('has no fraction or interval without trials', () => {
    expect(summarizeProportion(0, 0)).toEqual({
      trials: 0,
      passes: 0,
      passFraction: null,
      wilsonInterval: null,
    });
  });
});

describe('wilsonInterval', () => {
  test('uses the two-sided 95 percent normal quantile', () => {
    expect(WILSON_Z_95).toBe(1.959963984540054);
  });

  test('stays inside [0, 1] for unanimous results', () => {
    expect(wilsonInterval(3, 3).upper).toBe(1);
    expect(wilsonInterval(0, 3).lower).toBe(0);
    expectWithin(wilsonInterval(3, 3).lower, 0.43850296824495466);
    expectWithin(wilsonInterval(0, 3).upper, 1 - 0.43850296824495466);
  });

  test('is symmetric around one half', () => {
    const low = wilsonInterval(1, 3);
    const high = wilsonInterval(2, 3);
    expectWithin(low.lower, 1 - high.upper);
    expectWithin(low.width, high.width);
  });

  test.each([
    [1, 0],
    [-1, 3],
    [4, 3],
    [1.5, 3],
    [1, 2.5],
  ])('rejects %p passes out of %p trials', (passes, trials) => {
    expect(() => wilsonInterval(passes, trials)).toThrow(RangeError);
  });
});

describe('narrowestIntervalWidth', () => {
  test('is the width of a unanimous result, which no split result can beat', () => {
    expectWithin(narrowestIntervalWidth(1), 0.7934506856227624);
    expectWithin(narrowestIntervalWidth(2), 0.6576197724933468);
    expectWithin(narrowestIntervalWidth(3), 0.5614970317550453);
    for (let passes = 1; passes < 5; passes++) {
      expect(wilsonInterval(passes, 5).width).toBeGreaterThan(narrowestIntervalWidth(5));
    }
  });
});

describe('variancePolicySchema', () => {
  const policy = {
    name: 'two-thirds-within-interval',
    version: '1',
    minimumPassFraction: 0.66,
    maximumIntervalWidth: 0.75,
  };

  test('accepts a named, versioned policy', () => {
    expect(variancePolicySchema.parse(policy)).toEqual(policy);
  });

  test.each([
    ['name', { ...policy, name: '' }],
    ['version', { ...policy, version: '' }],
    ['minimumPassFraction', { ...policy, minimumPassFraction: 0 }],
    ['minimumPassFraction', { ...policy, minimumPassFraction: 1.2 }],
    ['maximumIntervalWidth', { ...policy, maximumIntervalWidth: 0 }],
    ['maximumIntervalWidth', { ...policy, maximumIntervalWidth: 1.1 }],
  ])('rejects an invalid %s', (field, input) => {
    const parsed = variancePolicySchema.safeParse(input);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual([field]);
  });

  test('rejects keys the policy does not define', () => {
    expect(variancePolicySchema.safeParse({ ...policy, confidence: 0.95 }).success).toBe(false);
  });
});
