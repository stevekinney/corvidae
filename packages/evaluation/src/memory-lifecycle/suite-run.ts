/**
 * Runs the whole memory-lifecycle suite in one lane: every scenario against
 * every baseline, under the lane's one compute envelope, through
 * `scoreTrials` (this package's only case executor). Trial seeds are common
 * random numbers: each scenario's trials get the same seeds under every
 * baseline, drawn from a generator seeded by the lane (or the caller), so a
 * lane's run is one fixed, recorded configuration and the baselines differ
 * only in memory.
 *
 * When the lifecycle architecture runs, each of its structured components is
 * also ablated: the architecture runs again without that one component, over
 * the component's target scenarios, under the same seeds. The report promotes
 * a component only when removing it costs something there.
 *
 * Each trial yields a run artifact, and each baseline an `evaluation-run`
 * record that the release gate and the history can compare.
 */
import {
  createDefaultRuntimeServices,
  createManualRuntimeServices,
  type RunResultBase,
} from '@lostgradient/operative';

import type { EvaluatorConfiguration } from '../configuration';
import type { EvaluationRunRecord } from '../evaluation-run';
import { createEvaluator } from '../evaluator';
import { toEvaluationRunRecord } from '../history';
import type { EvaluatorIdentity } from '../identity';
import { scoreTrials, type TrialAggregate } from '../trials';
import type { ScenarioAgent, ScenarioModel } from './agent';
import {
  observedTrace,
  type ScenarioRunArtifact,
  summarizeTrial,
  toScenarioRunArtifact,
  type TrialVerdictSummary,
} from './artifact';
import {
  baselineComponents,
  baselineVariant,
  MEMORY_BASELINES,
  type MemoryBaselineName,
  type StructuredComponent,
} from './baselines/adapter';
import { componentScenarioIds } from './components';
import {
  type ComputeEnvelope,
  envelopeDigest,
  memoryLifecycleEnvelope,
  type MemoryLifecycleLane,
} from './envelope';
import { memoryLifecycleEvaluator } from './memory-evaluator';
import { measureScenarioRun, type ScenarioMetrics } from './metrics';
import type { MemoryScenarioSuite } from './scenarios';
import { memoryLifecycleSuite, suiteDigest } from './suite';

/** Seeds are unsigned 32-bit integers. */
const SEED_RANGE = 0x1_0000_0000;

export interface RunMemoryLifecycleSuiteOptions {
  readonly lane: MemoryLifecycleLane;
  /** Defaults to the committed suite. */
  readonly suite?: MemoryScenarioSuite | undefined;
  /** Defaults to all four, simplest first. */
  readonly baselines?: readonly MemoryBaselineName[] | undefined;
  /** Defaults to the lane's reference policy. */
  readonly model?: ScenarioModel | undefined;
  /** Seeds every scenario's trials. Defaults to `memory-lifecycle/<lane>`. */
  readonly seed?: string | undefined;
  /** Measures wall-clock time. Defaults to the real monotonic clock. */
  readonly monotonic?: (() => number) | undefined;
  /** When the evaluation-run records are recorded. Defaults to now. */
  readonly recordedAt?: string | undefined;
  /** Called with each artifact as soon as its trial is scored. */
  readonly onArtifact?: ((artifact: ScenarioRunArtifact) => void | Promise<void>) | undefined;
}

/** One trial's typed results, as its artifact records them. */
export interface TrialResult {
  readonly scenarioId: string;
  readonly trial: number;
  readonly seed: number;
  readonly artifactId: string;
  readonly verdict: TrialVerdictSummary;
  readonly metrics: ScenarioMetrics;
  readonly wallClockMilliseconds: number;
}

export interface BaselineRun {
  readonly baseline: MemoryBaselineName;
  readonly components: readonly StructuredComponent[];
  readonly identity: EvaluatorIdentity;
  readonly configuration: EvaluatorConfiguration;
  readonly aggregates: readonly TrialAggregate[];
  readonly record: EvaluationRunRecord;
  readonly trials: readonly TrialResult[];
  readonly artifacts: readonly ScenarioRunArtifact[];
}

/**
 * The lifecycle architecture without one of its structured components, run
 * over that component's target scenarios only.
 */
export interface ComponentAblation {
  readonly component: StructuredComponent;
  readonly run: BaselineRun;
}

export interface MemoryLifecycleSuiteRun {
  readonly suite: MemoryScenarioSuite;
  readonly suiteDigest: string;
  readonly lane: MemoryLifecycleLane;
  readonly envelope: ComputeEnvelope;
  readonly envelopeDigest: string;
  readonly seed: string;
  readonly baselines: readonly BaselineRun[];
  /** One per component of the lifecycle run that some scenario targets; empty when it did not run. */
  readonly ablations: readonly ComponentAblation[];
}

/** The seeds every baseline's trials of `scenarioId` run under. */
export function scenarioSeeds(seed: string, scenarioId: string, repetitions: number): number[] {
  const { random } = createManualRuntimeServices({ randomSeed: `${seed}/${scenarioId}` });
  return Array.from({ length: repetitions }, () => Math.floor(random.next() * SEED_RANGE));
}

interface TrialCapture {
  agent?: ScenarioAgent;
  run?: RunResultBase;
  wallClockMilliseconds: number;
}

/** What every baseline run in one lane shares. */
interface LaneRun {
  readonly options: RunMemoryLifecycleSuiteOptions;
  readonly suite: MemoryScenarioSuite;
  readonly envelope: ComputeEnvelope;
  readonly seed: string;
  readonly recordedAt: string;
}

