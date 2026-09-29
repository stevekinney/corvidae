/**
 * The repeated-trial executor (COR-896, "repeated trials"). It is this
 * repository's only evaluation case executor, and it adds no agent loop:
 * each trial calls an operative `RunnableAgent`'s `run()` with the case's
 * input, waits for the terminal `RunResult`, and scores it with the
 * evaluator's rubric. A case runs exactly `configuration.repetitions`
 * trials, in order, and nothing is ever retried.
 *
 * Every trial records the seed it ran under. Seeds come from the injected
 * `RuntimeServices.random` (all drawn before the first trial, so a subject
 * that shares that source cannot shift them), or are replayed from an
 * earlier aggregate. Given the same seeds and the same scripted agent and
 * judge, the aggregate serializes to the same bytes.
 *
 * The aggregate outcome is never one collapsed boolean:
 *
 * - `indeterminate` when any trial hit an evaluator infrastructure failure,
 *   including a run that rejected instead of finishing (`subject-error`).
 *   The typed errors are attached and no pass or fail is inferred from the
 *   trials that did score.
 * - Otherwise `pass`, `fail`, or `disagreement`, as `decideTrials` rules
 *   under the configuration's variance policy.
 */
import {
  type CostEstimate,
  createDefaultRuntimeServices,
  type FinishReason,
  type RunResultBase,
  type RuntimeServices,
  type TokenUsage,
} from '@lostgradient/operative';

import { decideTrials, type Disagreement, type TrialVerdict } from './disagreement';
import type { Evaluator } from './evaluator';
import type { EvaluatorIdentity } from './identity';
import type { CriterionResult } from './rubric';
import {
  type ScoreStatistics,
  summarizeProportion,
  summarizeScores,
  type TrialStatistics,
  type VariancePolicy,
} from './variance';
import {
  type CaseEvaluation,
  type CaseVerdict,
  EVALUATION_RESULT_SCHEMA_VERSION,
  EvaluatorInfrastructureError,
} from './verdict';

/** Seeds are unsigned 32-bit integers. */
const SEED_RANGE = 0x1_0000_0000;

export interface TrialContext {
  /** The trial's 1-based position. */
  readonly trial: number;
  /** The seed recorded for this trial. */
  readonly seed: number;
}

/**
 * What a trial needs from its subject: one `run()` whose terminal result it
 * awaits. An operative `RunnableAgent` is one; so is a replay of a run that
 * already finished, which is how a goal attempt's result is re-judged.
 */
export interface TrialSubject {
  run(input: string): { result(): Promise<RunResultBase> };
}

export interface RunTrialsOptions {
  readonly evaluator: Evaluator;
  readonly caseId: string;
  /**
   * The subject, usually an operative agent built with `createAgent`, whose
   * `run()` a trial calls. It receives the trial's seed so it can seed its
   * own runtime.
   */
  readonly subject: (trial: TrialContext) => TrialSubject;
  /** Draws each trial's seed. Defaults to the real-globals runtime services. */
  readonly runtime?: Pick<RuntimeServices, 'random'> | undefined;
  /** Seeds recorded by an earlier aggregate, one per repetition, replayed instead of drawn. */
  readonly seeds?: readonly number[] | undefined;
}

/**
 * The executor's core: how a case's trials are scored once each trial's run
 * result is in hand. {@link runTrials} produces each result by running an
 * operative agent; a release-gate replay produces it from recorded evidence.
 */
export interface ScoreTrialsOptions {
  readonly evaluator: Evaluator;
  readonly caseId: string;
  /**
   * The completed run for trial `context` of the case whose input is
   * `input`. A throw or rejection is that trial's `subject-error`.
   */
  readonly runResult: (context: TrialContext, input: string) => Promise<RunResultBase>;
  /** Draws each trial's seed. Defaults to the real-globals runtime services. */
  readonly runtime?: Pick<RuntimeServices, 'random'> | undefined;
  /** Seeds recorded by an earlier aggregate, one per repetition, replayed instead of drawn. */
  readonly seeds?: readonly number[] | undefined;
}

