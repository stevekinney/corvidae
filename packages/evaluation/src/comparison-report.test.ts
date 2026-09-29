import { beforeAll, describe, expect, test } from 'bun:test';

import { decideAdmission } from './admission';
import { runComparison } from './comparison';
import {
  comparisonEvidenceDigest,
  toComparisonEvidence,
  type ComparisonEvidence,
} from './comparison-evidence';
import { REPORT_METRICS, renderComparisonReport } from './comparison-report';
import { admissionRuleInput } from './fixtures/comparison/rules';
import { negativeControlScenario, vaultCodeScenario } from './fixtures/comparison/scenarios';

type Mutable = Record<string, any>;

let admitted: ComparisonEvidence;
let rejected: ComparisonEvidence;
let unmeasured: ComparisonEvidence;
let partial: ComparisonEvidence;

async function evidenceOf(
  scenario: Awaited<ReturnType<typeof vaultCodeScenario>>,
  taskClass: string,
): Promise<ComparisonEvidence> {
  const comparison = await runComparison(scenario);
  const admission = await decideAdmission(admissionRuleInput(taskClass), comparison);
  return toComparisonEvidence({
    comparison,
    admission,
    recordedAt: '2026-09-28T12:00:00.000Z',
  });
}

/** The vault-code scenario, with a collaboration subject that throws on the named trials. */
async function crashingCollaboration(
  crashes: (trial: number) => boolean,
): Promise<Awaited<ReturnType<typeof vaultCodeScenario>>> {
  const scenario = await vaultCodeScenario();
  const { collaboration } = scenario.subjects;
  return {
    ...scenario,
    subjects: {
      ...scenario.subjects,
      collaboration: async (context) => {
        if (crashes(context.trial)) throw new Error('The collaboration runtime crashed');
        return collaboration(context);
      },
    },
  };
}

beforeAll(async () => {
  admitted = await evidenceOf(await vaultCodeScenario(), 'partitioned-search');
  rejected = await evidenceOf(await negativeControlScenario(), 'direct');
  unmeasured = await evidenceOf(await crashingCollaboration(() => true), 'partitioned-search');
  partial = await evidenceOf(
    await crashingCollaboration((trial) => trial === 2),
    'partitioned-search',
  );
});

function row(report: string, metric: string): string {
  const line = report.split('\n').find((candidate) => candidate.startsWith(`| ${metric} |`));
  if (line === undefined) throw new Error(`No "${metric}" row`);
  return line;
}

