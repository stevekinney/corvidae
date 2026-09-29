/**
 * Release gates (COR-896, "Merge and release gate fields"). A gate is a
 * committed JSON file, `gates/<gateId>.json`, that names:
 *
 * - `evaluator`: the evaluator module the gate runs, relative to the gate
 *   file. Rolling an evaluator back means pointing this at the prior approved
 *   module; history is never touched.
 * - `dataset`: the dataset id and version the evaluator must score.
 * - `baseline`: what the run is compared with. Explicit only: either the
 *   latest decision of this gate that passed without an override (or that
 *   the override authority accepted as a permanent baseline change), or a
 *   committed `evaluation-run` record. A gate without one is invalid
 *   configuration, never "compare against nothing".
 * - `sampleSize`: the minimum trial count for a stochastic judge, or the
 *   minimum held-out case count for a deterministic one. No default.
 * - `regressionThresholds`: per criterion and metric, the largest tolerated
 *   decrease from the baseline and whether a breach is `hard` or
 *   `overridable`.
 * - `budgets`: the cost and latency ceilings of the gate run itself.
 * - `overrideAuthority`: the principal who may override a blocking result.
 * - `expiry`: how far, in commits or milliseconds, a baseline may trail the
 *   run before it stops being evidence. A gate result is never evergreen.
 * - `package`: the workspace whose release the gate guards. Optional for the
 *   gate itself, but a promotion signal (`promotion.ts`) binds it, so a gate
 *   that does not name one has decisions no signal can be issued from.
 *
 * This module also defines the two records a gate appends to the history:
 * the `gate-decision` record, which holds everything a replay needs to
 * recompute the decision without calling a model, and the `gate-override`
 * record, which never mutates a decision.
 *
 * A decision is audit material, so it carries reviewer-projection evidence:
 * each trial's run projection (its content and tool trajectory) and the raw
 * reply of its model judge. Cases are still placed by ordinal, never by a
 * held-out id, and nothing in a decision is ever returned to the generator.
 */
import { z } from 'zod';

import {
  codeRevisionSchema,
  EvaluatorConfigurationError,
  identifier,
  reportDuplicates,
  toConfigurationIssues,
  unitInterval,
} from './configuration';
import {
  casePlacementFields,
  digestSchema,
  evaluationRunRecordSchema,
  historicalRecordIdSchema,
  nonNegative,
  reportCasePlacementIssues,
  usageSchema,
} from './evaluation-run';
import { AGENT_FAILURE_REASONS } from './verdict';

/** The version of the gate-decision and gate-override record shapes this package writes. */
export const GATE_RECORD_SCHEMA_VERSION = 1;

/** A gate id is its file's name without `.json`: a plain identifier, never a path. */
export const gateIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
    'Expected 1 to 64 letters, digits, underscores, or hyphens, starting with a letter or digit',
  );

const REGRESSION_METRICS = ['passFraction', 'meanScore'] as const;
const REGRESSION_SEVERITIES = ['hard', 'overridable'] as const;

export type RegressionMetric = (typeof REGRESSION_METRICS)[number];
export type RegressionSeverity = (typeof REGRESSION_SEVERITIES)[number];

const baselineSelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('latest-passing-decision') }),
  z.strictObject({ kind: z.literal('evaluation-run'), path: z.string().min(1) }),
]);

const regressionThresholdSchema = z.strictObject({
  criterion: identifier,
  metric: z.enum(REGRESSION_METRICS),
  /** The largest tolerated decrease from the baseline, in `[0, 1]`. */
  maximumDecrease: unitInterval,
  severity: z.enum(REGRESSION_SEVERITIES),
});

