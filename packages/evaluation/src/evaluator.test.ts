import { describe, expect, mock, test } from 'bun:test';

import {
  createManualRuntimeServices,
  createScriptedGenerate,
  type RunResultBase,
} from '@lostgradient/operative';

import { EvaluatorConfigurationError, parseEvaluatorConfiguration } from './configuration';
import type { CriterionScorers } from './criteria';
import {
  datasetInput,
  deterministicConfigurationInput,
  judgeReply,
  modelConfigurationInput,
  runResult,
} from './evaluation.test-support';
import { createEvaluator, type CreateEvaluatorOptions } from './evaluator';
import { evaluatorIdentity } from './identity';
import {
  AGENT_FAILURE_REASONS,
  type CaseEvaluation,
  EvaluatorInfrastructureError,
} from './verdict';

function scorers(overrides: { assertion?: boolean; heuristic?: number; policy?: number } = {}) {
  const assertion = mock((): boolean => overrides.assertion ?? true);
  const heuristic = mock((): number => overrides.heuristic ?? 1);
  const policy = mock((): number => overrides.policy ?? 1);
  const bound: CriterionScorers = {
    assertions: { 'names-the-capital': assertion },
    heuristics: { concise: heuristic },
    policies: { 'follows-style-guide': policy },
  };
  return { bound, spies: [assertion, heuristic, policy] };
}

function reply(content: string) {
  return { kind: 'respond' as const, response: { content, toolCalls: [] } };
}

async function rejection(options: CreateEvaluatorOptions): Promise<string[]> {
  try {
    await createEvaluator(options);
  } catch (error) {
    expect(error).toBeInstanceOf(EvaluatorConfigurationError);
    return (error as EvaluatorConfigurationError).issues.map((issue) => issue.path.join('.'));
  }
  throw new Error('Expected the evaluator to be rejected');
}

function infrastructureError(evaluation: CaseEvaluation): EvaluatorInfrastructureError {
  if (evaluation.verdict !== 'infrastructure-failure') {
    throw new Error(`Expected an infrastructure failure, got ${evaluation.verdict}`);
  }
  expect(evaluation.error).toBeInstanceOf(EvaluatorInfrastructureError);
  return evaluation.error;
}

async function evaluate(
  options: Partial<CreateEvaluatorOptions> & { readonly result?: RunResultBase } = {},
): Promise<CaseEvaluation> {
  const evaluator = await createEvaluator({
    configuration: deterministicConfigurationInput(),
    dataset: datasetInput(),
    scorers: scorers().bound,
    ...options,
  });
  return evaluator.evaluateCase('case-france', options.result ?? runResult());
}

describe('createEvaluator', () => {
  test('parses the configuration and dataset and exposes the evaluator identity', async () => {
    const evaluator = await createEvaluator({
      configuration: modelConfigurationInput(),
      dataset: datasetInput(),
      scorers: scorers().bound,
      generate: createScriptedGenerate([]),
    });
    expect(evaluator.identity).toEqual(
      await evaluatorIdentity(parseEvaluatorConfiguration(modelConfigurationInput())),
    );
    expect(evaluator.configuration.name).toBe('capital-cities');
    expect(evaluator.dataset.cases).toHaveLength(2);
  });

  test('rejects an invalid configuration or dataset', async () => {
    const configuration = deterministicConfigurationInput();
    delete configuration['judge'];
    expect(
      await rejection({ configuration, dataset: datasetInput(), scorers: scorers().bound }),
    ).toEqual(['judge']);
    expect(
      await rejection({
        configuration: deterministicConfigurationInput(),
        dataset: { version: 'capitals-2026-09', cases: [] },
        scorers: scorers().bound,
      }),
    ).toEqual(['cases']);
  });

  test('rejects a configuration whose calibration example id equals a dataset case id', async () => {
    const configuration = deterministicConfigurationInput();
    const examples = configuration['examples'] as Record<string, unknown>[];
    examples[0] = { ...examples[0], id: 'case-france' };
    expect(
      await rejection({ configuration, dataset: datasetInput(), scorers: scorers().bound }),
    ).toEqual(['examples.0.id']);
  });

  test('rejects a result schema version this package does not emit', async () => {
    const configuration = deterministicConfigurationInput();
    configuration['resultSchemaVersion'] = 2;
    expect(
      await rejection({ configuration, dataset: datasetInput(), scorers: scorers().bound }),
    ).toEqual(['resultSchemaVersion']);
  });

  test('rejects criteria without scorers and model-judge criteria without a generate function', async () => {
    expect(
      await rejection({ configuration: modelConfigurationInput(), dataset: datasetInput() }),
    ).toEqual(['criteria.0', 'criteria.1', 'criteria.3', 'judge']);
  });

  test('refuses to evaluate a case the dataset does not contain', async () => {
    const evaluator = await createEvaluator({
      configuration: deterministicConfigurationInput(),
      dataset: datasetInput(),
      scorers: scorers().bound,
    });
    await expect(evaluator.evaluateCase('case-peru', runResult())).rejects.toThrow(
      'Unknown evaluation case "case-peru"',
    );
  });
});

