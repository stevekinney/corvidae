/**
 * Replay of a stored release-gate decision. A replay recomputes the decision
 * from the evidence the record holds and reports whether it and its digest
 * come out the same, without calling a model:
 *
 * - The evaluator module the decision names is loaded again, only for its
 *   configuration, dataset, and scorers. Its configuration digest and its
 *   dataset's id, version, and digest must equal the recorded ones.
 * - Every trial is re-scored by `scoreTrials` under its recorded seed, from
 *   its recorded reviewer-projection run. Deterministic criteria re-execute
 *   on that run; model-judge criteria read the recorded judge reply; a
 *   recorded latency-budget failure stays one. No agent runs and no
 *   `GenerateFunction` is called.
 * - Everything a decision reads from outside its evidence (the baseline, its
 *   age and revision distance, eligibility, and the overrides it weighed) is
 *   taken from the record, so later history never changes a replay.
 *
 * Outcomes, with the `replay` command's exit codes: `match` (0) when the
 * recomputed record and digest equal the stored ones; `mismatch` (4) naming
 * every field that differs; `unresolvable` (3) when the recorded evaluator
 * configuration digest or dataset version cannot be resolved; `unknown-record`
 * (64); and `corrupt-record` (65).
 */
import { resolve } from 'node:path';

import type { RuntimeTimers } from '@lostgradient/operative';

import { createEvaluator, type Evaluator } from './evaluator';
import type { GateDecisionRecord, TrialEvidence } from './gate';
import {
  CorruptHistoricalRecordError,
  type EvaluationHistory,
  type HistoricalRecord,
  recordDigest,
  toEvaluationRunRecord,
} from './history';
import { canonicalJson } from './identity';
import { fromReviewerRunProjection } from './projections';
import {
  datasetDigest,
  decideGate,
  EVALUATION_PACKAGE_DIRECTORY,
  type GateEvaluatorLoader,
  loadGateEvaluator,
} from './release-gate';
import { scoreTrials, type TrialAggregate } from './trials';
import { EvaluatorInfrastructureError } from './verdict';

export interface ReplayDifference {
  /** The field's path in the record, such as `decision` or `findings.regressions.0.delta`. */
  readonly path: string;
  readonly stored: unknown;
  readonly recomputed: unknown;
}

export type ReplayOutcome =
  | {
      readonly result: 'match';
      readonly recordId: string;
      readonly gateId: string;
      readonly decision: GateDecisionRecord['decision'];
      readonly digest: string;
    }
  | {
      readonly result: 'mismatch';
      readonly recordId: string;
      readonly storedDigest: string;
      readonly recomputedDigest: string;
      /** Every differing field, in canonical order; the first is the first mismatch. */
      readonly differences: readonly ReplayDifference[];
    }
  | { readonly result: 'unresolvable'; readonly recordId: string; readonly problem: string }
  | { readonly result: 'unknown-record'; readonly problem: string }
  | { readonly result: 'corrupt-record'; readonly recordId: string; readonly problem: string };

export const REPLAY_EXIT_CODES = {
  match: 0,
  mismatch: 4,
  unresolvable: 3,
  'unknown-record': 64,
  'corrupt-record': 65,
} as const satisfies Record<ReplayOutcome['result'], number>;

/** Which decision to replay: one record, or the newest decision of a gate. */
export type ReplaySelector = { readonly recordId: string } | { readonly gateId: string };

export interface ReplayOptions {
  readonly history: EvaluationHistory;
  readonly loadEvaluator?: GateEvaluatorLoader | undefined;
}

/** A replay never waits on a clock: a recorded latency failure is replayed from the record. */
const NO_TIMERS: Pick<RuntimeTimers, 'setTimeout' | 'clearTimeout'> = {
  setTimeout: () => 0,
  clearTimeout: () => undefined,
};

/** Why a selected decision cannot be replayed. */
class ReplayRefusal extends Error {
  readonly result: 'unresolvable' | 'corrupt-record';

