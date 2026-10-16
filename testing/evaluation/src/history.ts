/**
 * Append-only evaluation history (COR-896, "audit record"). Every evaluation
 * run, release-gate decision, gate override, and promotion signal is kept as
 * one immutable record (`evaluation-run`, `gate-decision`, `gate-override`,
 * or `promotion-signal`) in a weft `TextValueStore`: `BunSQLiteStorage` for
 * the local file the `history`, `release-gate`, `replay`, and
 * `promotion-signal` commands share, `MemoryStorage` in tests. The store is
 * the durable audit record itself, so a local command never needs a running
 * bureau.
 *
 * Records are never rewritten. {@link createEvaluationHistory} exposes only
 * `append`, `read`, and `list`; `append` commits with a compare-and-swap that
 * requires the id to be absent, so a second record with the same id is
 * rejected with {@link HistoricalRecordExistsError} and the first stays
 * byte-identical. Rolling an evaluator back means citing an earlier record,
 * never editing one.
 *
 * Each stored row is the canonical JSON (keys sorted at every depth) of
 * `{ digest, record }`, where `digest` is the SHA-256 of the record's own
 * canonical JSON. Canonical JSON has exactly one spelling per value, so
 * `read` can hold a row to it byte for byte: a row that is not valid UTF-8,
 * does not parse, is not canonical, does not match a record schema, is
 * stored under another id, or does not match its digest is rejected with
 * {@link CorruptHistoricalRecordError}. Changing any single byte of a row
 * therefore always makes it unreadable rather than silently different.
 *
 * An `evaluation-run` record is built from `runTrials` aggregates by
 * {@link toEvaluationRunRecord}, which keeps the evidence a later comparison
 * or gate needs and drops everything that could leak a held-out case (see
 * `evaluation-run.ts`). Gate records are defined in `gate.ts`, and promotion
 * signals in `promotion.ts`.
 */
import { sha256Hex } from '@lostgradient/cryptography';
import type { ConditionalTextValueStore } from '@lostgradient/weft';
import { z } from 'zod';

import { EvaluatorConfigurationError, toConfigurationIssues } from './configuration';
import type { CaseVisibility } from './datasets';
import type { AggregateOutcome } from './disagreement';
import {
  digestSchema,
  EVALUATION_HISTORY_SCHEMA_VERSION,
  type EvaluationRunCase,
  type EvaluationRunRecord,
  evaluationRunRecordSchema,
  type EvaluationRunTrial,
  parseEvaluationRunRecord,
  toRecordedUsage,
} from './evaluation-run';
import type { Evaluator } from './evaluator';
import {
  type GateDecisionRecord,
  gateDecisionRecordSchema,
  type GateOverrideRecord,
  gateOverrideRecordSchema,
} from './gate';
import { canonicalJson, type EvaluatorIdentity } from './identity';
import { type PromotionSignalRecord, promotionSignalRecordSchema } from './promotion';
import {
  type AggregateStatistics,
  aggregateStatistics,
  type TrialAggregate,
  type TrialRecord,
} from './trials';

const RECORD_KEY_PREFIX = 'evaluation-history/records/';

/** Every kind of record the history keeps, told apart by `kind`. */
const historyRecordSchema = z.discriminatedUnion('kind', [
  evaluationRunRecordSchema,
  gateDecisionRecordSchema,
  gateOverrideRecordSchema,
  promotionSignalRecordSchema,
]);

export type HistoryRecord =
  EvaluationRunRecord | GateDecisionRecord | GateOverrideRecord | PromotionSignalRecord;

const historicalRecordSchema = z.strictObject({
  digest: digestSchema,
  record: historyRecordSchema,
});

/** A stored record and the SHA-256 of its canonical JSON. */
export interface HistoricalRecord<R extends HistoryRecord = HistoryRecord> {
  readonly digest: string;
  readonly record: R;
}

/** Parses any record the history keeps, throwing {@link EvaluatorConfigurationError} on any issue. */
function parseHistoryRecord(input: HistoryRecord): HistoryRecord {
  const parsed = historyRecordSchema.safeParse(input);
  if (!parsed.success) throw new EvaluatorConfigurationError(toConfigurationIssues(parsed.error));
  return parsed.data;
}

/** The SHA-256 of a record's canonical JSON: the digest the history stores it under. */
export function recordDigest(record: HistoryRecord): Promise<string> {
  return sha256Hex(canonicalJson(record));
}

