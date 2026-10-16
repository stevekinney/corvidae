import { beforeAll, describe, expect, test } from 'bun:test';

import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing';

import { decideAdmission } from './admission';
import { bindComparison, runComparison } from './comparison';
import {
  admissionFromEvidence,
  BINDING_CHANGES,
  type BindingChange,
  COMPARISON_EVIDENCE_SCHEMA_VERSION,
  type ComparisonEvidence,
  comparisonEvidenceDigest,
  comparisonEvidenceSchema,
  recordedSeeds,
  toComparisonEvidence,
  verifyComparisonEvidence,
} from './comparison-evidence';
import { EvaluatorConfigurationError } from './configuration';
import { admissionRuleInput } from './fixtures/comparison/rules';
import {
  comparisonEvaluator,
  comparisonEvaluatorConfiguration,
  type ComparisonScenario,
  fixtureRuntime,
  vaultCodeScenario,
} from './fixtures/comparison/scenarios';
import { canonicalJson } from './identity';

type Mutable = Record<string, any>;

const RECORDED_AT = '2026-09-28T12:00:00.000Z';

async function evidenceFor(scenario: ComparisonScenario): Promise<ComparisonEvidence> {
  const comparison = await runComparison(scenario);
  const admission = await decideAdmission(admissionRuleInput(), comparison);
  return toComparisonEvidence({ comparison, admission, recordedAt: RECORDED_AT });
}

let evidence: ComparisonEvidence;

beforeAll(async () => {
  evidence = await evidenceFor(await vaultCodeScenario());
});

/** The vault scenario with one input changed, as a later comparison would declare it. */
async function changed(change: (draft: Mutable) => unknown): Promise<ComparisonScenario> {
  const base = await vaultCodeScenario();
  const draft = {
    ...base,
    definition: structuredClone(base.definition),
    plans: structuredClone(base.plans),
  } as Mutable;
  await change(draft);
  return draft as ComparisonScenario;
}

