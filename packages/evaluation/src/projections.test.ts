import { describe, expect, test } from 'bun:test';

import { createScriptedGenerate, type RunResultBase } from '@lostgradient/operative';

import type { CriterionScorers } from './criteria';
import {
  CALIBRATION_RESPONSE,
  datasetInput,
  EXPECTED_ANSWER,
  judgeReply,
  modelConfigurationInput,
  runResult,
  STYLE_GUIDE_TEXT,
} from './evaluation.test-support';
import { createEvaluator } from './evaluator';
import { toGeneratorProjection, toReviewerProjection } from './projections';
import type { CaseEvaluation } from './verdict';

const LEAKY_FEEDBACK = `The answer should be "${EXPECTED_ANSWER}". Remember: ${STYLE_GUIDE_TEXT} Unlike "${CALIBRATION_RESPONSE}"`;

function scorers(assertion = true): CriterionScorers {
  return {
    assertions: { 'names-the-capital': () => assertion },
    heuristics: { concise: () => 1 },
    policies: { 'follows-style-guide': () => 1 },
  };
}

async function evaluate(
  result: RunResultBase,
  options: { assertion?: boolean; reply?: string } = {},
): Promise<CaseEvaluation> {
  const evaluator = await createEvaluator({
    configuration: modelConfigurationInput(),
    dataset: datasetInput(),
    scorers: scorers(options.assertion),
    generate: createScriptedGenerate([
      {
        kind: 'respond',
        response: {
          content: options.reply ?? judgeReply({ feedback: LEAKY_FEEDBACK }),
          toolCalls: [],
        },
      },
    ]),
  });
  return evaluator.evaluateCase('case-france', result);
}

describe('toGeneratorProjection', () => {
  test('exposes only the verdict, the feedback, and the names of failing hard criteria', async () => {
    const projection = toGeneratorProjection(
      await evaluate(runResult({ toolCalls: [{ name: 'web_search' }] }), { assertion: false }),
    );
    expect(Object.keys(projection).toSorted()).toEqual([
      'failedHardCriteria',
      'feedback',
      'projection',
      'verdict',
    ]);
    expect(projection.projection).toBe('generator');
    expect(projection.verdict).toBe('fail');
    expect(projection.failedHardCriteria).toEqual(['names-the-capital', 'no-web-search']);
  });

  test('never contains the expected answer, reference material, or calibration examples, even when the judge quotes them', async () => {
    const evaluation = await evaluate(runResult());
    if (evaluation.verdict !== 'pass')
      throw new Error(`Expected a pass, got ${evaluation.verdict}`);
    expect(evaluation.feedback).toContain(EXPECTED_ANSWER);
    const serialized = JSON.stringify(toGeneratorProjection(evaluation));
    expect(serialized).not.toContain(EXPECTED_ANSWER);
    expect(serialized).not.toContain(STYLE_GUIDE_TEXT);
    expect(serialized).not.toContain(CALIBRATION_RESPONSE);
    expect(serialized).not.toContain('case-france');
    expect(toGeneratorProjection(evaluation).feedback).toBe(
      'The answer should be "[redacted]". Remember: [redacted] Unlike "[redacted]"',
    );
  });

  test('explains an agent failure without scoring details', async () => {
    const projection = toGeneratorProjection(
      await evaluate(runResult({ finishReason: 'maximum-steps' })),
    );
    expect(projection).toEqual({
      projection: 'generator',
      verdict: 'agent-failed',
      feedback:
        'The run ended with finish reason "maximum-steps" before its criteria could be scored.',
      failedHardCriteria: [],
    });
  });

  test('reports an infrastructure failure without the evaluator error or its cause', async () => {
    const evaluation = await evaluate(runResult(), { reply: `not json: ${EXPECTED_ANSWER}` });
    expect(evaluation.verdict).toBe('infrastructure-failure');
    const projection = toGeneratorProjection(evaluation);
    expect(projection).toEqual({
      projection: 'generator',
      verdict: 'infrastructure-failure',
      feedback: 'The evaluator could not score this run. This is not a verdict on the run.',
      failedHardCriteria: [],
    });
  });
});

describe('toReviewerProjection', () => {
  test('exposes every inspectable fact of a scored case as plain JSON', async () => {
    const result = runResult({ toolCalls: [{ name: 'lookup', arguments: { country: 'France' } }] });
    const evaluation = await evaluate(result);
    const projection = toReviewerProjection(evaluation);
    expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);
    expect(projection.projection).toBe('reviewer');
    expect(projection.verdict).toBe('pass');
    expect(projection.resultSchemaVersion).toBe(1);
    expect(projection.evaluator).toBe(evaluation.evaluator);
    expect(projection.configuration.judge).toEqual(evaluation.configuration.judge);
    expect(projection.configuration.referenceMaterial.entries[0]?.text).toBe(STYLE_GUIDE_TEXT);
    expect(projection.case).toEqual({
      id: 'case-france',
      input: 'What is the capital of France?',
      expected: EXPECTED_ANSWER,
    });
    expect(projection.feedback).toBe(LEAKY_FEEDBACK);
    expect(projection.rubric?.criteria.map((criterion) => criterion.name)).toHaveLength(5);
    expect(projection.run).toEqual({
      finishReason: 'stop-condition',
      content: 'Paris, on the Seine.',
      usage: { prompt: 12, completion: 8, total: 20 },
      trajectory: [
        {
          step: 0,
          content: '',
          toolCalls: [{ id: 'call-0', name: 'lookup', arguments: { country: 'France' } }],
          results: [
            { toolCallId: 'call-0', toolName: 'lookup', outcome: 'success', content: 'ok' },
          ],
        },
        { step: 1, content: 'Paris, on the Seine.', toolCalls: [], results: [] },
      ],
    });
  });

  test('includes the terminal error, cost estimate, and schema validation of the run', async () => {
    const result: RunResultBase = {
      ...runResult({ finishReason: 'error', error: new TypeError('provider exploded') }),
      costEstimate: {
        promptCost: 0.01,
        completionCost: 0.02,
        cacheWriteCost: 0,
        cacheReadCost: 0,
        totalCost: 0.03,
        model: 'claude-sonnet-4-5',
        usage: { prompt: 12, completion: 8, total: 20 },
      },
      schemaValidation: { success: false, error: 'not an object' },
    };
    const projection = toReviewerProjection(await evaluate(result));
    expect(projection.verdict).toBe('agent-failed');
    expect(projection.run.finishReason).toBe('error');
    expect(projection.run.error).toEqual({ name: 'TypeError', message: 'provider exploded' });
    expect(projection.run.costEstimate).toEqual(result.costEstimate);
    expect(projection.run.schemaValidation).toEqual({
      success: false,
      error: { name: 'string', message: 'not an object' },
    });
    expect(projection.rubric).toBeUndefined();
    expect(projection.infrastructureError).toBeUndefined();
  });

  test('includes the typed infrastructure error', async () => {
    const projection = toReviewerProjection(await evaluate(runResult(), { reply: 'not json' }));
    expect(projection.verdict).toBe('infrastructure-failure');
    expect(projection.infrastructureError).toEqual({
      reason: 'judge-malformed-output',
      message: 'Model judge "rubric-judge" returned malformed output: the reply is not JSON',
    });
    expect(projection.feedback).toBeUndefined();
  });

  test('keeps a schema validation without an error as a bare success flag', async () => {
    const result: RunResultBase = { ...runResult(), schemaValidation: { success: true } };
    const projection = toReviewerProjection(await evaluate(result));
    expect(projection.run.schemaValidation).toEqual({ success: true });
  });
});
