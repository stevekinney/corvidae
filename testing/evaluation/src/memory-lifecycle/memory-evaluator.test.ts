import { describe, expect, test } from 'bun:test';

import { parseEvaluatorConfiguration } from '../configuration';
import {
  contaminationCheckSchema,
  isGateEligibleDataset,
  parseEvaluationDataset,
} from '../datasets';
import { createEvaluator } from '../evaluator';
import { evaluatorIdentity } from '../identity';
import { memoryLifecycleEnvelope } from './envelope';
import {
  ACTION_CRITERION,
  admissionScore,
  LANE_REPETITIONS,
  MEMORY_LIFECYCLE_CODE_REVISION,
  memoryLifecycleConfiguration,
  memoryLifecycleEvaluator,
  memoryLifecycleScorers,
  modelJudgingIssues,
  SAFETY_CRITERIA,
} from './memory-evaluator';
import { runScenario } from './memory-lifecycle.test-support';
import type { ScenarioMetrics } from './metrics';
import { memoryLifecycleGate } from './release';
import { memoryLifecycleSuite } from './suite';

const suite = memoryLifecycleSuite();

describe('memoryLifecycleConfiguration', () => {
  test('is one valid, versioned configuration per baseline and lane, differing only in its environment', async () => {
    const envelope = memoryLifecycleEnvelope('deterministic');
    const lifecycle = parseEvaluatorConfiguration(
      memoryLifecycleConfiguration(suite, 'lifecycle', envelope),
    );
    const raw = parseEvaluatorConfiguration(
      memoryLifecycleConfiguration(suite, 'raw-log-search', envelope),
    );
    expect(lifecycle.judge).toEqual({ kind: 'deterministic', name: 'memory-lifecycle-checks' });
    expect(lifecycle.environment).toEqual({
      name: 'memory-lifecycle/lifecycle',
      revision: 'lifecycle-1+memory-lifecycle-environment-1',
    });
    expect(lifecycle.codeRevision).toBe(MEMORY_LIFECYCLE_CODE_REVISION);
    expect(lifecycle.repetitions).toBe(LANE_REPETITIONS.deterministic);
    expect(lifecycle.variancePolicy).toBeUndefined();
    expect({ ...raw, environment: lifecycle.environment }).toEqual(lifecycle);
    const [rawIdentity, lifecycleIdentity] = await Promise.all([
      evaluatorIdentity(raw),
      evaluatorIdentity(lifecycle),
    ]);
    expect(rawIdentity.digest).not.toBe(lifecycleIdentity.digest);
    const names = lifecycle.criteria.map((criterion) => criterion.name);
    expect(names).toContain(ACTION_CRITERION);
    for (const name of SAFETY_CRITERIA) expect(names).toContain(name);
  });

  test('names an ablation for the components it removes, so its identity is never the full architecture', () => {
    const envelope = memoryLifecycleEnvelope('deterministic');
    const environmentOf = (...args: Parameters<typeof memoryLifecycleConfiguration>) =>
      parseEvaluatorConfiguration(memoryLifecycleConfiguration(...args)).environment.name;
    expect(
      environmentOf(suite, 'lifecycle', envelope, ['state-projector', 'resource-derivation']),
    ).toBe('memory-lifecycle/lifecycle-without-procedure-memory');
    expect(environmentOf(suite, 'lifecycle', envelope, ['procedure-memory'])).toBe(
      'memory-lifecycle/lifecycle-without-state-projector-and-resource-derivation',
    );
    expect(
      environmentOf(suite, 'lifecycle', envelope, [
        'resource-derivation',
        'state-projector',
        'procedure-memory',
      ]),
    ).toBe('memory-lifecycle/lifecycle');
    // A baseline without components has nothing to remove.
    expect(environmentOf(suite, 'raw-log-search', envelope, [])).toBe(
      'memory-lifecycle/raw-log-search',
    );
  });

  test('declares repeated trials and a variance policy in the stochastic lane', () => {
    const configuration = parseEvaluatorConfiguration(
      memoryLifecycleConfiguration(suite, 'lifecycle', memoryLifecycleEnvelope('stochastic')),
    );
    expect(configuration.repetitions).toBe(LANE_REPETITIONS.stochastic);
    expect(configuration.variancePolicy).toMatchObject({ name: 'memory-lifecycle-sampled' });
  });
});

