import type { WorkflowTimelineEntry } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { humanizeStepName, prettySummary, stepName, stepStatus } from './step-presentation.ts';

function entry(overrides: Partial<WorkflowTimelineEntry>): WorkflowTimelineEntry {
  return {
    step: 0,
    operationType: 'activity',
    operationLabel: 'chargeCard',
    inputSummary: '{}',
    timestamp: 1_000,
    status: 'completed',
    ...overrides,
  };
}

describe('humanizeStepName', () => {
  test('says a camel-case, snake-case or kebab-case name as words', () => {
    expect(humanizeStepName('chargeCard')).toBe('Charge card');
    expect(humanizeStepName('send_receipt')).toBe('Send receipt');
    expect(humanizeStepName('validate-shipment')).toBe('Validate shipment');
  });

  test('leaves a phrase as it is, and a name with no words alone', () => {
    expect(humanizeStepName('Wait for the warehouse')).toBe('Wait for the warehouse');
    expect(humanizeStepName('___')).toBe('___');
  });
});

describe('stepName', () => {
  test('names an activity in words and keeps its raw name beside it', () => {
    expect(stepName(entry({}))).toEqual({ readable: 'Charge card', raw: 'chargeCard' });
  });

  test('names a structural step by its kind', () => {
    expect(stepName(entry({ operationType: 'wait-signal', operationLabel: 'approve' }))).toEqual({
      readable: 'Signal: approve',
      raw: 'approve',
    });
  });

  test('names a saga’s undo for the step it undoes, keeping the raw name beside it', () => {
    expect(stepName(entry({ operationLabel: 'compensate:reserveHotel' }))).toEqual({
      readable: 'Undo reserve hotel',
      raw: 'compensate:reserveHotel',
    });
  });

  test('drops the raw name when it is the words', () => {
    expect(stepName(entry({ operationLabel: 'Settle' })).raw).toBeUndefined();
  });
});

describe('stepStatus', () => {
  test('gives every status a word and a dot', () => {
    expect(stepStatus('completed')).toEqual({ label: 'Succeeded', dot: 'success' });
    expect(stepStatus('running').label).toBe('Running');
    expect(stepStatus('timed-out').dot).toBe('danger');
  });
});

describe('prettySummary', () => {
  test('indents a JSON object and leaves other text as it was kept', () => {
    expect(prettySummary('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettySummary('boom')).toBe('boom');
    expect(prettySummary('42')).toBe('42');
  });
});
