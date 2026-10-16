/**
 * The compute-matched collaboration comparison (COR-818). One comparison
 * runs each dataset case under COR-820's three execution profiles, under one
 * predeclared resource envelope:
 *
 * - `direct-agent`: one strong Agent, the floor every other profile must
 *   beat. It is the single-sample baseline, retained but never the only
 *   control.
 * - `compute-matched-ensemble`: independent samples at the collaboration's
 *   participant count (or a declared equivalent compute), exchanging no
 *   messages, combined by an aggregation rule comparable to the
 *   collaboration's own synthesis: a deterministic majority vote, or one
 *   reducer that reads every sample.
 * - `collaboration`: the proposed `CollaborationPlan`, run by the caller's
 *   collaboration subject, which returns the final result and the run's
 *   trajectory. Nothing here dispatches a plan or adds an agent loop.
 *
 * Every profile's trials go through `scoreTrials`, the package's only case
 * executor, with the same recorded seeds, so each profile gets the same
 * evaluator verdicts, variance, and Wilson intervals as any other
 * evaluation. On top of that the comparison records, per trial: task
 * success against the case's success contract, cost, latency (from the
 * injected monotonic clock), tokens, tool calls, steps, the trajectory's
 * coordination metrics, failure labels, and cleanup state, and any breach of
 * the resource envelope.
 *
 * A comparison binds everything that could change its outcome: the declared
 * definition (each Agent's model, effort, definition and prompt revisions,
 * and tools; tool revisions; the data revision; concurrency; the compute
 * match; the aggregation and stopping rules; the cases), the three plans
 * (topology, context projections, commit authority, budgets, policy), the
 * evaluator's identity, the dataset's digest, and the trial count. The
 * binding's SHA-256 is the comparison's `revision`: change any input and the
 * evidence is a different revision, never a silent reuse.
 */
import { sha256Hex } from '@lostgradient/cryptography';
import {
  createDefaultRuntimeServices,
  type RunResultBase,
  type RuntimeServices,
} from '@lostgradient/operative';
import { z } from 'zod';

import {
  type CollaborationPlan,
  collaborationPlanDigest,
  collaborationPlanSchema,
  EXECUTION_PROFILES,
  type ExecutionProfile,
  type ResourceEnvelope,
  taskClassKey,
  taskClassSchema,
} from './collaboration-plan';
import {
  checkSuccessContract,
  COMPARISON_CONTROLS,
  type ComparisonCase,
  type ComparisonDataset,
  comparisonDatasetDigest,
  comparisonDatasetSchema,
  renderParticipantInput,
  shardFor,
  successContractKey,
  type SuccessHeuristics,
  toEvaluationDataset,
} from './comparison-datasets';
import {
  type ConfigurationIssue,
  EFFORTS,
  EvaluatorConfigurationError,
  identifier,
  reportDuplicates,
  unitInterval,
} from './configuration';
import { DISAGREEMENT_REASONS } from './disagreement';
import {
  AGGREGATE_OUTCOMES,
  CASE_VERDICTS,
  casePlacementFields,
  digestSchema,
  historicalRecordIdSchema,
  nonNegative,
  reportCasePlacementIssues,
  statisticsSchema,
  trialStatisticsFields,
} from './evaluation-run';
import type { Evaluator } from './evaluator';
import { canonicalJson } from './identity';
import {
  CLEANUP_STATES,
  cleanupReportSchema,
  type CleanupState,
  type CollaborationTrajectory,
  coordinationMetricsSchema,
  FAILURE_LABELS,
  failureOccurrenceSchema,
  measureTrajectory,
  parseCollaborationTrajectory,
  type TrajectoryEvent,
} from './trajectory';
import { scoreTrials, type TrialContext, type TrialRecord, type TrialSubject } from './trials';
import { summarizeProportion } from './variance';
import { AGENT_FAILURE_REASONS, INFRASTRUCTURE_FAILURE_REASONS } from './verdict';

/** The version of the comparison binding and result shapes this package writes. */
export const COMPARISON_SCHEMA_VERSION = 1;

/** Seeds are unsigned 32-bit integers. */
const SEED_RANGE = 0x1_0000_0000;
/** The 32-bit golden-ratio increment: consecutive sample seeds never collide. */
const GOLDEN_GAMMA = 0x9e_37_79_b9;
/** Cost comparisons this close to a ceiling are treated as on it, so float noise never breaches. */
const COST_TOLERANCE = 1e-9;

/** How the compute-matched ensemble aggregates its samples: a majority vote, or one reducer. */
export const AGGREGATION_KINDS = ['majority-vote', 'reducer'] as const;

/**
 * The resource-envelope ceilings a trial can breach. Breaches are recorded for
 * every profile's trials; only a collaboration trial's breach blocks admission.
 */
export const ENVELOPE_BREACHES = [
  'tokens',
  'cost',
  'wall-clock',
  'steps',
  'fan-out',
  'descendants',
] as const;

export type EnvelopeBreach = (typeof ENVELOPE_BREACHES)[number];

const count = z.number().int().min(0);
const seedSchema = z.number().int().min(0).max(0xffff_ffff);

