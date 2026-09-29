import { describe, expect, test } from 'bun:test';

import fixtureGate from '../gates/fixture-regression.json';
import { EvaluatorConfigurationError } from './configuration';
import {
  gateDecisionRecordSchema,
  gateIdSchema,
  gateOverrideRecordSchema,
  parseGateDefinition,
} from './gate';

function gateInput(): Record<string, unknown> {
  return structuredClone(fixtureGate);
}

function issuePaths(input: unknown): string[] {
  try {
    parseGateDefinition(input);
  } catch (error) {
    expect(error).toBeInstanceOf(EvaluatorConfigurationError);
    return (error as EvaluatorConfigurationError).issues.map((issue) => issue.path.join('.'));
  }
  throw new Error('Expected the gate to be rejected');
}

function overrideInput(): Record<string, unknown> {
  return {
    kind: 'gate-override',
    schemaVersion: 1,
    id: 'override-1',
    recordedAt: '2026-09-28T12:00:00.000Z',
    gateId: 'fixture-regression',
    gateDecisionId: 'fixture-regression.decision-1',
    actor: 'release-manager',
    reason: 'Accepting the tone change for the October release.',
    expiresAt: '2026-10-28T12:00:00.000Z',
    permanentBaselineChange: false,
    evidence: ['https://example.test/review/42'],
  };
}

describe('parseGateDefinition', () => {
  test('parses the committed fixture gate', () => {
    const gate = parseGateDefinition(gateInput());
    expect(gate.baseline).toEqual({
      kind: 'evaluation-run',
      path: '../src/fixtures/release-gate/baseline-run.json',
    });
    expect(gate.sampleSize).toBe(6);
    expect(gate.overrideAuthority).toBe('release-manager');
    expect(gate.regressionThresholds.map((threshold) => threshold.severity)).toEqual([
      'hard',
      'overridable',
    ]);
  });

  test.each(['baseline', 'sampleSize'])(
    'rejects a gate without %s: there is no default',
    (field) => {
      const input = gateInput();
      delete input[field];
      expect(issuePaths(input)).toEqual([field]);
    },
  );

  test('accepts the latest passing decision as a baseline', () => {
    const gate = parseGateDefinition({
      ...gateInput(),
      baseline: { kind: 'latest-passing-decision' },
    });
    expect(gate.baseline).toEqual({ kind: 'latest-passing-decision' });
  });

  test('rejects an expiry that bounds neither revision distance nor age', () => {
    expect(issuePaths({ ...gateInput(), expiry: {} })).toEqual(['expiry']);
    expect(
      parseGateDefinition({ ...gateInput(), expiry: { maximumAgeMs: 86_400_000 } }).expiry,
    ).toEqual({ maximumAgeMs: 86_400_000 });
  });

  test('rejects a second threshold on the same criterion and metric, and no thresholds at all', () => {
    const input = gateInput();
    const thresholds = input['regressionThresholds'] as unknown[];
    expect(issuePaths({ ...input, regressionThresholds: [...thresholds, thresholds[0]] })).toEqual([
      'regressionThresholds.2',
    ]);
    expect(issuePaths({ ...input, regressionThresholds: [] })).toEqual(['regressionThresholds']);
  });

  test('rejects unknown fields, an unknown severity, and a non-positive sample size', () => {
    const input = gateInput();
    const [first] = input['regressionThresholds'] as Record<string, unknown>[];
    expect(
      issuePaths({
        ...input,
        sampleSize: 0,
        retries: 3,
        regressionThresholds: [{ ...first, severity: 'advisory' }],
      }),
    ).toEqual(['sampleSize', 'regressionThresholds.0.severity', '']);
  });
});

describe('gateIdSchema', () => {
  test('accepts a plain identifier and refuses anything that could name another path', () => {
    expect(gateIdSchema.safeParse('fixture-regression').success).toBe(true);
    for (const id of ['../secrets', 'nested/gate', '.hidden', '']) {
      expect(gateIdSchema.safeParse(id).success).toBe(false);
    }
  });
});

describe('gateOverrideRecordSchema', () => {
  test('accepts an expiring override with retained evidence', () => {
    expect(gateOverrideRecordSchema.parse(overrideInput())).toEqual(
      overrideInput() as ReturnType<typeof gateOverrideRecordSchema.parse>,
    );
  });

  test('requires an expiry unless the override is a permanent baseline change', () => {
    const { expiresAt: _expiresAt, ...permanent } = overrideInput();
    expect(gateOverrideRecordSchema.safeParse(permanent).success).toBe(false);
    expect(
      gateOverrideRecordSchema.safeParse({ ...permanent, permanentBaselineChange: true }).success,
    ).toBe(true);
    expect(
      gateOverrideRecordSchema.safeParse({ ...overrideInput(), permanentBaselineChange: true })
        .success,
    ).toBe(false);
  });

  test('rejects an override that expires before it was recorded, or retains no evidence', () => {
    expect(
      gateOverrideRecordSchema.safeParse({
        ...overrideInput(),
        expiresAt: '2026-09-28T11:59:59.999Z',
      }).success,
    ).toBe(false);
    expect(gateOverrideRecordSchema.safeParse({ ...overrideInput(), evidence: [] }).success).toBe(
      false,
    );
  });
});

describe('gateDecisionRecordSchema', () => {
  test('refuses a decision whose evidence names a held-out case by id', () => {
    const shape = gateDecisionRecordSchema.shape.evidence.element;
    const trial = {
      trial: 1,
      seed: 7,
      run: null,
      judge: null,
      latencyBudgetExceeded: false,
    };
    expect(shape.safeParse({ ordinal: 1, visibility: 'held-out', trials: [trial] }).success).toBe(
      true,
    );
    expect(
      shape.safeParse({
        ordinal: 1,
        visibility: 'held-out',
        caseId: 'case-france',
        trials: [trial],
      }).success,
    ).toBe(false);
    expect(shape.safeParse({ ordinal: 2, visibility: 'public', trials: [trial] }).success).toBe(
      false,
    );
  });
});
