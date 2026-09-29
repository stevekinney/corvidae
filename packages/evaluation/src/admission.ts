/**
 * Collaboration admission (COR-818; COR-820, "Admission comparison"). One
 * predeclared, versioned rule decides whether the evidence of a comparison
 * admits the collaboration profile for the task class the rule names. The
 * rule is a document with a digest, and it has no defaults: every threshold
 * is written into the rule itself, so no benchmark-paper number is ever a
 * product constant.
 *
 * The decision pools every case's trials per profile and applies, in order:
 *
 * 1. Infrastructure: an evaluator that could not score a trial
 *    (`indeterminate`) makes the decision an infrastructure failure.
 * 2. Evidence: too few cases for the rule's explicit sample size, evaluator
 *    disagreement, a profile with no finished trial, or a trial with no cost
 *    estimate make it insufficient evidence.
 * 3. Quality: the collaboration's task success (the success contract, never
 *    agreement, message count, or self-reported confidence) must beat the
 *    better of the direct Agent and the compute-matched ensemble by the
 *    rule's minimum gain, by point estimate or by 95 percent Wilson interval
 *    separation, and the evaluator must accept enough collaboration trials.
 * 4. Safety: the rule's forbidden failure labels and its ceilings on
 *    unresolved contradictions, propagated faults, and stale reads; and,
 *    whatever the rule says, no abandoned participant and no breach of the
 *    resource envelope.
 * 5. Tradeoffs: the collaboration's mean cost and latency per trial over
 *    each control's, at most the rule's explicit ratios. Extra calls or
 *    tokens never count as gain: they only ever cost.
 *
 * The decision uses the release gate's contract: `admit` is the gate's
 * `pass` (exit 0), `reject` its `regression` (1), then
 * `infrastructure-failure` (2) and `insufficient-evidence` (3), most severe
 * first. Anything but `admit` leaves the plan's declared fallback, one
 * strong direct Agent, authoritative.
 */
import { sha256Hex } from '@lostgradient/cryptography';
import { z } from 'zod';

import {
  EXECUTION_PROFILES,
  type ExecutionProfile,
  taskClassKey,
  taskClassSchema,
} from './collaboration-plan';
import type { CaseComparison, ComparisonResult, ProfileTrial } from './comparison';
import {
  EvaluatorConfigurationError,
  identifier,
  reportDuplicates,
  toConfigurationIssues,
  unitInterval,
} from './configuration';
import { digestSchema, nonNegative, trialStatisticsFields } from './evaluation-run';
import { GATE_DECISIONS, type GateDecision } from './gate';
import { canonicalJson } from './identity';
import { RELEASE_GATE_EXIT_CODES, THRESHOLD_TOLERANCE } from './release-gate';
import { FAILURE_LABELS } from './trajectory';
import { summarizeProportion, type TrialStatistics } from './variance';

const count = z.number().int().min(0);
const ratio = z.number().positive();

export const admissionRuleSchema = z
  .strictObject({
    kind: z.literal('collaboration-admission-rule'),
    name: identifier,
    version: identifier,
    /** The one task class this rule admits collaboration for. */
    taskClass: taskClassSchema,
    /** The explicit sample size: the fewest cases the evidence must cover. */
    minimumCases: z.number().int().positive(),
    quality: z.strictObject({
      successComparison: z.enum(['point-estimate', 'interval-separation']),
      /** The least task-success gain over the better control. */
      minimumSuccessGain: unitInterval,
      /** The least share of collaboration trials the evaluator must accept. */
      minimumVerifierAcceptance: unitInterval,
    }),
    safety: z.strictObject({
      forbiddenFailureLabels: z.array(z.enum(FAILURE_LABELS)),
      maximumUnresolvedContradictions: count,
      maximumPropagatedFaults: count,
      maximumStaleReads: count,
    }),
    tradeoffs: z.strictObject({
      /** The collaboration's mean cost per trial over each control's, at most. */
      maximumCostRatio: z.strictObject({ direct: ratio, ensemble: ratio }),
      /** The collaboration's mean latency per trial over each control's, at most. */
      maximumLatencyRatio: z.strictObject({ direct: ratio, ensemble: ratio }),
    }),
  })
  .superRefine((rule, context) => {
    reportDuplicates(
      rule.safety.forbiddenFailureLabels,
      (index) => ['safety', 'forbiddenFailureLabels', index],
      'forbidden failure label',
      context,
    );
  });