describe('renderComparisonReport', () => {
  test('heads the report with the comparison, its evidence identity, and the admission decision', async () => {
    const digest = await comparisonEvidenceDigest(admitted);
    const report = renderComparisonReport(admitted, digest);
    expect(report).toStartWith('# Collaboration comparison: vault-code\n');
    expect(report).toContain(`- Evidence: \`${admitted.id}\`, recorded 2026-09-28T12:00:00.000Z`);
    expect(report).toContain(`- Revision: \`${admitted.revision}\``);
    expect(report).toContain(`- Digest: \`${digest}\``);
    expect(report).toContain(
      '- Decision: **admit** (exit 0) for partitioned-search under rule `fixture-admission` version 1',
    );
    expect(report).toContain('- Authoritative profile: collaboration');
    expect(report).toContain('No findings.');
  });

  test('describes the binding: evaluator, dataset, trials, rules, agents, tools, plans, and envelope', () => {
    const report = renderComparisonReport(admitted, 'digest');
    const { binding } = admitted;
    expect(report).toContain(
      `- Evaluator: collaboration-comparison revision 1 (\`${binding.evaluator.digest}\`)`,
    );
    expect(report).toContain(
      `- Dataset: collaboration-comparison version collaboration-comparison-2026-09 (\`${binding.dataset.digest}\`)`,
    );
    expect(report).toContain('- Trials per case and profile: 3; ensemble concurrency: 2');
    expect(report).toContain('- Compute match: participant count');
    expect(report).toContain('- Aggregation: majority-vote `majority-vote` version 1');
    expect(report).toContain(
      '- Stopping rule: `commit-or-exhaust` version 1: Stop once the commit authority commits or the round budget is spent.',
    );
    expect(report).toContain('- Data revision: collaboration-comparison-data-1');
    expect(report).toContain(
      '| solver | claude-sonnet-4-20250514 | medium | solver-definition-1 | solver-prompt-1 | ledger_lookup |',
    );
    expect(report).toContain('| ledger_lookup | ledger-lookup-1 |');
    expect(report).toContain(
      '| collaboration | partitioned-search-plan | 1 | collaboration-policy-2026-09 | 4 | 3 | 0 | 4 |',
    );
    expect(report).toContain(
      '- Resource envelope: 20000 tokens, 50 cents, 60000 ms, 40 steps, fan-out 4, 4 descendants',
    );
  });

  test('separates every metric per profile for each case', () => {
    const report = renderComparisonReport(admitted, 'digest');
    expect(report).toContain('## Case 3: partitioned-search-vault-code');
    expect(report).toContain('Task class: partitioned-search. Controls: distributed-information.');
    expect(report).toContain(`Seeds: ${admitted.cases[0]!.seeds.join(', ')}.`);
    expect(report).toContain(
      '| Metric | direct-agent | compute-matched-ensemble | collaboration |',
    );
    for (const metric of REPORT_METRICS) row(report, metric);
    expect(REPORT_METRICS).toEqual([
      'Trials with runs',
      'Evaluator outcome',
      'Task success',
      'Verifier acceptance',
      'Cost (USD)',
      'Latency (mean ms)',
      'Tokens',
      'Tool calls',
      'Steps',
      'Coordination tokens',
      'Coordination turns',
      'Ungoverned writes',
      'Duplicate work',
      'Message novelty',
      'Corrected false claims',
      'Unresolved contradictions',
      'Stale reads',
      'Retries',
      'Replans',
      'Propagated faults',
      'Cleanup',
      'Failure labels',
      'Envelope breaches',
    ]);
    expect(row(report, 'Trials with runs')).toBe('| Trials with runs | 3 of 3 | 3 of 3 | 3 of 3 |');
    expect(row(report, 'Task success')).toBe(
      '| Task success | 0/3 (0.00; 95% 0.00-0.56) | 0/3 (0.00; 95% 0.00-0.56) | 3/3 (1.00; 95% 0.44-1.00) |',
    );
    expect(row(report, 'Cost (USD)')).toBe('| Cost (USD) | 0.008100 | 0.032400 | 0.032400 |');
    expect(row(report, 'Latency (mean ms)')).toBe('| Latency (mean ms) | 250 | 1000 | 1000 |');
    expect(row(report, 'Coordination turns')).toBe('| Coordination turns | 0 | 0 | 9 |');
    expect(row(report, 'Duplicate work')).toBe('| Duplicate work | 0 | 9 | 0 |');
    expect(row(report, 'Message novelty')).toBe('| Message novelty | none | none | 1.00 |');
    expect(row(report, 'Cleanup')).toBe('| Cleanup | quiescent | quiescent | quiescent |');
    expect(row(report, 'Failure labels')).toBe('| Failure labels | none | none | none |');
  });

  test('lists findings, the fallback, held-out cases, cleanup, failure labels, and breaches', () => {
    const edited = structuredClone(rejected) as Mutable;
    const entry = edited['cases'][0];
    entry.visibility = 'held-out';
    delete entry.caseId;
    const collaboration = entry.profiles.collaboration;
    collaboration.totals = {
      ...collaboration.totals,
      costUsd: null,
      cleanup: 'abandoned',
      failureLabels: [{ label: 'prompt-infection', count: 2 }],
      envelopeBreaches: [{ breach: 'tokens', count: 1 }],
    };
    collaboration.trials[0].cleanup = {
      state: 'abandoned',
      detached: [],
      abandoned: ['finisher'],
    };
    collaboration.trials[1].cleanup = {
      state: 'detached',
      detached: [{ participant: 'drafter', workItem: 'draft-archive', reason: 'Archived later.' }],
      abandoned: [],
    };
    edited['binding'].definition.computeMatch = {
      kind: 'equivalent-compute',
      reason: 'Two samplers spend what two participants do.',
    };
    const report = renderComparisonReport(edited as ComparisonEvidence, 'digest');
    expect(report).toContain(
      '- Decision: **reject** (exit 1) for direct under rule `fixture-admission` version 1',
    );
    expect(report).toContain(
      '- Authoritative profile: direct-agent (fallback: One strong agent is the floor.)',
    );
    expect(report).toContain('- quality, insufficient-success-gain: Collaboration task success');
    expect(report).toContain('## Case 1 (held out)');
    expect(report).not.toContain('direct-multiplication');
    expect(report).toContain(
      '- Compute match: equivalent compute: Two samplers spend what two participants do.',
    );
    const cells = (metric: string) => row(report, metric).split(' | ').at(-1);
    // A run without a cost estimate leaves the cost unknown while its other metrics stand.
    expect(cells('Trials with runs')).toBe('3 of 3 |');
    expect(cells('Cost (USD)')).toBe('unknown |');
    expect(cells('Tokens')).toBe('3000 |');
    expect(cells('Cleanup')).toBe('abandoned (finisher); detached (drafter as draft-archive) |');
    expect(cells('Failure labels')).toBe('prompt-infection x2 |');
    expect(cells('Envelope breaches')).toBe('tokens x1 |');
  });

  test('shows every metric of a profile whose trials all crashed as unknown, never as zero', () => {
    const report = renderComparisonReport(unmeasured, 'digest');
    const collaboration = (metric: string) => row(report, metric).split(' | ').at(-1);
    expect(collaboration('Trials with runs')).toBe('0 of 3 |');
    expect(collaboration('Evaluator outcome')).toBe('indeterminate |');
    expect(collaboration('Task success')).toBe('no trials |');
    for (const metric of [
      'Cost (USD)',
      'Latency (mean ms)',
      'Tokens',
      'Tool calls',
      'Steps',
      'Coordination tokens',
      'Coordination turns',
      'Ungoverned writes',
      'Duplicate work',
      'Message novelty',
      'Corrected false claims',
      'Unresolved contradictions',
      'Stale reads',
      'Retries',
      'Replans',
      'Propagated faults',
      'Cleanup',
      'Failure labels',
      'Envelope breaches',
    ]) {
      expect(`${metric}: ${collaboration(metric)}`).toBe(`${metric}: unknown |`);
    }
    // The other profiles ran, so their measured zeros and absences still read as such.
    expect(row(report, 'Trials with runs')).toBe('| Trials with runs | 3 of 3 | 3 of 3 | 0 of 3 |');
    expect(row(report, 'Coordination turns')).toBe('| Coordination turns | 0 | 0 | unknown |');
    expect(row(report, 'Message novelty')).toBe('| Message novelty | none | none | unknown |');
    expect(row(report, 'Failure labels')).toBe('| Failure labels | none | none | unknown |');
  });

  test('labels totals that cover only the trials whose run finished', () => {
    const report = renderComparisonReport(partial, 'digest');
    expect(row(report, 'Trials with runs')).toBe('| Trials with runs | 3 of 3 | 3 of 3 | 2 of 3 |');
    expect(row(report, 'Task success')).toBe(
      '| Task success | 0/3 (0.00; 95% 0.00-0.56) | 0/3 (0.00; 95% 0.00-0.56) | 2/2 (1.00; 95% 0.34-1.00) |',
    );
    expect(row(report, 'Tokens')).toBe('| Tokens | 1500 | 6000 | 4000 |');
    expect(row(report, 'Coordination turns')).toBe('| Coordination turns | 0 | 0 | 6 |');
  });
});
