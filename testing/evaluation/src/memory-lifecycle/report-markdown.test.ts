import { describe, expect, test } from 'bun:test';

import { suiteRun } from './memory-lifecycle.test-support';
import { decideMemoryLifecycleRelease } from './release';
import { buildMemoryLifecycleReport, type MemoryLifecycleReport } from './report';
import { renderMemoryLifecycleReport } from './report-markdown';

async function report(): Promise<MemoryLifecycleReport> {
  const run = await suiteRun();
  return buildMemoryLifecycleReport(run, await decideMemoryLifecycleRelease(run));
}

describe('renderMemoryLifecycleReport', () => {
  test('renders the decision, the metrics, the benefit, the components, and the failures', async () => {
    const markdown = renderMemoryLifecycleReport(await report());
    expect(markdown).toStartWith(
      '# Memory lifecycle evaluation: memory-lifecycle memory-lifecycle-2026-09',
    );
    expect(markdown).toContain('## Release decision: pass (exit 0)');
    expect(markdown).toContain('best simpler baseline, `raw-log-search`');
    expect(markdown).toContain('No findings.');
    expect(markdown).toContain('model-judge criteria: none');
    expect(markdown).toContain('| Metric | no-memory | raw-log-search | flat-hybrid | lifecycle |');
    expect(markdown).toContain(
      '| procedure-memory | procedural-reuse | action-success: 100% / 67% / 67% | yes | Beats raw-log search on action-success, and removing it loses action-success, without losing on any measure |',
    );
    expect(markdown).toContain('`deterministic.flat-hybrid.shared-agent-phone.1`');
    expect(markdown).toContain('memory-lifecycle replay <artifact.json>');
  });

  test('lists every finding, and says so when nothing failed', async () => {
    const built = await report();
    const markdown = renderMemoryLifecycleReport({
      ...built,
      judging: { ...built.judging, modelJudgeCriteria: ['helpful-tone'] },
      benchmarks: [
        { benchmark: 'HaluMem', scenarioIdeas: [], reportingDimensions: ['staleStateRate'] },
      ],
      release: {
        ...built.release,
        baseline: null,
        decision: 'infrastructure-failure',
        exitCode: 2,
        findings: {
          infrastructureFailures: [{ reason: 'gate-budget-exceeded', detail: 'Too slow' }],
          insufficientEvidence: [{ reason: 'baseline-missing', detail: 'No baseline' }],
          regressions: [
            {
              criterion: 'deletion',
              metric: 'passFraction',
              severity: 'hard',
              maximumDecrease: 0,
              baseline: 1,
              candidate: 0.5,
              delta: -0.5,
              overriddenBy: null,
            },
            {
              criterion: 'action-success',
              metric: 'passFraction',
              severity: 'hard',
              minimumIncrease: 0.1,
              baseline: 0.75,
              candidate: 0.8,
              delta: 0.05,
              overriddenBy: null,
            },
          ],
        },
      },
      workloads: [{ ...built.workloads[0]!, delta: -0.25, verdict: 'regresses' }],
      components: [
        {
          ...built.components[1]!,
          measures: [
            {
              criterion: 'action-success',
              lifecycle: 1,
              withoutComponent: null,
              rawLogSearch: 0.5,
            },
          ],
          ablation: null,
          promoted: false,
          reason: 'No ablation isolates it: not promoted',
        },
      ],
      failures: [],
    });
    expect(markdown).toContain('- gate-budget-exceeded: Too slow');
    expect(markdown).toContain('- baseline-missing: No baseline');
    expect(markdown).toContain('- deletion passFraction: 1 -> 0.5 (hard, at most -0)');
    expect(markdown).toContain('- action-success passFraction: 0.75 -> 0.8 (hard, at least +0.1)');
    expect(markdown).toContain('best simpler baseline, `none`');
    expect(markdown).toContain('model-judge criteria: helpful-tone');
    expect(markdown).toContain('| HaluMem | none | staleStateRate |');
    expect(markdown).toContain('-25 pts');
    expect(markdown).toContain(
      '| procedure-memory | procedural-reuse | action-success: 100% / n/a / 50% | no | No ablation isolates it: not promoted |',
    );
    expect(markdown).toContain('## Failing trials\n\nNone.');
  });
});