export const gateDefinitionSchema = z
  .strictObject({
    description: z.string().min(1).optional(),
    /** The workspace (by package name) whose release this gate guards. */
    package: identifier.optional(),
    evaluator: z.string().min(1),
    dataset: z.strictObject({ id: identifier, version: identifier }),
    baseline: baselineSelectorSchema,
    sampleSize: z.number().int().positive(),
    regressionThresholds: z.array(regressionThresholdSchema).min(1),
    budgets: z.strictObject({
      costUsd: nonNegative,
      latencyMilliseconds: z.number().int().positive(),
    }),
    overrideAuthority: identifier,
    expiry: z
      .strictObject({
        maximumRevisionDistance: z.number().int().min(0).optional(),
        maximumAgeMs: z.number().int().positive().optional(),
      })
      .refine(
        (expiry) =>
          expiry.maximumRevisionDistance !== undefined || expiry.maximumAgeMs !== undefined,
        'Declare maximumRevisionDistance, maximumAgeMs, or both: a gate result is never evergreen evidence',
      ),
  })
  .superRefine((gate, context) => {
    reportDuplicates(
      gate.regressionThresholds.map((threshold) => `${threshold.criterion} ${threshold.metric}`),
      (index) => ['regressionThresholds', index],
      'threshold for criterion and metric',
      context,
    );
  });

export type GateDefinition = z.output<typeof gateDefinitionSchema>;
export type BaselineSelector = GateDefinition['baseline'];
export type RegressionThreshold = GateDefinition['regressionThresholds'][number];

/** Parses a gate definition, throwing {@link EvaluatorConfigurationError} on any issue. */
export function parseGateDefinition(input: unknown): GateDefinition {
  const parsed = gateDefinitionSchema.safeParse(input);
  if (!parsed.success) throw new EvaluatorConfigurationError(toConfigurationIssues(parsed.error));
  return parsed.data;
}

const errorDescriptionSchema = z.strictObject({ name: z.string(), message: z.string() });

/** A trial's run as the reviewer projection keeps it (`toReviewerRunProjection`). */
export const runProjectionSchema = z.strictObject({
  finishReason: z.enum(['stop-condition', ...AGENT_FAILURE_REASONS]),
  content: z.string(),
  usage: usageSchema,
  trajectory: z.array(
    z.strictObject({
      step: z.number().int().min(0),
      content: z.string(),
      toolCalls: z.array(z.strictObject({ id: z.string(), name: z.string(), arguments: z.json() })),
      results: z.array(
        z.strictObject({
          toolCallId: z.string(),
          toolName: z.string(),
          outcome: z.enum(['success', 'error', 'action_required']),
          content: z.json(),
        }),
      ),
    }),
  ),
  error: errorDescriptionSchema.optional(),
  costEstimate: z
    .strictObject({
      promptCost: nonNegative,
      completionCost: nonNegative,
      cacheWriteCost: nonNegative,
      cacheReadCost: nonNegative,
      totalCost: nonNegative,
      model: z.string(),
      usage: usageSchema,
    })
    .optional(),
  schemaValidation: z
    .strictObject({ success: z.boolean(), error: errorDescriptionSchema.optional() })
    .optional(),
});

/** One model-judge call as recorded (`RecordedJudgeOutput`). */
const recordedJudgeOutputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('reply'),
    content: z.string(),
    requestedTools: z.array(z.string()),
  }),
  z.strictObject({ kind: z.literal('error') }),
]);

const trialEvidenceSchema = z.strictObject({
  trial: z.number().int().positive(),
  seed: z.number().int().min(0).max(0xffff_ffff),
  /** `null` when the run rejected instead of finishing: a subject error. */
  run: runProjectionSchema.nullable(),
  /** `null` when the trial never called its judge. */
  judge: recordedJudgeOutputSchema.nullable(),
  /** The evaluation ran out of its per-evaluation latency budget, which no replay can re-time. */
  latencyBudgetExceeded: z.boolean(),
});

const caseEvidenceSchema = z
  .strictObject({ ...casePlacementFields, trials: z.array(trialEvidenceSchema).min(1) })
  .superRefine(reportCasePlacementIssues);