describe('memoryLifecycleScorers', () => {
  test('scores every criterion from one measurement of the run', async () => {
    const envelope = memoryLifecycleEnvelope('deterministic');
    const evaluator = await createEvaluator({
      configuration: memoryLifecycleConfiguration(suite, 'flat-hybrid', envelope),
      dataset: memoryLifecycleEvaluator({ baseline: 'flat-hybrid', lane: 'deterministic' }).dataset,
      scorers: memoryLifecycleScorers(suite, 'flat-hybrid', envelope),
    });
    const { result } = await runScenario('flat-hybrid', 'shared-agent-phone');
    const evaluation = await evaluator.evaluateCase('shared-agent-phone', result);
    expect(evaluation.verdict).toBe('fail');
    if (evaluation.verdict !== 'fail') return;
    const scores = Object.fromEntries(
      evaluation.rubric.criteria.map(({ name, score }) => [name, score]),
    );
    expect(scores).toMatchObject({
      'action-success': 0,
      'tool-correctness': 1,
      authorization: 0,
      deletion: 1,
      poisoning: 1,
      'state-maintenance': 1,
      'cost-ceiling': 1,
      'retrieval-sufficiency': 1,
      'evidence-admission': 1,
    });
    expect(scores['context-efficiency']).toBeGreaterThan(0);
    expect(scores['context-efficiency']).toBeLessThan(1);
    const again = await evaluator.evaluateCase('shared-agent-phone', result);
    expect(again).toEqual(evaluation);
  });
});

describe('admissionScore', () => {
  const score = (admission: Partial<ScenarioMetrics['admission']>) =>
    admissionScore({
      admission: {
        truePositives: 0,
        falsePositives: 0,
        falseNegatives: 0,
        precision: null,
        recall: null,
        ...admission,
      },
    } as ScenarioMetrics);

  test('is the F1 of precision and recall, and perfect only when there was nothing to get wrong', () => {
    expect(score({})).toBe(1);
    expect(score({ falsePositives: 1, precision: 0 })).toBe(0);
    expect(score({ recall: 0 })).toBe(0);
    expect(score({ precision: 0, recall: 0 })).toBe(0);
    expect(score({ precision: 0.5, recall: 1 })).toBeCloseTo(2 / 3);
  });
});

describe('modelJudgingIssues', () => {
  test('finds none in the committed configuration and gate', () => {
    const configuration = parseEvaluatorConfiguration(
      memoryLifecycleConfiguration(suite, 'lifecycle', memoryLifecycleEnvelope('deterministic')),
    );
    expect(modelJudgingIssues(configuration, memoryLifecycleGate())).toEqual([]);
    expect(modelJudgingIssues(configuration)).toEqual([]);
  });

  test('refuses model judging that gates, outweighs the checks, or backs a release threshold', () => {
    const check = { name: 'checked', kind: 'deterministic-assertion', description: 'x', weight: 2 };
    const judged = { name: 'judged', kind: 'model-judge', description: 'x', weight: 1 };
    expect(modelJudgingIssues({ criteria: [check, judged] } as never)).toEqual([]);
    expect(
      modelJudgingIssues(
        { criteria: [check, { ...judged, weight: 2, hardThreshold: 0.5 }] } as never,
        {
          regressionThresholds: [
            { criterion: 'judged', metric: 'meanScore', maximumDecrease: 0, severity: 'hard' },
          ],
        },
      ),
    ).toEqual([
      'Model-judge criterion "judged" cannot be a hard gate',
      'Model-judge criteria cannot outweigh the deterministic checks',
      'Release threshold on model-judge criterion "judged"',
    ]);
  });
});

describe('memoryLifecycleEvaluator', () => {
  test("carries the dataset owner's contamination check for the evaluated revision", () => {
    const definition = memoryLifecycleEvaluator({ baseline: 'lifecycle', lane: 'deterministic' });
    expect(definition.calibrationRecords).toEqual([]);
    expect(definition.driftChecks).toEqual([]);
    expect(
      isGateEligibleDataset({
        dataset: parseEvaluationDataset(definition.dataset),
        codeRevision: MEMORY_LIFECYCLE_CODE_REVISION,
        contaminationChecks: definition.contaminationChecks.map((check) =>
          contaminationCheckSchema.parse(check),
        ),
      }),
    ).toBe(true);
  });
});
