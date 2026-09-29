/**
 * The local release gate (COR-896, "CI gate, in a repository with no CI").
 * This repository has no hosted CI, so a gate is a local command: it decides
 * whether an evaluator's current evidence clears a gate against an explicit
 * baseline, appends exactly one `gate-decision` record, and exits with a
 * stable code. Nothing runs it automatically and nothing blocks a merge on it.
 *
 * One gate run:
 *
 * 1. Prepares the gate. A gate file that is missing or invalid, an evaluator
 *    module that cannot be loaded or built, an evaluator whose dataset is not
 *    the one the gate names, a threshold on a criterion the evaluator does
 *    not have, or an unreadable committed baseline is a configuration error:
 *    exit 64, and nothing is appended.
 * 2. Runs every case of the evaluator's dataset through `scoreTrials`, the
 *    repeated-trial executor behind `runTrials`, recording each trial's seed,
 *    reviewer-projection run, and raw model-judge reply as evidence.
 * 3. Resolves the baseline, the overrides the history holds for the gate,
 *    and the judge's and dataset's eligibility, then {@link decideGate}.
 * 4. Appends the decision, which carries every input the decision was made
 *    from, so `replay` can recompute it without calling a model.
 *
 * Exit codes, which a person or agent reads from `$?`:
 *
 * - `0` pass: every threshold held against an unexpired, comparable baseline
 *   at the declared sample size, with no unresolved infrastructure failure.
 * - `1` regression: a threshold was breached, and it was hard or no valid,
 *   unexpired override cleared it.
 * - `2` evaluator infrastructure failure, including a gate run over budget.
 * - `3` insufficient evidence: too few trials, a missing, expired, or
 *   incomparable baseline, an uncalibrated or drift-unchecked model judge, a
 *   dataset without a contamination check, or an unresolved disagreement.
 * - `64` invalid gate configuration or usage.
 *
 * When several gates run, the command exits with the most severe code, in
 * the order `64` > `2` > `3` > `1` > `0`. An evaluator failure never passes.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { sha256Hex } from '@lostgradient/cryptography';
import type {
  GenerateFunction,
  RunnableAgent,
  RunResultBase,
  RuntimeServices,
} from '@lostgradient/operative';
import { z } from 'zod';

import { calibrationRecordSchema, driftCheckRecordSchema, judgeEligibility } from './calibration';
import { EvaluatorConfigurationError, type JudgeKind } from './configuration';
import type { CriterionScorers } from './criteria';
import {
  contaminationCheckSchema,
  type EvaluationCase,
  type EvaluationDataset,
  isGateEligibleDataset,
} from './datasets';
import {
  type EvaluationRunRecord,
  parseEvaluationRunRecord,
  toRecordedUsage,
} from './evaluation-run';
import { createEvaluator, type Evaluator } from './evaluator';
import {
  type CaseEvidence,
  type ConsideredOverride,
  GATE_RECORD_SCHEMA_VERSION,
  type GateDecision,
  type GateDecisionRecord,
  type GateDefinition,
  type GateEligibility,
  type GateFindings,
  gateIdSchema,
  type GateOverrideRecord,
  type GateOverrides,
  parseGateDefinition,
  type RecordedBaseline,
  type Regression,
  runProjectionSchema,
  type TrialEvidence,
} from './gate';
import {
  compareEvaluationRuns,
  type EvaluationHistory,
  type EvaluationRunComparison,
  type HistoricalRecord,
  recordDigest,
  toEvaluationRunRecord,
} from './history';
import { canonicalJson } from './identity';
import { judgeRevisionOf } from './judge-drift';
import { assessOverride, decisionRejection, passedWithoutOverride } from './override';
import { toReviewerRunProjection } from './projections';
import { scoreTrials, type TrialAggregate, type TrialContext } from './trials';

/**
 * What a gate's evaluator module's default export builds: an evaluator
 * configuration and dataset, the scorers and model judge they need, the
 * agent under evaluation, and the recorded eligibility evidence. The module
 * builds a fresh one for every gate run, so scripted fixtures start over.
 */
export interface GateEvaluatorDefinition {
  /** An evaluator configuration, validated with `evaluatorConfigurationSchema`. */
  readonly configuration: unknown;
  /** The dataset the configuration scores, validated with `evaluationDatasetSchema`. */
  readonly dataset: unknown;
  readonly scorers?: CriterionScorers | undefined;
  /** The model judge's provider call, required for model-judge criteria. */
  readonly judge?: GenerateFunction | undefined;
  /** The operative agent one trial runs. */
  readonly subject: (trial: TrialContext) => RunnableAgent<unknown, boolean>;
  /** Contamination checks the dataset owner recorded (`contaminationCheckSchema`). */
  readonly contaminationChecks: readonly unknown[];
  /** Human calibration records of judge revisions (`calibrationRecordSchema`). */
  readonly calibrationRecords: readonly unknown[];
  /** Drift checks of judge revisions, as `{ judgeRevision, outcome }` or full checks. */
  readonly driftChecks: readonly unknown[];
}

