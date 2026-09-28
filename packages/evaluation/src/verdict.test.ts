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
});