export type AdmissionRule = z.output<typeof admissionRuleSchema>;

/** Parses a rule, throwing {@link EvaluatorConfigurationError} on any issue. */
export function parseAdmissionRule(input: unknown): AdmissionRule {
  const parsed = admissionRuleSchema.safeParse(input);
  if (!parsed.success) throw new EvaluatorConfigurationError(toConfigurationIssues(parsed.error));
  return parsed.data;
}

export const ADMISSION_DECISIONS = [
  'admit',
  'reject',
  'infrastructure-failure',
  'insufficient-evidence',
] as const;

export type AdmissionDecisionKind = (typeof ADMISSION_DECISIONS)[number];

const GATE_DECISION_OF = {
  admit: 'pass',
  reject: 'regression',
  'infrastructure-failure': 'infrastructure-failure',
  'insufficient-evidence': 'insufficient-evidence',
} as const satisfies Record<AdmissionDecisionKind, GateDecision>;

export const ADMISSION_FINDING_REASONS = [
  'evaluator-indeterminate',
  'too-few-cases',
  'evaluator-disagreement',
  'no-completed-trials',
  'missing-cost',
  'insufficient-success-gain',
  'verifier-acceptance-too-low',
  'forbidden-failure-label',
  'unresolved-contradictions',
  'propagated-faults',
  'stale-reads',
  'abandoned-participants',
  'envelope-breach',
  'cost-ratio',
  'latency-ratio',
] as const;

export type AdmissionFindingReason = (typeof ADMISSION_FINDING_REASONS)[number];

const ADMISSION_GATES = ['infrastructure', 'evidence', 'quality', 'safety', 'tradeoff'] as const;

type AdmissionGate = (typeof ADMISSION_GATES)[number];

const pooledProfileSchema = z.strictObject({
  taskSuccess: z.strictObject(trialStatisticsFields),
  verifierAcceptance: z.strictObject(trialStatisticsFields),
  /** `null` without finished trials or when any lacks a cost estimate. */
  meanCostUsd: nonNegative.nullable(),
  meanLatencyMilliseconds: nonNegative.nullable(),
});

export type PooledProfile = z.output<typeof pooledProfileSchema>;

export const admissionDecisionSchema = z.strictObject({
  kind: z.literal('collaboration-admission-decision'),
  rule: z.strictObject({ name: identifier, version: identifier, digest: digestSchema }),
  taskClass: taskClassSchema,
  decision: z.enum(ADMISSION_DECISIONS),
  /** The same decision in the release gate's vocabulary. */
  gateDecision: z.enum(GATE_DECISIONS),
  exitCode: z.number().int().min(0),
  /** The profile that runs this task class: the collaboration only when admitted. */
  authoritativeProfile: z.enum(EXECUTION_PROFILES),
  fallback: z.strictObject({ profile: z.literal('direct-agent'), reason: identifier }),
  cases: count,
  profiles: z.strictObject({
    'direct-agent': pooledProfileSchema,
    'compute-matched-ensemble': pooledProfileSchema,
    collaboration: pooledProfileSchema,
  }),
  findings: z.array(
    z.strictObject({
      gate: z.enum(ADMISSION_GATES),
      reason: z.enum(ADMISSION_FINDING_REASONS),
      detail: identifier,
    }),
  ),
});

export type AdmissionDecision = z.output<typeof admissionDecisionSchema>;
export type AdmissionFinding = AdmissionDecision['findings'][number];

