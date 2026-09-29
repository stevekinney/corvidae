import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fixtureConfiguration,
  fixtureRegressionEvaluator,
  type FixtureScript,
} from './fixtures/release-gate/fixture-regression';
import { GATE_RECORD_SCHEMA_VERSION, type GateDecisionRecord, parseGateDefinition } from './gate';
import type { EvaluationHistory } from './history';
import {
  assessOverride,
  decisionRejection,
  OverrideRejectedError,
  recordOverride,
  type RecordOverrideOptions,
} from './override';
import { runReleaseGate, type RunReleaseGateOptions } from './release-gate';
import {
  capitalThresholdAt,
  FIXTURE_GATE_ID,
  fixtureGateFile,
  GATE_ACTOR,
  type GateFile,
  memoryHistory,
  OVERRIDE_AUTHORITY,
  writeGates,
} from './release-gate.test-support';

const RECORDED_AT = '2026-09-28T12:00:00.000Z';
const EXPIRES_AT = '2026-10-28T12:00:00.000Z';
const OVERRIDABLE = fixtureGateFile('regressing', capitalThresholdAt('overridable'));
const HARD = fixtureGateFile('regressing', capitalThresholdAt('hard'));

let scratch: string;
let directories = 0;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'override-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function run(
  history: EvaluationHistory,
  gate: GateFile,
  options: Partial<RunReleaseGateOptions> = {},
): Promise<GateDecisionRecord> {
  directories += 1;
  const gatesDirectory = await writeGates(join(scratch, `gates-${directories}`), {
    [FIXTURE_GATE_ID]: gate,
  });
  const result = await runReleaseGate({
    gatesDirectory,
    gateId: FIXTURE_GATE_ID,
    history,
    actor: GATE_ACTOR,
    now: () => Date.parse(RECORDED_AT),
    ...options,
  });
  if (result.decision === 'configuration-error') throw new Error(result.issues.join('; '));
  return result.historical.record;
}

function override(
  decision: GateDecisionRecord,
  changes: Partial<RecordOverrideOptions['override']> = {},
): RecordOverrideOptions['override'] {
  return {
    id: `override-${decision.id.slice(-8)}`,
    recordedAt: RECORDED_AT,
    gateId: FIXTURE_GATE_ID,
    gateDecisionId: decision.id,
    actor: OVERRIDE_AUTHORITY,
    reason: 'The capital regression is a known fixture change.',
    expiresAt: EXPIRES_AT,
    permanentBaselineChange: false,
    evidence: ['https://example.test/review/42'],
    ...changes,
  };
}

/** Appends an override without `recordOverride`'s checks, as another writer might. */
async function appendDirectly(
  history: EvaluationHistory,
  fields: RecordOverrideOptions['override'],
): Promise<void> {
  await history.append({
    kind: 'gate-override',
    schemaVersion: GATE_RECORD_SCHEMA_VERSION,
    ...fields,
  });
}

