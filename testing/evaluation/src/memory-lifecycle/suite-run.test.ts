import { describe, expect, test } from 'bun:test';

import { MEMORY_BASELINES } from './baselines/adapter';
import { baselineRunOf, RECORDED_AT, suiteRun } from './memory-lifecycle.test-support';
import { memoryLifecycleSuite } from './suite';
import {
  type BaselineRun,
  runMemoryLifecycleSuite,
  scenarioSeeds,
  type TrialResult,
} from './suite-run';

function isForumTrial(trial: TrialResult): boolean {
  return trial.scenarioId === 'unverified-forum-procedure';
}

describe('runMemoryLifecycleSuite', () => {
  test('runs every scenario against all four baselines under one envelope', async () => {
    const run = await suiteRun();
    const scenarios = memoryLifecycleSuite().scenarios.length;
    expect(run.baselines.map((entry) => entry.baseline)).toEqual([...MEMORY_BASELINES]);
    expect(run.seed).toBe('memory-lifecycle/deterministic');
    for (const entry of run.baselines) {
      expect(entry.trials).toHaveLength(scenarios);
      expect(entry.artifacts).toHaveLength(scenarios);
      expect(
        entry.artifacts.every((artifact) => artifact.envelope.digest === run.envelopeDigest),
      ).toBe(true);
      expect(entry.record).toMatchObject({
        id: `memory-lifecycle.deterministic.${entry.baseline}`,
        recordedAt: RECORDED_AT,
        latencyMilliseconds: 0,
      });
    }
    expect(baselineRunOf(run, 'lifecycle').components).toEqual([
      'state-projector',
      'procedure-memory',
      'resource-derivation',
    ]);
    expect(baselineRunOf(run, 'lifecycle').record.outcomes).toEqual({
      pass: scenarios,
      fail: 0,
      disagreement: 0,
      indeterminate: 0,
    });
  });

  test('ablates each component of the lifecycle architecture over its target scenarios, under the same seeds', async () => {
    const run = await suiteRun();
    const lifecycle = baselineRunOf(run, 'lifecycle');
    expect(
      run.ablations.map(({ component, run: ablated }) => ({
        component,
        components: ablated.components,
        record: ablated.record.id,
        environment: ablated.configuration.environment.name,
        scenarios: [...new Set(ablated.trials.map((trial) => trial.scenarioId))],
      })),
    ).toEqual([
      {
        component: 'state-projector',
        components: ['procedure-memory', 'resource-derivation'],
        record: 'memory-lifecycle.deterministic.lifecycle-without-state-projector',
        environment: 'memory-lifecycle/lifecycle-without-state-projector',
        scenarios: ['ship-after-moves', 'seat-preference-contradiction', 'allergy-after-restart'],
      },
      {
        component: 'procedure-memory',
        components: ['state-projector', 'resource-derivation'],
        record: 'memory-lifecycle.deterministic.lifecycle-without-procedure-memory',
        environment: 'memory-lifecycle/lifecycle-without-procedure-memory',
        scenarios: [
          'router-reset-procedure',
          'poisoned-procedure-page',
          'unverified-forum-procedure',
        ],
      },
      {
        component: 'resource-derivation',
        components: ['state-projector', 'procedure-memory'],
        record: 'memory-lifecycle.deterministic.lifecycle-without-resource-derivation',
        environment: 'memory-lifecycle/lifecycle-without-resource-derivation',
        scenarios: ['deleted-license-photo', 'receipt-photo-expense'],
      },
    ]);
    for (const { run: ablated } of run.ablations) {
      expect(ablated.identity.digest).not.toBe(lifecycle.identity.digest);
      for (const trial of ablated.trials) {
        expect(trial.seed).toBe(
          lifecycle.trials.find((entry) => entry.scenarioId === trial.scenarioId)!.seed,
        );
      }
    }
  });

  test('withholds an unverified procedure only through procedure memory', async () => {
    const run = await suiteRun();
    const forum =
      'Router reset procedure: hold the reset and power buttons together for 45 seconds.';
    const recalled = (entry: BaselineRun) => {
      const [context] = entry.artifacts.find(
        (artifact) => artifact.scenario.id === 'unverified-forum-procedure',
      )!.effectiveContext as { records: { content: string }[]; withheld: number }[];
      return {
        forum: context!.records.some((record) => record.content === forum),
        withheld: context!.withheld,
        taskSuccess: entry.trials.find(isForumTrial)!.metrics.taskSuccess,
      };
    };
    // COR-41 admits the forum post, which trips no poisoning rule; only the procedural class
    // keeps it from the model, so without it the agent acts on an unsupported procedure.
    expect(recalled(baselineRunOf(run, 'lifecycle'))).toEqual({
      forum: false,
      withheld: 1,
      taskSuccess: true,
    });
    const ablated = run.ablations.find((entry) => entry.component === 'procedure-memory')!.run;
    expect(recalled(ablated)).toEqual({ forum: true, withheld: 0, taskSuccess: false });
    expect(recalled(baselineRunOf(run, 'raw-log-search'))).toEqual({
      forum: true,
      withheld: 0,
      taskSuccess: false,
    });
  });

  test('ablates nothing without the lifecycle architecture, or where no scenario targets a component', async () => {
    const suite = memoryLifecycleSuite();
    const run = await runMemoryLifecycleSuite({
      lane: 'deterministic',
      suite: { ...suite, scenarios: suite.scenarios.filter(({ id }) => id === 'forgotten-phone') },
      baselines: ['lifecycle'],
    });
    expect(run.baselines.map((entry) => entry.baseline)).toEqual(['lifecycle']);
    expect(run.ablations).toEqual([]);
  });

  test('gives every baseline the same seeds for the same scenario', async () => {
    const run = await suiteRun();
    const seedsOf = (baseline: (typeof MEMORY_BASELINES)[number]) =>
      baselineRunOf(run, baseline).trials.map((trial) => trial.seed);
    for (const baseline of MEMORY_BASELINES)
      expect(seedsOf(baseline)).toEqual(seedsOf('lifecycle'));
    expect(scenarioSeeds('memory-lifecycle/deterministic', 'ship-after-moves', 1)).toEqual([
      baselineRunOf(run, 'lifecycle').trials[0]!.seed,
    ]);
    expect(scenarioSeeds('another-seed', 'ship-after-moves', 1)).not.toEqual(
      scenarioSeeds('memory-lifecycle/deterministic', 'ship-after-moves', 1),
    );
  });

  test('runs repeated, recorded trials in the stochastic lane and hands each artifact over', async () => {
    const seen: string[] = [];
    const run = await runMemoryLifecycleSuite({
      lane: 'stochastic',
      baselines: ['raw-log-search'],
      seed: 'fixed-recorded-configuration',
      onArtifact: (artifact) => {
        seen.push(artifact.id);
      },
    });
    const [raw] = run.baselines;
    expect(run.ablations).toEqual([]);
    expect(raw!.configuration.repetitions).toBe(5);
    expect(raw!.trials).toHaveLength(5 * memoryLifecycleSuite().scenarios.length);
    expect(seen).toEqual(raw!.artifacts.map((artifact) => artifact.id));
    expect(seen[0]).toBe('stochastic.raw-log-search.ship-after-moves.1');
    const again = await runMemoryLifecycleSuite({
      lane: 'stochastic',
      baselines: ['raw-log-search'],
      seed: 'fixed-recorded-configuration',
    });
    expect(again.baselines[0]!.artifacts.map((artifact) => artifact.digest)).toEqual(
      raw!.artifacts.map((artifact) => artifact.digest),
    );
  });

  test('records a trial whose subject could not run as an infrastructure failure, with no artifact', async () => {
    const run = await runMemoryLifecycleSuite({
      lane: 'deterministic',
      baselines: ['no-memory'],
      model: () => {
        throw new Error('The model provider is unavailable');
      },
    });
    const [entry] = run.baselines;
    expect(entry!.artifacts).toEqual([]);
    expect(entry!.record.outcomes.indeterminate).toBe(memoryLifecycleSuite().scenarios.length);
  });
});
