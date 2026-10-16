import { describe, expect, test } from 'bun:test';

import { createScriptedGenerate, type ScriptedGenerateStep } from '@lostgradient/operative';

import { EvaluatorConfigurationError, parseEvaluatorConfiguration } from './configuration';
import { modelConfigurationInput } from './evaluation.test-support';
import calibrationSet from './fixtures/judge-drift/calibration-set.json';
import driftedRevision from './fixtures/judge-drift/drifted-revision.json';
import stableRevision from './fixtures/judge-drift/stable-revision.json';
import { checkJudgeDrift, judgeRevisionOf, parseCalibrationSet } from './judge-drift';
import { EvaluatorInfrastructureError } from './verdict';

type RevisionFixture = typeof stableRevision;

function respond(content: string): ScriptedGenerateStep {
  return { kind: 'respond', response: { content, toolCalls: [] } };
}

function configurationFor(revision: { promptVersion: string }): Record<string, unknown> {
  return { ...modelConfigurationInput(), promptVersion: revision.promptVersion };
}

function scriptedJudge(revision: RevisionFixture) {
  return createScriptedGenerate(revision.replies.map((entry) => respond(JSON.stringify(entry))));
}

async function rejectionPaths(run: () => Promise<unknown>): Promise<string[]> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(EvaluatorConfigurationError);
    return (error as EvaluatorConfigurationError).issues.map((issue) => issue.path.join('.'));
  }
  throw new Error('Expected a configuration error');
}

