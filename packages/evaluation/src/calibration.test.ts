import { describe, expect, test } from 'bun:test';

import { createScriptedGenerate } from '@lostgradient/operative';

import {
  calibrationRecordSchema,
  driftCheckRecordSchema,
  isGateEligibleJudge,
  judgeEligibility,
  parseCalibrationRecord,
} from './calibration';
import { EvaluatorConfigurationError, parseEvaluatorConfiguration } from './configuration';
import { modelConfigurationInput } from './evaluation.test-support';
import calibrationSet from './fixtures/judge-drift/calibration-set.json';
import driftedRevision from './fixtures/judge-drift/drifted-revision.json';
import stableRevision from './fixtures/judge-drift/stable-revision.json';
import { checkJudgeDrift, type JudgeDriftCheck, judgeRevisionOf } from './judge-drift';

type RevisionFixture = typeof stableRevision;

async function driftCheck(revision: RevisionFixture): Promise<JudgeDriftCheck> {
  return checkJudgeDrift(
    {
      configuration: { ...modelConfigurationInput(), promptVersion: revision.promptVersion },
      generate: createScriptedGenerate(
        revision.replies.map((entry) => ({
          kind: 'respond' as const,
          response: { content: JSON.stringify(entry), toolCalls: [] },
        })),
      ),
    },
    calibrationSet,
  );
}

async function digestOf(revision: RevisionFixture): Promise<string> {
  const configuration = parseEvaluatorConfiguration({
    ...modelConfigurationInput(),
    promptVersion: revision.promptVersion,
  });
  const judgeRevision = await judgeRevisionOf(configuration);
  return judgeRevision.digest;
}

function calibrationRecord(judgeRevision: string) {
  return parseCalibrationRecord({
    judgeRevision,
    reviewer: 'evaluation-calibrator',
    sampleSize: 40,
    agreementRate: 0.925,
    recordedAt: '2026-09-28T12:00:00Z',
  });
}

describe('parseCalibrationRecord', () => {
  test('returns a human calibration record for one judge revision', async () => {
    const digest = await digestOf(stableRevision);
    expect(calibrationRecord(digest)).toEqual({
      judgeRevision: digest,
      reviewer: 'evaluation-calibrator',
      sampleSize: 40,
      agreementRate: 0.925,
      recordedAt: '2026-09-28T12:00:00Z',
    });
  });

  test('rejects a record without a revision digest, reviewer, sample, rate, or timestamp', () => {
    let caught: unknown;
    try {
      parseCalibrationRecord({
        judgeRevision: 'judge-prompt-3',
        reviewer: '',
        sampleSize: 0,
        agreementRate: 1.5,
        recordedAt: 'last week',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EvaluatorConfigurationError);
    expect(
      (caught as EvaluatorConfigurationError).issues
        .map((issue) => issue.path.join('.'))
        .toSorted(),
    ).toEqual(['agreementRate', 'judgeRevision', 'recordedAt', 'reviewer', 'sampleSize']);
    expect(calibrationRecordSchema.safeParse({}).success).toBe(false);
  });
});

describe('isGateEligibleJudge', () => {
  test('keeps the prior approved revision eligible when a new revision fails its drift check', async () => {
    const stable = await digestOf(stableRevision);
    const drifted = await digestOf(driftedRevision);
    expect(drifted).not.toBe(stable);
    const driftChecks = [await driftCheck(stableRevision), await driftCheck(driftedRevision)];
    expect(driftChecks.map((check) => check.outcome)).toEqual(['passed', 'drifted']);
    const calibrationRecords = [calibrationRecord(stable), calibrationRecord(drifted)];

    expect(isGateEligibleJudge({ judgeRevision: stable, driftChecks, calibrationRecords })).toBe(
      true,
    );
    expect(isGateEligibleJudge({ judgeRevision: drifted, driftChecks, calibrationRecords })).toBe(
      false,
    );
  });

  test('is false for a revision with a passing drift check but no calibration record', async () => {
    const stable = await digestOf(stableRevision);
    const driftChecks = [await driftCheck(stableRevision)];
    expect(
      isGateEligibleJudge({ judgeRevision: stable, driftChecks, calibrationRecords: [] }),
    ).toBe(false);
    const otherRevision = calibrationRecord(await digestOf(driftedRevision));
    expect(
      isGateEligibleJudge({
        judgeRevision: stable,
        driftChecks,
        calibrationRecords: [otherRevision],
      }),
    ).toBe(false);
  });

  test('is false for a calibrated revision whose drift was never checked, or only indeterminately', async () => {
    const stable = await digestOf(stableRevision);
    const calibrationRecords = [calibrationRecord(stable)];
    expect(
      isGateEligibleJudge({ judgeRevision: stable, driftChecks: [], calibrationRecords }),
    ).toBe(false);
    const indeterminate: JudgeDriftCheck = {
      ...(await driftCheck(stableRevision)),
      outcome: 'indeterminate',
      agreementRate: null,
    };
    expect(
      isGateEligibleJudge({
        judgeRevision: stable,
        driftChecks: [indeterminate],
        calibrationRecords,
      }),
    ).toBe(false);
  });

  test('is false once any drift check of the revision has found drift', async () => {
    const stable = await digestOf(stableRevision);
    const passed = await driftCheck(stableRevision);
    const laterDrift: JudgeDriftCheck = { ...passed, outcome: 'drifted', agreementRate: 0.6 };
    expect(
      isGateEligibleJudge({
        judgeRevision: stable,
        driftChecks: [passed, laterDrift],
        calibrationRecords: [calibrationRecord(stable)],
      }),
    ).toBe(false);
  });
});

describe('judgeEligibility', () => {
  test('reports calibration and drift checking separately for one revision', async () => {
    const stable = await digestOf(stableRevision);
    const passed = { judgeRevision: stable, outcome: 'passed' as const };
    const calibrated = [calibrationRecord(stable)];

    expect(
      judgeEligibility({ judgeRevision: stable, driftChecks: [passed], calibrationRecords: [] }),
    ).toEqual({ calibrated: false, driftChecked: true });
    expect(
      judgeEligibility({ judgeRevision: stable, driftChecks: [], calibrationRecords: calibrated }),
    ).toEqual({ calibrated: true, driftChecked: false });
    expect(
      judgeEligibility({
        judgeRevision: stable,
        driftChecks: [passed],
        calibrationRecords: calibrated,
      }),
    ).toEqual({ calibrated: true, driftChecked: true });
  });

  test('accepts a drift check recorded as its revision and outcome alone', async () => {
    const stable = await digestOf(stableRevision);
    const full = await driftCheck(stableRevision);
    expect(driftCheckRecordSchema.parse(full)).toEqual({
      judgeRevision: stable,
      outcome: 'passed',
    });
    expect(() =>
      driftCheckRecordSchema.parse({ judgeRevision: 'abc', outcome: 'passed' }),
    ).toThrow();
    expect(() =>
      driftCheckRecordSchema.parse({ judgeRevision: stable, outcome: 'unknown' }),
    ).toThrow();
  });
});