/** Resolves an evaluator module's absolute path to a fresh definition. */
export type GateEvaluatorLoader = (modulePath: string) => Promise<GateEvaluatorDefinition>;

/** Imports an evaluator module and calls its default export. */
export async function loadGateEvaluator(modulePath: string): Promise<GateEvaluatorDefinition> {
  const loaded: { readonly default?: unknown } = await import(modulePath);
  if (typeof loaded.default !== 'function') {
    throw new EvaluatorConfigurationError([
      {
        path: ['evaluator'],
        message: `${modulePath} has no default export that builds an evaluator`,
      },
    ]);
  }
  return (await loaded.default()) as GateEvaluatorDefinition;
}

/** The evaluation package: a decision records module and baseline paths relative to it. */
export const EVALUATION_PACKAGE_DIRECTORY = resolve(import.meta.dir, '..');

/** A gate's outcome: its decision, or a configuration error that stopped it from running. */
export type GateOutcome = GateDecision | 'configuration-error';

export const RELEASE_GATE_EXIT_CODES = {
  pass: 0,
  regression: 1,
  'infrastructure-failure': 2,
  'insufficient-evidence': 3,
  'configuration-error': 64,
} as const satisfies Record<GateOutcome, number>;

/** Most severe first: `64` > `2` > `3` > `1` > `0`. */
const PRECEDENCE: readonly GateOutcome[] = [
  'configuration-error',
  'infrastructure-failure',
  'insufficient-evidence',
  'regression',
  'pass',
];

/** The most severe of `outcomes`; a run of no gates at all is a configuration error. */
export function mostSevere(outcomes: readonly GateOutcome[]): GateOutcome {
  return PRECEDENCE.find((outcome) => outcomes.includes(outcome)) ?? 'configuration-error';
}

/** Deltas this close to a threshold are treated as on it, so float noise never decides. */
const THRESHOLD_TOLERANCE = 1e-9;

export interface RunReleaseGateOptions {
  /** The directory holding `<gateId>.json`. */
  readonly gatesDirectory: string;
  readonly gateId: string;
  readonly history: EvaluationHistory;
  /** The principal running the gate. */
  readonly actor: string;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Draws trial seeds. Defaults to the real-globals runtime services. */
  readonly runtime?: Pick<RuntimeServices, 'random'> | undefined;
  /** The decision's record id. Defaults to the gate id, the time, and a random suffix. */
  readonly createId?: ((gateId: string, recordedAt: string) => string) | undefined;
  /**
   * Commits from one code revision to another, or `undefined` when that
   * cannot be determined. Only asked about two different revisions. Without
   * it, a baseline at another revision has an unknown distance.
   */
  readonly revisionDistance?: ((from: string, to: string) => number | undefined) | undefined;
  /**
   * The repository revision the gate runs at (`git rev-parse HEAD` in the
   * command). Recorded on the decision when given; a promotion signal can
   * only be issued from a decision that records one.
   */
  readonly sourceRevision?: string | undefined;
  readonly loadEvaluator?: GateEvaluatorLoader | undefined;
}

export type GateRunResult =
  | {
      readonly gateId: string;
      readonly decision: 'configuration-error';
      readonly issues: readonly string[];
    }
  | {
      readonly gateId: string;
      readonly decision: GateDecision;
      readonly historical: HistoricalRecord<GateDecisionRecord>;
      readonly comparison: EvaluationRunComparison | null;
    };

/** Why a gate could not run. Collected before anything is appended. */
class GateConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join('; '));
    this.issues = issues;
  }
}

