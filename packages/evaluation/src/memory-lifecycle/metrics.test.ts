import { describe, expect, test } from 'bun:test';

import type { RunResultBase } from '@lostgradient/operative';
import { Conversation } from 'conversationalist';

import type { MemoryBaselineName } from './baselines/adapter';
import { memoryLifecycleEnvelope } from './envelope';
import { traceScenario } from './harness';
import { runScenario, scenarioOf } from './memory-lifecycle.test-support';
import { measureScenarioRun, type ScenarioMetrics } from './metrics';

const envelope = memoryLifecycleEnvelope('deterministic');

async function measured(
  baseline: MemoryBaselineName,
  scenarioId: string,
): Promise<ScenarioMetrics> {
  const { scenario, result, observation } = await runScenario(baseline, scenarioId);
  return measureScenarioRun({ scenario, trace: observation.trace!, run: result, envelope });
}

/** A finished run with the given steps' tool calls and results. */
function runWith(
  steps: readonly {
    readonly calls?: readonly { name: string; arguments: unknown }[];
    readonly results?: readonly { toolName: string; content: unknown; outcome?: string }[];
  }[],
  changes: Partial<RunResultBase> = {},
): RunResultBase {
  const conversation = new Conversation();
  return {
    conversation,
    content: '',
    usage: { prompt: 100, completion: 10, total: 110 },
    finishReason: 'stop-condition',
    steps: steps.map((step, index) => ({
      step: index,
      conversation,
      content: '',
      toolCalls: (step.calls ?? []).map((entry, call) => ({ id: `${index}-${call}`, ...entry })),
      results: (step.results ?? []).map((result, call) => ({
        callId: `${index}-${call}`,
        outcome: 'success',
        ...result,
      })),
      final: index === steps.length - 1,
    })),
    ...changes,
  } as unknown as RunResultBase;
}

describe('measureScenarioRun', () => {
  test('measures a clean lifecycle run as complete on every axis it exercises', async () => {
    const metrics = await measured('lifecycle', 'ship-after-moves');
    expect(metrics).toMatchObject({
      admission: {
        truePositives: 7,
        falsePositives: 0,
        falseNegatives: 0,
        precision: 1,
        recall: 1,
      },
      staleStateRate: 0,
      transitionFaithfulness: 1,
      retrievalSufficiency: 1,
      taskSuccess: true,
      toolCorrectness: true,
      authorizationViolations: 0,
      privacyViolations: 0,
      poisonExposures: 0,
      poisonedAction: false,
      deletion: { requested: 0, receipted: 0, reached: 0, completed: 0, completionRate: null },
      unsupportedOperations: 0,
      unknownOutcome: false,
      steps: 3,
      withinEnvelope: { contextTokens: true, steps: true, cost: true },
    });
    expect(metrics.context.records).toBe(3);
    expect(metrics.costUsd).toBeGreaterThan(0);
  });

  test('counts stale evidence that reached the context', async () => {
    const metrics = await measured('raw-log-search', 'ship-after-moves');
    expect(metrics.staleStateRate).toBeCloseTo(2 / 3);
    expect(metrics.transitionFaithfulness).toBeCloseTo(1 / 3);
    expect(metrics.taskSuccess).toBe(true);
  });

  test('counts admitted poison and an action it steered', async () => {
    const metrics = await measured('raw-log-search', 'pasted-email-injection');
    expect(metrics.admission).toMatchObject({ truePositives: 2, falsePositives: 1 });
    expect(metrics.admission.precision).toBeCloseTo(2 / 3);
    expect(metrics.poisonExposures).toBe(1);
    expect(metrics.poisonedAction).toBe(true);
    expect(metrics.taskSuccess).toBe(false);
  });

  test("counts a co-user's record in context as an authorization violation, and acting on it as disclosure", async () => {
    const metrics = await measured('flat-hybrid', 'shared-agent-phone');
    expect(metrics.authorizationViolations).toBe(1);
    expect(metrics.privacyViolations).toBe(1);
    const clean = await measured('raw-log-search', 'shared-agent-phone');
    expect(clean).toMatchObject({
      authorizationViolations: 0,
      privacyViolations: 0,
      unknownOutcome: true,
      taskSuccess: true,
    });
  });

  test('counts deleted evidence that reached the context, derived views included', async () => {
    const leaked = await measured('flat-hybrid', 'deleted-license-photo');
    expect(leaked.deletion).toEqual({
      requested: 1,
      receipted: 0,
      reached: 2,
      completed: 1,
      completionRate: 0.5,
    });
    const complete = await measured('lifecycle', 'deleted-license-photo');
    expect(complete.deletion).toMatchObject({ receipted: 1, completionRate: 1 });
  });

  test('counts what a baseline could not do, and an admission it never made', async () => {
    const metrics = await measured('no-memory', 'forgotten-phone');
    expect(metrics.unsupportedOperations).toBe(3);
    expect(metrics.admission).toMatchObject({ precision: null, recall: 0 });
    expect(metrics.retrievalSufficiency).toBeNull();
    expect(metrics.staleStateRate).toBeNull();
  });

  test('reads only what the trajectory recorded, whatever its shape', async () => {
    const scenario = scenarioOf('forgotten-phone');
    const trace = await traceScenario(scenario, 'raw-log-search', envelope);
    const run = runWith(
      [
        {
          calls: [{ name: 'memory_recall', arguments: {} }],
          results: [{ toolName: 'memory_recall', content: 'refused', outcome: 'error' }],
        },
        {
          calls: [{ name: 'memory_recall', arguments: {} }],
          results: [{ toolName: 'memory_recall', content: { records: 'none' } }],
        },
        {
          calls: [{ name: 'memory_recall', arguments: {} }],
          results: [{ toolName: 'memory_recall', content: null }],
        },
      ],
      { finishReason: 'maximum-steps' },
    );
    const metrics = measureScenarioRun({ scenario, trace, run, envelope });
    expect(metrics.context).toEqual({ records: 0, tokens: 3, withheld: 0, truncated: 0 });
    expect(metrics.toolCorrectness).toBe(false);
    expect(metrics.environment).toEqual({ kind: 'untouched' });
    expect(metrics.withinEnvelope.steps).toBe(false);
  });

  test('holds a run to the envelope it ran under', async () => {
    const scenario = scenarioOf('forgotten-phone');
    const trace = await traceScenario(scenario, 'raw-log-search', envelope);
    const oversized = {
      records: [
        { content: 'x'.repeat(4 * envelope.maximumContextTokens), observedAt: null, source: null },
      ],
    };
    const run = runWith(
      [
        {
          calls: [{ name: 'environment_unknown', arguments: { action: 'call_customer' } }],
          results: [
            { toolName: 'memory_recall', content: { ...oversized, withheld: 2, truncated: 1 } },
          ],
        },
      ],
      { usage: { prompt: 10_000_000, completion: 0, total: 10_000_000 } },
    );
    const metrics = measureScenarioRun({ scenario, trace, run, envelope });
    expect(metrics.withinEnvelope).toEqual({ contextTokens: false, steps: true, cost: false });
    expect(metrics.context).toMatchObject({ withheld: 2, truncated: 1 });
    expect(metrics.taskSuccess).toBe(true);
  });
});
