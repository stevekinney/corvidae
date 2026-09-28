import { describe, expect, mock, test } from 'bun:test';

import type { RunResultBase } from '@lostgradient/operative';

import { type EvaluatorConfiguration, parseEvaluatorConfiguration } from './configuration';
import {
  bindCriteria,
  type CriterionEvidence,
  type CriterionScorers,
  type ScoringContext,
  toolCallNames,
} from './criteria';
import { parseEvaluationDataset } from './dataset';
import {
  datasetInput,
  deterministicConfigurationInput,
  modelConfigurationInput,
  runResult,
  STYLE_GUIDE_TEXT,
} from './evaluation.test-support';
import type { JudgeVerdict } from './judge';
import { EvaluatorInfrastructureError } from './verdict';

const evaluationCase = parseEvaluationDataset(datasetInput()).cases[0]!;

function passingScorers(): CriterionScorers {
  return {
    assertions: { 'names-the-capital': () => true },
    heuristics: { concise: () => 0.5 },
    policies: { 'follows-style-guide': () => true },
  };
}

function context(result: RunResultBase = runResult(), verdict?: JudgeVerdict): ScoringContext {
  const evidence: CriterionEvidence = {
    evaluationCase,
    result,
    signal: new AbortController().signal,
  };
  return {
    evidence,
    judge: async () => {
      if (!verdict) throw new Error('This test does not expect a judge call');
      return verdict;
    },
  };
}

function bindDeterministic(scorers: CriterionScorers) {
  return bindCriteria(parseEvaluatorConfiguration(deterministicConfigurationInput()), scorers);
}

async function captureError(work: () => Promise<unknown>): Promise<EvaluatorInfrastructureError> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(EvaluatorInfrastructureError);
    return error as EvaluatorInfrastructureError;
  }
  throw new Error('Expected an evaluator infrastructure error');
}

describe('toolCallNames', () => {
  test('lists every tool call across the run steps in order', () => {
    const result = runResult({ toolCalls: [{ name: 'lookup' }, { name: 'web_search' }] });
    expect(toolCallNames(result)).toEqual(['lookup', 'web_search']);
  });
});

