/**
 * Scores one completed operative run against a versioned evaluator
 * configuration. The evaluator itself never starts a run: it scores exactly
 * the `RunResultBase` it is handed. Running cases is `runTrials` and
 * `scoreTrials` (one subject, repeated trials) and `runComparison` (the same
 * cases under the direct-agent, compute-matched-ensemble, and collaboration
 * profiles); both call this evaluator to score each trial.
 *
 * The flow for one case is fixed:
 *
 * 1. A run whose `finishReason` is not `stop-condition` is `agent-failed`
 *    and no criterion is scored.
 * 2. Otherwise every criterion is scored in configuration order under the
 *    per-evaluation latency budget. The model judge, when the configuration
 *    has model-judge criteria, is called at most once.
 * 3. Any evaluator failure along the way (a scorer or judge that throws, a
 *    malformed score, or the budget expiring) ends the evaluation as
 *    `infrastructure-failure`. No rubric is computed from a partial score
 *    set, so an infrastructure failure can never become a pass or a fail.
 * 4. Otherwise the rubric decides `pass` or `fail`.
 */
import {
  createDefaultRuntimeServices,
  type GenerateFunction,
  type RunResultBase,
  type RuntimeTimers,
} from '@lostgradient/operative';

import {
  type ConfigurationIssue,
  type EvaluatorConfiguration,
  EvaluatorConfigurationError,
  parseEvaluatorConfiguration,
} from './configuration';
import {
  bindCriteria,
  type CriterionEvidence,
  type CriterionScorers,
  type ScoringContext,
} from './criteria';
import {
  calibrationSeparationIssues,
  type EvaluationDataset,
  parseEvaluationDataset,
} from './datasets';
import { type EvaluatorIdentity, evaluatorIdentity } from './identity';
import {
  type JudgeVerdict,
  readRecordedJudgeOutput,
  type RecordedJudgeOutput,
  runModelJudge,
} from './judge';
import { applyRubric, type CriterionScore, type RubricResult } from './rubric';
import {
  type CaseEvaluation,
  type CaseEvaluationBase,
  EVALUATION_RESULT_SCHEMA_VERSION,
  EvaluatorInfrastructureError,
  isAgentFailureReason,
} from './verdict';

export interface CreateEvaluatorOptions {
  /** An evaluator configuration, validated with `evaluatorConfigurationSchema`. */
  readonly configuration: unknown;
  /** The dataset whose cases this evaluator scores, validated with `evaluationDatasetSchema`. */
  readonly dataset: unknown;
  readonly scorers?: CriterionScorers | undefined;
  /**
   * The model judge's provider call. Required when the configuration has a
   * model-judge criterion. The caller configures it for `judge.model` and
   * `judge.effort`; this package never constructs a provider.
   */
  readonly generate?: GenerateFunction | undefined;
  /**
   * The model judge's recorded output for one case, read in place of a live
   * call: a release-gate replay scores model-judge criteria this way and
   * never calls a provider. Mutually exclusive with `generate`. `undefined`
   * means nothing was recorded for this case, which is a `judge-error`.
   */
  readonly recordedJudgeOutput?:
    ((evidence: CriterionEvidence) => RecordedJudgeOutput | undefined) | undefined;
  /** Timers for the latency budget. Defaults to the real-clock runtime services. */
  readonly timers?: Pick<RuntimeTimers, 'setTimeout' | 'clearTimeout'> | undefined;
}

export interface Evaluator {
  readonly identity: EvaluatorIdentity;
  readonly configuration: EvaluatorConfiguration;
  readonly dataset: EvaluationDataset;
  /** Scores the completed `result` of one run against the dataset case named `caseId`. */
  evaluateCase(caseId: string, result: RunResultBase): Promise<CaseEvaluation>;
}

function formatScore(value: number): string {
  return value.toFixed(2);
}

function summarize(rubric: RubricResult): string {
  if (rubric.failedHardCriteria.length > 0) {
    return `Failed hard criteria: ${rubric.failedHardCriteria.join(', ')}.`;
  }
  return rubric.passed
    ? `Passed with a weighted score of ${formatScore(rubric.weightedTotal)} (threshold ${formatScore(rubric.passThreshold)}).`
    : `Weighted score ${formatScore(rubric.weightedTotal)} is below the pass threshold ${formatScore(rubric.passThreshold)}.`;
}

async function withinLatencyBudget<T>(
  milliseconds: number,
  timers: Pick<RuntimeTimers, 'setTimeout' | 'clearTimeout'>,
  controller: AbortController,
  work: () => Promise<T>,
): Promise<T> {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const handle = timers.setTimeout(() => {
    controller.abort();
    reject(
      new EvaluatorInfrastructureError({
        reason: 'latency-budget-exceeded',
        message: `Evaluation exceeded its latency budget of ${milliseconds} ms`,
      }),
    );
  }, milliseconds);
  try {
    return await Promise.race([work(), expired]);
  } finally {
    timers.clearTimeout(handle);
  }
}

