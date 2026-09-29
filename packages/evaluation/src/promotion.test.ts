import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { sha256Hex } from '@lostgradient/cryptography';

import { fixtureConfiguration } from './fixtures/release-gate/fixture-regression';
import { type GateDecisionRecord, parseGateDefinition } from './gate';
import type { EvaluationHistory } from './history';
import { canonicalJson } from './identity';
import { recordOverride } from './override';
import {
  issuePromotionSignal,
  latestGateDecision,
  PROMOTION_SIGNAL_EXIT_CODES,
  PROMOTION_SIGNAL_MAXIMUM_LIFETIME_MS,
  PROMOTION_SIGNAL_SCHEMA_VERSION,
  type PromotionContext,
  type PromotionSignal,
  promotionSignalDigest,
  promotionSignalRecordSchema,
  promotionSignalSchema,
  verifyPromotionSignal,
} from './promotion';
import {
  EVALUATION_PACKAGE_DIRECTORY,
  type GateEvaluatorDefinition,
  loadGateEvaluator,
  runReleaseGate,
  type RunReleaseGateOptions,
} from './release-gate';
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

const REVISION = '857d7dbf10e51718e77bc484145cd4a95f244afc';
const OTHER_REVISION = 'b1c2d3e4f5a60718293a4b5c6d7e8f9012345678';
const PACKAGE_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DECIDED_AT = '2026-09-28T12:00:00.000Z';
const ISSUED_AT = '2026-09-28T13:00:00.000Z';
const RELEASE_OWNER = 'release-owner';

let scratch: string;
let directories = 0;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'promotion-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Runs the gate once, at `DECIDED_AT` and `REVISION` unless told otherwise, and returns its decision. */
async function decide(
  history: EvaluationHistory,
  gate: GateFile = fixtureGateFile(),
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
    now: () => Date.parse(DECIDED_AT),
    sourceRevision: REVISION,
    ...options,
  });
  if (result.decision === 'configuration-error') throw new Error(result.issues.join('; '));
  return result.historical.record;
}

/** Loads the evaluator module a decision names, then applies `change` to its definition. */
function loadingWith(
  change: (definition: GateEvaluatorDefinition) => GateEvaluatorDefinition = (definition) =>
    definition,
): PromotionContext['loadEvaluator'] {
  return async (module) =>
    change(await loadGateEvaluator(resolve(EVALUATION_PACKAGE_DIRECTORY, module)));
}

function withConfiguration(changes: Record<string, unknown>): PromotionContext['loadEvaluator'] {
  return loadingWith((definition) => ({
    ...definition,
    configuration: { ...(definition.configuration as Record<string, unknown>), ...changes },
  }));
}

/** The repository as it stands when a signal is issued or verified: unchanged unless told otherwise. */
function context(
  history: EvaluationHistory,
  changes: Partial<PromotionContext> = {},
): PromotionContext {
  return {
    history,
    currentRevision: REVISION,
    loadEvaluator: loadingWith(),
    packageSourceRevision: () => PACKAGE_TREE,
    now: () => Date.parse(ISSUED_AT),
    ...changes,
  };
}

async function issued(history: EvaluationHistory, decision: GateDecisionRecord) {
  const outcome = await issuePromotionSignal(decision.id, {
    ...context(history),
    actor: RELEASE_OWNER,
  });
  if (outcome.result !== 'issued') throw new Error(`Expected a signal, got ${outcome.result}`);
  return outcome;
}

async function kinds(history: EvaluationHistory): Promise<string[]> {
  const records = await history.list();
  return records.map(({ record }) => record.kind);
}

function signalInput(): Record<string, unknown> {
  return {
    signalId: 'fixture-regression.signal.1',
    package: { name: '@lostgradient/evaluation', sourceRevision: PACKAGE_TREE },
    model: { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'medium' },
    promptVersion: 'fixture-judge-prompt-1',
    dataset: { id: 'capitals', version: 'capitals-2026-09' },
    evaluator: { name: 'fixture-regression', revision: 1, digest: 'b'.repeat(64) },
    sourceRevision: REVISION,
    gateDecisionRecordId: 'fixture-regression.decision-1',
    overrideRecordIds: [],
    decidedAt: DECIDED_AT,
    issuedAt: ISSUED_AT,
    actor: RELEASE_OWNER,
    expiresAt: '2026-09-29T12:00:00.000Z',
    digest: 'c'.repeat(64),
  };
}