describe('bindCriteria', () => {
  test('binds one scorer per criterion, in configuration order', async () => {
    const { bindings, issues } = bindDeterministic(passingScorers());
    expect(issues).toEqual([]);
    const scores = await Promise.all(bindings.map((binding) => binding(context())));
    expect(scores.map((score) => [score.name, score.kind, score.score])).toEqual([
      ['names-the-capital', 'deterministic-assertion', 1],
      ['concise', 'heuristic', 0.5],
      ['no-web-search', 'trajectory', 1],
      ['follows-style-guide', 'policy', 1],
    ]);
    expect(scores[0]?.hardThreshold).toBe(1);
    expect(scores[0]?.weight).toBe(3);
  });

  test('reports a missing scorer for every criterion kind that needs one', () => {
    const { issues } = bindDeterministic({});
    expect(issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['criteria.0', 'No assertions scorer is bound to criterion "names-the-capital"'],
      ['criteria.1', 'No heuristics scorer is bound to criterion "concise"'],
      ['criteria.3', 'No policies scorer is bound to criterion "follows-style-guide"'],
    ]);
  });

  test('reports scorers bound to criteria that do not exist or have another kind', () => {
    const { issues } = bindDeterministic({
      ...passingScorers(),
      assertions: { 'names-the-capital': () => true, concise: () => true },
      heuristics: { concise: () => 1, 'no-web-search': () => 1 },
      policies: { 'follows-style-guide': () => true, unknown: () => true },
    });
    expect(issues.map((issue) => issue.path.join('.'))).toEqual([
      'scorers.assertions.concise',
      'scorers.heuristics.no-web-search',
      'scorers.policies.unknown',
    ]);
  });

  test('reports a policy criterion whose reference material is missing', () => {
    const configuration = parseEvaluatorConfiguration(deterministicConfigurationInput());
    const unchecked: EvaluatorConfiguration = {
      ...configuration,
      referenceMaterial: { ...configuration.referenceMaterial, entries: [] },
    };
    const { issues } = bindCriteria(unchecked, passingScorers());
    expect(issues.map((issue) => issue.path.join('.'))).toEqual(['criteria.3.referenceMaterialId']);
  });

  test('scores an assertion 1 when it holds and 0 when it does not', async () => {
    const { bindings } = bindDeterministic({
      ...passingScorers(),
      assertions: { 'names-the-capital': async ({ result }) => result.content === 'nope' },
    });
    const score = await bindings[0]!(context());
    expect(score.score).toBe(0);
    expect(score.rationale).toBe('Assertion did not hold.');
    const held = await bindDeterministic(passingScorers()).bindings[0]!(context());
    expect(held.rationale).toBe('Assertion held.');
  });

  test('hands policy scorers the reference material entry their criterion cites', async () => {
    const policy = mock((_evidence: { reference: { text: string } }) => 0.25);
    const { bindings } = bindDeterministic({
      ...passingScorers(),
      policies: { 'follows-style-guide': policy },
    });
    const score = await bindings[3]!(context());
    expect(score.score).toBe(0.25);
    expect(score.rationale).toBe('Policy "style-guide" scored 0.25.');
    expect(policy.mock.calls[0]?.[0].reference.text).toBe(STYLE_GUIDE_TEXT);
  });

  test('scores a heuristic with the value it returns', async () => {
    const score = await bindDeterministic(passingScorers()).bindings[1]!(context());
    expect(score.rationale).toBe('Heuristic scored 0.5.');
  });

  test('fails a trajectory criterion when a forbidden tool call appears, even with a correct answer', async () => {
    const { bindings } = bindDeterministic(passingScorers());
    const result = runResult({ toolCalls: [{ name: 'web_search', arguments: { q: 'France' } }] });
    const score = await bindings[2]!(context(result));
    expect(score.score).toBe(0);
    expect(score.rationale).toBe('Called forbidden tools: web_search.');
  });

  test('fails a trajectory criterion when a required tool is never called', async () => {
    const input = deterministicConfigurationInput();
    const criteria = input['criteria'] as Record<string, unknown>[];
    criteria[2] = { ...criteria[2], forbiddenTools: [], requiredTools: ['atlas', 'lookup'] };
    const { bindings } = bindCriteria(parseEvaluatorConfiguration(input), passingScorers());
    const score = await bindings[2]!(context(runResult({ toolCalls: [{ name: 'lookup' }] })));
    expect(score.score).toBe(0);
    expect(score.rationale).toBe('Never called required tools: atlas.');
  });

  test('reports both trajectory violations together', async () => {
    const input = deterministicConfigurationInput();
    const criteria = input['criteria'] as Record<string, unknown>[];
    criteria[2] = { ...criteria[2], requiredTools: ['atlas'] };
    const { bindings } = bindCriteria(parseEvaluatorConfiguration(input), passingScorers());
    const score = await bindings[2]!(context(runResult({ toolCalls: [{ name: 'web_search' }] })));
    expect(score.rationale).toBe(
      'Called forbidden tools: web_search. Never called required tools: atlas.',
    );
  });

  test('passes a trajectory criterion whose constraints hold', async () => {
    const score = await bindDeterministic(passingScorers()).bindings[2]!(context());
    expect(score.score).toBe(1);
    expect(score.rationale).toBe('Tool trajectory satisfied its constraints.');
  });

  test('turns a scorer that throws into a typed infrastructure error', async () => {
    const cause = new Error('fixture harness offline');
    const { bindings } = bindDeterministic({
      ...passingScorers(),
      heuristics: {
        concise: () => {
          throw cause;
        },
      },
    });
    const error = await captureError(() => bindings[1]!(context()));
    expect(error.reason).toBe('scorer-error');
    expect(error.criterion).toBe('concise');
    expect(error.cause).toBe(cause);
  });

  test.each<[string, CriterionScorers]>([
    [
      'an assertion returning a non-boolean',
      { assertions: { 'names-the-capital': () => 1 as never } },
    ],
    ['a heuristic above 1', { heuristics: { concise: () => 1.5 } }],
    ['a heuristic returning NaN', { heuristics: { concise: () => Number.NaN } }],
    ['a policy returning text', { policies: { 'follows-style-guide': () => 'yes' as never } }],
  ])('turns %s into a malformed-output infrastructure error', async (_label, override) => {
    const { bindings } = bindDeterministic({ ...passingScorers(), ...override });
    const errors = await Promise.all(
      bindings.map((binding) =>
        binding(context()).then(
          () => undefined,
          (error: unknown) => error,
        ),
      ),
    );
    const malformed = errors.filter((error) => error !== undefined);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toBeInstanceOf(EvaluatorInfrastructureError);
    expect((malformed[0] as EvaluatorInfrastructureError).reason).toBe('scorer-malformed-output');
  });

  test('reads model-judge scores from the judge verdict', async () => {
    const configuration = parseEvaluatorConfiguration(modelConfigurationInput());
    const { bindings, issues } = bindCriteria(configuration, passingScorers());
    expect(issues).toEqual([]);
    const verdict: JudgeVerdict = {
      scores: new Map([['helpful-tone', { score: 0.8, rationale: 'Polite.' }]]),
      feedback: 'Good.',
    };
    const score = await bindings[4]!(context(runResult(), verdict));
    expect(score).toEqual({
      name: 'helpful-tone',
      kind: 'model-judge',
      weight: 2,
      hardThreshold: undefined,
      score: 0.8,
      rationale: 'Polite.',
    });
  });

  test('reports a model-judge criterion scored without a judge as a judge infrastructure failure', async () => {
    const configuration = parseEvaluatorConfiguration(modelConfigurationInput());
    const { bindings } = bindCriteria(configuration, passingScorers());
    const { evidence } = context();
    const error = await captureError(() => bindings[4]!({ evidence }));
    expect(error.reason).toBe('judge-error');
    expect(error.criterion).toBe('helpful-tone');
  });

  test('treats a judge verdict that omits a model-judge criterion as malformed output', async () => {
    const configuration = parseEvaluatorConfiguration(modelConfigurationInput());
    const { bindings } = bindCriteria(configuration, passingScorers());
    const verdict: JudgeVerdict = { scores: new Map(), feedback: 'Good.' };
    const error = await captureError(() => bindings[4]!(context(runResult(), verdict)));
    expect(error.reason).toBe('judge-malformed-output');
    expect(error.criterion).toBe('helpful-tone');
  });
});
