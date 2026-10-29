import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';

import fixtureGate from '../gates/fixture-regression.json';
import type { EvaluationRunRecord } from './evaluation-run';
import { createEvaluator } from './evaluator';
import {
  fixtureRegressionEvaluator,
  type FixtureScript,
} from './fixtures/release-gate/fixture-regression';
import { createEvaluationHistory, toEvaluationRunRecord } from './history';
import { runTrials, type TrialAggregate } from './trials';

/**
 * Shared fixtures for the release-gate and replay tests. Gate files are
 * written to a test-only gates directory with absolute paths, so a test can
 * point `fixture-regression` at any script without touching the committed
 * gate.
 */

export const PACKAGE_DIRECTORY = resolve(import.meta.dir, '..');
export const COMMITTED_GATES_DIRECTORY = join(PACKAGE_DIRECTORY, 'gates');
export const FIXTURE_GATE_ID = 'fixture-regression';
export const BASELINE_RUN_PATH = join(
  import.meta.dir,
  'fixtures',
  'release-gate',
  'baseline-run.json',
);
export const GATE_ACTOR = 'gate-runner';
export const OVERRIDE_AUTHORITY = fixtureGate.overrideAuthority;

/** The absolute path of the evaluator module that runs `script`. */
export function evaluatorModule(script: FixtureScript): string {
  return join(import.meta.dir, 'fixtures', 'release-gate', `${script}.ts`);
}

export type GateFile = Record<string, unknown>;

/** The committed fixture gate with absolute paths, running `script`, with `changes` applied. */
export function fixtureGateFile(
  script: FixtureScript = 'passing',
  changes: GateFile = {},
): GateFile {
  return {
    ...structuredClone(fixtureGate),
    evaluator: evaluatorModule(script),
    baseline: { kind: 'evaluation-run', path: BASELINE_RUN_PATH },
    ...changes,
  };
}

/** A threshold list with `names-the-capital` at `severity`. */
export function capitalThresholdAt(severity: 'hard' | 'overridable'): GateFile {
  return {
    regressionThresholds: fixtureGate.regressionThresholds.map((threshold) =>
      threshold.criterion === 'names-the-capital' ? { ...threshold, severity } : threshold,
    ),
  };
}

/** Writes `gates` into `directory` as `<gateId>.json` and returns the directory. */
export async function writeGates(
  directory: string,
  gates: Readonly<Record<string, GateFile>>,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  for (const [gateId, gate] of Object.entries(gates)) {
    await writeFile(join(directory, `${gateId}.json`), `${JSON.stringify(gate, null, 2)}\n`);
  }
  return directory;
}

export function memoryHistory() {
  const store = textValueStore(new MemoryStorage());
  return { store, history: createEvaluationHistory(store) };
}

/**
 * The committed `baseline-run.json`: the passing script's evaluation run,
 * with seeds drawn from a fixed manual runtime and a fixed time and latency.
 */
export async function fixtureBaselineRun(): Promise<EvaluationRunRecord> {
  const definition = await fixtureRegressionEvaluator('passing');
  const evaluator = await createEvaluator({
    configuration: definition.configuration,
    dataset: definition.dataset,
    scorers: definition.scorers,
    generate: definition.judge,
  });
  const runtime = createManualRuntimeServices({ randomSeed: 'fixture-regression-baseline' });
  const aggregates: TrialAggregate[] = [];
  for (const evaluationCase of evaluator.dataset.cases) {
    aggregates.push(
      await runTrials({
        evaluator,
        caseId: evaluationCase.id,
        subject: definition.subject,
        runtime,
      }),
    );
  }
  return toEvaluationRunRecord({
    id: 'fixture-regression-baseline',
    recordedAt: '2026-09-28T00:00:00.000Z',
    evaluator,
    aggregates,
    latencyMilliseconds: 1000,
  });
}