const definitionShape = z.strictObject({
  id: historicalRecordIdSchema,
  /** Every Agent any plan's participants name, with what defines its behavior. */
  agents: z
    .array(
      z.strictObject({
        name: identifier,
        model: identifier,
        effort: z.enum(EFFORTS),
        definitionRevision: identifier,
        promptRevision: identifier,
        tools: z.array(identifier),
      }),
    )
    .min(1),
  tools: z.array(z.strictObject({ name: identifier, revision: identifier })),
  /** The revision of the data and fixtures the Agents read. */
  dataRevision: identifier,
  /** The most ensemble samples run at once. */
  concurrency: z.number().int().positive(),
  computeMatch: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('participant-count') }),
    z.strictObject({ kind: z.literal('equivalent-compute'), reason: identifier }),
  ]),
  aggregation: z.strictObject({
    kind: z.enum(AGGREGATION_KINDS),
    name: identifier,
    version: identifier,
  }),
  stoppingRule: z.strictObject({ name: identifier, version: identifier, description: identifier }),
  /** The dataset cases this comparison runs, in order. */
  caseIds: z.array(identifier).min(1),
});

/**
 * What a comparison declares before it runs: the Agents and tools with their
 * revisions, the data revision, ensemble concurrency, the compute match,
 * the aggregation and stopping rules, and the case ids.
 */
export const comparisonDefinitionSchema = definitionShape.superRefine((definition, context) => {
  reportDuplicates(
    definition.agents.map((agent) => agent.name),
    (index) => ['agents', index, 'name'],
    'agent',
    context,
  );
  reportDuplicates(
    definition.tools.map((tool) => tool.name),
    (index) => ['tools', index, 'name'],
    'tool',
    context,
  );
  const tools = new Set(definition.tools.map((tool) => tool.name));
  for (const [index, agent] of definition.agents.entries()) {
    for (const [position, tool] of agent.tools.entries()) {
      if (!tools.has(tool)) {
        context.addIssue({
          code: 'custom',
          path: ['agents', index, 'tools', position],
          message: `Tool "${tool}" has no bound revision`,
        });
      }
    }
  }
  reportDuplicates(definition.caseIds, (index) => ['caseIds', index], 'case id', context);
});

export type ComparisonDefinition = z.output<typeof comparisonDefinitionSchema>;

/**
 * Where a bound case sits in the dataset version: a held-out case by ordinal
 * alone, a public one with its id too. The binding never names a held-out
 * case, so no evidence built from it can.
 */
const boundCaseSchema = z.strictObject(casePlacementFields).superRefine(reportCasePlacementIssues);

const profilePlansSchema = z.strictObject({
  'direct-agent': collaborationPlanSchema,
  'compute-matched-ensemble': collaborationPlanSchema,
  collaboration: collaborationPlanSchema,
});

export type ProfilePlans = z.output<typeof profilePlansSchema>;

/** Everything that could change a comparison's result; its SHA-256 is the comparison revision. */
export const comparisonBindingSchema = z.strictObject({
  schemaVersion: z.literal(COMPARISON_SCHEMA_VERSION),
  /** The declared definition, with its cases bound by placement in `cases`. */
  definition: definitionShape.omit({ caseIds: true }),
  cases: z.array(boundCaseSchema).min(1),
  plans: profilePlansSchema,
  evaluator: z.strictObject({
    name: identifier,
    revision: z.number().int().positive(),
    digest: digestSchema,
  }),
  dataset: z.strictObject({ id: identifier, version: identifier, digest: digestSchema }),
  /** Trials per case per profile: the evaluator's repetitions. */
  trials: z.number().int().positive(),
});

export type ComparisonBinding = z.output<typeof comparisonBindingSchema>;

export const profileTrialSchema = z.strictObject({
  trial: z.number().int().positive(),
  seed: seedSchema,
  /** Each ensemble sample's seed, then the reducer's; empty for the other profiles. */
  sampleSeeds: z.array(seedSchema),
  verdict: z.enum(CASE_VERDICTS),
  /** `null` when the run rejected instead of finishing. */
  finishReason: z.enum(['stop-condition', ...AGENT_FAILURE_REASONS]).nullable(),
  /** The case's success contract; `null` when the run rejected. */
  taskSuccess: z.boolean().nullable(),
  /** `null` when any run in the trial carried no cost estimate. */
  costUsd: nonNegative.nullable(),
  latencyMilliseconds: nonNegative.nullable(),
  tokens: nonNegative.nullable(),
  toolCalls: count.nullable(),
  steps: count.nullable(),
  coordination: coordinationMetricsSchema.nullable(),
  failures: z.array(failureOccurrenceSchema),
  cleanup: cleanupReportSchema.nullable(),
  envelopeBreaches: z.array(z.enum(ENVELOPE_BREACHES)),
  /** The typed reason of an evaluator infrastructure failure, never its message. */
  error: z.enum(INFRASTRUCTURE_FAILURE_REASONS).nullable(),
});

export type ProfileTrial = z.output<typeof profileTrialSchema>;

/**
 * Every total is taken over the trials whose run finished, which
 * `trialsWithRuns` counts. When none finished, nothing was observed, so each
 * total is `null`: never a measured zero, and never a measured absence.
 */
