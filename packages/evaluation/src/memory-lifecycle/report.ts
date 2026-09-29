/**
 * The memory-lifecycle report (COR-755): one versioned JSON document per
 * suite run, and a Markdown rendering of it. It reports every metric per
 * baseline, which memory workloads, conditions, and named action tasks the
 * lifecycle architecture benefits compared with the best simpler baseline,
 * which structured components earn promotion, the release decision, and
 * every failing baseline trial with the artifact that replays it. An
 * ablation's artifacts are listed on its component's row instead: its
 * trials are expected to fail wherever the component matters.
 *
 * A structured component is promoted only when, on the scenarios of its
 * target conditions, the lifecycle architecture beats both raw-log search
 * and its own ablation without that component: no worse than either on
 * every one of the component's measures, and strictly better than each on at
 * least one. Beating raw-log search alone is not enough, because the rest of
 * the architecture (COR-41's admission and owner partitions) can win there on
 * its own; only the ablation attributes the gain to the component. Otherwise
 * it is flagged as not promoted, which is its default.
 */
import type { EvaluatorIdentity } from '../identity';
import {
  MEMORY_BASELINES,
  type MemoryBaselineName,
  STRUCTURED_COMPONENTS,
  type StructuredComponent,
} from './baselines/adapter';
import { type BenchmarkAdoption, benchmarkAdoptions, EXTERNAL_SCORE_POLICY } from './benchmarks';
import { COMPONENT_TARGETS, componentScenarioIds } from './components';
import type { ComputeEnvelope, MemoryLifecycleLane } from './envelope';
import { ACTION_CRITERION } from './memory-evaluator';
import type { MemoryLifecycleRelease } from './release';
import {
  MEMORY_WORKLOADS,
  type MemoryScenario,
  SCENARIO_CONDITIONS,
  type ScenarioCondition,
} from './scenarios';
import type {
  BaselineRun,
  ComponentAblation,
  MemoryLifecycleSuiteRun,
  TrialResult,
} from './suite-run';

export const MEMORY_LIFECYCLE_REPORT_SCHEMA_VERSION = 1 as const;

export interface BaselineMetrics {
  readonly evidenceAdmissionPrecision: number | null;
  readonly evidenceAdmissionRecall: number | null;
  readonly staleStateRate: number | null;
  readonly transitionFaithfulness: number | null;
  readonly retrievalSufficiency: number | null;
  readonly contextTokens: number;
  readonly latencyMilliseconds: { readonly mean: number; readonly maximum: number };
  /** Trials that took longer than the envelope's wall-clock ceiling. Measured, never gated. */
  readonly wallClockBreaches: number;
  readonly downstreamTaskSuccess: number;
  readonly toolEnvironmentCorrectness: number;
  readonly privacyViolations: number;
  readonly authorizationViolations: number;
  readonly poisonExposures: number;
  readonly deletionCompletion: number | null;
  readonly deletionReceipts: number;
  readonly unsupportedOperations: number;
  readonly unknownOutcomes: number;
  readonly correctAbstentions: number;
  readonly costUsd: { readonly total: number; readonly mean: number };
  readonly steps: number;
}

export interface BaselineSummary {
  readonly name: MemoryBaselineName;
  readonly revision: string;
  readonly components: readonly StructuredComponent[];
  readonly evaluator: EvaluatorIdentity;
  readonly outcomes: BaselineRun['record']['outcomes'];
  readonly metrics: BaselineMetrics;
  readonly criteria: readonly {
    readonly name: string;
    readonly passFraction: number | null;
    readonly meanScore: number | null;
  }[];
}

export interface BenefitRow {
  readonly key: string;
  readonly scenarios: number;
  readonly lifecycle: number;
  readonly bestSimpler: number;
  readonly delta: number;
  readonly verdict: 'benefits' | 'no-benefit' | 'regresses';
}

