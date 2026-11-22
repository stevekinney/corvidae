import { describe, expect, it } from 'bun:test';

import {
  buildExplanationModel,
  failureCategoryLabel,
  failureCategoryTone,
  refusalSentence,
  type Explanation,
} from './failure-explanation.ts';

const explanation: Explanation = {
  summary: 'The step "charge-card" failed because the code it ran raised an error.',
  cause: { category: 'application', code: 'CARD_DECLINED', kind: 'tool' },
  step: { index: 1, label: 'charge-card' },
  tries: 3,
  verdicts: [
    { name: 'sentinel-card', kind: 'tripwire', outcome: 'tripwire', step: 1 },
    { name: 'pii', kind: 'guardrail', outcome: 'redact', step: null },
  ],
  remediation: 'Fix the input, then start the run again.',
  nextCommands: [],
};

describe('the words of a run’s explanation (COR-2543)', () => {
  it('names each part, with the Bureau’s sentence first and the step by its label alone', () => {
    expect(buildExplanationModel(explanation)).toEqual({
      summary: explanation.summary,
      category: 'application',
      causeDetail: 'code CARD_DECLINED',
      step: 'charge-card',
      tries: '3',
      verdicts: ['sentinel-card stopped the run', 'pii redacted the step'],
      remediation: explanation.remediation,
    });
  });

  it('shows a code only when it names something a person can act on, and never the error’s kind', () => {
    const detail = (code: string | null) =>
      buildExplanationModel({
        ...explanation,
        cause: { category: 'application', code, kind: 'tool' },
      }).causeDetail;
    expect(detail('UNKNOWN')).toBe('');
    expect(detail(null)).toBe('');
    expect(detail('ECONNRESET')).toBe('code ECONNRESET');
  });

  it('leaves out what is not stored, and says a failure nothing classifies is uncategorized', () => {
    const model = buildExplanationModel({
      ...explanation,
      cause: { category: null, code: null, kind: null },
      step: null,
      tries: null,
      verdicts: [],
    });
    expect(model).toMatchObject({ category: null, step: null, tries: null, verdicts: [] });
    expect(failureCategoryLabel(model.category)).toBe('uncategorized');
    expect(failureCategoryLabel(undefined)).toBe('');
  });

  it('words every guardrail outcome the Bureau answers, with no step number', () => {
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
      'tripwire stopped the run',
      'block blocked the step',
      'warn warned',
      'sanitize sanitized the step',
      'redact redacted the step',
    ]);
  });

  it('draws a cancellation quietly, a limit as a warning, and a fault as danger', () => {
    expect(failureCategoryTone('cancellation')).toBe('neutral');
    expect(failureCategoryTone('timeout')).toBe('warning');
    expect(failureCategoryTone('resource')).toBe('warning');
    for (const category of ['application', 'system', null, undefined]) {
      expect(failureCategoryTone(category)).toBe('danger');
    }
  });

  it('words a run that did not fail itself, and leaves any other refusal to the Bureau', () => {
    const message = 'This run has not failed, so there is no failure to explain';
    const sentence = refusalSentence({ reason: 'run-not-failed', message, remediation: null });
    expect(sentence).toBe('This run didn’t fail, so there’s nothing to explain.');
    // No run identifier, no quoted status.
    expect(sentence).not.toMatch(/["“”]|run-\d/);
    expect(refusalSentence({ reason: null, message: 'Not found', remediation: null })).toBe(
      'Not found',
    );
    expect(refusalSentence({ reason: 'other', message: 'Refused', remediation: 'Wait.' })).toBe(
      'Refused',
    );
  });
});
