/**
 * The human-readable form of a {@link MemoryLifecycleReport}. It is rendered
 * from the report alone, so the Markdown and the JSON can never disagree.
 */
import { describeThresholdBound } from '../gate';
import type {
  BaselineMetrics,
  BenefitRow,
  ComponentPromotion,
  MemoryLifecycleReport,
} from './report';

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(0)}%`;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

const METRIC_ROWS: readonly [string, (metrics: BaselineMetrics) => string][] = [
  ['Downstream task success', (metrics) => percent(metrics.downstreamTaskSuccess)],
  ['Tool/environment correctness', (metrics) => percent(metrics.toolEnvironmentCorrectness)],
  ['Evidence admission precision', (metrics) => percent(metrics.evidenceAdmissionPrecision)],
  ['Evidence admission recall', (metrics) => percent(metrics.evidenceAdmissionRecall)],
  ['Stale-state rate', (metrics) => percent(metrics.staleStateRate)],
  ['Transition faithfulness', (metrics) => percent(metrics.transitionFaithfulness)],
  ['Retrieval sufficiency', (metrics) => percent(metrics.retrievalSufficiency)],
  ['Context cost (tokens, mean)', (metrics) => metrics.contextTokens.toFixed(1)],
  ['Latency (ms, mean; measured)', (metrics) => metrics.latencyMilliseconds.mean.toFixed(1)],
  ['Wall-clock breaches (measured)', (metrics) => String(metrics.wallClockBreaches)],
  ['Privacy violations', (metrics) => String(metrics.privacyViolations)],
  ['Authorization violations', (metrics) => String(metrics.authorizationViolations)],
  ['Poison exposures', (metrics) => String(metrics.poisonExposures)],
  ['Deletion completion', (metrics) => percent(metrics.deletionCompletion)],
  ['Deletion receipts', (metrics) => String(metrics.deletionReceipts)],
  ['Unsupported operations', (metrics) => String(metrics.unsupportedOperations)],
  [
    'Unknown outcomes (correct)',
    (metrics) => `${metrics.unknownOutcomes} (${metrics.correctAbstentions})`,
  ],
  ['Cost (USD, total)', (metrics) => metrics.costUsd.total.toFixed(6)],
];

function benefitTable(title: string, rows: readonly BenefitRow[]): string {
  return [
    `### ${title}`,
    '',
    table(
      ['', 'Scenarios', 'Lifecycle', 'Best simpler', 'Delta', 'Verdict'],
      rows.map((row) => [
        row.key,
        String(row.scenarios),
        percent(row.lifecycle),
        percent(row.bestSimpler),
        `${row.delta >= 0 ? '+' : ''}${(row.delta * 100).toFixed(0)} pts`,
        row.verdict,
      ]),
    ),
  ].join('\n');
}

/** Each measure as `criterion: lifecycle / without the component / raw-log search`. */
function componentMeasures(component: ComponentPromotion): string {
  return component.measures
    .map(
      (measure) =>
        `${measure.criterion}: ${percent(measure.lifecycle)} / ${percent(measure.withoutComponent)} / ${percent(measure.rawLogSearch)}`,
    )
    .join('<br>');
}

/** Renders `report` as Markdown. */
export function renderMemoryLifecycleReport(report: MemoryLifecycleReport): string {
  const { release } = report;
  const names = report.baselines.map((baseline) => baseline.name);
  const findings = [
    ...release.findings.infrastructureFailures.map(
      (finding) => `${finding.reason}: ${finding.detail}`,
    ),
    ...release.findings.insufficientEvidence.map(
      (finding) => `${finding.reason}: ${finding.detail}`,
    ),
    ...release.findings.regressions.map(
      (regression) =>
        `${regression.criterion} ${regression.metric}: ${regression.baseline} -> ${regression.candidate} (${regression.severity}, ${describeThresholdBound(regression)})`,
    ),
  ];
  return [
    `# Memory lifecycle evaluation: ${report.suite.id} ${report.suite.version}`,
    '',
    `Lane \`${report.lane}\`, seed \`${report.seed}\`, ${report.repetitions} trial(s) per scenario, ${report.suite.scenarios} scenarios. Every baseline ran under envelope \`${report.envelope.digest.slice(0, 12)}\` (model \`${report.envelope.value.model.name}\` revision ${report.envelope.value.model.revision}, effort ${report.envelope.value.effort}, prompt \`${report.envelope.value.promptRevision}\`, recall limit ${report.envelope.value.recallLimit}, ${report.envelope.value.maximumContextTokens} context tokens, ${report.envelope.value.maximumSteps} steps, ${report.envelope.value.maximumCostUsd} USD, ${report.envelope.value.maximumWallClockMilliseconds} ms).`,
    '',
    `Judging: \`${report.judging.judge}\`; model-judge criteria: ${report.judging.modelJudgeCriteria.length === 0 ? 'none' : report.judging.modelJudgeCriteria.join(', ')}.`,
    '',
    `## Release decision: ${release.decision} (exit ${release.exitCode})`,
    '',
    `The lifecycle architecture against the best simpler baseline, \`${release.baseline ?? 'none'}\`, under gate \`${release.gateId}\`.`,
    '',
    findings.length === 0 ? 'No findings.' : findings.map((finding) => `- ${finding}`).join('\n'),
    '',
    '## Metrics by baseline',
    '',
    table(
      ['Metric', ...names],
      METRIC_ROWS.map(([label, read]) => [
        label,
        ...report.baselines.map((baseline) => read(baseline.metrics)),
      ]),
    ),
    '',
    '## Where the lifecycle architecture benefits',
    '',
    benefitTable('By memory workload', report.workloads),
    '',
    benefitTable('By condition', report.conditions),
    '',
    benefitTable('By named action task', report.tasks),
    '',
    '## Structured components',
    '',
    'Each measure is the lifecycle architecture / the architecture without that component / raw-log search, on the scenarios of its target conditions.',
    '',
    table(
      ['Component', 'Target', 'Measures', 'Promoted', 'Reason'],
      report.components.map((component) => [
        component.component,
        component.targetConditions.join(', '),
        componentMeasures(component),
        component.promoted ? 'yes' : 'no',
        component.reason,
      ]),
    ),
    '',
    '## External benchmarks',
    '',
    report.externalScorePolicy,
    '',
    table(
      ['Benchmark', 'Scenario ideas adopted', 'Reporting dimensions'],
      report.benchmarks.map((benchmark) => [
        benchmark.benchmark,
        benchmark.scenarioIdeas.length === 0
          ? 'none'
          : benchmark.scenarioIdeas
              .map((idea) => `${idea.idea} (${idea.scenarios.join(', ')})`)
              .join('<br>'),
        benchmark.reportingDimensions.join(', '),
      ]),
    ),
    '',
    '## Failing trials',
    '',
    report.failures.length === 0
      ? 'None.'
      : table(
          ['Artifact', 'Verdict', 'Failed criteria'],
          report.failures.map((failure) => [
            `\`${failure.artifactId}\``,
            failure.verdict,
            failure.failedCriteria.join(', '),
          ]),
        ),
    '',
    'Replay any failure with `bun run --cwd packages/evaluation memory-lifecycle replay <artifact.json>`.',
    '',
  ].join('\n');
}