export const profileTotalsSchema = z.strictObject({
  /** Trials whose run finished, so their metrics exist. */
  trialsWithRuns: count,
  /** Summed over those trials; `null` when any lacks a cost estimate or none ran. */
  costUsd: nonNegative.nullable(),
  latencyMillisecondsMean: nonNegative.nullable(),
  tokens: nonNegative.nullable(),
  toolCalls: count.nullable(),
  steps: count.nullable(),
  coordinationTokens: count.nullable(),
  coordinationTurns: count.nullable(),
  ungovernedWrites: count.nullable(),
  duplicateWork: count.nullable(),
  /** Averaged over trials that sent messages; `null` when none did or none ran. */
  messageNovelty: unitInterval.nullable(),
  correctedFalseClaims: count.nullable(),
  unresolvedContradictions: count.nullable(),
  staleReads: count.nullable(),
  retries: count.nullable(),
  replans: count.nullable(),
  propagatedFaults: count.nullable(),
  /** The worst cleanup state of any trial: abandoned, then detached, then quiescent. */
  cleanup: z.enum(CLEANUP_STATES).nullable(),
  failureLabels: z
    .array(z.strictObject({ label: z.enum(FAILURE_LABELS), count: z.number().int().positive() }))
    .nullable(),
  envelopeBreaches: z
    .array(
      z.strictObject({ breach: z.enum(ENVELOPE_BREACHES), count: z.number().int().positive() }),
    )
    .nullable(),
});

export type ProfileTotals = z.output<typeof profileTotalsSchema>;

export const profileResultSchema = z.strictObject({
  profile: z.enum(EXECUTION_PROFILES),
  plan: z.strictObject({
    planId: identifier,
    planRevision: z.number().int().positive(),
    digest: digestSchema,
  }),
  /** The evaluator's aggregate outcome over the trials. */
  outcome: z.enum(AGGREGATE_OUTCOMES),
  disagreementReasons: z.array(z.enum(DISAGREEMENT_REASONS)),
  /** Passes of the success contract among trials whose run finished. */
  taskSuccess: z.strictObject(trialStatisticsFields),
  /** The evaluator's verdicts: passes among trials that produced one. */
  verifierAcceptance: z.strictObject(trialStatisticsFields),
  criteria: statisticsSchema.shape.criteria,
  totals: profileTotalsSchema,
  trials: z.array(profileTrialSchema).min(1),
});

export type ProfileResult = z.output<typeof profileResultSchema>;

export const caseComparisonSchema = z
  .strictObject({
    ...casePlacementFields,
    taskClass: taskClassSchema,
    controls: z.array(z.enum(COMPARISON_CONTROLS)),
    /** One per trial, shared by every profile. */
    seeds: z.array(seedSchema).min(1),
    profiles: z.strictObject({
      'direct-agent': profileResultSchema,
      'compute-matched-ensemble': profileResultSchema,
      collaboration: profileResultSchema,
    }),
  })
  .superRefine(reportCasePlacementIssues);

export type CaseComparison = z.output<typeof caseComparisonSchema>;

/** A finished comparison: its revision, its binding, and every case's three profile results. */
export const comparisonResultSchema = z.strictObject({
  /** The SHA-256 of the binding's canonical JSON. */
  revision: digestSchema,
  binding: comparisonBindingSchema,
  cases: z.array(caseComparisonSchema).min(1),
});

export type ComparisonResult = z.output<typeof comparisonResultSchema>;

/** What a direct Agent or one ensemble sample or reducer is told about its trial. */
export interface ParticipantContext extends TrialContext {
  /** The participant's `agentName` in its profile's plan. */
  readonly participant: string;
}

/** What the collaboration subject is told about its trial. */
export interface CollaborationContext extends TrialContext {
  readonly plan: CollaborationPlan;
  /** Each participant's input: a producer sees its round-robin shard, everyone else the task alone. */
  readonly inputs: Readonly<Record<string, string>>;
}

/** One finished collaboration run. */
export interface CollaborationRun {
  /** The committed result, with usage, steps, and cost covering every participant. */
  readonly result: RunResultBase;
  /** The run's trajectory, validated with `collaborationTrajectorySchema`. */
  readonly trajectory: unknown;
}

/** How each profile's runs are produced. None of them may see the case's id or expected answer. */
export interface ComparisonSubjects {
  readonly direct: (context: ParticipantContext) => TrialSubject;
  readonly ensembleSample: (context: ParticipantContext) => TrialSubject;
  /** Required with `reducer` aggregation: it reads every sample's answer and gives the final one. */
  readonly ensembleReducer?: ((context: ParticipantContext) => TrialSubject) | undefined;
  readonly collaboration: (context: CollaborationContext) => Promise<CollaborationRun>;
}

export interface BindComparisonOptions {
  readonly definition: unknown;
  readonly plans: {
    readonly direct: unknown;
    readonly ensemble: unknown;
    readonly collaboration: unknown;
  };
  readonly dataset: unknown;
  readonly evaluator: Evaluator;
  readonly successHeuristics?: SuccessHeuristics | undefined;
}

export interface RunComparisonOptions extends BindComparisonOptions {
  readonly subjects: ComparisonSubjects;
  /** Seeds and the latency clock. Defaults to the real-globals runtime services. */
  readonly runtime?: Pick<RuntimeServices, 'random' | 'monotonic'> | undefined;
  /** Seeds recorded by earlier evidence, keyed by case id, replayed instead of drawn. */
  readonly seeds?: Readonly<Record<string, readonly number[]>> | undefined;
}

/** A validated comparison: its binding and revision, the parsed dataset, and the cases to run. */
export interface BoundComparison {
  readonly binding: ComparisonBinding;
  readonly revision: string;
  readonly dataset: ComparisonDataset;
  readonly caseIds: readonly string[];
}

