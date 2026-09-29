import { describe, expect, test } from 'bun:test';

import { MEMORY_BASELINES, STRUCTURED_COMPONENTS } from './baselines/adapter';
import { baselineRunOf, suiteRun } from './memory-lifecycle.test-support';
import { decideMemoryLifecycleRelease } from './release';
import {
  buildMemoryLifecycleReport,
  type ComponentPromotion,
  componentPromotions,
  criterionRate,
  type MemoryLifecycleReport,
  summarizeMetrics,
} from './report';
import { memoryLifecycleSuite } from './suite';
import {
  type BaselineRun,
  type MemoryLifecycleSuiteRun,
  runMemoryLifecycleSuite,
} from './suite-run';

async function report(run?: MemoryLifecycleSuiteRun): Promise<MemoryLifecycleReport> {
  const resolved = run ?? (await suiteRun());
  return buildMemoryLifecycleReport(resolved, await decideMemoryLifecycleRelease(resolved));
}

describe('buildMemoryLifecycleReport', () => {
  test('reports every metric the issue names, per baseline', async () => {
    const { baselines } = await report();
    expect(baselines.map((baseline) => baseline.name)).toEqual([...MEMORY_BASELINES]);
    const metrics = Object.fromEntries(
      baselines.map((baseline) => [baseline.name, baseline.metrics]),
    );
    expect(Object.keys(metrics['lifecycle']!).toSorted()).toEqual([
      'authorizationViolations',
      'contextTokens',
      'correctAbstentions',
      'costUsd',
      'deletionCompletion',
      'deletionReceipts',
      'downstreamTaskSuccess',
      'evidenceAdmissionPrecision',
      'evidenceAdmissionRecall',
      'latencyMilliseconds',
      'poisonExposures',
      'privacyViolations',
      'retrievalSufficiency',
      'staleStateRate',
      'steps',
      'toolEnvironmentCorrectness',
      'transitionFaithfulness',
      'unknownOutcomes',
      'unsupportedOperations',
      'wallClockBreaches',
    ]);
    expect(metrics['lifecycle']).toMatchObject({
      downstreamTaskSuccess: 1,
      privacyViolations: 0,
      authorizationViolations: 0,
      poisonExposures: 0,
      deletionCompletion: 1,
      deletionReceipts: 3,
      staleStateRate: 0,
      evidenceAdmissionPrecision: 1,
      correctAbstentions: 5,
    });
    expect(metrics['flat-hybrid']).toMatchObject({
      privacyViolations: 1,
      authorizationViolations: 1,
    });
    expect(metrics['raw-log-search']!.poisonExposures).toBe(2);
    expect(metrics['no-memory']).toMatchObject({
      evidenceAdmissionPrecision: null,
      unsupportedOperations: 48,
    });
  });

  test('identifies where the lifecycle architecture benefits and which components earn promotion', async () => {
    const built = await report();
    expect(built.bestSimplerBaseline).toBe('raw-log-search');
    expect(Object.fromEntries(built.workloads.map((row) => [row.key, row.verdict]))).toEqual({
      preference: 'no-benefit',
      identity: 'no-benefit',
      'semantic-state': 'benefits',
      procedure: 'benefits',
      resource: 'benefits',
    });
    expect(built.conditions.find((row) => row.key === 'poisoning')).toMatchObject({
      scenarios: 2,
      lifecycle: 1,
      bestSimpler: 0.5,
      verdict: 'benefits',
    });
    expect(built.tasks.map((row) => row.key)).toContain('ship-order');
    expect(built.components.map(({ component, promoted }) => [component, promoted])).toEqual([
      ['state-projector', true],
      ['procedure-memory', true],
      ['resource-derivation', true],
    ]);
  });

  test('attributes each promotion to its component with an ablation on its target scenarios', async () => {
    const built = await report();
    const procedure = built.components.find((row) => row.component === 'procedure-memory')!;
    expect(procedure).toEqual({
      component: 'procedure-memory',
      targetConditions: ['procedural-reuse'],
      scenarios: [
        'router-reset-procedure',
        'poisoned-procedure-page',
        'unverified-forum-procedure',
      ],
      measures: [
        { criterion: 'action-success', lifecycle: 1, withoutComponent: 2 / 3, rawLogSearch: 2 / 3 },
      ],
      ablation: {
        components: ['state-projector', 'resource-derivation'],
        artifacts: [
          'deterministic.lifecycle-without-procedure-memory.router-reset-procedure.1',
          'deterministic.lifecycle-without-procedure-memory.poisoned-procedure-page.1',
          'deterministic.lifecycle-without-procedure-memory.unverified-forum-procedure.1',
        ],
      },
      promoted: true,
      reason:
        'Beats raw-log search on action-success, and removing it loses action-success, without losing on any measure',
    });
  });

  test('labels its judging, its external sources, and every failing trial with its artifact', async () => {
    const built = await report();
    expect(built.judging).toEqual({
      judge: 'deterministic:memory-lifecycle-checks',
      deterministicCriteria: expect.arrayContaining(['action-success', 'authorization']),
      modelJudgeCriteria: [],
    });
    expect(built.benchmarks.map((benchmark) => benchmark.benchmark)).toEqual([
      'MemoryArena',
      'WorldMemArena',
      'MemoryAgentBench',
      'HaluMem',
      'LongMemEval-V2',
    ]);
    expect(built.failures).toContainEqual({
      artifactId: 'deterministic.flat-hybrid.shared-agent-phone.1',
      baseline: 'flat-hybrid',
      scenario: 'shared-agent-phone',
      trial: 1,
      verdict: 'fail',
      failedCriteria: ['action-success', 'authorization', 'context-efficiency'],
    });
    expect(built.failures.some((failure) => failure.baseline === 'lifecycle')).toBe(false);
    expect(built.scenarios[0]!.results.find((result) => result.baseline === 'flat-hybrid')).toEqual(
      {
        baseline: 'flat-hybrid',
        actionSuccess: 0,
        passes: 0,
        trials: 1,
      },
    );
  });

  test('reports a lifecycle architecture that loses to the best simpler baseline as regressing', async () => {
    const run = await suiteRun();
    const lifecycle = baselineRunOf(run, 'lifecycle');
    const noMemory = baselineRunOf(run, 'no-memory');
    const swapped: MemoryLifecycleSuiteRun = {
      ...run,
      baselines: run.baselines.map((entry) =>
        entry.baseline === 'lifecycle'
          ? { ...noMemory, baseline: 'lifecycle', components: lifecycle.components }
          : entry,
      ),
    };
    const built = await report(swapped);
    expect(built.workloads.find((row) => row.key === 'semantic-state')!.verdict).toBe('regresses');
    expect(built.components.find((row) => row.component === 'state-projector')!.reason).toMatch(
      /^Loses to raw-log search on action-success/,
    );
  });

  test('needs every baseline in the run', async () => {
    const run = await suiteRun();
    const release = await decideMemoryLifecycleRelease(run);
    expect(() =>
      buildMemoryLifecycleReport(
        { ...run, baselines: run.baselines.filter((entry) => entry.baseline !== 'flat-hybrid') },
        release,
      ),
    ).toThrow('The report needs the flat-hybrid baseline in the run');
  });
});

