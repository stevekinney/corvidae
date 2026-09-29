/**
 * The `evaluation-run` record: the shape one evaluation run is kept in by the
 * append-only history (`history.ts`) and embedded in by a release gate's
 * `gate-decision` record (`gate.ts`). It lives in its own module so both can
 * depend on it without depending on each other.
 *
 * A record keeps the evidence a later comparison or gate needs and nothing
 * that could leak a held-out case: a held-out case is recorded by its ordinal
 * in the dataset version, never by its id, and no expected answer, run
 * content, feedback, judge rationale, or error message (any of which may
 * quote one) is stored. The schema enforces the id rule, so no record can
 * carry a held-out id however it was built.
 */
import type { TokenUsage } from '@lostgradient/operative';
import { z } from 'zod';

import {
  codeRevisionSchema,
  EvaluatorConfigurationError,
  identifier,
  toConfigurationIssues,
  unitInterval,
} from './configuration';
import { CASE_VISIBILITIES } from './datasets';
import { type AggregateOutcome, DISAGREEMENT_REASONS } from './disagreement';
import type { HardGateOutcome } from './rubric';
import { variancePolicySchema } from './variance';
import { AGENT_FAILURE_REASONS, type CaseVerdict, INFRASTRUCTURE_FAILURE_REASONS } from './verdict';

/** The version of the {@link EvaluationRunRecord} shape this package writes. */
export const EVALUATION_HISTORY_SCHEMA_VERSION = 1;

export const CASE_VERDICTS = [
  'pass',
  'fail',
  'agent-failed',
  'infrastructure-failure',
] as const satisfies readonly CaseVerdict[];
const HARD_GATE_OUTCOMES = [
  'passed',
  'failed',
  'not-applicable',
] as const satisfies readonly HardGateOutcome[];
export const AGGREGATE_OUTCOMES = [
  'pass',
  'fail',
  'disagreement',
  'indeterminate',
] as const satisfies readonly AggregateOutcome[];

const count = z.number().int().min(0);
export const nonNegative = z.number().min(0);
export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 digest');

/** A record id is a plain identifier, so it is always a safe storage key and command argument. */
export const historicalRecordIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    'Expected 1 to 128 letters, digits, dots, underscores, or hyphens, starting with a letter or digit',
  );

/** Token usage as a record keeps it: the provider-neutral counters only. */
export const usageSchema = z.strictObject({
  prompt: nonNegative,
  completion: nonNegative,
  total: nonNegative,
  cacheCreationTokens: nonNegative.optional(),
  cacheReadTokens: nonNegative.optional(),
});

/** Token usage with only the counters {@link usageSchema} keeps. */
export function toRecordedUsage(usage: TokenUsage): z.output<typeof usageSchema> {
  const { cacheCreationTokens, cacheReadTokens } = usage;
  return {
    prompt: usage.prompt,
    completion: usage.completion,
    total: usage.total,
    ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
  };
}

export const trialStatisticsFields = {
  trials: count,
  passes: count,
  passFraction: unitInterval.nullable(),
  wilsonInterval: z
    .strictObject({ lower: unitInterval, upper: unitInterval, width: unitInterval })
    .nullable(),
};

export const statisticsSchema = z.strictObject({
  verdicts: z.strictObject(trialStatisticsFields),
  criteria: z.array(
    z.strictObject({
      name: identifier,
      ...trialStatisticsFields,
      meanScore: unitInterval.nullable(),
      sampleVariance: nonNegative.nullable(),
      standardDeviation: nonNegative.nullable(),
    }),
  ),
});

const trialSchema = z.strictObject({
  trial: z.number().int().positive(),
  seed: z.number().int().min(0).max(0xffff_ffff),
  verdict: z.enum(CASE_VERDICTS),
  finishReason: z.enum(['stop-condition', ...AGENT_FAILURE_REASONS]).optional(),
  usage: usageSchema.optional(),
  costUsd: nonNegative.optional(),
  /** Scores only: a judge's rationale may quote the expected answer. */
  scores: z.array(
    z.strictObject({
      name: identifier,
      score: unitInterval,
      hardGate: z.enum(HARD_GATE_OUTCOMES),
    }),
  ),
  weightedTotal: unitInterval.optional(),
  /** The typed reason only: an error's message may name the case. */
  error: z
    .strictObject({
      reason: z.enum(INFRASTRUCTURE_FAILURE_REASONS),
      criterion: identifier.optional(),
    })
    .optional(),
});

/** Where a case sits in its dataset version: a held-out case by ordinal alone, a public one with its id. */
export const casePlacementFields = {
  /** The case's 1-based position in the dataset version. */
  ordinal: z.number().int().positive(),
  visibility: z.enum(CASE_VISIBILITIES),
  /** Present exactly when the case is public. */
  caseId: identifier.optional(),
};

/** Rejects a held-out case recorded with its id and a public case recorded without one. */
export function reportCasePlacementIssues(
  entry: { readonly visibility: string; readonly caseId?: string | undefined },
  context: z.RefinementCtx,
): void {
  if (entry.visibility === 'held-out' && entry.caseId !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['caseId'],
      message: 'A held-out case is recorded by ordinal, never by id',
    });
  }
  if (entry.visibility === 'public' && entry.caseId === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['caseId'],
      message: 'A public case is recorded with its id',
    });
  }
}

const caseSchema = z
  .strictObject({
    ...casePlacementFields,
    outcome: z.enum(AGGREGATE_OUTCOMES),
    disagreementReasons: z.array(z.enum(DISAGREEMENT_REASONS)).optional(),
    statistics: statisticsSchema,
    trials: z.array(trialSchema).min(1),
  })
  .superRefine(reportCasePlacementIssues);

export const evaluationRunRecordSchema = z.strictObject({
  kind: z.literal('evaluation-run'),
  schemaVersion: z.literal(EVALUATION_HISTORY_SCHEMA_VERSION),
  id: historicalRecordIdSchema,
  recordedAt: z.iso.datetime({ offset: true }),
  evaluator: z.strictObject({
    name: identifier,
    revision: z.number().int().positive(),
    digest: digestSchema,
  }),
  resultSchemaVersion: z.number().int().positive(),
  dataset: z.strictObject({ id: identifier, version: identifier }),
  codeRevision: codeRevisionSchema,
  repetitions: z.number().int().min(1),
  variancePolicy: variancePolicySchema.nullable(),
  /** How many cases ended in each aggregate outcome. */
  outcomes: z.strictObject({
    pass: count,
    fail: count,
    disagreement: count,
    indeterminate: count,
  }),
  /** Verdict and per-criterion statistics pooled over every trial of every case. */
  statistics: statisticsSchema,
  /** The summed cost estimate of every trial; `null` when any trial has none. */
  costUsd: nonNegative.nullable(),
  latencyMilliseconds: nonNegative,
  /** In dataset order. */
  cases: z.array(caseSchema).min(1),
});

export type EvaluationRunRecord = z.output<typeof evaluationRunRecordSchema>;
export type EvaluationRunCase = EvaluationRunRecord['cases'][number];
export type EvaluationRunTrial = EvaluationRunCase['trials'][number];

/** Parses an evaluation-run record, throwing {@link EvaluatorConfigurationError} on any issue. */
export function parseEvaluationRunRecord(input: unknown): EvaluationRunRecord {
  const parsed = evaluationRunRecordSchema.safeParse(input);
  if (!parsed.success) throw new EvaluatorConfigurationError(toConfigurationIssues(parsed.error));
  return parsed.data;
}