const PLAN_KEYS = {
  direct: 'direct-agent',
  ensemble: 'compute-matched-ensemble',
  collaboration: 'collaboration',
} as const satisfies Record<keyof BindComparisonOptions['plans'], ExecutionProfile>;

type PlanKey = keyof typeof PLAN_KEYS;

const SHARED_PLAN_FIELDS = ['task', 'taskClass', 'policyVersion', 'resourceEnvelope'] as const;

function collect<T>(
  schema: z.ZodType<T>,
  input: unknown,
  path: readonly PropertyKey[],
  issues: ConfigurationIssue[],
): T | undefined {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) {
    issues.push({ path: [...path, ...issue.path], message: issue.message });
  }
  return undefined;
}

function checkPlans(plans: Record<PlanKey, CollaborationPlan>, issues: ConfigurationIssue[]): void {
  for (const [key, profile] of Object.entries(PLAN_KEYS)) {
    const plan = plans[key as PlanKey];
    if (plan.executionProfile !== profile) {
      issues.push({
        path: ['plans', key, 'executionProfile'],
        message: `The ${key} plan runs the ${profile} profile, not ${plan.executionProfile}`,
      });
    }
  }
  for (const key of ['direct', 'ensemble'] as const) {
    for (const field of SHARED_PLAN_FIELDS) {
      if (canonicalJson(plans[key][field]) !== canonicalJson(plans.collaboration[field])) {
        issues.push({
          path: ['plans', key, field],
          message: `Every profile shares the collaboration plan's ${field}`,
        });
      }
    }
  }
}

function checkEnsemble(
  definition: ComparisonDefinition,
  plans: Record<PlanKey, CollaborationPlan>,
  issues: ConfigurationIssue[],
): void {
  const { ensemble, collaboration } = plans;
  const path = ['plans', 'ensemble', 'participants'];
  if (ensemble.topology.edges.length > 0) {
    issues.push({
      path: ['plans', 'ensemble', 'topology', 'edges'],
      message: 'A compute-matched ensemble exchanges no messages, so it has no edges',
    });
  }
  const producers = ensemble.participants.filter((entry) => entry.role === 'producer').length;
  const reducers = ensemble.participants.filter((entry) => entry.role === 'reducer').length;
  if (producers === 0 || producers + reducers !== ensemble.participants.length) {
    issues.push({
      path,
      message: 'An ensemble is independent producers plus, for reducer aggregation, one reducer',
    });
  }
  const { aggregation, computeMatch } = definition;
  const expected = aggregation.kind === 'reducer' ? 1 : 0;
  if (reducers !== expected) {
    issues.push({
      path,
      message: `${aggregation.kind} aggregation takes ${expected} reducer participants, not ${reducers}`,
    });
  }
  const matched = collaboration.participants.length;
  if (computeMatch.kind === 'participant-count' && ensemble.participants.length !== matched) {
    issues.push({
      path,
      message: `A participant-count match needs ${matched} ensemble participants, not ${ensemble.participants.length}`,
    });
  }
  if (definition.concurrency > collaboration.resourceEnvelope.fanOut) {
    issues.push({
      path: ['definition', 'concurrency'],
      message: `Concurrency ${definition.concurrency} exceeds the envelope's fan-out of ${collaboration.resourceEnvelope.fanOut}`,
    });
  }
}

function checkAgents(
  definition: ComparisonDefinition,
  plans: Record<PlanKey, CollaborationPlan>,
  issues: ConfigurationIssue[],
): void {
  const agents = new Set(definition.agents.map((agent) => agent.name));
  for (const key of Object.keys(PLAN_KEYS) as PlanKey[]) {
    for (const [index, participant] of plans[key].participants.entries()) {
      if (!agents.has(participant.agentName)) {
        issues.push({
          path: ['plans', key, 'participants', index, 'agentName'],
          message: `Participant "${participant.agentName}" is not bound to an Agent definition`,
        });
      }
    }
  }
}

function checkCases(
  options: BindComparisonOptions,
  definition: ComparisonDefinition,
  dataset: ComparisonDataset,
  plan: CollaborationPlan,
  issues: ConfigurationIssue[],
): void {
  if (canonicalJson(options.evaluator.dataset) !== canonicalJson(toEvaluationDataset(dataset))) {
    issues.push({
      path: ['evaluator', 'dataset'],
      message:
        'The evaluator must score this comparison dataset, as toEvaluationDataset projects it',
    });
  }
  const planClass = taskClassKey(plan.taskClass);
  const heuristics = options.successHeuristics ?? {};
  for (const [index, caseId] of definition.caseIds.entries()) {
    const path = ['definition', 'caseIds', index];
    const entry = dataset.cases.find((candidate) => candidate.id === caseId);
    if (entry === undefined) {
      issues.push({ path, message: `Unknown comparison case "${caseId}"` });
      continue;
    }
    const caseClass = taskClassKey(entry.taskClass);
    if (caseClass !== planClass) {
      issues.push({
        path,
        message: `Case "${caseId}" is a ${caseClass} task, but the plans are for ${planClass}`,
      });
    }
    const key = successContractKey(entry.successContract);
    if (entry.successContract.kind === 'heuristic' && heuristics[key] === undefined) {
      issues.push({ path, message: `Case "${caseId}" needs the success heuristic "${key}"` });
    }
  }
}

