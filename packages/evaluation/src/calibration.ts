/**
 * Human calibration and judge gate eligibility (COR-896, "human calibration"
 * and "judge drift checks").
 *
 * A {@link CalibrationRecord} is the recorded fact that a human reviewed a
 * sample of one judge revision's scores against the same rubric and measured
 * how often they agreed. It is evidence, not an optional audit: a judge
 * revision may back a release gate only when it has both a calibration
 * record and a passing drift check for that exact revision digest.
 *
 * Eligibility is decided per revision, so a new revision that fails its
 * drift check never touches the prior approved revision, which keeps gating.
 * Rolling back is selecting that prior revision again; nothing is rewritten.
 */
import { z } from 'zod';

import {
  EvaluatorConfigurationError,
  identifier,
  toConfigurationIssues,
  unitInterval,
} from './configuration';
import type { JudgeDriftCheck } from './judge-drift';

export const calibrationRecordSchema = z.strictObject({
  /** The `JudgeRevision.digest` whose scores were reviewed. */
  judgeRevision: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a judge revision digest'),
  /** Who reviewed the sample. */
  reviewer: identifier,
  /** How many judge scores the reviewer checked. */
  sampleSize: z.number().int().positive(),
  /** The share of sampled scores the reviewer agreed with. */
  agreementRate: unitInterval,
  recordedAt: z.iso.datetime({ offset: true }),
});

export type CalibrationRecord = z.output<typeof calibrationRecordSchema>;

/** Parses a calibration record, throwing {@link EvaluatorConfigurationError} on any issue. */
export function parseCalibrationRecord(input: unknown): CalibrationRecord {
  const parsed = calibrationRecordSchema.safeParse(input);
  if (!parsed.success) throw new EvaluatorConfigurationError(toConfigurationIssues(parsed.error));
  return parsed.data;
}

export interface GateEligibleJudgeOptions {
  /** The `JudgeRevision.digest` that would back the gate. */
  readonly judgeRevision: string;
  readonly driftChecks: readonly JudgeDriftCheck[];
  readonly calibrationRecords: readonly CalibrationRecord[];
}

/**
 * True only when this exact revision has a calibration record, at least one
 * passing drift check, and no drift check that found drift. An
 * indeterminate drift check is neither evidence for nor against it.
 */
export function isGateEligibleJudge(options: GateEligibleJudgeOptions): boolean {
  const { judgeRevision } = options;
  const checks = options.driftChecks.filter((check) => check.judgeRevision === judgeRevision);
  return (
    checks.some((check) => check.outcome === 'passed') &&
    !checks.some((check) => check.outcome === 'drifted') &&
    options.calibrationRecords.some((record) => record.judgeRevision === judgeRevision)
  );
}
