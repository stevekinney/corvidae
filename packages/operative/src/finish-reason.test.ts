import { describe, expect, it } from 'bun:test';

import { classifyErrorFinishReason } from './durable/run-workflow-result';
import {
  BudgetExceededError,
  ElicitationDeniedError,
  GuardrailTripwireError,
  MaximumStepsExceededError,
} from './errors';
import {
  FAILURE_BY_FINISH_REASON,
  finishReasonOfError,
  isFailureFinishReason,
} from './finish-reason';
import type { FinishReason } from './types';

/** Every finish reason, so a reason added to the type has to be classified here too. */
const EXPECTED: Readonly<Record<FinishReason, boolean>> = {
  error: true,
  tripwire: true,
  'maximum-steps': true,
  'elicitation-denied': true,
  'budget-exceeded': true,
  'stop-condition': false,
  aborted: false,
};

describe('isFailureFinishReason (COR-1627)', () => {
  it('classifies every finish reason: five failures, a stop, and an abort', () => {
    expect(Object.keys(FAILURE_BY_FINISH_REASON).toSorted()).toEqual(
      Object.keys(EXPECTED).toSorted(),
    );
    for (const [finishReason, failure] of Object.entries(EXPECTED)) {
      expect([finishReason, isFailureFinishReason(finishReason)]).toEqual([finishReason, failure]);
    }
  });

  it('is false for anything that is not a known finish reason', () => {
    for (const value of [
      undefined,
      null,
      42,
      {},
      ['error'],
      '',
      'unknown',
      'toString',
      'constructor',
      '__proto__',
    ]) {
      expect(isFailureFinishReason(value)).toBe(false);
    }
  });
});

describe('finishReasonOfError (COR-1627)', () => {
  it('classifies every error class the way makeErrorResult does, a step limit included', () => {
    expect(finishReasonOfError(new MaximumStepsExceededError(2))).toBe('maximum-steps');
    expect(finishReasonOfError(new BudgetExceededError('spent'))).toBe('budget-exceeded');
    expect(finishReasonOfError(new ElicitationDeniedError('declined'))).toBe('elicitation-denied');
    expect(
      finishReasonOfError(
        new GuardrailTripwireError('tripped', {
          guardrailName: 'g',
          category: 'c',
          phase: 'input',
          confidence: 1,
        }),
      ),
    ).toBe('tripwire');
    expect(finishReasonOfError(new Error('plain'))).toBe('error');
    expect(finishReasonOfError('not an error')).toBe('error');
  });

  it('agrees with the durable classifier', () => {
    for (const error of [
      new MaximumStepsExceededError(3),
      new BudgetExceededError('spent'),
      new ElicitationDeniedError('declined'),
      new Error('plain'),
    ]) {
      expect(classifyErrorFinishReason(error)).toBe(finishReasonOfError(error));
    }
  });
});
