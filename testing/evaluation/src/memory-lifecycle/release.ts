/**
 * The memory-lifecycle release decision (COR-755). One committed gate,
 * `gates/memory-lifecycle.json`, holds the release policy, and it is applied
 * two ways, always by the release gate's own `decideGate`:
 *
 * - The suite command applies it to the run it just made, comparing the
 *   lifecycle architecture with the best simpler baseline from that same
 *   run, under the same envelope and the same trial seeds.
 * - `release-gate --gate memory-lifecycle` applies it to a fresh run of the
 *   lifecycle architecture against the committed record of the best simpler
 *   baseline, appends the decision to the history, and `replay` recomputes it.
 *
 * The policy: no regression on authorization, deletion, poisoning, state
 * maintenance, or the cost ceiling, and a predeclared minimum improvement in
 * action success over the best simpler baseline. The best simpler baseline is
 * the one with the highest action success; a tie goes to the simpler one.
 */
import { resolve } from 'node:path';

import gateFile from '../../gates/memory-lifecycle.json';
import {
  contaminationCheckSchema,
  isGateEligibleDataset,
  parseEvaluationDataset,
} from '../datasets';
import type { EvaluationRunRecord } from '../evaluation-run';
import { type GateDefinition, type GateFindings, parseGateDefinition } from '../gate';
import { type EvaluationRunComparison, recordDigest } from '../history';
import { decideGate, type GateOutcome, RELEASE_GATE_EXIT_CODES } from '../release-gate';
import { type MemoryBaselineName, SIMPLER_BASELINES } from './baselines/adapter';
import {
  ACTION_CRITERION,
  MEMORY_LIFECYCLE_CODE_REVISION,
  memoryLifecycleEvaluator,
} from './memory-evaluator';
import { memoryLifecycleSuite } from './suite';
import {
  type BaselineRun,
  type MemoryLifecycleSuiteRun,
  runMemoryLifecycleSuite,
} from './suite-run';

export const MEMORY_LIFECYCLE_GATE_ID = 'memory-lifecycle';

/** The committed evaluation-run record `gates/memory-lifecycle.json` compares with. */
export const BEST_SIMPLER_BASELINE_PATH = resolve(
  import.meta.dir,
  'best-simpler-baseline-run.json',
);

/** When the committed best-simpler-baseline record says it was recorded. */
export const COMMITTED_BASELINE_RECORDED_AT = '2026-09-28T00:00:00.000Z';

/** The committed gate, freshly parsed. */
export function memoryLifecycleGate(): GateDefinition {
  return parseGateDefinition(structuredClone(gateFile));
}

/** A run's action-success pass fraction; a run that scored no trial has none. */
export function actionSuccessOf(record: EvaluationRunRecord): number {
  return (
    record.statistics.criteria.find((criterion) => criterion.name === ACTION_CRITERION)
      ?.passFraction ?? 0
  );
}

/** The simpler baseline with the highest action success, ties to the simpler; none when none ran. */
export function bestSimplerBaseline(runs: readonly BaselineRun[]): BaselineRun | undefined {
  let best: BaselineRun | undefined;
  for (const name of SIMPLER_BASELINES) {
    const run = runs.find((entry) => entry.baseline === name);
    if (
      run !== undefined &&
      (best === undefined || actionSuccessOf(run.record) > actionSuccessOf(best.record))
    ) {
      best = run;
    }
  }
  return best;
}

export interface MemoryLifecycleRelease {
  readonly gateId: string;
  readonly candidate: 'lifecycle';
  /** The best simpler baseline the candidate was compared with, or `null` when none ran. */
  readonly baseline: MemoryBaselineName | null;
  readonly decision: GateOutcome;
  readonly exitCode: number;
  readonly findings: GateFindings;
  readonly comparison: EvaluationRunComparison | null;
}

/** Applies the committed gate to one suite run's lifecycle and best simpler baseline records. */
export async function decideMemoryLifecycleRelease(
  run: MemoryLifecycleSuiteRun,
): Promise<MemoryLifecycleRelease> {
  const candidate = run.baselines.find((entry) => entry.baseline === 'lifecycle');
  if (candidate === undefined) {
    throw new RangeError('A release decision needs the lifecycle baseline in the run');
  }
  const best = bestSimplerBaseline(run.baselines);
  const definition = memoryLifecycleEvaluator({
    baseline: 'lifecycle',
    lane: run.lane,
    suite: run.suite,
  });
  const contaminationChecked = isGateEligibleDataset({
    dataset: parseEvaluationDataset(definition.dataset),
    codeRevision: MEMORY_LIFECYCLE_CODE_REVISION,
    contaminationChecks: definition.contaminationChecks.map((check) =>
      contaminationCheckSchema.parse(check),
    ),
  });
  const outputs = await decideGate({
    gate: memoryLifecycleGate(),
    judge: 'deterministic',
    eligibility: { contaminationChecked, judge: null },
    candidate: candidate.record,
    baseline:
      best === undefined
        ? null
        : {
            source: {
              kind: 'evaluation-run',
              path: `compute-matched:${best.baseline}`,
              digest: await recordDigest(best.record),
            },
            run: best.record,
            ageMilliseconds: 0,
            revisionDistance: 0,
          },
    overrides: [],
  });
  return {
    gateId: MEMORY_LIFECYCLE_GATE_ID,
    candidate: 'lifecycle',
    baseline: best?.baseline ?? null,
    decision: outputs.decision,
    exitCode: RELEASE_GATE_EXIT_CODES[outputs.decision],
    findings: outputs.findings,
    comparison: outputs.comparison,
  };
}

/**
 * The evaluation-run record `gates/memory-lifecycle.json` compares with: the
 * best simpler baseline's deterministic-lane run over the committed suite,
 * recorded at a fixed time with a stopped clock so the record depends on
 * nothing but the code. `memory-lifecycle baseline --write` commits it.
 */
export async function bestSimplerBaselineRecord(): Promise<EvaluationRunRecord> {
  const run = await runMemoryLifecycleSuite({
    lane: 'deterministic',
    suite: memoryLifecycleSuite(),
    baselines: SIMPLER_BASELINES,
    monotonic: () => 0,
    recordedAt: COMMITTED_BASELINE_RECORDED_AT,
  });
  return bestSimplerBaseline(run.baselines)!.record;
}
