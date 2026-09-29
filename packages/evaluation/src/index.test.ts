import { describe, expect, test } from 'bun:test';

import { createAgent, createScriptedGenerate, createScriptedTool } from '@lostgradient/operative';

import {
  datasetInput,
  EXPECTED_ANSWER,
  judgeReply,
  modelConfigurationInput,
  STYLE_GUIDE_TEXT,
} from './evaluation.test-support';
import * as evaluation from './index';

describe('@lostgradient/evaluation', () => {
  test('exposes its runtime API from the package root', () => {
    expect(Object.keys(evaluation).toSorted()).toEqual([
      'AGENT_FAILURE_REASONS',
      'CASE_VISIBILITIES',
      'CorruptHistoricalRecordError',
      'DISAGREEMENT_REASONS',
      'DatasetOwnershipError',
      'EVALUATION_HISTORY_SCHEMA_VERSION',
      'EVALUATION_RESULT_SCHEMA_VERSION',
      'EvaluatorConfigurationError',
      'EvaluatorInfrastructureError',
      'GATE_DECISIONS',
      'GATE_RECORD_SCHEMA_VERSION',
      'HistoricalRecordExistsError',
      'INFRASTRUCTURE_FAILURE_REASONS',
      'JUDGE_RESPONSE_FORMAT',
      'OverrideRejectedError',
      'RELEASE_GATE_EXIT_CODES',
      'REPLAY_EXIT_CODES',
      'WILSON_Z_95',
      'applyRubric',
      'assessOverride',
      'calibrationRecordSchema',
      'calibrationSetSchema',
      'canonicalJson',
      'checkJudgeDrift',
      'compareEvaluationRuns',
      'contaminationCheckSchema',
      'createEvaluationHistory',
      'createEvaluator',
      'createGoalEvaluatorAdapter',
      'decideGate',
      'driftCheckRecordSchema',
      'evaluationDatasetSchema',
      'evaluationRunRecordSchema',
      'evaluatorConfigurationSchema',
      'evaluatorIdentity',
      'gateDecisionRecordSchema',
      'gateDefinitionSchema',
      'gateOverrideRecordSchema',
      'isAgentFailureReason',
      'isGateEligibleDataset',
      'isGateEligibleJudge',
      'judgeEligibility',
      'judgeResponseSchema',
      'judgeRevisionOf',
      'loadGateEvaluator',
      'parseCalibrationRecord',
      'parseCalibrationSet',
      'parseContaminationCheck',
      'parseEvaluationDataset',
      'parseEvaluationRunRecord',
      'parseEvaluatorConfiguration',
      'parseGateDefinition',
      'promoteCaseToPublic',
      'reconcileJudges',
      'recordDigest',
      'recordOverride',
      'renderJudgePrompt',
      'replayGateDecision',
      'runReleaseGate',
      'runTrials',
      'scoreTrials',
      'toEvaluationRunRecord',
      'toGeneratorProjection',
      'toReleaseGateReport',
      'toReviewerProjection',
      'variancePolicySchema',
      'wilsonInterval',
    ]);
  });

  test('scores a real operative run: a forbidden tool call fails the case despite a correct answer', async () => {
    const webSearch = createScriptedTool('web_search', [
      { kind: 'resolve', result: 'Paris is the capital of France.' },
    ]);
    const agentGenerate = createScriptedGenerate([
      {
        kind: 'respond',
        response: {
          content: '',
          toolCalls: [
            { id: 'call-1', name: 'web_search', arguments: { query: 'capital of France' } },
          ],
        },
      },
      { kind: 'respond', response: { content: 'Paris, on the Seine.', toolCalls: [] } },
    ]);
    const agent = createAgent({
      name: 'geographer',
      generate: agentGenerate,
      tools: { web_search: webSearch },
    });
    const result = await agent.run('What is the capital of France?').result();
    expect(result.finishReason).toBe('stop-condition');
    expect(webSearch.callCount).toBe(1);

    const judge = createScriptedGenerate([
      {
        kind: 'respond',
        response: {
          content: judgeReply({ feedback: `Say "${EXPECTED_ANSWER}" per: ${STYLE_GUIDE_TEXT}` }),
          toolCalls: [],
        },
      },
    ]);
    const evaluator = await evaluation.createEvaluator({
      configuration: modelConfigurationInput(),
      dataset: datasetInput(),
      scorers: {
        assertions: {
          'names-the-capital': ({ result: run, evaluationCase }) =>
            run.content.startsWith(evaluationCase.expected),
        },
        heuristics: { concise: ({ result: run }) => (run.content.split(' ').length < 40 ? 1 : 0) },
        policies: { 'follows-style-guide': () => true },
      },
      generate: judge,
    });
    const scored = await evaluator.evaluateCase('case-france', result);

    expect(scored.verdict).toBe('fail');
    const generatorView = evaluation.toGeneratorProjection(scored);
    expect(generatorView.failedHardCriteria).toEqual(['no-web-search']);
    expect(JSON.stringify(generatorView)).not.toContain(EXPECTED_ANSWER);
    expect(JSON.stringify(generatorView)).not.toContain(STYLE_GUIDE_TEXT);
    const reviewerView = evaluation.toReviewerProjection(scored);
    expect(
      reviewerView.run.trajectory.flatMap((step) => step.toolCalls.map((call) => call.name)),
    ).toEqual(['web_search']);
    expect(
      reviewerView.rubric?.criteria.find((criterion) => criterion.name === 'names-the-capital')
        ?.score,
    ).toBe(1);
  });
});