describe('recordOverride', () => {
  test('appends an expiring override of an overridable regression and leaves the decision untouched', async () => {
    const { history } = memoryHistory();
    const decision = await run(history, OVERRIDABLE);
    const before = await history.read(decision.id);

    const appended = await recordOverride({
      history,
      gate: parseGateDefinition(OVERRIDABLE),
      override: override(decision),
    });

    expect(appended.record).toMatchObject({ kind: 'gate-override', gateDecisionId: decision.id });
    expect(await history.read(appended.record.id)).toEqual(appended);
    expect(await history.read(decision.id)).toEqual(before);
  });

  test.each<[string, Partial<RecordOverrideOptions['override']>, string]>([
    [
      'an override by a principal other than the override authority',
      { actor: 'someone-else' },
      'not-override-authority',
    ],
    [
      'an override of a decision that does not exist',
      { gateDecisionId: 'never-decided' },
      'unknown-decision',
    ],
    ['an override naming another gate', { gateId: 'another-gate' }, 'unknown-decision'],
  ])('rejects %s', async (_label, changes, reason) => {
    const { history } = memoryHistory();
    const decision = await run(history, OVERRIDABLE);
    const attempt = recordOverride({
      history,
      gate: parseGateDefinition(OVERRIDABLE),
      override: override(decision, changes),
    });
    await expect(attempt).rejects.toBeInstanceOf(OverrideRejectedError);
    await expect(attempt).rejects.toMatchObject({ reason });
    const records = await history.list();
    expect(records.map(({ record }) => record.kind)).toEqual(['gate-decision']);
  });

  test('rejects an override by the principal who ran the decision', async () => {
    const { history } = memoryHistory();
    const decision = await run(history, OVERRIDABLE, { actor: OVERRIDE_AUTHORITY });
    await expect(
      recordOverride({
        history,
        gate: parseGateDefinition(OVERRIDABLE),
        override: override(decision),
      }),
    ).rejects.toMatchObject({ reason: 'decision-actor' });
  });

  test('rejects an override of a record that is not a gate decision', async () => {
    const { history } = memoryHistory();
    const decision = await run(history, OVERRIDABLE);
    const first = await recordOverride({
      history,
      gate: parseGateDefinition(OVERRIDABLE),
      override: override(decision),
    });
    await expect(
      recordOverride({
        history,
        gate: parseGateDefinition(OVERRIDABLE),
        override: override(decision, {
          id: 'override-of-override',
          gateDecisionId: first.record.id,
        }),
      }),
    ).rejects.toMatchObject({ reason: 'unknown-decision' });
  });

  test('rejects any override of a decision whose regressions are all hard', async () => {
    const { history } = memoryHistory();
    const decision = await run(history, HARD);
    for (const permanentBaselineChange of [false, true]) {
      await expect(
        recordOverride({
          history,
          gate: parseGateDefinition(HARD),
          override: override(decision, {
            permanentBaselineChange,
            ...(permanentBaselineChange ? { expiresAt: undefined } : {}),
          }),
        }),
      ).rejects.toMatchObject({ reason: 'hard-regression' });
    }
  });

  test('rejects an override of a decision that has nothing to override', async () => {
    const { history } = memoryHistory();
    const passed = await run(history, fixtureGateFile());
    const failed = await run(history, fixtureGateFile('judge-throws'));
    const gate = parseGateDefinition(fixtureGateFile());
    for (const [decision, permanentBaselineChange] of [
      [passed, false],
      [passed, true],
      [failed, true],
    ] as const) {
      await expect(
        recordOverride({
          history,
          gate,
          override: override(decision, {
            permanentBaselineChange,
            ...(permanentBaselineChange ? { expiresAt: undefined } : {}),
          }),
        }),
      ).rejects.toMatchObject({ reason: 'nothing-to-override' });
    }
  });
});

describe('assessOverride and decisionRejection', () => {
  test('an override past its expiry no longer counts', async () => {
    const { history } = memoryHistory();
    const decision = await run(history, OVERRIDABLE);
    const record = {
      kind: 'gate-override' as const,
      schemaVersion: 1 as const,
      ...override(decision),
    };
    const gate = parseGateDefinition(OVERRIDABLE);
    expect(
      assessOverride({ override: record, decision, gate, at: '2026-10-28T11:59:59.999Z' }),
    ).toBe('valid');
    expect(assessOverride({ override: record, decision, gate, at: EXPIRES_AT })).toBe('expired');
  });

  test('a regression with any overridable breach can be answered by an expiring override', async () => {
    const { history } = memoryHistory();
    const decision = await run(history, OVERRIDABLE);
    expect(decisionRejection(decision, false)).toBeUndefined();
    expect(decisionRejection(decision, true)).toBeUndefined();
  });
});