/**
 * Validates a comparison and computes its binding and revision without
 * running anything. Every problem is collected into one
 * {@link EvaluatorConfigurationError}.
 */
export async function bindComparison(options: BindComparisonOptions): Promise<BoundComparison> {
  const issues: ConfigurationIssue[] = [];
  const definition = collect(
    comparisonDefinitionSchema,
    options.definition,
    ['definition'],
    issues,
  );
  const dataset = collect(comparisonDatasetSchema, options.dataset, ['dataset'], issues);
  const plans: Partial<Record<PlanKey, CollaborationPlan>> = {};
  for (const key of Object.keys(PLAN_KEYS) as PlanKey[]) {
    const plan = collect(collaborationPlanSchema, options.plans[key], ['plans', key], issues);
    if (plan !== undefined) plans[key] = plan;
  }
  if (issues.length > 0) throw new EvaluatorConfigurationError(issues);
  const parsedDefinition = definition as ComparisonDefinition;
  const parsedDataset = dataset as ComparisonDataset;
  const parsedPlans = plans as Record<PlanKey, CollaborationPlan>;
  checkPlans(parsedPlans, issues);
  checkEnsemble(parsedDefinition, parsedPlans, issues);
  checkAgents(parsedDefinition, parsedPlans, issues);
  checkCases(options, parsedDefinition, parsedDataset, parsedPlans.collaboration, issues);
  if (issues.length > 0) throw new EvaluatorConfigurationError(issues);

  const { configuration, identity } = options.evaluator;
  const { caseIds, ...declared } = parsedDefinition;
  const binding: ComparisonBinding = {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    definition: declared,
    cases: caseIds.map((caseId) => placementOf(parsedDataset, caseId)),
    plans: {
      'direct-agent': parsedPlans.direct,
      'compute-matched-ensemble': parsedPlans.ensemble,
      collaboration: parsedPlans.collaboration,
    },
    evaluator: identity,
    dataset: {
      id: parsedDataset.id,
      version: parsedDataset.version,
      digest: await comparisonDatasetDigest(parsedDataset),
    },
    trials: configuration.repetitions,
  };
  return {
    binding,
    revision: await sha256Hex(canonicalJson(binding)),
    dataset: parsedDataset,
    caseIds,
  };
}

/** A case's placement: its 1-based ordinal and visibility, and its id only when public. */
function placementOf(dataset: ComparisonDataset, caseId: string): z.output<typeof boundCaseSchema> {
  const position = dataset.cases.findIndex((candidate) => candidate.id === caseId);
  const { visibility } = dataset.cases[position] as ComparisonCase;
  return { ordinal: position + 1, visibility, ...(visibility === 'public' ? { caseId } : {}) };
}

/** Sample `index`'s seed: the trial's own seed for the first, then one golden-ratio step each. */
export function sampleSeed(seed: number, index: number): number {
  return (seed + Math.imul(index, GOLDEN_GAMMA)) >>> 0;
}

/** What one trial of one profile produced before it was scored. */
interface TrialRun {
  readonly result: RunResultBase;
  /** Every run the trial made: one, or each sample and the reducer. */
  readonly runs: readonly RunResultBase[];
  readonly trajectory: CollaborationTrajectory;
  readonly sampleSeeds: readonly number[];
}

interface TrialCapture extends TrialRun {
  readonly latencyMilliseconds: number;
}

type ProfileExecutor = (context: TrialContext) => Promise<TrialRun>;

function finishOutcome(result: RunResultBase): 'completed' | 'failed' | 'cancelled' {
  if (result.finishReason === 'stop-condition') return 'completed';
  return result.finishReason === 'aborted' ? 'cancelled' : 'failed';
}

/** The trajectory of independent runs that exchange nothing: each starts, works, and finishes. */
function independentTrajectory(
  batches: readonly (readonly { participant: string; result: RunResultBase; unit: string }[])[],
): TrajectoryEvent[] {
  return batches.flatMap((batch) => [
    ...batch.map((run): TrajectoryEvent => ({
      type: 'participant-started',
      participant: run.participant,
    })),
    ...batch.map((run): TrajectoryEvent => ({
      type: 'work',
      participant: run.participant,
      unit: run.unit,
    })),
    ...batch.map((run): TrajectoryEvent => ({
      type: 'participant-finished',
      participant: run.participant,
      outcome: finishOutcome(run.result),
    })),
  ]);
}

function sumUsage(runs: readonly RunResultBase[]): RunResultBase['usage'] {
  return {
    prompt: runs.reduce((sum, run) => sum + run.usage.prompt, 0),
    completion: runs.reduce((sum, run) => sum + run.usage.completion, 0),
    total: runs.reduce((sum, run) => sum + run.usage.total, 0),
  };
}

/** The ensemble's scored result: the chosen answer, over every run's steps and usage. */
function combineRuns(runs: readonly RunResultBase[], chosen: RunResultBase): RunResultBase {
  return {
    conversation: chosen.conversation,
    steps: runs.flatMap((run) => run.steps),
    content: chosen.content,
    usage: sumUsage(runs),
    finishReason: chosen.finishReason,
    ...(chosen.error === undefined ? {} : { error: chosen.error }),
  };
}

/**
 * The deterministic majority vote: the trimmed answer most completed samples
 * gave, ties going to the answer given first. With no completed sample, the
 * first sample stands, so the ensemble fails the way it actually failed.
 */
