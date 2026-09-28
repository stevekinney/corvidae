import {
  type AgentRun,
  createManualRuntimeServices,
  type RunnableAgent,
  type RunResultBase,
} from '@lostgradient/operative';

import type { CriterionScorers } from './criteria';
import {
  datasetInput,
  deterministicConfigurationInput,
  HELD_OUT_CASE_ID,
  runResult,
} from './evaluation.test-support';
import { createEvaluator, type Evaluator } from './evaluator';
import { type EvaluationRunRecord, toEvaluationRunRecord } from './history';
import { runTrials, type TrialAggregate } from './trials';

/**
 * The two evaluation runs behind `fixtures/history/*.json`: the same
 * deterministic evaluator (two trials per case) scoring the two-case capitals
 * dataset at a baseline and a candidate code revision. Every trial's cost and
 * every scorer's answer is scripted, so the per-criterion deltas between the
 * two runs can be worked out by hand.
 */
export const BASELINE_RUN_ID = 'run-baseline';
export const CANDIDATE_RUN_ID = 'run-candidate';
export const PUBLIC_CASE_ID = 'case-japan';

interface FixtureRunSpecification {
  readonly id: string;
  readonly recordedAt: string;
  readonly codeRevision: string;
  readonly latencyMilliseconds: number;
  /** One cost per trial, in run order: France's two trials, then Japan's. */
  readonly costs: readonly number[];
  /** The `names-the-capital` assertion's answer per trial, in run order. */
  readonly holds: readonly boolean[];
  /** The `concise` heuristic's score per trial, in run order. */
  readonly concise: readonly number[];
}

const FIXTURE_RUNS = {
  baseline: {
    id: BASELINE_RUN_ID,
    recordedAt: '2026-09-28T12:00:00.000Z',
    codeRevision: 'a7679370f3e1a3b850299d13c9e768541a601722',
    latencyMilliseconds: 1000,
    costs: [0.25, 0.25, 0.25, 0.25],
    holds: [true, true, true, true],
    concise: [1, 1, 1, 1],
  },
  candidate: {
    id: CANDIDATE_RUN_ID,
    recordedAt: '2026-09-28T13:00:00.000Z',
    codeRevision: 'b1c2d3e4f5a60718293a4b5c6d7e8f9012345678',
    latencyMilliseconds: 1250,
    costs: [0.25, 0.25, 0.5, 0.5],
    holds: [true, false, true, true],
    concise: [0.5, 0.75, 1, 0.25],
  },
} as const satisfies Record<string, FixtureRunSpecification>;

export type FixtureRun = keyof typeof FIXTURE_RUNS;

/** A hand-built operative agent whose every run resolves with `result()`. */
export function stubAgent(result: () => Promise<RunResultBase>): RunnableAgent<unknown, boolean> {
  return {
    name: 'stub',
    hasOutput: false,
    run: () => ({ result }) as unknown as AgentRun<unknown, boolean>,
  };
}

/** A completed run that cost `totalCost` dollars. */
export function costedRunResult(totalCost: number): RunResultBase {
  const result = runResult();
  return {
    ...result,
    costEstimate: {
      promptCost: totalCost / 2,
      completionCost: totalCost / 2,
      cacheWriteCost: 0,
      cacheReadCost: 0,
      totalCost,
      model: 'claude-sonnet-4-5',
      usage: result.usage,
    },
  };
}

function sequence<T>(values: readonly T[]): () => T {
  let index = 0;
  return () => values[index++]!;
}

async function fixtureEvaluator(specification: FixtureRunSpecification): Promise<Evaluator> {
  const holds = sequence(specification.holds);
  const concise = sequence(specification.concise);
  const scorers: CriterionScorers = {
    assertions: { 'names-the-capital': () => holds() },
    heuristics: { concise: () => concise() },
    policies: { 'follows-style-guide': () => true },
  };
  return createEvaluator({
    configuration: {
      ...deterministicConfigurationInput(),
      repetitions: 2,
      codeRevision: specification.codeRevision,
    },
    dataset: datasetInput(),
    scorers,
  });
}

/** A fresh evaluator for one fixture run, with its scorers' scripts not yet consumed. */
export function fixtureEvaluatorFor(which: FixtureRun): Promise<Evaluator> {
  return fixtureEvaluator(FIXTURE_RUNS[which]);
}

/** The evaluator and per-case trial aggregates behind one fixture run. */
export async function fixtureRunInputs(
  which: FixtureRun,
): Promise<{ readonly evaluator: Evaluator; readonly aggregates: readonly TrialAggregate[] }> {
  const specification = FIXTURE_RUNS[which];
  const evaluator = await fixtureEvaluator(specification);
  const cost = sequence(specification.costs);
  const runtime = createManualRuntimeServices({ randomSeed: `history-${which}` });
  const aggregates: TrialAggregate[] = [];
  for (const caseId of [HELD_OUT_CASE_ID, PUBLIC_CASE_ID]) {
    aggregates.push(
      await runTrials({
        evaluator,
        caseId,
        subject: () => {
          const result = costedRunResult(cost());
          return stubAgent(() => Promise.resolve(result));
        },
        runtime,
      }),
    );
  }
  return { evaluator, aggregates };
}

/** Builds one of the two committed fixture records from its scripted trials. */
export async function fixtureRun(which: FixtureRun): Promise<EvaluationRunRecord> {
  const specification = FIXTURE_RUNS[which];
  const { evaluator, aggregates } = await fixtureRunInputs(which);
  return toEvaluationRunRecord({
    id: specification.id,
    recordedAt: specification.recordedAt,
    evaluator,
    aggregates,
    latencyMilliseconds: specification.latencyMilliseconds,
  });
}
