/**
 * The dead-letter guard: a clear is confirmed against the dead letter as the diagnostics listed it
 * when the dialog opened, so one that was cleared, or recorded again, meanwhile is refused.
 */
import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft';

import {
  deadLetterTarget,
  deadLetterTargetFromDetail,
  retryRefusalMessage,
  sameDeadLetter,
} from './dead-letter-guard.ts';
import type {
  StandardTaskDiagnosticItem,
  TaskAttemptRecord,
  TaskDiagnosticItem,
  TaskLedgerDetail,
} from './worker-catalog-types.ts';

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
      attemptTokenDigest: undefined,
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

function attempt(overrides: Partial<TaskAttemptRecord> = {}): TaskAttemptRecord {
  return {
    attempt: 1,
    attemptTokenDigest: 'sha256:t1',
    claimedAt: 1_699_999_000_000,
    disposition: 'requeued',
    dispositionAt: 1_699_999_500_000,
    ...overrides,
  };
}

function detail(overrides: Partial<TaskLedgerDetail> = {}): TaskLedgerDetail {
  return {
    state: 'deadLettered',
    operationId: 'op_a',
    workflowType: 'orders',
    activityName: 'ChargeCard',
    queue: 'payments',
    headerKeys: [],
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_699_000_000_000,
    attempt: 2,
    attempts: [
      attempt(),
      attempt({ attempt: 2, attemptTokenDigest: 'sha256:t2', disposition: 'deadLettered' }),
    ],
    deadLetteredAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('deadLetterTargetFromDetail', () => {
  test('names the dead letter from the task ledger, with the digest of the dead-lettered attempt', () => {
    expect(deadLetterTargetFromDetail(detail())).toEqual({
      operationId: 'op_a',
      queue: 'payments',
      activityName: 'ChargeCard',
      deadLetteredAt: 1_700_000_000_000,
      attemptTokenDigest: 'sha256:t2',
    });
  });

  test('takes the digest of the current attempt, not of an earlier one that also ended badly', () => {
    const target = deadLetterTargetFromDetail(
      detail({
        attempt: 3,
        attempts: [
          attempt({ attempt: 2, attemptTokenDigest: 'sha256:t2', disposition: 'deadLettered' }),
          attempt({ attempt: 3, attemptTokenDigest: 'sha256:t3', disposition: 'deadLettered' }),
        ],
      }),
    );
    expect(target?.attemptTokenDigest).toBe('sha256:t3');
  });

  test('leaves the digest out when the history does not hold the dead-lettered attempt', () => {
    expect(
      deadLetterTargetFromDetail(detail({ attempts: [] }))?.attemptTokenDigest,
    ).toBeUndefined();
  });

  test('names nothing for a task that is not dead-lettered', () => {
    expect(deadLetterTargetFromDetail(detail({ state: 'queued' }))).toBeNull();
  });

  test('is the same dead letter only while the attempt that was dead-lettered is the same one', () => {
    const observed = deadLetterTargetFromDetail(detail());
    expect(sameDeadLetter(observed, deadLetterTargetFromDetail(detail()))).toBe(true);
    expect(
      sameDeadLetter(
        observed,
        deadLetterTargetFromDetail(
          detail({
            attempts: [
              attempt({
                attempt: 2,
                attemptTokenDigest: 'sha256:other',
                disposition: 'deadLettered',
              }),
            ],
          }),
        ),
      ),
    ).toBe(false);
  });
});

function conflict(reason: string): HttpClientError {
  return new HttpClientError(409, 'conflict', { faultCode: 'Conflict', data: { reason } });
}

describe('retryRefusalMessage', () => {
  test('says why the server refused a retry, by the reason it gave', () => {
    expect(retryRefusalMessage(conflict('not-dead-lettered'))).toMatch(/no longer a dead letter/);
    expect(retryRefusalMessage(conflict('dead-letter-changed'))).toMatch(/dead-lettered again/);
    expect(retryRefusalMessage(conflict('workflow-finished'))).toMatch(/workflow .* finished/);
    expect(retryRefusalMessage(conflict('concurrent-change'))).toMatch(/at the same time/);
  });

  test('every refusal says nothing was retried', () => {
    for (const reason of ['not-dead-lettered', 'dead-letter-changed', 'workflow-finished', 'x']) {
      expect(retryRefusalMessage(conflict(reason))).toMatch(/nothing was retried/);
    }
  });

  test('a task the server no longer holds, a lost scope, and any other fault each read differently', () => {
    const notFound = new HttpClientError(404, 'gone', { faultCode: 'NotFound' });
    const forbidden = new HttpClientError(403, 'no', { faultCode: 'Forbidden' });
    const broken = new HttpClientError(500, 'boom');
    expect(retryRefusalMessage(notFound)).toMatch(/no longer holds/);
    expect(retryRefusalMessage(forbidden)).toMatch(/system:admin/);
    expect(retryRefusalMessage(broken)).toMatch(/boom/);
    expect(retryRefusalMessage(new Error('x'))).toMatch(/nothing was retried/);
  });
});
