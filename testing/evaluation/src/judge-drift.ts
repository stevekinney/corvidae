/**
 * Judge drift checks (COR-896, "judge drift checks"). A model judge revision
 * is re-validated against a fixed calibration set before it may back a
 * release gate: every calibration item is rescored by the revision under
 * test, and each criterion score is compared with the human reference score
 * the set records for it.
 *
 * A judge revision is identified by {@link judgeRevisionOf}: a digest over
 * exactly what the judge reads (its `judge` configuration, `promptVersion`,
 * the model-judge criteria, the reference material, and the calibration
 * examples). A change to any of them is a new revision that needs its own
 * drift check; a change the judge never sees, such as the dataset version
 * or the code revision under evaluation, is not.
 *
 * The check scores every item once, in order, with no retry. A judge that
 * fails on an item is an evaluator infrastructure failure: the check is
 * `indeterminate`, never `passed` and never `drifted`.
 */
import { sha256Hex } from '@lostgradient/cryptography';
import type { GenerateFunction, RunResultBase } from '@lostgradient/operative';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import {
  type ConfigurationIssue,
  type EvaluatorConfiguration,
  EvaluatorConfigurationError,
  identifier,
  parseEvaluatorConfiguration,
  reportDuplicates,
  toConfigurationIssues,
  unitInterval,
} from './configuration';
import { canonicalJson } from './identity';
import { type JudgeVerdict, runModelJudge } from './judge';
import { EvaluatorInfrastructureError } from './verdict';

export interface JudgeRevision {
  readonly name: string;
  readonly promptVersion: string;
  /** SHA-256 over everything the judge reads. Drift checks and calibration records cite this. */
  readonly digest: string;
}

function modelJudgeCriteria(configuration: EvaluatorConfiguration) {
  return configuration.criteria.filter((criterion) => criterion.kind === 'model-judge');
}

export async function judgeRevisionOf(
  configuration: EvaluatorConfiguration,
): Promise<JudgeRevision> {
  const { judge, promptVersion, referenceMaterial, examples } = configuration;
  return {
    name: judge.name,
    promptVersion,
    digest: await sha256Hex(
      canonicalJson({
        judge,
        promptVersion,
        criteria: modelJudgeCriteria(configuration),
        referenceMaterial,
        examples,
      }),
    ),
  };
}

const calibrationItemSchema = z.strictObject({
  id: identifier,
  input: z.string(),
  expected: z.string(),
  /** The agent response the judge scores. */
  response: z.string(),
  /** The human reference score for every model-judge criterion. */
  referenceScores: z.record(z.string(), unitInterval),
});

export const calibrationSetSchema = z
  .strictObject({
    id: identifier,
    version: identifier,
    /** The largest judge-to-reference difference that still counts as agreement. */
    tolerance: unitInterval,
    /** The share of criterion scores that must agree for the revision to pass. */
    minimumAgreementRate: z.number().gt(0).max(1),
    items: z.array(calibrationItemSchema).min(1),
  })
  .superRefine((set, context) => {
    reportDuplicates(
      set.items.map((item) => item.id),
      (index) => ['items', index, 'id'],
      'calibration item id',
      context,
    );
  });

export type CalibrationSet = z.output<typeof calibrationSetSchema>;
export type CalibrationItem = CalibrationSet['items'][number];

/** Parses a calibration set, throwing {@link EvaluatorConfigurationError} on any issue. */
export function parseCalibrationSet(input: unknown): CalibrationSet {
  const parsed = calibrationSetSchema.safeParse(input);
  if (!parsed.success) throw new EvaluatorConfigurationError(toConfigurationIssues(parsed.error));
  return parsed.data;
}

export interface JudgeUnderTest {
  /** The evaluator configuration whose model judge is checked. */
  readonly configuration: unknown;
  /** The judge's provider call, configured for `judge.model` and `judge.effort`. */
  readonly generate: GenerateFunction;
}

export type JudgeDriftOutcome = 'passed' | 'drifted' | 'indeterminate';

export interface DriftComparison {
  readonly item: string;
  readonly criterion: string;
  readonly referenceScore: number;
  readonly judgeScore: number;
  readonly agrees: boolean;
}

