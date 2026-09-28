import { describe, expect, test } from 'bun:test';

import {
  EvaluatorConfigurationError,
  evaluatorConfigurationSchema,
  parseEvaluatorConfiguration,
} from './configuration';
import {
  deterministicConfigurationInput,
  modelConfigurationInput,
} from './evaluation.test-support';

/** The fields COR-896's "Evaluator configuration record" requires, none defaulted. */
const CONTRACT_FIELDS = [
  'criteria',
  'examples',
  'referenceMaterial',
  'judge',
  'promptVersion',
  'datasetVersion',
  'environment',
  'budgets',
  'repetitions',
  'resultSchemaVersion',
  'codeRevision',
] as const;

function issuePaths(input: unknown): string[] {
  const parsed = evaluatorConfigurationSchema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => issue.path.join('.'));
}

describe('evaluatorConfigurationSchema', () => {
  test('accepts a complete model-judged configuration', () => {
    expect(issuePaths(modelConfigurationInput())).toEqual([]);
  });

  test('covers exactly the eleven contract fields', () => {
    expect(CONTRACT_FIELDS).toHaveLength(11);
  });

  test.each([...CONTRACT_FIELDS])('rejects a configuration without %s', (field) => {
    const input = modelConfigurationInput();
    delete input[field];
    const parsed = evaluatorConfigurationSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path[0])).toContain(field);
  });

  test.each(['name', 'revision', 'passThreshold'])(
    'rejects a configuration without its %s identity or decision field',
    (field) => {
      const input = modelConfigurationInput();
      delete input[field];
      expect(issuePaths(input)).toContain(field);
    },
  );

  test.each([
    ['model', { kind: 'model', name: 'j', model: 'm', effort: 'low', tools: [] }],
    ['heuristic', { kind: 'heuristic', name: 'j' }],
  ] as const)('rejects a %s judge whose repetitions is 0 or absent', (_kind, judge) => {
    const input = deterministicConfigurationInput();
    input['judge'] = judge;
    input['repetitions'] = 0;
    expect(issuePaths(input)).toEqual(['repetitions']);
    delete input['repetitions'];
    expect(issuePaths(input)).toEqual(['repetitions']);
  });

  test('accepts a deterministic judge with repetitions: 1', () => {
    const input = deterministicConfigurationInput();
    expect(input['repetitions']).toBe(1);
    expect(issuePaths(input)).toEqual([]);
  });

  test('rejects a model judge without model, effort, or tools', () => {
    const input = modelConfigurationInput();
    input['judge'] = { kind: 'model', name: 'rubric-judge' };
    expect(issuePaths(input).toSorted()).toEqual(['judge.effort', 'judge.model', 'judge.tools']);
  });

  test('rejects an effort outside the operative effort vocabulary', () => {
    const input = modelConfigurationInput();
    input['judge'] = { kind: 'model', name: 'j', model: 'm', effort: 'extreme', tools: [] };
    expect(issuePaths(input)).toEqual(['judge.effort']);
  });

  test('rejects keys the contract does not define, at every level', () => {
    const input = modelConfigurationInput();
    input['threshold'] = 0.5;
    input['judge'] = { kind: 'model', name: 'j', model: 'm', effort: 'low', tools: [], seed: 7 };
    expect(issuePaths(input).toSorted()).toEqual(['', 'judge']);
  });

  test('rejects an empty criteria list', () => {
    const input = modelConfigurationInput();
    input['criteria'] = [];
    expect(issuePaths(input)).toEqual(['criteria']);
  });

  test('rejects non-positive weights and hard thresholds outside [0, 1]', () => {
    const input = deterministicConfigurationInput();
    const criteria = input['criteria'] as Record<string, unknown>[];
    criteria[0] = { ...criteria[0], weight: 0 };
    criteria[1] = { ...criteria[1], hardThreshold: 1.5 };
    expect(issuePaths(input)).toEqual(['criteria.0.weight', 'criteria.1.hardThreshold']);
  });

  test('rejects a code revision that is not a commit hash', () => {
    const input = modelConfigurationInput();
    input['codeRevision'] = 'main';
    expect(issuePaths(input)).toEqual(['codeRevision']);
  });

  test('rejects duplicate criterion names, example ids, and reference entry ids', () => {
    const input = modelConfigurationInput();
    const criteria = input['criteria'] as Record<string, unknown>[];
    criteria[1] = { ...criteria[1], name: 'names-the-capital' };
    const examples = input['examples'] as Record<string, unknown>[];
    examples.push({ ...examples[0] });
    const reference = input['referenceMaterial'] as { entries: Record<string, unknown>[] };
    reference.entries.push({ ...reference.entries[0], text: 'Another text.' });
    expect(issuePaths(input)).toEqual([
      'criteria.1.name',
      'examples.1.id',
      'referenceMaterial.entries.1.id',
    ]);
  });

  test('rejects a policy criterion citing reference material the configuration lacks', () => {
    const input = modelConfigurationInput();
    const criteria = input['criteria'] as Record<string, unknown>[];
    criteria[3] = { ...criteria[3], referenceMaterialId: 'missing-policy' };
    expect(issuePaths(input)).toEqual(['criteria.3.referenceMaterialId']);
  });

  test('rejects a model-judge criterion when the judge is not a model', () => {
    const input = modelConfigurationInput();
    input['judge'] = { kind: 'heuristic', name: 'regex-judge' };
    expect(issuePaths(input)).toEqual(['criteria.4.kind']);
  });
});

describe('parseEvaluatorConfiguration', () => {
  test('returns the parsed configuration', () => {
    const configuration = parseEvaluatorConfiguration(modelConfigurationInput());
    expect(configuration.name).toBe('capital-cities');
    expect(configuration.judge).toEqual({
      kind: 'model',
      name: 'rubric-judge',
      model: 'claude-sonnet-4-5',
      effort: 'medium',
      tools: [],
    });
  });

  test('throws a typed error listing every issue path', () => {
    const input = modelConfigurationInput();
    delete input['codeRevision'];
    delete input['budgets'];
    let caught: unknown;
    try {
      parseEvaluatorConfiguration(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EvaluatorConfigurationError);
    const error = caught as EvaluatorConfigurationError;
    expect(error.name).toBe('EvaluatorConfigurationError');
    expect(error.issues.map((issue) => issue.path.join('.')).toSorted()).toEqual([
      'budgets',
      'codeRevision',
    ]);
    expect(error.message).toStartWith('Invalid evaluator configuration: ');
    expect(error.message).toContain('budgets: ');
    expect(error.message).toContain('codeRevision: ');
  });

  test('names the configuration root when an issue has no path', () => {
    const error = new EvaluatorConfigurationError([{ path: [], message: 'Expected object' }]);
    expect(error.message).toBe('Invalid evaluator configuration: (root): Expected object');
  });
});
