import { describe, expect, test } from 'bun:test';

import { createScriptedGenerate, type GenerateResponse } from '@lostgradient/operative';

import { parseEvaluatorConfiguration } from './configuration';
import { parseEvaluationDataset } from './datasets';
import {
  CALIBRATION_RESPONSE,
  datasetInput,
  EXPECTED_ANSWER,
  judgeReply,
  modelConfigurationInput,
  runResult,
  STYLE_GUIDE_TEXT,
} from './evaluation.test-support';
import {
  JUDGE_RESPONSE_FORMAT,
  parseJudgeResponse,
  renderJudgePrompt,
  runModelJudge,
} from './judge';
import { EvaluatorInfrastructureError } from './verdict';

const configuration = parseEvaluatorConfiguration(modelConfigurationInput());
const evaluationCase = parseEvaluationDataset(datasetInput()).cases[0]!;

function reply(content: string, toolCalls: GenerateResponse['toolCalls'] = []): GenerateResponse {
  return { content, toolCalls };
}

function malformedReason(response: GenerateResponse): string {
  try {
    parseJudgeResponse(response, 'rubric-judge', ['helpful-tone']);
  } catch (error) {
    expect(error).toBeInstanceOf(EvaluatorInfrastructureError);
    expect((error as EvaluatorInfrastructureError).reason).toBe('judge-malformed-output');
    return (error as EvaluatorInfrastructureError).message;
  }
  throw new Error('Expected the judge response to be rejected');
}

describe('renderJudgePrompt', () => {
  const prompt = renderJudgePrompt({
    configuration,
    evaluationCase,
    result: runResult({ toolCalls: [{ name: 'lookup', arguments: { country: 'France' } }] }),
  });

  test('puts the rubric, reference material, and calibration examples in the system message', () => {
    expect(prompt.system).toContain('rubric-judge');
    expect(prompt.system).toContain('judge-prompt-3');
    expect(prompt.system).toContain(
      '- helpful-tone (weight 2): The answer is courteous and directly addresses the question.',
    );
    expect(prompt.system).not.toContain('names-the-capital');
    expect(prompt.system).toContain('Reference material (version style-guide-2026-09)');
    expect(prompt.system).toContain(STYLE_GUIDE_TEXT);
    expect(prompt.system).toContain('Calibration examples');
    expect(prompt.system).toContain('calibration-lyon');
    expect(prompt.system).toContain(CALIBRATION_RESPONSE);
    expect(prompt.system).toContain('Expected verdict: fail');
    expect(prompt.system).toContain('Names the wrong city.');
    expect(prompt.system).toContain('"criteria"');
  });

  test('keeps the case under evaluation out of the calibration section and vice versa', () => {
    expect(prompt.system).not.toContain(EXPECTED_ANSWER);
    expect(prompt.system).not.toContain('case-france');
    expect(prompt.user).not.toContain(CALIBRATION_RESPONSE);
    expect(prompt.user).toContain('case-france');
    expect(prompt.user).toContain('What is the capital of France?');
    expect(prompt.user).toContain(`Expected answer:\n${EXPECTED_ANSWER}`);
    expect(prompt.user).toContain('Paris, on the Seine.');
    expect(prompt.user).toContain('1. lookup {"country":"France"}');
  });

  test('says so when there are no tool calls, calibration examples, or reference entries', () => {
    const input = modelConfigurationInput();
    input['examples'] = [];
    const reference = input['referenceMaterial'] as { entries: unknown[] };
    reference.entries = [];
    input['criteria'] = (input['criteria'] as { kind: string }[]).filter(
      (criterion) => criterion.kind !== 'policy',
    );
    const bare = renderJudgePrompt({
      configuration: parseEvaluatorConfiguration(input),
      evaluationCase,
      result: runResult(),
    });
    expect(bare.system).toContain('No calibration examples.');
    expect(bare.system).toContain('No reference material.');
    expect(bare.user).toContain('No tool calls.');
  });

  test('marks hard thresholds in the rubric', () => {
    const input = modelConfigurationInput();
    const criteria = input['criteria'] as Record<string, unknown>[];
    criteria[4] = { ...criteria[4], hardThreshold: 0.6 };
    const gated = renderJudgePrompt({
      configuration: parseEvaluatorConfiguration(input),
      evaluationCase,
      result: runResult(),
    });
    expect(gated.system).toContain('- helpful-tone (weight 2, hard threshold 0.6):');
  });
});