/** A record with this id is already in the history, which is append-only. */
export class HistoricalRecordExistsError extends Error {
  override readonly name = 'HistoricalRecordExistsError';
  readonly id: string;

  constructor(id: string) {
    super(`Historical record "${id}" already exists; evaluation history is append-only`);
    this.id = id;
  }
}

/** A stored record no longer matches what was appended. It is never returned. */
export class CorruptHistoricalRecordError extends Error {
  override readonly name = 'CorruptHistoricalRecordError';
  readonly id: string;

  constructor(id: string, problem: string, options?: ErrorOptions) {
    super(`Historical record "${id}" ${problem}`, options);
    this.id = id;
  }
}

export interface EvaluationHistory {
  /** Stores a new record. Rejects with {@link HistoricalRecordExistsError} when the id is taken. */
  append<R extends HistoryRecord>(record: R): Promise<HistoricalRecord<R>>;
  /** The verified record, or `undefined` when no record has this id. */
  read(id: string): Promise<HistoricalRecord | undefined>;
  /** Every verified record, oldest first. Rejects if any record is corrupt. */
  list(): Promise<HistoricalRecord[]>;
}

async function verify(id: string, text: string): Promise<HistoricalRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new CorruptHistoricalRecordError(id, 'is not valid JSON', { cause });
  }
  // A changed byte that still parses to an equal value (`1e-7` as `1E-7`)
  // re-serializes differently, so the digest alone would not see it.
  if (canonicalJson(parsed) !== text) {
    throw new CorruptHistoricalRecordError(id, 'is not in canonical form');
  }
  const envelope = historicalRecordSchema.safeParse(parsed);
  if (!envelope.success) {
    throw new CorruptHistoricalRecordError(
      id,
      `does not match any history record schema: ${z.prettifyError(envelope.error)}`,
    );
  }
  const { digest, record } = envelope.data;
  if (record.id !== id) {
    throw new CorruptHistoricalRecordError(id, `names "${record.id}" but is stored under "${id}"`);
  }
  if ((await recordDigest(record)) !== digest) {
    throw new CorruptHistoricalRecordError(id, 'does not match its digest');
  }
  return envelope.data;
}

function oldestFirst(left: HistoricalRecord, right: HistoricalRecord): number {
  const byTime = Date.parse(left.record.recordedAt) - Date.parse(right.record.recordedAt);
  // Ids are unique keys, so they never tie.
  return byTime === 0 ? (left.record.id < right.record.id ? -1 : 1) : byTime;
}

/**
 * The append-only history over `store`. The returned object has exactly
 * `append`, `read`, and `list`: there is no update and no delete.
 */
export function createEvaluationHistory(store: ConditionalTextValueStore): EvaluationHistory {
  async function read(id: string): Promise<HistoricalRecord | undefined> {
    let text: string | null;
    try {
      text = await store.get(`${RECORD_KEY_PREFIX}${id}`);
    } catch (cause) {
      // The store decodes UTF-8 fatally, so a changed byte can surface here.
      if (cause instanceof TypeError) {
        throw new CorruptHistoricalRecordError(id, 'is not valid UTF-8 text', { cause });
      }
      throw cause;
    }
    return text === null ? undefined : verify(id, text);
  }

  async function append<R extends HistoryRecord>(input: R): Promise<HistoricalRecord<R>> {
    // Parsing returns the same kind of record it was given.
    const record = parseHistoryRecord(input) as R;
    const historical: HistoricalRecord<R> = { digest: await recordDigest(record), record };
    const key = `${RECORD_KEY_PREFIX}${record.id}`;
    const committed = await store.conditionalBatch(
      [{ key, expectedValue: null }],
      [{ type: 'set', key, value: canonicalJson(historical) }],
    );
    if (!committed) throw new HistoricalRecordExistsError(record.id);
    return historical;
  }

  async function list(): Promise<HistoricalRecord[]> {
    const records: HistoricalRecord[] = [];
    for (const key of await store.list(RECORD_KEY_PREFIX)) {
      const historical = await read(key.slice(RECORD_KEY_PREFIX.length));
      if (historical !== undefined) records.push(historical);
    }
    return records.toSorted(oldestFirst);
  }

  return Object.freeze({ append, read, list });
}

