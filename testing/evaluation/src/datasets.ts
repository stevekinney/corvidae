/**
 * Datasets and their held-out controls (COR-896, "held-out ownership" and
 * "contamination checks").
 *
 * Dataset cases are the inputs being scored, each with the expected answer a
 * judge or reviewer reads to score that one case. Calibration examples
 * (`EvaluatorConfiguration.examples`) are a different thing: they calibrate
 * the judge's reading of the rubric and are never scored. The two pools stay
 * disjoint, so a configuration whose example id names a dataset case is
 * rejected rather than letting a scored case leak into the judge's prompt as
 * a worked example.
 *
 * Every dataset names its `owner`, the sole principal who may move a case
 * out of the held-out pool, and every case declares its `visibility` with no
 * default. A held-out case's id, expected answer, and held-out status never
 * appear in a generator projection.
 *
 * A contamination check is a recorded fact, not something computed at run
 * time: the owner states that no held-out input or expected answer is
 * visible to the evaluated system at a given code revision. A dataset
 * version is gate-eligible only once the owner has recorded that check for
 * the exact code revision being evaluated.
 */
import { z } from 'zod';

import {
  codeRevisionSchema,
  type ConfigurationIssue,
  type EvaluatorConfiguration,
  EvaluatorConfigurationError,
  identifier,
  reportDuplicates,
  toConfigurationIssues,
} from './configuration';

export const CASE_VISIBILITIES = ['held-out', 'public'] as const;

export type CaseVisibility = (typeof CASE_VISIBILITIES)[number];

const evaluationCaseSchema = z.strictObject({
  id: identifier,
  input: z.string(),
  expected: z.string(),
  visibility: z.enum(CASE_VISIBILITIES),
});

export const evaluationDatasetSchema = z
  .strictObject({
    id: identifier,
    version: identifier,
    /** The principal who owns the held-out pool. */
    owner: identifier,
    cases: z.array(evaluationCaseSchema).min(1),
  })
  .superRefine((dataset, context) => {
    reportDuplicates(
      dataset.cases.map((entry) => entry.id),
      (index) => ['cases', index, 'id'],
      'case id',
      context,
    );
  });

export type EvaluationDataset = z.output<typeof evaluationDatasetSchema>;
export type EvaluationCase = EvaluationDataset['cases'][number];

/** Parses a dataset, throwing {@link EvaluatorConfigurationError} on any issue. */
export function parseEvaluationDataset(input: unknown): EvaluationDataset {
  const parsed = evaluationDatasetSchema.safeParse(input);
  if (!parsed.success) throw new EvaluatorConfigurationError(toConfigurationIssues(parsed.error));
  return parsed.data;
}

/**
 * The issues that keep `configuration` from scoring `dataset`: a dataset
 * version other than the one the configuration cites, and any calibration
 * example whose id equals a dataset case id.
 */
export function calibrationSeparationIssues(
  configuration: EvaluatorConfiguration,
  dataset: EvaluationDataset,
): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  if (dataset.version !== configuration.datasetVersion) {
    issues.push({
      path: ['datasetVersion'],
      message: `Configuration cites dataset version "${configuration.datasetVersion}" but the dataset is "${dataset.version}"`,
    });
  }
  const caseIds = new Set(dataset.cases.map((entry) => entry.id));
  for (const [index, example] of configuration.examples.entries()) {
    if (caseIds.has(example.id)) {
      issues.push({
        path: ['examples', index, 'id'],
        message: `Calibration example "${example.id}" collides with a dataset case id`,
      });
    }
  }
  return issues;
}

export const contaminationCheckSchema = z.strictObject({
  /** The dataset the check covers. A version string alone could name two datasets. */
  datasetId: identifier,
  datasetVersion: identifier,
  /** The evaluated system's revision the statement holds for. */
  codeRevision: codeRevisionSchema,
  /** Who recorded the check. Only the dataset owner's checks count. */
  actor: identifier,
  recordedAt: z.iso.datetime({ offset: true }),
  /** What the owner attests about training data, prompts, memory, and skills. */
  statement: identifier,
});

export type ContaminationCheck = z.output<typeof contaminationCheckSchema>;

/** Parses a contamination check, throwing {@link EvaluatorConfigurationError} on any issue. */
export function parseContaminationCheck(input: unknown): ContaminationCheck {
  const parsed = contaminationCheckSchema.safeParse(input);
  if (!parsed.success) throw new EvaluatorConfigurationError(toConfigurationIssues(parsed.error));
  return parsed.data;
}

export interface GateEligibleDatasetOptions {
  readonly dataset: EvaluationDataset;
  /** The evaluated system's revision. */
  readonly codeRevision: string;
  readonly contaminationChecks: readonly ContaminationCheck[];
}

/**
 * True only when the dataset's owner has recorded a contamination check for
 * this exact dataset id, dataset version, and evaluated code revision.
 */
export function isGateEligibleDataset(options: GateEligibleDatasetOptions): boolean {
  const { dataset, codeRevision } = options;
  return options.contaminationChecks.some(
    (check) =>
      check.datasetId === dataset.id &&
      check.datasetVersion === dataset.version &&
      check.codeRevision === codeRevision &&
      check.actor === dataset.owner,
  );
}

/** A principal other than the dataset owner tried to change the held-out pool. */
export class DatasetOwnershipError extends Error {
  override readonly name = 'DatasetOwnershipError';
  readonly principal: string;
  readonly owner: string;

  constructor(options: {
    readonly datasetId: string;
    readonly principal: string;
    readonly owner: string;
  }) {
    super(
      `Only "${options.owner}" may change the held-out pool of dataset "${options.datasetId}", not "${options.principal}"`,
    );
    this.principal = options.principal;
    this.owner = options.owner;
  }
}

export interface PromoteCaseOptions {
  readonly dataset: EvaluationDataset;
  readonly caseId: string;
  /** The principal requesting the promotion. It must be the dataset owner. */
  readonly principal: string;
  /**
   * The new dataset version. Promotion changes which cases are held out, so
   * the result can never share a version, or a contamination check, with the
   * dataset it came from.
   */
  readonly version: string;
}

/** Returns a new dataset version in which the owner has made one held-out case public. */
export function promoteCaseToPublic(options: PromoteCaseOptions): EvaluationDataset {
  const { dataset, caseId, principal, version } = options;
  if (principal !== dataset.owner) {
    throw new DatasetOwnershipError({ datasetId: dataset.id, principal, owner: dataset.owner });
  }
  const promoted = dataset.cases.find((entry) => entry.id === caseId);
  if (promoted === undefined) throw new RangeError(`Unknown evaluation case "${caseId}"`);
  if (promoted.visibility === 'public') throw new RangeError(`Case "${caseId}" is already public`);
  if (version === dataset.version) {
    throw new RangeError(`Promoting a case needs a new dataset version, not "${version}" again`);
  }
  return {
    ...dataset,
    version,
    cases: dataset.cases.map((entry) =>
      entry === promoted ? { ...entry, visibility: 'public' } : entry,
    ),
  };
}
