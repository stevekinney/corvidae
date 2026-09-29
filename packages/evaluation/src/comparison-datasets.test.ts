import { describe, expect, test } from 'bun:test';

import { TASK_CLASSES, taskClassKey } from './collaboration-plan';
import {
  checkSuccessContract,
  COMPARISON_CONTROLS,
  comparisonDatasetDigest,
  comparisonDatasetSchema,
  parseComparisonDataset,
  renderParticipantInput,
  shardFor,
  successContractKey,
  toEvaluationDataset,
} from './comparison-datasets';
import { EvaluatorConfigurationError } from './configuration';
import { deterministicConfigurationInput } from './evaluation.test-support';
import { createEvaluator } from './evaluator';
import { REPRESENTATIVE_SUCCESS_HEURISTICS } from './fixtures/comparison/heuristics';
import representativeDataset from './fixtures/comparison/representative-dataset.json';

type DatasetInput = Record<string, any>;

function dataset(): DatasetInput {
  return structuredClone(representativeDataset);
}

function caseNamed(input: DatasetInput, id: string): DatasetInput {
  return input['cases'].find((entry: DatasetInput) => entry['id'] === id);
}

function issuesOf(input: unknown): { path: string; message: string }[] {
  const parsed = comparisonDatasetSchema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

describe('the representative comparison dataset', () => {
  const parsed = parseComparisonDataset(representativeDataset);

  test('has at least one case in each of the six task classes, each with its recorded reason', () => {
    const classes = new Set(parsed.cases.map((entry) => taskClassKey(entry.taskClass)));
    for (const taskClass of TASK_CLASSES) expect(classes.has(taskClass)).toBe(true);
    for (const entry of parsed.cases) expect(entry.classReason.length).toBeGreaterThan(20);
  });

  test('gives every case an exact or versioned heuristic success contract', () => {
    const kinds = parsed.cases.map((entry) => successContractKey(entry.successContract));
    expect(kinds).toEqual([
      'exact',
      'exact',
      'exact',
      'exact',
      'exact',
      'exact',
      'exact-word-count@1',
    ]);
    for (const entry of parsed.cases) {
      const { successContract } = entry;
      if (successContract.kind === 'heuristic') {
        expect(
          REPRESENTATIVE_SUCCESS_HEURISTICS[successContractKey(successContract)],
        ).toBeDefined();
      }
    }
  });

  test('includes each required control, with the reason it is one', () => {
    expect(COMPARISON_CONTROLS).toEqual([
      'negative-control',
      'distributed-information',
      'ungoverned-shared-state',
    ]);
    const controlled = parsed.cases.flatMap((entry) =>
      entry.controls.map((control) => [control.kind, taskClassKey(entry.taskClass), entry.id]),
    );
    expect(controlled).toEqual([
      ['negative-control', 'direct', 'direct-multiplication'],
      ['distributed-information', 'partitioned-search', 'partitioned-search-vault-code'],
      ['ungoverned-shared-state', 'shared-state', 'shared-state-ungoverned-scratchpad'],
    ]);
  });

  test('distributes the vault code so no single participant, and so no majority vote, sees every digit', () => {
    const vault = parsed.cases.find((entry) => entry.id === 'partitioned-search-vault-code');
    if (vault === undefined) throw new Error('missing case');
    const required = vault.requiredEvidence;
    const views = [vault.views.direct, ...vault.views.shards];
    for (const view of views) expect(required.every((id) => view.includes(id))).toBe(false);
    const union = new Set(vault.views.shards.flat());
    expect(required.every((id) => union.has(id))).toBe(true);
  });

  test('its digest ignores key order and moves with any field', async () => {
    const digest = await comparisonDatasetDigest(parsed);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const edited = parseComparisonDataset({
      ...dataset(),
      version: 'collaboration-comparison-2026-10',
    });
    expect(await comparisonDatasetDigest(edited)).not.toBe(digest);
  });
});

describe('comparison dataset validation', () => {
  test('rejects a duplicate case, evidence id, or control, and evidence a case never declares', () => {
    const input = dataset();
    input['cases'].push({ ...caseNamed(input, 'direct-multiplication') });
    const vault = caseNamed(input, 'partitioned-search-vault-code');
    vault['evidence'].push({ id: 'shard-a', text: 'A second shard A.' });
    vault['requiredEvidence'].push('shard-z');
    vault['views'].direct.push('shard-y');
    vault['views'].shards[1].push('shard-x');
    vault['controls'].push({ ...vault['controls'][0] });
    expect(issuesOf(input)).toEqual([
      { path: 'cases.2.evidence.3.id', message: 'Duplicate evidence id "shard-a"' },
      {
        path: 'cases.2.requiredEvidence.3',
        message: 'Evidence "shard-z" is not declared by this case',
      },
      {
        path: 'cases.2.views.direct.1',
        message: 'Evidence "shard-y" is not declared by this case',
      },
      {
        path: 'cases.2.views.shards.1.1',
        message: 'Evidence "shard-x" is not declared by this case',
      },
      { path: 'cases.2.controls.1.kind', message: 'Duplicate control "distributed-information"' },
      { path: 'cases.7.id', message: 'Duplicate case id "direct-multiplication"' },
    ]);
  });

  test('rejects a distributed-information case that one participant could solve alone', () => {
    const input = dataset();
    const vault = caseNamed(input, 'partitioned-search-vault-code');
    vault['views'].shards = [['shard-a', 'shard-b', 'shard-c'], ['shard-b']];
    expect(issuesOf(input)).toEqual([
      {
        path: 'cases.2.views',
        message:
          'A distributed-information case needs every single view to miss some required evidence; shard 0 sees all of it',
      },
    ]);
    vault['views'].direct = ['shard-a', 'shard-b', 'shard-c'];
    vault['views'].shards = [['shard-a'], ['shard-b']];
    expect(issuesOf(input)).toEqual([
      {
        path: 'cases.2.views',
        message:
          'A distributed-information case needs every single view to miss some required evidence; the direct view sees all of it',
      },
      {
        path: 'cases.2.views.shards',
        message: 'The shards together must cover the required evidence; none sees shard-c',
      },
    ]);
  });

  test('requires a distributed-information case to split required evidence across at least two shards', () => {
    const input = dataset();
    const vault = caseNamed(input, 'partitioned-search-vault-code');
    vault['views'].shards = [['shard-a']];
    vault['requiredEvidence'] = [];
    expect(issuesOf(input)).toEqual([
      {
        path: 'cases.2.views.shards',
        message: 'A distributed-information case splits its evidence across at least two shards',
      },
      {
        path: 'cases.2.requiredEvidence',
        message: 'A distributed-information case names the evidence a correct answer needs',
      },
    ]);
  });

  test('keeps the ungoverned shared-store control to shared-state cases', () => {
    const input = dataset();
    const direct = caseNamed(input, 'direct-multiplication');
    direct['controls'] = [{ kind: 'ungoverned-shared-state', reason: 'Misfiled.' }];
    expect(issuesOf(input)).toEqual([
      {
        path: 'cases.0.controls.0.kind',
        message: 'The ungoverned shared-store control belongs to a shared-state case',
      },
    ]);
  });

  test('parseComparisonDataset throws a typed configuration error', () => {
    expect(() => parseComparisonDataset({ ...dataset(), cases: [] })).toThrow(
      EvaluatorConfigurationError,
    );
  });
});

describe('dataset helpers', () => {
  const parsed = parseComparisonDataset(representativeDataset);
  const vault = parsed.cases[2]!;
  const direct = parsed.cases[0]!;

  test('toEvaluationDataset gives the evaluator each case’s input, expected answer, and visibility', async () => {
    const evaluationDataset = toEvaluationDataset(parsed);
    expect(evaluationDataset.cases[3]).toEqual({
      id: 'sequential-dependency-conversion',
      input: parsed.cases[3]!.input,
      expected: '16',
      visibility: 'held-out',
    });
    expect(evaluationDataset.cases[6]?.expected).toBe('7');
    const evaluator = await createEvaluator({
      configuration: { ...deterministicConfigurationInput(), datasetVersion: parsed.version },
      dataset: evaluationDataset,
      scorers: {
        assertions: { 'names-the-capital': () => true },
        heuristics: { concise: () => 1 },
        policies: { 'follows-style-guide': () => true },
      },
    });
    expect(evaluator.dataset.cases.map((entry) => entry.id)).toEqual(
      parsed.cases.map((entry) => entry.id),
    );
  });

  test('renders a participant’s input from the task and exactly the evidence its view names', () => {
    expect(renderParticipantInput(direct, [])).toBe(direct.input);
    expect(renderParticipantInput(vault, ['shard-b'])).toBe(
      `${vault.input}\n\nEvidence:\n- shard-b: Shard B records the digit 7.`,
    );
  });

  test('assigns shards to producers round-robin, and none when the case has no shards', () => {
    expect([0, 1, 2, 3].map((index) => shardFor(vault, index))).toEqual([
      ['shard-a'],
      ['shard-b'],
      ['shard-c'],
      ['shard-a'],
    ]);
    expect(shardFor(direct, 5)).toEqual([]);
  });

  test('checks an exact contract against the trimmed content', () => {
    expect(checkSuccessContract(direct.successContract, ' 391\n', {})).toBe(true);
    expect(checkSuccessContract(direct.successContract, '391.', {})).toBe(false);
  });

  test('checks a heuristic contract with the scorer registered under its name and version', () => {
    const contract = parsed.cases[6]!.successContract;
    const heuristics = REPRESENTATIVE_SUCCESS_HEURISTICS;
    expect(
      checkSuccessContract(
        contract,
        'Rivers carve patient valleys through ancient stone.',
        heuristics,
      ),
    ).toBe(true);
    expect(checkSuccessContract(contract, 'Rivers carve valleys.', heuristics)).toBe(false);
    expect(() => checkSuccessContract(contract, 'Rivers.', {})).toThrow(
      'No success heuristic is registered for "exact-word-count@1"',
    );
    const loose = { 'exact-word-count@1': () => 'yes' as unknown as boolean };
    expect(() => checkSuccessContract(contract, 'Rivers.', loose)).toThrow(
      'Success heuristic "exact-word-count@1" returned string, not a boolean',
    );
  });
});
