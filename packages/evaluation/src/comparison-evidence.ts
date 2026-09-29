/**
 * The collaboration comparison's evidence artifact (COR-818): one versioned,
 * machine-readable document per comparison run, holding the binding (and so
 * its revision), every case's per-profile results, and the admission
 * decision. Deterministic selection planning consumes it; the human-readable
 * report (`comparison-report.ts`) is rendered from the same document.
 *
 * Evidence never silently outlives what it was bound to.
 * {@link admissionFromEvidence} hands back a recorded admission only while
 * the current comparison binds exactly what the evidence did and the
 * admission rule is the same document; otherwise it reports the evidence
 * stale and names what changed: a model or effort, a prompt, an Agent
 * definition, a tool, the evaluator, a topology, a policy, and every other
 * bound input. A change versions the evidence (its revision moves); it never
 * reuses a historical admission.
 *
 * Like an `evaluation-run` record, evidence places cases by ordinal and
 * never names a held-out case.
 */
import { sha256Hex } from '@lostgradient/cryptography';
import { z } from 'zod';

import { type AdmissionDecision, admissionDecisionSchema, parseAdmissionRule } from './admission';
import { type CollaborationPlan, taskClassKey } from './collaboration-plan';
import {
  type BoundComparison,
  caseComparisonSchema,
  type ComparisonBinding,
  comparisonBindingSchema,
  type ComparisonResult,
} from './comparison';
import { comparisonDatasetDigest, parseComparisonDataset } from './comparison-datasets';
import { EvaluatorConfigurationError, toConfigurationIssues } from './configuration';
import { digestSchema, historicalRecordIdSchema } from './evaluation-run';
import { canonicalJson } from './identity';

/** The version of the {@link ComparisonEvidence} shape this package writes. */
export const COMPARISON_EVIDENCE_SCHEMA_VERSION = 1;

/** The versioned evidence artifact: binding, revision, every case, and the admission decision. */
export const comparisonEvidenceSchema = z.strictObject({
  kind: z.literal('collaboration-comparison-evidence'),
  schemaVersion: z.literal(COMPARISON_EVIDENCE_SCHEMA_VERSION),
  /** `<comparison id>-<first 12 hex digits of the revision>`. */
  id: historicalRecordIdSchema,
  recordedAt: z.iso.datetime({ offset: true }),
  /** The SHA-256 of the binding's canonical JSON. */
  revision: digestSchema,
  binding: comparisonBindingSchema,
  cases: z.array(caseComparisonSchema).min(1),
  admission: admissionDecisionSchema,
});

export type ComparisonEvidence = z.output<typeof comparisonEvidenceSchema>;

export interface ComparisonEvidenceOptions {
  readonly comparison: ComparisonResult;
  readonly admission: AdmissionDecision;
  /** When the comparison ran, from the caller's runtime clock. */
  readonly recordedAt: string;
}

/** Assembles the evidence artifact for one comparison and its admission decision. */
export function toComparisonEvidence(options: ComparisonEvidenceOptions): ComparisonEvidence {
  const { comparison, admission } = options;
  const { binding, revision } = comparison;
  const ran = taskClassKey(binding.plans.collaboration.taskClass);
  const decided = taskClassKey(admission.taskClass);
  if (ran !== decided) {
    throw new EvaluatorConfigurationError([
      {
        path: ['admission', 'taskClass'],
        message: `The admission decided ${decided}, but the comparison ran ${ran}`,
      },
    ]);
  }
  return {
    kind: 'collaboration-comparison-evidence',
    schemaVersion: COMPARISON_EVIDENCE_SCHEMA_VERSION,
    id: `${binding.definition.id}-${revision.slice(0, 12)}`,
    recordedAt: options.recordedAt,
    revision,
    binding,
    cases: comparison.cases,
    admission,
  };
}

/** The SHA-256 of the evidence's canonical JSON. */
export function comparisonEvidenceDigest(evidence: ComparisonEvidence): Promise<string> {
  return sha256Hex(canonicalJson(evidence));
}

/**
 * Parses evidence and checks that its revision is its binding's digest,
 * rejecting with an {@link EvaluatorConfigurationError} otherwise.
 */
export async function verifyComparisonEvidence(input: unknown): Promise<ComparisonEvidence> {
  const parsed = comparisonEvidenceSchema.safeParse(input);
  if (!parsed.success) throw new EvaluatorConfigurationError(toConfigurationIssues(parsed.error));
  const evidence = parsed.data;
  if ((await sha256Hex(canonicalJson(evidence.binding))) !== evidence.revision) {
    throw new EvaluatorConfigurationError([
      { path: ['revision'], message: 'The evidence revision does not match its binding' },
    ]);
  }
  return evidence;
}

/**
 * The seeds the evidence recorded, keyed by case id, for `runComparison`'s
 * `seeds` option. Cases are placed by ordinal, so this refuses any dataset
 * but the one the evidence was recorded against.
 */
