import { describe, expect, test } from 'bun:test';

import { createBaselineAdapter } from './baselines/index';
import { memoryLifecycleEnvelope } from './envelope';
import {
  applyTimeline,
  createScenarioRuntime,
  TASK_DELAY_MILLISECONDS,
  taskTime,
  traceScenario,
} from './harness';
import { scenarioOf } from './memory-lifecycle.test-support';

const envelope = memoryLifecycleEnvelope('deterministic');

describe('createScenarioRuntime', () => {
  test("starts the clock at the scenario's first event and seeds randomness by the trial", () => {
    const scenario = scenarioOf('deletion-survives-restart');
    const runtime = createScenarioRuntime(scenario, 11);
    expect(runtime.clock.nowISO()).toBe('2026-01-03T09:00:00.000Z');
    expect(runtime.randomSeed).toBe('11');
    expect(runtime.identifierSeed).toBe('memory-lifecycle/deletion-survives-restart');
    expect(taskTime(scenario)).toBe(
      Date.parse('2026-02-04T09:00:00.000Z') + TASK_DELAY_MILLISECONDS,
    );
  });
});

describe('applyTimeline', () => {
  test('replays observations, deletions, and restarts, each at its own time', async () => {
    const scenario = scenarioOf('deletion-survives-restart');
    const runtime = createScenarioRuntime(scenario, 1);
    const adapter = createBaselineAdapter('raw-log-search', { runtime, envelope });
    const trace = await applyTimeline(adapter, scenario, runtime);
    expect(trace).toEqual({
      admissions: [
        { evidenceId: 'billing-email', principal: 'owner', outcome: 'admitted' },
        { evidenceId: 'invoice-cadence', principal: 'owner', outcome: 'admitted' },
      ],
      deletions: [{ evidenceId: 'billing-email', status: 'completed', receipted: false }],
      restarts: 1,
    });
    expect(runtime.clock.now()).toBe(taskTime(scenario));
    const { items } = await adapter.recall({ query: 'invoice cadence', limit: 1 });
    expect(items[0]!.observedAt).toBe('2026-01-04T09:00:00.000Z');
  });
});

describe('what a baseline receives', () => {
  test('is every observation without its ground-truth label', async () => {
    const scenario = scenarioOf('pasted-email-injection');
    const runtime = createScenarioRuntime(scenario, 1);
    const adapter = createBaselineAdapter('no-memory', { runtime, envelope });
    const observed: object[] = [];
    await applyTimeline(
      {
        ...adapter,
        observe: (evidence) => {
          observed.push(evidence);
          return adapter.observe(evidence);
        },
      },
      scenario,
      runtime,
    );
    expect(observed).toHaveLength(3);
    expect(observed.some((evidence) => 'label' in evidence)).toBe(false);
  });
});

describe('traceScenario', () => {
  test('re-derives the same trace from a fresh baseline every time', async () => {
    const scenario = scenarioOf('deleted-license-photo');
    const first = await traceScenario(scenario, 'lifecycle', envelope);
    expect(first.deletions).toEqual([
      { evidenceId: 'license-photo', status: 'completed', receipted: true },
    ]);
    expect(await traceScenario(scenario, 'lifecycle', envelope)).toEqual(first);
    const none = await traceScenario(scenario, 'no-memory', envelope);
    expect(none.admissions.map((entry) => entry.outcome)).toEqual([
      'not-retained',
      'not-retained',
      'not-retained',
    ]);
  });
});
