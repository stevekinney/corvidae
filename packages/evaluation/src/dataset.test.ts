import { describe, expect, test } from 'bun:test';

import { EvaluatorConfigurationError, parseEvaluatorConfiguration } from './configuration';
import { calibrationSeparationIssues, parseEvaluationDataset } from './dataset';
import { datasetInput, modelConfigurationInput } from './evaluation.test-support';

function rejectionPaths(input: unknown): string[] {
  try {
    parseEvaluationDataset(input);
  } catch (error) {
    expect(error).toBeInstanceOf(EvaluatorConfigurationError);
    return (error as EvaluatorConfigurationError).issues.map((issue) => issue.path.join('.'));
  }
  throw new Error('Expected the dataset to be rejected');
}

describe('parseEvaluationDataset', () => {
  test('returns a dataset of cases with inputs and expected answers', () => {
    const dataset = parseEvaluationDataset(datasetInput());
    expect(dataset.version).toBe('capitals-2026-09');
    expect(dataset.cases.map((entry) => entry.id)).toEqual(['case-france', 'case-japan']);
  });

  test('rejects duplicate case ids, empty datasets, and cases without an expected answer', () => {
    const input = datasetInput();
    input.cases.push({ ...input.cases[0]! });
    expect(rejectionPaths(input)).toEqual(['cases.2.id']);
    expect(rejectionPaths({ version: 'v1', cases: [] })).toEqual(['cases']);
    expect(rejectionPaths({ version: 'v1', cases: [{ id: 'a', input: 'q' }] })).toEqual([
      'cases.0.expected',
    ]);
  });
});

describe('calibrationSeparationIssues', () => {
  test('accepts calibration examples that are distinct from dataset cases', () => {
    const configuration = parseEvaluatorConfiguration(modelConfigurationInput());
    const dataset = parseEvaluationDataset(datasetInput());
    expect(calibrationSeparationIssues(configuration, dataset)).toEqual([]);
  });

  test('rejects a calibration example whose id equals a dataset case id', () => {
    const input = modelConfigurationInput();
    const examples = input['examples'] as Record<string, unknown>[];
    examples.push({ ...examples[0], id: 'case-japan' });
    const configuration = parseEvaluatorConfiguration(input);
    const dataset = parseEvaluationDataset(datasetInput());
    const issues = calibrationSeparationIssues(configuration, dataset);
    expect(issues.map((issue) => issue.path.join('.'))).toEqual(['examples.1.id']);
    expect(issues[0]?.message).toContain('case-japan');
  });

  test('rejects a dataset whose version differs from the configured dataset version', () => {
    const configuration = parseEvaluatorConfiguration(modelConfigurationInput());
    const dataset = parseEvaluationDataset({ ...datasetInput(), version: 'capitals-2026-10' });
    const issues = calibrationSeparationIssues(configuration, dataset);
    expect(issues.map((issue) => issue.path.join('.'))).toEqual(['datasetVersion']);
  });
});
