import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgent,
  createManualRuntimeServices,
  createScriptedGenerate,
} from '@lostgradient/operative';

import committedBaseline from './fixtures/release-gate/baseline-run.json';
import {
  FIXTURE_CODE_REVISION,
  fixtureConfiguration,
  fixtureRegressionEvaluator,
} from './fixtures/release-gate/fixture-regression';
import type { GateDecisionRecord } from './gate';
import type { EvaluationHistory } from './history';
import { costedRunResult, stubAgent } from './history.test-support';
import {
  decideGate,
  type GateEvaluatorDefinition,
  type GateRunResult,
  loadGateEvaluator,
  mostSevere,
  runReleaseGate,
  type RunReleaseGateOptions,
  toReleaseGateReport,
} from './release-gate';
import {
  BASELINE_RUN_PATH,
  capitalThresholdAt,
  COMMITTED_GATES_DIRECTORY,
  evaluatorModule,
  FIXTURE_GATE_ID,
  fixtureBaselineRun,
  fixtureGateFile,
  GATE_ACTOR,
  type GateFile,
  memoryHistory,
  writeGates,
} from './release-gate.test-support';

const OTHER_REVISION = 'b1c2d3e4f5a60718293a4b5c6d7e8f9012345678';

let scratch: string;
let directories = 0;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'release-gate-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function gatesWith(gate: GateFile, gateId = FIXTURE_GATE_ID): Promise<string> {
  directories += 1;
  return writeGates(join(scratch, `gates-${directories}`), { [gateId]: gate });
}

async function runGate(
  gate: GateFile,
  options: Partial<RunReleaseGateOptions> = {},
): Promise<{ result: GateRunResult; history: EvaluationHistory }> {
  const history = options.history ?? memoryHistory().history;
  const result = await runReleaseGate({
    gatesDirectory: await gatesWith(gate),
    gateId: FIXTURE_GATE_ID,
    actor: GATE_ACTOR,
    ...options,
    history,
  });
  return { result, history };
}

async function gateResult(
  gate: GateFile,
  options: Partial<RunReleaseGateOptions> = {},
): Promise<GateRunResult> {
  const { result } = await runGate(gate, options);
  return result;
}

function decided(result: GateRunResult): GateDecisionRecord {
  if (result.decision === 'configuration-error') {
    throw new Error(`Expected a decision, got configuration errors: ${result.issues.join('; ')}`);
  }
  return result.historical.record;
}

function issues(result: GateRunResult): readonly string[] {
  if (result.decision !== 'configuration-error') {
    throw new Error(`Expected a configuration error, got ${result.decision}`);
  }
  return result.issues;
}

/** Loads the passing fixture and changes its definition before the gate sees it. */
function modified(
  change: (definition: GateEvaluatorDefinition) => GateEvaluatorDefinition,
): RunReleaseGateOptions['loadEvaluator'] {
  return async () => change(await fixtureRegressionEvaluator('passing'));
}

function atRevision(codeRevision: string) {
  return modified((definition) => ({
    ...definition,
    configuration: { ...fixtureConfiguration(), codeRevision },
    contaminationChecks: (definition.contaminationChecks as Record<string, unknown>[]).map(
      (check) => ({ ...check, codeRevision }),
    ),
  }));
}

/** A clock that reads `times` in order, then stays at the last one. */
function clock(...times: number[]): () => number {
  let index = 0;
  return () => times[Math.min(index++, times.length - 1)]!;
}

describe('fixture baseline', () => {
  test('the committed baseline run is the passing script’s run under fixed seeds', async () => {
    expect(await fixtureBaselineRun()).toEqual(committedBaseline as never);
  });
});