describe('judgeRevisionOf', () => {
  test('names the judge and prompt version and digests what the judge reads', async () => {
    const configuration = parseEvaluatorConfiguration(modelConfigurationInput());
    const revision = await judgeRevisionOf(configuration);
    expect(revision.name).toBe('rubric-judge');
    expect(revision.promptVersion).toBe('judge-prompt-3');
    expect(revision.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each<[string, (input: Record<string, unknown>) => void]>([
    ['prompt version', (input) => (input['promptVersion'] = 'judge-prompt-4')],
    [
      'judge model',
      (input) => (input['judge'] = { ...(input['judge'] as object), model: 'other' }),
    ],
    [
      'model-judge criterion',
      (input) => {
        const criteria = input['criteria'] as Record<string, unknown>[];
        criteria[4] = { ...criteria[4], description: 'Friendlier wording.' };
      },
    ],
    [
      'reference material',
      (input) => {
        (input['referenceMaterial'] as Record<string, unknown>)['version'] = 'style-guide-2026-10';
      },
    ],
    ['calibration examples', (input) => (input['examples'] = [])],
  ])('moves when the %s changes', async (_label, change) => {
    const base = await judgeRevisionOf(parseEvaluatorConfiguration(modelConfigurationInput()));
    const input = modelConfigurationInput();
    change(input);
    const changed = await judgeRevisionOf(parseEvaluatorConfiguration(input));
    expect(changed.digest).not.toBe(base.digest);
  });

  test.each<[string, (input: Record<string, unknown>) => void]>([
    ['code revision', (input) => (input['codeRevision'] = '41257994')],
    ['dataset version', (input) => (input['datasetVersion'] = 'capitals-2026-10')],
    ['repetitions', (input) => (input['repetitions'] = 5)],
    [
      'a criterion the judge does not score',
      (input) => {
        const criteria = input['criteria'] as Record<string, unknown>[];
        criteria[1] = { ...criteria[1], weight: 4 };
      },
    ],
  ])('stays put when the %s changes', async (_label, change) => {
    const base = await judgeRevisionOf(parseEvaluatorConfiguration(modelConfigurationInput()));
    const input = modelConfigurationInput();
    change(input);
    const unchanged = await judgeRevisionOf(parseEvaluatorConfiguration(input));
    expect(unchanged.digest).toBe(base.digest);
  });
});

describe('checkJudgeDrift', () => {
  test('passes the stable revision fixture', async () => {
    const generate = scriptedJudge(stableRevision);
    const configuration = configurationFor(stableRevision);
    const check = await checkJudgeDrift({ configuration, generate }, calibrationSet);
    expect(generate.callCount).toBe(calibrationSet.items.length);
    expect(check.outcome).toBe('passed');
    expect(check.agreementRate).toBe(1);
    expect(check.minimumAgreementRate).toBe(0.8);
    expect(check.calibrationSet).toEqual({ id: 'capitals-judge-calibration', version: '2026-09' });
    const revision = await judgeRevisionOf(parseEvaluatorConfiguration(configuration));
    expect(check.judgeRevision).toBe(revision.digest);
    expect(check.comparisons).toHaveLength(5);
    expect(check.comparisons[1]).toEqual({
      item: 'calibration-curt-correct',
      criterion: 'helpful-tone',
      referenceScore: 0.3,
      judgeScore: 0.25,
      agrees: true,
    });
    expect(check.errors).toEqual([]);
  });

  test('fails the drifted revision fixture', async () => {
    const check = await checkJudgeDrift(
      {
        configuration: configurationFor(driftedRevision),
        generate: scriptedJudge(driftedRevision),
      },
      calibrationSet,
    );
    expect(check.outcome).toBe('drifted');
    expect(check.agreementRate).toBe(0.4);
    expect(check.comparisons.filter((comparison) => !comparison.agrees).map((c) => c.item)).toEqual(
      ['calibration-curt-correct', 'calibration-dismissive', 'calibration-evasive'],
    );
  });

  test('is indeterminate, with typed errors and every item still judged once, when the judge fails', async () => {
    const replies = stableRevision.replies.map((entry) => JSON.stringify(entry));
    replies[1] = 'not json';
    replies[3] = JSON.stringify({ criteria: [], feedback: 'Scored nothing.' });
    const generate = createScriptedGenerate(replies.map(respond));
    const check = await checkJudgeDrift(
      { configuration: configurationFor(stableRevision), generate },
      calibrationSet,
    );
    expect(generate.callCount).toBe(5);
    expect(check.outcome).toBe('indeterminate');
    expect(check.agreementRate).toBeNull();
    expect(check.comparisons).toHaveLength(3);
    expect(check.errors.map((error) => [error.reason, error.criterion])).toEqual([
      ['judge-malformed-output', undefined],
      ['judge-malformed-output', 'helpful-tone'],
    ]);
    for (const error of check.errors) expect(error).toBeInstanceOf(EvaluatorInfrastructureError);
    expect(check.errors[1]?.message).toContain('calibration-dismissive');
  });

  test('rejects a judge that is not a model or scores no criterion', async () => {
    const heuristic = modelConfigurationInput();
    heuristic['criteria'] = (heuristic['criteria'] as { kind: string }[]).filter(
      (criterion) => criterion.kind !== 'model-judge',
    );
    heuristic['judge'] = { kind: 'heuristic', name: 'regex-judge' };
    const generate = createScriptedGenerate([]);
    expect(
      await rejectionPaths(() =>
        checkJudgeDrift({ configuration: heuristic, generate }, calibrationSet),
      ),
    ).toEqual(['judge.kind', 'criteria']);
    expect(generate.callCount).toBe(0);
  });

  test('rejects calibration items whose reference scores do not match the model-judge criteria', async () => {
    const set = structuredClone(calibrationSet) as {
      items: { referenceScores: Record<string, number> }[];
    };
    set.items[0]!.referenceScores = {};
    set.items[2]!.referenceScores['concise'] = 1;
    expect(
      await rejectionPaths(() =>
        checkJudgeDrift(
          { configuration: modelConfigurationInput(), generate: createScriptedGenerate([]) },
          set,
        ),
      ),
    ).toEqual(['items.0.referenceScores.helpful-tone', 'items.2.referenceScores.concise']);
  });
});

describe('parseCalibrationSet', () => {
  test('returns the fixed calibration set', () => {
    const parsed = parseCalibrationSet(calibrationSet);
    expect(parsed.items.map((item) => item.id)).toHaveLength(5);
    expect(parsed.tolerance).toBe(0.2);
  });

  test('rejects duplicate items, an empty set, and scores outside [0, 1]', async () => {
    const duplicate = structuredClone(calibrationSet);
    duplicate.items.push(duplicate.items[0]!);
    expect(await rejectionPaths(async () => parseCalibrationSet(duplicate))).toEqual([
      'items.5.id',
    ]);
    expect(
      await rejectionPaths(async () => parseCalibrationSet({ ...calibrationSet, items: [] })),
    ).toEqual(['items']);
    const outOfRange = structuredClone(calibrationSet);
    outOfRange.items[0]!.referenceScores['helpful-tone'] = 2;
    expect(await rejectionPaths(async () => parseCalibrationSet(outOfRange))).toEqual([
      'items.0.referenceScores.helpful-tone',
    ]);
    expect(
      await rejectionPaths(async () =>
        parseCalibrationSet({ ...calibrationSet, minimumAgreementRate: 0 }),
      ),
    ).toEqual(['minimumAgreementRate']);
  });
});