export function majorityVote(samples: readonly RunResultBase[]): number {
  const tally = new Map<string, { first: number; votes: number }>();
  for (const [index, sample] of samples.entries()) {
    if (sample.finishReason !== 'stop-condition') continue;
    const key = sample.content.trim();
    const entry = tally.get(key);
    if (entry === undefined) tally.set(key, { first: index, votes: 1 });
    else entry.votes += 1;
  }
  let best: { first: number; votes: number } | undefined;
  for (const entry of tally.values()) {
    if (best === undefined || entry.votes > best.votes) best = entry;
  }
  return best?.first ?? 0;
}

/** The reducer's input: the task, then every sample's answer in sample order. */
function candidatesInput(entry: ComparisonCase, samples: readonly RunResultBase[]): string {
  const lines = samples.map((sample, index) => `${index + 1}. ${sample.content.trim()}`);
  return `${entry.input}\n\nCandidate answers:\n${lines.join('\n')}`;
}

function directExecutor(
  plan: CollaborationPlan,
  entry: ComparisonCase,
  subjects: ComparisonSubjects,
): ProfileExecutor {
  const participant = (plan.participants[0] as CollaborationPlan['participants'][number]).agentName;
  const input = renderParticipantInput(entry, entry.views.direct);
  return async (context) => {
    const result = await subjects
      .direct({ ...context, participant })
      .run(input)
      .result();
    return {
      result,
      runs: [result],
      trajectory: independentTrajectory([[{ participant, result, unit: 'complete-solution' }]]),
      sampleSeeds: [],
    };
  };
}

function ensembleExecutor(
  plan: CollaborationPlan,
  definition: ComparisonBinding['definition'],
  entry: ComparisonCase,
  subjects: ComparisonSubjects,
): ProfileExecutor {
  const producers = plan.participants.filter((participant) => participant.role === 'producer');
  const reducer = plan.participants.find((participant) => participant.role === 'reducer');
  const { concurrency } = definition;
  return async ({ trial, seed }) => {
    const seeds = plan.participants.map((_, index) => sampleSeed(seed, index));
    const samples: RunResultBase[] = [];
    const batches: { participant: string; result: RunResultBase; unit: string }[][] = [];
    for (let start = 0; start < producers.length; start += concurrency) {
      const batch = producers.slice(start, start + concurrency);
      // Every sample in a batch settles before the trial moves on, so none is abandoned.
      const settled = await Promise.allSettled(
        batch.map(async ({ agentName }, offset) => {
          const index = start + offset;
          const input = renderParticipantInput(entry, shardFor(entry, index));
          const context = { trial, seed: seeds[index] as number, participant: agentName };
          return subjects.ensembleSample(context).run(input).result();
        }),
      );
      const results = settled.map((outcome) => {
        if (outcome.status === 'rejected') throw outcome.reason;
        return outcome.value;
      });
      samples.push(...results);
      batches.push(
        results.map((result, offset) => ({
          participant: (batch[offset] as (typeof batch)[number]).agentName,
          result,
          unit: 'complete-solution',
        })),
      );
    }
    if (reducer === undefined) {
      const chosen = samples[majorityVote(samples)] as RunResultBase;
      return {
        result: combineRuns(samples, chosen),
        runs: samples,
        trajectory: independentTrajectory(batches),
        sampleSeeds: seeds,
      };
    }
    const reduce = subjects.ensembleReducer as NonNullable<ComparisonSubjects['ensembleReducer']>;
    const reducerSeed = seeds[producers.length] as number;
    const context = { trial, seed: reducerSeed, participant: reducer.agentName };
    const reduced = await reduce(context).run(candidatesInput(entry, samples)).result();
    const runs = [...samples, reduced];
    batches.push([{ participant: reducer.agentName, result: reduced, unit: 'aggregation' }]);
    return {
      result: combineRuns(runs, reduced),
      runs,
      trajectory: independentTrajectory(batches),
      sampleSeeds: seeds,
    };
  };
}

function collaborationExecutor(
  plan: CollaborationPlan,
  entry: ComparisonCase,
  subjects: ComparisonSubjects,
): ProfileExecutor {
  let producer = 0;
  const inputs = Object.fromEntries(
    plan.participants.map((participant) => [
      participant.agentName,
      renderParticipantInput(
        entry,
        participant.role === 'producer' ? shardFor(entry, producer++) : [],
      ),
    ]),
  );
  return async (context) => {
    const run = await subjects.collaboration({ ...context, plan, inputs });
    const trajectory = parseCollaborationTrajectory(run.trajectory);
    return { result: run.result, runs: [run.result], trajectory, sampleSeeds: [] };
  };
}

function sumCost(runs: readonly RunResultBase[]): number | null {
  let total = 0;
  for (const run of runs) {
    if (run.costEstimate === undefined) return null;
    total += run.costEstimate.totalCost;
  }
  return total;
}

function breachesOf(
  envelope: ResourceEnvelope,
  measured: {
    readonly tokens: number;
    readonly costUsd: number | null;
    readonly latencyMilliseconds: number;
    readonly steps: number;
    readonly started: number;
    readonly maximumConcurrent: number;
  },
): EnvelopeBreach[] {
  const breaches: EnvelopeBreach[] = [];
  if (measured.tokens > envelope.tokens) breaches.push('tokens');
  if (measured.costUsd !== null && measured.costUsd * 100 > envelope.costCents + COST_TOLERANCE) {
    breaches.push('cost');
  }
  if (measured.latencyMilliseconds > envelope.wallClockMilliseconds) breaches.push('wall-clock');
  if (measured.steps > envelope.steps) breaches.push('steps');
  if (measured.maximumConcurrent > envelope.fanOut) breaches.push('fan-out');
  if (measured.started > envelope.maximumDescendants) breaches.push('descendants');
  return breaches;
}