describe('runReleaseGate', () => {
  test('passes the committed fixture gate against its committed baseline and appends one decision', async () => {
    const { history } = memoryHistory();
    const result = await runReleaseGate({
      gatesDirectory: COMMITTED_GATES_DIRECTORY,
      gateId: FIXTURE_GATE_ID,
      history,
      actor: GATE_ACTOR,
      now: clock(Date.parse('2026-09-28T12:00:00.000Z'), Date.parse('2026-09-28T12:00:01.500Z')),
      createId: (gateId, recordedAt) => `${gateId}.${recordedAt.slice(0, 10)}`,
    });

    expect(result.decision).toBe('pass');
    const record = decided(result);
    expect(record).toMatchObject({
      kind: 'gate-decision',
      id: 'fixture-regression.2026-09-28',
      recordedAt: '2026-09-28T12:00:01.500Z',
      gateId: FIXTURE_GATE_ID,
      actor: GATE_ACTOR,
      evaluator: {
        module: 'src/fixtures/release-gate/passing.ts',
        name: 'fixture-regression',
        revision: 1,
        judge: 'model',
      },
      dataset: { id: 'capitals', version: 'capitals-2026-09' },
      eligibility: { contaminationChecked: true, judge: { calibrated: true, driftChecked: true } },
      baseline: {
        source: { kind: 'evaluation-run', path: 'src/fixtures/release-gate/baseline-run.json' },
        revisionDistance: 0,
        ageMilliseconds:
          Date.parse('2026-09-28T12:00:01.500Z') - Date.parse('2026-09-28T00:00:00.000Z'),
      },
      overrides: { considered: [], applied: [], rejected: [] },
      findings: { infrastructureFailures: [], insufficientEvidence: [], regressions: [] },
      decision: 'pass',
    });
    expect(record.candidate).toMatchObject({
      id: 'fixture-regression.2026-09-28.candidate',
      latencyMilliseconds: 1500,
      outcomes: { pass: 2, fail: 0, disagreement: 0, indeterminate: 0 },
    });
    expect(result.decision !== 'configuration-error' && result.comparison?.kind).toBe(
      'evaluation-run-comparison',
    );

    const [held, open] = record.evidence;
    expect(held).toMatchObject({ ordinal: 1, visibility: 'held-out' });
    expect(held).not.toHaveProperty('caseId');
    expect(open).toMatchObject({ ordinal: 2, visibility: 'public', caseId: 'case-japan' });
    expect(held!.trials).toHaveLength(3);
    expect(held!.trials[0]).toMatchObject({
      trial: 1,
      run: { finishReason: 'stop-condition', content: 'Paris, on the Seine.' },
      judge: { kind: 'reply', requestedTools: [] },
      latencyBudgetExceeded: false,
    });

    const stored = await history.list();
    expect(stored.map(({ record: entry }) => entry.kind)).toEqual(['gate-decision']);
    expect(stored[0]).toEqual(result.decision === 'pass' ? result.historical : undefined);
  });

  test('exits the regressing script as a hard regression of the capital criterion', async () => {
    const { result } = await runGate(fixtureGateFile('regressing'));
    expect(result.decision).toBe('regression');
    expect(decided(result).findings).toEqual({
      infrastructureFailures: [],
      insufficientEvidence: [],
      regressions: [
        {
          criterion: 'names-the-capital',
          metric: 'passFraction',
          severity: 'hard',
          maximumDecrease: 0.1,
          baseline: 1,
          candidate: 0.5,
          delta: -0.5,
          overriddenBy: null,
        },
      ],
    });
  });

  test('reports a judge that throws as an evaluator infrastructure failure, never a pass', async () => {
    const { result } = await runGate(fixtureGateFile('judge-throws'));
    expect(result.decision).toBe('infrastructure-failure');
    const record = decided(result);
    expect(record.findings.infrastructureFailures).toEqual([
      {
        reason: 'evaluator-infrastructure-failure',
        detail:
          'Case 1 could not be scored (trial 1: judge-error, trial 2: judge-error, trial 3: judge-error)',
      },
      {
        reason: 'evaluator-infrastructure-failure',
        detail:
          'Case 2 could not be scored (trial 1: judge-error, trial 2: judge-error, trial 3: judge-error)',
      },
    ]);
    expect(record.evidence[0]!.trials[0]!.judge).toEqual({ kind: 'error' });
  });

  test('refuses an uncalibrated judge as insufficient evidence', async () => {
    const { result } = await runGate(fixtureGateFile('uncalibrated'));
    expect(result.decision).toBe('insufficient-evidence');
    const record = decided(result);
    expect(record.eligibility.judge).toMatchObject({ calibrated: false, driftChecked: true });
    expect(record.findings.insufficientEvidence.map((finding) => finding.reason)).toEqual([
      'judge-uncalibrated',
    ]);
  });

  test('refuses a sample smaller than the gate’s sample size', async () => {
    const { result } = await runGate(fixtureGateFile('passing', { sampleSize: 7 }));
    expect(result.decision).toBe('insufficient-evidence');
    expect(decided(result).findings.insufficientEvidence).toEqual([
      { reason: 'sample-size-not-met', detail: '6 trials recorded; the gate requires 7' },
    ]);
  });

  test('refuses a drift-unchecked judge and a dataset without a contamination check', async () => {
    const { result } = await runGate(fixtureGateFile(), {
      loadEvaluator: modified((definition) => ({
        ...definition,
        driftChecks: [],
        contaminationChecks: [],
      })),
    });
    expect(decided(result).findings.insufficientEvidence.map((finding) => finding.reason)).toEqual([
      'dataset-not-contamination-checked',
      'judge-not-drift-checked',
    ]);
  });

  test('refuses an unresolved disagreement between trials', async () => {
    const answers = ['Lyon.', 'Paris.', 'Lyon.', 'Tokyo.', 'Tokyo.', 'Tokyo.'];
    const generate = createScriptedGenerate(
      answers.map((content) => ({
        kind: 'respond' as const,
        response: { content, toolCalls: [] },
      })),
    );
    const { result } = await runGate(fixtureGateFile(), {
      loadEvaluator: modified((definition) => ({
        ...definition,
        subject: () => createAgent({ name: 'geographer', generate }),
      })),
    });
    expect(result.decision).toBe('insufficient-evidence');
    expect(decided(result).findings.insufficientEvidence).toContainEqual({
      reason: 'unresolved-disagreement',
      detail: "Case 1's trials disagree (below-minimum-pass-fraction)",
    });
  });

  test('treats a gate run over its cost or latency budget as an infrastructure failure', async () => {
    const overCost = await runGate(fixtureGateFile(), {
      loadEvaluator: modified((definition) => ({
        ...definition,
        subject: () => stubAgent(() => Promise.resolve(costedRunResult(0.5))),
      })),
    });
    expect(decided(overCost.result).findings.infrastructureFailures).toEqual([
      {
        reason: 'gate-budget-exceeded',
        detail: 'The gate run cost 3 USD; its budget is 1 USD',
      },
    ]);
    expect(decided(overCost.result).candidate.costUsd).toBe(3);

    const overTime = await runGate(fixtureGateFile(), { now: clock(0, 60_001) });
    expect(overTime.result.decision).toBe('infrastructure-failure');
    expect(decided(overTime.result).findings.infrastructureFailures).toEqual([
      {
        reason: 'gate-budget-exceeded',
        detail: 'The gate run took 60001 ms; its budget is 60000 ms',
      },
    ]);
  });

  test('counts held-out cases, not trials, as the sample of a deterministic judge', async () => {
    const deterministic = modified((definition) => {
      const configuration = fixtureConfiguration();
      const generate = createScriptedGenerate(
        ['Paris.', 'Tokyo.'].map((content) => ({
          kind: 'respond' as const,
          response: { content, toolCalls: [] },
        })),
      );
      return {
        ...definition,
        subject: () => createAgent({ name: 'geographer', generate }),
        configuration: {
          ...configuration,
          criteria: (configuration['criteria'] as { kind: string }[]).filter(
            (criterion) => criterion.kind !== 'model-judge',
          ),
          judge: { kind: 'deterministic', name: 'fixture-checks' },
          repetitions: 1,
          variancePolicy: undefined,
        },
        judge: undefined,
      };
    });
    const thresholds = {
      regressionThresholds: [
        {
          criterion: 'names-the-capital',
          metric: 'passFraction',
          maximumDecrease: 0.1,
          severity: 'hard',
        },
      ],
    };

    const enough = await runGate(fixtureGateFile('passing', { ...thresholds, sampleSize: 1 }), {
      loadEvaluator: deterministic,
    });
    expect(enough.result.decision).toBe('pass');
    expect(decided(enough.result).eligibility.judge).toBeNull();

    const tooFew = await runGate(fixtureGateFile('passing', { ...thresholds, sampleSize: 2 }), {
      loadEvaluator: deterministic,
    });
    expect(decided(tooFew.result).findings.insufficientEvidence).toEqual([
      { reason: 'sample-size-not-met', detail: '1 held-out cases recorded; the gate requires 2' },
    ]);
  });

  test('draws trial seeds from the given runtime', async () => {
    const seedsOf = async (randomSeed: string) => {
      const result = await gateResult(fixtureGateFile(), {
        runtime: createManualRuntimeServices({ randomSeed }),
      });
      return decided(result).evidence.flatMap((entry) => entry.trials.map((trial) => trial.seed));
    };
    expect(await seedsOf('seeds-a')).toEqual(await seedsOf('seeds-a'));
    expect(await seedsOf('seeds-a')).not.toEqual(await seedsOf('seeds-b'));
  });

  test('records the source revision it ran at when the runner knows it, apart from the declared code revision', async () => {
    const known = decided(await gateResult(fixtureGateFile(), { sourceRevision: OTHER_REVISION }));
    expect(known.sourceRevision).toBe(OTHER_REVISION);
    expect(known.candidate.codeRevision).toBe(FIXTURE_CODE_REVISION);

    const unknown = decided(await gateResult(fixtureGateFile()));
    expect(unknown).not.toHaveProperty('sourceRevision');
  });
});