/** Which baseline to run, and for an ablation, with which components over which scenarios. */
interface BaselineSelection {
  readonly baseline: MemoryBaselineName;
  /** Defaults to every component the baseline has. */
  readonly components?: readonly StructuredComponent[] | undefined;
  /** Defaults to the whole suite. */
  readonly scenarioIds?: ReadonlySet<string> | undefined;
}

async function runBaseline(lane: LaneRun, selection: BaselineSelection): Promise<BaselineRun> {
  const { options, suite, envelope, seed, recordedAt } = lane;
  const { baseline, scenarioIds } = selection;
  const components = baselineComponents(baseline, selection.components);
  const monotonic = options.monotonic ?? createDefaultRuntimeServices().monotonic.now;
  const captures = new Map<string, TrialCapture>();
  const capture = (scenarioId: string, trial: number) => {
    const key = `${scenarioId}#${trial}`;
    let entry = captures.get(key);
    if (entry === undefined) {
      entry = { wallClockMilliseconds: 0 };
      captures.set(key, entry);
    }
    return entry;
  };
  const definition = memoryLifecycleEvaluator({
    baseline,
    components,
    lane: envelope.lane,
    suite,
    model: options.model,
    onTrial: (trial, scenario, agent) => {
      capture(scenario.id, trial.trial).agent = agent;
    },
  });
  const evaluator = await createEvaluator({
    configuration: definition.configuration,
    dataset: definition.dataset,
    scorers: definition.scorers,
  });
  const aggregates: TrialAggregate[] = [];
  const trials: TrialResult[] = [];
  const artifacts: ScenarioRunArtifact[] = [];
  let latencyMilliseconds = 0;
  for (const scenario of suite.scenarios.filter((entry) => scenarioIds?.has(entry.id) ?? true)) {
    const aggregate = await scoreTrials({
      evaluator,
      caseId: scenario.id,
      seeds: scenarioSeeds(seed, scenario.id, evaluator.configuration.repetitions),
      runResult: async (context, input) => {
        const entry = capture(scenario.id, context.trial);
        const started = monotonic();
        try {
          entry.run = await definition.subject(context).run(input).result();
          return entry.run;
        } finally {
          entry.wallClockMilliseconds = monotonic() - started;
          latencyMilliseconds += entry.wallClockMilliseconds;
        }
      },
    });
    aggregates.push(aggregate);
    for (const record of aggregate.trials) {
      const { agent, run, wallClockMilliseconds } = capture(scenario.id, record.trial);
      if (agent === undefined || run === undefined) continue;
      const verdict = summarizeTrial(record);
      const metrics = measureScenarioRun({
        scenario,
        trace: await observedTrace(agent.observation, scenario, baseline, envelope, components),
        run,
        envelope,
      });
      const artifact = await toScenarioRunArtifact({
        suite,
        scenario,
        baseline,
        components,
        envelope,
        trial: record.trial,
        seed: record.seed,
        observation: agent.observation,
        run,
        verdict,
        metrics,
        wallClockMilliseconds,
      });
      trials.push({
        scenarioId: scenario.id,
        trial: record.trial,
        seed: record.seed,
        artifactId: artifact.id,
        verdict,
        metrics,
        wallClockMilliseconds,
      });
      await agent.close();
      artifacts.push(artifact);
      await options.onArtifact?.(artifact);
    }
  }
  return {
    baseline,
    components,
    identity: evaluator.identity,
    configuration: evaluator.configuration,
    aggregates,
    record: toEvaluationRunRecord({
      id: `memory-lifecycle.${envelope.lane}.${baselineVariant(baseline, components)}`,
      recordedAt,
      evaluator,
      aggregates,
      latencyMilliseconds,
    }),
    trials,
    artifacts,
  };
}

/** The lifecycle run without each of its components in turn, over that component's targets. */
async function runAblations(
  lane: LaneRun,
  lifecycle: BaselineRun | undefined,
): Promise<ComponentAblation[]> {
  const ablations: ComponentAblation[] = [];
  const components = lifecycle?.components ?? [];
  for (const component of components) {
    const scenarioIds = componentScenarioIds(component, lane.suite.scenarios);
    if (scenarioIds.size === 0) continue;
    const run = await runBaseline(lane, {
      baseline: 'lifecycle',
      components: components.filter((entry) => entry !== component),
      scenarioIds,
    });
    ablations.push({ component, run });
  }
  return ablations;
}

/**
 * Runs every scenario against every requested baseline in one lane, and,
 * when the lifecycle architecture is among them, each of its ablations.
 */
export async function runMemoryLifecycleSuite(
  options: RunMemoryLifecycleSuiteOptions,
): Promise<MemoryLifecycleSuiteRun> {
  const lane: LaneRun = {
    options,
    suite: options.suite ?? memoryLifecycleSuite(),
    envelope: memoryLifecycleEnvelope(options.lane),
    seed: options.seed ?? `memory-lifecycle/${options.lane}`,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
  };
  const { suite, envelope, seed } = lane;
  const baselines: BaselineRun[] = [];
  for (const baseline of options.baselines ?? MEMORY_BASELINES) {
    baselines.push(await runBaseline(lane, { baseline }));
  }
  const ablations = await runAblations(
    lane,
    baselines.find((entry) => entry.baseline === 'lifecycle'),
  );
  return {
    suite,
    suiteDigest: await suiteDigest(suite),
    lane: options.lane,
    envelope,
    envelopeDigest: await envelopeDigest(envelope),
    seed,
    baselines,
    ablations,
  };
}
