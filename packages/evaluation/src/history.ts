/**
 * Append-only evaluation history (COR-896, "audit record"). Every evaluation
 * run is kept as one immutable `evaluation-run` record in a weft
 * `TextValueStore`: `BunSQLiteStorage` for the local file the `history`
 * command reads, `MemoryStorage` in tests. The store is the durable audit
 * record itself, so a local command never needs a running bureau.
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
 * does not parse, is not canonical, does not match the record schema, is
 * stored under another id, or does not match its digest is rejected with
 * {@link CorruptHistoricalRecordError}. Changing any single byte of a row
 * therefore always makes it unreadable rather than silently different.
 *
 * A record is built from `runTrials` aggregates by
 * {@link toEvaluationRunRecord}, which keeps the evidence a later comparison
 * or gate needs and drops everything that could leak a held-out case: a
 * held-out case is recorded by its ordinal in the dataset version, never by
 * its id, and no expected answer, run content, feedback, judge rationale, or
 * error message (any of which may quote one) is stored. The schema enforces
 * the id rule, so no record can carry a held-out id however it was built.
 */
import { sha256Hex } from '@lostgradient/cryptography';
import type { TokenUsage } from '@lostgradient/operative';
import type { ConditionalTextValueStore } from '@lostgradient/weft';
import { z } from 'zod';

import {
  codeRevisionSchema,
  EvaluatorConfigurationError,
  identifier,
  toConfigurationIssues,
  unitInterval,
} from './configuration';
import { CASE_VISIBILITIES, type CaseVisibility } from './datasets';
import { type AggregateOutcome, DISAGREEMENT_REASONS } from './disagreement';
import type { Evaluator } from './evaluator';
import { canonicalJson, type EvaluatorIdentity } from './identity';
import type { HardGateOutcome } from './rubric';
import {
  type AggregateStatistics,
  aggregateStatistics,
  type TrialAggregate,
  type TrialRecord,
} from './trials';
import { variancePolicySchema } from './variance';
import { AGENT_FAILURE_REASONS, type CaseVerdict, INFRASTRUCTURE_FAILURE_REASONS } from './verdict';

/** The version of the {@link EvaluationRunRecord} shape this package writes. */
export const EVALUATION_HISTORY_SCHEMA_VERSION = 1;

const RECORD_KEY_PREFIX = 'evaluation-history/records/';

const CASE_VERDICTS = [
  'pass',
  'fail',
  'agent-failed',
  'infrastructure-failure',
] as const satisfies readonly CaseVerdict[];
const HARD_GATE_OUTCOMES = [
  'passed',
  'failed',
  'not-applicable',
] as const satisfies readonly HardGateOutcome[];
const AGGREGATE_OUTCOMES = [
  'pass',
  'fail',
  'disagreement',
  'indeterminate',
] as const satisfies readonly AggregateOutcome[];

const count = z.number().int().min(0);
const nonNegative = z.number().min(0);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 digest');

/** A record id is a plain identifier, so it is always a safe storage key and command argument. */
const historicalRecordIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    'Expected 1 to 128 letters, digits, dots, underscores, or hyphens, starting with a letter or digit',
  );

const trialStatisticsFields = {
  trials: count,
  passes: count,
  passFraction: unitInterval.nullable(),
  wilsonInterval: z
    .strictObject({ lower: unitInterval, upper: unitInterval, width: unitInterval })
    .nullable(),
};

const statisticsSchema = z.strictObject({
  verdicts: z.strictObject(trialStatisticsFields),
  criteria: z.array(
    z.strictObject({
      name: identifier,
      ...trialStatisticsFields,
      meanScore: unitInterval.nullable(),
      sampleVariance: nonNegative.nullable(),
      standardDeviation: nonNegative.nullable(),
    }),
  ),
});

const trialSchema = z.strictObject({
  trial: z.number().int().positive(),
  seed: z.number().int().min(0).max(0xffff_ffff),
  verdict: z.enum(CASE_VERDICTS),
  finishReason: z.enum(['stop-condition', ...AGENT_FAILURE_REASONS]).optional(),
  usage: z
    .strictObject({
      prompt: nonNegative,
      completion: nonNegative,
      total: nonNegative,
      cacheCreationTokens: nonNegative.optional(),
      cacheReadTokens: nonNegative.optional(),
    })
    .optional(),
  costUsd: nonNegative.optional(),
  /** Scores only: a judge's rationale may quote the expected answer. */
  scores: z.array(
    z.strictObject({
      name: identifier,
      score: unitInterval,
      hardGate: z.enum(HARD_GATE_OUTCOMES),
    }),
  ),
  weightedTotal: unitInterval.optional(),
  /** The typed reason only: an error's message may name the case. */
  error: z
    .strictObject({
      reason: z.enum(INFRASTRUCTURE_FAILURE_REASONS),
      criterion: identifier.optional(),
    })
    .optional(),
});