type ProfileTrials = Readonly<Record<ExecutionProfile, readonly ProfileTrial[]>>;

function trialsByProfile(cases: readonly CaseComparison[]): ProfileTrials {
  const byProfile = (profile: ExecutionProfile): ProfileTrial[] =>
    cases.flatMap((entry) => entry.profiles[profile].trials);
  return {
    'direct-agent': byProfile('direct-agent'),
    'compute-matched-ensemble': byProfile('compute-matched-ensemble'),
    collaboration: byProfile('collaboration'),
  };
}

/** Trials whose run finished, so their metrics exist. */
function finished(trials: readonly ProfileTrial[]): ProfileTrial[] {
  return trials.filter((trial) => trial.coordination !== null);
}

function meanOf(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.includes(null)) return null;
  return (values as number[]).reduce((sum, value) => sum + value, 0) / values.length;
}

function pool(trials: readonly ProfileTrial[]): PooledProfile {
  const successes = trials.flatMap((trial) =>
    trial.taskSuccess === null ? [] : [trial.taskSuccess],
  );
  const verdicts = trials.filter((trial) => trial.verdict !== 'infrastructure-failure');
  const runs = finished(trials);
  return {
    taskSuccess: summarizeProportion(successes.filter(Boolean).length, successes.length),
    verifierAcceptance: summarizeProportion(
      verdicts.filter((trial) => trial.verdict === 'pass').length,
      verdicts.length,
    ),
    meanCostUsd: meanOf(runs.map((trial) => trial.costUsd)),
    meanLatencyMilliseconds: meanOf(runs.map((trial) => trial.latencyMilliseconds)),
  };
}

function format(value: number): string {
  return value.toFixed(4);
}

class Findings {
  readonly list: AdmissionFinding[];

  constructor() {
    this.list = [];
  }

  add(gate: AdmissionGate, reason: AdmissionFindingReason, detail: string): void {
    this.list.push({ gate, reason, detail });
  }

  has(gate: AdmissionGate): boolean {
    return this.list.some((finding) => finding.gate === gate);
  }
}

const CONTROLS = ['direct-agent', 'compute-matched-ensemble'] as const;

function checkEvidence(
  rule: AdmissionRule,
  comparison: ComparisonResult,
  trials: ProfileTrials,
  findings: Findings,
): void {
  for (const entry of comparison.cases) {
    for (const profile of EXECUTION_PROFILES) {
      if (entry.profiles[profile].outcome === 'indeterminate') {
        findings.add(
          'infrastructure',
          'evaluator-indeterminate',
          `The evaluator could not score every ${profile} trial of case ${entry.ordinal}`,
        );
      }
    }
  }
  if (comparison.cases.length < rule.minimumCases) {
    findings.add(
      'evidence',
      'too-few-cases',
      `The evidence covers ${comparison.cases.length} cases; the rule needs ${rule.minimumCases}`,
    );
  }
  for (const entry of comparison.cases) {
    for (const profile of EXECUTION_PROFILES) {
      if (entry.profiles[profile].outcome === 'disagreement') {
        findings.add(
          'evidence',
          'evaluator-disagreement',
          `The evaluator's ${profile} verdicts disagreed past the variance policy on case ${entry.ordinal}`,
        );
      }
    }
  }
  for (const profile of EXECUTION_PROFILES) {
    const runs = finished(trials[profile]);
    if (runs.length === 0) {
      findings.add('evidence', 'no-completed-trials', `No ${profile} trial finished a run`);
    } else if (runs.some((trial) => trial.costUsd === null)) {
      findings.add(
        'evidence',
        'missing-cost',
        `A ${profile} trial has no cost estimate, so cost cannot be weighed`,
      );
    }
  }
}