export async function recordedSeeds(
  evidence: ComparisonEvidence,
  datasetInput: unknown,
): Promise<Record<string, readonly number[]>> {
  const dataset = parseComparisonDataset(datasetInput);
  if ((await comparisonDatasetDigest(dataset)) !== evidence.binding.dataset.digest) {
    throw new EvaluatorConfigurationError([
      { path: ['dataset'], message: 'The evidence was recorded against another dataset' },
    ]);
  }
  return Object.fromEntries(
    evidence.cases.map((entry) => [
      (dataset.cases[entry.ordinal - 1] as (typeof dataset.cases)[number]).id,
      entry.seeds,
    ]),
  );
}

/** The named inputs whose change makes recorded evidence stale in `admissionFromEvidence`. */
export const BINDING_CHANGES = [
  'comparison',
  'model',
  'prompt',
  'agent-definition',
  'tool',
  'data',
  'evaluator',
  'dataset',
  'cases',
  'trials',
  'concurrency',
  'compute-match',
  'aggregation',
  'stopping-rule',
  'task',
  'topology',
  'context-projection',
  'commit-authority',
  'verification',
  'policy',
  'budget',
  'plan',
  'admission-rule',
] as const;

export type BindingChange = (typeof BINDING_CHANGES)[number];

function plansOf(binding: ComparisonBinding): readonly CollaborationPlan[] {
  return Object.values(binding.plans);
}

/** What each change compares. Every bound input falls under at least one. */
const COMPONENTS: Readonly<
  Record<Exclude<BindingChange, 'admission-rule'>, (binding: ComparisonBinding) => unknown>
> = {
  comparison: (binding) => [binding.schemaVersion, binding.definition.id],
  model: (binding) =>
    binding.definition.agents.map((agent) => [agent.name, agent.model, agent.effort]),
  prompt: (binding) => binding.definition.agents.map((agent) => [agent.name, agent.promptRevision]),
  'agent-definition': (binding) =>
    binding.definition.agents.map((agent) => [agent.name, agent.definitionRevision, agent.tools]),
  tool: (binding) => binding.definition.tools,
  data: (binding) => binding.definition.dataRevision,
  evaluator: (binding) => binding.evaluator,
  dataset: (binding) => binding.dataset,
  cases: (binding) => binding.cases,
  trials: (binding) => binding.trials,
  concurrency: (binding) => binding.definition.concurrency,
  'compute-match': (binding) => binding.definition.computeMatch,
  aggregation: (binding) => binding.definition.aggregation,
  'stopping-rule': (binding) => [
    binding.definition.stoppingRule,
    plansOf(binding).map((plan) => [plan.stopConditions, plan.topology.maximumRounds]),
  ],
  task: (binding) => plansOf(binding).map((plan) => [plan.task, plan.taskClass]),
  topology: (binding) => plansOf(binding).map((plan) => [plan.participants, plan.topology]),
  'context-projection': (binding) => plansOf(binding).map((plan) => plan.contextProjections),
  'commit-authority': (binding) =>
    plansOf(binding).map((plan) => [
      plan.commitAuthority,
      plan.artifacts.map((artifact) => [artifact.artifactId, artifact.commitAuthority]),
    ]),
  verification: (binding) => plansOf(binding).map((plan) => plan.stageVerifiers),
  policy: (binding) =>
    plansOf(binding).map((plan) => [
      plan.policyVersion,
      plan.security,
      plan.resourceEnvelope.toolAuthority,
    ]),
  budget: (binding) =>
    plansOf(binding).map((plan) => {
      const { toolAuthority: _toolAuthority, ...budget } = plan.resourceEnvelope;
      return budget;
    }),
  plan: (binding) => binding.plans,
};

export interface CurrentComparison {
  /** The comparison as it would be bound today, from `bindComparison`. */
  readonly comparison: Pick<BoundComparison, 'binding' | 'revision'>;
  /** The admission rule in force today. */
  readonly rule: unknown;
}

export type EvidenceCurrency =
  | { readonly status: 'current'; readonly admission: AdmissionDecision }
  | { readonly status: 'stale'; readonly changes: readonly BindingChange[] };

/**
 * The recorded admission, only while nothing it was bound to has changed;
 * otherwise every change that makes the evidence stale.
 */
export async function admissionFromEvidence(
  evidence: ComparisonEvidence,
  current: CurrentComparison,
): Promise<EvidenceCurrency> {
  const { binding } = current.comparison;
  const changes: BindingChange[] = [];
  for (const change of Object.keys(COMPONENTS) as (keyof typeof COMPONENTS)[]) {
    const component = COMPONENTS[change];
    if (canonicalJson(component(evidence.binding)) !== canonicalJson(component(binding))) {
      changes.push(change);
    }
  }
  const rule = parseAdmissionRule(current.rule);
  if ((await sha256Hex(canonicalJson(rule))) !== evidence.admission.rule.digest) {
    changes.push('admission-rule');
  }
  if (changes.length > 0 || current.comparison.revision !== evidence.revision) {
    return { status: 'stale', changes };
  }
  return { status: 'current', admission: evidence.admission };
}
