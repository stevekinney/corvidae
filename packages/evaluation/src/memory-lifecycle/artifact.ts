/**
 * Scenario run artifacts and their replay (COR-755, "every scenario run
 * records evidence, transition, retrieval-plan, effective-context, provider,
 * tool, environment, and outcome revisions sufficient to replay a failure
 * without a live model").
 *
 * One artifact records one trial of one scenario against one baseline, with
 * the structured components it ran (fewer than all for an ablation). Each
 * section has its own revision (the SHA-256 of its canonical JSON), and the
 * artifact's digest covers every section except `measured`, which holds the
 * wall-clock time: a measurement of the host, never replayed.
 *
 * A replay needs no model. It resolves the suite, scenario, baseline
 * revision, and envelope the artifact names, prepares a fresh baseline with
 * the components the artifact names from the scenario's timeline under the
 * recorded seed, runs the scenario agent with the recorded model replies in
 * place of the model, re-scores the run, and rebuilds the artifact. The
 * recomputed digest either equals the stored one or the replay names every
 * field that differs.
 */
import { sha256Hex } from '@lostgradient/cryptography';
import { createScriptedGenerate, type RunResultBase } from '@lostgradient/operative';
import { z } from 'zod';

import { identifier } from '../configuration';
import { digestSchema } from '../evaluation-run';
import { createEvaluator } from '../evaluator';
import { canonicalJson } from '../identity';
import { differencesBetween, type ReplayDifference } from '../replay';
import type { TrialRecord } from '../trials';
import type { CaseEvaluation, CaseVerdict } from '../verdict';
import { createScenarioAgent, type ScenarioObservation } from './agent';
import {
  BASELINE_REVISIONS,
  baselineComponents,
  baselineVariant,
  MEMORY_BASELINES,
  type MemoryBaselineName,
  STRUCTURED_COMPONENTS,
  type StructuredComponent,
} from './baselines/adapter';
import {
  type ComputeEnvelope,
  envelopeDigest,
  MEMORY_LIFECYCLE_LANES,
  memoryLifecycleEnvelope,
  type MemoryLifecycleLane,
  SCENARIO_TOOLS,
} from './envelope';
import { ENVIRONMENT_REVISION } from './environment';
import { createScenarioRuntime, type HarnessTrace, traceScenario } from './harness';
import { memoryLifecycleEvaluator } from './memory-evaluator';
import { measureScenarioRun, type ScenarioMetrics } from './metrics';
import { renderTaskPrompt } from './prompt';
import type { MemoryScenario, MemoryScenarioSuite } from './scenarios';
import { memoryLifecycleSuite, scenarioDigest, suiteDigest } from './suite';

export const MEMORY_LIFECYCLE_ARTIFACT_SCHEMA_VERSION = 1 as const;

const exchangeSchema = z.strictObject({
  step: z.number().int().min(0),
  content: z.string(),
  toolCalls: z.array(
    z.strictObject({ id: z.string().optional(), name: identifier, arguments: z.json() }),
  ),
  usage: z
    .strictObject({
      prompt: z.number().int().min(0),
      completion: z.number().int().min(0),
      total: z.number().int().min(0),
    })
    .nullable(),
});

const REVISION_SECTIONS = [
  'evidence',
  'transitions',
  'retrievalPlan',
  'effectiveContext',
  'provider',
  'tools',
  'environment',
  'outcome',
] as const;

