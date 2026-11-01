/**
 * What a reply’s details print (COR-1983): the plan reason and the context from the inspected step,
 * and the tokens from the run’s terminal event. A part without a source is left out.
 */
import { describe, expect, test } from 'bun:test';

import type { TaskStep } from '../../lib/bureau-tasks.ts';
import { isEmptyDetails, replyDetailsOf, replyStepOf, usageEntries } from './reply-details.ts';

const STEP: TaskStep = {
  step: 1,
  messageId: 'run-1:step:1',
  planReason: {
    code: 'policy',
    detail: 'The model policy leaves one model',
    rejected: [
      { provider: 'anthropic', model: 'opus', code: 'policy' },
      { provider: 'openai', model: 'mini', code: 'fallback' },
    ],
  },
  hasEffectiveContext: true,
  effectiveContext: {
    sources: [
      { sourceId: 'memory', disposition: 'included' },
      { sourceId: 'skills', disposition: 'excluded', reason: 'over budget' },
      { sourceId: 'hook-plan', disposition: 'absent-by-composition' },
    ],
    messages: [{ id: 'm1', role: 'user' }],
    messageCount: 12,
    truncated: true,
  },
};

describe('the step a row is the reply of', () => {
  test('is read from the Bureau’s row identifier', () => {
    expect(replyStepOf('run-1:step:3')).toEqual({ runId: 'run-1', step: 3 });
    expect(replyStepOf('a:b:step:0')).toEqual({ runId: 'a:b', step: 0 });
  });

  test('is none for a row the Bureau did not name as a step', () => {
    expect(replyStepOf('reply-1')).toBeUndefined();
    expect(replyStepOf('run-1:step:')).toBeUndefined();
    expect(replyStepOf('run-1:step:x')).toBeUndefined();
  });
});

describe('the details of a step', () => {
  test('say why the model was chosen, what it passed over and what the model saw', () => {
    const details = replyDetailsOf(STEP, undefined);
    expect(details.why).toEqual({
      reason: 'Model policy',
      detail: 'The model policy leaves one model',
      passedOver: ['anthropic/opus: not allowed by the model policy', 'openai/mini: unavailable'],
    });
    expect(details.saw).toEqual({
      messages: '12 messages',
      truncated: true,
      sources: ['memory: included', 'skills: left out (over budget)'],
    });
    expect(details.usage).toEqual([]);
  });

  test('name no source that was absent by composition', () => {
    expect(replyDetailsOf(STEP, undefined).saw?.sources.join(' ')).not.toContain('hook-plan');
  });

  test('leave out a plan the step was recorded without', () => {
    const details = replyDetailsOf({ ...STEP, planReason: null }, undefined);
    expect(details.why).toBeUndefined();
    expect(details.saw).toBeDefined();
  });

  test('leave out a context the step kept none of', () => {
    const details = replyDetailsOf(
      { ...STEP, hasEffectiveContext: false, effectiveContext: null },
      undefined,
    );
    expect(details.saw).toBeUndefined();
    expect(details.why).toBeDefined();
  });

  test('say one message in the singular', () => {
    const details = replyDetailsOf(
      { ...STEP, effectiveContext: { ...STEP.effectiveContext!, messageCount: 1 } },
      undefined,
    );
    expect(details.saw?.messages).toBe('1 message');
  });

  test('are empty for a step with neither, and with no usage', () => {
    const bare = replyDetailsOf(
      { ...STEP, planReason: null, hasEffectiveContext: false, effectiveContext: null },
      undefined,
    );
    expect(isEmptyDetails(bare)).toBe(true);
    expect(isEmptyDetails(replyDetailsOf(undefined, undefined))).toBe(true);
  });

  test('are not empty when only the run’s usage is known', () => {
    const details = replyDetailsOf(undefined, { totalTokens: 1234 });
    expect(isEmptyDetails(details)).toBe(false);
    expect(details.usage).toEqual([{ kind: 'Total', tokens: '1,234' }]);
  });
});

describe('the tokens a run used', () => {
  test('list only the counts the event carried, input first', () => {
    expect(usageEntries({ totalTokens: 1500, inputTokens: 1000 })).toEqual([
      { kind: 'Input', tokens: '1,000' },
      { kind: 'Total', tokens: '1,500' },
    ]);
  });

  test('keep a count of zero, which is a count', () => {
    expect(usageEntries({ outputTokens: 0 })).toEqual([{ kind: 'Output', tokens: '0' }]);
  });

  test('are none for a run the page did not watch end', () => {
    expect(usageEntries(undefined)).toEqual([]);
  });
});