/** What one trial recorded. Plain data, so an aggregate serializes deterministically. */
export interface TrialRecord {
  readonly trial: number;
  readonly seed: number;
  readonly verdict: CaseVerdict;
  /** Absent only when the run rejected instead of finishing. */
  readonly finishReason?: FinishReason;
  readonly usage?: TokenUsage;
  readonly costEstimate?: CostEstimate;
  /** Every criterion's result for a scored (`pass` or `fail`) trial; empty otherwise. */
  readonly criteria: readonly CriterionResult[];
  readonly weightedTotal?: number;
  /** The unredacted feedback of a scored trial. Reviewer material, never the generator's. */
  readonly feedback?: string;
  readonly error?: EvaluatorInfrastructureError;
}

export interface CriterionStatistics extends ScoreStatistics {
  readonly name: string;
}

export interface AggregateStatistics {
  /** Passing trials among every trial that produced a verdict. */
  readonly verdicts: TrialStatistics;
  /**
   * Per criterion, in configuration order, over the scored trials. A trial
   * passes a criterion when its score reaches the criterion's hard threshold,
   * or the configuration's pass threshold when it has none.
   */
  readonly criteria: readonly CriterionStatistics[];
}

interface TrialAggregateBase {
  readonly resultSchemaVersion: number;
  readonly evaluator: EvaluatorIdentity;
  readonly caseId: string;
  readonly datasetVersion: string;
  readonly codeRevision: string;
  readonly repetitions: number;
  /** `null` only for a deterministic judge that declared none. */
  readonly variancePolicy: VariancePolicy | null;
  readonly statistics: AggregateStatistics;
  readonly trials: readonly TrialRecord[];
}

export type TrialAggregate =
  | (TrialAggregateBase & { readonly outcome: 'pass' | 'fail' })
  | (TrialAggregateBase & {
      readonly outcome: 'disagreement';
      readonly disagreement: Disagreement;
    })
  | (TrialAggregateBase & {
      readonly outcome: 'indeterminate';
      /** Every trial's typed infrastructure error, in trial order. */
      readonly errors: readonly EvaluatorInfrastructureError[];
    });

function resolveSeeds(options: ScoreTrialsOptions, repetitions: number): readonly number[] {
  const { seeds } = options;
  if (seeds === undefined) {
    const random = (options.runtime ?? createDefaultRuntimeServices()).random;
    return Array.from({ length: repetitions }, () => Math.floor(random.next() * SEED_RANGE));
  }
  if (seeds.length !== repetitions) {
    throw new RangeError(
      `Expected ${repetitions} recorded seeds, one per repetition, not ${seeds.length}`,
    );
  }
  for (const seed of seeds) {
    if (!Number.isInteger(seed) || seed < 0 || seed >= SEED_RANGE) {
      throw new RangeError(`A recorded seed is an unsigned 32-bit integer, not ${seed}`);
    }
  }
  return seeds;
}

function recordEvaluation(context: TrialContext, evaluation: CaseEvaluation): TrialRecord {
  const { run } = evaluation;
  const recorded = {
    ...context,
    verdict: evaluation.verdict,
    finishReason: run.finishReason,
    usage: { ...run.usage },
    ...(run.costEstimate === undefined ? {} : { costEstimate: run.costEstimate }),
  };
  switch (evaluation.verdict) {
    case 'pass':
    case 'fail':
      return {
        ...recorded,
        criteria: evaluation.rubric.criteria,
        weightedTotal: evaluation.rubric.weightedTotal,
        feedback: evaluation.feedback,
      };
    case 'agent-failed':
      return { ...recorded, criteria: [] };
    case 'infrastructure-failure':
      return { ...recorded, criteria: [], error: evaluation.error };
  }
}