export const scenarioRunArtifactSchema = z.strictObject({
  kind: z.literal('memory-lifecycle-run'),
  schemaVersion: z.literal(MEMORY_LIFECYCLE_ARTIFACT_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,254}$/, 'Expected an artifact id'),
  suite: z.strictObject({ id: identifier, version: identifier, digest: digestSchema }),
  scenario: z.strictObject({ id: identifier, digest: digestSchema }),
  baseline: z.strictObject({
    name: z.enum(MEMORY_BASELINES),
    revision: identifier,
    components: z.array(z.enum(STRUCTURED_COMPONENTS)),
  }),
  lane: z.enum(MEMORY_LIFECYCLE_LANES),
  trial: z.number().int().positive(),
  seed: z.number().int().min(0).max(0xffff_ffff),
  envelope: z.strictObject({ digest: digestSchema, value: z.json() }),
  revisions: z.strictObject(
    Object.fromEntries(REVISION_SECTIONS.map((section) => [section, digestSchema])) as Record<
      (typeof REVISION_SECTIONS)[number],
      typeof digestSchema
    >,
  ),
  evidence: z.json(),
  transitions: z.json(),
  retrievalPlan: z.json(),
  effectiveContext: z.json(),
  provider: z.strictObject({ model: z.json(), exchanges: z.array(exchangeSchema) }),
  tools: z.json(),
  environment: z.json(),
  outcome: z.json(),
  /** Host measurements: reported, never digested, never replayed. */
  measured: z.strictObject({ wallClockMilliseconds: z.number().min(0) }),
  digest: digestSchema,
});

export type ScenarioRunArtifact = z.output<typeof scenarioRunArtifactSchema>;

export interface ScenarioRunArtifactInput {
  readonly suite: MemoryScenarioSuite;
  readonly scenario: MemoryScenario;
  readonly baseline: MemoryBaselineName;
  /** The structured components the baseline ran. */
  readonly components: readonly StructuredComponent[];
  readonly envelope: ComputeEnvelope;
  readonly trial: number;
  readonly seed: number;
  readonly observation: ScenarioObservation;
  readonly run: RunResultBase;
  readonly verdict: TrialVerdictSummary;
  readonly metrics: ScenarioMetrics;
  readonly wallClockMilliseconds: number;
}

/**
 * The trace a run observed, or, for a run whose model never recalled and so
 * never prepared its baseline, the trace re-derived from the scenario.
 */
export async function observedTrace(
  observation: ScenarioObservation,
  scenario: MemoryScenario,
  baseline: MemoryBaselineName,
  envelope: ComputeEnvelope,
  components?: readonly StructuredComponent[],
): Promise<HarnessTrace> {
  return observation.trace ?? (await traceScenario(scenario, baseline, envelope, components));
}

/** The id an artifact is stored and replayed by; `variant` is from {@link baselineVariant}. */
export function artifactId(
  lane: MemoryLifecycleLane,
  variant: string,
  scenarioId: string,
  trial: number,
): string {
  return `${lane}.${variant}.${scenarioId}.${trial}`;
}

function plain(value: unknown): z.output<ReturnType<typeof z.json>> {
  return JSON.parse(JSON.stringify(value ?? null));
}

/** How one trial was judged, whether it came from a trial record or a direct evaluation. */
export interface TrialVerdictSummary {
  readonly verdict: CaseVerdict;
  readonly criteria: readonly { readonly name: string; readonly score: number }[];
  /** The typed reason of an infrastructure failure, or `null`. */
  readonly infrastructureFailure: string | null;
}

export function summarizeTrial(
  record: Pick<TrialRecord, 'verdict' | 'criteria' | 'error'>,
): TrialVerdictSummary {
  return {
    verdict: record.verdict,
    criteria: record.criteria.map(({ name, score }) => ({ name, score })),
    infrastructureFailure: record.error?.reason ?? null,
  };
}

export function summarizeEvaluation(evaluation: CaseEvaluation): TrialVerdictSummary {
  switch (evaluation.verdict) {
    case 'pass':
    case 'fail':
      return summarizeTrial({ verdict: evaluation.verdict, criteria: evaluation.rubric.criteria });
    case 'agent-failed':
      return summarizeTrial({ verdict: evaluation.verdict, criteria: [] });
    case 'infrastructure-failure':
      return summarizeTrial({ verdict: evaluation.verdict, criteria: [], error: evaluation.error });
  }
}