export type TrialEvidence = z.output<typeof trialEvidenceSchema>;
export type CaseEvidence = z.output<typeof caseEvidenceSchema>;

const baselineSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('evaluation-run'),
    /** The committed record, relative to the evaluation package. */
    path: z.string().min(1),
    digest: digestSchema,
  }),
  z.strictObject({
    kind: z.literal('gate-decision'),
    recordId: historicalRecordIdSchema,
    digest: digestSchema,
    /** The permanent baseline change that accepted the decision; `null` if it passed without an override. */
    acceptedBy: historicalRecordIdSchema.nullable(),
  }),
]);

const recordedBaselineSchema = z.strictObject({
  source: baselineSourceSchema,
  run: evaluationRunRecordSchema,
  /** How long before this decision the baseline was recorded. */
  ageMilliseconds: z.number(),
  /** Commits from the baseline's code revision to the run's; `null` when it could not be determined. */
  revisionDistance: z.number().int().min(0).nullable(),
});

export type RecordedBaseline = z.output<typeof recordedBaselineSchema>;

const OVERRIDE_INVALIDITY_REASONS = [
  'unknown-decision',
  'not-override-authority',
  'decision-actor',
  'expired',
  'different-evaluator',
] as const;

export type OverrideInvalidityReason = (typeof OVERRIDE_INVALIDITY_REASONS)[number];

const coveredRegressionSchema = z.strictObject({
  criterion: identifier,
  metric: z.enum(REGRESSION_METRICS),
  delta: z.number(),
});

const consideredOverrideSchema = z.strictObject({
  id: historicalRecordIdSchema,
  digest: digestSchema,
  gateDecisionId: historicalRecordIdSchema,
  /** `valid`, or why this override cannot clear anything at this decision. */
  validity: z.enum(['valid', ...OVERRIDE_INVALIDITY_REASONS]),
  /** The overridden decision's overridable regressions: what the override may clear. */
  covers: z.array(coveredRegressionSchema),
});

export type ConsideredOverride = z.output<typeof consideredOverrideSchema>;
export type CoveredRegression = z.output<typeof coveredRegressionSchema>;

const INFRASTRUCTURE_FINDINGS = [
  'evaluator-infrastructure-failure',
  'gate-budget-exceeded',
] as const;

const INSUFFICIENT_EVIDENCE_FINDINGS = [
  'sample-size-not-met',
  'baseline-missing',
  'baseline-expired',
  'baseline-not-comparable',
  'judge-uncalibrated',
  'judge-not-drift-checked',
  'dataset-not-contamination-checked',
  'unresolved-disagreement',
  'criterion-not-comparable',
] as const;

const regressionSchema = z.strictObject({
  criterion: identifier,
  metric: z.enum(REGRESSION_METRICS),
  severity: z.enum(REGRESSION_SEVERITIES),
  maximumDecrease: unitInterval,
  baseline: unitInterval,
  candidate: unitInterval,
  delta: z.number(),
  /** The valid override that clears this regression; always `null` for a hard one. */
  overriddenBy: historicalRecordIdSchema.nullable(),
});

export type Regression = z.output<typeof regressionSchema>;

export const GATE_DECISIONS = [
  'pass',
  'regression',
  'infrastructure-failure',
  'insufficient-evidence',
] as const;

export type GateDecision = (typeof GATE_DECISIONS)[number];

