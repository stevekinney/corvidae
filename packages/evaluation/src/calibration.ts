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

/**
 * What eligibility reads from a {@link JudgeDriftCheck}: the revision it
 * checked and its outcome. A full drift check parses to this, and a gate can
 * cite a drift check recorded earlier by these two facts alone.
 */
export const driftCheckRecordSchema = z.object({
  judgeRevision: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a judge revision digest'),
  outcome: z.enum(['passed', 'drifted', 'indeterminate']),
});

export type DriftCheckRecord = Pick<JudgeDriftCheck, 'judgeRevision' | 'outcome'>;

export interface GateEligibleJudgeOptions {
  /** The `JudgeRevision.digest` that would back the gate. */
  readonly judgeRevision: string;
  readonly driftChecks: readonly DriftCheckRecord[];
  readonly calibrationRecords: readonly Pick<CalibrationRecord, 'judgeRevision'>[];
}

/** The two facts gate eligibility needs about one judge revision. */
export interface JudgeEligibility {
  /** A human calibration record exists for this exact revision. */
  readonly calibrated: boolean;
  /**
   * At least one drift check of this exact revision passed and none found
   * drift. An indeterminate drift check is neither evidence for nor against it.
   */
  readonly driftChecked: boolean;
}

export function judgeEligibility(options: GateEligibleJudgeOptions): JudgeEligibility {
  const { judgeRevision } = options;
  const checks = options.driftChecks.filter((check) => check.judgeRevision === judgeRevision);
  return {
    calibrated: options.calibrationRecords.some((record) => record.judgeRevision === judgeRevision),
    driftChecked:
      checks.some((check) => check.outcome === 'passed') &&
      !checks.some((check) => check.outcome === 'drifted'),
  };
}

/** True only when this exact revision is both calibrated and drift-checked. */
export function isGateEligibleJudge(options: GateEligibleJudgeOptions): boolean {
  const { calibrated, driftChecked } = judgeEligibility(options);
  return calibrated && driftChecked;
}