/** The digest of an artifact: every section but `measured` and the digest itself. */
export function artifactDigest(artifact: Omit<ScenarioRunArtifact, 'digest'>): Promise<string> {
  const { measured: _measured, ...digested } = artifact;
  return sha256Hex(canonicalJson(digested));
}

/** Builds and digests one trial's artifact. */
export async function toScenarioRunArtifact(
  input: ScenarioRunArtifactInput,
): Promise<ScenarioRunArtifact> {
  const { suite, scenario, baseline, envelope, observation, run, verdict, metrics } = input;
  const trace = observation.trace;
  const sections = {
    evidence: plain(trace?.admissions ?? []),
    transitions: plain({ deletions: trace?.deletions ?? [], restarts: trace?.restarts ?? 0 }),
    retrievalPlan: plain(observation.recalls.map((recall) => recall.plan)),
    effectiveContext: plain(
      observation.recalls.map(({ records, withheld, truncated, contextTokens }) => ({
        records,
        withheld,
        truncated,
        contextTokens,
      })),
    ),
    provider: {
      model: plain(envelope.model),
      exchanges: z.array(exchangeSchema).parse(plain(observation.exchanges)),
    },
    tools: plain({
      definitions: SCENARIO_TOOLS,
      calls: run.steps.flatMap((step) =>
        step.toolCalls.map((call) => ({
          step: step.step,
          name: call.name,
          arguments: call.arguments,
          outcome: step.results.find((result) => result.callId === call.id)?.outcome ?? null,
        })),
      ),
    }),
    environment: plain({ revision: ENVIRONMENT_REVISION, state: observation.environment }),
    outcome: plain({
      finishReason: run.finishReason,
      content: run.content,
      ...verdict,
      metrics,
    }),
  };
  const revisions = Object.fromEntries(
    await Promise.all(
      REVISION_SECTIONS.map(async (section) => [
        section,
        await sha256Hex(canonicalJson(sections[section])),
      ]),
    ),
  ) as ScenarioRunArtifact['revisions'];
  const artifact = {
    kind: 'memory-lifecycle-run' as const,
    schemaVersion: MEMORY_LIFECYCLE_ARTIFACT_SCHEMA_VERSION,
    id: artifactId(
      envelope.lane,
      baselineVariant(baseline, input.components),
      scenario.id,
      input.trial,
    ),
    suite: { id: suite.id, version: suite.version, digest: await suiteDigest(suite) },
    scenario: { id: scenario.id, digest: await scenarioDigest(scenario) },
    baseline: {
      name: baseline,
      revision: BASELINE_REVISIONS[baseline],
      components: [...input.components],
    },
    lane: envelope.lane,
    trial: input.trial,
    seed: input.seed,
    envelope: { digest: await envelopeDigest(envelope), value: plain(envelope) },
    revisions,
    ...sections,
    measured: { wallClockMilliseconds: input.wallClockMilliseconds },
  };
  return { ...artifact, digest: await artifactDigest(artifact) };
}

export type ArtifactReplayOutcome =
  | { readonly result: 'match'; readonly artifactId: string; readonly digest: string }
  | {
      readonly result: 'mismatch';
      readonly artifactId: string;
      readonly storedDigest: string;
      readonly recomputedDigest: string;
      readonly differences: readonly ReplayDifference[];
    }
  | { readonly result: 'unresolvable'; readonly artifactId: string; readonly problem: string }
  | { readonly result: 'corrupt-artifact'; readonly problem: string };

/** The `memory-lifecycle replay` command's exit code for each outcome. */
export const MEMORY_LIFECYCLE_REPLAY_EXIT_CODES = {
  match: 0,
  mismatch: 4,
  unresolvable: 3,
  'corrupt-artifact': 65,
} as const satisfies Record<ArtifactReplayOutcome['result'], number>;

/**
 * Replays a stored artifact without a model. `suite` defaults to the
 * committed suite; the artifact must name its exact digest.
 */