function checkQuality(
  rule: AdmissionRule,
  pooled: Readonly<Record<ExecutionProfile, PooledProfile>>,
  findings: Findings,
): void {
  const { quality } = rule;
  const collaboration = pooled.collaboration.taskSuccess;
  const controls = CONTROLS.map((profile) => pooled[profile].taskSuccess);
  if ([collaboration, ...controls].every((statistics) => statistics.passFraction !== null)) {
    const gain = successGain(quality.successComparison, collaboration, controls);
    if (gain.value < quality.minimumSuccessGain - THRESHOLD_TOLERANCE) {
      findings.add(
        'quality',
        'insufficient-success-gain',
        `${gain.description} is a gain of ${format(gain.value)}; the rule needs ${format(quality.minimumSuccessGain)}`,
      );
    }
  }
  const acceptance = pooled.collaboration.verifierAcceptance.passFraction ?? 0;
  if (acceptance < quality.minimumVerifierAcceptance - THRESHOLD_TOLERANCE) {
    findings.add(
      'quality',
      'verifier-acceptance-too-low',
      `The evaluator accepted ${format(acceptance)} of collaboration trials; the rule needs ${format(quality.minimumVerifierAcceptance)}`,
    );
  }
}

function successGain(
  comparison: AdmissionRule['quality']['successComparison'],
  collaboration: TrialStatistics,
  controls: readonly TrialStatistics[],
): { readonly value: number; readonly description: string } {
  if (comparison === 'point-estimate') {
    const own = collaboration.passFraction as number;
    const best = Math.max(...controls.map((control) => control.passFraction as number));
    return {
      value: own - best,
      description: `Collaboration task success ${format(own)} against the better control ${format(best)}`,
    };
  }
  const lower = (collaboration.wilsonInterval as NonNullable<TrialStatistics['wilsonInterval']>)
    .lower;
  const upper = Math.max(
    ...controls.map(
      (control) => (control.wilsonInterval as NonNullable<TrialStatistics['wilsonInterval']>).upper,
    ),
  );
  return {
    value: lower - upper,
    description: `Collaboration task success interval lower bound ${format(lower)} against the better control's upper bound ${format(upper)}`,
  };
}

function checkSafety(
  rule: AdmissionRule,
  cases: readonly CaseComparison[],
  findings: Findings,
): void {
  const { safety } = rule;
  const trials = cases.flatMap((entry) =>
    entry.profiles.collaboration.trials.map((trial) => ({ ordinal: entry.ordinal, trial })),
  );
  const labels = trials.flatMap(({ trial }) => trial.failures.map((failure) => failure.label));
  for (const label of safety.forbiddenFailureLabels) {
    const occurrences = labels.filter((entry) => entry === label).length;
    if (occurrences > 0) {
      findings.add(
        'safety',
        'forbidden-failure-label',
        `Forbidden failure label ${label} in collaboration trials: ${occurrences}`,
      );
    }
  }
  const ceilings = [
    [
      'unresolved-contradictions',
      'Unresolved contradictions',
      'unresolvedContradictions',
      safety.maximumUnresolvedContradictions,
    ],
    ['propagated-faults', 'Propagated faults', 'propagatedFaults', safety.maximumPropagatedFaults],
    ['stale-reads', 'Stale reads', 'staleReads', safety.maximumStaleReads],
  ] as const;
  for (const [reason, name, metric, maximum] of ceilings) {
    const total = trials.reduce((sum, { trial }) => sum + (trial.coordination?.[metric] ?? 0), 0);
    if (total > maximum) {
      findings.add(
        'safety',
        reason,
        `${name} in collaboration trials: ${total}; the rule allows at most ${maximum}`,
      );
    }
  }
  for (const { ordinal, trial } of trials) {
    const where = `Trial ${trial.trial} of case ${ordinal}`;
    if (trial.cleanup?.state === 'abandoned') {
      findings.add(
        'safety',
        'abandoned-participants',
        `${where} abandoned ${trial.cleanup.abandoned.join(', ')}`,
      );
    }
    if (trial.envelopeBreaches.length > 0) {
      findings.add(
        'safety',
        'envelope-breach',
        `${where} breached the resource envelope: ${trial.envelopeBreaches.join(', ')}`,
      );
    }
  }
}

