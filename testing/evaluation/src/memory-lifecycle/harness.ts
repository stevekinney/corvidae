/**
 * Replays a scenario's timeline against one baseline, before the decision
 * run starts. Nothing here involves a model: observations are admitted (or
 * not) by the baseline, the owner's deletion requests go through the
 * baseline's own deletion path, and restarts drop the baseline's in-process
 * state. The scenario's deterministic runtime is moved to each event's time
 * first, so every timestamp a baseline records is the scenario's.
 *
 * The trace records what the baseline reported: the evidence and transition
 * revisions of a run artifact, and the input to admission, deletion, and
 * unsupported-outcome metrics. Given the same scenario and baseline revision
 * it is the same trace, which is how a scorer re-derives it during replay.
 */
import { createManualRuntimeServices } from '@lostgradient/operative';

import {
  type AdmissionOutcome,
  type DeletionOutcome,
  type MemoryBaselineAdapter,
  type MemoryBaselineName,
  type StructuredComponent,
} from './baselines/adapter';
import { createBaselineAdapter } from './baselines/index';
import type { ComputeEnvelope } from './envelope';
import type { MemoryScenario, ScenarioPrincipal } from './scenarios';

/** How long after its last event a scenario's task is asked. */
export const TASK_DELAY_MILLISECONDS = 60 * 60 * 1000;

export type ScenarioRuntime = ReturnType<typeof createManualRuntimeServices>;

export interface AdmissionRecord {
  readonly evidenceId: string;
  readonly principal: ScenarioPrincipal;
  readonly outcome: AdmissionOutcome;
}

export interface DeletionRecord extends DeletionOutcome {
  readonly evidenceId: string;
}

export interface HarnessTrace {
  readonly admissions: readonly AdmissionRecord[];
  readonly deletions: readonly DeletionRecord[];
  readonly restarts: number;
}

/**
 * The scenario's deterministic runtime: its clock starts at the first event,
 * its identifiers are seeded by the scenario, and its randomness by `seed`.
 */
export function createScenarioRuntime(scenario: MemoryScenario, seed: number): ScenarioRuntime {
  return createManualRuntimeServices({
    origin: scenario.timeline[0]!.at,
    identifierSeed: `memory-lifecycle/${scenario.id}`,
    randomSeed: String(seed),
  });
}

/** When the scenario's task is asked. */
export function taskTime(scenario: MemoryScenario): number {
  return Date.parse(scenario.timeline.at(-1)!.at) + TASK_DELAY_MILLISECONDS;
}

/** Replays `scenario`'s timeline against `adapter` and leaves the clock at the task's time. */
export async function applyTimeline(
  adapter: MemoryBaselineAdapter,
  scenario: MemoryScenario,
  runtime: ScenarioRuntime,
): Promise<HarnessTrace> {
  const admissions: AdmissionRecord[] = [];
  const deletions: DeletionRecord[] = [];
  let restarts = 0;
  for (const event of scenario.timeline) {
    runtime.setTime(Date.parse(event.at));
    switch (event.kind) {
      case 'observe': {
        // A baseline receives what a deployment would: never the ground-truth label.
        const { label: _label, ...observed } = event.evidence;
        const outcome = await adapter.observe(observed);
        admissions.push({ evidenceId: observed.id, principal: observed.principal, outcome });
        break;
      }
      case 'forget':
        deletions.push({
          evidenceId: event.evidenceId,
          ...(await adapter.forget(event.evidenceId)),
        });
        break;
      case 'restart':
        await adapter.restart();
        restarts += 1;
        break;
    }
  }
  runtime.setTime(taskTime(scenario));
  return { admissions, deletions, restarts };
}

/** A fresh baseline with `scenario`'s timeline applied, ready for its decision run. */
export async function prepareScenario(options: {
  readonly scenario: MemoryScenario;
  readonly baseline: MemoryBaselineName;
  readonly envelope: ComputeEnvelope;
  readonly runtime: ScenarioRuntime;
  /** The structured components to run, for an ablation. Defaults to all the baseline has. */
  readonly components?: readonly StructuredComponent[] | undefined;
}): Promise<{ readonly adapter: MemoryBaselineAdapter; readonly trace: HarnessTrace }> {
  const adapter = createBaselineAdapter(options.baseline, {
    runtime: options.runtime,
    envelope: options.envelope,
    components: options.components,
  });
  const trace = await applyTimeline(adapter, options.scenario, options.runtime);
  return { adapter, trace };
}

/**
 * The trace alone, from a fresh baseline and runtime. Scorers call this to
 * re-derive what the timeline did, because a recorded run keeps only what the
 * agent saw.
 */
export async function traceScenario(
  scenario: MemoryScenario,
  baseline: MemoryBaselineName,
  envelope: ComputeEnvelope,
  components?: readonly StructuredComponent[],
): Promise<HarnessTrace> {
  const { adapter, trace } = await prepareScenario({
    scenario,
    baseline,
    envelope,
    runtime: createScenarioRuntime(scenario, 0),
    components,
  });
  await adapter.close();
  return trace;
}
