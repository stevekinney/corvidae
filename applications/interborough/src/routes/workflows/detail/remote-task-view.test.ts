/** Tests for the pure mapping behind the remote-activity panel (COR-274). */
import { describe, expect, test } from 'bun:test';

import type { TaskLedgerDetail } from '../../workers/worker-catalog-types.ts';
import { REMOTE_TASK_STATE_LABELS, remoteTaskFields, remoteTaskState } from './remote-task-view.ts';

const NOW = 1_700_000_000_000;

function task(overrides: Partial<TaskLedgerDetail> = {}): TaskLedgerDetail {
  return {
    state: 'queued',
    operationId: 'as:wf-1:2:1',
    workflowId: 'wf-1',
    workflowExecutionToken: 'token-1',
    workflowType: 'orders',
    activityName: 'chargeCard',
    queue: 'payments',
    headerKeys: ['traceparent', 'x-tenant'],
    visibilityTimeoutMilliseconds: 30_000,
    scheduleToCloseDeadline: NOW + 120_000,
    retryPolicy: { maxAttempts: 3, initialBackoff: '1s', backoffMultiplier: 2, maxBackoff: '1m' },
    createdAt: NOW - 1_000,
    attempt: 2,
    attempts: [],
    ...overrides,
  };
}

function value(fields: ReturnType<typeof remoteTaskFields>, term: string): string | undefined {
  return fields.find((field) => field.term === term)?.value;
}

describe('remoteTaskState', () => {
  test('every ledger state reads as its own explicit label', () => {
    const labels = [
      remoteTaskState(task({ state: 'queued' })).label,
      remoteTaskState(task({ state: 'leased' })).label,
      remoteTaskState(task({ state: 'completing' })).label,
      remoteTaskState(task({ state: 'cancelling' })).label,
      remoteTaskState(task({ state: 'deadLettered' })).label,
      remoteTaskState(task({ state: 'terminal', disposition: 'resolved' })).label,
      remoteTaskState(task({ state: 'terminal', disposition: 'cancelled' })).label,
      remoteTaskState(task({ state: 'terminal', disposition: 'retryExhausted' })).label,
    ];

    expect(new Set(labels).size).toBe(8);
    expect(labels).toEqual([
      REMOTE_TASK_STATE_LABELS.queued,
      REMOTE_TASK_STATE_LABELS.leased,
      REMOTE_TASK_STATE_LABELS.completing,
      REMOTE_TASK_STATE_LABELS.cancelling,
      REMOTE_TASK_STATE_LABELS.deadLettered,
      REMOTE_TASK_STATE_LABELS.resolved,
      REMOTE_TASK_STATE_LABELS.cancelled,
      REMOTE_TASK_STATE_LABELS.retryExhausted,
    ]);
  });

  test('no label presents a remote task as having run locally', () => {
    for (const label of Object.values(REMOTE_TASK_STATE_LABELS)) {
      expect(label).not.toMatch(/local|in-process|inline/i);
    }
  });

  test('a terminal record with no known disposition says so, and is not coerced into resolved', () => {
    const state = remoteTaskState(task({ state: 'terminal' }));

    expect(state.label).toBe(REMOTE_TASK_STATE_LABELS.terminalUnknown);
    expect(state.label).not.toBe(REMOTE_TASK_STATE_LABELS.resolved);
  });

  test('failures read as danger, a resolved record as success, anything in flight as a warning', () => {
    expect(remoteTaskState(task({ state: 'deadLettered' })).variant).toBe('danger');
    expect(
      remoteTaskState(task({ state: 'terminal', disposition: 'retryExhausted' })).variant,
    ).toBe('danger');
    expect(remoteTaskState(task({ state: 'terminal', disposition: 'resolved' })).variant).toBe(
      'success',
    );
    expect(remoteTaskState(task({ state: 'leased' })).variant).toBe('warning');
  });
});

describe('remoteTaskFields', () => {
  test('shows queue, attempt, retry policy, timeouts, header keys, and execution token from the record', () => {
    const fields = remoteTaskFields(task(), NOW);

    expect(value(fields, 'Queue')).toBe('payments');
    expect(value(fields, 'Attempt')).toBe('2 of 3');
    expect(value(fields, 'Retry policy')).toBe('Up to 3 attempts, backoff 1s × 2, at most 1m');
    expect(value(fields, 'Visibility timeout')).toBe('30s');
    expect(value(fields, 'Schedule-to-close deadline')).toContain('in 2m');
    expect(value(fields, 'Header keys')).toBe('traceparent, x-tenant');
    expect(value(fields, 'Execution token')).toBe('token-1');
  });

  test('says so, in words, when there is no retry policy, deadline, header, or token', () => {
    const {
      retryPolicy: _retry,
      scheduleToCloseDeadline: _deadline,
      workflowExecutionToken: _token,
      ...bare
    } = task();
    const fields = remoteTaskFields({ ...bare, headerKeys: [] }, NOW);

    expect(value(fields, 'Attempt')).toBe('2');
    expect(value(fields, 'Retry policy')).toBe('No retry policy');
    expect(value(fields, 'Schedule-to-close deadline')).toBe('None');
    expect(value(fields, 'Header keys')).toBe('None');
    expect(value(fields, 'Execution token')).toBe('Not supplied');
  });
});
