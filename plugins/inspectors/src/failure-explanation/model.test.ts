import { describe, expect, it } from 'bun:test';

import {
  buildExplanationModel,
  isExplanation,
  refusalOf,
  runIdOf,
  type Explanation,
} from './model.ts';

const explanation: Explanation = {
  summary: 'The step "charge-card" failed because the code it ran raised an error.',
  cause: { category: 'application', code: 'UNKNOWN', kind: 'tool' },
  step: { index: 1, label: 'charge-card' },
  tries: 3,
  verdicts: [
    { name: 'sentinel-card', kind: 'tripwire', outcome: 'tripwire', step: 1 },
    { name: 'pii', kind: 'guardrail', outcome: 'redact', step: null },
  ],
  remediation: 'Read the run’s failure message, then start the run again.',
  nextCommands: ['interborough runs get --kind task run-1'],
};

describe('what the explain read answers (COR-2543)', () => {
  it('is recognised by its shape, and by nothing looser', () => {
    expect(isExplanation(explanation)).toBe(true);
    expect(
      isExplanation({
        ...explanation,
        cause: { category: null, code: null, kind: null },
        step: null,
        tries: null,
        verdicts: [],
      }),
    ).toBe(true);
    for (const wrong of [
      null,
      'a sentence',
      {},
      { ...explanation, summary: 7 },
      { ...explanation, cause: null },
      { ...explanation, cause: { category: 3, code: null, kind: null } },
      { ...explanation, step: { index: 'one', label: 'x' } },
      { ...explanation, tries: 1.5 },
      { ...explanation, verdicts: [{ name: 'x', kind: 'other', outcome: 'warn', step: null }] },
      { ...explanation, verdicts: [{ name: 'x', kind: 'guardrail', outcome: 'maybe', step: 0 }] },
      { ...explanation, remediation: null },
      { ...explanation, nextCommands: 'interborough runs get' },
    ]) {
      expect(isExplanation(wrong)).toBe(false);
    }
  });

  it('names each part: the sentence, the cause, the step, the tries, the guardrails and the remediation', () => {
    expect(buildExplanationModel(explanation)).toEqual({
      summary: explanation.summary,
      category: 'application',
      causeDetail: 'code UNKNOWN, kind tool',
      step: 'charge-card (step 2)',
      tries: '3',
      verdicts: ['sentinel-card stopped the run at step 2', 'pii redacted the step'],
      remediation: explanation.remediation,
    });
  });

  it('says what a failure that nothing classifies is, and leaves out what is not stored', () => {
    expect(
      buildExplanationModel({
        ...explanation,
        cause: { category: null, code: null, kind: null },
        step: null,
        tries: null,
        verdicts: [],
      }),
    ).toMatchObject({
      category: 'not classified',
      causeDetail: '',
      step: null,
      tries: null,
      verdicts: [],
    });
    expect(
      buildExplanationModel({
        ...explanation,
        cause: { category: 'timeout', code: 'X', kind: null },
      }).causeDetail,
    ).toBe('code X');
  });

  it('words every guardrail outcome the Bureau answers', () => {
    const outcomes = ['tripwire', 'block', 'warn', 'sanitize', 'redact'] as const;
    const lines = buildExplanationModel({
      ...explanation,
      verdicts: outcomes.map((outcome) => ({
        name: outcome,
        kind: outcome === 'tripwire' ? ('tripwire' as const) : ('guardrail' as const),
        outcome,
        step: 0,
      })),
    }).verdicts;
    expect(lines).toEqual([
      'tripwire stopped the run at step 1',
      'block blocked the step at step 1',
      'warn warned at step 1',
      'sanitize sanitized the step at step 1',
      'redact redacted the step at step 1',
    ]);
  });
});

describe('the Bureau’s refusal to explain a run (COR-2543)', () => {
  it('reads the message and the remediation from the fault’s structured content', () => {
    expect(
      refusalOf({
        isError: true,
        structuredContent: {
          code: 'Unprocessable',
          message:
            'Run "run-1" has not failed (its status is "completed"), so there is no failure to explain',
          data: { reason: 'run-not-failed' },
          retryable: false,
          remediation: 'Explain a run only after it has failed.',
        },
      }),
    ).toEqual({
      message:
        'Run "run-1" has not failed (its status is "completed"), so there is no failure to explain',
      remediation: 'Explain a run only after it has failed.',
    });
  });

  it('has no remediation when the fault sent none, and falls back to the text of the result', () => {
    expect(refusalOf({ isError: true, structuredContent: { message: 'Not found' } })).toEqual({
      message: 'Not found',
      remediation: null,
    });
    expect(
      refusalOf({ isError: true, content: [{ type: 'text', text: 'the host refused' }] }),
    ).toEqual({ message: 'the host refused', remediation: null });
  });

  it('is nothing for a result that is not an error, or an error with nothing to read', () => {
    expect(refusalOf({ structuredContent: { message: 'fine' } })).toBeUndefined();
    expect(refusalOf({ isError: true })).toBeUndefined();
    expect(refusalOf({ isError: true, content: [{ type: 'image' }] })).toBeUndefined();
    expect(refusalOf({ isError: true, structuredContent: { message: '' } })).toBeUndefined();
  });
});

describe('the run a page was opened for (COR-2543)', () => {
  it('is the explain tool’s runId, or the taskId a run’s page passes', () => {
    expect(runIdOf({ runId: 'run-1' })).toBe('run-1');
    expect(runIdOf({ taskId: 'task-1' })).toBe('task-1');
    expect(runIdOf({ runId: 'run-1', taskId: 'task-1' })).toBe('run-1');
  });

  it('is nothing for an opening that names none', () => {
    expect(runIdOf(undefined)).toBeUndefined();
    expect(runIdOf({})).toBeUndefined();
    expect(runIdOf({ runId: '' })).toBeUndefined();
    expect(runIdOf({ runId: 7 })).toBeUndefined();
  });
});