function toProfileTrial(
  record: TrialRecord,
  capture: TrialCapture | undefined,
  plan: CollaborationPlan,
  entry: ComparisonCase,
  heuristics: SuccessHeuristics,
): ProfileTrial {
  const base = {
    trial: record.trial,
    seed: record.seed,
    verdict: record.verdict,
    finishReason: record.finishReason ?? null,
    error: record.error?.reason ?? null,
  };
  if (capture === undefined) {
    return {
      ...base,
      sampleSeeds: [],
      taskSuccess: null,
      costUsd: null,
      latencyMilliseconds: null,
      tokens: null,
      toolCalls: null,
      steps: null,
      coordination: null,
      failures: [],
      cleanup: null,
      envelopeBreaches: [],
    };
  }
  const { result, runs, latencyMilliseconds } = capture;
  const taskSuccess =
    result.finishReason === 'stop-condition' &&
    checkSuccessContract(entry.successContract, result.content, heuristics);
  const measurement = measureTrajectory(plan, capture.trajectory);
  const failures = [...measurement.failures];
  if (!taskSuccess && measurement.lastVerdict === 'accepted') {
    failures.push({
      label: 'missing-or-incorrect-verification',
      participant: null,
      event: null,
      evidence: 'An in-run verifier accepted a result that fails the success contract',
    });
  }
  const tokens = runs.reduce((sum, run) => sum + run.usage.total, 0);
  const steps = runs.reduce((sum, run) => sum + run.steps.length, 0);
  const toolCalls = runs.reduce(
    (sum, run) => sum + run.steps.reduce((calls, step) => calls + step.toolCalls.length, 0),
    0,
  );
  const costUsd = sumCost(runs);
  return {
    ...base,
    sampleSeeds: [...capture.sampleSeeds],
    taskSuccess,
    costUsd,
    latencyMilliseconds,
    tokens,
    toolCalls,
    steps,
    coordination: measurement.coordination,
    failures,
    cleanup: measurement.cleanup,
    envelopeBreaches: breachesOf(plan.resourceEnvelope, {
      tokens,
      costUsd,
      latencyMilliseconds,
      steps,
      ...measurement.participants,
    }),
  };
}

const CLEANUP_SEVERITY: readonly CleanupState[] = ['abandoned', 'detached', 'quiescent'];

type MeasuredTrial = ProfileTrial & {
  readonly coordination: NonNullable<ProfileTrial['coordination']>;
  readonly cleanup: NonNullable<ProfileTrial['cleanup']>;
  readonly latencyMilliseconds: number;
  readonly tokens: number;
  readonly toolCalls: number;
  readonly steps: number;
};

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countOccurrences<T extends string>(
  names: readonly T[],
  occurrences: readonly T[],
): { readonly name: T; readonly count: number }[] {
  return names
    .map((name) => ({ name, count: occurrences.filter((entry) => entry === name).length }))
    .filter((entry) => entry.count > 0);
}

const UNMEASURED_TOTALS: ProfileTotals = {
  trialsWithRuns: 0,
  costUsd: null,
  latencyMillisecondsMean: null,
  tokens: null,
  toolCalls: null,
  steps: null,
  coordinationTokens: null,
  coordinationTurns: null,
  ungovernedWrites: null,
  duplicateWork: null,
  messageNovelty: null,
  correctedFalseClaims: null,
  unresolvedContradictions: null,
  staleReads: null,
  retries: null,
  replans: null,
  propagatedFaults: null,
  cleanup: null,
  failureLabels: null,
  envelopeBreaches: null,
};

/**
 * One profile's metrics for one case, summed (or averaged, where named) over
 * the trials whose run finished; every total is `null` when none did.
 */
export function totalsOf(trials: readonly ProfileTrial[]): ProfileTotals {
  const measured = trials.filter((trial): trial is MeasuredTrial => trial.coordination !== null);
  if (measured.length === 0) return { ...UNMEASURED_TOTALS };
  const sum = (metric: (trial: MeasuredTrial) => number): number =>
    measured.reduce((total, trial) => total + metric(trial), 0);
  const costs = measured.map((trial) => trial.costUsd);
  const novelty = measured.flatMap((trial) => {
    const value = trial.coordination.messageNovelty;
    return value === null ? [] : [value];
  });
  const states = new Set(measured.map((trial) => trial.cleanup.state));
  return {
    trialsWithRuns: measured.length,
    costUsd: costs.includes(null)
      ? null
      : (costs as number[]).reduce((total, cost) => total + cost, 0),
    latencyMillisecondsMean: mean(measured.map((trial) => trial.latencyMilliseconds)),
    tokens: sum((trial) => trial.tokens),
    toolCalls: sum((trial) => trial.toolCalls),
    steps: sum((trial) => trial.steps),
    coordinationTokens: sum((trial) => trial.coordination.coordinationTokens),
    coordinationTurns: sum((trial) => trial.coordination.coordinationTurns),
    ungovernedWrites: sum((trial) => trial.coordination.ungovernedWrites),
    duplicateWork: sum((trial) => trial.coordination.duplicateWork),
    messageNovelty: mean(novelty),
    correctedFalseClaims: sum((trial) => trial.coordination.correctedFalseClaims),
    unresolvedContradictions: sum((trial) => trial.coordination.unresolvedContradictions),
    staleReads: sum((trial) => trial.coordination.staleReads),
    retries: sum((trial) => trial.coordination.retries),
    replans: sum((trial) => trial.coordination.replans),
    propagatedFaults: sum((trial) => trial.coordination.propagatedFaults),
    cleanup: CLEANUP_SEVERITY.find((state) => states.has(state)) ?? null,
    failureLabels: countOccurrences(
      FAILURE_LABELS,
      measured.flatMap((trial) => trial.failures.map((failure) => failure.label)),
    ).map(({ name, count: occurrences }) => ({ label: name, count: occurrences })),
    envelopeBreaches: countOccurrences(
      ENVELOPE_BREACHES,
      measured.flatMap((trial) => trial.envelopeBreaches),
    ).map(({ name, count: occurrences }) => ({ breach: name, count: occurrences })),
  };
}