describe('runReleaseGate baselines', () => {
  const latest = { baseline: { kind: 'latest-passing-decision' } };

  test('finds no baseline for a gate that has never passed', async () => {
    const { result } = await runGate(fixtureGateFile('passing', latest));
    expect(result.decision).toBe('insufficient-evidence');
    const record = decided(result);
    expect(record.baseline).toBeNull();
    expect(record.findings.insufficientEvidence).toEqual([
      {
        reason: 'baseline-missing',
        detail:
          'No earlier decision of this gate passed without an override or was accepted as its baseline',
      },
    ]);
  });

  test('compares with the latest passing decision of the same gate, skipping later failures', async () => {
    const { history } = memoryHistory();
    const first = decided(await gateResult(fixtureGateFile(), { history }));
    await runGate(fixtureGateFile('regressing'), { history });

    const { result } = await runGate(fixtureGateFile('passing', latest), { history });

    expect(result.decision).toBe('pass');
    const record = decided(result);
    expect(record.baseline?.source).toEqual({
      kind: 'gate-decision',
      recordId: first.id,
      digest: (await history.read(first.id))!.digest,
      acceptedBy: null,
    });
    expect(record.baseline?.run).toEqual(first.candidate);
  });

  test('refuses a passing decision older than the gate’s maximum age', async () => {
    const { history } = memoryHistory();
    const day = 86_400_000;
    await runGate(fixtureGateFile(), { history, now: clock(0) });

    const expired = await runGate(
      fixtureGateFile('passing', { ...latest, expiry: { maximumAgeMs: day } }),
      { history, now: clock(day + 1) },
    );
    expect(expired.result.decision).toBe('insufficient-evidence');
    expect(decided(expired.result).findings.insufficientEvidence).toEqual([
      {
        reason: 'baseline-expired',
        detail: expect.stringMatching(/is 86400001 ms old; the gate accepts at most 86400000 ms$/),
      },
    ]);

    const fresh = await runGate(
      fixtureGateFile('passing', { ...latest, expiry: { maximumAgeMs: day } }),
      { history, now: clock(day) },
    );
    expect(fresh.result.decision).toBe('pass');
  });

  test('refuses a baseline more commits behind than the gate allows, or an unknown distance', async () => {
    const run = (revisionDistance?: RunReleaseGateOptions['revisionDistance']) =>
      runGate(fixtureGateFile(), { loadEvaluator: atRevision(OTHER_REVISION), revisionDistance });

    const asked: [string, string][] = [];
    const near = await run((from, to) => {
      asked.push([from, to]);
      return 50;
    });
    expect(near.result.decision).toBe('pass');
    expect(asked).toEqual([[FIXTURE_CODE_REVISION, OTHER_REVISION]]);
    expect(decided(near.result).baseline?.revisionDistance).toBe(50);

    const far = await run(() => 51);
    expect(decided(far.result).findings.insufficientEvidence).toEqual([
      {
        reason: 'baseline-expired',
        detail:
          'Baseline evaluation run src/fixtures/release-gate/baseline-run.json is 51 commits behind; the gate accepts at most 50',
      },
    ]);

    for (const unknown of [await run(() => undefined), await run()]) {
      expect(decided(unknown.result).baseline?.revisionDistance).toBeNull();
      expect(decided(unknown.result).findings.insufficientEvidence).toEqual([
        {
          reason: 'baseline-expired',
          detail: `The distance from baseline evaluation run src/fixtures/release-gate/baseline-run.json at ${FIXTURE_CODE_REVISION} to ${OTHER_REVISION} could not be determined`,
        },
      ]);
    }
  });

  test('refuses a baseline of another dataset version, and a threshold the baseline cannot measure', async () => {
    const baseline = JSON.parse(await readFile(BASELINE_RUN_PATH, 'utf8')) as {
      dataset: { version: string };
      statistics: { criteria: { name: string }[] };
    };
    const otherDataset = join(scratch, 'other-dataset.json');
    await writeFile(
      otherDataset,
      JSON.stringify({
        ...baseline,
        dataset: { ...baseline.dataset, version: 'capitals-2026-08' },
      }),
    );
    const incomparable = await runGate(
      fixtureGateFile('passing', { baseline: { kind: 'evaluation-run', path: otherDataset } }),
    );
    expect(decided(incomparable.result).findings.insufficientEvidence).toEqual([
      {
        reason: 'baseline-not-comparable',
        detail: expect.stringContaining('scored dataset "capitals" version "capitals-2026-08"'),
      },
    ]);
    expect(decided(incomparable.result).baseline?.source).toMatchObject({
      kind: 'evaluation-run',
      path: expect.stringMatching(/other-dataset\.json$/),
    });

    const withoutTone = join(scratch, 'without-tone.json');
    await writeFile(
      withoutTone,
      JSON.stringify({
        ...baseline,
        statistics: {
          ...baseline.statistics,
          criteria: baseline.statistics.criteria.filter(
            (criterion) => criterion.name !== 'helpful-tone',
          ),
        },
      }),
    );
    const unmeasured = await runGate(
      fixtureGateFile('passing', { baseline: { kind: 'evaluation-run', path: withoutTone } }),
    );
    expect(decided(unmeasured.result).findings.insufficientEvidence).toEqual([
      {
        reason: 'criterion-not-comparable',
        detail: '"helpful-tone" meanScore is missing from the baseline or the run',
      },
    ]);
  });
});

