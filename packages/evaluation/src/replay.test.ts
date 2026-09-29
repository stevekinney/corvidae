import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GenerateFunction } from '@lostgradient/operative';

import {
  fixtureConfiguration,
  fixtureDataset,
  fixtureRegressionEvaluator,
  type FixtureScript,
} from './fixtures/release-gate/fixture-regression';
import type { GateDecisionRecord } from './gate';
import type { EvaluationHistory, HistoricalRecord } from './history';
import {
  type GateEvaluatorDefinition,
  type GateEvaluatorLoader,
  loadGateEvaluator,
  runReleaseGate,
  type RunReleaseGateOptions,
} from './release-gate';
import {
  FIXTURE_GATE_ID,
  fixtureBaselineRun,
  fixtureGateFile,
  GATE_ACTOR,
  memoryHistory,
  writeGates,
} from './release-gate.test-support';
import { differencesBetween, replayGateDecision } from './replay';

let scratch: string;
let directories = 0;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'replay-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function decide(
  history: EvaluationHistory,
  script: FixtureScript,
  options: Partial<RunReleaseGateOptions> = {},
): Promise<HistoricalRecord<GateDecisionRecord>> {
  directories += 1;
  const gatesDirectory = await writeGates(join(scratch, `gates-${directories}`), {
    [FIXTURE_GATE_ID]: fixtureGateFile(script),
  });
  const result = await runReleaseGate({
    gatesDirectory,
    gateId: FIXTURE_GATE_ID,
    history,
    actor: GATE_ACTOR,
    ...options,
  });
  if (result.decision === 'configuration-error') throw new Error(result.issues.join('; '));
  return result.historical;
}

/** Loads evaluator modules as replay would, counting every judge and agent call. */
function spyingLoader(): { load: GateEvaluatorLoader; calls: () => number } {
  let calls = 0;
  const load: GateEvaluatorLoader = async (modulePath) => {
    const definition = await loadGateEvaluator(modulePath);
    const judge = definition.judge!;
    const spy: GenerateFunction = (context) => {
      calls += 1;
      return judge(context);
    };
    return {
      ...definition,
      judge: spy,
      subject: (context) => {
        calls += 1;
        return definition.subject(context);
      },
    };
  };
  return { load, calls: () => calls };
}