export async function createEvaluator(options: CreateEvaluatorOptions): Promise<Evaluator> {
  const configuration = parseEvaluatorConfiguration(options.configuration);
  const dataset = parseEvaluationDataset(options.dataset);
  const { generate, recordedJudgeOutput } = options;
  const { bindings, issues: bindingIssues } = bindCriteria(configuration, options.scorers ?? {});
  const issues: ConfigurationIssue[] = [
    ...calibrationSeparationIssues(configuration, dataset),
    ...bindingIssues,
  ];
  if (configuration.resultSchemaVersion !== EVALUATION_RESULT_SCHEMA_VERSION) {
    issues.push({
      path: ['resultSchemaVersion'],
      message: `This package emits result schema version ${EVALUATION_RESULT_SCHEMA_VERSION}, not ${configuration.resultSchemaVersion}`,
    });
  }
  if (generate !== undefined && recordedJudgeOutput !== undefined) {
    issues.push({
      path: ['judge'],
      message: 'Pass a generate function or recorded judge outputs, not both',
    });
  } else if (
    generate === undefined &&
    recordedJudgeOutput === undefined &&
    configuration.criteria.some((criterion) => criterion.kind === 'model-judge')
  ) {
    issues.push({
      path: ['judge'],
      message: 'Model-judge criteria require an injected generate function',
    });
  }
  if (issues.length > 0) throw new EvaluatorConfigurationError(issues);

  const identity = await evaluatorIdentity(configuration);
  const cases = new Map(dataset.cases.map((entry) => [entry.id, entry]));
  const timers = options.timers ?? createDefaultRuntimeServices().timers;
  const budget = configuration.budgets.perEvaluation.latencyMilliseconds;

  /** The case's judge, called at most once: live through `generate`, or read from its recording. */
  function judgeFor(
    evidence: CriterionEvidence,
    once: (verdict: () => Promise<JudgeVerdict>) => Promise<JudgeVerdict>,
  ): ScoringContext['judge'] {
    if (generate !== undefined) {
      return () => once(() => runModelJudge({ generate, configuration, ...evidence }));
    }
    if (recordedJudgeOutput === undefined) return undefined;
    return () =>
      once(async () => {
        const output = recordedJudgeOutput(evidence);
        if (output === undefined) {
          throw new EvaluatorInfrastructureError({
            reason: 'judge-error',
            message: `No judge output was recorded for model judge "${configuration.judge.name}"`,
          });
        }
        return readRecordedJudgeOutput(output, configuration);
      });
  }

  async function evaluateCase(caseId: string, result: RunResultBase): Promise<CaseEvaluation> {
    const evaluationCase = cases.get(caseId);
    if (evaluationCase === undefined) throw new RangeError(`Unknown evaluation case "${caseId}"`);
    const base: CaseEvaluationBase = {
      resultSchemaVersion: EVALUATION_RESULT_SCHEMA_VERSION,
      evaluator: identity,
      configuration,
      evaluationCase,
      run: result,
    };
    if (isAgentFailureReason(result.finishReason)) {
      return { ...base, verdict: 'agent-failed', finishReason: result.finishReason };
    }

    const controller = new AbortController();
    const evidence = { evaluationCase, result, signal: controller.signal };
    let judged: Promise<JudgeVerdict> | undefined;
    const context: ScoringContext = {
      evidence,
      judge: judgeFor(evidence, (verdict) => (judged ??= verdict())),
    };
    try {
      const scores = await withinLatencyBudget(budget, timers, controller, async () => {
        const scored: CriterionScore[] = [];
        for (const binding of bindings) {
          // Once the budget expires the verdict is settled; stop calling scorers.
          controller.signal.throwIfAborted();
          scored.push(await binding(context));
        }
        return scored;
      });
      const rubric = applyRubric(scores, configuration.passThreshold);
      const judgeVerdict = judged === undefined ? undefined : await judged;
      const feedback = judgeVerdict === undefined ? summarize(rubric) : judgeVerdict.feedback;
      return { ...base, verdict: rubric.passed ? 'pass' : 'fail', rubric, feedback };
    } catch (error) {
      // Every scorer, judge, and budget failure arrives already typed. Anything
      // else is a defect in this package, not a verdict, so it propagates.
      if (!(error instanceof EvaluatorInfrastructureError)) throw error;
      return { ...base, verdict: 'infrastructure-failure', error };
    }
  }

  return { identity, configuration, dataset, evaluateCase };
}