/** A copy of `input` with the field at `path` (dot-separated) removed. */
function without(input: Record<string, unknown>, path: string): Record<string, unknown> {
  const copy = structuredClone(input);
  const keys = path.split('.');
  const last = keys.pop()!;
  let parent: Record<string, unknown> = copy;
  for (const key of keys) parent = parent[key] as Record<string, unknown>;
  delete parent[last];
  return copy;
}

function issuePaths(input: unknown): string[] {
  const parsed = promotionSignalSchema.safeParse(input);
  if (parsed.success) throw new Error('Expected the signal to be rejected');
  return parsed.error.issues.map((issue) => issue.path.join('.'));
}

describe('promotionSignalSchema', () => {
  test('accepts a complete signal', () => {
    expect(promotionSignalSchema.parse(signalInput())).toEqual(signalInput() as PromotionSignal);
  });

  test.each([
    'signalId',
    'package',
    'package.name',
    'package.sourceRevision',
    'model',
    'model.provider',
    'model.model',
    'model.effort',
    'promptVersion',
    'dataset',
    'dataset.id',
    'dataset.version',
    'evaluator',
    'evaluator.name',
    'evaluator.revision',
    'evaluator.digest',
    'sourceRevision',
    'gateDecisionRecordId',
    'overrideRecordIds',
    'decidedAt',
    'issuedAt',
    'actor',
    'expiresAt',
    'digest',
  ])('rejects a signal without %s, naming that field', (field) => {
    expect(issuePaths(without(signalInput(), field))).toEqual([field]);
  });

  test('binds no model for a judge that is not a model, but never an absent one', () => {
    expect(promotionSignalSchema.parse({ ...signalInput(), model: null }).model).toBeNull();
  });

  test('rejects unknown fields, an unknown effort, and revisions that are not commit hashes', () => {
    expect(
      issuePaths({
        ...signalInput(),
        model: { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'extreme' },
        sourceRevision: 'HEAD',
        channel: 'stable',
      }),
    ).toEqual(['model.effort', 'sourceRevision', '']);
  });

  test('rejects a signal issued before its decision, or one that expires by the time it is issued', () => {
    expect(issuePaths({ ...signalInput(), issuedAt: '2026-09-28T11:59:59.999Z' })).toEqual([
      'issuedAt',
    ]);
    expect(issuePaths({ ...signalInput(), expiresAt: ISSUED_AT })).toEqual(['expiresAt']);
  });
});

describe('promotionSignalRecordSchema', () => {
  test('keeps a signal under its own id and issue time', () => {
    const signal = signalInput();
    const record = {
      kind: 'promotion-signal',
      schemaVersion: PROMOTION_SIGNAL_SCHEMA_VERSION,
      id: signal['signalId'],
      recordedAt: signal['issuedAt'],
      signal,
    };
    expect(promotionSignalRecordSchema.safeParse(record).success).toBe(true);
    const mismatched = promotionSignalRecordSchema.safeParse({
      ...record,
      id: 'another-id',
      recordedAt: DECIDED_AT,
    });
    expect(mismatched.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'id',
      'recordedAt',
    ]);
  });
});

