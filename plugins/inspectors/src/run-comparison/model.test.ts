import { describe, expect, it } from 'bun:test';

import {
  buildComparisonModel,
  isComparison,
  resultMessage,
  stepDetail,
  type Comparison,
} from './model.ts';

const side = (overrides: Record<string, string | undefined> = {}) => ({
  operationType: 'activity',
  label: 'issueTicket',
  status: 'completed',
  input: '{"order":"ord_1"}',
  output: '{"ticket":1}',
  ...overrides,
});

const comparison: Comparison = {
  runId: 'fork-1',
  sourceRunId: 'source-1',
  forkPoint: 2,
  steps: [
    {
      index: 0,
      shared: true,
      source: side({ label: 'reserveStock' }),
      fork: side({ label: 'reserveStock' }),
    },
    { index: 1, shared: false, source: side(), fork: side({ output: '{"ticket":2}' }) },
    { index: 2, shared: false, source: side({ label: 'notify' }), fork: side({ label: 'notify' }) },
    { index: 3, shared: false, source: side({ label: 'archive' }) },
  ],
};

describe('isComparison', () => {
  it('accepts what bureau.runs.compare answers', () => {
    expect(isComparison(comparison)).toBe(true);
    expect(isComparison({ ...comparison, nextCursor: 'step:3' })).toBe(true);
  });

  it('refuses a value that is not one', () => {
    expect(isComparison(undefined)).toBe(false);
    expect(isComparison({ ...comparison, steps: 'none' })).toBe(false);
    expect(isComparison({ ...comparison, forkPoint: '2' })).toBe(false);
    expect(
      isComparison({ ...comparison, steps: [{ index: 0, shared: true, source: { label: 'x' } }] }),
    ).toBe(false);
  });
});

describe('resultMessage', () => {
  it('reads the text blocks of an error result as the server’s message', () => {
    expect(
      resultMessage({
        content: [
          { type: 'text', text: 'Run r is not a fork.' },
          { type: 'image', data: 'x' },
          { type: 'text', text: 'Fork a run first.' },
        ],
      }),
    ).toBe('Run r is not a fork.\nFork a run first.');
  });

  it('reads the message of a Bureau fault from its structured content, not its JSON text', () => {
    const fault = {
      code: 'Unprocessable',
      message: 'Run run-1 is not a fork, so there is no source to compare it with.',
      data: { reason: 'not-a-fork' },
      retryable: false,
    };
    expect(
      resultMessage({
        structuredContent: fault,
        content: [{ type: 'text', text: JSON.stringify(fault) }],
      }),
    ).toBe('Run run-1 is not a fork, so there is no source to compare it with.');
  });

  it('has no message when the result carries no text', () => {
    expect(resultMessage({})).toBeUndefined();
    expect(resultMessage({ content: [] })).toBeUndefined();
  });
});

describe('buildComparisonModel', () => {
  it('separates the steps the fork kept from the steps it ran again, and says what each is', () => {
    const model = buildComparisonModel(comparison);

    // No run id in the title: the panel is on the fork's page and says "the source run".
    expect(model.title).toBe('Compared with the source run');
    expect(model.title).not.toContain('fork-1');
    expect(model.title).not.toContain('source-1');
    expect(model.intro).toContain('checkpoint step 2');
    expect(model.shared.map((row) => row.title)).toEqual(['Step 1, reserveStock']);
    expect(model.ranAgain.map((row) => [row.title, row.kind, row.differs])).toEqual([
      ['Step 2, issueTicket', 'changed', 'Differs in output'],
      ['Step 3, notify', 'unchanged', undefined],
      ['Step 4, archive', 'source-only', undefined],
    ]);
  });
});

describe('stepDetail', () => {
  it('reads the output difference of a changed step as two JSON values, and the same input as a note', () => {
    const detail = stepDetail(comparison.steps[1]!);

    expect(detail.heading).toBe('Step 2 differences');
    expect(detail.notes).toEqual([]);
    expect(detail.payloads).toEqual([
      { heading: 'Input', kind: 'note', note: 'The input is the same in both runs.' },
      { heading: 'Output', kind: 'diff', before: { ticket: 1 }, after: { ticket: 2 } },
    ]);
  });

  it('keeps text that is not JSON as the text it is', () => {
    const detail = stepDetail({
      index: 1,
      shared: false,
      source: side({ input: 'undefined' }),
      fork: side({ input: '[Redacted]' }),
    });
    expect(detail.payloads[0]).toEqual({
      heading: 'Input',
      kind: 'diff',
      before: 'undefined',
      after: '[Redacted]',
    });
  });

  it('says which run lacks an output, and notes a changed status', () => {
    const { output: _output, ...running } = side();
    const detail = stepDetail({
      index: 1,
      shared: false,
      source: side(),
      fork: { ...running, status: 'running' },
    });
    expect(detail.notes).toEqual(['completed in the source, running in the fork']);
    expect(detail.payloads[1]).toEqual({
      heading: 'Output',
      kind: 'note',
      note: 'The fork has not recorded an output for this step.',
    });
  });

  it('says which run has not reached a step only one run has', () => {
    expect(stepDetail(comparison.steps[3]!).notes).toEqual(['The fork has not reached this step.']);
    expect(stepDetail({ index: 4, shared: false, fork: side() }).notes).toEqual([
      'The source never reached this step.',
    ]);
    expect(stepDetail(comparison.steps[3]!).payloads).toEqual([]);
  });
});
