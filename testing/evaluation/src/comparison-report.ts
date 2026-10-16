/**
 * The human-readable comparison report (COR-818): Markdown rendered from the
 * same evidence artifact a machine reads, so the two can never disagree.
 *
 * It heads with the evidence identity and the admission decision, lists the
 * findings, describes everything the comparison bound, and then, for each
 * case, puts every metric in its own row with one column per profile: how
 * many trials finished a run (every total covers those alone), task success
 * and verifier acceptance kept apart, cost, latency, tokens, tool calls,
 * steps, coordination tokens and turns, ungoverned writes, duplicate work,
 * message novelty, corrected false claims, unresolved contradictions, stale
 * reads, retries, replans, propagated faults, cleanup, failure labels, and
 * envelope breaches. Missing evidence is shown as `unknown`, never as a zero
 * or a `none`. A held-out case appears by ordinal alone.
 */
import { EXECUTION_PROFILES, taskClassKey } from './collaboration-plan';
import type { CaseComparison, ProfileResult } from './comparison';
import type { ComparisonEvidence } from './comparison-evidence';
import type { TrialStatistics } from './variance';

type Cell = (profile: ProfileResult) => string;

function statistics(value: TrialStatistics): string {
  const { passFraction, wilsonInterval } = value;
  if (passFraction === null || wilsonInterval === null) return 'no trials';
  const interval = `${wilsonInterval.lower.toFixed(2)}-${wilsonInterval.upper.toFixed(2)}`;
  return `${value.passes}/${value.trials} (${passFraction.toFixed(2)}; 95% ${interval})`;
}

function orUnknown(value: number | null, format: (value: number) => string): string {
  return value === null ? 'unknown' : format(value);
}

function cleanup(profile: ProfileResult): string {
  const abandoned = [...new Set(profile.trials.flatMap((trial) => trial.cleanup?.abandoned ?? []))];
  const detached = profile.trials.flatMap((trial) =>
    (trial.cleanup?.detached ?? []).map((entry) => `${entry.participant} as ${entry.workItem}`),
  );
  const parts: string[] = [];
  if (abandoned.length > 0) parts.push(`abandoned (${abandoned.join(', ')})`);
  if (detached.length > 0) parts.push(`detached (${[...new Set(detached)].join(', ')})`);
  return parts.length > 0 ? parts.join('; ') : (profile.totals.cleanup ?? 'unknown');
}

/** Named occurrence counts: `none` when trials ran without any, `unknown` when none ran. */
function counted<Entry extends { readonly count: number }>(
  entries: readonly Entry[] | null,
  name: (entry: Entry) => string,
): string {
  if (entries === null) return 'unknown';
  return entries.length === 0
    ? 'none'
    : entries.map((entry) => `${name(entry)} x${entry.count}`).join(', ');
}

/** A summed count: `unknown` when no trial finished a run to count it. */
function total(metric: (totals: ProfileResult['totals']) => number | null): Cell {
  return (profile) => orUnknown(metric(profile.totals), String);
}

/** Novelty is `none` when trials ran but sent no messages, `unknown` when none ran. */
function novelty(profile: ProfileResult): string {
  const { messageNovelty, trialsWithRuns } = profile.totals;
  if (messageNovelty !== null) return messageNovelty.toFixed(2);
  return trialsWithRuns === 0 ? 'unknown' : 'none';
}

const METRICS: readonly (readonly [string, Cell])[] = [
  ['Trials with runs', (profile) => `${profile.totals.trialsWithRuns} of ${profile.trials.length}`],
  ['Evaluator outcome', (profile) => profile.outcome],
  ['Task success', (profile) => statistics(profile.taskSuccess)],
  ['Verifier acceptance', (profile) => statistics(profile.verifierAcceptance)],
  ['Cost (USD)', (profile) => orUnknown(profile.totals.costUsd, (value) => value.toFixed(6))],
  [
    'Latency (mean ms)',
    (profile) => orUnknown(profile.totals.latencyMillisecondsMean, (value) => value.toFixed(0)),
  ],
  ['Tokens', total((totals) => totals.tokens)],
  ['Tool calls', total((totals) => totals.toolCalls)],
  ['Steps', total((totals) => totals.steps)],
  ['Coordination tokens', total((totals) => totals.coordinationTokens)],
  ['Coordination turns', total((totals) => totals.coordinationTurns)],
  ['Ungoverned writes', total((totals) => totals.ungovernedWrites)],
  ['Duplicate work', total((totals) => totals.duplicateWork)],
  ['Message novelty', novelty],
  ['Corrected false claims', total((totals) => totals.correctedFalseClaims)],
  ['Unresolved contradictions', total((totals) => totals.unresolvedContradictions)],
  ['Stale reads', total((totals) => totals.staleReads)],
  ['Retries', total((totals) => totals.retries)],
  ['Replans', total((totals) => totals.replans)],
  ['Propagated faults', total((totals) => totals.propagatedFaults)],
  ['Cleanup', cleanup],
  ['Failure labels', (profile) => counted(profile.totals.failureLabels, (entry) => entry.label)],
  [
    'Envelope breaches',
    (profile) => counted(profile.totals.envelopeBreaches, (entry) => entry.breach),
  ],
];