async function runTrial(
  options: ScoreTrialsOptions,
  context: TrialContext,
  input: string,
): Promise<TrialRecord> {
  let result: RunResultBase;
  try {
    result = await options.runResult(context, input);
  } catch (cause) {
    const error = new EvaluatorInfrastructureError({
      reason: 'subject-error',
      message: `Trial ${context.trial} of case "${options.caseId}" did not produce a run result`,
      cause,
    });
    return { ...context, verdict: 'infrastructure-failure', criteria: [], error };
  }
  return recordEvaluation(context, await options.evaluator.evaluateCase(options.caseId, result));
}

/**
 * Verdict and per-criterion statistics over `trials`. The history pools every
 * case's trials of one evaluation run through this same rule.
 */
export function aggregateStatistics(
  evaluator: Evaluator,
  trials: readonly TrialRecord[],
): AggregateStatistics {
  const { criteria, passThreshold } = evaluator.configuration;
  const verdicts = trials.filter((trial) => trial.verdict !== 'infrastructure-failure');
  const passes = verdicts.filter((trial) => trial.verdict === 'pass').length;
  return {
    verdicts: summarizeProportion(passes, verdicts.length),
    criteria: criteria.map((criterion) => {
      const threshold = criterion.hardThreshold ?? passThreshold;
      const samples = trials.flatMap((trial) =>
        trial.criteria
          .filter((result) => result.name === criterion.name)
          .map((result) => ({ score: result.score, passed: result.score >= threshold })),
      );
      return { name: criterion.name, ...summarizeScores(samples) };
    }),
  };
}

/** Runs one case `repetitions` times and aggregates the trials into one reviewer-level report. */
export function runTrials(options: RunTrialsOptions): Promise<TrialAggregate> {
  const { subject, ...rest } = options;
  return scoreTrials({
    ...rest,
    runResult: (context, input) => subject(context).run(input).result(),
  });
}

/**
 * Scores one case's `repetitions` trials, in order and without retry, taking
 * each trial's run from `runResult`, and aggregates them exactly as
 * {@link runTrials} does.
 */
export async function scoreTrials(options: ScoreTrialsOptions): Promise<TrialAggregate> {
  const { evaluator, caseId } = options;
  const { configuration, identity } = evaluator;
  const evaluationCase = evaluator.dataset.cases.find((entry) => entry.id === caseId);
  if (evaluationCase === undefined) throw new RangeError(`Unknown evaluation case "${caseId}"`);
  const seeds = resolveSeeds(options, configuration.repetitions);

  const trials: TrialRecord[] = [];
  for (const [index, seed] of seeds.entries()) {
    trials.push(await runTrial(options, { trial: index + 1, seed }, evaluationCase.input));
  }

  const base = {
    resultSchemaVersion: EVALUATION_RESULT_SCHEMA_VERSION,
    evaluator: identity,
    caseId,
    datasetVersion: configuration.datasetVersion,
    codeRevision: configuration.codeRevision,
    repetitions: configuration.repetitions,
    variancePolicy: configuration.variancePolicy ?? null,
  };
  const evidence = { statistics: aggregateStatistics(evaluator, trials), trials };
  const errors = trials.flatMap((trial) => (trial.error === undefined ? [] : [trial.error]));
  if (errors.length > 0) return { ...base, outcome: 'indeterminate', errors, ...evidence };

  const verdicts = trials.flatMap((trial): TrialVerdict[] =>
    trial.verdict === 'infrastructure-failure'
      ? []
      : [{ trial: trial.trial, verdict: trial.verdict }],
  );
  const decision = decideTrials(verdicts, configuration.variancePolicy);
  if (decision.outcome === 'disagreement') {
    return { ...base, outcome: 'disagreement', disagreement: decision.disagreement, ...evidence };
  }
  return { ...base, outcome: decision.outcome, ...evidence };
}
