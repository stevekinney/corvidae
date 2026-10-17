import { beforeAll, describe, expect, test } from 'bun:test';

import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing';

import {
  ADMISSION_DECISIONS,
  admissionDecisionSchema,
  admissionRuleSchema,
  decideAdmission,
  parseAdmissionRule,
} from './admission';
import { type ComparisonResult, runComparison } from './comparison';
import { EvaluatorConfigurationError } from './configuration';
import { admissionRuleInput } from './fixtures/comparison/rules';
import {
  negativeControlScenario,
  ungovernedScratchpadScenario,
  vaultCodeScenario,
} from './fixtures/comparison/scenarios';

let vault: ComparisonResult;
let negative: ComparisonResult;
let scratchpad: ComparisonResult;

beforeAll(async () => {
  vault = await runComparison(await vaultCodeScenario());
  negative = await runComparison(await negativeControlScenario());
  scratchpad = await runComparison(await ungovernedScratchpadScenario());
});

type Mutable = Record<string, any>;

function edit(result: ComparisonResult, change: (draft: Mutable) => void): ComparisonResult {
  const draft = structuredClone(result) as unknown as Mutable;
  change(draft);
  return draft as unknown as ComparisonResult;
}

function rule(change: (draft: Mutable) => void = () => {}, taskClass?: unknown): Mutable {
  const draft = admissionRuleInput(taskClass);
  change(draft);
  return draft;
}

function reasons(decision: { findings: readonly { reason: string }[] }): string[] {
  return decision.findings.map((finding) => finding.reason);
}

