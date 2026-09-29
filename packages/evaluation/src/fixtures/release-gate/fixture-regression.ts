/**
 * The offline evaluator behind `gates/fixture-regression.json`. Everything a
 * model would do is scripted with operative's `createScriptedGenerate`: the
 * capitals agent's answers and the model judge's replies. Nothing here calls
 * a provider, so the gate and its replay run anywhere.
 *
 * Each script is its own module (`passing.ts`, `regressing.ts`,
 * `judge-throws.ts`, `uncalibrated.ts`) whose default export builds a fresh
 * evaluator, so a gate file selects one by path. Trials run case by case in
 * dataset order, so one shared agent script answers them in that order.
 */
import {
  createAgent,
  createScriptedGenerate,
  type ScriptedGenerateStep,
} from '@lostgradient/operative';

import { parseEvaluatorConfiguration } from '../../configuration';
import { judgeRevisionOf } from '../../judge-drift';
import type { GateEvaluatorDefinition } from '../../release-gate';

export type FixtureScript = 'passing' | 'regressing' | 'judge-throws' | 'uncalibrated';

/** The evaluated revision the fixture's contamination check and baseline cite. */
export const FIXTURE_CODE_REVISION = 'e179aa61e7d926037cb590b35ad797acaaa5d556';
export const FIXTURE_DATASET_OWNER = 'evaluation-datasets-team';
export const FIXTURE_REPETITIONS = 3;

const AGENT_USAGE = { prompt: 10, completion: 5, total: 15 };

export function fixtureConfiguration(): Record<string, unknown> {
  return {
    name: 'fixture-regression',
    revision: 1,
    passThreshold: 0.75,
    criteria: [
      {
        name: 'names-the-capital',
        kind: 'deterministic-assertion',
        description: 'The final answer names the expected capital.',
        weight: 3,
        hardThreshold: 1,
      },
      {
        name: 'helpful-tone',
        kind: 'model-judge',
        description: 'The answer is courteous and directly addresses the question.',
        weight: 1,
      },
    ],
    examples: [
      {
        id: 'calibration-lyon',
        input: 'What is the capital of France?',
        response: 'Lyon is the capital, next to the Rhone.',
        verdict: 'fail',
        rationale: 'Names the wrong city.',
      },
    ],
    referenceMaterial: { version: 'fixture-reference-1', entries: [] },
    judge: {
      kind: 'model',
      name: 'fixture-judge',
      model: 'claude-sonnet-4-5',
      effort: 'medium',
      tools: [],
    },
    promptVersion: 'fixture-judge-prompt-1',
    datasetVersion: 'capitals-2026-09',
    environment: { name: 'scripted-generate', revision: 'fixture-regression-1' },
    budgets: {
      perEvaluation: { costUsd: 0.05, latencyMilliseconds: 30_000 },
      perGateRun: { costUsd: 1, latencyMilliseconds: 60_000 },
    },
    repetitions: FIXTURE_REPETITIONS,
    variancePolicy: {
      name: 'two-of-three',
      version: '1',
      minimumPassFraction: 0.6,
      maximumIntervalWidth: 0.75,
    },
    resultSchemaVersion: 1,
    codeRevision: FIXTURE_CODE_REVISION,
  };
}

export function fixtureDataset(): Record<string, unknown> {
  return {
    id: 'capitals',
    version: 'capitals-2026-09',
    owner: FIXTURE_DATASET_OWNER,
    cases: [
      {
        id: 'case-france',
        input: 'What is the capital of France?',
        expected: 'Paris',
        visibility: 'held-out',
      },
      {
        id: 'case-japan',
        input: 'What is the capital of Japan?',
        expected: 'Tokyo',
        visibility: 'public',
      },
    ],
  };
}

/** The agent's answer to each case, in dataset order, for one script. */
function answers(script: FixtureScript): readonly string[] {
  const france = script === 'regressing' ? 'Lyon, on the Rhone.' : 'Paris, on the Seine.';
  return [france, 'Tokyo, on Honshu.'];
}

function respond(content: string): ScriptedGenerateStep {
  return { kind: 'respond', response: { content, toolCalls: [], usage: AGENT_USAGE } };
}

function judgeStep(script: FixtureScript): ScriptedGenerateStep {
  if (script === 'judge-throws') {
    return { kind: 'fail', error: new Error('The scripted judge provider is unavailable') };
  }
  return respond(
    JSON.stringify({
      criteria: [{ name: 'helpful-tone', score: 1, rationale: 'Courteous and direct.' }],
      feedback: 'Clear, direct answer.',
    }),
  );
}

/** A fresh evaluator for one gate run: its scripts have not been consumed yet. */
export async function fixtureRegressionEvaluator(
  script: FixtureScript,
): Promise<GateEvaluatorDefinition> {
  const configuration = fixtureConfiguration();
  const judgeRevision = await judgeRevisionOf(parseEvaluatorConfiguration(configuration));
  const trials = answers(script).flatMap((answer) =>
    Array.from({ length: FIXTURE_REPETITIONS }, () => answer),
  );
  const agentGenerate = createScriptedGenerate(trials.map(respond));
  return {
    configuration,
    dataset: fixtureDataset(),
    scorers: {
      assertions: {
        'names-the-capital': ({ result, evaluationCase }) =>
          result.content.includes(evaluationCase.expected),
      },
    },
    judge: createScriptedGenerate(trials.map(() => judgeStep(script))),
    subject: () => createAgent({ name: 'geographer', generate: agentGenerate }),
    contaminationChecks: [
      {
        datasetId: 'capitals',
        datasetVersion: 'capitals-2026-09',
        codeRevision: FIXTURE_CODE_REVISION,
        actor: FIXTURE_DATASET_OWNER,
        recordedAt: '2026-09-28T00:00:00.000Z',
        statement: 'No held-out capital appears in the scripted agent, its prompt, or its memory.',
      },
    ],
    calibrationRecords:
      script === 'uncalibrated'
        ? []
        : [
            {
              judgeRevision: judgeRevision.digest,
              reviewer: 'evaluation-calibrator',
              sampleSize: 40,
              agreementRate: 0.925,
              recordedAt: '2026-09-28T00:00:00.000Z',
            },
          ],
    driftChecks: [{ judgeRevision: judgeRevision.digest, outcome: 'passed' }],
  };
}