  constructor(result: ReplayRefusal['result'], message: string) {
    super(message);
    this.result = result;
  }
}

async function select(
  selector: ReplaySelector,
  history: EvaluationHistory,
): Promise<HistoricalRecord<GateDecisionRecord> | string> {
  if ('recordId' in selector) {
    const stored = await history.read(selector.recordId);
    if (stored === undefined) return `No historical record "${selector.recordId}"`;
    if (stored.record.kind !== 'gate-decision') {
      return `Historical record "${selector.recordId}" is a ${stored.record.kind} record, not a gate decision`;
    }
    return stored as HistoricalRecord<GateDecisionRecord>;
  }
  const records = await history.list();
  const decisions = records.filter(
    (stored): stored is HistoricalRecord<GateDecisionRecord> =>
      stored.record.kind === 'gate-decision' && stored.record.gateId === selector.gateId,
  );
  return decisions.at(-1) ?? `No gate decision for gate "${selector.gateId}"`;
}

/** The evaluator the decision names, rebuilt to score recorded runs, checked against the record. */
async function resolveEvaluator(
  record: GateDecisionRecord,
  loadEvaluator: GateEvaluatorLoader,
  cursor: () => TrialEvidence,
): Promise<Evaluator> {
  const modulePath = resolve(EVALUATION_PACKAGE_DIRECTORY, record.evaluator.module);
  let evaluator: Evaluator;
  try {
    const definition = await loadEvaluator(modulePath);
    evaluator = await createEvaluator({
      configuration: definition.configuration,
      dataset: definition.dataset,
      scorers: definition.scorers,
      recordedJudgeOutput: () => cursor().judge ?? undefined,
      timers: NO_TIMERS,
    });
  } catch (error) {
    throw new ReplayRefusal(
      'unresolvable',
      `The evaluator module ${record.evaluator.module} cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { identity, dataset } = evaluator;
  if (identity.digest !== record.evaluator.digest) {
    throw new ReplayRefusal(
      'unresolvable',
      `The recorded evaluator configuration digest ${record.evaluator.digest} cannot be resolved: ${record.evaluator.module} now builds ${identity.digest}`,
    );
  }
  const digest = await datasetDigest(dataset);
  const recorded = record.dataset;
  if (
    dataset.id !== recorded.id ||
    dataset.version !== recorded.version ||
    digest !== recorded.digest
  ) {
    throw new ReplayRefusal(
      'unresolvable',
      `The recorded dataset "${recorded.id}" version "${recorded.version}" cannot be resolved: ${record.evaluator.module} now scores "${dataset.id}" version "${dataset.version}" (${digest})`,
    );
  }
  return evaluator;
}

/** Re-scores every recorded trial and rebuilds the decision record from the evidence. */
async function recompute(
  record: GateDecisionRecord,
  loadEvaluator: GateEvaluatorLoader,
): Promise<GateDecisionRecord> {
  let current: TrialEvidence | undefined;
  const cursor = () => current!;
  const evaluator = await resolveEvaluator(record, loadEvaluator, cursor);
  const replaying: Evaluator = {
    ...evaluator,
    evaluateCase: (caseId, run) => {
      if (!cursor().latencyBudgetExceeded) return evaluator.evaluateCase(caseId, run);
      const evaluationCase = evaluator.dataset.cases.find((entry) => entry.id === caseId)!;
      return Promise.resolve({
        resultSchemaVersion: evaluator.configuration.resultSchemaVersion,
        evaluator: evaluator.identity,
        configuration: evaluator.configuration,
        evaluationCase,
        run,
        verdict: 'infrastructure-failure',
        error: new EvaluatorInfrastructureError({
          reason: 'latency-budget-exceeded',
          message: 'The recorded evaluation exceeded its latency budget',
        }),
      });
    },
  };
  const aggregates: TrialAggregate[] = [];
  for (const entry of record.evidence) {
    const evaluationCase = evaluator.dataset.cases[entry.ordinal - 1];
    if (evaluationCase === undefined) {
      throw new ReplayRefusal(
        'corrupt-record',
        `Its evidence names case ${entry.ordinal}, which the dataset lacks`,
      );
    }
    aggregates.push(
      await scoreTrials({
        evaluator: replaying,
        caseId: evaluationCase.id,
        seeds: entry.trials.map((trial) => trial.seed),
        runResult: (context) => {
          current = entry.trials[context.trial - 1]!;
          const { run } = current;
          if (run === null) return Promise.reject(new Error('The recorded trial produced no run'));
          return Promise.resolve(fromReviewerRunProjection(run));
        },
      }),
    );
  }
  const candidate = toEvaluationRunRecord({
    id: record.candidate.id,
    recordedAt: record.candidate.recordedAt,
    evaluator,
    aggregates,
    latencyMilliseconds: record.candidate.latencyMilliseconds,
  });
  const outputs = await decideGate({
    gate: record.gate,
    judge: record.evaluator.judge,
    eligibility: record.eligibility,
    candidate,
    baseline: record.baseline,
    overrides: record.overrides.considered,
  });
  return {
    ...record,
    candidate,
    overrides: { considered: record.overrides.considered, ...outputs.overrides },
    findings: outputs.findings,
    decision: outputs.decision,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Every leaf where two JSON values differ, in canonical key order. */
export function differencesBetween(
  stored: unknown,
  recomputed: unknown,
  path: readonly string[] = [],
): ReplayDifference[] {
  if (isObject(stored) && isObject(recomputed)) {
    const keys = [...new Set([...Object.keys(stored), ...Object.keys(recomputed)])].toSorted();
    return keys.flatMap((key) => differencesBetween(stored[key], recomputed[key], [...path, key]));
  }
  if (Array.isArray(stored) && Array.isArray(recomputed)) {
    const length = Math.max(stored.length, recomputed.length);
    return Array.from({ length }, (_, index) =>
      differencesBetween(stored[index], recomputed[index], [...path, String(index)]),
    ).flat();
  }
  return canonicalJson(stored) === canonicalJson(recomputed)
    ? []
    : [{ path: path.join('.') || '(record)', stored, recomputed }];
}

/** Recomputes the selected decision from its recorded evidence and compares it with the stored one. */
export async function replayGateDecision(
  selector: ReplaySelector,
  options: ReplayOptions,
): Promise<ReplayOutcome> {
  let stored: HistoricalRecord<GateDecisionRecord> | string;
  try {
    stored = await select(selector, options.history);
  } catch (error) {
    if (!(error instanceof CorruptHistoricalRecordError)) throw error;
    return { result: 'corrupt-record', recordId: error.id, problem: error.message };
  }
  if (typeof stored === 'string') return { result: 'unknown-record', problem: stored };
  const { record, digest } = stored;
  let recomputed: GateDecisionRecord;
  try {
    recomputed = await recompute(record, options.loadEvaluator ?? loadGateEvaluator);
  } catch (error) {
    if (error instanceof ReplayRefusal && error.result === 'unresolvable') {
      return { result: 'unresolvable', recordId: record.id, problem: error.message };
    }
    if (error instanceof ReplayRefusal || error instanceof RangeError) {
      return {
        result: 'corrupt-record',
        recordId: record.id,
        problem: `Gate decision "${record.id}" cannot be replayed: ${error.message}`,
      };
    }
    throw error;
  }
  const recomputedDigest = await recordDigest(recomputed);
  if (recomputedDigest === digest) {
    return {
      result: 'match',
      recordId: record.id,
      gateId: record.gateId,
      decision: record.decision,
      digest,
    };
  }
  return {
    result: 'mismatch',
    recordId: record.id,
    storedDigest: digest,
    recomputedDigest,
    differences: differencesBetween(
      JSON.parse(canonicalJson(record)),
      JSON.parse(canonicalJson(recomputed)),
    ),
  };
}
