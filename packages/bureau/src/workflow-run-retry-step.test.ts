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
    { kind: 'map', over: 'items', steps: [{ kind: 'activity', handler: 'agent' }] },
  ];

  it('is an activity step outside a parallel step, a map’s included', () => {
    expect(canonicalStepCount(steps)).toBe(6);
    expect(isRetryableStep(steps, 0)).toBe(true);
    expect(isRetryableStep(steps, 1)).toBe(false);
    expect(isRetryableStep(steps, 3)).toBe(false);
    expect(isRetryableStep(steps, 5)).toBe(true);
    expect(isRetryableStep(steps, 9)).toBe(false);
  });
});