describe('runReleaseGate configuration errors', () => {
  test.each<[string, GateFile]>([
    ['a gate without a baseline', { baseline: undefined }],
    ['a gate without a sample size', { sampleSize: undefined }],
    ['a threshold on a criterion the evaluator does not have', capitalThresholdAt('hard')],
  ])('appends nothing for %s', async (label, changes) => {
    const gate = fixtureGateFile('passing', changes);
    if (label.startsWith('a threshold')) {
      (gate['regressionThresholds'] as { criterion: string }[])[0]!.criterion = 'spells-it-right';
    }
    const { result, history } = await runGate(JSON.parse(JSON.stringify(gate)));
    expect(result.decision).toBe('configuration-error');
    expect(await history.list()).toEqual([]);
  });

  test('names each missing field of the gate file', async () => {
    const withoutBaseline = await runGate(fixtureGateFile('passing', { baseline: undefined }));
    expect(issues(withoutBaseline.result)).toEqual([
      'gate: baseline: Invalid input: expected object, received undefined',
    ]);
  });

  test('rejects a gate id that is not a plain identifier, a missing gate file, and a file that is not JSON', async () => {
    const { history } = memoryHistory();
    const directory = await gatesWith(fixtureGateFile());
    const run = (gateId: string) =>
      runReleaseGate({ gatesDirectory: directory, gateId, history, actor: GATE_ACTOR });

    expect(issues(await run('../gates/fixture-regression'))[0]).toStartWith(
      'gate: "../gates/fixture-regression" is not a gate id',
    );
    expect(issues(await run('never-written'))[0]).toStartWith('gate: ENOENT');
    await writeFile(join(directory, 'broken.json'), '{ "baseline": ');
    expect(issues(await run('broken'))[0]).toStartWith('gate: JSON Parse error');
  });

  test('rejects an evaluator module that cannot build an evaluator', async () => {
    const withDefinition = (definition: unknown) =>
      gateResult(fixtureGateFile(), {
        loadEvaluator: () => Promise.resolve(definition as GateEvaluatorDefinition),
      });
    const passing = await fixtureRegressionEvaluator('passing');

    expect(issues(await withDefinition({ ...passing, subject: undefined }))).toEqual([
      expect.stringMatching(
        /^evaluator: .*passing\.ts builds an evaluator without a subject agent$/,
      ),
    ]);
    expect(
      issues(await withDefinition({ ...passing, configuration: { name: 'x' } }))[0],
    ).toStartWith('evaluator: revision:');
    expect(
      issues(await withDefinition({ ...passing, calibrationRecords: [{ reviewer: 'x' }] }))[0],
    ).toStartWith('evaluator: calibrationRecords.0.judgeRevision:');

    const throwing = await runGate(fixtureGateFile(), {
      loadEvaluator: () => Promise.reject(new Error('no such module')),
    });
    expect(issues(throwing.result)).toEqual(['evaluator: no such module']);
    const thrownValue = await runGate(fixtureGateFile(), {
      loadEvaluator: () => Promise.reject('not an error'),
    });
    expect(issues(thrownValue.result)).toEqual(['evaluator: not an error']);
  });

  test('rejects an evaluator that scores another dataset than the gate names', async () => {
    const { result } = await runGate(
      fixtureGateFile('passing', { dataset: { id: 'capitals', version: 'capitals-2026-08' } }),
    );
    expect(issues(result)).toEqual([
      'evaluator: scores dataset "capitals" version "capitals-2026-09", but the gate names "capitals" version "capitals-2026-08"',
    ]);
  });

  test('rejects a committed baseline that is missing or is not an evaluation run', async () => {
    const missing = await runGate(
      fixtureGateFile('passing', {
        baseline: { kind: 'evaluation-run', path: join(scratch, 'absent.json') },
      }),
    );
    expect(issues(missing.result)[0]).toStartWith('baseline: ENOENT');

    const notARun = join(scratch, 'not-a-run.json');
    await writeFile(notARun, JSON.stringify({ kind: 'dashboard' }));
    const invalid = await runGate(
      fixtureGateFile('passing', { baseline: { kind: 'evaluation-run', path: notARun } }),
    );
    expect(issues(invalid.result)[0]).toStartWith('baseline: kind:');
  });

  test('propagates a failure of the history itself', async () => {
    const failure = new Error('disk full');
    const { history } = memoryHistory();
    await expect(
      runGate(fixtureGateFile(), { history: { ...history, list: () => Promise.reject(failure) } }),
    ).rejects.toBe(failure);
  });
});