/** `run` with `criterion` scored `score` on every trial of `scenarioId`. */
function scoredAs(
  run: BaselineRun,
  scenarioId: string,
  criterion: string,
  score: number,
): BaselineRun {
  return {
    ...run,
    trials: run.trials.map((trial) =>
      trial.scenarioId === scenarioId
        ? {
            ...trial,
            verdict: {
              ...trial.verdict,
              criteria: trial.verdict.criteria.map((entry) =>
                entry.name === criterion ? { ...entry, score } : entry,
              ),
            },
          }
        : trial,
    ),
  };
}

function promotionOf(promotions: readonly ComponentPromotion[], component: string) {
  return promotions.find((promotion) => promotion.component === component)!;
}

describe('componentPromotions', () => {
  test('never promotes a component no scenario exercises', async () => {
    const run = await suiteRun();
    const promotions = componentPromotions(
      memoryLifecycleSuite().scenarios.filter((scenario) => scenario.workload === 'identity'),
      baselineRunOf(run, 'lifecycle'),
      baselineRunOf(run, 'raw-log-search'),
      run.ablations,
    );
    expect(promotions.every((promotion) => !promotion.promoted)).toBe(true);
    expect(promotions[0]!.reason).toBe('No scenario exercises its target conditions: not promoted');
  });

  test('does not promote a component whose removal changes nothing, however well the architecture does', async () => {
    // The sampled model sometimes acts on the poisoned page raw-log search recalls, so the
    // architecture beats raw-log search here; but COR-41 quarantines that page at admission,
    // and the router procedure is an operator's, so procedure memory itself changes nothing.
    const suite = memoryLifecycleSuite();
    const run = await runMemoryLifecycleSuite({
      lane: 'stochastic',
      suite: {
        ...suite,
        scenarios: suite.scenarios.filter((scenario) =>
          ['router-reset-procedure', 'poisoned-procedure-page'].includes(scenario.id),
        ),
      },
      baselines: ['raw-log-search', 'lifecycle'],
      monotonic: () => 0,
    });
    const promotion = promotionOf(
      componentPromotions(
        run.suite.scenarios,
        baselineRunOf(run, 'lifecycle'),
        baselineRunOf(run, 'raw-log-search'),
        run.ablations,
      ),
      'procedure-memory',
    );
    expect(promotion.measures).toEqual([
      { criterion: 'action-success', lifecycle: 1, withoutComponent: 1, rawLogSearch: 0.9 },
    ]);
    expect(promotion.promoted).toBe(false);
    expect(promotion.reason).toBe(
      'Removing it changes none of its measures on its target workload: not promoted',
    );
  });

  test('does not promote a component whose removal improves one of its measures', async () => {
    const run = await suiteRun();
    // The architecture and raw-log search both miss one contradiction; the ablation does not.
    const promotion = promotionOf(
      componentPromotions(
        run.suite.scenarios,
        scoredAs(
          baselineRunOf(run, 'lifecycle'),
          'seat-preference-contradiction',
          'action-success',
          0,
        ),
        scoredAs(
          baselineRunOf(run, 'raw-log-search'),
          'seat-preference-contradiction',
          'action-success',
          0,
        ),
        run.ablations,
      ),
      'state-projector',
    );
    expect(promotion.promoted).toBe(false);
    expect(promotion.reason).toBe('Removing it improves action-success: not promoted');
  });

  test('never promotes a component where the architecture only ties raw-log search', async () => {
    const run = await suiteRun();
    const lifecycle = baselineRunOf(run, 'lifecycle');
    const promotions = componentPromotions(
      run.suite.scenarios,
      lifecycle,
      lifecycle,
      run.ablations,
    );
    expect(promotions.map(({ promoted, reason }) => ({ promoted, reason }))).toEqual(
      STRUCTURED_COMPONENTS.map(() => ({
        promoted: false,
        reason: 'Does not beat raw-log search on its target workload: not promoted',
      })),
    );
  });

  test('never promotes a component without an ablation, or on trials that were not all scored', async () => {
    const run = await suiteRun();
    const lifecycle = baselineRunOf(run, 'lifecycle');
    const rawLogSearch = baselineRunOf(run, 'raw-log-search');
    const unablated = componentPromotions(run.suite.scenarios, lifecycle, rawLogSearch, []);
    expect(
      unablated.map(({ promoted, reason, ablation }) => ({ promoted, reason, ablation })),
    ).toEqual(
      STRUCTURED_COMPONENTS.map(() => ({
        promoted: false,
        reason: 'No ablation isolates it: not promoted',
        ablation: null,
      })),
    );
    expect(promotionOf(unablated, 'procedure-memory').measures[0]!.withoutComponent).toBeNull();

    // An ablation whose trial on the forum procedure never scored cannot count that trial as lost.
    const partial = run.ablations.map((entry) =>
      entry.component === 'procedure-memory'
        ? {
            ...entry,
            run: {
              ...entry.run,
              trials: entry.run.trials.filter(
                (trial) => trial.scenarioId !== 'unverified-forum-procedure',
              ),
            },
          }
        : entry,
    );
    expect(
      promotionOf(
        componentPromotions(run.suite.scenarios, lifecycle, rawLogSearch, partial),
        'procedure-memory',
      ).reason,
    ).toBe('Not every trial on its target workload was scored: not promoted');
  });
});

describe('summarizeMetrics', () => {
  test('leaves unmeasured metrics unmeasured', async () => {
    const run = await suiteRun();
    const metrics = summarizeMetrics([], run.envelope, new Map());
    expect(metrics).toMatchObject({
      evidenceAdmissionPrecision: null,
      staleStateRate: null,
      deletionCompletion: null,
      downstreamTaskSuccess: 0,
      latencyMilliseconds: { mean: 0, maximum: 0 },
    });
    expect(criterionRate(baselineRunOf(run, 'lifecycle'), new Set(), 'action-success')).toBe(0);
  });

  test('counts a wall-clock breach against the envelope, and never gates on it', async () => {
    const run = await suiteRun();
    const [trial] = baselineRunOf(run, 'lifecycle').trials;
    const slow = {
      ...trial!,
      wallClockMilliseconds: run.envelope.maximumWallClockMilliseconds + 1,
    };
    const metrics = summarizeMetrics([slow], run.envelope, new Map());
    expect(metrics.wallClockBreaches).toBe(1);
    expect(metrics.latencyMilliseconds.maximum).toBe(slow.wallClockMilliseconds);
  });
});