describe('issuePromotionSignal', () => {
  test('binds the package, model, prompt, dataset, evaluator, and source revision of a passing decision', async () => {
    const { history } = memoryHistory();
    const decision = await decide(history);

    const outcome = await issued(history, decision);

    const { signal } = outcome;
    expect(signal).toEqual({
      signalId: expect.stringMatching(
        /^fixture-regression\.signal\.20260928T130000000Z\.[0-9a-f]{8}$/,
      ),
      package: { name: '@lostgradient/evaluation', sourceRevision: PACKAGE_TREE },
      model: { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'medium' },
      promptVersion: 'fixture-judge-prompt-1',
      dataset: { id: 'capitals', version: 'capitals-2026-09' },
      evaluator: {
        name: decision.evaluator.name,
        revision: decision.evaluator.revision,
        digest: decision.evaluator.digest,
      },
      sourceRevision: REVISION,
      gateDecisionRecordId: decision.id,
      overrideRecordIds: [],
      decidedAt: DECIDED_AT,
      issuedAt: ISSUED_AT,
      actor: RELEASE_OWNER,
      expiresAt: new Date(
        Date.parse(DECIDED_AT) + PROMOTION_SIGNAL_MAXIMUM_LIFETIME_MS,
      ).toISOString(),
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(await kinds(history)).toEqual(['gate-decision', 'promotion-signal']);
    expect(await history.read(signal.signalId)).toEqual({
      digest: outcome.recordDigest,
      record: {
        kind: 'promotion-signal',
        schemaVersion: PROMOTION_SIGNAL_SCHEMA_VERSION,
        id: signal.signalId,
        recordedAt: ISSUED_AT,
        signal,
      },
    });
  });

  test('digests the canonical serialization of the signal without its digest field', async () => {
    const { history } = memoryHistory();
    const { signal } = await issued(history, await decide(history));
    const { digest, ...fields } = signal;

    expect(digest).toBe(await sha256Hex(canonicalJson(fields)));
    expect(await promotionSignalDigest(signal)).toBe(digest);
    expect(await promotionSignalDigest({ ...signal, actor: 'someone-else' })).not.toBe(digest);
  });

  test('issues a new signal each time, and never changes an earlier one', async () => {
    const { history } = memoryHistory();
    const decision = await decide(history);
    const first = await issued(history, decision);
    const before = await history.read(first.signal.signalId);

    const second = await issued(history, decision);

    expect(second.signal.signalId).not.toBe(first.signal.signalId);
    expect(await history.read(first.signal.signalId)).toEqual(before);
    expect(before?.digest).toBe(first.recordDigest);
    expect(await kinds(history)).toEqual(['gate-decision', 'promotion-signal', 'promotion-signal']);
  });

  test('names the signal with the id source it is given', async () => {
    const { history } = memoryHistory();
    const decision = await decide(history);
    const outcome = await issuePromotionSignal(decision.id, {
      ...context(history),
      actor: RELEASE_OWNER,
      createId: (from, issuedAt) => `${from.id}.promoted-${issuedAt.slice(0, 10)}`,
    });
    expect(outcome).toMatchObject({
      result: 'issued',
      signal: { signalId: `${decision.id}.promoted-2026-09-28` },
    });
  });

  test.each<[string, GateFile, GateDecisionRecord['decision']]>([
    ['a regression', fixtureGateFile('regressing'), 'regression'],
    ['an infrastructure failure', fixtureGateFile('judge-throws'), 'infrastructure-failure'],
    ['insufficient evidence', fixtureGateFile('uncalibrated'), 'insufficient-evidence'],
  ])('refuses %s and appends nothing', async (_label, gate, decided) => {
    const { history } = memoryHistory();
    const decision = await decide(history, gate);
    expect(decision.decision).toBe(decided);

    const outcome = await issuePromotionSignal(decision.id, {
      ...context(history),
      actor: RELEASE_OWNER,
    });

    expect(outcome).toEqual({
      result: 'insufficient-evidence',
      gateDecisionRecordId: decision.id,
      reason: 'decision-not-passing',
      problem: `Gate decision "${decision.id}" is ${decided}, not pass`,
    });
    expect(await kinds(history)).toEqual(['gate-decision']);
  });

  test('refuses a decision older than the gate’s maximum age, or than a signal may ever be', async () => {
    const { history } = memoryHistory();
    // The committed baseline is twelve hours older than the decision, so the gate must accept that.
    const maximumAgeMs = 13 * 3_600_000;
    const aged = await decide(
      history,
      fixtureGateFile('passing', { expiry: { maximumRevisionDistance: 50, maximumAgeMs } }),
    );
    const fresh = await decide(history);
    const at = (time: number) => ({
      ...context(history, { now: () => Date.parse(DECIDED_AT) + time }),
      actor: RELEASE_OWNER,
    });

    expect(aged.decision).toBe('pass');
    expect(await issuePromotionSignal(aged.id, at(maximumAgeMs))).toEqual({
      result: 'insufficient-evidence',
      gateDecisionRecordId: aged.id,
      reason: 'decision-expired',
      problem: `Gate decision "${aged.id}" expired at 2026-09-29T01:00:00.000Z`,
    });
    expect(await issuePromotionSignal(aged.id, at(maximumAgeMs - 1))).toMatchObject({
      result: 'issued',
      signal: { expiresAt: '2026-09-29T01:00:00.000Z' },
    });
    expect(
      await issuePromotionSignal(fresh.id, at(PROMOTION_SIGNAL_MAXIMUM_LIFETIME_MS)),
    ).toMatchObject({ result: 'insufficient-evidence', reason: 'decision-expired' });
    expect(await kinds(history)).toEqual(['gate-decision', 'gate-decision', 'promotion-signal']);
  });

  test('refuses a decision recorded at another revision than the one checked out, and appends nothing', async () => {
    const { history } = memoryHistory();
    const decision = await decide(history, fixtureGateFile(), { sourceRevision: OTHER_REVISION });

    const outcome = await issuePromotionSignal(decision.id, {
      ...context(history),
      actor: RELEASE_OWNER,
    });

    expect(outcome).toEqual({
      result: 'stale',
      gateDecisionRecordId: decision.id,
      stale: [{ field: 'sourceRevision', bound: OTHER_REVISION, current: REVISION }],
    });
    expect(await kinds(history)).toEqual(['gate-decision']);
  });

  test('refuses a decision whose evaluator or dataset has moved since it was made', async () => {
    const { history } = memoryHistory();
    const decision = await decide(history);
    const issue = (loadEvaluator: PromotionContext['loadEvaluator']) =>
      issuePromotionSignal(decision.id, {
        ...context(history, { loadEvaluator }),
        actor: RELEASE_OWNER,
      });

    const evaluatorMoved = await issue(withConfiguration({ passThreshold: 0.5 }));
    expect(evaluatorMoved).toMatchObject({
      result: 'stale',
      stale: [{ field: 'evaluator.digest', bound: decision.evaluator.digest }],
    });

    const datasetMoved = await issue(
      loadingWith((definition) => ({
        ...definition,
        dataset: {
          ...(definition.dataset as Record<string, unknown>),
          version: 'capitals-2026-10',
        },
      })),
    );
    expect(datasetMoved).toMatchObject({
      result: 'stale',
      stale: [{ field: 'dataset.version', bound: 'capitals-2026-09', current: 'capitals-2026-10' }],
    });
    expect(await kinds(history)).toEqual(['gate-decision']);
  });

  test('refuses an id that names no gate decision', async () => {
    const { history } = memoryHistory();
    const decision = await decide(history);
    const { signal } = await issued(history, decision);

    for (const id of ['never-decided', signal.signalId]) {
      expect(await issuePromotionSignal(id, { ...context(history), actor: RELEASE_OWNER })).toEqual(
        {
          result: 'insufficient-evidence',
          gateDecisionRecordId: id,
          reason: 'decision-missing',
          problem: `No gate decision "${id}"`,
        },
      );
    }
  });

  test('refuses a decision of a gate that names no package, or that records no source revision', async () => {
    const { history } = memoryHistory();
    const { package: _package, ...unnamed } = fixtureGateFile();
    const anonymous = await decide(history, unnamed);
    const unrecorded = await decide(history, fixtureGateFile(), { sourceRevision: undefined });
    const issue = (id: string) =>
      issuePromotionSignal(id, { ...context(history), actor: RELEASE_OWNER });

    expect(await issue(anonymous.id)).toEqual({
      result: 'insufficient-evidence',
      gateDecisionRecordId: anonymous.id,
      reason: 'package-undeclared',
      problem: `Gate "${FIXTURE_GATE_ID}" names no package, so a signal cannot bind one`,
    });
    expect(await issue(unrecorded.id)).toEqual({
      result: 'insufficient-evidence',
      gateDecisionRecordId: unrecorded.id,
      reason: 'source-revision-unrecorded',
      problem: `Gate decision "${unrecorded.id}" does not record the source revision it ran at`,
    });
  });

  test.each<[string, Partial<PromotionContext>, string]>([
    [
      'the checked-out revision is unknown',
      { currentRevision: undefined },
      'The current source revision cannot be determined',
    ],
    [
      'the package cannot be found at that revision',
      { packageSourceRevision: () => undefined },
      `The source revision of workspace "@lostgradient/evaluation" at ${REVISION} cannot be resolved`,
    ],
    [
      'the evaluator module cannot be loaded',
      {
        loadEvaluator: () => Promise.reject(new Error('the module is gone')),
      },
      'The evaluator module src/fixtures/release-gate/passing.ts cannot be resolved: the module is gone',
    ],
    [
      'the evaluator module builds an invalid configuration',
      { loadEvaluator: withConfiguration({ repetitions: 0 }) },
      'The evaluator module src/fixtures/release-gate/passing.ts cannot be resolved: Invalid evaluator configuration: repetitions:',
    ],
    [
      'the judge model is not in operative’s model catalog',
      { loadEvaluator: withConfiguration({ judge: { ...judge(), model: 'claude-sonnet-4-5' } }) },
      'Judge model "claude-sonnet-4-5" is not in operative’s model catalog, so its provider cannot be bound',
    ],
  ])('cannot bind current values when %s', async (_label, changes, problem) => {
    const { history } = memoryHistory();
    const decision = await decide(history);

    const outcome = await issuePromotionSignal(decision.id, {
      ...context(history, changes),
      actor: RELEASE_OWNER,
    });

    expect(outcome).toEqual({
      result: 'unresolvable',
      gateDecisionRecordId: decision.id,
      problem: expect.stringContaining(problem),
    });
    expect(await kinds(history)).toEqual(['gate-decision']);
  });
});

function judge(): Record<string, unknown> {
  return fixtureConfiguration()['judge'] as Record<string, unknown>;
}

describe('issuePromotionSignal with overrides', () => {
  const OVERRIDABLE = fixtureGateFile('regressing', capitalThresholdAt('overridable'));

  /** A regression, an override of it that expires at `expiresAt`, and the next run it lets pass. */
  async function overriddenPass(history: EvaluationHistory, expiresAt: string) {
    const regression = await decide(history, OVERRIDABLE);
    const { record: override } = await recordOverride({
      history,
      gate: parseGateDefinition(OVERRIDABLE),
      override: {
        id: 'override-capital',
        recordedAt: DECIDED_AT,
        gateId: FIXTURE_GATE_ID,
        gateDecisionId: regression.id,
        actor: OVERRIDE_AUTHORITY,
        reason: 'The capital regression is a known fixture change.',
        expiresAt,
        permanentBaselineChange: false,
        evidence: ['https://example.test/review/42'],
      },
    });
    const passed = await decide(history, OVERRIDABLE);
    expect(passed.decision).toBe('pass');
    expect(passed.overrides.applied).toEqual([override.id]);
    return { passed, override };
  }

  test('binds the overrides a passing decision relied on, and expires with the first of them', async () => {
    const { history } = memoryHistory();
    const { passed, override } = await overriddenPass(history, '2026-09-28T14:00:00.000Z');

    const outcome = await issuePromotionSignal(passed.id, {
      ...context(history, { loadEvaluator: loadingWith() }),
      actor: RELEASE_OWNER,
    });

    expect(outcome).toMatchObject({
      result: 'issued',
      signal: { overrideRecordIds: [override.id], expiresAt: '2026-09-28T14:00:00.000Z' },
    });
  });

  test('refuses a decision whose override has since expired', async () => {
    const { history } = memoryHistory();
    const { passed } = await overriddenPass(history, '2026-09-28T14:00:00.000Z');

    const outcome = await issuePromotionSignal(passed.id, {
      ...context(history, { now: () => Date.parse('2026-09-28T14:00:00.000Z') }),
      actor: RELEASE_OWNER,
    });

    expect(outcome).toEqual({
      result: 'insufficient-evidence',
      gateDecisionRecordId: passed.id,
      reason: 'override-invalid',
      problem: 'Override "override-capital" no longer clears the decision’s regression: expired',
    });
  });

  test('refuses a decision whose override the history does not hold', async () => {
    const { history } = memoryHistory();
    const { passed } = await overriddenPass(history, '2026-09-28T14:00:00.000Z');
    const elsewhere = memoryHistory().history;
    await elsewhere.append(passed);

    const outcome = await issuePromotionSignal(passed.id, {
      ...context(elsewhere),
      actor: RELEASE_OWNER,
    });

    expect(outcome).toEqual({
      result: 'insufficient-evidence',
      gateDecisionRecordId: passed.id,
      reason: 'override-invalid',
      problem:
        'Override "override-capital" that cleared the decision’s regression is not in the history',
    });
  });
});

describe('verifyPromotionSignal', () => {
  test('is valid while nothing it binds has moved', async () => {
    const { history } = memoryHistory();
    const { signal } = await issued(history, await decide(history));

    expect(await verifyPromotionSignal(signal.signalId, context(history))).toEqual({
      result: 'valid',
      signal,
    });
  });

  test('is expired from its expiry on, whatever else has moved', async () => {
    const { history } = memoryHistory();
    const { signal } = await issued(history, await decide(history));
    const at = (time: string) =>
      verifyPromotionSignal(
        signal.signalId,
        context(history, { now: () => Date.parse(time), currentRevision: OTHER_REVISION }),
      );

    expect(await at(signal.expiresAt)).toEqual({
      result: 'expired',
      signal,
      checkedAt: signal.expiresAt,
    });
    expect(await at('2026-09-29T11:59:59.999Z')).toMatchObject({ result: 'stale' });
  });

  test.each<[string, Partial<PromotionContext>, string[]]>([
    [
      'the package source revision',
      { packageSourceRevision: () => 'f'.repeat(40) },
      ['package.sourceRevision'],
    ],
    ['the source revision', { currentRevision: OTHER_REVISION }, ['sourceRevision']],
    [
      'the evaluator digest',
      { loadEvaluator: withConfiguration({ passThreshold: 0.5 }) },
      ['evaluator.digest'],
    ],
    [
      'the model',
      { loadEvaluator: withConfiguration({ judge: { ...judge(), model: 'claude-opus-4-8' } }) },
      ['evaluator.digest', 'model.model'],
    ],
    [
      'the effort',
      { loadEvaluator: withConfiguration({ judge: { ...judge(), effort: 'high' } }) },
      ['evaluator.digest', 'model.effort'],
    ],
    [
      'the prompt version',
      { loadEvaluator: withConfiguration({ promptVersion: 'fixture-judge-prompt-2' }) },
      ['evaluator.digest', 'promptVersion'],
    ],
    [
      'the judge, to one that is not a model',
      {
        loadEvaluator: withConfiguration({
          judge: { kind: 'deterministic', name: 'exact-match' },
          criteria: [(fixtureConfiguration()['criteria'] as unknown[])[0]],
          variancePolicy: undefined,
        }),
      },
      ['evaluator.digest', 'model'],
    ],
  ])(
    'is stale when %s moves, and names every field that moved',
    async (_label, changes, fields) => {
      const { history } = memoryHistory();
      const { signal } = await issued(history, await decide(history));

      const verification = await verifyPromotionSignal(signal.signalId, context(history, changes));

      expect(verification.result).toBe('stale');
      expect(
        verification.result === 'stale' && verification.stale.map((entry) => entry.field),
      ).toEqual(fields);
    },
  );

  test('reports what each stale field was bound to and what it is now', async () => {
    const { history } = memoryHistory();
    const { signal } = await issued(history, await decide(history));

    const verification = await verifyPromotionSignal(
      signal.signalId,
      context(history, {
        currentRevision: OTHER_REVISION,
        packageSourceRevision: () => 'f'.repeat(40),
      }),
    );

    expect(verification).toEqual({
      result: 'stale',
      signal,
      stale: [
        { field: 'package.sourceRevision', bound: PACKAGE_TREE, current: 'f'.repeat(40) },
        { field: 'sourceRevision', bound: REVISION, current: OTHER_REVISION },
      ],
    });
  });

  test('binds the backend a judge model alias names, not the alias', async () => {
    const { history } = memoryHistory();
    const { signal } = await issued(history, await decide(history));

    const verification = await verifyPromotionSignal(
      signal.signalId,
      context(history, {
        loadEvaluator: withConfiguration({ judge: { ...judge(), model: 'sonnet' } }),
      }),
    );

    expect(verification.result === 'stale' && verification.stale).toContainEqual({
      field: 'model.model',
      bound: 'claude-sonnet-4-6',
      current: 'claude-sonnet-5',
    });
  });

  test('finds no signal for an unknown id or a record of another kind', async () => {
    const { history } = memoryHistory();
    const decision = await decide(history);
    for (const id of ['never-issued', decision.id]) {
      expect(await verifyPromotionSignal(id, context(history))).toEqual({
        result: 'insufficient-evidence',
        signalId: id,
        reason: 'signal-missing',
        problem: `No promotion signal "${id}"`,
      });
    }
  });

  test('reports a signal that does not match its own digest, or names a decision the history lacks', async () => {
    const { history } = memoryHistory();
    const { signal } = await issued(history, await decide(history));
    const append = (target: EvaluationHistory, changes: Partial<PromotionSignal>) => {
      const copy = { ...signal, ...changes };
      return target.append({
        kind: 'promotion-signal',
        schemaVersion: PROMOTION_SIGNAL_SCHEMA_VERSION,
        id: copy.signalId,
        recordedAt: copy.issuedAt,
        signal: copy,
      });
    };
    await append(history, { signalId: 'tampered', actor: 'someone-else' });
    const elsewhere = memoryHistory().history;
    await append(elsewhere, {});

    expect(await verifyPromotionSignal('tampered', context(history))).toEqual({
      result: 'corrupt-record',
      recordId: 'tampered',
      problem: 'Promotion signal "tampered" does not match its own digest',
    });
    expect(await verifyPromotionSignal(signal.signalId, context(elsewhere))).toEqual({
      result: 'corrupt-record',
      recordId: signal.signalId,
      problem: `Promotion signal "${signal.signalId}" names gate decision "${signal.gateDecisionRecordId}", which the history does not hold`,
    });
  });

  test('cannot verify against a repository whose current values cannot be resolved', async () => {
    const { history } = memoryHistory();
    const { signal } = await issued(history, await decide(history));

    expect(
      await verifyPromotionSignal(
        signal.signalId,
        context(history, { currentRevision: undefined }),
      ),
    ).toEqual({
      result: 'unresolvable',
      signalId: signal.signalId,
      problem: 'The current source revision cannot be determined',
    });
    expect(
      await verifyPromotionSignal(
        signal.signalId,
        context(history, { packageSourceRevision: () => undefined }),
      ),
    ).toMatchObject({ result: 'unresolvable', signalId: signal.signalId });
  });
});

describe('latestGateDecision', () => {
  test('is the newest decision of the gate, whatever its outcome, and undefined for a gate never run', async () => {
    const { history } = memoryHistory();
    await decide(history);
    const newest = await decide(history, fixtureGateFile('regressing'), {
      now: () => Date.parse('2026-09-28T12:30:00.000Z'),
    });
    const [oldest] = await history.list();
    await issued(history, oldest!.record as GateDecisionRecord);

    const latest = await latestGateDecision(history, FIXTURE_GATE_ID);
    expect(latest?.record).toEqual(newest);
    expect(await latestGateDecision(history, 'never-run')).toBeUndefined();
  });
});

describe('PROMOTION_SIGNAL_EXIT_CODES', () => {
  test('exits 0 issued or valid, 3 without sufficient evidence, 5 stale, 64 usage, 65 corrupt', () => {
    expect(PROMOTION_SIGNAL_EXIT_CODES).toEqual({
      issued: 0,
      valid: 0,
      'insufficient-evidence': 3,
      expired: 3,
      unresolvable: 3,
      stale: 5,
      'usage-error': 64,
      'corrupt-record': 65,
    });
  });
});