describe('parseJudgeResponse', () => {
  test('returns each criterion score and the feedback', () => {
    const verdict = parseJudgeResponse(reply(judgeReply({ score: 0.4 })), 'rubric-judge', [
      'helpful-tone',
    ]);
    expect(verdict.feedback).toBe('Clear, direct answer.');
    expect(verdict.scores.get('helpful-tone')).toEqual({
      score: 0.4,
      rationale: 'Courteous and direct.',
    });
  });

  test('rejects a response that requests tool calls', () => {
    expect(malformedReason(reply(judgeReply(), [{ name: 'search', arguments: {} }]))).toContain(
      'requested tool calls',
    );
  });

  test('rejects a response that is not JSON', () => {
    expect(malformedReason(reply('The answer looks great!'))).toContain('not JSON');
  });

  test('rejects a response that fails the result schema', () => {
    const outOfRange = JSON.stringify({
      criteria: [{ name: 'helpful-tone', score: 2, rationale: 'x' }],
      feedback: 'ok',
    });
    expect(malformedReason(reply(outOfRange))).toContain('criteria.0.score');
    expect(malformedReason(reply(JSON.stringify({ criteria: [] })))).toContain('feedback');
  });

  test('rejects scores for criteria the judge was not asked about, and repeated scores', () => {
    const unknown = JSON.stringify({
      criteria: [{ name: 'concise', score: 1, rationale: 'x' }],
      feedback: 'ok',
    });
    expect(malformedReason(reply(unknown))).toContain('"concise"');
    const repeated = JSON.stringify({
      criteria: [
        { name: 'helpful-tone', score: 1, rationale: 'x' },
        { name: 'helpful-tone', score: 0, rationale: 'y' },
      ],
      feedback: 'ok',
    });
    expect(malformedReason(reply(repeated))).toContain('more than once');
  });
});

describe('runModelJudge', () => {
  test('calls the injected generate function with the rendered prompt and no tools', async () => {
    const generate = createScriptedGenerate([
      { kind: 'respond', response: reply(judgeReply({ score: 0.9 })) },
    ]);
    const controller = new AbortController();
    const verdict = await runModelJudge({
      generate,
      configuration,
      evaluationCase,
      result: runResult(),
      signal: controller.signal,
    });
    expect(verdict.scores.get('helpful-tone')?.score).toBe(0.9);
    expect(generate.callCount).toBe(1);
    generate.assertReceived(0, { tools: [], signal: controller.signal });
    const context = generate.calls[0]!.context;
    expect(context.step).toBe(0);
    expect(context.responseFormat).toBe(JUDGE_RESPONSE_FORMAT);
    const history = context.conversation.current;
    const messages = history.ids.map((id) => history.messages[id]!);
    const expected = renderJudgePrompt({ configuration, evaluationCase, result: runResult() });
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ['system', expected.system],
      ['user', expected.user],
    ]);
  });

  test('turns a judge that throws into a typed infrastructure error', async () => {
    const cause = new Error('overloaded');
    const generate = createScriptedGenerate([{ kind: 'fail', error: cause }]);
    let caught: unknown;
    try {
      await runModelJudge({
        generate,
        configuration,
        evaluationCase,
        result: runResult(),
        signal: new AbortController().signal,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EvaluatorInfrastructureError);
    const error = caught as EvaluatorInfrastructureError;
    expect(error.reason).toBe('judge-error');
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('Model judge "rubric-judge" threw');
  });

  test('requests the judge result schema as structured output', () => {
    expect(JUDGE_RESPONSE_FORMAT.type).toBe('json_schema');
    expect(JUDGE_RESPONSE_FORMAT.name).toBe('evaluation_judge_verdict');
    expect(JSON.stringify(JUDGE_RESPONSE_FORMAT.schema)).toContain('"feedback"');
  });
});