function checkTradeoffs(
  rule: AdmissionRule,
  pooled: Readonly<Record<ExecutionProfile, PooledProfile>>,
  findings: Findings,
): void {
  const measures = [
    {
      reason: 'cost-ratio',
      verb: 'costs',
      unbounded: ['costs more than the free', 'free'],
      mean: (profile: PooledProfile) => profile.meanCostUsd,
      maximum: rule.tradeoffs.maximumCostRatio,
    },
    {
      reason: 'latency-ratio',
      verb: 'takes',
      unbounded: ['takes longer than the instant', 'instant'],
      mean: (profile: PooledProfile) => profile.meanLatencyMilliseconds,
      maximum: rule.tradeoffs.maximumLatencyRatio,
    },
  ] as const;
  for (const measure of measures) {
    const own = measure.mean(pooled.collaboration);
    for (const control of CONTROLS) {
      const theirs = measure.mean(pooled[control]);
      if (own === null || theirs === null) continue;
      const limit = control === 'direct-agent' ? measure.maximum.direct : measure.maximum.ensemble;
      if (theirs === 0) {
        if (own > 0) {
          findings.add(
            'tradeoff',
            measure.reason,
            `Collaboration ${measure.unbounded[0]} ${control} per trial; the ratio is unbounded`,
          );
        }
        continue;
      }
      const value = own / theirs;
      if (value > limit + THRESHOLD_TOLERANCE) {
        findings.add(
          'tradeoff',
          measure.reason,
          `Collaboration ${measure.verb} ${format(value)} times the ${control} per trial; the rule allows ${format(limit)}`,
        );
      }
    }
  }
}

function decide(findings: Findings): AdmissionDecisionKind {
  if (findings.has('infrastructure')) return 'infrastructure-failure';
  if (findings.has('evidence')) return 'insufficient-evidence';
  return findings.list.length > 0 ? 'reject' : 'admit';
}

/**
 * Decides admission for the comparison's collaboration plan under `rule`.
 * Rejects with an {@link EvaluatorConfigurationError} when the rule is
 * invalid or admits another task class than the comparison ran.
 */
export async function decideAdmission(
  rule: unknown,
  comparison: ComparisonResult,
): Promise<AdmissionDecision> {
  const parsed = parseAdmissionRule(rule);
  const plan = comparison.binding.plans.collaboration;
  const ruleClass = taskClassKey(parsed.taskClass);
  const planClass = taskClassKey(plan.taskClass);
  if (ruleClass !== planClass) {
    throw new EvaluatorConfigurationError([
      {
        path: ['taskClass'],
        message: `The rule admits ${ruleClass}, but the comparison ran ${planClass}`,
      },
    ]);
  }
  const trials = trialsByProfile(comparison.cases);
  const pooled = {
    'direct-agent': pool(trials['direct-agent']),
    'compute-matched-ensemble': pool(trials['compute-matched-ensemble']),
    collaboration: pool(trials.collaboration),
  };
  const findings = new Findings();
  checkEvidence(parsed, comparison, trials, findings);
  checkQuality(parsed, pooled, findings);
  checkSafety(parsed, comparison.cases, findings);
  checkTradeoffs(parsed, pooled, findings);
  const decision = decide(findings);
  const gateDecision = GATE_DECISION_OF[decision];
  return {
    kind: 'collaboration-admission-decision',
    rule: {
      name: parsed.name,
      version: parsed.version,
      digest: await sha256Hex(canonicalJson(parsed)),
    },
    taskClass: parsed.taskClass,
    decision,
    gateDecision,
    exitCode: RELEASE_GATE_EXIT_CODES[gateDecision],
    authoritativeProfile: decision === 'admit' ? 'collaboration' : plan.fallback.profile,
    fallback: plan.fallback,
    cases: comparison.cases.length,
    profiles: pooled,
    findings: findings.list,
  };
}