interface ProfileRunOptions {
  readonly profile: ExecutionProfile;
  readonly plan: CollaborationPlan;
  readonly entry: ComparisonCase;
  readonly seeds: readonly number[];
  readonly executor: ProfileExecutor;
}

async function runProfile(
  options: RunComparisonOptions,
  monotonic: RuntimeServices['monotonic'],
  run: ProfileRunOptions,
): Promise<ProfileResult> {
  const { profile, plan, entry } = run;
  const captures = new Map<number, TrialCapture>();
  const aggregate = await scoreTrials({
    evaluator: options.evaluator,
    caseId: entry.id,
    seeds: run.seeds,
    runResult: async (context) => {
      const started = monotonic.now();
      const trialRun = await run.executor(context);
      captures.set(context.trial, { ...trialRun, latencyMilliseconds: monotonic.now() - started });
      return trialRun.result;
    },
  });
  const heuristics = options.successHeuristics ?? {};
  const trials = aggregate.trials.map((record) =>
    toProfileTrial(record, captures.get(record.trial), plan, entry, heuristics),
  );
  const successes = trials.flatMap((trial) =>
    trial.taskSuccess === null ? [] : [trial.taskSuccess],
  );
  return {
    profile,
    plan: {
      planId: plan.planId,
      planRevision: plan.planRevision,
      digest: await collaborationPlanDigest(plan),
    },
    outcome: aggregate.outcome,
    disagreementReasons:
      aggregate.outcome === 'disagreement' ? [...aggregate.disagreement.reasons] : [],
    taskSuccess: summarizeProportion(successes.filter(Boolean).length, successes.length),
    verifierAcceptance: aggregate.statistics.verdicts,
    criteria: [...aggregate.statistics.criteria],
    totals: totalsOf(trials),
    trials,
  };
}

function drawSeeds(random: RuntimeServices['random'], repetitions: number): number[] {
  return Array.from({ length: repetitions }, () => Math.floor(random.next() * SEED_RANGE));
}

/**
 * Runs every case of the comparison under the three profiles, in case order
 * and then direct, ensemble, collaboration, each through `scoreTrials` with
 * the case's seeds. A configuration problem rejects with an
 * {@link EvaluatorConfigurationError} before anything runs.
 */
export async function runComparison(options: RunComparisonOptions): Promise<ComparisonResult> {
  const { binding, revision, dataset, caseIds } = await bindComparison(options);
  const { plans, definition } = binding;
  if (definition.aggregation.kind === 'reducer' && options.subjects.ensembleReducer === undefined) {
    throw new EvaluatorConfigurationError([
      {
        path: ['subjects', 'ensembleReducer'],
        message: 'Reducer aggregation needs an ensembleReducer subject',
      },
    ]);
  }
  const runtime = options.runtime ?? createDefaultRuntimeServices();
  const cases: CaseComparison[] = [];
  for (const [index, caseId] of caseIds.entries()) {
    const placement = binding.cases[index] as z.output<typeof boundCaseSchema>;
    const entry = dataset.cases[placement.ordinal - 1] as ComparisonCase;
    const seeds = [...(options.seeds?.[caseId] ?? drawSeeds(runtime.random, binding.trials))];
    const profile = (name: ExecutionProfile, executor: ProfileExecutor): Promise<ProfileResult> =>
      runProfile(options, runtime.monotonic, {
        profile: name,
        plan: plans[name],
        entry,
        seeds,
        executor,
      });
    const direct = await profile(
      'direct-agent',
      directExecutor(plans['direct-agent'], entry, options.subjects),
    );
    const ensemble = await profile(
      'compute-matched-ensemble',
      ensembleExecutor(plans['compute-matched-ensemble'], definition, entry, options.subjects),
    );
    const collaboration = await profile(
      'collaboration',
      collaborationExecutor(plans.collaboration, entry, options.subjects),
    );
    cases.push({
      ...placement,
      taskClass: entry.taskClass,
      controls: entry.controls.map((control) => control.kind),
      seeds,
      profiles: {
        'direct-agent': direct,
        'compute-matched-ensemble': ensemble,
        collaboration,
      },
    });
  }
  return { revision, binding, cases };
}
