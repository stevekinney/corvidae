import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createRunState } from '../loop';
import { makeErrorResult } from '../run-lifecycle';
import type { FinishReason } from '../types';
import {
  FINISH_REASONS_ANNOUNCED_ON_REATTACH,
  reconstructTerminalRunError,
} from './active-run-result-reconstruction';

/**
 * COR-1598: whether a recovered run announces `run.error` is a classification of every finish
 * reason, and it has to agree with the one place a fresh run turns an error into a finish reason,
 * `makeErrorResult`. A reason that is classified there as a failure is announced; a reason it
 * does not classify back to itself (a stop, a step limit, an abort) is not. The map's own
 * `satisfies Record<FinishReason, boolean>` makes a new finish reason fail the type-check until
 * it is classified, and this test makes the classification agree with `makeErrorResult`.
 */
describe('the finish reasons a recovered run announces as a failure', () => {
  it('announces exactly the finish reasons that makeErrorResult classifies as a failure', () => {
    const reasons = Object.keys(FINISH_REASONS_ANNOUNCED_ON_REATTACH) as FinishReason[];
    // Every finish reason is classified, so a reason added to the type cannot be skipped here.
    const everyFinishReason: FinishReason[] = [
      'aborted',
      'budget-exceeded',
      'elicitation-denied',
      'error',
      'maximum-steps',
      'stop-condition',
      'tripwire',
    ];
    expect(reasons.toSorted()).toEqual(everyFinishReason);

    for (const finishReason of reasons) {
      const reconstructed = reconstructTerminalRunError({ finishReason, steps: 1 });
      const classifiedAs =
        reconstructed === undefined
          ? undefined
          : makeErrorResult(
              createRunState(),
              new Conversation(),
              undefined,
              undefined,
              reconstructed,
            ).finishReason;

      expect([finishReason, FINISH_REASONS_ANNOUNCED_ON_REATTACH[finishReason]]).toEqual([
        finishReason,
        classifiedAs === finishReason,
      ]);
    }
  });
});
