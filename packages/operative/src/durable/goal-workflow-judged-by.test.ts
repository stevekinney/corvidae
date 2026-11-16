/**
 * COR-2112 — the verdict the workflow commits carries what judged it, exactly as the validator
 * activity returned it, so the record names the validator that ran and not whatever the goal names
 * when the verdict is written.
 */
import { describe, expect, it } from 'bun:test';

import {
  decideCancellation,
  type ProjectedValidatorResult,
  type ValidatorJudge,
} from '../goal-decision';
import { identifiers } from './goal-workflow-fixtures';
import { buildValidationDecision } from './goal-workflow-transitions';

const NOW = Date.parse('2026-10-02T01:00:00.000Z');

const view = {
  goalRunId: 'goal-1',
  status: 'evaluating',
  transitionSeq: 2,
  bounds: { maximumAttempts: 3, maximumTotalTokens: 10 },
  attempts: [
    {
      attemptId: 'goal-1:a0',
      attemptIndex: 0,
      runId: 'goal-goal-1-a0',
      sessionId: 'session-0',
      startedAt: '2026-10-02T00:59:00.000Z',
      usage: { steps: 0, tokens: 0 },
      status: 'evaluating',
    },
  ],
  usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
  active: {
    kind: 'validation',
    attemptId: 'goal-1:a0',
    validator: { name: 'goal-validator', version: '2' },
    startedAt: '2026-10-02T00:59:50.000Z',
  },
  createdAt: '2026-10-02T00:59:00.000Z',
} as never;

const JUDGE: ValidatorJudge = {
  validator: { name: 'ran', version: '1' },
  source: { kind: 'plugin', name: 'checks', version: '2.3.4' },
  configuration: null,
};

const result = (judgedBy?: ValidatorJudge): ProjectedValidatorResult => ({
  identity: { name: 'ran', version: '1' },
  startedAt: '2026-10-02T00:59:50.000Z',
  completedAt: '2026-10-02T00:59:59.000Z',
  outcome: { kind: 'pass', evidence: [] },
  ...(judgedBy === undefined ? {} : { judgedBy }),
});

const decision = decideCancellation();

describe('the validation a transition records', () => {
  it('carries the judge the validator activity returned', () => {
    const transition = buildValidationDecision(
      view,
      identifiers,
      NOW,
      (view as { attempts: never[] }).attempts[0]!,
      result(JUDGE),
      decision,
    );
    expect(transition.attempt?.validation?.judgedBy).toEqual(JUDGE);
  });

  it('records none for a verdict that came back without one', () => {
    const transition = buildValidationDecision(
      view,
      identifiers,
      NOW,
      (view as { attempts: never[] }).attempts[0]!,
      result(),
      decision,
    );
    expect(transition.attempt?.validation).toBeDefined();
    expect(Object.hasOwn(transition.attempt?.validation ?? {}, 'judgedBy')).toBe(false);
  });
});