describe('release gate with overrides', () => {
  test('a valid override of an overridable regression makes the next run pass and names the override', async () => {
    const { history } = memoryHistory();
    const first = await run(history, OVERRIDABLE);
    expect(first.decision).toBe('regression');
    const { record } = await recordOverride({
      history,
      gate: parseGateDefinition(OVERRIDABLE),
      override: override(first),
    });

    const next = await run(history, OVERRIDABLE);

    expect(next.decision).toBe('pass');
    expect(next.overrides.applied).toEqual([record.id]);
    expect(next.findings.regressions).toEqual([
      expect.objectContaining({ criterion: 'names-the-capital', overriddenBy: record.id }),
    ]);
    expect(next.overrides.considered).toEqual([
      expect.objectContaining({ id: record.id, validity: 'valid', gateDecisionId: first.id }),
    ]);
  });

  test('an override by a principal other than the override authority is rejected and the gate still regresses', async () => {
    const { history } = memoryHistory();
    const first = await run(history, OVERRIDABLE);
    await appendDirectly(history, override(first, { actor: 'someone-else' }));
    const next = await run(history, OVERRIDABLE);
    expect(next.decision).toBe('regression');
    expect(next.overrides.applied).toEqual([]);
    expect(next.overrides.rejected).toEqual([
      expect.objectContaining({ criterion: 'names-the-capital', reason: 'not-override-authority' }),
    ]);
  });

  test('an override by the decision’s own actor is rejected and the gate still regresses', async () => {
    const { history } = memoryHistory();
    const first = await run(history, OVERRIDABLE, { actor: OVERRIDE_AUTHORITY });
    await appendDirectly(history, override(first));
    const next = await run(history, OVERRIDABLE);
    expect(next.decision).toBe('regression');
    expect(next.overrides.rejected.map((entry) => entry.reason)).toEqual(['decision-actor']);
  });

  test('an override past its expiry is rejected and the gate still regresses', async () => {
    const { history } = memoryHistory();
    const first = await run(history, OVERRIDABLE);
    await recordOverride({
      history,
      gate: parseGateDefinition(OVERRIDABLE),
      override: override(first),
    });
    const next = await run(history, OVERRIDABLE, { now: () => Date.parse(EXPIRES_AT) + 1 });
    expect(next.decision).toBe('regression');
    expect(next.overrides.rejected.map((entry) => entry.reason)).toEqual(['expired']);
  });

  test('no override clears a hard regression', async () => {
    const { history } = memoryHistory();
    const first = await run(history, OVERRIDABLE);
    await recordOverride({
      history,
      gate: parseGateDefinition(OVERRIDABLE),
      override: override(first),
    });
    const next = await run(history, HARD);
    expect(next.decision).toBe('regression');
    expect(next.overrides.applied).toEqual([]);
    expect(next.overrides.rejected.map((entry) => entry.reason)).toEqual(['hard-regression']);
    expect(next.findings.regressions[0]!.overriddenBy).toBeNull();
  });

  test('an override covers only the overridable regressions it answered, even after a hard threshold is demoted', async () => {
    /** The fixture gate with a capital meanScore threshold beside a capital passFraction at `severity`. */
    const capitalMeanScoreBeside = (severity: 'hard' | 'overridable') => {
      const { regressionThresholds } = capitalThresholdAt(severity) as {
        regressionThresholds: GateFile[];
      };
      return fixtureGateFile('regressing', {
        regressionThresholds: [
          ...regressionThresholds,
          {
            criterion: 'names-the-capital',
            metric: 'meanScore',
            maximumDecrease: 0.1,
            severity: 'overridable',
          },
        ],
      });
    };
    const capital = (decision: GateDecisionRecord) =>
      decision.findings.regressions.filter(({ criterion }) => criterion === 'names-the-capital');
    const { history } = memoryHistory();
    const first = await run(history, capitalMeanScoreBeside('hard'));
    expect(first.decision).toBe('regression');
    expect(capital(first).map(({ metric, severity }) => [metric, severity])).toEqual([
      ['passFraction', 'hard'],
      ['meanScore', 'overridable'],
    ]);
    const { record } = await recordOverride({
      history,
      gate: parseGateDefinition(capitalMeanScoreBeside('hard')),
      override: override(first),
    });
    const answered = first.findings.regressions
      .filter(({ severity }) => severity === 'overridable')
      .map(({ criterion, metric, delta }) => ({ criterion, metric, delta }));

    const rerun = await run(history, capitalMeanScoreBeside('hard'));
    const demoted = await run(history, capitalMeanScoreBeside('overridable'));

    for (const next of [rerun, demoted]) {
      expect(next.decision).toBe('regression');
      expect(capital(next).map(({ metric, overriddenBy }) => [metric, overriddenBy])).toEqual([
        ['passFraction', null],
        ['meanScore', record.id],
      ]);
      expect(next.overrides.considered).toEqual([
        expect.objectContaining({ id: record.id, validity: 'valid', covers: answered }),
      ]);
      expect(next.overrides.rejected).toEqual([]);
    }
  });

  test('an override answers one evaluator revision, and an unknown decision covers nothing', async () => {
    const { history } = memoryHistory();
    const first = await run(history, OVERRIDABLE);
    await recordOverride({
      history,
      gate: parseGateDefinition(OVERRIDABLE),
      override: override(first),
    });
    await appendDirectly(
      history,
      override(first, { id: 'override-unknown', gateDecisionId: 'never-decided' }),
    );
    const revised = await run(history, OVERRIDABLE, {
      loadEvaluator: async () => ({
        ...(await fixtureRegressionEvaluator('regressing')),
        configuration: { ...fixtureConfiguration(), revision: 2 },
      }),
    });
    expect(revised.decision).toBe('regression');
    expect(revised.overrides.rejected.map((entry) => entry.reason)).toEqual([
      'different-evaluator',
    ]);
    expect(revised.overrides.considered).toContainEqual(
      expect.objectContaining({ id: 'override-unknown', validity: 'unknown-decision', covers: [] }),
    );
  });
});