describe('loadGateEvaluator', () => {
  test('builds a fresh definition from a module’s default export', async () => {
    const first = await loadGateEvaluator(evaluatorModule('passing'));
    const second = await loadGateEvaluator(evaluatorModule('passing'));
    expect(first.judge).not.toBe(second.judge);
    expect(first.configuration).toEqual(fixtureConfiguration());
  });

  test('rejects a module without a default export that builds an evaluator', async () => {
    await expect(
      loadGateEvaluator(join(import.meta.dir, 'fixtures', 'release-gate', 'fixture-regression.ts')),
    ).rejects.toThrow('has no default export that builds an evaluator');
  });
});

describe('decideGate', () => {
  test('ranks infrastructure failure over insufficient evidence over regression', async () => {
    const { result } = await runGate(fixtureGateFile('regressing'));
    const record = decided(result);
    const inputs = {
      gate: record.gate,
      judge: record.evaluator.judge,
      eligibility: record.eligibility,
      candidate: record.candidate,
      baseline: record.baseline,
      overrides: [],
    };
    const regressed = await decideGate(inputs);
    expect(regressed.decision).toBe('regression');
    const uncalibrated = {
      ...inputs,
      eligibility: {
        ...inputs.eligibility,
        judge: { ...inputs.eligibility.judge!, calibrated: false },
      },
    };
    const refused = await decideGate(uncalibrated);
    expect(refused.decision).toBe('insufficient-evidence');
    const overBudget = {
      ...uncalibrated,
      candidate: { ...inputs.candidate, latencyMilliseconds: 60_001 },
    };
    const failed = await decideGate(overBudget);
    expect(failed.decision).toBe('infrastructure-failure');
  });

  test('reports a missing committed baseline in terms of the gate file', async () => {
    const { result } = await runGate(fixtureGateFile());
    const record = decided(result);
    const outputs = await decideGate({
      gate: record.gate,
      judge: record.evaluator.judge,
      eligibility: record.eligibility,
      candidate: record.candidate,
      baseline: null,
      overrides: [],
    });
    expect(outputs.findings.insufficientEvidence).toEqual([
      { reason: 'baseline-missing', detail: 'The gate names no baseline run' },
    ]);
  });
});

