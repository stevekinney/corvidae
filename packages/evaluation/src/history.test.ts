import { describe, expect, test } from 'bun:test';

import { sha256Hex } from '@lostgradient/cryptography';
import {
  createManualRuntimeServices,
  createScriptedGenerate,
  type RunResultBase,
  type ScriptedGenerateStep,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';

import { EvaluatorConfigurationError } from './configuration';
import type { EvaluationRunRecord } from './evaluation-run';
import {
  datasetInput,
  EXPECTED_ANSWER,
  HELD_OUT_CASE_ID,
  modelConfigurationInput,
  runResult,
} from './evaluation.test-support';
import { createEvaluator } from './evaluator';
import baselineFixture from './fixtures/history/baseline-run.json';
import candidateFixture from './fixtures/history/candidate-run.json';
import {
  compareEvaluationRuns,
  CorruptHistoricalRecordError,
  createEvaluationHistory,
  type HistoricalRecord,
  HistoricalRecordExistsError,
  toEvaluationRunRecord,
} from './history';
import {
  BASELINE_RUN_ID,
  CANDIDATE_RUN_ID,
  costedRunResult,
  fixtureEvaluatorFor,
  fixtureRun,
  fixtureRunInputs,
  PUBLIC_CASE_ID,
  stubAgent,
} from './history.test-support';
import { canonicalJson } from './identity';
import { runTrials, type TrialAggregate } from './trials';

const RECORD_KEY_PREFIX = 'evaluation-history/records/';

function baselineRecord(): EvaluationRunRecord {
  return structuredClone(baselineFixture) as EvaluationRunRecord;
}

function candidateRecord(): EvaluationRunRecord {
  return structuredClone(candidateFixture) as EvaluationRunRecord;
}

function memoryHistory() {
  const storage = new MemoryStorage();
  const store = textValueStore(storage);
  return { storage, store, history: createEvaluationHistory(store) };
}

async function onlyKey(store: ReturnType<typeof textValueStore>): Promise<string> {
  const keys = await store.list('');
  expect(keys).toHaveLength(1);
  return keys[0]!;
}

describe('createEvaluationHistory', () => {
  test('exposes append, read, and list, and nothing that could rewrite a record', () => {
    const { store } = memoryHistory();
    expect(Object.keys(createEvaluationHistory(store)).toSorted()).toEqual([
      'append',
      'list',
      'read',
    ]);
  });

  test('appends a record under its id with the SHA-256 of its canonical JSON, and reads it back', async () => {
    const { store, history } = memoryHistory();
    const record = baselineRecord();

    const appended = await history.append(record);

    expect(appended).toEqual({ digest: await sha256Hex(canonicalJson(record)), record });
    expect(await store.list('')).toEqual([`${RECORD_KEY_PREFIX}${BASELINE_RUN_ID}`]);
    expect(await store.get(`${RECORD_KEY_PREFIX}${BASELINE_RUN_ID}`)).toBe(canonicalJson(appended));
    expect(await history.read(BASELINE_RUN_ID)).toEqual(appended);
  });

  test('keeps gate-override records beside evaluation runs, verified the same way', async () => {
    const { history } = memoryHistory();
    const override = {
      kind: 'gate-override' as const,
      schemaVersion: 1 as const,
      id: 'override-1',
      recordedAt: '2026-09-28T12:30:00.000Z',
      gateId: 'fixture-regression',
      gateDecisionId: 'fixture-regression.decision-1',
      actor: 'release-manager',
      reason: 'Accepting the tone change for the October release.',
      expiresAt: '2026-10-28T12:00:00.000Z',
      permanentBaselineChange: false,
      evidence: ['https://example.test/review/42'],
    };

    const run = await history.append(baselineRecord());
    const appended = await history.append(override);

    expect(appended).toEqual({
      digest: await sha256Hex(canonicalJson(override)),
      record: override,
    });
    expect(await history.read('override-1')).toEqual(appended);
    expect(await history.list()).toEqual([run, appended]);
  });

  test('refuses to append a record of a kind the history does not keep', async () => {
    const { store, history } = memoryHistory();
    const unknownKind = { ...baselineRecord(), kind: 'dashboard-snapshot' };
    await expect(history.append(unknownKind as never)).rejects.toBeInstanceOf(
      EvaluatorConfigurationError,
    );
    expect(await store.list('')).toEqual([]);
  });

  test('reads an unknown id as undefined', async () => {
    const { history } = memoryHistory();
    expect(await history.read('never-recorded')).toBeUndefined();
  });

  test('rejects a second record with the same id and leaves the first byte-identical', async () => {
    const { store, history } = memoryHistory();
    const first = await history.append(baselineRecord());
    const key = await onlyKey(store);
    const storedBefore = await store.get(key);

    const rewrite = { ...candidateRecord(), id: BASELINE_RUN_ID };
    const rejection = history.append(rewrite);
    await expect(rejection).rejects.toBeInstanceOf(HistoricalRecordExistsError);
    await expect(rejection).rejects.toMatchObject({ id: BASELINE_RUN_ID });

    expect(await store.get(key)).toBe(storedBefore);
    expect(await history.read(BASELINE_RUN_ID)).toEqual(first);
  });

  test('lets exactly one of two concurrent appends with the same id commit', async () => {
    const { history } = memoryHistory();
    const results = await Promise.allSettled([
      history.append(baselineRecord()),
      history.append({ ...candidateRecord(), id: BASELINE_RUN_ID }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const [rejected] = results.filter((result) => result.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(HistoricalRecordExistsError);
  });

  test.each([
    ['an id that is not a plain identifier', { id: 'runs/baseline' }],
    ['a timestamp that is not ISO-8601', { recordedAt: 'yesterday' }],
    ['a negative latency', { latencyMilliseconds: -1 }],
    ['an unknown field', { note: 'extra' }],
  ])('refuses to append a record with %s', async (_label, change) => {
    const { store, history } = memoryHistory();
    await expect(history.append({ ...baselineRecord(), ...change })).rejects.toBeInstanceOf(
      EvaluatorConfigurationError,
    );
    expect(await store.list('')).toEqual([]);
  });

  test('refuses to append a held-out case that carries its id, or a public case that does not', async () => {
    const { history } = memoryHistory();
    const leaking = baselineRecord();
    const [heldOut, publicCase] = leaking.cases;
    const withHeldOutId = { ...leaking, cases: [{ ...heldOut!, caseId: HELD_OUT_CASE_ID }] };
    await expect(history.append(withHeldOutId)).rejects.toThrow(
      /A held-out case is recorded by ordinal, never by id/,
    );
    const { caseId: _caseId, ...anonymousPublic } = publicCase!;
    const withoutPublicId = { ...leaking, cases: [anonymousPublic] };
    await expect(history.append(withoutPublicId)).rejects.toThrow(
      /A public case is recorded with its id/,
    );
  });

  test('rejects read() with CorruptHistoricalRecordError when any single byte of the stored record changes', async () => {
    const { storage, store, history } = memoryHistory();
    const appended = await history.append(baselineRecord());
    const key = await onlyKey(store);
    const original = (await storage.get(key))!.slice();

    for (let index = 0; index < original.length; index++) {
      const changed = original.slice();
      changed[index] = changed[index]! ^ 0x01;
      await storage.put(key, changed);
      await expect(history.read(BASELINE_RUN_ID)).rejects.toBeInstanceOf(
        CorruptHistoricalRecordError,
      );
    }

    await storage.put(key, original);
    expect(await history.read(BASELINE_RUN_ID)).toEqual(appended);
  });

  test('rejects a stored record that is not valid UTF-8', async () => {
    const { storage, store, history } = memoryHistory();
    await history.append(baselineRecord());
    const key = await onlyKey(store);
    const changed = (await storage.get(key))!.slice();
    changed[10] = 0xff;
    await storage.put(key, changed);

    const rejection = history.read(BASELINE_RUN_ID);
    await expect(rejection).rejects.toBeInstanceOf(CorruptHistoricalRecordError);
    await expect(rejection).rejects.toMatchObject({ id: BASELINE_RUN_ID });
  });

  test('propagates a storage failure that is not corruption', async () => {
    const { store } = memoryHistory();
    const failure = new Error('disk unavailable');
    const history = createEvaluationHistory({ ...store, get: () => Promise.reject(failure) });
    await expect(history.read(BASELINE_RUN_ID)).rejects.toBe(failure);
  });

  test('rejects a stored record that is valid JSON but not in canonical form', async () => {
    const { store, history } = memoryHistory();
    const appended = await history.append(baselineRecord());
    await store.set(await onlyKey(store), JSON.stringify(appended, null, 2));
    await expect(history.read(BASELINE_RUN_ID)).rejects.toThrow(/canonical/);
  });

  test('rejects a canonical record whose digest matches but whose shape is not a record', async () => {
    const { store, history } = memoryHistory();
    const record = { kind: 'evaluation-run', id: BASELINE_RUN_ID };
    await store.set(
      `${RECORD_KEY_PREFIX}${BASELINE_RUN_ID}`,
      canonicalJson({ digest: await sha256Hex(canonicalJson(record)), record }),
    );
    await expect(history.read(BASELINE_RUN_ID)).rejects.toThrow(/schema/);
  });

  test('rejects a record copied under another record’s id', async () => {
    const { store, history } = memoryHistory();
    await history.append(baselineRecord());
    const text = await store.get(await onlyKey(store));
    await store.set(`${RECORD_KEY_PREFIX}${CANDIDATE_RUN_ID}`, text!);
    await expect(history.read(CANDIDATE_RUN_ID)).rejects.toThrow(/names "run-baseline"/);
  });

  test('lists every verified record, oldest first', async () => {
    const { history } = memoryHistory();
    const candidate = await history.append(candidateRecord());
    const baseline = await history.append(baselineRecord());
    const sameInstant = await history.append({
      ...baselineRecord(),
      id: 'run-baseline-rerun',
      recordedAt: '2026-09-28T12:00:00.000+00:00',
    });

    expect(await history.list()).toEqual([baseline, sameInstant, candidate]);
  });

  test('refuses to list when any stored record is corrupt', async () => {
    const { store, history } = memoryHistory();
    await history.append(baselineRecord());
    await history.append(candidateRecord());
    await store.set(`${RECORD_KEY_PREFIX}${CANDIDATE_RUN_ID}`, '{}');
    const rejection = history.list();
    await expect(rejection).rejects.toBeInstanceOf(CorruptHistoricalRecordError);
    await expect(rejection).rejects.toMatchObject({ id: CANDIDATE_RUN_ID });
  });

  test('lists an empty history as an empty array', async () => {
    const { history } = memoryHistory();
    expect(await history.list()).toEqual([]);
  });
});

describe('toEvaluationRunRecord', () => {
  test.each([
    ['baseline', baselineFixture],
    ['candidate', candidateFixture],
  ] as const)(
    'produces the committed %s fixture from its scripted trials',
    async (which, fixture) => {
      expect(await fixtureRun(which)).toEqual(fixture as EvaluationRunRecord);
    },
  );

  test('records the evaluator, dataset, pooled statistics, cost, latency, and every case', () => {
    const record = candidateRecord();
    expect(record).toMatchObject({
      kind: 'evaluation-run',
      schemaVersion: 1,
      id: CANDIDATE_RUN_ID,
      evaluator: { name: 'capital-cities', revision: 3 },
      dataset: { id: 'capitals', version: 'capitals-2026-09' },
      codeRevision: 'b1c2d3e4f5a60718293a4b5c6d7e8f9012345678',
      repetitions: 2,
      variancePolicy: null,
      outcomes: { pass: 1, fail: 0, disagreement: 1, indeterminate: 0 },
      costUsd: 1.5,
      latencyMilliseconds: 1250,
    });
    expect(record.statistics.verdicts).toMatchObject({ trials: 4, passes: 3, passFraction: 0.75 });
    const [heldOut, publicCase] = record.cases;
    expect(heldOut).toMatchObject({
      ordinal: 1,
      visibility: 'held-out',
      outcome: 'disagreement',
      disagreementReasons: ['split-without-variance-policy'],
    });
    expect(heldOut).not.toHaveProperty('caseId');
    expect(publicCase).toMatchObject({
      ordinal: 2,
      visibility: 'public',
      caseId: PUBLIC_CASE_ID,
      outcome: 'pass',
    });
    expect(heldOut?.trials[1]).toMatchObject({
      trial: 2,
      verdict: 'fail',
      finishReason: 'stop-condition',
      usage: { prompt: 12, completion: 8, total: 20 },
      costUsd: 0.25,
    });
    expect(heldOut?.trials[1]?.scores[0]).toEqual({
      name: 'names-the-capital',
      score: 0,
      hardGate: 'failed',
    });
  });

  test('never stores a held-out case id or expected answer, even where the evidence quotes them', async () => {
    const quoting = `Expected "${EXPECTED_ANSWER}" for ${HELD_OUT_CASE_ID}.`;
    const judgeStep = (score: number): ScriptedGenerateStep => ({
      kind: 'respond',
      response: {
        content: JSON.stringify({
          criteria: [{ name: 'helpful-tone', score, rationale: quoting }],
          feedback: quoting,
        }),
        toolCalls: [],
      },
    });
    let policyCalls = 0;
    const evaluator = await createEvaluator({
      configuration: modelConfigurationInput(),
      dataset: datasetInput(),
      scorers: {
        assertions: { 'names-the-capital': () => true },
        heuristics: { concise: () => 1 },
        policies: {
          'follows-style-guide': () => {
            if (++policyCalls === 5) throw new Error(`${EXPECTED_ANSWER} is not in the guide`);
            return true;
          },
        },
      },
      generate: createScriptedGenerate([
        judgeStep(1),
        judgeStep(1),
        { kind: 'fail', error: new Error(`The provider refused ${HELD_OUT_CASE_ID}`) },
        judgeStep(0),
      ]),
    });
    const runtime = createManualRuntimeServices({ randomSeed: 'held-out' });
    let calls = 0;
    const subject = () =>
      stubAgent(() =>
        ++calls === 2
          ? Promise.reject(new Error(`No capital for ${HELD_OUT_CASE_ID}: ${EXPECTED_ANSWER}`))
          : Promise.resolve(runResult()),
      );
    const aggregates: TrialAggregate[] = [];
    for (const caseId of [HELD_OUT_CASE_ID, PUBLIC_CASE_ID]) {
      aggregates.push(await runTrials({ evaluator, caseId, subject, runtime }));
    }
    // The aggregates themselves are reviewer material and do quote the secrets.
    expect(JSON.stringify(aggregates)).toContain(HELD_OUT_CASE_ID);
    expect(JSON.stringify(aggregates)).toContain(EXPECTED_ANSWER);

    const { storage, store, history } = memoryHistory();
    const { record } = await history.append(
      toEvaluationRunRecord({
        id: 'run-held-out',
        recordedAt: '2026-09-28T14:00:00.000Z',
        evaluator,
        aggregates,
        latencyMilliseconds: 10,
      }),
    );

    expect(record.cases.map((entry) => entry.outcome)).toEqual(['indeterminate', 'indeterminate']);
    expect(record.cases[0]?.trials[1]?.error).toEqual({ reason: 'subject-error' });
    expect(record.cases[1]?.trials.map((trial) => trial.error)).toEqual([
      { reason: 'judge-error' },
      undefined,
      { reason: 'scorer-error', criterion: 'follows-style-guide' },
    ]);
    expect(record.costUsd).toBeNull();
    const keys = await store.list('');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const row = new TextDecoder().decode((await storage.get(key))!);
      expect(row).not.toContain(HELD_OUT_CASE_ID);
      expect(row).not.toContain(EXPECTED_ANSWER);
      expect(row).toContain(PUBLIC_CASE_ID);
    }
  });

  test('keeps prompt-cache token counts when the run reports them', async () => {
    const record = await recordOfOneTrial({
      ...costedRunResult(0.5),
      usage: { prompt: 12, completion: 8, total: 20, cacheCreationTokens: 3, cacheReadTokens: 4 },
    });
    expect(record.cases[0]?.trials[0]?.usage).toEqual({
      prompt: 12,
      completion: 8,
      total: 20,
      cacheCreationTokens: 3,
      cacheReadTokens: 4,
    });
    // Both of the case's trials cost 0.5.
    expect(record.costUsd).toBe(1);
  });

  test('records an agent-failed trial without scores', async () => {
    const record = await recordOfOneTrial(runResult({ finishReason: 'maximum-steps' }));
    expect(record.cases[0]?.trials[0]).toEqual({
      trial: 1,
      seed: record.cases[0]!.trials[0]!.seed,
      verdict: 'agent-failed',
      finishReason: 'maximum-steps',
      usage: { prompt: 12, completion: 8, total: 20 },
      scores: [],
    });
    expect(record.costUsd).toBeNull();
  });

  test('rejects aggregates it cannot attribute to the evaluator and its dataset', async () => {
    const baseline = await fixtureRunInputs('baseline');
    const candidate = await fixtureRunInputs('candidate');
    const record = (aggregates: readonly TrialAggregate[]) => () =>
      toEvaluationRunRecord({
        id: 'run-invalid',
        recordedAt: '2026-09-28T15:00:00.000Z',
        evaluator: baseline.evaluator,
        aggregates,
        latencyMilliseconds: 1,
      });

    expect(record([])).toThrow(/at least one case/);
    expect(record([baseline.aggregates[0]!, candidate.aggregates[1]!])).toThrow(
      /another evaluator/,
    );
    expect(record([baseline.aggregates[0]!, baseline.aggregates[0]!])).toThrow(/more than once/);
    expect(record([{ ...baseline.aggregates[0]!, caseId: 'case-peru' }])).toThrow(
      /not in dataset "capitals"/,
    );
  });
});

describe('compareEvaluationRuns', () => {
  async function stored(
    record: EvaluationRunRecord,
  ): Promise<HistoricalRecord<EvaluationRunRecord>> {
    return { digest: await sha256Hex(canonicalJson(record)), record };
  }

  test('reports per-criterion pass-fraction and mean-score deltas, plus cost and latency deltas', async () => {
    const baseline = await stored(baselineRecord());
    const candidate = await stored(candidateRecord());

    const comparison = compareEvaluationRuns(baseline, candidate);

    expect(comparison).toEqual({
      kind: 'evaluation-run-comparison',
      baseline: {
        id: BASELINE_RUN_ID,
        digest: baseline.digest,
        recordedAt: '2026-09-28T12:00:00.000Z',
        evaluator: baseline.record.evaluator,
        dataset: { id: 'capitals', version: 'capitals-2026-09' },
        codeRevision: 'a7679370f3e1a3b850299d13c9e768541a601722',
      },
      candidate: {
        id: CANDIDATE_RUN_ID,
        digest: candidate.digest,
        recordedAt: '2026-09-28T13:00:00.000Z',
        evaluator: candidate.record.evaluator,
        dataset: { id: 'capitals', version: 'capitals-2026-09' },
        codeRevision: 'b1c2d3e4f5a60718293a4b5c6d7e8f9012345678',
      },
      verdicts: { passFraction: { baseline: 1, candidate: 0.75, delta: -0.25 } },
      criteria: [
        {
          name: 'names-the-capital',
          passFraction: { baseline: 1, candidate: 0.75, delta: -0.25 },
          meanScore: { baseline: 1, candidate: 0.75, delta: -0.25 },
        },
        {
          name: 'concise',
          passFraction: { baseline: 1, candidate: 0.5, delta: -0.5 },
          meanScore: { baseline: 1, candidate: 0.625, delta: -0.375 },
        },
        {
          name: 'no-web-search',
          passFraction: { baseline: 1, candidate: 1, delta: 0 },
          meanScore: { baseline: 1, candidate: 1, delta: 0 },
        },
        {
          name: 'follows-style-guide',
          passFraction: { baseline: 1, candidate: 1, delta: 0 },
          meanScore: { baseline: 1, candidate: 1, delta: 0 },
        },
      ],
      costUsd: { baseline: 1, candidate: 1.5, delta: 0.5 },
      latencyMilliseconds: { baseline: 1000, candidate: 1250, delta: 250 },
    });
  });

  test('reports a null delta wherever either run has no value', async () => {
    const baseline = baselineRecord();
    const candidate = candidateRecord();
    const [first, ...rest] = candidate.statistics.criteria;
    const unscored = {
      ...candidate,
      costUsd: null,
      statistics: {
        verdicts: { trials: 0, passes: 0, passFraction: null, wilsonInterval: null },
        criteria: [
          ...rest.slice(1),
          { ...first!, name: 'cites-a-source' },
          {
            ...rest[0]!,
            passFraction: null,
            wilsonInterval: null,
            meanScore: null,
            sampleVariance: null,
            standardDeviation: null,
          },
        ],
      },
    };

    const comparison = compareEvaluationRuns(await stored(baseline), await stored(unscored));

    expect(comparison.verdicts.passFraction).toEqual({ baseline: 1, candidate: null, delta: null });
    expect(comparison.costUsd).toEqual({ baseline: 1, candidate: null, delta: null });
    expect(comparison.criteria.map((criterion) => criterion.name)).toEqual([
      'names-the-capital',
      'concise',
      'no-web-search',
      'follows-style-guide',
      'cites-a-source',
    ]);
    expect(comparison.criteria[0]?.meanScore).toEqual({
      baseline: 1,
      candidate: null,
      delta: null,
    });
    expect(comparison.criteria[1]?.meanScore).toEqual({
      baseline: 1,
      candidate: null,
      delta: null,
    });
    expect(comparison.criteria[4]?.passFraction).toEqual({
      baseline: null,
      candidate: 0.75,
      delta: null,
    });
  });
});

/** A one-case run of the baseline evaluator whose two trials both resolve with `result`. */
async function recordOfOneTrial(result: RunResultBase): Promise<EvaluationRunRecord> {
  const evaluator = await fixtureEvaluatorFor('baseline');
  const aggregate = await runTrials({
    evaluator,
    caseId: PUBLIC_CASE_ID,
    subject: () => stubAgent(() => Promise.resolve(result)),
    runtime: createManualRuntimeServices({ randomSeed: 'one-trial' }),
    seeds: [7, 8],
  });
  return toEvaluationRunRecord({
    id: 'run-one-case',
    recordedAt: '2026-09-28T16:00:00.000Z',
    evaluator,
    aggregates: [aggregate],
    latencyMilliseconds: 5,
  });
}