export const gateDecisionRecordSchema = z.strictObject({
  kind: z.literal('gate-decision'),
  schemaVersion: z.literal(GATE_RECORD_SCHEMA_VERSION),
  id: historicalRecordIdSchema,
  recordedAt: z.iso.datetime({ offset: true }),
  gateId: gateIdSchema,
  /** The principal who ran the gate. */
  actor: identifier,
  /**
   * The repository revision (`git rev-parse HEAD`) the gate ran at, when the
   * runner could tell. The evaluator configuration's `codeRevision` is what
   * the evaluator declares it evaluated; this is where the gate, its
   * evaluator module, and the code under evaluation actually were. A
   * promotion signal is issued only for this revision.
   */
  sourceRevision: codeRevisionSchema.optional(),
  /** The gate definition as it was when the gate ran. */
  gate: gateDefinitionSchema,
  evaluator: z.strictObject({
    /** The evaluator module, relative to the evaluation package. */
    module: z.string().min(1),
    name: identifier,
    revision: z.number().int().positive(),
    digest: digestSchema,
    judge: z.enum(['deterministic', 'heuristic', 'model']),
  }),
  /** The digest is over the whole dataset version, so a silent edit cannot pass for it. */
  dataset: z.strictObject({ id: identifier, version: identifier, digest: digestSchema }),
  eligibility: z.strictObject({
    contaminationChecked: z.boolean(),
    /** `null` unless the judge is a model judge. */
    judge: z
      .strictObject({ revision: digestSchema, calibrated: z.boolean(), driftChecked: z.boolean() })
      .nullable(),
  }),
  /** Per case, in dataset order, every trial's recorded evidence. */
  evidence: z.array(caseEvidenceSchema).min(1),
  /** The run's evaluation-run record, derived from the evidence. */
  candidate: evaluationRunRecordSchema,
  /** `null` when no baseline could be found. */
  baseline: recordedBaselineSchema.nullable(),
  overrides: z.strictObject({
    considered: z.array(consideredOverrideSchema),
    applied: z.array(historicalRecordIdSchema),
    rejected: z.array(
      z.strictObject({
        id: historicalRecordIdSchema,
        criterion: identifier,
        metric: z.enum(REGRESSION_METRICS),
        reason: z.enum([...OVERRIDE_INVALIDITY_REASONS, 'hard-regression']),
      }),
    ),
  }),
  findings: z.strictObject({
    infrastructureFailures: z.array(
      z.strictObject({ reason: z.enum(INFRASTRUCTURE_FINDINGS), detail: identifier }),
    ),
    insufficientEvidence: z.array(
      z.strictObject({ reason: z.enum(INSUFFICIENT_EVIDENCE_FINDINGS), detail: identifier }),
    ),
    regressions: z.array(regressionSchema),
  }),
  decision: z.enum(GATE_DECISIONS),
});

export type GateDecisionRecord = z.output<typeof gateDecisionRecordSchema>;
export type GateFindings = GateDecisionRecord['findings'];
export type GateOverrides = GateDecisionRecord['overrides'];
export type GateEligibility = GateDecisionRecord['eligibility'];

export const gateOverrideRecordSchema = z
  .strictObject({
    kind: z.literal('gate-override'),
    schemaVersion: z.literal(GATE_RECORD_SCHEMA_VERSION),
    id: historicalRecordIdSchema,
    recordedAt: z.iso.datetime({ offset: true }),
    gateId: gateIdSchema,
    /** The decision this override answers. It is never modified. */
    gateDecisionId: historicalRecordIdSchema,
    actor: identifier,
    reason: identifier,
    /** Mandatory unless this is a permanent baseline change. */
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    /** Accepts the decision's evidence as the gate's baseline from now on, instead of expiring. */
    permanentBaselineChange: z.boolean(),
    /** References to the retained evidence the override rests on. */
    evidence: z.array(identifier).min(1),
  })
  .superRefine((override, context) => {
    const { expiresAt, permanentBaselineChange } = override;
    if (!permanentBaselineChange && expiresAt === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'An override expires unless it is a permanent baseline change',
      });
    }
    if (permanentBaselineChange && expiresAt !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'A permanent baseline change does not expire',
      });
    }
    if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(override.recordedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'An override must expire after it is recorded',
      });
    }
  });

export type GateOverrideRecord = z.output<typeof gateOverrideRecordSchema>;