export async function replayScenarioArtifact(
  input: unknown,
  options: { readonly suite?: MemoryScenarioSuite | undefined } = {},
): Promise<ArtifactReplayOutcome> {
  const parsed = scenarioRunArtifactSchema.safeParse(input);
  if (!parsed.success) {
    return {
      result: 'corrupt-artifact',
      problem: `Not a memory-lifecycle run artifact: ${parsed.error.issues[0]!.message}`,
    };
  }
  const stored = parsed.data;
  const { digest: storedDigest, ...unsigned } = stored;
  if ((await artifactDigest(unsigned)) !== storedDigest) {
    return {
      result: 'corrupt-artifact',
      problem: `Artifact "${stored.id}" does not match its digest`,
    };
  }
  const suite = options.suite ?? memoryLifecycleSuite();
  const unresolvable = (problem: string): ArtifactReplayOutcome => ({
    result: 'unresolvable',
    artifactId: stored.id,
    problem,
  });
  if ((await suiteDigest(suite)) !== stored.suite.digest) {
    return unresolvable(
      `The recorded suite "${stored.suite.id}" version "${stored.suite.version}" is not the suite at hand`,
    );
  }
  const scenario = suite.scenarios.find((entry) => entry.id === stored.scenario.id);
  if (scenario === undefined || (await scenarioDigest(scenario)) !== stored.scenario.digest) {
    return unresolvable(`The suite at hand has no scenario "${stored.scenario.id}" as recorded`);
  }
  const baseline = stored.baseline.name;
  if (BASELINE_REVISIONS[baseline] !== stored.baseline.revision) {
    return unresolvable(
      `Baseline "${baseline}" is now revision ${BASELINE_REVISIONS[baseline]}, not ${stored.baseline.revision}`,
    );
  }
  const envelope = memoryLifecycleEnvelope(stored.lane);
  if ((await envelopeDigest(envelope)) !== stored.envelope.digest) {
    return unresolvable(
      `The ${stored.lane} lane's envelope has changed since the artifact was recorded`,
    );
  }
  // The components the baseline runs when asked for the recorded ones: a claim it cannot honor mismatches.
  const components = baselineComponents(baseline, stored.baseline.components);
  const definition = memoryLifecycleEvaluator({
    baseline,
    components,
    lane: stored.lane,
    suite,
  });
  const evaluator = await createEvaluator({
    configuration: definition.configuration,
    dataset: definition.dataset,
    scorers: definition.scorers,
  });
  const built = createScenarioAgent({
    scenario,
    baseline,
    components,
    envelope,
    runtime: createScenarioRuntime(scenario, stored.seed),
    generate: createScriptedGenerate(
      stored.provider.exchanges.map(({ content, toolCalls, usage }) => ({
        kind: 'respond' as const,
        response: {
          content,
          toolCalls: toolCalls.map((call) => ({ ...call })),
          ...(usage === null ? {} : { usage }),
        },
      })),
    ),
  });
  const run = await built.agent.run(renderTaskPrompt(scenario.task)).result();
  await built.close();
  const verdict = summarizeEvaluation(await evaluator.evaluateCase(scenario.id, run));
  const recomputed = await toScenarioRunArtifact({
    suite,
    scenario,
    baseline,
    components,
    envelope,
    trial: stored.trial,
    seed: stored.seed,
    observation: built.observation,
    run,
    verdict,
    metrics: measureScenarioRun({
      scenario,
      trace: await observedTrace(built.observation, scenario, baseline, envelope, components),
      run,
      envelope,
    }),
    wallClockMilliseconds: stored.measured.wallClockMilliseconds,
  });
  if (recomputed.digest === storedDigest) {
    return { result: 'match', artifactId: stored.id, digest: storedDigest };
  }
  return {
    result: 'mismatch',
    artifactId: stored.id,
    storedDigest,
    recomputedDigest: recomputed.digest,
    differences: differencesBetween(
      JSON.parse(canonicalJson(stored)),
      JSON.parse(canonicalJson(recomputed)),
    ).filter((difference) => difference.path !== 'digest'),
  };
}
