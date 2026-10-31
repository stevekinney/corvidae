/**
 * The dead-letter guard: a clear is confirmed against the dead letter as the diagnostics listed it
 * when the dialog opened, so one that was cleared, or recorded again, meanwhile is refused.
 */
import { describe, expect, test } from 'bun:test';

import { deadLetterTarget, sameDeadLetter } from './dead-letter-guard.ts';
import type { StandardTaskDiagnosticItem, TaskDiagnosticItem } from './worker-catalog-types.ts';

function deadLetter(
  overrides: Partial<StandardTaskDiagnosticItem> = {},
): StandardTaskDiagnosticItem {
  return {
    kind: 'dead-lettered',
    state: 'dead-lettered',
    retryCount: 5,
    requeueCount: 5,
    evidence: ['exhausted retries'],
    operationId: 'op_a',
    activityName: 'ChargeCard',
    queue: 'payments',
    deadLetteredAt: 1_700_000_000_000,
    ...overrides,
  };
}

const STUCK: TaskDiagnosticItem = {
  kind: 'stuck-queued',
  state: 'queued',
  retryCount: 0,
  requeueCount: 0,
  evidence: ['waiting'],
  operationId: 'op_a',
  queue: 'payments',
};

describe('deadLetterTarget', () => {
  test('reads the task, queue, activity and moment from the listed dead letter', () => {
    expect(deadLetterTarget([deadLetter()], 'op_a')).toEqual({
      operationId: 'op_a',
      queue: 'payments',
      activityName: 'ChargeCard',
      deadLetteredAt: 1_700_000_000_000,
    });
  });

  test('finds nothing for a task that is not listed, or is listed as something other than a dead letter', () => {
    expect(deadLetterTarget([deadLetter()], 'op_b')).toBeNull();
    expect(deadLetterTarget([STUCK], 'op_a')).toBeNull();
    expect(deadLetterTarget([], 'op_a')).toBeNull();
  });
});

describe('sameDeadLetter', () => {
  const listed = deadLetterTarget([deadLetter()], 'op_a');

  test('holds while the dead letter is listed as it was', () => {
    expect(sameDeadLetter(listed, deadLetterTarget([deadLetter()], 'op_a'))).toBe(true);
  });

  test('refuses once the dead letter is gone', () => {
    expect(sameDeadLetter(listed, null)).toBe(false);
    expect(sameDeadLetter(null, listed)).toBe(false);
  });

  test('refuses a task dead-lettered again at another moment, or moved to another queue', () => {
    expect(
      sameDeadLetter(
        listed,
        deadLetterTarget([deadLetter({ deadLetteredAt: 1_700_000_999_000 })], 'op_a'),
      ),
    ).toBe(false);
    expect(
      sameDeadLetter(listed, deadLetterTarget([deadLetter({ queue: 'billing' })], 'op_a')),
    ).toBe(false);
  });
});