const caseSchema = z
  .strictObject({
    /** The case's 1-based position in the dataset version. */
    ordinal: z.number().int().positive(),
    visibility: z.enum(CASE_VISIBILITIES),
    /** Present exactly when the case is public. */
    caseId: identifier.optional(),
    outcome: z.enum(AGGREGATE_OUTCOMES),
    disagreementReasons: z.array(z.enum(DISAGREEMENT_REASONS)).optional(),
    statistics: statisticsSchema,
    trials: z.array(trialSchema).min(1),
  })
  .superRefine((entry, context) => {
    if (entry.visibility === 'held-out' && entry.caseId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['caseId'],
        message: 'A held-out case is recorded by ordinal, never by id',
      });
    }
    if (entry.visibility === 'public' && entry.caseId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['caseId'],
        message: 'A public case is recorded with its id',
      });
    }
  });

export const evaluationRunRecordSchema = z.strictObject({
  kind: z.literal('evaluation-run'),
  schemaVersion: z.literal(EVALUATION_HISTORY_SCHEMA_VERSION),
  id: historicalRecordIdSchema,
  recordedAt: z.iso.datetime({ offset: true }),
  evaluator: z.strictObject({
    name: identifier,
    revision: z.number().int().positive(),
    digest: digestSchema,
  }),
  resultSchemaVersion: z.number().int().positive(),
  dataset: z.strictObject({ id: identifier, version: identifier }),
  codeRevision: codeRevisionSchema,
  repetitions: z.number().int().min(1),
  variancePolicy: variancePolicySchema.nullable(),
  /** How many cases ended in each aggregate outcome. */
  outcomes: z.strictObject({
    pass: count,
    fail: count,
    disagreement: count,
    indeterminate: count,
  }),
  /** Verdict and per-criterion statistics pooled over every trial of every case. */
  statistics: statisticsSchema,
  /** The summed cost estimate of every trial; `null` when any trial has none. */
  costUsd: nonNegative.nullable(),
  latencyMilliseconds: nonNegative,
  /** In dataset order. */
  cases: z.array(caseSchema).min(1),
});

export type EvaluationRunRecord = z.output<typeof evaluationRunRecordSchema>;
export type EvaluationRunCase = EvaluationRunRecord['cases'][number];
export type EvaluationRunTrial = EvaluationRunCase['trials'][number];

const historicalRecordSchema = z.strictObject({
  digest: digestSchema,
  record: evaluationRunRecordSchema,
});

/** A stored record and the SHA-256 of its canonical JSON. */
export interface HistoricalRecord {
  readonly digest: string;
  readonly record: EvaluationRunRecord;
}

/** Parses an evaluation-run record, throwing {@link EvaluatorConfigurationError} on any issue. */
export function parseEvaluationRunRecord(input: unknown): EvaluationRunRecord {
  const parsed = evaluationRunRecordSchema.safeParse(input);
  if (!parsed.success) throw new EvaluatorConfigurationError(toConfigurationIssues(parsed.error));
  return parsed.data;
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
  append(record: EvaluationRunRecord): Promise<HistoricalRecord>;
  /** The verified record, or `undefined` when no record has this id. */
  read(id: string): Promise<HistoricalRecord | undefined>;
  /** Every verified record, oldest first. Rejects if any record is corrupt. */
  list(): Promise<HistoricalRecord[]>;
}

function digestOf(record: EvaluationRunRecord): Promise<string> {
  return sha256Hex(canonicalJson(record));
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
      `does not match the evaluation-run record schema: ${z.prettifyError(envelope.error)}`,
    );
  }
  const { digest, record } = envelope.data;
  if (record.id !== id) {
    throw new CorruptHistoricalRecordError(id, `names "${record.id}" but is stored under "${id}"`);
  }
  if ((await digestOf(record)) !== digest) {
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

  async function append(input: EvaluationRunRecord): Promise<HistoricalRecord> {
    const record = parseEvaluationRunRecord(input);
    const historical: HistoricalRecord = { digest: await digestOf(record), record };
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

function toUsage(usage: TokenUsage): NonNullable<EvaluationRunTrial['usage']> {
  const { cacheCreationTokens, cacheReadTokens } = usage;
  return {
    prompt: usage.prompt,
    completion: usage.completion,
    total: usage.total,
    ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
  };
}

function toRunTrial(trial: TrialRecord): EvaluationRunTrial {
  const { finishReason, usage, costEstimate, weightedTotal, error } = trial;
  return {
    trial: trial.trial,
    seed: trial.seed,
    verdict: trial.verdict,
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(usage === undefined ? {} : { usage: toUsage(usage) }),
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
 * twice, and {@link EvaluatorConfigurationError} for an invalid id,
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

function comparedRun({ digest, record }: HistoricalRecord): ComparedRun {
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
  baseline: HistoricalRecord,
  candidate: HistoricalRecord,
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
