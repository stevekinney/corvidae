import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import { throwingRejectionOf } from '@lostgradient/testing';

import { parseEvaluationRunRecord } from '../evaluation-run';
import { ACTION_CRITERION, SAFETY_CRITERIA } from './memory-evaluator';
import { baselineRunOf, suiteRun } from './memory-lifecycle.test-support';
import {
  actionSuccessOf,
  BEST_SIMPLER_BASELINE_PATH,
  bestSimplerBaseline,
  bestSimplerBaselineRecord,
  decideMemoryLifecycleRelease,
  memoryLifecycleGate,
} from './release';
import { runMemoryLifecycleSuite } from './suite-run';

describe('memoryLifecycleGate', () => {
  test('holds the safety criteria without regression and requires a predeclared improvement', () => {
    const gate = memoryLifecycleGate();
    expect(gate.package).toBe('@lostgradient/memory');
    expect(gate.sampleSize).toBe(14);
    for (const criterion of SAFETY_CRITERIA) {
      expect(gate.regressionThresholds).toContainEqual({
        criterion,
        metric: 'passFraction',
        maximumDecrease: 0,
        severity: 'hard',
      });
    }
    expect(gate.regressionThresholds).toContainEqual({
      criterion: ACTION_CRITERION,
      metric: 'passFraction',
      minimumIncrease: 0.1,
      severity: 'hard',
    });
  });
});

describe('bestSimplerBaseline', () => {
  test('is the simpler baseline with the highest action success, ties to the simpler one', async () => {
    const run = await suiteRun();
    expect(bestSimplerBaseline(run.baselines)?.baseline).toBe('raw-log-search');
    const raw = baselineRunOf(run, 'raw-log-search');
    const flat = baselineRunOf(run, 'flat-hybrid');
    expect(bestSimplerBaseline([flat, { ...raw, record: flat.record }])?.baseline).toBe(
      'raw-log-search',
    );
    expect(bestSimplerBaseline([baselineRunOf(run, 'lifecycle')])).toBeUndefined();
  });

  test('treats a run that scored no action as no success', async () => {
    const { record } = baselineRunOf(await suiteRun(), 'no-memory');
    expect(actionSuccessOf({ ...record, statistics: { ...record.statistics, criteria: [] } })).toBe(
      0,
    );
  });
});

describe('decideMemoryLifecycleRelease', () => {
  test('passes the lifecycle architecture against the best simpler baseline of the same run', async () => {
    const release = await decideMemoryLifecycleRelease(await suiteRun());
    expect(release).toMatchObject({
      gateId: 'memory-lifecycle',
      candidate: 'lifecycle',
      baseline: 'raw-log-search',
      decision: 'pass',
      exitCode: 0,
      findings: { infrastructureFailures: [], insufficientEvidence: [], regressions: [] },
    });
    const action = release.comparison!.criteria.find((entry) => entry.name === ACTION_CRITERION)!;
    expect(action.passFraction.delta).toBeGreaterThanOrEqual(0.1);
  });

  test('finds a candidate that is no better than the best simpler baseline short of the predeclared improvement', async () => {
    const run = await suiteRun();
    const raw = baselineRunOf(run, 'raw-log-search');
    const release = await decideMemoryLifecycleRelease({
      ...run,
      baselines: run.baselines.map((entry) =>
        entry.baseline === 'lifecycle'
          ? { ...entry, record: { ...raw.record, id: entry.record.id } }
          : entry,
      ),
    });
    expect(release.decision).toBe('regression');
    expect(release.exitCode).toBe(1);
    expect(release.findings.regressions).toEqual([
      expect.objectContaining({ criterion: ACTION_CRITERION, minimumIncrease: 0.1, delta: 0 }),
    ]);
  });

  test('needs the lifecycle baseline, and reports no simpler baseline as missing evidence', async () => {
    const run = await suiteRun();
    expect(
      await throwingRejectionOf(decideMemoryLifecycleRelease({ ...run, baselines: [] })),
    ).toThrow('A release decision needs the lifecycle baseline in the run');
    const alone = await decideMemoryLifecycleRelease({
      ...run,
      baselines: [baselineRunOf(run, 'lifecycle')],
    });
    expect(alone).toMatchObject({ baseline: null, decision: 'insufficient-evidence', exitCode: 3 });
    expect(alone.findings.insufficientEvidence.map((finding) => finding.reason)).toEqual([
      'baseline-missing',
    ]);
  });
});

describe('bestSimplerBaselineRecord', () => {
  test('is exactly the committed record the gate compares with', async () => {
    const committed = parseEvaluationRunRecord(
      JSON.parse(await readFile(BEST_SIMPLER_BASELINE_PATH, 'utf8')),
    );
    const record = await bestSimplerBaselineRecord();
    expect(record).toEqual(committed);
    expect(record.id).toBe('memory-lifecycle.deterministic.raw-log-search');
  });

  test('comes from a run of the simpler baselines alone', async () => {
    const run = await runMemoryLifecycleSuite({
      lane: 'deterministic',
      baselines: ['no-memory', 'raw-log-search', 'flat-hybrid'],
      monotonic: () => 0,
      recordedAt: '2026-09-28T00:00:00.000Z',
    });
    expect(bestSimplerBaseline(run.baselines)!.record).toEqual(await bestSimplerBaselineRecord());
  });
});