/** The metric rows every case table carries, in order. */
export const REPORT_METRICS: readonly string[] = METRICS.map(([name]) => name);

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)];
}

function caseSection(entry: CaseComparison): string[] {
  const heading =
    entry.caseId === undefined
      ? `## Case ${entry.ordinal} (held out)`
      : `## Case ${entry.ordinal}: ${entry.caseId}`;
  const controls = entry.controls.length === 0 ? 'none' : entry.controls.join(', ');
  return [
    heading,
    '',
    `Task class: ${taskClassKey(entry.taskClass)}. Controls: ${controls}.`,
    `Seeds: ${entry.seeds.join(', ')}.`,
    '',
    ...table(
      ['Metric', ...EXECUTION_PROFILES],
      METRICS.map(([name, cell]) => [
        name,
        ...EXECUTION_PROFILES.map((profile) => cell(entry.profiles[profile])),
      ]),
    ),
    '',
  ];
}

function bindingSection(evidence: ComparisonEvidence): string[] {
  const { binding } = evidence;
  const { definition, evaluator, dataset, plans } = binding;
  const { computeMatch, aggregation, stoppingRule } = definition;
  const match =
    computeMatch.kind === 'participant-count'
      ? 'participant count'
      : `equivalent compute: ${computeMatch.reason}`;
  const envelope = plans.collaboration.resourceEnvelope;
  return [
    '## Binding',
    '',
    `- Evaluator: ${evaluator.name} revision ${evaluator.revision} (\`${evaluator.digest}\`)`,
    `- Dataset: ${dataset.id} version ${dataset.version} (\`${dataset.digest}\`)`,
    `- Trials per case and profile: ${binding.trials}; ensemble concurrency: ${definition.concurrency}`,
    `- Compute match: ${match}`,
    `- Aggregation: ${aggregation.kind} \`${aggregation.name}\` version ${aggregation.version}`,
    `- Stopping rule: \`${stoppingRule.name}\` version ${stoppingRule.version}: ${stoppingRule.description}`,
    `- Data revision: ${definition.dataRevision}`,
    `- Resource envelope: ${envelope.tokens} tokens, ${envelope.costCents} cents, ${envelope.wallClockMilliseconds} ms, ${envelope.steps} steps, fan-out ${envelope.fanOut}, ${envelope.maximumDescendants} descendants`,
    '',
    ...table(
      ['Agent', 'Model', 'Effort', 'Definition', 'Prompt', 'Tools'],
      definition.agents.map((agent) => [
        agent.name,
        agent.model,
        agent.effort,
        agent.definitionRevision,
        agent.promptRevision,
        agent.tools.join(', ') || 'none',
      ]),
    ),
    '',
    ...table(
      ['Tool', 'Revision'],
      definition.tools.map((tool) => [tool.name, tool.revision]),
    ),
    '',
    ...table(
      ['Profile', 'Plan', 'Revision', 'Policy', 'Participants', 'Edges', 'Cycles', 'Rounds'],
      EXECUTION_PROFILES.map((profile) => {
        const plan = plans[profile];
        return [
          profile,
          plan.planId,
          String(plan.planRevision),
          plan.policyVersion,
          String(plan.participants.length),
          String(plan.topology.edges.length),
          String(plan.topology.permittedCycles),
          String(plan.topology.maximumRounds),
        ];
      }),
    ),
    '',
  ];
}

/** The Markdown report for one comparison's evidence, whose SHA-256 is `digest`. */
export function renderComparisonReport(evidence: ComparisonEvidence, digest: string): string {
  const { admission } = evidence;
  const authoritative =
    admission.decision === 'admit'
      ? admission.authoritativeProfile
      : `${admission.authoritativeProfile} (fallback: ${admission.fallback.reason})`;
  const findings =
    admission.findings.length === 0
      ? ['No findings.']
      : admission.findings.map(
          (finding) => `- ${finding.gate}, ${finding.reason}: ${finding.detail}`,
        );
  const lines = [
    `# Collaboration comparison: ${evidence.binding.definition.id}`,
    '',
    `- Evidence: \`${evidence.id}\`, recorded ${evidence.recordedAt}`,
    `- Revision: \`${evidence.revision}\``,
    `- Digest: \`${digest}\``,
    `- Decision: **${admission.decision}** (exit ${admission.exitCode}) for ${taskClassKey(admission.taskClass)} under rule \`${admission.rule.name}\` version ${admission.rule.version}`,
    `- Authoritative profile: ${authoritative}`,
    '',
    '## Findings',
    '',
    ...findings,
    '',
    ...bindingSection(evidence),
    ...evidence.cases.flatMap(caseSection),
  ];
  return lines.join('\n');
}