describe('replayGateDecision', () => {
  test.each<[FixtureScript, GateDecisionRecord['decision']]>([
    ['passing', 'pass'],
    ['regressing', 'regression'],
    ['judge-throws', 'infrastructure-failure'],
    ['uncalibrated', 'insufficient-evidence'],
  ])(
    'recomputes a %s decision and its digest without calling the judge or the agent',
    async (script, decision) => {
      const { history } = memoryHistory();
      const stored = await decide(history, script);
      const { load, calls } = spyingLoader();

      const outcome = await replayGateDecision(
        { recordId: stored.record.id },
        { history, loadEvaluator: load },
      );

      expect(outcome).toEqual({
        result: 'match',
        recordId: stored.record.id,
        gateId: FIXTURE_GATE_ID,
        decision,
        digest: stored.digest,
      });
      expect(calls()).toBe(0);
    },
  );

  test('keeps the source revision a decision records', async () => {
    const { history } = memoryHistory();
    const stored = await decide(history, 'passing', {
      sourceRevision: '857d7dbf10e51718e77bc484145cd4a95f244afc',
    });

    const outcome = await replayGateDecision({ recordId: stored.record.id }, { history });

    expect(outcome).toMatchObject({ result: 'match', digest: stored.digest });
  });

  test('replays the newest decision of a gate, and appends nothing', async () => {
    const { history } = memoryHistory();
    await decide(history, 'passing', { now: () => Date.parse('2026-09-28T12:00:00.000Z') });
    const newest = await decide(history, 'regressing', {
      now: () => Date.parse('2026-09-28T13:00:00.000Z'),
    });
    const before = await history.list();

    const outcome = await replayGateDecision({ gateId: FIXTURE_GATE_ID }, { history });

    expect(outcome).toMatchObject({
      result: 'match',
      recordId: newest.record.id,
      decision: 'regression',
    });
    expect(await history.list()).toEqual(before);
  });

  test('replays trials that timed out, never produced a run, or whose scorer threw', async () => {
    const { history } = memoryHistory();
    const passing = await fixtureRegressionEvaluator('passing');
    let trial = 0;
    const definition = (): GateEvaluatorDefinition => ({
      ...passing,
      configuration: {
        ...fixtureConfiguration(),
        budgets: {
          perEvaluation: { costUsd: 1, latencyMilliseconds: 5 },
          perGateRun: { costUsd: 1, latencyMilliseconds: 60_000 },
        },
      },
      scorers: {
        assertions: {
          'names-the-capital': ({ evaluationCase }) => {
            if (evaluationCase.visibility === 'public') throw new Error('scorer defect');
            return true;
          },
        },
      },
      // The judge never answers the first trial, so its latency budget expires.
      judge: (context) => (trial === 1 ? new Promise(() => undefined) : passing.judge!(context)),
      subject: (context) => {
        trial = context.trial;
        if (context.trial === 2) throw new Error('the harness failed to start');
        return passing.subject(context);
      },
    });
    const stored = await decide(history, 'passing', {
      loadEvaluator: () => Promise.resolve(definition()),
    });
    const [france] = stored.record.evidence;
    expect(
      france!.trials.map((entry) => [entry.latencyBudgetExceeded, entry.run === null]),
    ).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
    expect(stored.record.candidate.cases[1]!.trials[0]!.error?.reason).toBe('scorer-error');

    const outcome = await replayGateDecision(
      { recordId: stored.record.id },
      { history, loadEvaluator: () => Promise.resolve(definition()) },
    );
    expect(outcome).toMatchObject({ result: 'match', decision: 'infrastructure-failure' });
  });

  test('records and replays a judge reply that asked for tools as malformed judge output', async () => {
    const { history } = memoryHistory();
    const passing = await fixtureRegressionEvaluator('passing');
    const judge: GenerateFunction = () =>
      Promise.resolve({
        content: '{}',
        toolCalls: [{ id: 'call-1', name: 'web_search', arguments: { query: 'capital' } }],
      });
    const definition = { ...passing, judge };
    const stored = await decide(history, 'passing', {
      loadEvaluator: () => Promise.resolve(definition),
    });
    expect(stored.record.decision).toBe('infrastructure-failure');
    expect(stored.record.evidence[0]!.trials[0]!.judge).toEqual({
      kind: 'reply',
      content: '{}',
      requestedTools: ['web_search'],
    });
    expect(stored.record.candidate.cases[0]!.trials[0]!.error?.reason).toBe(
      'judge-malformed-output',
    );

    const outcome = await replayGateDecision(
      { recordId: stored.record.id },
      { history, loadEvaluator: () => Promise.resolve(definition) },
    );
    expect(outcome).toMatchObject({ result: 'match', decision: 'infrastructure-failure' });
  });

  test('reports a stored decision its own evidence contradicts, naming the field', async () => {
    const { history } = memoryHistory();
    const { record } = await decide(history, 'regressing');
    const tampered = await history.append({
      ...record,
      id: `${record.id}-tampered`,
      decision: 'pass',
    });

    const outcome = await replayGateDecision({ recordId: tampered.record.id }, { history });

    expect(outcome).toMatchObject({
      result: 'mismatch',
      recordId: tampered.record.id,
      storedDigest: tampered.digest,
      differences: [{ path: 'decision', stored: 'pass', recomputed: 'regression' }],
    });
  });

  test('is unresolvable when the evaluator module no longer builds the recorded configuration or dataset', async () => {
    const { history } = memoryHistory();
    const { record } = await decide(history, 'passing');
    const replay = (loadEvaluator: GateEvaluatorLoader) =>
      replayGateDecision({ recordId: record.id }, { history, loadEvaluator });
    const passing = () => fixtureRegressionEvaluator('passing');

    const revised = await replay(async () => ({
      ...(await passing()),
      configuration: { ...fixtureConfiguration(), revision: 2 },
    }));
    expect(revised).toMatchObject({
      result: 'unresolvable',
      problem: expect.stringContaining(
        `The recorded evaluator configuration digest ${record.evaluator.digest} cannot be resolved`,
      ),
    });

    const dataset = fixtureDataset() as { cases: { expected: string }[] };
    dataset.cases[0]!.expected = 'Paris, France';
    const edited = await replay(async () => ({ ...(await passing()), dataset }));
    expect(edited).toMatchObject({
      result: 'unresolvable',
      problem: expect.stringContaining(
        'The recorded dataset "capitals" version "capitals-2026-09" cannot be resolved',
      ),
    });

    const missing = await replay(() => Promise.reject(new Error('Cannot find module')));
    expect(missing).toMatchObject({
      result: 'unresolvable',
      problem:
        'The evaluator module src/fixtures/release-gate/passing.ts cannot be resolved: Cannot find module',
    });
    const thrown = await replay(() => Promise.reject('gone'));
    expect(thrown).toMatchObject({
      result: 'unresolvable',
      problem: expect.stringMatching(/: gone$/),
    });
  });

  test('reports an unknown record, a record that is not a gate decision, and a gate without decisions', async () => {
    const { history } = memoryHistory();
    const run = await history.append(await fixtureBaselineRun());

    expect(await replayGateDecision({ recordId: 'never-recorded' }, { history })).toEqual({
      result: 'unknown-record',
      problem: 'No historical record "never-recorded"',
    });
    expect(await replayGateDecision({ recordId: run.record.id }, { history })).toEqual({
      result: 'unknown-record',
      problem: `Historical record "${run.record.id}" is a evaluation-run record, not a gate decision`,
    });
    expect(await replayGateDecision({ gateId: FIXTURE_GATE_ID }, { history })).toEqual({
      result: 'unknown-record',
      problem: 'No gate decision for gate "fixture-regression"',
    });
  });

  test('reports a corrupt stored record, and evidence that cannot fit its own evaluator', async () => {
    const { store, history } = memoryHistory();
    const { record } = await decide(history, 'passing');
    const key = `evaluation-history/records/${record.id}`;
    const text = (await store.get(key))!;

    const beyond = structuredClone(record);
    beyond.id = `${record.id}-beyond`;
    beyond.evidence[1]!.ordinal = 3;
    beyond.evidence[1]!.visibility = 'held-out';
    delete beyond.evidence[1]!.caseId;
    await history.append(beyond);
    expect(await replayGateDecision({ recordId: beyond.id }, { history })).toEqual({
      result: 'corrupt-record',
      recordId: beyond.id,
      problem: `Gate decision "${beyond.id}" cannot be replayed: Its evidence names case 3, which the dataset lacks`,
    });

    const short = structuredClone(record);
    short.id = `${record.id}-short`;
    short.evidence[0]!.trials.pop();
    await history.append(short);
    expect(await replayGateDecision({ recordId: short.id }, { history })).toMatchObject({
      result: 'corrupt-record',
      problem: expect.stringContaining('Expected 3 recorded seeds'),
    });

    await store.set(key, text.replace('"decision":"pass"', '"decision":"regression"'));
    for (const selector of [{ recordId: record.id }, { gateId: FIXTURE_GATE_ID }]) {
      expect(await replayGateDecision(selector, { history })).toMatchObject({
        result: 'corrupt-record',
        recordId: record.id,
        problem: `Historical record "${record.id}" does not match its digest`,
      });
    }
  });

  test('propagates a failure that is neither a missing, corrupt, nor unresolvable record', async () => {
    const failure = new Error('disk unreadable');
    const { history } = memoryHistory();
    await expect(
      replayGateDecision(
        { recordId: 'any' },
        { history: { ...history, read: () => Promise.reject(failure) } },
      ),
    ).rejects.toBe(failure);

    const { record, digest } = await decide(history, 'passing');
    const broken = { ...record, evidence: null } as unknown as GateDecisionRecord;
    await expect(
      replayGateDecision(
        { recordId: record.id },
        { history: { ...history, read: () => Promise.resolve({ digest, record: broken }) } },
      ),
    ).rejects.toThrow(TypeError);
  });
});

describe('differencesBetween', () => {
  test('lists each differing leaf in canonical order, including missing entries', () => {
    expect(
      differencesBetween(
        { b: [1, 2], a: { same: true, changed: 'x' }, gone: 1 },
        { a: { changed: 'y', same: true }, b: [1], added: null },
      ),
    ).toEqual([
      { path: 'a.changed', stored: 'x', recomputed: 'y' },
      { path: 'added', stored: undefined, recomputed: null },
      { path: 'b.1', stored: 2, recomputed: undefined },
      { path: 'gone', stored: 1, recomputed: undefined },
    ]);
    expect(differencesBetween('stored', 'recomputed')).toEqual([
      { path: '(record)', stored: 'stored', recomputed: 'recomputed' },
    ]);
    expect(differencesBetween({ same: [1, { a: 2 }] }, { same: [1, { a: 2 }] })).toEqual([]);
  });
});
