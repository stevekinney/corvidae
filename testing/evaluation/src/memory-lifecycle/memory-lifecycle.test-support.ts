import type { GenerateFunction, RunResultBase } from '@lostgradient/operative';

import { createScenarioAgent, type ScenarioObservation } from './agent';
import type { MemoryBaselineName } from './baselines/adapter';
import { memoryLifecycleEnvelope, type MemoryLifecycleLane } from './envelope';
import { createScenarioRuntime } from './harness';
import { createReferencePolicy } from './policy';
import { renderTaskPrompt } from './prompt';
import type { MemoryScenario } from './scenarios';
import { memoryLifecycleSuite } from './suite';
import {
  type BaselineRun,
  type MemoryLifecycleSuiteRun,
  runMemoryLifecycleSuite,
} from './suite-run';

/**
 * Shared fixtures for the memory-lifecycle tests. A whole deterministic
 * suite run takes a fraction of a second, but it is shared anyway, so every
 * test that reads it reads the same run.
 */

export const RECORDED_AT = '2026-09-28T12:00:00.000Z';

const runs = new Map<MemoryLifecycleLane, Promise<MemoryLifecycleSuiteRun>>();

/** One suite run per lane, with a stopped clock, shared by every test. */
export function suiteRun(
  lane: MemoryLifecycleLane = 'deterministic',
): Promise<MemoryLifecycleSuiteRun> {
  let run = runs.get(lane);
  if (run === undefined) {
    run = runMemoryLifecycleSuite({ lane, recordedAt: RECORDED_AT, monotonic: () => 0 });
    runs.set(lane, run);
  }
  return run;
}

export function baselineRunOf(run: MemoryLifecycleSuiteRun, name: MemoryBaselineName): BaselineRun {
  return run.baselines.find((entry) => entry.baseline === name)!;
}

export function scenarioOf(id: string): MemoryScenario {
  return memoryLifecycleSuite().scenarios.find((scenario) => scenario.id === id)!;
}

export interface ScenarioRunFixture {
  readonly scenario: MemoryScenario;
  readonly result: RunResultBase;
  readonly observation: ScenarioObservation;
}

/** Runs one scenario's agent against one baseline, with the reference policy or `generate`. */
export async function runScenario(
  baseline: MemoryBaselineName,
  scenarioId: string,
  generate?: GenerateFunction,
): Promise<ScenarioRunFixture> {
  const scenario = scenarioOf(scenarioId);
  const envelope = memoryLifecycleEnvelope('deterministic');
  const built = createScenarioAgent({
    scenario,
    baseline,
    envelope,
    runtime: createScenarioRuntime(scenario, 1),
    generate: generate ?? createReferencePolicy(envelope, 1),
  });
  const result = await built.agent.run(renderTaskPrompt(scenario.task)).result();
  await built.close();
  return { scenario, result, observation: built.observation };
}