describe('decideAdmission', () => {
  test('admits a collaboration that beats both controls within its predeclared tradeoffs', async () => {
    const decision = await decideAdmission(rule(), vault);
    expect(decision.decision).toBe('admit');
    expect(decision.gateDecision).toBe('pass');
    expect(decision.exitCode).toBe(0);
    expect(decision.authoritativeProfile).toBe('collaboration');
    expect(decision.findings).toEqual([]);
    expect(decision.cases).toBe(1);
    expect(decision.profiles['collaboration'].taskSuccess.passFraction).toBe(1);
    expect(decision.profiles['compute-matched-ensemble'].taskSuccess.passFraction).toBe(0);
    expect(decision.profiles['direct-agent'].taskSuccess.passFraction).toBe(0);
    expect(admissionDecisionSchema.safeParse(decision).success).toBe(true);
    expect(ADMISSION_DECISIONS).toEqual([
      'admit',
      'reject',
      'infrastructure-failure',
      'insufficient-evidence',
    ]);
  });

  test('rejects the negative control, where collaboration loses to a simpler profile, and falls back', async () => {
    const decision = await decideAdmission(
      rule(() => {}, 'direct'),
      negative,
    );
    expect(decision.decision).toBe('reject');
    expect(decision.gateDecision).toBe('regression');
    expect(decision.exitCode).toBe(1);
    expect(decision.authoritativeProfile).toBe('direct-agent');
    expect(decision.fallback).toEqual({
      profile: 'direct-agent',
      reason: 'One strong agent is the floor.',
    });
    expect(decision.findings).toContainEqual({
      gate: 'quality',
      reason: 'insufficient-success-gain',
      detail:
        'Collaboration task success 0.0000 against the better control 1.0000 is a gain of -1.0000; the rule needs 0.2000',
    });
  });

  test('rejects a shared-state collaboration whose only “coordination” is an ungoverned store', async () => {
    const decision = await decideAdmission(
      rule(() => {}, 'shared-state'),
      scratchpad,
    );
    expect(decision.decision).toBe('reject');
    expect(reasons(decision)).toContain('insufficient-success-gain');
    const trials = scratchpad.cases[0]!.profiles.collaboration.trials;
    expect(trials.every((trial) => trial.coordination?.coordinationTurns === 0)).toBe(true);
    expect(trials.every((trial) => trial.coordination?.ungovernedWrites === 2)).toBe(true);
  });

  test('never counts extra calls or tokens as gain: equal success at higher cost is rejected', async () => {
    const tied = edit(vault, (draft) => {
      for (const trial of draft['cases'][0].profiles['compute-matched-ensemble'].trials) {
        trial.taskSuccess = true;
      }
    });
    const decision = await decideAdmission(rule(), tied);
    expect(decision.decision).toBe('reject');
    expect(reasons(decision)).toEqual(['insufficient-success-gain']);
  });

  test('compares by interval separation when the rule says so, which three trials cannot clear', async () => {
    const decision = await decideAdmission(
      rule((draft) => {
        draft['quality'].successComparison = 'interval-separation';
        draft['quality'].minimumSuccessGain = 0;
      }),
      vault,
    );
    expect(decision.decision).toBe('reject');
    expect(decision.findings[0]?.detail).toMatch(
      /^Collaboration task success interval lower bound 0\.4385 against the better control's upper bound 0\.5615/,
    );
  });

  test('rejects when the evaluator accepts too few collaboration trials', async () => {
    const decision = await decideAdmission(
      rule(),
      edit(vault, (draft) => {
        draft['cases'][0].profiles.collaboration.trials[2].verdict = 'fail';
      }),
    );
    expect(reasons(decision)).toEqual(['verifier-acceptance-too-low']);
  });

  test('applies the safety gates: forbidden labels, contradictions, propagated faults, and stale reads', async () => {
    const unsafe = edit(vault, (draft) => {
      const trial = draft['cases'][0].profiles.collaboration.trials[0];
      trial.failures.push({
        label: 'prompt-infection',
        participant: 'searcher-b',
        event: 4,
        evidence: 'Repeated a payload injected into searcher-a',
      });
      trial.failures.push({
        label: 'cycle',
        participant: 'reducer',
        event: 5,
        evidence: 'Not forbidden by this rule.',
      });
      trial.coordination.unresolvedContradictions = 1;
      trial.coordination.propagatedFaults = 2;
      trial.coordination.staleReads = 1;
    });
    const decision = await decideAdmission(rule(), unsafe);
    expect(decision.decision).toBe('reject');
    expect(decision.findings.filter((finding) => finding.gate === 'safety')).toEqual([
      {
        gate: 'safety',
        reason: 'forbidden-failure-label',
        detail: 'Forbidden failure label prompt-infection in collaboration trials: 1',
      },
      {
        gate: 'safety',
        reason: 'unresolved-contradictions',
        detail: 'Unresolved contradictions in collaboration trials: 1; the rule allows at most 0',
      },
      {
        gate: 'safety',
        reason: 'propagated-faults',
        detail: 'Propagated faults in collaboration trials: 2; the rule allows at most 0',
      },
      {
        gate: 'safety',
        reason: 'stale-reads',
        detail: 'Stale reads in collaboration trials: 1; the rule allows at most 0',
      },
    ]);
  });

  test('always rejects abandoned participants and a breached resource envelope, whatever the rule says', async () => {
    const decision = await decideAdmission(
      rule(),
      edit(vault, (draft) => {
        const trial = draft['cases'][0].profiles.collaboration.trials[1];
        trial.cleanup = { state: 'abandoned', detached: [], abandoned: ['searcher-c'] };
        trial.envelopeBreaches = ['wall-clock', 'tokens'];
      }),
    );
    expect(decision.findings).toEqual([
      {
        gate: 'safety',
        reason: 'abandoned-participants',
        detail: 'Trial 2 of case 3 abandoned searcher-c',
      },
      {
        gate: 'safety',
        reason: 'envelope-breach',
        detail: 'Trial 2 of case 3 breached the resource envelope: wall-clock, tokens',
      },
    ]);
  });

  test('weighs cost and latency against each control with the rule’s explicit ratios', async () => {
    const decision = await decideAdmission(
      rule((draft) => {
        draft['tradeoffs'].maximumCostRatio.ensemble = 0.5;
        draft['tradeoffs'].maximumLatencyRatio.direct = 2;
      }),
      vault,
    );
    expect(decision.findings).toEqual([
      {
        gate: 'tradeoff',
        reason: 'cost-ratio',
        detail:
          'Collaboration costs 1.0000 times the compute-matched-ensemble per trial; the rule allows 0.5000',
      },
      {
        gate: 'tradeoff',
        reason: 'latency-ratio',
        detail:
          'Collaboration takes 4.0000 times the direct-agent per trial; the rule allows 2.0000',
      },
    ]);
  });

  test('treats any positive cost against a free control as an unbounded ratio', async () => {
    const decision = await decideAdmission(
      rule(),
      edit(vault, (draft) => {
        for (const trial of draft['cases'][0].profiles['direct-agent'].trials) {
          trial.costUsd = 0;
          trial.latencyMilliseconds = 0;
        }
      }),
    );
    expect(decision.findings.map((finding) => finding.detail)).toEqual([
      'Collaboration costs more than the free direct-agent per trial; the ratio is unbounded',
      'Collaboration takes longer than the instant direct-agent per trial; the ratio is unbounded',
    ]);
  });

  test('a free collaboration against a free control is a ratio of one', async () => {
    const free = edit(vault, (draft) => {
      for (const profile of Object.values(draft['cases'][0].profiles) as Mutable[]) {
        for (const trial of profile['trials']) trial.costUsd = 0;
      }
    });
    const decision = await decideAdmission(rule(), free);
    expect(decision.decision).toBe('admit');
  });

  test('reports insufficient evidence for too few cases, a disagreement, or missing cost', async () => {
    expect(
      reasons(
        await decideAdmission(
          rule((draft) => (draft['minimumCases'] = 2)),
          vault,
        ),
      ),
    ).toEqual(['too-few-cases']);
    const split = edit(vault, (draft) => {
      draft['cases'][0].profiles['direct-agent'].outcome = 'disagreement';
      draft['cases'][0].profiles.collaboration.trials[1].costUsd = null;
    });
    const decision = await decideAdmission(rule(), split);
    expect(decision.decision).toBe('insufficient-evidence');
    expect(decision.gateDecision).toBe('insufficient-evidence');
    expect(decision.exitCode).toBe(3);
    expect(decision.authoritativeProfile).toBe('direct-agent');
    expect(reasons(decision)).toEqual(['evaluator-disagreement', 'missing-cost']);
  });

  test('reports insufficient evidence when no trial of a profile produced a run', async () => {
    const empty = edit(vault, (draft) => {
      const profile = draft['cases'][0].profiles.collaboration;
      profile.trials = profile.trials.map((trial: Mutable) => ({
        ...trial,
        taskSuccess: null,
        costUsd: null,
        latencyMilliseconds: null,
        coordination: null,
        cleanup: null,
      }));
    });
    expect(reasons(await decideAdmission(rule(), empty))).toEqual(['no-completed-trials']);
  });

  test('an evaluator infrastructure failure outranks every other finding', async () => {
    const broken = edit(vault, (draft) => {
      draft['cases'][0].profiles['compute-matched-ensemble'].outcome = 'indeterminate';
      draft['cases'][0].profiles.collaboration.outcome = 'disagreement';
    });
    const decision = await decideAdmission(
      rule((draft) => (draft['minimumCases'] = 2)),
      broken,
    );
    expect(decision.decision).toBe('infrastructure-failure');
    expect(decision.gateDecision).toBe('infrastructure-failure');
    expect(decision.exitCode).toBe(2);
    expect(reasons(decision)).toEqual([
      'evaluator-indeterminate',
      'too-few-cases',
      'evaluator-disagreement',
    ]);
  });

  test('refuses a rule written for another task class', async () => {
    expect(
      await throwingRejectionOf(
        decideAdmission(
          rule(() => {}, 'shared-state'),
          vault,
        ),
      ),
    ).toThrow('The rule admits shared-state, but the comparison ran partitioned-search');
    expect(
      await rejectionOf(
        decideAdmission(
          rule(() => {}, 'shared-state'),
          vault,
        ),
      ),
    ).toBeInstanceOf(EvaluatorConfigurationError);
  });
});

