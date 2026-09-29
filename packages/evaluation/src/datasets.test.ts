import { describe, expect, test } from 'bun:test';

import { EvaluatorConfigurationError, parseEvaluatorConfiguration } from './configuration';
import {
  calibrationSeparationIssues,
  type ContaminationCheck,
  DatasetOwnershipError,
  isGateEligibleDataset,
  parseContaminationCheck,
  parseEvaluationDataset,
  promoteCaseToPublic,
} from './datasets';
import {
  DATASET_OWNER,
  datasetInput,
  HELD_OUT_CASE_ID,
  modelConfigurationInput,
} from './evaluation.test-support';

const CODE_REVISION = 'a7679370f3e1a3b850299d13c9e768541a601722';

function rejectionPaths(parse: (input: unknown) => unknown, input: unknown): string[] {
  try {
    parse(input);
  } catch (error) {
    expect(error).toBeInstanceOf(EvaluatorConfigurationError);
    return (error as EvaluatorConfigurationError).issues.map((issue) => issue.path.join('.'));
  }
  throw new Error('Expected the input to be rejected');
}

function contaminationCheck(overrides: Partial<ContaminationCheck> = {}): ContaminationCheck {
  return parseContaminationCheck({
    datasetId: 'capitals',
    datasetVersion: 'capitals-2026-09',
    codeRevision: CODE_REVISION,
    actor: DATASET_OWNER,
    recordedAt: '2026-09-28T12:00:00.000Z',
    statement:
      'No held-out input or expected answer appears in training data, prompts, memory, or skills.',
    ...overrides,
  });
}

describe('parseEvaluationDataset', () => {
  test('returns an owned, versioned dataset whose cases declare their visibility', () => {
    const dataset = parseEvaluationDataset(datasetInput());
    expect(dataset.id).toBe('capitals');
    expect(dataset.version).toBe('capitals-2026-09');
    expect(dataset.owner).toBe(DATASET_OWNER);
    expect(dataset.cases.map((entry) => [entry.id, entry.visibility])).toEqual([
      ['case-france', 'held-out'],
      ['case-japan', 'public'],
    ]);
  });

  test('rejects duplicate case ids, empty datasets, and cases without an expected answer', () => {
    const input = datasetInput();
    input.cases.push({ ...input.cases[0]! });
    expect(rejectionPaths(parseEvaluationDataset, input)).toEqual(['cases.2.id']);
    expect(rejectionPaths(parseEvaluationDataset, { ...datasetInput(), cases: [] })).toEqual([
      'cases',
    ]);
    expect(
      rejectionPaths(parseEvaluationDataset, {
        ...datasetInput(),
        cases: [{ id: 'a', input: 'q', visibility: 'public' }],
      }),
    ).toEqual(['cases.0.expected']);
  });

  test('requires an id, an owner, and a visibility on every case, with no default', () => {
    const { id: _id, owner: _owner, ...unowned } = datasetInput();
    expect(rejectionPaths(parseEvaluationDataset, unowned).toSorted()).toEqual(['id', 'owner']);
    const input = datasetInput();
    const { visibility: _visibility, ...undeclared } = input.cases[1]!;
    expect(
      rejectionPaths(parseEvaluationDataset, { ...input, cases: [input.cases[0], undeclared] }),
    ).toEqual(['cases.1.visibility']);
    expect(
      rejectionPaths(parseEvaluationDataset, {
        ...input,
        cases: [{ ...input.cases[0], visibility: 'private' }],
      }),
    ).toEqual(['cases.0.visibility']);
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

describe('parseContaminationCheck', () => {
  test('returns a recorded contamination check', () => {
    expect(contaminationCheck()).toMatchObject({
      datasetId: 'capitals',
      datasetVersion: 'capitals-2026-09',
      codeRevision: CODE_REVISION,
      actor: DATASET_OWNER,
    });
  });

  test('rejects a check without a statement, a commit hash, or an ISO timestamp', () => {
    const valid = contaminationCheck();
    expect(
      rejectionPaths(parseContaminationCheck, {
        ...valid,
        codeRevision: 'main',
        recordedAt: 'yesterday',
        statement: '',
      }).toSorted(),
    ).toEqual(['codeRevision', 'recordedAt', 'statement']);
  });
});

describe('isGateEligibleDataset', () => {
  const dataset = parseEvaluationDataset(datasetInput());

  test('is false for a held-out dataset version with no contamination check, and true once the owner records one', () => {
    expect(
      isGateEligibleDataset({ dataset, codeRevision: CODE_REVISION, contaminationChecks: [] }),
    ).toBe(false);
    expect(
      isGateEligibleDataset({
        dataset,
        codeRevision: CODE_REVISION,
        contaminationChecks: [contaminationCheck()],
      }),
    ).toBe(true);
  });

  test.each<[string, Partial<ContaminationCheck>]>([
    ['another code revision', { codeRevision: '41257994' }],
    ['another dataset version', { datasetVersion: 'capitals-2026-08' }],
    ['another dataset', { datasetId: 'rivers' }],
    ['someone other than the owner', { actor: 'release-engineer' }],
  ])('ignores a check recorded for %s', (_label, overrides) => {
    expect(
      isGateEligibleDataset({
        dataset,
        codeRevision: CODE_REVISION,
        contaminationChecks: [contaminationCheck(overrides)],
      }),
    ).toBe(false);
  });
});

describe('promoteCaseToPublic', () => {
  const dataset = parseEvaluationDataset(datasetInput());

  test('lets the owner promote a held-out case into a new dataset version', () => {
    const promoted = promoteCaseToPublic({
      dataset,
      caseId: HELD_OUT_CASE_ID,
      principal: DATASET_OWNER,
      version: 'capitals-2026-10',
    });
    expect(promoted.version).toBe('capitals-2026-10');
    expect(promoted.cases.find((entry) => entry.id === HELD_OUT_CASE_ID)?.visibility).toBe(
      'public',
    );
    expect(dataset.cases.find((entry) => entry.id === HELD_OUT_CASE_ID)?.visibility).toBe(
      'held-out',
    );
    expect(dataset.version).toBe('capitals-2026-09');
  });

  test.each(['release-engineer', 'Evaluation-Datasets-Team', ''])(
    'rejects the principal %p, who does not own the dataset',
    (principal) => {
      let caught: unknown;
      try {
        promoteCaseToPublic({
          dataset,
          caseId: HELD_OUT_CASE_ID,
          principal,
          version: 'capitals-2026-10',
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DatasetOwnershipError);
      const error = caught as DatasetOwnershipError;
      expect(error.name).toBe('DatasetOwnershipError');
      expect(error.principal).toBe(principal);
      expect(error.owner).toBe(DATASET_OWNER);
      expect(error.message).toContain('capitals');
    },
  );

  test('rejects an unknown case, an already public case, and an unchanged version', () => {
    const promote = (caseId: string, version: string) =>
      promoteCaseToPublic({ dataset, caseId, principal: DATASET_OWNER, version });
    expect(() => promote('case-mars', 'capitals-2026-10')).toThrow(
      'Unknown evaluation case "case-mars"',
    );
    expect(() => promote('case-japan', 'capitals-2026-10')).toThrow(
      'Case "case-japan" is already public',
    );
    expect(() => promote(HELD_OUT_CASE_ID, 'capitals-2026-09')).toThrow(RangeError);
  });
});