export interface ComponentPromotion {
  readonly component: StructuredComponent;
  readonly targetConditions: readonly ScenarioCondition[];
  readonly scenarios: readonly string[];
  readonly measures: readonly {
    readonly criterion: string;
    readonly lifecycle: number;
    /** The architecture without this component; `null` when no ablation ran. */
    readonly withoutComponent: number | null;
    readonly rawLogSearch: number;
  }[];
  /** The ablation's own components and the artifacts that replay its trials; `null` when none ran. */
  readonly ablation: {
    readonly components: readonly StructuredComponent[];
    readonly artifacts: readonly string[];
  } | null;
  readonly promoted: boolean;
  readonly reason: string;
}

export interface FailureRow {
  readonly artifactId: string;
  readonly baseline: MemoryBaselineName;
  readonly scenario: string;
  readonly trial: number;
  readonly verdict: string;
  readonly failedCriteria: readonly string[];
}

export interface MemoryLifecycleReport {
  readonly kind: 'memory-lifecycle-report';
  readonly schemaVersion: typeof MEMORY_LIFECYCLE_REPORT_SCHEMA_VERSION;
  readonly suite: {
    readonly id: string;
    readonly version: string;
    readonly digest: string;
    readonly scenarios: number;
  };
  readonly lane: MemoryLifecycleLane;
  readonly seed: string;
  readonly repetitions: number;
  /** Every baseline ran under exactly this envelope. */
  readonly envelope: { readonly digest: string; readonly value: ComputeEnvelope };
  readonly judging: {
    readonly judge: string;
    readonly deterministicCriteria: readonly string[];
    readonly modelJudgeCriteria: readonly string[];
  };
  readonly externalScorePolicy: string;
  readonly benchmarks: readonly BenchmarkAdoption[];
  readonly baselines: readonly BaselineSummary[];
  readonly scenarios: readonly {
    readonly id: string;
    readonly title: string;
    readonly workload: string;
    readonly conditions: readonly string[];
    readonly task: string;
    readonly results: readonly {
      readonly baseline: MemoryBaselineName;
      readonly actionSuccess: number;
      readonly passes: number;
      readonly trials: number;
    }[];
  }[];
  readonly bestSimplerBaseline: MemoryBaselineName | null;
  readonly workloads: readonly BenefitRow[];
  readonly conditions: readonly BenefitRow[];
  readonly tasks: readonly BenefitRow[];
  readonly components: readonly ComponentPromotion[];
  readonly release: MemoryLifecycleRelease;
  readonly failures: readonly FailureRow[];
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

/** The mean of the values that were measured, or `null` when none was. */
function measuredMean(values: readonly (number | null)[]): number | null {
  const measured = values.filter((value): value is number => value !== null);
  return measured.length === 0 ? null : mean(measured);
}

function sum(trials: readonly TrialResult[], count: (trial: TrialResult) => number): number {
  return trials.reduce((total, trial) => total + count(trial), 0);
}

function share(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function summarizeMetrics(
  trials: readonly TrialResult[],
  envelope: ComputeEnvelope,
  scenarios: ReadonlyMap<string, MemoryScenario>,
): BaselineMetrics {
  const metrics = trials.map((trial) => trial.metrics);
  const admitted = sum(trials, ({ metrics: { admission } }) => admission.truePositives);
  const latencies = trials.map((trial) => trial.wallClockMilliseconds);
  const cost = sum(trials, (trial) => trial.metrics.costUsd);
  return {
    evidenceAdmissionPrecision: share(
      admitted,
      admitted + sum(trials, ({ metrics: { admission } }) => admission.falsePositives),
    ),
    evidenceAdmissionRecall: share(
      admitted,
      admitted + sum(trials, ({ metrics: { admission } }) => admission.falseNegatives),
    ),
    staleStateRate: measuredMean(metrics.map((entry) => entry.staleStateRate)),
    transitionFaithfulness: measuredMean(metrics.map((entry) => entry.transitionFaithfulness)),
    retrievalSufficiency: measuredMean(metrics.map((entry) => entry.retrievalSufficiency)),
    contextTokens: mean(metrics.map((entry) => entry.context.tokens)),
    latencyMilliseconds: { mean: mean(latencies), maximum: Math.max(0, ...latencies) },
    wallClockBreaches: latencies.filter((value) => value > envelope.maximumWallClockMilliseconds)
      .length,
    downstreamTaskSuccess: mean(metrics.map((entry) => (entry.taskSuccess ? 1 : 0))),
    toolEnvironmentCorrectness: mean(metrics.map((entry) => (entry.toolCorrectness ? 1 : 0))),
    privacyViolations: sum(trials, (trial) => trial.metrics.privacyViolations),
    authorizationViolations: sum(trials, (trial) => trial.metrics.authorizationViolations),
    poisonExposures: sum(trials, (trial) => trial.metrics.poisonExposures),
    deletionCompletion: share(
      sum(trials, (trial) => trial.metrics.deletion.completed),
      sum(trials, (trial) => trial.metrics.deletion.reached),
    ),
    deletionReceipts: sum(trials, (trial) => trial.metrics.deletion.receipted),
    unsupportedOperations: sum(trials, (trial) => trial.metrics.unsupportedOperations),
    unknownOutcomes: metrics.filter((entry) => entry.unknownOutcome).length,
    correctAbstentions: trials.filter(
      (trial) =>
        trial.metrics.unknownOutcome &&
        scenarios.get(trial.scenarioId)!.expected.outcome.kind === 'unknown',
    ).length,
    costUsd: { total: cost, mean: mean(metrics.map((entry) => entry.costUsd)) },
    steps: mean(metrics.map((entry) => entry.steps)),
  };
}

/**
 * Whether `score` passes `criterion` in `run`'s configuration: it reaches the
 * criterion's hard threshold, or the pass threshold when it has none. The
 * release gate's criterion statistics count passes the same way.
 */
function passes(run: BaselineRun, criterion: string, score: number | undefined): boolean {
  const { criteria, passThreshold } = run.configuration;
  const threshold = criteria.find((entry) => entry.name === criterion)?.hardThreshold;
  return score !== undefined && score >= (threshold ?? passThreshold);
}

/** The share of `run`'s trials over `scenarioIds` that passed `criterion`. */
export function criterionRate(
  run: BaselineRun,
  scenarioIds: ReadonlySet<string>,
  criterion: string,
): number {
  return mean(
    run.trials
      .filter((trial) => scenarioIds.has(trial.scenarioId))
      .map((trial) => {
        const score = trial.verdict.criteria.find((entry) => entry.name === criterion)?.score;
        return passes(run, criterion, score) ? 1 : 0;
      }),
  );
}

function benefitRows(
  keyed: readonly { readonly key: string; readonly scenarios: ReadonlySet<string> }[],
  lifecycle: BaselineRun,
  best: BaselineRun,
): BenefitRow[] {
  return keyed
    .filter(({ scenarios }) => scenarios.size > 0)
    .map(({ key, scenarios }) => {
      const candidate = criterionRate(lifecycle, scenarios, ACTION_CRITERION);
      const baseline = criterionRate(best, scenarios, ACTION_CRITERION);
      const delta = candidate - baseline;
      return {
        key,
        scenarios: scenarios.size,
        lifecycle: candidate,
        bestSimpler: baseline,
        delta,
        verdict: delta > 0 ? 'benefits' : delta < 0 ? 'regresses' : 'no-benefit',
      };
    });
}

function idsWhere(
  scenarios: readonly MemoryScenario[],
  predicate: (scenario: MemoryScenario) => boolean,
): Set<string> {
  return new Set(scenarios.filter(predicate).map((scenario) => scenario.id));
}

type Measure = ComponentPromotion['measures'][number];

/** The measures on which the lifecycle architecture does worse and better than `other`. */
function versus(
  measures: readonly Measure[],
  other: (measure: Measure) => number,
): { readonly worse: string[]; readonly better: string[] } {
  return {
    worse: measures
      .filter((entry) => entry.lifecycle < other(entry))
      .map((entry) => entry.criterion),
    better: measures
      .filter((entry) => entry.lifecycle > other(entry))
      .map((entry) => entry.criterion),
  };
}

/** Whether `run` scored every trial of every scenario in `scenarioIds`. */
function scoredEveryTrial(run: BaselineRun, scenarioIds: ReadonlySet<string>): boolean {
  const scored = run.trials.filter((trial) => scenarioIds.has(trial.scenarioId)).length;
  return scored === scenarioIds.size * run.configuration.repetitions;
}

/** Why `component` is, or is not, promoted, from its measures and the runs behind them. */
function promotionReason(
  measures: readonly Measure[],
  evidence: { readonly scenarios: number; readonly ablated: boolean; readonly complete: boolean },
): { readonly promoted: boolean; readonly reason: string } {
  const notPromoted = (reason: string) => ({ promoted: false, reason: `${reason}: not promoted` });
  if (evidence.scenarios === 0) return notPromoted('No scenario exercises its target conditions');
  if (!evidence.ablated) return notPromoted('No ablation isolates it');
  if (!evidence.complete) return notPromoted('Not every trial on its target workload was scored');
  const raw = versus(measures, (entry) => entry.rawLogSearch);
  if (raw.worse.length > 0) {
    return notPromoted(`Loses to raw-log search on ${raw.worse.join(', ')}`);
  }
  if (raw.better.length === 0) {
    return notPromoted('Does not beat raw-log search on its target workload');
  }
  const ablated = versus(measures, (entry) => entry.withoutComponent!);
  if (ablated.worse.length > 0) {
    return notPromoted(`Removing it improves ${ablated.worse.join(', ')}`);
  }
  if (ablated.better.length === 0) {
    return notPromoted('Removing it changes none of its measures on its target workload');
  }
  return {
    promoted: true,
    reason: `Beats raw-log search on ${raw.better.join(', ')}, and removing it loses ${ablated.better.join(', ')}, without losing on any measure`,
  };
}

/**
 * Whether each of the lifecycle architecture's components earns promotion on
 * its target scenarios: the architecture must beat raw-log search there, and
 * also beat its ablation without that component, so the gain is the
 * component's. A component with no ablation, or whose runs did not score
 * every trial there, is never promoted.
 */
export function componentPromotions(
  scenarios: readonly MemoryScenario[],
  lifecycle: BaselineRun,
  rawLogSearch: BaselineRun,
  ablations: readonly ComponentAblation[],
): ComponentPromotion[] {
  return STRUCTURED_COMPONENTS.filter((component) => lifecycle.components.includes(component)).map(
    (component) => {
      const target = COMPONENT_TARGETS[component];
      const ids = componentScenarioIds(component, scenarios);
      const ablated = ablations.find((entry) => entry.component === component)?.run;
      const measures = target.measures.map((criterion) => ({
        criterion,
        lifecycle: criterionRate(lifecycle, ids, criterion),
        withoutComponent: ablated === undefined ? null : criterionRate(ablated, ids, criterion),
        rawLogSearch: criterionRate(rawLogSearch, ids, criterion),
      }));
      const runs = [lifecycle, rawLogSearch, ...(ablated === undefined ? [] : [ablated])];
      return {
        component,
        targetConditions: target.conditions,
        scenarios: [...ids],
        measures,
        ablation:
          ablated === undefined
            ? null
            : {
                components: ablated.components,
                artifacts: ablated.artifacts
                  .filter((artifact) => ids.has(artifact.scenario.id))
                  .map((artifact) => artifact.id),
              },
        ...promotionReason(measures, {
          scenarios: ids.size,
          ablated: ablated !== undefined,
          complete: runs.every((run) => scoredEveryTrial(run, ids)),
        }),
      };
    },
  );
}

function criterionNames(
  criteria: BaselineRun['configuration']['criteria'],
  kind: (kind: string) => boolean,
): string[] {
  return criteria.filter((criterion) => kind(criterion.kind)).map(({ name }) => name);
}

function runOf(run: MemoryLifecycleSuiteRun, name: MemoryBaselineName): BaselineRun {
  const found = run.baselines.find((entry) => entry.baseline === name);
  if (found === undefined) throw new RangeError(`The report needs the ${name} baseline in the run`);
  return found;
}

/** Builds the report for a suite run that ran all four baselines, with its release decision. */
export function buildMemoryLifecycleReport(
  run: MemoryLifecycleSuiteRun,
  release: MemoryLifecycleRelease,
): MemoryLifecycleReport {
  const runs = MEMORY_BASELINES.map((name) => runOf(run, name));
  const [, rawLogSearch, , lifecycle] = runs as [
    BaselineRun,
    BaselineRun,
    BaselineRun,
    BaselineRun,
  ];
  const best = runOf(run, release.baseline ?? 'no-memory');
  const { scenarios } = run.suite;
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const { criteria } = lifecycle.configuration;
  return {
    kind: 'memory-lifecycle-report',
    schemaVersion: MEMORY_LIFECYCLE_REPORT_SCHEMA_VERSION,
    suite: {
      id: run.suite.id,
      version: run.suite.version,
      digest: run.suiteDigest,
      scenarios: scenarios.length,
    },
    lane: run.lane,
    seed: run.seed,
    repetitions: lifecycle.configuration.repetitions,
    envelope: { digest: run.envelopeDigest, value: run.envelope },
    judging: {
      judge: `${lifecycle.configuration.judge.kind}:${lifecycle.configuration.judge.name}`,
      deterministicCriteria: criterionNames(criteria, (kind) => kind !== 'model-judge'),
      modelJudgeCriteria: criterionNames(criteria, (kind) => kind === 'model-judge'),
    },
    externalScorePolicy: EXTERNAL_SCORE_POLICY,
    benchmarks: benchmarkAdoptions(run.suite),
    baselines: runs.map((entry) => ({
      name: entry.baseline,
      revision: entry.configuration.environment.revision,
      components: entry.components,
      evaluator: entry.identity,
      outcomes: entry.record.outcomes,
      metrics: summarizeMetrics(entry.trials, run.envelope, byId),
      criteria: entry.record.statistics.criteria.map(({ name, passFraction, meanScore }) => ({
        name,
        passFraction,
        meanScore,
      })),
    })),
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      workload: scenario.workload,
      conditions: scenario.conditions,
      task: scenario.task.name,
      results: runs.map((entry) => {
        const trials = entry.trials.filter((trial) => trial.scenarioId === scenario.id);
        return {
          baseline: entry.baseline,
          actionSuccess: criterionRate(entry, new Set([scenario.id]), ACTION_CRITERION),
          passes: trials.filter((trial) => trial.verdict.verdict === 'pass').length,
          trials: trials.length,
        };
      }),
    })),
    bestSimplerBaseline: release.baseline,
    workloads: benefitRows(
      MEMORY_WORKLOADS.map((workload) => ({
        key: workload,
        scenarios: idsWhere(scenarios, (scenario) => scenario.workload === workload),
      })),
      lifecycle,
      best,
    ),
    conditions: benefitRows(
      SCENARIO_CONDITIONS.map((condition) => ({
        key: condition,
        scenarios: idsWhere(scenarios, (scenario) => scenario.conditions.includes(condition)),
      })),
      lifecycle,
      best,
    ),
    tasks: benefitRows(
      [...new Set(scenarios.map((scenario) => scenario.task.name))].map((task) => ({
        key: task,
        scenarios: idsWhere(scenarios, (scenario) => scenario.task.name === task),
      })),
      lifecycle,
      best,
    ),
    components: componentPromotions(scenarios, lifecycle, rawLogSearch, run.ablations),
    release,
    failures: runs.flatMap((entry) =>
      entry.trials
        .filter((trial) => trial.verdict.verdict !== 'pass')
        .map((trial) => ({
          artifactId: trial.artifactId,
          baseline: entry.baseline,
          scenario: trial.scenarioId,
          trial: trial.trial,
          verdict: trial.verdict.verdict,
          failedCriteria: trial.verdict.criteria
            .filter((criterion) => !passes(entry, criterion.name, criterion.score))
            .map((criterion) => criterion.name),
        })),
    ),
  };
}
