import { describe, expect, test } from 'bun:test';

import {
  createAgent,
  createManualRuntimeServices,
  createScriptedGenerate,
  type RunResultBase,
} from '@lostgradient/operative';

import type { CriterionScorers } from './criteria';
import { toolCallNames } from './criteria';
import {
  CALIBRATION_RESPONSE,
  datasetInput,
  EXPECTED_ANSWER,
  HELD_OUT_CASE_ID,
  judgeReply,
  modelConfigurationInput,
  runResult,
  STYLE_GUIDE_TEXT,
} from './evaluation.test-support';
import { createEvaluator } from './evaluator';
import {
  fromReviewerRunProjection,
  toGeneratorProjection,
  toReviewerProjection,
  toReviewerRunProjection,
} from './projections';
import { runTrials, type TrialAggregate } from './trials';
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
  options: { assertion?: boolean; reply?: string; caseId?: string } = {},
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
  return evaluator.evaluateCase(options.caseId ?? 'case-france', result);
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

  test('redacts a held-out case id the judge quotes, and leaves a public one alone', async () => {
    const heldOut = await evaluate(runResult(), {
      reply: judgeReply({ feedback: `Compare with ${HELD_OUT_CASE_ID}.` }),
    });
    expect(toGeneratorProjection(heldOut).feedback).toBe('Compare with [redacted].');
    const publicCase = await evaluate(runResult(), {
      caseId: 'case-japan',
      reply: judgeReply({ feedback: 'Compare with case-japan.' }),
    });
    expect(toGeneratorProjection(publicCase).feedback).toBe('Compare with case-japan.');
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

describe('toGeneratorProjection of a trial aggregate', () => {
  const QUOTING_FEEDBACK = `Case ${HELD_OUT_CASE_ID} (held-out) expects "${EXPECTED_ANSWER}".`;

  async function aggregate(options: {
    holds?: readonly boolean[];
    replies?: readonly string[];
    configuration?: Record<string, unknown>;
  }): Promise<TrialAggregate> {
    const replies =
      options.replies ?? [1, 2, 3].map(() => judgeReply({ feedback: QUOTING_FEEDBACK }));
    let assertionCalls = 0;
    const evaluator = await createEvaluator({
      configuration: options.configuration ?? modelConfigurationInput(),
      dataset: datasetInput(),
      scorers: {
        ...scorers(),
        assertions: { 'names-the-capital': () => options.holds?.[assertionCalls++] ?? true },
      },
      generate: createScriptedGenerate(
        replies.map((content) => ({
          kind: 'respond' as const,
          response: { content, toolCalls: [] },
        })),
      ),
    });
    const agentGenerate = createScriptedGenerate(
      replies.map(() => ({
        kind: 'respond' as const,
        response: { content: 'Paris, on the Seine.', toolCalls: [] },
      })),
    );
    return runTrials({
      evaluator,
      caseId: HELD_OUT_CASE_ID,
      subject: () => createAgent({ name: 'geographer', generate: agentGenerate }),
      runtime: createManualRuntimeServices(),
    });
  }

  test('never contains a held-out case id, its held-out status, or its expected answer', async () => {
    const reviewed = await aggregate({ holds: [true, false, false] });
    expect(reviewed.outcome).toBe('disagreement');
    // The aggregate itself is reviewer material and keeps all three.
    const reviewerJson = JSON.stringify(reviewed);
    expect(reviewerJson).toContain(HELD_OUT_CASE_ID);
    expect(reviewerJson).toContain(EXPECTED_ANSWER);
    expect(reviewerJson).toContain('held-out');

    const projection = toGeneratorProjection(reviewed);
    const serialized = JSON.stringify(projection);
    const { cases } = datasetInput();
    for (const heldOut of cases.filter((entry) => entry.visibility === 'held-out')) {
      expect(serialized).not.toContain(heldOut.id);
      expect(serialized).not.toContain(heldOut.expected);
    }
    expect(serialized).not.toContain('held-out');
    expect(serialized).not.toContain(STYLE_GUIDE_TEXT);
    expect(Object.keys(projection).toSorted()).toEqual([
      'failedHardCriteria',
      'feedback',
      'outcome',
      'projection',
    ]);
    expect(projection).toEqual({
      projection: 'generator',
      outcome: 'disagreement',
      feedback:
        'The evaluator’s trials disagreed: 1 of 3 passed. This is neither a pass nor a fail.',
      failedHardCriteria: ['names-the-capital'],
    });
    expect(projection).not.toHaveProperty('pass');
  });

  test('reports how many trials passed for a pass or a fail', async () => {
    expect(toGeneratorProjection(await aggregate({}))).toEqual({
      projection: 'generator',
      outcome: 'pass',
      feedback: '3 of 3 trials passed.',
      failedHardCriteria: [],
    });
    expect(toGeneratorProjection(await aggregate({ holds: [false, false, false] }))).toEqual({
      projection: 'generator',
      outcome: 'fail',
      feedback: '0 of 3 trials passed.',
      failedHardCriteria: ['names-the-capital'],
    });
  });

  test('reports an indeterminate aggregate without its errors or any verdict', async () => {
    const projection = toGeneratorProjection(
      await aggregate({
        holds: [false, true, true],
        replies: [judgeReply(), `not json: ${EXPECTED_ANSWER}`, judgeReply()],
      }),
    );
    expect(projection).toEqual({
      projection: 'generator',
      outcome: 'indeterminate',
      feedback: 'The evaluator could not score every trial. This is not a verdict on the run.',
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
      visibility: 'held-out',
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

describe('fromReviewerRunProjection', () => {
  test('rebuilds a run whose reviewer projection is the one it was rebuilt from', () => {
    const result: RunResultBase = {
      ...runResult({
        content: 'Paris.',
        finishReason: 'error',
        error: new TypeError('provider exploded'),
        toolCalls: [{ name: 'lookup', arguments: { country: 'France' } }, { name: 'atlas' }],
      }),
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
    const projected = toReviewerRunProjection(result);

    const rebuilt = fromReviewerRunProjection(JSON.parse(JSON.stringify(projected)));

    expect(toReviewerRunProjection(rebuilt)).toEqual(projected);
    expect(rebuilt.content).toBe('Paris.');
    expect(toolCallNames(rebuilt)).toEqual(['lookup', 'atlas']);
    expect(rebuilt.steps.map((step) => step.final)).toEqual([false, false, true]);
    expect(rebuilt.error).toBeInstanceOf(Error);
    expect(rebuilt.error).toMatchObject({ name: 'TypeError', message: 'provider exploded' });
  });

  test('rebuilds a plain finished run without an error, a cost, or a schema validation', () => {
    const projected = toReviewerRunProjection(runResult());
    const rebuilt = fromReviewerRunProjection(projected);
    expect(rebuilt).not.toHaveProperty('error');
    expect(rebuilt).not.toHaveProperty('costEstimate');
    expect(rebuilt).not.toHaveProperty('schemaValidation');
    expect(toReviewerRunProjection(rebuilt)).toEqual(projected);
    expect(
      toReviewerRunProjection(
        fromReviewerRunProjection({ ...projected, schemaValidation: { success: true } }),
      ).schemaValidation,
    ).toEqual({ success: true });
  });
});