export interface EvaluationRunRecordOptions {
  /** The record's id, unique within the history. */
  readonly id: string;
  /** When the run finished, as an ISO-8601 timestamp. */
  readonly recordedAt: string;
  /** The evaluator that scored every aggregate. */
  readonly evaluator: Evaluator;
  /** One `runTrials` aggregate per evaluated case of the evaluator's dataset. */
  readonly aggregates: readonly TrialAggregate[];
  /** The run's wall-clock duration. */
  readonly latencyMilliseconds: number;
}

function toRunTrial(trial: TrialRecord): EvaluationRunTrial {
  const { finishReason, usage, costEstimate, weightedTotal, error } = trial;
  return {
    trial: trial.trial,
    seed: trial.seed,
    verdict: trial.verdict,
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(usage === undefined ? {} : { usage: toRecordedUsage(usage) }),
    ...(costEstimate === undefined ? {} : { costUsd: costEstimate.totalCost }),
    scores: trial.criteria.map(({ name, score, hardGate }) => ({ name, score, hardGate })),
    ...(weightedTotal === undefined ? {} : { weightedTotal }),
    ...(error === undefined
      ? {}
      : {
          error: {
            reason: error.reason,
            ...(error.criterion === undefined ? {} : { criterion: error.criterion }),
          },
        }),
  };
}

function toStatistics(statistics: AggregateStatistics): EvaluationRunRecord['statistics'] {
  return { verdicts: statistics.verdicts, criteria: [...statistics.criteria] };
}

interface CasePlacement {
  readonly ordinal: number;
  readonly visibility: CaseVisibility;
}

function toRunCase(aggregate: TrialAggregate, placement: CasePlacement): EvaluationRunCase {
  return {
    ...placement,
    ...(placement.visibility === 'public' ? { caseId: aggregate.caseId } : {}),
    outcome: aggregate.outcome,
    ...(aggregate.outcome === 'disagreement'
      ? { disagreementReasons: [...aggregate.disagreement.reasons] }
      : {}),
    statistics: toStatistics(aggregate.statistics),
    trials: aggregate.trials.map(toRunTrial),
  };
}

/** The summed cost of every trial, or `null` when any trial has no cost estimate. */
function totalCost(trials: readonly TrialRecord[]): number | null {
  let total = 0;
  for (const trial of trials) {
    if (trial.costEstimate === undefined) return null;
    total += trial.costEstimate.totalCost;
  }
  return total;
}

/** Orders `aggregates` by dataset position, rejecting any it cannot attribute to `evaluator`. */
function placeAggregates(
  evaluator: Evaluator,
  aggregates: readonly TrialAggregate[],
): { readonly aggregate: TrialAggregate; readonly placement: CasePlacement }[] {
  const { dataset, identity } = evaluator;
  if (aggregates.length === 0) throw new RangeError('An evaluation run records at least one case');
  const placements = new Map(
    dataset.cases.map((entry, index) => [
      entry.id,
      { ordinal: index + 1, visibility: entry.visibility },
    ]),
  );
  const placed = new Set<number>();
  // Messages cite ordinals, never case ids, so they are safe to print.
  return aggregates
    .map((aggregate) => {
      if (aggregate.evaluator.digest !== identity.digest) {
        throw new RangeError(
          `A case aggregate was scored by another evaluator (${aggregate.evaluator.digest}), not ${identity.digest}`,
        );
      }
      const placement = placements.get(aggregate.caseId);
      if (placement === undefined) {
        throw new RangeError(
          `A case aggregate names a case that is not in dataset "${dataset.id}" version "${dataset.version}"`,
        );
      }
      if (placed.has(placement.ordinal)) {
        throw new RangeError(`Case ${placement.ordinal} is aggregated more than once`);
      }
      placed.add(placement.ordinal);
      return { aggregate, placement };
    })
    .toSorted((left, right) => left.placement.ordinal - right.placement.ordinal);
}

/**
 * Builds the `evaluation-run` record for one run of `evaluator` over the
 * cases in `aggregates`. Throws a `RangeError` for an aggregate from another
 * evaluator, a case outside the evaluator's dataset, or a case aggregated
 * twice, and `EvaluatorConfigurationError` for an invalid id,
 * timestamp, or latency.
 */
