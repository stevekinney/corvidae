import { describe, expect, it } from 'bun:test';

import { MaximumStepsExceededError } from '../errors';
import { reconstructTerminalRunError } from './active-run-result-reconstruction';
import {
  AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
  type AgentRunWorkflowResult,
  normalizeAgentRunWorkflowResult,
} from './run-workflow-result';

/**
 * COR-1627 — a durable run's summary says `maximum-steps` for two different ends: the loop ran
 * out of steps, which carries no error message because no error was thrown, and a step that threw
 * a `MaximumStepsExceededError` of its own, whose message the step checkpointed. Reconstruction
 * rebuilds the thrown error from what was checkpointed, so a recovered run reports the limit the
 * error named and not the count of steps the run happened to commit. A summary written before
 * this change carries no message for a step limit and reads exactly as it did.
 */
describe('reconstructing the terminal error of a durable run that ended at a step limit', () => {
  const rows = [
    {
      name: 'the loop ran out of steps (a summary from main, no error message)',
      args: { finishReason: 'maximum-steps' as const, steps: 2 },
      message: 'Agent run exceeded maximumSteps (2).',
    },
    {
      name: 'a step threw its own step-limit error',
      args: {
        finishReason: 'maximum-steps' as const,
        steps: 1,
        errorMessage: 'Agent run exceeded maximumSteps (9).',
        errorKind: 'policy' as const,
        errorCode: 'MAXIMUM_STEPS' as const,
      },
      message: 'Agent run exceeded maximumSteps (9).',
    },
    {
      name: 'a hook threw a step-limit error with a message of its own',
      args: {
        finishReason: 'maximum-steps' as const,
        steps: 3,
        errorMessage: 'The plan allows no more steps.',
      },
      message: 'The plan allows no more steps.',
    },
  ];

  for (const row of rows) {
    it(`rebuilds the MaximumStepsExceededError when ${row.name}`, () => {
      const error = reconstructTerminalRunError(row.args);

      expect(error).toBeInstanceOf(MaximumStepsExceededError);
      expect(error).toMatchObject({
        name: 'MaximumStepsExceededError',
        message: row.message,
        kind: 'policy',
        code: 'MAXIMUM_STEPS',
      });
    });
  }

  it('reads a step-limit summary written by main unchanged', () => {
    // The shape `origin/main` wrote for a run that ran out of steps: the current schema version,
    // the finish reason, and no error fields. Nothing about it is rejected or rewritten.
    const written: AgentRunWorkflowResult = {
      schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
      runId: 'from-main',
      steps: 2,
      content: 'step 1',
      parts: [],
      finishReason: 'maximum-steps',
    };

    const summary = normalizeAgentRunWorkflowResult(JSON.parse(JSON.stringify(written)));

    expect(summary).toEqual(written);
    expect(reconstructTerminalRunError(summary)?.message).toBe(
      'Agent run exceeded maximumSteps (2).',
    );
  });
});