describe('the comparison evidence artifact', () => {
  test('is a versioned, machine-readable document holding the binding, every case, and the admission', async () => {
    expect(evidence.kind).toBe('collaboration-comparison-evidence');
    expect(evidence.schemaVersion).toBe(COMPARISON_EVIDENCE_SCHEMA_VERSION);
    expect(evidence.id).toBe(`vault-code-${evidence.revision.slice(0, 12)}`);
    expect(evidence.recordedAt).toBe(RECORDED_AT);
    expect(evidence.admission.decision).toBe('admit');
    expect(evidence.cases).toHaveLength(1);
    expect(comparisonEvidenceSchema.safeParse(evidence).success).toBe(true);
    const roundTripped = await verifyComparisonEvidence(JSON.parse(JSON.stringify(evidence)));
    expect(roundTripped).toEqual(evidence);
  });

  test('refuses evidence whose revision does not match its binding, or that does not parse', async () => {
    const tampered = structuredClone(evidence) as Mutable;
    tampered['binding'].trials = 5;
    expect(await throwingRejectionOf(verifyComparisonEvidence(tampered))).toThrow(
      'revision: The evidence revision does not match its binding',
    );
    expect(await rejectionOf(verifyComparisonEvidence({ kind: 'something-else' }))).toBeInstanceOf(
      EvaluatorConfigurationError,
    );
  });

  test('refuses an admission for another task class than the comparison ran', async () => {
    const comparison = await runComparison(await vaultCodeScenario());
    const admission = await decideAdmission(admissionRuleInput(), comparison);
    const foreign = { ...admission, taskClass: 'shared-state' as const };
    expect(() =>
      toComparisonEvidence({ comparison, admission: foreign, recordedAt: RECORDED_AT }),
    ).toThrow('The admission decided shared-state, but the comparison ran partitioned-search');
  });

  test('is byte-identical, digest included, when the comparison reruns from the same seeds', async () => {
    const again = await evidenceFor(await vaultCodeScenario(fixtureRuntime()));
    expect(canonicalJson(again)).toBe(canonicalJson(evidence));
    expect(await comparisonEvidenceDigest(again)).toBe(await comparisonEvidenceDigest(evidence));
    expect(await comparisonEvidenceDigest(evidence)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('gives back its recorded seeds, keyed by case id, for a replay', async () => {
    const scenario = await vaultCodeScenario(fixtureRuntime('a-different-seed'));
    const seeds = await recordedSeeds(evidence, scenario.dataset);
    expect(seeds).toEqual({ 'partitioned-search-vault-code': evidence.cases[0]!.seeds });
    const replayed = await evidenceFor({ ...scenario, seeds });
    expect(canonicalJson(replayed)).toBe(canonicalJson(evidence));
    // Seeds are placed by ordinal, so they only map back onto the very dataset they came from.
    expect(
      await throwingRejectionOf(
        recordedSeeds(evidence, { ...(scenario.dataset as Mutable), version: 'another-version' }),
      ),
    ).toThrow('dataset: The evidence was recorded against another dataset');
  });
});

describe('admissionFromEvidence', () => {
  test('returns the recorded admission when nothing it was bound to has changed', async () => {
    const current = await bindComparison(await vaultCodeScenario());
    expect(
      await admissionFromEvidence(evidence, { comparison: current, rule: admissionRuleInput() }),
    ).toEqual({
      status: 'current',
      admission: evidence.admission,
    });
  });

  const bumps: readonly [BindingChange, (draft: Mutable) => unknown][] = [
    ['model', (draft) => (draft['definition'].agents[0].model = 'claude-opus-4-20250514')],
    ['model', (draft) => (draft['definition'].agents[0].effort = 'high')],
    ['prompt', (draft) => (draft['definition'].agents[1].promptRevision = 'sampler-1-prompt-2')],
    [
      'agent-definition',
      (draft) => (draft['definition'].agents[2].definitionRevision = 'sampler-2-definition-2'),
    ],
    ['tool', (draft) => (draft['definition'].tools[0].revision = 'ledger-lookup-2')],
    [
      'evaluator',
      async (draft) => {
        draft['evaluator'] = await comparisonEvaluator({
          ...comparisonEvaluatorConfiguration(),
          revision: 2,
        });
      },
    ],
    [
      'topology',
      (draft) => {
        draft['plans'].collaboration.topology.maximumRounds = 6;
        draft['plans'].collaboration.topology.edges[0].reason = 'Reports its shard first.';
      },
    ],
    [
      'policy',
      (draft) => {
        for (const plan of Object.values(draft['plans']) as Mutable[]) {
          plan['policyVersion'] = 'collaboration-policy-2026-10';
        }
      },
    ],
    ['aggregation', (draft) => (draft['definition'].aggregation.version = '2')],
    [
      'verification',
      (draft) => {
        draft['plans'].collaboration.stageVerifiers = [
          {
            stageId: 'reduce',
            boundAt: 'handoff-creation',
            acceptanceCriteria: 'Every shard reported a digit.',
            rejector: ['reducer'],
            onFailure: 'terminal',
            retryBudget: 0,
          },
        ];
      },
    ],
    [
      'budget',
      (draft) => {
        for (const plan of Object.values(draft['plans']) as Mutable[]) {
          plan['resourceEnvelope'].costCents = 75;
        }
      },
    ],
    [
      'context-projection',
      (draft) => (draft['plans'].collaboration.contextProjections[0].sources[0].revision = '2'),
    ],
    [
      'commit-authority',
      (draft) => (draft['plans'].collaboration.artifacts[0].commitAuthority = 'searcher-a'),
    ],
    ['data', (draft) => (draft['definition'].dataRevision = 'collaboration-comparison-data-2')],
    ['concurrency', (draft) => (draft['definition'].concurrency = 1)],
    ['stopping-rule', (draft) => (draft['definition'].stoppingRule.version = '2')],
    [
      'compute-match',
      (draft) =>
        (draft['definition'].computeMatch = {
          kind: 'equivalent-compute',
          reason: 'Four samplers spend what four participants do.',
        }),
    ],
    [
      'task',
      (draft) => {
        for (const plan of Object.values(draft['plans']) as Mutable[]) {
          plan['task'].successContractRevision = 'comparison-success-2';
        }
      },
    ],
    ['plan', (draft) => (draft['plans'].collaboration.planRevision = 2)],
    ['comparison', (draft) => (draft['definition'].id = 'vault-code-rerun')],
  ];

  for (const [change, bump] of bumps) {
    test(`a ${change} change versions the evidence instead of reusing its admission`, async () => {
      const current = await bindComparison(await changed(bump));
      expect(current.revision).not.toBe(evidence.revision);
      const outcome = await admissionFromEvidence(evidence, {
        comparison: current,
        rule: admissionRuleInput(),
      });
      expect(outcome.status).toBe('stale');
      expect(outcome.status === 'stale' && outcome.changes).toContain(change);
    });
  }

  test('a revised admission rule also makes the recorded admission stale', async () => {
    const current = await bindComparison(await vaultCodeScenario());
    const rule = admissionRuleInput();
    rule['version'] = '2';
    expect(await admissionFromEvidence(evidence, { comparison: current, rule })).toEqual({
      status: 'stale',
      changes: ['admission-rule'],
    });
  });

  test('a different dataset or trial count is a change too', async () => {
    const current = await bindComparison(await vaultCodeScenario());
    const moved = structuredClone(current) as Mutable;
    moved['binding'].dataset.digest = '0'.repeat(64);
    moved['binding'].trials = 5;
    moved['binding'].cases = [
      { ordinal: 1, visibility: 'public', caseId: 'direct-multiplication' },
    ];
    const outcome = await admissionFromEvidence(evidence, {
      comparison: moved as never,
      rule: admissionRuleInput(),
    });
    expect(outcome).toEqual({ status: 'stale', changes: ['dataset', 'cases', 'trials'] });
  });

  test('names every kind of change it can detect', () => {
    expect(BINDING_CHANGES).toEqual([
      'comparison',
      'model',
      'prompt',
      'agent-definition',
      'tool',
      'data',
      'evaluator',
      'dataset',
      'cases',
      'trials',
      'concurrency',
      'compute-match',
      'aggregation',
      'stopping-rule',
      'task',
      'topology',
      'context-projection',
      'commit-authority',
      'verification',
      'policy',
      'budget',
      'plan',
      'admission-rule',
    ]);
  });
});