/** Runs `work`, turning any failure into a configuration error about `where`. */
async function configured<T>(where: string, work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof EvaluatorConfigurationError) {
      throw new GateConfigurationError(
        error.issues.map(
          (issue) => `${where}: ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
        ),
      );
    }
    throw new GateConfigurationError([
      `${where}: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

const definitionEvidenceSchema = z.object({
  contaminationChecks: z.array(contaminationCheckSchema),
  calibrationRecords: z.array(calibrationRecordSchema),
  driftChecks: z.array(driftCheckRecordSchema),
});

type DefinitionEvidence = z.output<typeof definitionEvidenceSchema>;

/** One trial's recorded evidence while it runs. */
interface TrialSlot {
  run: TrialEvidence['run'];
  judge: TrialEvidence['judge'];
}

interface PreparedGate {
  readonly gate: GateDefinition;
  readonly modulePath: string;
  readonly definition: GateEvaluatorDefinition;
  readonly evaluator: Evaluator;
  readonly evidence: DefinitionEvidence;
  /** The committed baseline run, when the gate names one. */
  readonly baselineFile: { readonly path: string; readonly run: EvaluationRunRecord } | undefined;
  /** The trial whose evidence is being recorded. */
  readonly startTrial: () => TrialSlot;
}

/** Wraps the model judge so each call's reply, or its throw, lands in the running trial's slot. */
function recordingJudge(generate: GenerateFunction, current: () => TrialSlot): GenerateFunction {
  return async (context) => {
    const slot = current();
    try {
      const response = await generate(context);
      slot.judge = {
        kind: 'reply',
        content: response.content,
        requestedTools: response.toolCalls.map((call) => call.name),
      };
      return response;
    } catch (error) {
      slot.judge = { kind: 'error' };
      throw error;
    }
  };
}

function evaluatorIssues(gate: GateDefinition, evaluator: Evaluator): string[] {
  const { configuration, dataset } = evaluator;
  const issues: string[] = [];
  if (dataset.id !== gate.dataset.id || dataset.version !== gate.dataset.version) {
    issues.push(
      `evaluator: scores dataset "${dataset.id}" version "${dataset.version}", but the gate names "${gate.dataset.id}" version "${gate.dataset.version}"`,
    );
  }
  const criteria = new Set(configuration.criteria.map((criterion) => criterion.name));
  for (const threshold of gate.regressionThresholds) {
    if (!criteria.has(threshold.criterion)) {
      issues.push(`regressionThresholds: the evaluator has no criterion "${threshold.criterion}"`);
    }
  }
  return issues;
}

async function prepareGate(options: RunReleaseGateOptions): Promise<PreparedGate> {
  const { gatesDirectory, gateId } = options;
  const parsedId = gateIdSchema.safeParse(gateId);
  if (!parsedId.success) {
    throw new GateConfigurationError([
      `gate: "${gateId}" is not a gate id: ${parsedId.error.issues[0]!.message}`,
    ]);
  }
  const gateFile = join(gatesDirectory, `${gateId}.json`);
  const gate = await configured('gate', async () => parseGateDefinition(await readJson(gateFile)));
  const gateDirectory = dirname(gateFile);
  const modulePath = resolve(gateDirectory, gate.evaluator);
  let slot: TrialSlot = { run: null, judge: null };
  const startTrial = () => (slot = { run: null, judge: null });
  const { definition, evaluator, evidence } = await configured('evaluator', async () => {
    const loaded = await (options.loadEvaluator ?? loadGateEvaluator)(modulePath);
    if (typeof loaded.subject !== 'function') {
      throw new TypeError(`${modulePath} builds an evaluator without a subject agent`);
    }
    const built = await createEvaluator({
      configuration: loaded.configuration,
      dataset: loaded.dataset,
      scorers: loaded.scorers,
      generate: loaded.judge === undefined ? undefined : recordingJudge(loaded.judge, () => slot),
    });
    const parsed = definitionEvidenceSchema.safeParse(loaded);
    if (!parsed.success) {
      throw new EvaluatorConfigurationError(
        parsed.error.issues.map(({ path, message }) => ({ path, message })),
      );
    }
    return { definition: loaded, evaluator: built, evidence: parsed.data };
  });
  const issues = evaluatorIssues(gate, evaluator);
  if (issues.length > 0) throw new GateConfigurationError(issues);
  const { baseline } = gate;
  const baselineFile =
    baseline.kind === 'evaluation-run'
      ? await configured('baseline', async () => {
          const path = resolve(gateDirectory, baseline.path);
          return { path, run: parseEvaluationRunRecord(await readJson(path)) };
        })
      : undefined;
  return { gate, modulePath, definition, evaluator, evidence, baselineFile, startTrial };
}

/** A run projection as plain JSON with only the usage counters a record keeps. */
function recordRun(result: RunResultBase): NonNullable<TrialSlot['run']> {
  const projection = toReviewerRunProjection(result);
  const { costEstimate } = projection;
  return runProjectionSchema.parse(
    JSON.parse(
      JSON.stringify({
        ...projection,
        usage: toRecordedUsage(projection.usage),
        costEstimate:
          costEstimate === undefined
            ? undefined
            : { ...costEstimate, usage: toRecordedUsage(costEstimate.usage) },
      }),
    ),
  );
}

/** Where a case sits in the dataset: a held-out case by ordinal alone. */
function casePlacement(
  evaluationCase: EvaluationCase,
  ordinal: number,
): Pick<CaseEvidence, 'ordinal' | 'visibility' | 'caseId'> {
  return {
    ordinal,
    visibility: evaluationCase.visibility,
    ...(evaluationCase.visibility === 'public' ? { caseId: evaluationCase.id } : {}),
  };
}

async function runCandidate(
  prepared: PreparedGate,
  runtime: RunReleaseGateOptions['runtime'],
): Promise<{ readonly evidence: CaseEvidence[]; readonly aggregates: TrialAggregate[] }> {
  const { evaluator, definition } = prepared;
  const evidence: CaseEvidence[] = [];
  const aggregates: TrialAggregate[] = [];
  for (const [index, evaluationCase] of evaluator.dataset.cases.entries()) {
    const slots: TrialSlot[] = [];
    const aggregate = await scoreTrials({
      evaluator,
      caseId: evaluationCase.id,
      runtime,
      runResult: async (context, input) => {
        const slot = prepared.startTrial();
        slots.push(slot);
        const result = await definition.subject(context).run(input).result();
        slot.run = recordRun(result);
        return result;
      },
    });
    aggregates.push(aggregate);
    evidence.push({
      ...casePlacement(evaluationCase, index + 1),
      trials: aggregate.trials.map((trial, trialIndex) => {
        const slot = slots[trialIndex]!;
        const latencyBudgetExceeded = trial.error?.reason === 'latency-budget-exceeded';
        // A judge still in flight when the budget expired may land later; it is not evidence.
        return {
          trial: trial.trial,
          seed: trial.seed,
          run: slot.run,
          judge: latencyBudgetExceeded ? null : slot.judge,
          latencyBudgetExceeded,
        };
      }),
    });
  }
  return { evidence, aggregates };
}

function isGateDecision(
  historical: HistoricalRecord,
): historical is HistoricalRecord<GateDecisionRecord> {
  return historical.record.kind === 'gate-decision';
}

function isGateOverride(
  historical: HistoricalRecord,
): historical is HistoricalRecord<GateOverrideRecord> {
  return historical.record.kind === 'gate-override';
}

type BaselineFound = Pick<RecordedBaseline, 'source' | 'run'>;

/**
 * The newest decision of this gate that passed without any override, or that
 * the override authority accepted as a permanent baseline change. A decision
 * that passed only because an expiring override cleared a regression is never
 * adopted on its own: that would keep the regression cleared after the
 * override expires.
 */
function latestAcceptedDecision(
  records: readonly HistoricalRecord[],
  gateId: string,
  gate: GateDefinition,
  at: string,
): BaselineFound | undefined {
  const changes = records
    .filter(isGateOverride)
    .filter(({ record }) => record.gateId === gateId && record.permanentBaselineChange);
  const decisions = records
    .filter(isGateDecision)
    .filter(({ record }) => record.gateId === gateId)
    .toReversed();
  for (const { digest, record } of decisions) {
    const acceptedBy = passedWithoutOverride(record)
      ? null
      : changes.find(
          (change) =>
            change.record.gateDecisionId === record.id &&
            assessOverride({ override: change.record, decision: record, gate, at }) === 'valid' &&
            decisionRejection(record, true) === undefined,
        )?.record.id;
    if (acceptedBy !== undefined) {
      return {
        source: { kind: 'gate-decision', recordId: record.id, digest, acceptedBy },
        run: record.candidate,
      };
    }
  }
  return undefined;
}

async function resolveBaseline(
  prepared: PreparedGate,
  options: RunReleaseGateOptions,
  records: readonly HistoricalRecord[],
  candidate: EvaluationRunRecord,
): Promise<RecordedBaseline | null> {
  const { baselineFile, gate } = prepared;
  const found: BaselineFound | undefined =
    baselineFile === undefined
      ? latestAcceptedDecision(records, options.gateId, gate, candidate.recordedAt)
      : {
          source: {
            kind: 'evaluation-run',
            path: relative(EVALUATION_PACKAGE_DIRECTORY, baselineFile.path),
            digest: await recordDigest(baselineFile.run),
          },
          run: baselineFile.run,
        };
  if (found === undefined) return null;
  const from = found.run.codeRevision;
  const to = candidate.codeRevision;
  return {
    ...found,
    ageMilliseconds: Date.parse(candidate.recordedAt) - Date.parse(found.run.recordedAt),
    revisionDistance: from === to ? 0 : (options.revisionDistance?.(from, to) ?? null),
  };
}

/**
 * Every expiring override of this gate, with its validity now and what it
 * could clear: only the overridden decision's overridable regressions. A
 * regression that was hard when the authority answered was never answered,
 * so demoting its threshold later does not let the override clear it.
 */
function considerOverrides(
  records: readonly HistoricalRecord[],
  gateId: string,
  gate: GateDefinition,
  evaluatorDigest: string,
  at: string,
): ConsideredOverride[] {
  const decisions = new Map(
    records.filter(isGateDecision).map(({ record }) => [record.id, record]),
  );
  return records
    .filter(isGateOverride)
    .filter(({ record }) => record.gateId === gateId && !record.permanentBaselineChange)
    .map(({ digest, record }) => {
      const decision = decisions.get(record.gateDecisionId);
      return {
        id: record.id,
        digest,
        gateDecisionId: record.gateDecisionId,
        validity: assessOverride({ override: record, decision, gate, at, evaluatorDigest }),
        covers: (decision?.findings.regressions ?? [])
          .filter(({ severity }) => severity === 'overridable')
          .map(({ criterion, metric, delta }) => ({ criterion, metric, delta })),
      };
    });
}

async function gateEligibility(prepared: PreparedGate): Promise<GateEligibility> {
  const { configuration, dataset } = prepared.evaluator;
  const { contaminationChecks, calibrationRecords, driftChecks } = prepared.evidence;
  const contaminationChecked = isGateEligibleDataset({
    dataset,
    codeRevision: configuration.codeRevision,
    contaminationChecks,
  });
  if (configuration.judge.kind !== 'model') return { contaminationChecked, judge: null };
  const { digest } = await judgeRevisionOf(configuration);
  return {
    contaminationChecked,
    judge: {
      revision: digest,
      ...judgeEligibility({ judgeRevision: digest, driftChecks, calibrationRecords }),
    },
  };
}

/** The SHA-256 of a dataset version's canonical JSON, cases and expected answers included. */
export function datasetDigest(dataset: EvaluationDataset): Promise<string> {
  return sha256Hex(canonicalJson(dataset));
}

/**
 * The sample a gate's `sampleSize` counts: every trial for a stochastic
 * judge, or every held-out case for a deterministic one.
 */
function recordedSampleSize(candidate: EvaluationRunRecord, judge: JudgeKind): number {
  if (judge === 'deterministic') {
    return candidate.cases.filter((entry) => entry.visibility === 'held-out').length;
  }
  return candidate.cases.reduce((total, entry) => total + entry.trials.length, 0);
}

/** Everything a decision is made from. A replay supplies the same inputs from the record. */
export interface GateDecisionInputs {
  readonly gate: GateDefinition;
  readonly judge: JudgeKind;
  readonly eligibility: GateEligibility;
  readonly candidate: EvaluationRunRecord;
  readonly baseline: RecordedBaseline | null;
  readonly overrides: readonly ConsideredOverride[];
}

export interface GateDecisionOutputs {
  readonly comparison: EvaluationRunComparison | null;
  readonly overrides: Pick<GateOverrides, 'applied' | 'rejected'>;
  readonly findings: GateFindings;
  readonly decision: GateDecision;
}

type Finding<K extends keyof GateFindings> = GateFindings[K][number];

function candidateFindings(inputs: GateDecisionInputs): {
  readonly infrastructureFailures: Finding<'infrastructureFailures'>[];
  readonly insufficientEvidence: Finding<'insufficientEvidence'>[];
} {
  const { gate, candidate, eligibility } = inputs;
  const infrastructureFailures: Finding<'infrastructureFailures'>[] = [];
  const insufficientEvidence: Finding<'insufficientEvidence'>[] = [];
  for (const entry of candidate.cases) {
    if (entry.outcome === 'indeterminate') {
      const reasons = entry.trials.flatMap((trial) =>
        trial.error === undefined ? [] : [`trial ${trial.trial}: ${trial.error.reason}`],
      );
      infrastructureFailures.push({
        reason: 'evaluator-infrastructure-failure',
        detail: `Case ${entry.ordinal} could not be scored (${reasons.join(', ')})`,
      });
    }
    if (entry.outcome === 'disagreement') {
      insufficientEvidence.push({
        reason: 'unresolved-disagreement',
        detail: `Case ${entry.ordinal}'s trials disagree (${entry.disagreementReasons!.join(', ')})`,
      });
    }
  }
  const { costUsd, latencyMilliseconds } = gate.budgets;
  if (candidate.costUsd !== null && candidate.costUsd > costUsd) {
    infrastructureFailures.push({
      reason: 'gate-budget-exceeded',
      detail: `The gate run cost ${candidate.costUsd} USD; its budget is ${costUsd} USD`,
    });
  }
  if (candidate.latencyMilliseconds > latencyMilliseconds) {
    infrastructureFailures.push({
      reason: 'gate-budget-exceeded',
      detail: `The gate run took ${candidate.latencyMilliseconds} ms; its budget is ${latencyMilliseconds} ms`,
    });
  }
  const recorded = recordedSampleSize(candidate, inputs.judge);
  if (recorded < gate.sampleSize) {
    insufficientEvidence.push({
      reason: 'sample-size-not-met',
      detail: `${recorded} ${inputs.judge === 'deterministic' ? 'held-out cases' : 'trials'} recorded; the gate requires ${gate.sampleSize}`,
    });
  }
  if (!eligibility.contaminationChecked) {
    insufficientEvidence.push({
      reason: 'dataset-not-contamination-checked',
      detail: `No contamination check by the dataset owner covers dataset "${candidate.dataset.id}" version "${candidate.dataset.version}" at ${candidate.codeRevision}`,
    });
  }
  if (eligibility.judge?.calibrated === false) {
    insufficientEvidence.push({
      reason: 'judge-uncalibrated',
      detail: `Judge revision ${eligibility.judge.revision} has no human calibration record`,
    });
  }
  if (eligibility.judge?.driftChecked === false) {
    insufficientEvidence.push({
      reason: 'judge-not-drift-checked',
      detail: `Judge revision ${eligibility.judge.revision} has no passing drift check, or a check found drift`,
    });
  }
  return { infrastructureFailures, insufficientEvidence };
}

function describeSource(baseline: RecordedBaseline): string {
  const { source } = baseline;
  return source.kind === 'evaluation-run'
    ? `evaluation run ${source.path}`
    : `gate decision "${source.recordId}"`;
}

/** Why `baseline` cannot be compared with `candidate`; empty when it can. */
function baselineFindings(
  gate: GateDefinition,
  baseline: RecordedBaseline,
  candidate: EvaluationRunRecord,
): Finding<'insufficientEvidence'>[] {
  const findings: Finding<'insufficientEvidence'>[] = [];
  const described = describeSource(baseline);
  const { dataset } = baseline.run;
  if (dataset.id !== candidate.dataset.id || dataset.version !== candidate.dataset.version) {
    findings.push({
      reason: 'baseline-not-comparable',
      detail: `Baseline ${described} scored dataset "${dataset.id}" version "${dataset.version}", not "${candidate.dataset.id}" version "${candidate.dataset.version}"`,
    });
  }
  const { maximumAgeMs, maximumRevisionDistance } = gate.expiry;
  if (maximumAgeMs !== undefined && baseline.ageMilliseconds > maximumAgeMs) {
    findings.push({
      reason: 'baseline-expired',
      detail: `Baseline ${described} is ${baseline.ageMilliseconds} ms old; the gate accepts at most ${maximumAgeMs} ms`,
    });
  }
  if (maximumRevisionDistance !== undefined) {
    const { revisionDistance } = baseline;
    if (revisionDistance === null) {
      findings.push({
        reason: 'baseline-expired',
        detail: `The distance from baseline ${described} at ${baseline.run.codeRevision} to ${candidate.codeRevision} could not be determined`,
      });
    } else if (revisionDistance > maximumRevisionDistance) {
      findings.push({
        reason: 'baseline-expired',
        detail: `Baseline ${described} is ${revisionDistance} commits behind; the gate accepts at most ${maximumRevisionDistance}`,
      });
    }
  }
  return findings;
}

/** Every threshold breach, and every threshold whose metric one of the runs lacks. */
function thresholdFindings(
  gate: GateDefinition,
  comparison: EvaluationRunComparison,
): {
  readonly regressions: Regression[];
  readonly incomparable: Finding<'insufficientEvidence'>[];
} {
  const regressions: Regression[] = [];
  const incomparable: Finding<'insufficientEvidence'>[] = [];
  for (const threshold of gate.regressionThresholds) {
    const { criterion, metric, maximumDecrease, severity } = threshold;
    const measured = comparison.criteria.find((entry) => entry.name === criterion)?.[metric];
    if (measured?.delta === null || measured === undefined) {
      incomparable.push({
        reason: 'criterion-not-comparable',
        detail: `"${criterion}" ${metric} is missing from the baseline or the run`,
      });
      continue;
    }
    if (measured.delta < -(maximumDecrease + THRESHOLD_TOLERANCE)) {
      regressions.push({
        criterion,
        metric,
        severity,
        maximumDecrease,
        baseline: measured.baseline!,
        candidate: measured.candidate!,
        delta: measured.delta,
        overriddenBy: null,
      });
    }
  }
  return { regressions, incomparable };
}

/** Clears each overridable regression a valid override covers; reports every override it cannot use. */
function applyOverrides(
  regressions: readonly Regression[],
  overrides: readonly ConsideredOverride[],
): { readonly regressions: Regression[]; readonly overrides: GateDecisionOutputs['overrides'] } {
  const applied: string[] = [];
  const rejected: GateOverrides['rejected'] = [];
  const resolved = regressions.map((regression) => {
    let overriddenBy: string | null = null;
    for (const override of overrides) {
      const covered = override.covers.some(
        (entry) =>
          entry.criterion === regression.criterion &&
          entry.metric === regression.metric &&
          regression.delta >= entry.delta - THRESHOLD_TOLERANCE,
      );
      if (!covered) continue;
      const reason =
        override.validity === 'valid'
          ? regression.severity === 'hard'
            ? 'hard-regression'
            : undefined
          : override.validity;
      const { criterion, metric } = regression;
      if (reason !== undefined) rejected.push({ id: override.id, criterion, metric, reason });
      else if (overriddenBy === null) {
        overriddenBy = override.id;
        if (!applied.includes(override.id)) applied.push(override.id);
      }
    }
    return { ...regression, overriddenBy };
  });
  return { regressions: resolved, overrides: { applied, rejected } };
}

/**
 * The decision for one gate run, from its inputs alone. Infrastructure
 * failure outranks insufficient evidence, which outranks an uncleared
 * regression; only a run with none of them passes.
 */
export async function decideGate(inputs: GateDecisionInputs): Promise<GateDecisionOutputs> {
  const { gate, candidate, baseline } = inputs;
  const { infrastructureFailures, insufficientEvidence } = candidateFindings(inputs);
  let comparison: EvaluationRunComparison | null = null;
  let breaches: Regression[] = [];
  if (baseline === null) {
    insufficientEvidence.push({
      reason: 'baseline-missing',
      detail:
        gate.baseline.kind === 'latest-passing-decision'
          ? 'No earlier decision of this gate passed without an override or was accepted as its baseline'
          : 'The gate names no baseline run',
    });
  } else {
    const refused = baselineFindings(gate, baseline, candidate);
    insufficientEvidence.push(...refused);
    if (refused.length === 0) {
      comparison = compareEvaluationRuns(
        { digest: await recordDigest(baseline.run), record: baseline.run },
        { digest: await recordDigest(candidate), record: candidate },
      );
      const measured = thresholdFindings(gate, comparison);
      breaches = measured.regressions;
      insufficientEvidence.push(...measured.incomparable);
    }
  }
  const { regressions, overrides } = applyOverrides(breaches, inputs.overrides);
  let decision: GateDecision = 'pass';
  if (infrastructureFailures.length > 0) decision = 'infrastructure-failure';
  else if (insufficientEvidence.length > 0) decision = 'insufficient-evidence';
  else if (regressions.some((regression) => regression.overriddenBy === null)) {
    decision = 'regression';
  }
  return {
    comparison,
    overrides,
    findings: { infrastructureFailures, insufficientEvidence, regressions },
    decision,
  };
}

function defaultRecordId(gateId: string, recordedAt: string): string {
  return `${gateId}.${recordedAt.replaceAll(/[-:.]/g, '')}.${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Runs one gate and appends its decision. A configuration error is returned,
 * not thrown, and appends nothing; any other failure (the history store
 * itself failing, say) propagates.
 */
export async function runReleaseGate(options: RunReleaseGateOptions): Promise<GateRunResult> {
  const { gateId, history } = options;
  const now = options.now ?? Date.now;
  let prepared: PreparedGate;
  try {
    prepared = await prepareGate(options);
  } catch (error) {
    if (!(error instanceof GateConfigurationError)) throw error;
    return { gateId, decision: 'configuration-error', issues: error.issues };
  }
  const { gate, evaluator } = prepared;
  const startedAt = now();
  const { evidence, aggregates } = await runCandidate(prepared, options.runtime);
  const finishedAt = now();
  const recordedAt = new Date(finishedAt).toISOString();
  const id = (options.createId ?? defaultRecordId)(gateId, recordedAt);
  const candidate = toEvaluationRunRecord({
    id: `${id}.candidate`,
    recordedAt,
    evaluator,
    aggregates,
    latencyMilliseconds: finishedAt - startedAt,
  });
  const records = await history.list();
  const baseline = await resolveBaseline(prepared, options, records, candidate);
  const considered = considerOverrides(
    records,
    gateId,
    gate,
    evaluator.identity.digest,
    recordedAt,
  );
  const eligibility = await gateEligibility(prepared);
  const { configuration, dataset, identity } = evaluator;
  const outputs = await decideGate({
    gate,
    judge: configuration.judge.kind,
    eligibility,
    candidate,
    baseline,
    overrides: considered,
  });
  const historical = await history.append<GateDecisionRecord>({
    kind: 'gate-decision',
    schemaVersion: GATE_RECORD_SCHEMA_VERSION,
    id,
    recordedAt,
    gateId,
    actor: options.actor,
    ...(options.sourceRevision === undefined ? {} : { sourceRevision: options.sourceRevision }),
    gate,
    evaluator: {
      module: relative(EVALUATION_PACKAGE_DIRECTORY, prepared.modulePath),
      ...identity,
      judge: configuration.judge.kind,
    },
    dataset: { id: dataset.id, version: dataset.version, digest: await datasetDigest(dataset) },
    eligibility,
    evidence,
    candidate,
    baseline,
    overrides: { considered, ...outputs.overrides },
    findings: outputs.findings,
    decision: outputs.decision,
  });
  return { gateId, decision: outputs.decision, historical, comparison: outputs.comparison };
}

/** One gate's entry in a {@link ReleaseGateReport}. */
export type GateReport =
  | {
      readonly gateId: string;
      readonly decision: 'configuration-error';
      readonly exitCode: number;
      readonly recordId: null;
      readonly digest: null;
      readonly issues: readonly string[];
    }
  | {
      readonly gateId: string;
      readonly decision: GateDecision;
      readonly exitCode: number;
      readonly recordId: string;
      readonly digest: string;
      readonly evaluator: GateDecisionRecord['evaluator'];
      readonly dataset: GateDecisionRecord['dataset'];
      readonly baseline: {
        readonly source: RecordedBaseline['source'];
        readonly recordedAt: string;
        readonly ageMilliseconds: number;
        readonly revisionDistance: number | null;
      } | null;
      readonly sample: { readonly required: number; readonly recorded: number };
      readonly costUsd: number | null;
      readonly latencyMilliseconds: number;
      readonly findings: GateFindings;
      /** The overrides that cleared a regression in this run. */
      readonly overrideIds: readonly string[];
      readonly rejectedOverrides: GateOverrides['rejected'];
      readonly comparison: EvaluationRunComparison | null;
    };

/** The one JSON document the `release-gate` command prints. */
export interface ReleaseGateReport {
  readonly kind: 'release-gate-report';
  readonly schemaVersion: 1;
  /** The decision's record id when exactly one gate appended one; otherwise `null`. */
  readonly recordId: string | null;
  readonly decision: GateOutcome;
  readonly exitCode: number;
  readonly gates: readonly GateReport[];
}

function toGateReport(result: GateRunResult): GateReport {
  const exitCode = RELEASE_GATE_EXIT_CODES[result.decision];
  if (result.decision === 'configuration-error') {
    const { gateId, decision, issues } = result;
    return { gateId, decision, exitCode, recordId: null, digest: null, issues };
  }
  const { digest, record } = result.historical;
  const { baseline, candidate } = record;
  return {
    gateId: result.gateId,
    decision: result.decision,
    exitCode,
    recordId: record.id,
    digest,
    evaluator: record.evaluator,
    dataset: record.dataset,
    baseline:
      baseline === null
        ? null
        : {
            source: baseline.source,
            recordedAt: baseline.run.recordedAt,
            ageMilliseconds: baseline.ageMilliseconds,
            revisionDistance: baseline.revisionDistance,
          },
    sample: {
      required: record.gate.sampleSize,
      recorded: recordedSampleSize(candidate, record.evaluator.judge),
    },
    costUsd: candidate.costUsd,
    latencyMilliseconds: candidate.latencyMilliseconds,
    findings: record.findings,
    overrideIds: record.overrides.applied,
    rejectedOverrides: record.overrides.rejected,
    comparison: result.comparison,
  };
}

/** The report for a run of `results`, one per gate, deciding by the most severe outcome. */
export function toReleaseGateReport(results: readonly GateRunResult[]): ReleaseGateReport {
  const gates = results.map(toGateReport);
  const decision = mostSevere(gates.map((gate) => gate.decision));
  return {
    kind: 'release-gate-report',
    schemaVersion: 1,
    recordId: gates.length === 1 ? gates[0]!.recordId : null,
    decision,
    exitCode: RELEASE_GATE_EXIT_CODES[decision],
    gates,
  };
}
