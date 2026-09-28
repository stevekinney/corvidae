import { describe, expect, spyOn, test } from 'bun:test';

import {
  createManualRuntimeServices,
  createScriptedGenerate,
  type RunResultBase,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';

import { EvaluatorConfigurationError } from './configuration';
import type { CriterionScorers } from './criteria';
import type { AggregateOutcome } from './disagreement';
import {
  datasetInput,
  deterministicConfigurationInput,
  EXPECTED_ANSWER,
  HELD_OUT_CASE_ID,
  judgeReply,
  modelConfigurationInput,
  runResult,
  STYLE_GUIDE_TEXT,
} from './evaluation.test-support';
import { createEvaluator, type Evaluator } from './evaluator';
import {
  createGoalEvaluatorAdapter,
  type GoalEvaluatorConfiguration,
  type GoalEvaluatorVerdict,
} from './goal-adapter';
import { createEvaluationHistory, type EvaluationHistory } from './history';
import { EvaluatorInfrastructureError } from './verdict';

/** Every fixture's evaluator runs this many trials per attempt. */
const REPETITIONS = 3;

type VerdictKind = GoalEvaluatorVerdict['kind'];

function memoryHistory(): EvaluationHistory {
  return createEvaluationHistory(textValueStore(new MemoryStorage()));
}

function manualRuntime() {
  return createManualRuntimeServices({
    identifierSeed: 'goal-adapter',
    randomSeed: 'goal-adapter',
  });
}

interface ScriptedScorers {
  /** The hard `names-the-capital` assertion's answer on its nth call; it holds past the end. */
  readonly holds?: readonly boolean[];
  /** The `concise` heuristic, called once per scored trial. Scores 1 by default. */
  readonly concise?: () => number;
}

function scorers(options: ScriptedScorers = {}): CriterionScorers {
  let assertionCalls = 0;
  return {
    assertions: { 'names-the-capital': () => options.holds?.[assertionCalls++] ?? true },
    heuristics: { concise: options.concise ?? (() => 1) },
    policies: { 'follows-style-guide': () => true },
  };
}

/** The capitals evaluator with a deterministic judge and no variance policy, run {@link REPETITIONS} times. */
function deterministicEvaluator(options: ScriptedScorers = {}): Promise<Evaluator> {
  return createEvaluator({
    configuration: { ...deterministicConfigurationInput(), repetitions: REPETITIONS },
    dataset: datasetInput(),
    scorers: scorers(options),
  });
}

type GoalOverrides = Partial<Omit<GoalEvaluatorConfiguration, 'loadEvaluator'>>;

interface FixtureOptions {
  readonly scorers?: ScriptedScorers;
  readonly goal?: GoalOverrides;
  readonly result?: RunResultBase;
  /** Replaces the loader that resolves the fixture's deterministic evaluator. */
  readonly loadEvaluator?: () => Promise<Evaluator>;
  readonly controller?: AbortController;
  readonly history?: EvaluationHistory;
}

interface FixtureRun {
  readonly verdict: GoalEvaluatorVerdict;
  readonly history: EvaluationHistory;
  readonly result: RunResultBase;
  /**
   * Every `evaluateCase` call the adapter's trials made. A trial calls its
   * subject's `run()` and then scores that run exactly once, so this is also
   * the count of subject `run()` calls that produced a result.
   */
  readonly evaluations: readonly (readonly [string, RunResultBase])[];
}

async function evaluateFixture(options: FixtureOptions = {}): Promise<FixtureRun> {
  const evaluator = await deterministicEvaluator(options.scorers);
  const evaluateCase = spyOn(evaluator, 'evaluateCase');
  const history = options.history ?? memoryHistory();
  const result = options.result ?? runResult();
  const evaluate = createGoalEvaluatorAdapter({
    configuration: {
      loadEvaluator: options.loadEvaluator ?? (() => Promise.resolve(evaluator)),
      caseId: HELD_OUT_CASE_ID,
      retryableOnFailure: true,
      nonRetryableCriteria: [],
      ...options.goal,
    },
    history,
    runtime: manualRuntime(),
  });
  const controller = options.controller ?? new AbortController();
  const verdict = await evaluate(result, { signal: controller.signal });
  return { verdict, history, result, evaluations: evaluateCase.mock.calls };
}

/**
 * One named fixture per verdict kind. Each one makes exactly one adapter
 * call, and the kind it must produce is its name.
 */
const FIXTURES: Record<VerdictKind, () => Promise<FixtureRun>> = {
  // Every criterion holds in every trial.
  pass: () => evaluateFixture(),
  // The hard `names-the-capital` assertion fails in every trial.
  fail: () => evaluateFixture({ scorers: { holds: [false, false, false] } }),
  // The `concise` scorer crashes in every trial: the evaluator failed, not the attempt.
  error: () =>
    evaluateFixture({
      scorers: {
        concise: () => {
          throw new Error('scorer crashed');
        },
      },
    }),
  // The evaluator's configuration is rejected, so the evaluator never loads.
  unavailable: () =>
    evaluateFixture({
      loadEvaluator: () =>
        createEvaluator({
          configuration: { ...deterministicConfigurationInput(), repetitions: 0 },
          dataset: datasetInput(),
          scorers: scorers(),
        }),
    }),
  // The goal controller aborts while the first trial is being scored.
  canceled: () => {
    const controller = new AbortController();
    return evaluateFixture({
      controller,
      scorers: {
        concise: () => {
          controller.abort();
          return 1;
        },
      },
    });
  },
  // One trial passes and two fail, and a deterministic judge has no rule to choose.
  indeterminate: () => evaluateFixture({ scorers: { holds: [true, false, false] } }),
};

const VERDICT_KINDS = Object.keys(FIXTURES) as VerdictKind[];

describe('createGoalEvaluatorAdapter', () => {
  test.each(VERDICT_KINDS)('the %s fixture produces exactly one verdict kind', async (kind) => {
    const { verdict } = await FIXTURES[kind]();
    expect(verdict.kind).toBe(kind);
  });

  test('maps each fixture to its full verdict', async () => {
    const runs = await Promise.all(VERDICT_KINDS.map((kind) => FIXTURES[kind]()));
    const verdicts = Object.fromEntries(
      runs.map(({ verdict }, index) => [VERDICT_KINDS[index], verdict] as const),
    );
    const evidenceReference = expect.any(String);
    expect(verdicts).toEqual({
      pass: { kind: 'pass', feedback: '3 of 3 trials passed.', evidenceReference },
      fail: {
        kind: 'fail',
        feedback: '0 of 3 trials passed.',
        failedHardCriteria: ['names-the-capital'],
        retryable: true,
        evidenceReference,
      },
      error: {
        kind: 'error',
        error: {
          kind: 'execute',
          code: 'scorer-error',
          message:
            'The evaluator could not score 3 of 3 trials (first: scorer-error on criterion "concise"). This is not a verdict on the attempt.',
          cause: expect.any(EvaluatorInfrastructureError),
        },
        evidenceReference,
      },
      unavailable: {
        kind: 'unavailable',
        error: {
          kind: 'load',
          code: 'evaluator-unloadable',
          message: 'The evaluator could not be loaded.',
          cause: expect.any(EvaluatorConfigurationError),
        },
        reason: 'The evaluator could not be loaded.',
      },
      canceled: { kind: 'canceled' },
      indeterminate: {
        kind: 'indeterminate',
        reason: 'The evaluator’s trials disagreed: split-without-variance-policy.',
        feedback:
          'The evaluator’s trials disagreed: 1 of 3 passed. This is neither a pass nor a fail.',
        evidenceReference,
      },
    });
  });

  test('an evaluator infrastructure failure is an error verdict after exactly repetitions trials, with no retry', async () => {
    const { verdict, history, result, evaluations } = await FIXTURES.error();

    expect(verdict.kind).toBe('error');
    expect(verdict.kind).not.toBe('pass');
    expect(verdict.kind).not.toBe('fail');
    expect(evaluations).toHaveLength(REPETITIONS);
    for (const [caseId, scored] of evaluations) {
      expect(caseId).toBe(HELD_OUT_CASE_ID);
      expect(scored).toBe(result);
    }
    const [stored] = await history.list();
    const [trials] = stored!.record.cases.map((entry) => entry.trials);
    expect(trials?.map((trial) => [trial.verdict, trial.error?.reason])).toEqual([
      ['infrastructure-failure', 'scorer-error'],
      ['infrastructure-failure', 'scorer-error'],
      ['infrastructure-failure', 'scorer-error'],
    ]);
  });

  test('maps a malformed score to an output error', async () => {
    const { verdict } = await evaluateFixture({ scorers: { concise: () => 7 } });
    expect(verdict).toMatchObject({
      kind: 'error',
      error: { kind: 'output', code: 'scorer-malformed-output' },
    });
  });

  /** The aggregate outcome each recorded verdict kind maps from. */
  const RECORDED_OUTCOMES = {
    pass: 'pass',
    fail: 'fail',
    indeterminate: 'disagreement',
    error: 'indeterminate',
  } as const satisfies Partial<Record<VerdictKind, AggregateOutcome>>;

  test.each(Object.keys(RECORDED_OUTCOMES) as (keyof typeof RECORDED_OUTCOMES)[])(
    'a %s verdict references the evaluation-run record it appended',
    async (kind) => {
      const { verdict, history } = await FIXTURES[kind]();
      if (!('evidenceReference' in verdict) || verdict.evidenceReference === undefined) {
        throw new Error(`The ${kind} verdict carries no evidence reference`);
      }

      const stored = await history.read(verdict.evidenceReference);

      expect(stored?.record.kind).toBe('evaluation-run');
      expect(stored?.record.id).toBe(verdict.evidenceReference);
      expect(stored?.record.repetitions).toBe(REPETITIONS);
      expect(stored?.record.cases.map((entry) => entry.outcome)).toEqual([RECORDED_OUTCOMES[kind]]);
      expect(await history.list()).toEqual([stored!]);
    },
  );

  test('records the run with the runtime’s identifier and clock', async () => {
    const { verdict, history } = await FIXTURES.pass();
    const runtime = manualRuntime();
    const expectedId = runtime.identifiers.next('goal-evaluation');

    expect(verdict).toMatchObject({ kind: 'pass', evidenceReference: expectedId });
    const stored = await history.read(expectedId);
    expect(stored?.record.recordedAt).toBe(runtime.clock.nowISO());
    expect(stored?.record.latencyMilliseconds).toBe(0);
  });

  test('uses the real runtime services when none are injected', async () => {
    const evaluator = await deterministicEvaluator();
    const history = memoryHistory();
    const evaluate = createGoalEvaluatorAdapter({
      configuration: {
        loadEvaluator: () => Promise.resolve(evaluator),
        caseId: HELD_OUT_CASE_ID,
        retryableOnFailure: false,
        nonRetryableCriteria: [],
      },
      history,
    });

    const verdict = await evaluate(runResult(), { signal: new AbortController().signal });

    expect(verdict.kind).toBe('pass');
    expect(await history.list()).toHaveLength(1);
  });

  test('aborting the signal mid-trial returns canceled, stops the remaining trials, and appends nothing', async () => {
    const { verdict, history, evaluations } = await FIXTURES.canceled();

    expect(verdict).toEqual({ kind: 'canceled' });
    // The in-flight trial finished scoring; the two after it never scored the attempt.
    expect(evaluations).toHaveLength(1);
    expect(await history.list()).toEqual([]);
  });

  test('an already-aborted signal returns canceled without loading the evaluator', async () => {
    const controller = new AbortController();
    controller.abort();
    let loads = 0;
    const { verdict, history, evaluations } = await evaluateFixture({
      controller,
      loadEvaluator: () => {
        loads += 1;
        return deterministicEvaluator();
      },
    });

    expect(verdict).toEqual({ kind: 'canceled' });
    expect(loads).toBe(0);
    expect(evaluations).toHaveLength(0);
    expect(await history.list()).toEqual([]);
  });

  test('an attempt that did not finish on its stop condition is a fail with no criterion scored', async () => {
    const { verdict } = await evaluateFixture({
      result: runResult({ finishReason: 'maximum-steps' }),
    });
    expect(verdict).toMatchObject({
      kind: 'fail',
      feedback: '0 of 3 trials passed.',
      failedHardCriteria: [],
    });
  });

  test('an evaluation whose evidence cannot be recorded is an error, never a pass', async () => {
    const storeFailure = new Error('disk full');
    const history: EvaluationHistory = {
      append: () => Promise.reject(storeFailure),
      read: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
    };

    const { verdict } = await evaluateFixture({ history });

    expect(verdict).toEqual({
      kind: 'error',
      error: {
        kind: 'execute',
        code: 'history-unwritable',
        message:
          'The evaluation finished but its evidence could not be recorded, so it is not a verdict on the attempt.',
        cause: storeFailure,
      },
    });
  });

  describe('contract with the loaded evaluator', () => {
    test('a case outside the evaluator’s dataset makes the evaluator unavailable', async () => {
      const { verdict, history, evaluations } = await evaluateFixture({
        goal: { caseId: 'case-atlantis' },
      });

      expect(verdict).toEqual({
        kind: 'unavailable',
        error: {
          kind: 'contract',
          code: 'unknown-case',
          message:
            'The goal names a case that is not in dataset "capitals" version "capitals-2026-09".',
        },
        reason:
          'The goal names a case that is not in dataset "capitals" version "capitals-2026-09".',
      });
      expect(evaluations).toHaveLength(0);
      expect(await history.list()).toEqual([]);
    });

    test.each(['concise', 'no-such-criterion'])(
      'a non-retryable mark on %s, which is not a hard criterion, makes the evaluator unavailable',
      async (criterion) => {
        const { verdict, evaluations } = await evaluateFixture({
          goal: { nonRetryableCriteria: ['names-the-capital', criterion] },
        });

        const message = `Criterion "${criterion}" is marked non-retryable but is not a hard criterion of evaluator "capital-cities".`;
        expect(verdict).toEqual({
          kind: 'unavailable',
          error: { kind: 'contract', code: 'not-a-hard-criterion', message },
          reason: message,
        });
        expect(evaluations).toHaveLength(0);
      },
    );
  });

  describe('retryable', () => {
    test('comes from the configuration’s explicit retryableOnFailure', async () => {
      const retried = await evaluateFixture({
        scorers: { holds: [false, false, false] },
        goal: { retryableOnFailure: true },
      });
      const notRetried = await evaluateFixture({
        scorers: { holds: [false, false, false] },
        goal: { retryableOnFailure: false },
      });

      expect(retried.verdict).toMatchObject({ kind: 'fail', retryable: true });
      expect(notRetried.verdict).toMatchObject({ kind: 'fail', retryable: false });
    });

    test('is forced to false when a hard criterion marked non-retryable failed', async () => {
      // The attempt searched the web, failing the hard `no-web-search` trajectory criterion.
      const { verdict } = await evaluateFixture({
        result: runResult({ toolCalls: [{ name: 'web_search' }] }),
        goal: { retryableOnFailure: true, nonRetryableCriteria: ['no-web-search'] },
      });

      expect(verdict).toEqual({
        kind: 'fail',
        feedback: '0 of 3 trials passed.',
        failedHardCriteria: ['no-web-search'],
        retryable: false,
        evidenceReference: expect.any(String),
      });
    });

    test('stays retryable when only hard criteria not marked non-retryable failed', async () => {
      const { verdict } = await evaluateFixture({
        scorers: { holds: [false, false, false] },
        goal: { retryableOnFailure: true, nonRetryableCriteria: ['no-web-search'] },
      });

      expect(verdict).toMatchObject({
        kind: 'fail',
        failedHardCriteria: ['names-the-capital'],
        retryable: true,
      });
    });
  });

  describe('feedback', () => {
    /** Weights no trial count can spell, so a leaked weight is always detectable. */
    const WEIGHTS = [0.37, 0.59, 0.71, 0.83, 1.29] as const;
    const JUDGE_MODEL = 'claude-sonnet-4-5';
    const LEAKY_FEEDBACK = `Say "${EXPECTED_ANSWER}" for ${HELD_OUT_CASE_ID}, per "${STYLE_GUIDE_TEXT}", weighing ${WEIGHTS.join(' and ')}, as ${JUDGE_MODEL} sees it.`;
    const FORBIDDEN = [
      EXPECTED_ANSWER,
      STYLE_GUIDE_TEXT,
      HELD_OUT_CASE_ID,
      ...WEIGHTS.map(String),
      JUDGE_MODEL,
    ];

    function leakyModelEvaluator(holds: readonly boolean[]): Promise<Evaluator> {
      const configuration = modelConfigurationInput();
      const criteria = configuration['criteria'] as { weight: number }[];
      for (const [index, criterion] of criteria.entries()) criterion.weight = WEIGHTS[index]!;
      expect((configuration['judge'] as { model: string }).model).toBe(JUDGE_MODEL);
      return createEvaluator({
        configuration,
        dataset: datasetInput(),
        scorers: scorers({ holds }),
        generate: createScriptedGenerate(
          holds.map(() => ({
            kind: 'respond' as const,
            response: { content: judgeReply({ feedback: LEAKY_FEEDBACK }), toolCalls: [] },
          })),
        ),
      });
    }

    test.each([
      ['pass', [true, true, true]],
      ['fail', [false, false, false]],
      ['indeterminate', [true, false, false]],
    ] as const)(
      'a %s verdict never carries the expected answer, reference material, a held-out case id, a weight, or the judge model',
      async (kind, holds) => {
        const { verdict } = await evaluateFixture({
          loadEvaluator: () => leakyModelEvaluator(holds),
        });

        expect(verdict.kind).toBe(kind);
        if (!('feedback' in verdict)) throw new Error(`The ${kind} verdict carries no feedback`);
        for (const secret of FORBIDDEN) {
          expect(verdict.feedback).not.toContain(secret);
          expect(JSON.stringify(verdict)).not.toContain(secret);
        }
      },
    );
  });
});
