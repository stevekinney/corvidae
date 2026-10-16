import { describe, expect, test } from 'bun:test';

import gateFile from '../../gates/memory-lifecycle.json';
import { benchmarkAdoptions, EXTERNAL_SCORE_POLICY } from './benchmarks';
import { memoryLifecycleSuite } from './suite';

describe('benchmarkAdoptions', () => {
  test('documents at least one adopted idea from every named benchmark, read from the suite', () => {
    const adoptions = benchmarkAdoptions(memoryLifecycleSuite());
    for (const adoption of adoptions) {
      expect(adoption.scenarioIdeas.length).toBeGreaterThan(0);
      expect(adoption.reportingDimensions.length).toBeGreaterThan(0);
    }
    const longMem = adoptions.find((adoption) => adoption.benchmark === 'LongMemEval-V2')!;
    expect(longMem.scenarioIdeas).toContainEqual({
      idea: 'Knowledge updates: act on the latest value of a fact that changed across sessions.',
      scenarios: ['ship-after-moves'],
    });
  });

  test('adopts no external score as a threshold', () => {
    expect(EXTERNAL_SCORE_POLICY).toContain('No external score is a threshold');
    const gate = JSON.stringify(gateFile);
    for (const adoption of benchmarkAdoptions(memoryLifecycleSuite())) {
      expect(gate).not.toContain(adoption.benchmark);
      expect(Object.keys(adoption).toSorted()).toEqual([
        'benchmark',
        'reportingDimensions',
        'scenarioIdeas',
      ]);
    }
  });
});
