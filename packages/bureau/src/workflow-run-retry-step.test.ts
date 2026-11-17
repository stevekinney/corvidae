/**
 * COR-2424 — which step a failed instance failed at, read from the engine's timeline, and which
 * steps can run again in place.
 */
import { describe, expect, it } from 'bun:test';

import type { WorkflowTimelineEntry } from '@lostgradient/weft';

import { canonicalStepCount, failedStepIndexOf, isRetryableStep } from './workflow-run-retry';

function entry(
  documentStep: number | undefined,
  status: WorkflowTimelineEntry['status'],
): WorkflowTimelineEntry {
  return {
    step: 0,
    ...(documentStep === undefined ? {} : { documentStep }),
    operationType: 'activity',
    operationLabel: 'agent',
    inputSummary: '',
    timestamp: 0,
    status,
  };
}

describe('the step a failed instance failed at', () => {
  it('is the step of the last entry that failed', () => {
    expect(failedStepIndexOf([entry(0, 'completed'), entry(1, 'failed'), entry(1, 'failed')])).toBe(
      1,
    );
  });

  it('is no step for a try that failed and was then tried again and completed', () => {
    expect(failedStepIndexOf([entry(0, 'failed'), entry(0, 'completed')])).toBeUndefined();
    expect(failedStepIndexOf([])).toBeUndefined();
    expect(failedStepIndexOf([entry(undefined, 'failed')])).toBeUndefined();
  });
});

describe('which steps can run again', () => {
  const steps = [
    { kind: 'activity', handler: 'agent' },
    { kind: 'workflow', workflow: 'linear:sync' },
    { kind: 'parallel', branches: { a: [{ kind: 'activity', handler: 'agent' }] } },
    {
      kind: 'map',
      over: 'items',
      concurrency: 1,
      steps: [{ kind: 'activity', handler: 'agent' }],
    },
    { kind: 'map', over: 'items', steps: [{ kind: 'activity', handler: 'agent' }] },
    {
      kind: 'map',
      over: 'items',
      concurrency: 2,
      steps: [{ kind: 'activity', handler: 'agent' }],
    },
  ];

  it('is an activity step outside a parallel step, in a map that runs one item at a time', () => {
    expect(canonicalStepCount(steps)).toBe(10);
    expect(isRetryableStep(steps, 0)).toBe(true);
    expect(isRetryableStep(steps, 1)).toBe(false);
    expect(isRetryableStep(steps, 3)).toBe(false);
    expect(isRetryableStep(steps, 5)).toBe(true);
    expect(isRetryableStep(steps, 99)).toBe(false);
  });

  it('is not a step in a map that runs items together, whose completed items a retry would run again', () => {
    // The default concurrency is more than one, and so is 2.
    expect(isRetryableStep(steps, 7)).toBe(false);
    expect(isRetryableStep(steps, 9)).toBe(false);
  });
});
