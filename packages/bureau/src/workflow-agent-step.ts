/**
 * The pure half of a workflow file's `agent` step (COR-1527): the run id a step's agent run has,
 * and how a finished run, or a durable run's recorded state, becomes the step's result or its
 * failure. Starting the run is `create-bureau.ts`'s, which owns the dispatcher.
 *
 * @module workflow-agent-step
 */

import { createHash } from 'node:crypto';

import { isFailureFinishReason, type RunResult } from '@lostgradient/operative';
import type { JSONValue, WorkflowState } from '@lostgradient/weft';
import { isJSONValue } from '@lostgradient/weft';

import { serializeUnknownError } from './serialization';
import { type AgentStepResult, WorkflowAgentStepError } from './workflow-host';

/**
 * The id of the standalone run an `agent` step starts: a function of the instance and the step, so
 * a step a restart re-executes finds its own run. A hash and not a concatenation, because a
 * workflow id can already be close to Weft's 128 characters.
 */
export function workflowStepRunId(workflowId: string, step: number): string {
  const digest = createHash('sha256')
    .update(`${workflowId}:${String(step)}`)
    .digest('hex');
  return `workflow-agent-${digest.slice(0, 32)}`;
}

function failed(
  agent: string,
  finishReason: string,
  error: string | undefined,
): WorkflowAgentStepError {
  const aborted = finishReason === 'aborted';
  return new WorkflowAgentStepError(
    aborted ? 'agent-run-aborted' : 'agent-run-failed',
    agent,
    `Agent "${agent}" ${aborted ? 'was aborted' : 'failed'} (finish reason "${finishReason}")${
      error === undefined ? '' : `: ${error}`
    }`,
  );
}

function jsonOrNull(value: unknown): JSONValue | null {
  if (value === undefined || value === null) return null;
  return isJSONValue(value) ? value : (JSON.parse(JSON.stringify(value)) as JSONValue);
}

/**
 * Where Armorer's message begins when a call needed an approval it could not issue because the run
 * had no request context to bind it to (an unattended run: a workflow step has no requester). The
 * `workflow-agent-step-approval` test runs a real step, so a change to the text fails it.
 */
const APPROVAL_UNAVAILABLE_MESSAGE_START = 'Approval authorization requires';

/**
 * The first tool call of the run that needed a person's approval, which an unattended run cannot
 * get: it ended `action_required`, or Armorer could not issue the approval at all. `undefined` when
 * no call did.
 */
function toolNeedingApproval(result: RunResult<unknown, true>): string | undefined {
  for (const step of result.steps) {
    for (const call of step.results) {
      if (call.outcome === 'action_required') return call.toolName;
      if (
        call.outcome === 'error' &&
        (call.error?.message ?? call.errorMessage)?.startsWith(APPROVAL_UNAVAILABLE_MESSAGE_START)
      ) {
        return call.toolName;
      }
    }
  }
  return undefined;
}

/**
 * A step's result from the finished run, or the failure the run ended in. A run in which a tool
 * call needed an approval fails the step too (COR-1913): the model was told the call did not run
 * and went on, so the run looks finished while the change it was started for was never made. A
 * workflow step has no one to ask, so a tool it uses to change something has to say `never`.
 */
export function agentStepResultFromRun(
  agent: string,
  result: RunResult<unknown, true>,
): AgentStepResult {
  const finishReason = result.finishReason;
  if (finishReason === 'aborted' || isFailureFinishReason(finishReason)) {
    throw failed(
      agent,
      finishReason,
      result.error === undefined ? undefined : serializeUnknownError(result.error),
    );
  }
  const needing = toolNeedingApproval(result);
  if (needing !== undefined) {
    throw new WorkflowAgentStepError(
      'agent-run-failed',
      agent,
      `Agent "${agent}" called "${needing}", which needs a person's approval, and a workflow step has no one to ask, so the call did not run. Set "${needing}" to "never" in the agent file's toolApproval to let a workflow use it, or take the tool away from the agent.`,
    );
  }
  return {
    content: result.content,
    output: jsonOrNull((result as { output?: unknown }).output),
    finishReason,
  };
}

/**
 * A step's result from the engine's record of the step's run, for a run that already existed when
 * the step ran again: the summary the `agentRun` workflow returns, or the failure the run ended in.
 */
export function agentStepResultFromState(
  agent: string,
  state: WorkflowState | null | undefined,
): AgentStepResult {
  if (state === null || state === undefined) {
    throw new WorkflowAgentStepError(
      'agent-run-failed',
      agent,
      `The run of agent "${agent}" for this step is no longer recorded.`,
    );
  }
  if (state.status === 'cancelled') throw failed(agent, 'aborted', state.error);
  if (state.status === 'failed' || state.status === 'timed-out') {
    throw failed(agent, 'error', state.error ?? state.status);
  }
  const summary = state.result;
  if (
    typeof summary !== 'object' ||
    summary === null ||
    typeof (summary as { content?: unknown }).content !== 'string' ||
    typeof (summary as { finishReason?: unknown }).finishReason !== 'string'
  ) {
    throw new WorkflowAgentStepError(
      'agent-run-failed',
      agent,
      `The run of agent "${agent}" for this step did not record a result.`,
    );
  }
  const recorded = summary as { content: string; finishReason: string; output?: unknown };
  if (recorded.finishReason === 'aborted' || isFailureFinishReason(recorded.finishReason)) {
    throw failed(agent, recorded.finishReason, undefined);
  }
  return {
    content: recorded.content,
    output: jsonOrNull(recorded.output),
    finishReason: recorded.finishReason,
  };
}
