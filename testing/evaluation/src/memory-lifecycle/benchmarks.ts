/**
 * What this suite adopted from external memory benchmarks (COR-755). The
 * benchmarks are sources of scenario ideas and reporting dimensions only.
 * No external benchmark score, leaderboard number, or dataset is part of
 * this suite, and none is a threshold: every threshold the release gate
 * holds is a delta between this suite's own baselines, measured on this
 * suite's own scenarios. Adopting an external score as a permanent gate
 * would take a separate release decision.
 *
 * Scenario ideas are read from each scenario's `sources`, so this record and
 * the suite cannot drift apart. The reporting dimensions name this suite's
 * own metrics that a benchmark's framing motivated.
 */
import { BENCHMARK_SOURCES, type BenchmarkSource, type MemoryScenarioSuite } from './scenarios';

export const EXTERNAL_SCORE_POLICY =
  'External benchmarks supply scenario ideas and reporting dimensions only. No external score is a threshold; every release threshold is a delta between this suite’s own baselines on this suite’s own scenarios.';

/** This suite's metrics each benchmark's framing motivated. */
const REPORTING_DIMENSIONS: Readonly<Record<BenchmarkSource, readonly string[]>> = {
  MemoryArena: ['downstreamTaskSuccess', 'toolEnvironmentCorrectness'],
  WorldMemArena: ['downstreamTaskSuccess', 'staleStateRate'],
  MemoryAgentBench: ['retrievalSufficiency', 'staleStateRate'],
  HaluMem: [
    'evidenceAdmissionPrecision',
    'evidenceAdmissionRecall',
    'transitionFaithfulness',
    'unsupportedOperations',
  ],
  'LongMemEval-V2': ['staleStateRate', 'unknownOutcomes', 'correctAbstentions'],
};

export interface BenchmarkAdoption {
  readonly benchmark: BenchmarkSource;
  /** Each adopted idea, with the scenarios that carry it. */
  readonly scenarioIdeas: readonly {
    readonly idea: string;
    readonly scenarios: readonly string[];
  }[];
  readonly reportingDimensions: readonly string[];
}

/** Every benchmark's adopted ideas, read from `suite`, and its reporting dimensions. */
export function benchmarkAdoptions(suite: MemoryScenarioSuite): BenchmarkAdoption[] {
  return BENCHMARK_SOURCES.map((benchmark) => {
    const ideas = new Map<string, string[]>();
    for (const scenario of suite.scenarios) {
      for (const source of scenario.sources) {
        if (source.benchmark !== benchmark) continue;
        ideas.set(source.idea, [...(ideas.get(source.idea) ?? []), scenario.id]);
      }
    }
    return {
      benchmark,
      scenarioIdeas: [...ideas].map(([idea, scenarios]) => ({ idea, scenarios })),
      reportingDimensions: REPORTING_DIMENSIONS[benchmark],
    };
  });
}