describe('permanent baseline changes', () => {
  const latest = { baseline: { kind: 'latest-passing-decision' } };

  test('accept a decision’s evidence as the baseline of the gate’s next run', async () => {
    const { history } = memoryHistory();
    const first = await run(history, fixtureGateFile('passing', latest));
    expect(first.decision).toBe('insufficient-evidence');
    const accepted = await recordOverride({
      history,
      gate: parseGateDefinition(fixtureGateFile('passing', latest)),
      override: override(first, { permanentBaselineChange: true, expiresAt: undefined }),
    });

    const next = await run(history, fixtureGateFile('passing', latest));

    expect(next.decision).toBe('pass');
    expect(next.baseline?.source).toEqual({
      kind: 'gate-decision',
      recordId: first.id,
      digest: (await history.read(first.id))!.digest,
      acceptedBy: accepted.record.id,
    });
    expect(next.overrides.considered).toEqual([]);
  });

  const hour = 3_600_000;
  /** Runs the gate `hours` after {@link RECORDED_AT}, so decisions never tie on time. */
  const at = (hours: number) => ({ now: () => Date.parse(RECORDED_AT) + hours * hour });
  /** The gate with an overridable capital threshold on the latest-passing-decision baseline. */
  const latestOverridable = (script: FixtureScript) =>
    fixtureGateFile(script, { ...capitalThresholdAt('overridable'), ...latest });

  /**
   * A pass against the committed baseline, an overridable regression against
   * that pass, an expiring override of the regression, and a run that passes
   * only because the override clears the same regression.
   */
  async function passThroughExpiringOverride(history: EvaluationHistory) {
    const clean = await run(
      history,
      fixtureGateFile('passing', capitalThresholdAt('overridable')),
      at(-2),
    );
    const regressed = await run(history, latestOverridable('regressing'), at(-1));
    const { record: expiring } = await recordOverride({
      history,
      gate: parseGateDefinition(latestOverridable('regressing')),
      override: override(regressed),
    });
    const overridden = await run(history, latestOverridable('regressing'), at(1));
    return { clean, regressed, expiring, overridden };
  }

  test('never adopt a decision that passed only through an expiring override', async () => {
    const { history } = memoryHistory();
    const { clean, regressed, expiring, overridden } = await passThroughExpiringOverride(history);
    const cleanBaseline = {
      kind: 'gate-decision' as const,
      recordId: clean.id,
      digest: (await history.read(clean.id))!.digest,
      acceptedBy: null,
    };
    expect([clean.decision, regressed.decision, overridden.decision]).toEqual([
      'pass',
      'regression',
      'pass',
    ]);
    expect(overridden.overrides.applied).toEqual([expiring.id]);
    expect(overridden.baseline?.source).toEqual(cleanBaseline);

    const expired = await run(history, latestOverridable('regressing'), {
      now: () => Date.parse(EXPIRES_AT) + 1,
    });

    expect(expired.decision).toBe('regression');
    expect(expired.baseline?.source).toEqual(cleanBaseline);
    expect(expired.findings.regressions).toEqual([
      expect.objectContaining({ criterion: 'names-the-capital', overriddenBy: null }),
    ]);
    expect(expired.overrides.rejected).toEqual([
      {
        id: expiring.id,
        criterion: 'names-the-capital',
        metric: 'passFraction',
        reason: 'expired',
      },
    ]);
  });

  test('may accept a decision that passed only through an expiring override', async () => {
    const { history } = memoryHistory();
    const { overridden } = await passThroughExpiringOverride(history);
    expect(decisionRejection(overridden, true)).toBeUndefined();
    const accepted = await recordOverride({
      history,
      gate: parseGateDefinition(latestOverridable('regressing')),
      override: override(overridden, {
        recordedAt: new Date(Date.parse(RECORDED_AT) + 2 * hour).toISOString(),
        permanentBaselineChange: true,
        expiresAt: undefined,
      }),
    });

    const next = await run(history, latestOverridable('regressing'), {
      now: () => Date.parse(EXPIRES_AT) + 1,
    });

    expect(next.decision).toBe('pass');
    expect(next.baseline?.source).toEqual({
      kind: 'gate-decision',
      recordId: overridden.id,
      digest: (await history.read(overridden.id))!.digest,
      acceptedBy: accepted.record.id,
    });
    expect(next.findings.regressions).toEqual([]);
  });

  test('are ignored when the override authority did not make them', async () => {
    const { history } = memoryHistory();
    const first = await run(history, fixtureGateFile('passing', latest));
    await appendDirectly(
      history,
      override(first, {
        permanentBaselineChange: true,
        expiresAt: undefined,
        actor: 'someone-else',
      }),
    );
    const next = await run(history, fixtureGateFile('passing', latest));
    expect(next.baseline).toBeNull();
  });
});
