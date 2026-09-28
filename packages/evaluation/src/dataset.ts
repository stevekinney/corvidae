/**
 * Dataset cases are the inputs being scored, each with the expected answer a
 * judge or reviewer reads to score that one case. Calibration examples
 * (`EvaluatorConfiguration.examples`) are a different thing: they calibrate
 * the judge's reading of the rubric and are never scored. The two pools stay
 * disjoint, so a configuration whose example id names a dataset case is
 * rejected rather than letting a scored case leak into the judge's prompt as
 * a worked example.
 */
import { z } from 'zod';

import {
  type ConfigurationIssue,
  type EvaluatorConfiguration,
  EvaluatorConfigurationError,
  reportDuplicates,
  toConfigurationIssues,
} from './configuration';

const evaluationCaseSchema = z.strictObject({
  id: z.string().min(1),
  input: z.string(),
  expected: z.string(),
});

export const evaluationDatasetSchema = z
  .strictObject({
    version: z.string().min(1),
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
