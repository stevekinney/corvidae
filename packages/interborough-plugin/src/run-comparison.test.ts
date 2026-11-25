import { describe, expect, test } from 'bun:test';

import {
  classifyComparedStep,
  differingFields,
  parseSummary,
  type ComparedSide,
  type ComparedStep,
} from './run-comparison.ts';

function side(overrides: Partial<ComparedSide> = {}): ComparedSide {
  return {
    operationType: 'activity',
    label: 'issueTicket',
    status: 'completed',
    input: '{"order":"ord_1"}',
    output: '{"ticket":1}',
    ...overrides,
  };
}

describe('classifyComparedStep', () => {
  test('a step before the fork point is shared, whatever its sides hold', () => {
    const step: ComparedStep = { index: 0, shared: true, source: side(), fork: side() };
    expect(classifyComparedStep(step)).toBe('shared');
  });

  test('two entries that differ in output are a changed step', () => {
    const step: ComparedStep = {
      index: 2,
      shared: false,
      source: side(),
      fork: side({ output: '{"ticket":2}' }),
    };
    expect(classifyComparedStep(step)).toBe('changed');
  });

  test('two identical entries are an unchanged step', () => {
    expect(classifyComparedStep({ index: 2, shared: false, source: side(), fork: side() })).toBe(
      'unchanged',
    );
  });

  test('a side that is missing makes the step belong to the other run', () => {
    expect(classifyComparedStep({ index: 3, shared: false, source: side() })).toBe('source-only');
    expect(classifyComparedStep({ index: 3, shared: false, fork: side() })).toBe('fork-only');
  });

  test('an output the fork has not recorded yet is a difference', () => {
    const fork = side();
    const { output: _output, ...running } = fork;
    expect(
      classifyComparedStep({
        index: 1,
        shared: false,
        source: side(),
        fork: { ...running, status: 'running' },
      }),
    ).toBe('changed');
  });
});

describe('differingFields', () => {
  test('names every field that differs, in reading order', () => {
    expect(
      differingFields(
        side(),
        side({ label: 'other', status: 'failed', input: '{}', output: '"boom"' }),
      ),
    ).toEqual(['label', 'status', 'input', 'output']);
  });

  test('names nothing for equal entries', () => {
    expect(differingFields(side(), side())).toEqual([]);
  });
});

describe('parseSummary', () => {
  test('reads JSON text as the value it holds', () => {
    expect(parseSummary('{"a":[1,2]}')).toEqual({ a: [1, 2] });
    expect(parseSummary('"text"')).toBe('text');
    expect(parseSummary('null')).toBeNull();
  });

  test('returns text that is not JSON as it is, instead of refusing it', () => {
    expect(parseSummary('undefined')).toBe('undefined');
    expect(parseSummary('[Object]')).toBe('[Object]');
    expect(parseSummary('')).toBe('');
  });
});
