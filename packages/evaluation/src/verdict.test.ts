import { describe, expect, test } from 'bun:test';

import type { FinishReason } from '@lostgradient/operative';

import {
  AGENT_FAILURE_REASONS,
  EvaluatorInfrastructureError,
  INFRASTRUCTURE_FAILURE_REASONS,
  isAgentFailureReason,
} from './verdict';

describe('agent failure reasons', () => {
  test('are exactly the non-stop-condition finish reasons', () => {
    expect(AGENT_FAILURE_REASONS).toEqual([
      'maximum-steps',
      'aborted',
      'error',
      'elicitation-denied',
      'budget-exceeded',
      'tripwire',
    ]);
  });

  test.each<[FinishReason, boolean]>([
    ['stop-condition', false],
    ['maximum-steps', true],
    ['tripwire', true],
  ])('isAgentFailureReason(%s) is %s', (reason, expected) => {
    expect(isAgentFailureReason(reason)).toBe(expected);
  });
});

describe('EvaluatorInfrastructureError', () => {
  test('carries a typed reason, the affected criterion, and the underlying cause', () => {
    const cause = new Error('socket hang up');
    const error = new EvaluatorInfrastructureError({
      reason: 'judge-error',
      message: 'The model judge threw',
      criterion: 'helpful-tone',
      cause,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('EvaluatorInfrastructureError');
    expect(error.reason).toBe('judge-error');
    expect(error.criterion).toBe('helpful-tone');
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('The model judge threw');
  });

  test('leaves the criterion undefined when the failure is not tied to one', () => {
    const error = new EvaluatorInfrastructureError({
      reason: 'latency-budget-exceeded',
      message: 'Evaluation exceeded its latency budget',
    });
    expect(error.criterion).toBeUndefined();
    expect(INFRASTRUCTURE_FAILURE_REASONS).toContain(error.reason);
  });

  test('names every infrastructure failure reason, including a trial whose run rejected', () => {
    expect(INFRASTRUCTURE_FAILURE_REASONS).toEqual([
      'judge-error',
      'judge-malformed-output',
      'scorer-error',
      'scorer-malformed-output',
      'latency-budget-exceeded',
      'subject-error',
    ]);
  });

  test('serializes to its name, reason, message, and criterion, never its cause', () => {
    const error = new EvaluatorInfrastructureError({
      reason: 'judge-error',
      message: 'The model judge threw',
      criterion: 'helpful-tone',
      cause: new Error('secret provider detail'),
    });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'EvaluatorInfrastructureError',
      reason: 'judge-error',
      message: 'The model judge threw',
      criterion: 'helpful-tone',
    });
    const untied = new EvaluatorInfrastructureError({
      reason: 'subject-error',
      message: 'Run rejected',
    });
    expect(JSON.stringify(untied)).toBe(
      '{"name":"EvaluatorInfrastructureError","reason":"subject-error","message":"Run rejected"}',
    );
  });
});
