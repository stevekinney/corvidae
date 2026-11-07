import { describe, expect, test } from 'bun:test';

import { queueTaskRows } from './queue-task-rows.ts';
import type { QueueTask } from './queue-tasks-data.ts';

const NOW = Date.UTC(2026, 10, 2, 15, 0);

function task(overrides: Partial<QueueTask> = {}): QueueTask {
  return {
    operationId: 'op-1',
    status: 'failed',
    workflowId: 'run-1',
    workflowType: 'release-notes',
    activityName: 'collect-merged-changes',
    attempt: 5,
    at: Date.UTC(2026, 9, 30, 20, 0),
    error: 'GitHub didn’t answer (HTTP 503)',
    ...overrides,
  };
}

/** `value` without `key`, which a `Partial` cannot say under `exactOptionalPropertyTypes`. */
function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _omitted, ...rest } = value;
  return rest;
}

describe('queueTaskRows', () => {
  test('a failed task says how many tries it took and why, and the day it failed', () => {
    const [row] = queueTaskRows([task()], 'reports', new Set(), NOW);
    expect(row).toMatchObject({
      id: 'op-1',
      word: 'Failed for good',
      name: 'collect-merged-changes',
      line: 'Failed after 5 tries · GitHub didn’t answer (HTTP 503).',
      time: 'Oct 30',
      failed: true,
      run: { id: 'run-1', label: 'Release notes run' },
    });
  });

  test('a cause that already ends in a full stop is not given a second', () => {
    const [row] = queueTaskRows(
      [task({ attempt: 1, error: 'The Slack channel #releases no longer exists.' })],
      'reports',
      new Set(),
      NOW,
    );
    expect(row?.line).toBe('Failed after 1 try · The Slack channel #releases no longer exists.');
  });

  test('a failed task with no recorded cause says its result could not be saved', () => {
    const [row] = queueTaskRows([without(task(), 'error')], 'reports', new Set(), NOW);
    expect(row?.line).toBe('Failed after 5 tries · Its result could not be saved.');
  });

  test('a waiting task says what it waits for and when it queued', () => {
    const [row] = queueTaskRows(
      [task({ status: 'waiting', attempt: 1, activityName: 'render-digest', at: NOW - 3_600_000 })],
      'reports',
      new Set(),
      NOW,
    );
    expect(row).toMatchObject({
      word: 'Waiting',
      name: 'render-digest',
      line: 'On the reports queue · waiting for a reports worker',
      failed: false,
    });
    expect(row?.time).toMatch(/^\d{1,2}:\d{2} [AP]M$/u);
  });

  test('a task put back reads as waiting on its next try, with the day it failed at the right', () => {
    const [row] = queueTaskRows([task()], 'reports', new Set(['op-1']), NOW);
    expect(row).toMatchObject({
      word: 'Waiting',
      line: 'Back on the queue · try 6',
      time: 'Oct 30',
      failed: false,
    });
  });

  test('a waiting task on a later try says it is back, and which try', () => {
    const [row] = queueTaskRows(
      [task({ status: 'waiting', attempt: 6 })],
      'reports',
      new Set(),
      NOW,
    );
    expect(row?.line).toBe('Back on the queue · try 6');
  });

  test('a task that names no run has no run link', () => {
    const [row] = queueTaskRows([without(task(), 'workflowId')], 'reports', new Set(), NOW);
    expect(row?.run).toBeUndefined();
  });
});