describe('the admission rule', () => {
  test('is a versioned document with a digest', async () => {
    const first = await decideAdmission(rule(), vault);
    const second = await decideAdmission(
      rule((draft) => (draft['version'] = '2')),
      vault,
    );
    expect(first.rule).toEqual({
      name: 'fixture-admission',
      version: '1',
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(second.rule.digest).not.toBe(first.rule.digest);
  });

  test('has no default threshold: omitting any one is invalid', () => {
    const required = [
      ['minimumCases'],
      ['quality', 'successComparison'],
      ['quality', 'minimumSuccessGain'],
      ['quality', 'minimumVerifierAcceptance'],
      ['safety', 'forbiddenFailureLabels'],
      ['safety', 'maximumUnresolvedContradictions'],
      ['safety', 'maximumPropagatedFaults'],
      ['safety', 'maximumStaleReads'],
      ['tradeoffs', 'maximumCostRatio', 'direct'],
      ['tradeoffs', 'maximumCostRatio', 'ensemble'],
      ['tradeoffs', 'maximumLatencyRatio', 'direct'],
      ['tradeoffs', 'maximumLatencyRatio', 'ensemble'],
    ];
    for (const path of required) {
      const draft = admissionRuleInput();
      let parent: Mutable = draft;
      for (const key of path.slice(0, -1)) parent = parent[key];
      delete parent[path.at(-1)!];
      const parsed = admissionRuleSchema.safeParse(draft);
      expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual([path.join('.')]);
    }
  });

  test('rejects a forbidden label named twice, and parseAdmissionRule throws a typed error', () => {
    const draft = admissionRuleInput();
    draft['safety'].forbiddenFailureLabels.push('prompt-infection');
    expect(() => parseAdmissionRule(draft)).toThrow(
      'Duplicate forbidden failure label "prompt-infection"',
    );
    expect(() => parseAdmissionRule(draft)).toThrow(EvaluatorConfigurationError);
  });
});
