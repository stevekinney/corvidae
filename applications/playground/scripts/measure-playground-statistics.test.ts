import { describe, expect, it } from 'bun:test';

import {
  classifyGrowth,
  growthReport,
  median,
  selectCandidate,
  summarize,
  type MetricObservation,
} from './measure-playground-statistics.ts';

describe('median and summarize', () => {
  it('takes the middle sample of an odd count regardless of order', () => {
    expect(median([30, 10, 20])).toBe(20);
  });

  it('averages the two middle samples of an even count', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('reports every sample, the observed band, and the median', () => {
    expect(summarize([12, 9, 15])).toEqual({
      samples: [12, 9, 15],
      minimum: 9,
      median: 12,
      maximum: 15,
    });
  });

  it('refuses empty and non-finite samples', () => {
    expect(() => summarize([])).toThrow(RangeError);
    expect(() => summarize([1, Number.NaN])).toThrow(RangeError);
    expect(() => median([Number.POSITIVE_INFINITY])).toThrow(RangeError);
  });
});

function observation(
  metric: MetricObservation['metric'],
  temperature: MetricObservation['temperature'],
  baseline: number[],
  candidate: number[],
  subject?: string,
): MetricObservation {
  return subject === undefined
    ? { metric, temperature, baseline, candidate }
    : { metric, subject, temperature, baseline, candidate };
}

describe('selectCandidate', () => {
  it('selects a candidate whose maximum falls below the baseline minimum when nothing else regresses', () => {
    const decision = selectCandidate([
      observation('staticExportMilliseconds', 'cold', [100, 110, 120], [80, 85, 90]),
      observation('staticExportMilliseconds', 'warm', [90, 95, 100], [92, 96, 99]),
      observation('serverSpawnToReadyMilliseconds', 'cold', [50, 55, 60], [52, 60, 61]),
    ]);
    expect(decision.selected).toBe(true);
    expect(
      decision.comparisons.filter((comparison) => comparison.improved).map((c) => c.key),
    ).toEqual(['staticExportMilliseconds/cold']);
  });

  it('retains the baseline when an improvement only reaches into the baseline band', () => {
    // Candidate maximum 100 equals the baseline minimum: inside the band, so not an improvement.
    const decision = selectCandidate([
      observation('staticExportMilliseconds', 'cold', [100, 110, 120], [80, 90, 100]),
    ]);
    expect(decision.selected).toBe(false);
    expect(decision.reasons).toEqual([
      'No primary metric has a candidate maximum below its baseline minimum.',
    ]);
  });

  it('retains the baseline when another metric median exceeds its baseline maximum', () => {
    const decision = selectCandidate([
      observation('staticExportMilliseconds', 'cold', [100, 110, 120], [60, 70, 80]),
      observation(
        'processTreePeakResidentBytes',
        'cold',
        [1000, 1100, 1200],
        [1150, 1250, 1300],
        'static-export',
      ),
    ]);
    expect(decision.selected).toBe(false);
    expect(decision.reasons).toContain(
      'processTreePeakResidentBytes(static-export)/cold: candidate median 1250 exceeds baseline maximum 1200.',
    );
  });

  it('accepts a candidate median exactly at the baseline maximum', () => {
    const decision = selectCandidate([
      observation('staticExportMilliseconds', 'warm', [100, 110, 120], [60, 70, 80]),
      observation('serverSpawnToReadyMilliseconds', 'warm', [50, 55, 60], [40, 60, 90]),
    ]);
    expect(decision.selected).toBe(true);
  });

  it('weighs the same metric for different subjects as separate observations', () => {
    expect(() =>
      selectCandidate([
        observation('processTreePeakResidentBytes', 'cold', [1], [1], 'static-export'),
        observation('processTreePeakResidentBytes', 'cold', [1], [1], 'server'),
      ]),
    ).not.toThrow();
  });

  it('refuses duplicate and missing observations', () => {
    expect(() => selectCandidate([])).toThrow(RangeError);
    expect(() =>
      selectCandidate([
        observation('staticExportMilliseconds', 'cold', [1], [1]),
        observation('staticExportMilliseconds', 'cold', [2], [2]),
      ]),
    ).toThrow('appears more than once');
  });
});

describe('classifyGrowth', () => {
  it('flags a series that never falls and ends higher as monotonic growth', () => {
    expect(classifyGrowth([10, 10, 12, 15, 15])).toBe('monotonic-growth');
  });

  it('calls an unchanged series stable', () => {
    expect(classifyGrowth([7, 7, 7, 7, 7])).toBe('stable');
  });

  it('calls growth that is later released fluctuating', () => {
    expect(classifyGrowth([10, 14, 12, 15, 11])).toBe('fluctuating');
    expect(classifyGrowth([10, 12, 9])).toBe('fluctuating');
  });

  it('needs at least two finite cycles', () => {
    expect(() => classifyGrowth([1])).toThrow(RangeError);
    expect(() => classifyGrowth([1, Number.NaN])).toThrow(RangeError);
  });
});

describe('growthReport', () => {
  it('classifies each named series and treats a single cycle as stable', () => {
    expect(growthReport({ mounts: [3, 3, 3], heap: [1, 2, 3], single: [9] })).toEqual({
      mounts: { series: [3, 3, 3], classification: 'stable' },
      heap: { series: [1, 2, 3], classification: 'monotonic-growth' },
      single: { series: [9], classification: 'stable' },
    });
  });
});