export function toEvaluationRunRecord(options: EvaluationRunRecordOptions): EvaluationRunRecord {
  const { evaluator } = options;
  const { configuration, dataset, identity } = evaluator;
  const placed = placeAggregates(evaluator, options.aggregates);
  const aggregates = placed.map(({ aggregate }) => aggregate);
  const trials = aggregates.flatMap((aggregate) => aggregate.trials);
  const outcomeCount = (outcome: AggregateOutcome) =>
    aggregates.filter((aggregate) => aggregate.outcome === outcome).length;
  return parseEvaluationRunRecord({
    kind: 'evaluation-run',
    schemaVersion: EVALUATION_HISTORY_SCHEMA_VERSION,
    id: options.id,
    recordedAt: options.recordedAt,
    evaluator: { ...identity },
    resultSchemaVersion: configuration.resultSchemaVersion,
    dataset: { id: dataset.id, version: dataset.version },
    codeRevision: configuration.codeRevision,
    repetitions: configuration.repetitions,
    variancePolicy: configuration.variancePolicy ?? null,
    outcomes: {
      pass: outcomeCount('pass'),
      fail: outcomeCount('fail'),
      disagreement: outcomeCount('disagreement'),
      indeterminate: outcomeCount('indeterminate'),
    },
    statistics: toStatistics(aggregateStatistics(evaluator, trials)),
    costUsd: totalCost(trials),
    latencyMilliseconds: options.latencyMilliseconds,
    cases: placed.map(({ aggregate, placement }) => toRunCase(aggregate, placement)),
  } satisfies EvaluationRunRecord);
}

/** One metric in both runs, and `candidate - baseline` when both have it. */
export interface MetricDelta {
  readonly baseline: number | null;
  readonly candidate: number | null;
  readonly delta: number | null;
}

export interface CriterionDelta {
  readonly name: string;
  readonly passFraction: MetricDelta;
  readonly meanScore: MetricDelta;
}

/** What identifies one side of a comparison. */
export interface ComparedRun {
  readonly id: string;
  readonly digest: string;
  readonly recordedAt: string;
  readonly evaluator: EvaluatorIdentity;
  readonly dataset: EvaluationRunRecord['dataset'];
  readonly codeRevision: string;
}

export interface EvaluationRunComparison {
  readonly kind: 'evaluation-run-comparison';
  readonly baseline: ComparedRun;
  readonly candidate: ComparedRun;
  /** The pooled pass fraction over every trial that produced a verdict. */
  readonly verdicts: { readonly passFraction: MetricDelta };
  /** Every criterion in either run: the baseline's in order, then any only the candidate has. */
  readonly criteria: readonly CriterionDelta[];
  readonly costUsd: MetricDelta;
  readonly latencyMilliseconds: MetricDelta;
}

function metricDelta(
  baseline: number | null | undefined,
  candidate: number | null | undefined,
): MetricDelta {
  const before = baseline ?? null;
  const after = candidate ?? null;
  return {
    baseline: before,
    candidate: after,
    delta: before === null || after === null ? null : after - before,
  };
}

function comparedRun({ digest, record }: HistoricalRecord<EvaluationRunRecord>): ComparedRun {
  return {
    id: record.id,
    digest,
    recordedAt: record.recordedAt,
    evaluator: record.evaluator,
    dataset: record.dataset,
    codeRevision: record.codeRevision,
  };
}

/**
 * Per-criterion pass-fraction and mean-score deltas between two runs, with
 * the pooled verdict pass fraction, cost, and latency. A metric either run
 * lacks has a `null` delta, never `0`.
 */
export function compareEvaluationRuns(
  baseline: HistoricalRecord<EvaluationRunRecord>,
  candidate: HistoricalRecord<EvaluationRunRecord>,
): EvaluationRunComparison {
  const before = new Map(baseline.record.statistics.criteria.map((entry) => [entry.name, entry]));
  const after = new Map(candidate.record.statistics.criteria.map((entry) => [entry.name, entry]));
  const names = [...new Set([...before.keys(), ...after.keys()])];
  return {
    kind: 'evaluation-run-comparison',
    baseline: comparedRun(baseline),
    candidate: comparedRun(candidate),
    verdicts: {
      passFraction: metricDelta(
        baseline.record.statistics.verdicts.passFraction,
        candidate.record.statistics.verdicts.passFraction,
      ),
    },
    criteria: names.map((name) => ({
      name,
      passFraction: metricDelta(before.get(name)?.passFraction, after.get(name)?.passFraction),
      meanScore: metricDelta(before.get(name)?.meanScore, after.get(name)?.meanScore),
    })),
    costUsd: metricDelta(baseline.record.costUsd, candidate.record.costUsd),
    latencyMilliseconds: metricDelta(
      baseline.record.latencyMilliseconds,
      candidate.record.latencyMilliseconds,
    ),
  };
}