describe('toReleaseGateReport', () => {
  test('decides a multi-gate run by the most severe outcome: 64 > 2 > 3 > 1 > 0', async () => {
    const pass = await gateResult(fixtureGateFile());
    const regression = await gateResult(fixtureGateFile('regressing'));
    const insufficient = await gateResult(fixtureGateFile('uncalibrated'));
    const infrastructure = await gateResult(fixtureGateFile('judge-throws'));
    const configuration = await gateResult(fixtureGateFile('passing', { sampleSize: 0 }));

    const report = (...results: GateRunResult[]) => toReleaseGateReport(results);
    expect(report(pass).exitCode).toBe(0);
    expect(report(pass, regression).exitCode).toBe(1);
    expect(report(regression, insufficient).exitCode).toBe(3);
    expect(report(insufficient, infrastructure, regression).exitCode).toBe(2);
    expect(report(pass, infrastructure, configuration)).toMatchObject({
      decision: 'configuration-error',
      exitCode: 64,
      recordId: null,
    });

    const single = report(regression);
    expect(single).toMatchObject({
      kind: 'release-gate-report',
      schemaVersion: 1,
      recordId: decided(regression).id,
      decision: 'regression',
      exitCode: 1,
    });
    expect(single.gates[0]).toMatchObject({
      gateId: FIXTURE_GATE_ID,
      decision: 'regression',
      exitCode: 1,
      recordId: decided(regression).id,
      sample: { required: 6, recorded: 6 },
      costUsd: null,
      overrideIds: [],
      rejectedOverrides: [],
      baseline: {
        source: { kind: 'evaluation-run', path: 'src/fixtures/release-gate/baseline-run.json' },
        recordedAt: '2026-09-28T00:00:00.000Z',
        revisionDistance: 0,
      },
    });
    expect(report(configuration).gates[0]).toEqual({
      gateId: FIXTURE_GATE_ID,
      decision: 'configuration-error',
      exitCode: 64,
      recordId: null,
      digest: null,
      issues: ['gate: sampleSize: Too small: expected number to be >0'],
    });
    const missing = await gateResult(
      fixtureGateFile('passing', { baseline: { kind: 'latest-passing-decision' } }),
    );
    expect(report(missing).gates[0]).toMatchObject({ baseline: null, exitCode: 3 });
  });

  test('treats a run of no gates as a configuration error', () => {
    expect(mostSevere([])).toBe('configuration-error');
    expect(toReleaseGateReport([])).toMatchObject({
      decision: 'configuration-error',
      exitCode: 64,
    });
  });
});