describe('evaluateCase', () => {
  test('passes a stop-condition run whose rubric passes, recording every fact the verdict rests on', async () => {
    const result = runResult();
    const evaluation = await evaluate({ result });
    expect(evaluation.verdict).toBe('pass');
    if (evaluation.verdict !== 'pass') return;
    expect(evaluation.resultSchemaVersion).toBe(1);
    expect(evaluation.evaluator.name).toBe('capital-cities');
    expect(evaluation.evaluationCase.id).toBe('case-france');
    expect(evaluation.run).toBe(result);
    expect(evaluation.rubric.weightedTotal).toBe(1);
    expect(evaluation.rubric.criteria.map((criterion) => criterion.name)).toEqual([
      'names-the-capital',
      'concise',
      'no-web-search',
      'follows-style-guide',
    ]);
    expect(evaluation.feedback).toBe('Passed with a weighted score of 1.00 (threshold 0.75).');
  });

  test('fails a case whose hard-threshold criterion fails, even when every other criterion scores 1.0', async () => {
    const { bound } = scorers({ assertion: false });
    // A threshold the weighted total clears, so only the hard gate can fail the case.
    const configuration = deterministicConfigurationInput();
    configuration['passThreshold'] = 0.4;
    const evaluation = await evaluate({ configuration, scorers: bound });
    expect(evaluation.verdict).toBe('fail');
    if (evaluation.verdict !== 'fail') return;
    expect(
      evaluation.rubric.criteria.map((criterion) => [criterion.name, criterion.score]),
    ).toEqual([
      ['names-the-capital', 0],
      ['concise', 1],
      ['no-web-search', 1],
      ['follows-style-guide', 1],
    ]);
    expect(evaluation.rubric.weightedTotal).toBe(0.5);
    expect(evaluation.rubric.weightedTotal).toBeGreaterThanOrEqual(evaluation.rubric.passThreshold);
    expect(evaluation.rubric.failedHardCriteria).toEqual(['names-the-capital']);
    expect(evaluation.feedback).toBe('Failed hard criteria: names-the-capital.');
  });

  test('fails a case whose trajectory calls a forbidden tool, even though the final content satisfies every other criterion', async () => {
    const evaluation = await evaluate({
      result: runResult({ toolCalls: [{ name: 'web_search', arguments: { query: 'capital' } }] }),
    });
    expect(evaluation.verdict).toBe('fail');
    if (evaluation.verdict !== 'fail') return;
    expect(evaluation.rubric.failedHardCriteria).toEqual(['no-web-search']);
    expect(
      evaluation.rubric.criteria.find((criterion) => criterion.name === 'no-web-search')?.rationale,
    ).toBe('Called forbidden tools: web_search.');
  });

  test('fails a case whose weighted total is below the pass threshold', async () => {
    const { bound } = scorers({ heuristic: 0, policy: 0 });
    const configuration = deterministicConfigurationInput();
    configuration['passThreshold'] = 0.9;
    const evaluation = await evaluate({ configuration, scorers: bound });
    expect(evaluation.verdict).toBe('fail');
    if (evaluation.verdict !== 'fail') return;
    expect(evaluation.rubric.failedHardCriteria).toEqual([]);
    expect(evaluation.feedback).toBe('Weighted score 0.67 is below the pass threshold 0.90.');
  });

  test.each([...AGENT_FAILURE_REASONS])(
    'returns agent-failed for a %s run without invoking any scorer',
    async (finishReason) => {
      const { bound, spies } = scorers();
      const generate = createScriptedGenerate([]);
      const evaluator = await createEvaluator({
        configuration: modelConfigurationInput(),
        dataset: datasetInput(),
        scorers: bound,
        generate,
      });
      const evaluation = await evaluator.evaluateCase(
        'case-france',
        runResult({ finishReason, error: new Error('stopped') }),
      );
      expect(evaluation.verdict).toBe('agent-failed');
      if (evaluation.verdict !== 'agent-failed') return;
      expect(evaluation.finishReason).toBe(finishReason);
      for (const spy of spies) expect(spy).toHaveBeenCalledTimes(0);
      expect(generate.callCount).toBe(0);
    },
  );

  test('scores model-judge criteria through the injected generate function, calling the judge once per case', async () => {
    const input = modelConfigurationInput();
    const criteria = input['criteria'] as Record<string, unknown>[];
    criteria.push({ ...criteria[4], name: 'on-topic', description: 'Stays on topic.' });
    const generate = createScriptedGenerate([
      reply(
        JSON.stringify({
          criteria: [
            { name: 'helpful-tone', score: 1, rationale: 'Polite.' },
            { name: 'on-topic', score: 0.5, rationale: 'Mostly.' },
          ],
          feedback: 'Lead with the city.',
        }),
      ),
    ]);
    const evaluator = await createEvaluator({
      configuration: input,
      dataset: datasetInput(),
      scorers: scorers().bound,
      generate,
    });
    const evaluation = await evaluator.evaluateCase('case-france', runResult());
    expect(generate.callCount).toBe(1);
    expect(evaluation.verdict).toBe('pass');
    if (evaluation.verdict !== 'pass') return;
    expect(evaluation.feedback).toBe('Lead with the city.');
    expect(
      evaluation.rubric.criteria.map((criterion) => [criterion.name, criterion.score]),
    ).toContainEqual(['on-topic', 0.5]);
  });

  test('returns infrastructure-failure when the judge throws', async () => {
    const cause = new Error('529 overloaded');
    const evaluation = await evaluate({
      configuration: modelConfigurationInput(),
      generate: createScriptedGenerate([{ kind: 'fail', error: cause }]),
    });
    const error = infrastructureError(evaluation);
    expect(error.reason).toBe('judge-error');
    expect(error.cause).toBe(cause);
  });

  test('returns infrastructure-failure when the judge output fails the result schema', async () => {
    const evaluation = await evaluate({
      configuration: modelConfigurationInput(),
      generate: createScriptedGenerate([reply('{"criteria": "all good"}')]),
    });
    expect(infrastructureError(evaluation).reason).toBe('judge-malformed-output');
  });

  test('never turns an infrastructure failure into a fail, even when a hard criterion already failed', async () => {
    const evaluation = await evaluate({
      configuration: modelConfigurationInput(),
      scorers: scorers({ assertion: false }).bound,
      generate: createScriptedGenerate([reply('not json')]),
    });
    expect(evaluation.verdict).toBe('infrastructure-failure');
    expect('rubric' in evaluation).toBe(false);
    expect('feedback' in evaluation).toBe(false);
  });

  test('never turns an infrastructure failure into a pass, even when every other criterion passed', async () => {
    const evaluation = await evaluate({
      configuration: modelConfigurationInput(),
      generate: createScriptedGenerate([
        reply(judgeReply({ score: 1 }).replace('"criteria"', '"scores"')),
      ]),
    });
    expect(evaluation.verdict).toBe('infrastructure-failure');
  });

  test('returns infrastructure-failure when a scorer throws', async () => {
    const evaluation = await evaluate({
      scorers: {
        ...scorers().bound,
        heuristics: {
          concise: () => {
            throw new Error('tokenizer missing');
          },
        },
      },
    });
    const error = infrastructureError(evaluation);
    expect(error.reason).toBe('scorer-error');
    expect(error.criterion).toBe('concise');
  });

  test('returns infrastructure-failure when the judge exceeds its latency budget, and aborts the judge call', async () => {
    const runtime = createManualRuntimeServices();
    const generate = createScriptedGenerate([
      { kind: 'block', barrier: 'judge' },
      reply(judgeReply()),
    ]);
    const evaluator = await createEvaluator({
      configuration: modelConfigurationInput(),
      dataset: datasetInput(),
      scorers: scorers().bound,
      generate,
      timers: runtime.timers,
    });
    const pending = evaluator.evaluateCase('case-france', runResult());
    await generate.reached('judge');
    expect(runtime.pendingTimers().map((timer) => timer.dueAt)).toEqual([30_000]);
    await runtime.advance(29_999);
    expect(generate.calls[0]?.context.signal?.aborted).toBe(false);
    await runtime.advance(1);
    const evaluation = await pending;
    const error = infrastructureError(evaluation);
    expect(error.reason).toBe('latency-budget-exceeded');
    expect(error.message).toBe('Evaluation exceeded its latency budget of 30000 ms');
    expect(generate.calls[0]?.context.signal?.aborted).toBe(true);
    // A judge that answers after the budget expired cannot change the verdict.
    generate.release('judge');
    expect(evaluation.verdict).toBe('infrastructure-failure');
  });

  test('stops invoking scorers once the latency budget has expired', async () => {
    const runtime = createManualRuntimeServices();
    const { promise: slowScore, resolve } = Promise.withResolvers<number>();
    let heuristicStarted = false;
    const { bound, spies } = scorers();
    const evaluator = await createEvaluator({
      configuration: deterministicConfigurationInput(),
      dataset: datasetInput(),
      scorers: {
        ...bound,
        heuristics: {
          concise: ({ signal }) => {
            heuristicStarted = true;
            expect(signal.aborted).toBe(false);
            return slowScore;
          },
        },
      },
      timers: runtime.timers,
    });
    const pending = evaluator.evaluateCase('case-france', runResult());
    while (!heuristicStarted) await Promise.resolve();
    await runtime.advance(30_000);
    expect(infrastructureError(await pending).reason).toBe('latency-budget-exceeded');
    resolve(1);
    // One macrotask turn drains every microtask the abandoned scoring loop queues.
    await Bun.sleep(0);
    const policy = spies[2]!;
    expect(policy).toHaveBeenCalledTimes(0);
  });

  test('clears the latency timer once scoring finishes within budget', async () => {
    const runtime = createManualRuntimeServices();
    const evaluation = await evaluate({ timers: runtime.timers });
    expect(evaluation.verdict).toBe('pass');
    expect(runtime.pendingTimers()).toEqual([]);
  });

  test('hands scorers the latency-budget abort signal and the case, including its expected answer', async () => {
    const assertion = mock(
      ({
        evaluationCase,
        result,
        signal,
      }: Parameters<NonNullable<CriterionScorers['assertions']>[string]>[0]) =>
        !signal.aborted && result.content.startsWith(evaluationCase.expected),
    );
    const evaluation = await evaluate({
      scorers: { ...scorers().bound, assertions: { 'names-the-capital': assertion } },
    });
    expect(assertion).toHaveBeenCalledTimes(1);
    expect(evaluation.verdict).toBe('pass');
  });

  test('evaluates with real timers by default', async () => {
    const generate = createScriptedGenerate([reply(judgeReply())]);
    const evaluation = await evaluate({ configuration: modelConfigurationInput(), generate });
    expect(evaluation.verdict).toBe('pass');
    expect(generate.callCount).toBe(1);
  });
});