export interface JudgeDriftCheck {
  /** The {@link JudgeRevision.digest} checked. */
  readonly judgeRevision: string;
  readonly calibrationSet: { readonly id: string; readonly version: string };
  readonly outcome: JudgeDriftOutcome;
  /** Agreeing comparisons over all comparisons; `null` when the check is indeterminate. */
  readonly agreementRate: number | null;
  readonly minimumAgreementRate: number;
  readonly comparisons: readonly DriftComparison[];
  readonly errors: readonly EvaluatorInfrastructureError[];
}

function driftCheckIssues(
  configuration: EvaluatorConfiguration,
  set: CalibrationSet,
): ConfigurationIssue[] {
  const judged = modelJudgeCriteria(configuration).map((criterion) => criterion.name);
  const issues: ConfigurationIssue[] = [];
  if (configuration.judge.kind !== 'model') {
    issues.push({
      path: ['judge', 'kind'],
      message: `A drift check rescores a model judge, not a ${configuration.judge.kind} judge`,
    });
  }
  if (judged.length === 0) {
    issues.push({
      path: ['criteria'],
      message: 'A drift check needs at least one model-judge criterion',
    });
  }
  if (issues.length > 0) return issues;
  for (const [index, item] of set.items.entries()) {
    const scored = Object.keys(item.referenceScores);
    for (const name of judged.filter((criterion) => !scored.includes(criterion))) {
      issues.push({
        path: ['items', index, 'referenceScores', name],
        message: `Calibration item "${item.id}" has no reference score for "${name}"`,
      });
    }
    for (const name of scored.filter((criterion) => !judged.includes(criterion))) {
      issues.push({
        path: ['items', index, 'referenceScores', name],
        message: `"${name}" is not a model-judge criterion of this configuration`,
      });
    }
  }
  return issues;
}

function calibrationRun(response: string): RunResultBase {
  return {
    conversation: new Conversation(),
    steps: [],
    content: response,
    parts: [{ type: 'text', text: response }],
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason: 'stop-condition',
  };
}

async function judgeItem(
  judge: { readonly configuration: EvaluatorConfiguration; readonly generate: GenerateFunction },
  item: CalibrationItem,
): Promise<JudgeVerdict> {
  return runModelJudge({
    ...judge,
    evaluationCase: {
      id: item.id,
      input: item.input,
      expected: item.expected,
      visibility: 'held-out',
    },
    result: calibrationRun(item.response),
    signal: new AbortController().signal,
  });
}

/** Rescores the fixed calibration set with one judge revision and compares it with the reference scores. */
export async function checkJudgeDrift(
  judge: JudgeUnderTest,
  calibrationSet: unknown,
): Promise<JudgeDriftCheck> {
  const configuration = parseEvaluatorConfiguration(judge.configuration);
  const set = parseCalibrationSet(calibrationSet);
  const issues = driftCheckIssues(configuration, set);
  if (issues.length > 0) throw new EvaluatorConfigurationError(issues);

  const comparisons: DriftComparison[] = [];
  const errors: EvaluatorInfrastructureError[] = [];
  for (const item of set.items) {
    let verdict: JudgeVerdict;
    try {
      verdict = await judgeItem({ configuration, generate: judge.generate }, item);
    } catch (error) {
      // Every judge failure arrives typed; anything else is a defect here.
      if (!(error instanceof EvaluatorInfrastructureError)) throw error;
      errors.push(error);
      continue;
    }
    for (const [criterion, referenceScore] of Object.entries(item.referenceScores)) {
      const judged = verdict.scores.get(criterion);
      if (judged === undefined) {
        errors.push(
          new EvaluatorInfrastructureError({
            reason: 'judge-malformed-output',
            message: `Model judge returned no score for criterion "${criterion}" on calibration item "${item.id}"`,
            criterion,
          }),
        );
        continue;
      }
      comparisons.push({
        item: item.id,
        criterion,
        referenceScore,
        judgeScore: judged.score,
        agrees: Math.abs(judged.score - referenceScore) <= set.tolerance,
      });
    }
  }

  const revision = await judgeRevisionOf(configuration);
  const base = {
    judgeRevision: revision.digest,
    calibrationSet: { id: set.id, version: set.version },
  };
  const evidence = { minimumAgreementRate: set.minimumAgreementRate, comparisons, errors };
  if (errors.length > 0)
    return { ...base, outcome: 'indeterminate', agreementRate: null, ...evidence };
  const agreementRate =
    comparisons.filter((comparison) => comparison.agrees).length / comparisons.length;
  const outcome = agreementRate >= set.minimumAgreementRate ? 'passed' : 'drifted';
  return { ...base, outcome, agreementRate, ...evidence };
}
