/**
 * `bureau.tasks.explanation.get` and `bureau.tasks.explanation.generate`: the longer explanation of a
 * failed agent run that a model writes when the owner asks for it (COR-2534), after the stored-facts
 * explanation `bureau.tasks.explain` serves.
 *
 * `generate` asks the Bureau's configured decision model to read the stored-facts explanation and,
 * for each step, its name, status, error message and guardrail verdicts, and nothing else: no tool
 * argument, tool result or message is read, so none can reach the model. The text is stored on the
 * task with the model that wrote it, the time and its cost, and replaces the one the task held.
 * `get` returns what is stored and calls no model, so reopening a page costs nothing.
 *
 * Neither operation is on MCP, so a model cannot spend tokens asking another model to explain a run.
 * Only an agent run (a task) has a record to keep it on; an instance of a workflow file is answered
 * with the stored facts alone. The cost is the explanation's own and the run's `usage` is not touched.
 *
 * @module tasks-model-explanation-operation
 */

import { DecisionSchemaError } from '@lostgradient/operative';
import { defineOperation, type OperationFault } from '@lostgradient/backchannel';
import { z } from 'zod';

import { BureauError } from '../../bureau-errors.ts';
import { ModelPolicyDeniedError } from '../../file-agent-generate.ts';
import {
  explanationRequestSteps,
  generateModelExplanation,
  modelExplanationRequest,
  type ModelExplanationDependencies,
} from '../../run-model-explanation.ts';
import { readRunFailure } from '../../run-failure-read.ts';
import type { TaskRegistry } from '../../task-registry.ts';
import { bureauFaultOf } from '../bureau-fault-policy.ts';
import { ownerOfPrincipal } from '../owner-predicate.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';
import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';
import { readableRun } from './runs-timeline-operation.ts';
import { runNotFailed, type BureauTasksExplainOperationHost } from './tasks-explain-operation.ts';
import { mayAccessTask } from './tasks-operations.ts';

/** What the two operations read from the handler's `host`. */
export type BureauTasksModelExplanationOperationHost = BureauTasksExplainOperationHost &
  Pick<ModelExplanationDependencies, 'decisions' | 'catalog'> & {
    /** The record a task's explanation is kept on, and the clock that dates it. */
    readonly modelExplanations: Pick<TaskRegistry, 'record' | 'recordModelExplanation'> & {
      readonly now: () => string;
    };
  };

const explanationInput = z.object({
  runId: z
    .string()
    .min(1)
    .max(256)
    .describe('The identifier of the failed agent run: its task id.'),
});

const modelExplanationSchema = z.object({
  text: z.string().describe('What the model wrote, as plain text.'),
  model: z.string().describe('The model that wrote it, as `<provider>/<model>`.'),
  generatedAt: z.iso.datetime({ offset: true }).describe('When it was written.'),
  costUsd: z
    .number()
    .nullable()
    .describe(
      'What writing it cost in US dollars, priced from the model catalog; `null` when the model has no price or reported no usage, never `0`. The run’s own `usage.costUsd` does not include it.',
    ),
});

const explanationOutput = z.object({
  explanation: modelExplanationSchema
    .nullable()
    .describe('The stored explanation, or `null` when no model has been asked about this run.'),
});

const generatedOutput = z.object({ explanation: modelExplanationSchema });

/** The fault for a run that is not an agent run: only a task has a record to keep an explanation on. */
function runHasNoTask(): OperationFault {
  return {
    code: 'Unprocessable',
    message:
      'This run is an instance of a workflow file, which has no task to keep a model’s explanation on',
    data: { reason: 'run-has-no-task' },
    remediation:
      'Read why it failed from the stored facts with `interborough runs explain`, or open the agent run of the step that failed.',
  };
}

/** What a caller is told when no provider is connected to write the explanation. */
const CONNECT_PROVIDER_REMEDIATION =
  'Connect a provider in Settings, under Models, so a model can write the explanation; the stored explanation of the failure still reads without one.';

/** The fault a failed model call is answered with: the model cannot be reached, answered badly, or is not allowed. */
function modelFault(error: unknown): unknown {
  if (error instanceof BureauError && error.code === 'NOT_CONFIGURED') {
    return {
      code: 'UnsupportedCapability',
      message: 'No model is connected to write the explanation',
      data: { capability: 'generate' },
      remediation: CONNECT_PROVIDER_REMEDIATION,
    } satisfies OperationFault;
  }
  if (error instanceof ModelPolicyDeniedError) {
    return {
      code: 'Unprocessable',
      message: error.message,
      data: { reason: error.code },
    } satisfies OperationFault;
  }
  if (error instanceof DecisionSchemaError || error instanceof z.ZodError) {
    return {
      code: 'Unprocessable',
      message: 'The model did not give an explanation that could be kept',
      data: { reason: 'decision-schema' },
      remediation: 'Ask again; the model may answer differently.',
    } satisfies OperationFault;
  }
  return bureauFaultOf(error, { capability: 'generate' });
}

export const tasksExplanationGetOperation = defineOperation<
  typeof explanationInput,
  typeof explanationOutput,
  BureauTasksModelExplanationOperationHost
>({
  name: 'bureau.tasks.explanation.get',
  authorize: authorizeWorkspaceOperation('bureau.tasks.explanation.get'),
  mcpExposable: false,
  summary: 'Read the explanation a model wrote of a failed run',
  description:
    'Returns `explanation`: the longer explanation of why one failed agent run failed that a model wrote when it was asked (`bureau.tasks.explanation.generate`), with its `text`, the `model` that wrote it (`<provider>/<model>`), when it was written (`generatedAt`) and what it cost (`costUsd`, in US dollars, `null` when unpriced), or `null` when none has been written. It calls no model, so reading it again costs nothing. It is a read of the task, with the access `bureau.tasks.get` asks; an instance of a workflow file has no task to keep one on and answers `null`, and any run the caller may not read, or that does not exist, is `NotFound`. It is not on MCP.',
  destructive: false,
  tags: ['Tasks'],
  inputSchema: explanationInput,
  outputSchema: explanationOutput,
  producibleFaults: ['InvalidParams', 'NotFound'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const run = await readableRun(host, principal, input.runId);
    if (run.kind !== 'agent') return { explanation: null };
    const record = await host.modelExplanations.record(input.runId);
    return { explanation: record?.modelExplanation ?? null };
  },
});

export const tasksExplanationGenerateOperation = defineOperation<
  typeof explanationInput,
  typeof generatedOutput,
  BureauTasksModelExplanationOperationHost
>({
  name: 'bureau.tasks.explanation.generate',
  authorize: authorizeWorkspaceOperation('bureau.tasks.explanation.generate'),
  mcpExposable: false,
  summary: 'Ask a model to explain a failed run at more length',
  description:
    'Asks the Bureau’s configured decision model to explain why one failed agent run failed, at more length than `bureau.tasks.explain`, stores the text on the task, and returns it as `explanation` with the `model` that wrote it (`<provider>/<model>`), `generatedAt` and `costUsd` (US dollars priced from the model catalog, `null` when unpriced). It replaces any explanation the task held, and each call asks the model again; `bureau.tasks.explanation.get` reads what is stored without a call. The model is sent the stored-facts explanation and, for each step, its name, status, error message and guardrail verdicts, and never a tool argument, a tool result or a message. The cost is the explanation’s own and is not added to the run’s `usage`. It spends a model’s tokens, so it asks what `bureau.tasks.cancel` asks of the caller (the owner of the run, or `bureau.tasks:write` with `bureau.tasks:read`). A run that did not fail is `Unprocessable` with `data.reason` `run-not-failed`; an instance of a workflow file is `Unprocessable` with `run-has-no-task`; with no provider connected the call is `UnsupportedCapability` (`generate`) with a `remediation` that says to connect one; a run the caller may not use is `NotFound`. It is not on MCP.',
  destructive: false,
  tags: ['Tasks'],
  inputSchema: explanationInput,
  outputSchema: generatedOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'Unprocessable', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { runId } = input;
    const run = await readableRun(host, principal, runId);
    if (run.kind !== 'agent') throw runHasNoTask();
    // Spending a model's tokens on a run is a write on it: its owner may, and so may a holder of
    // the write scope (who has read it, to get here).
    if (!(await mayAccessTask(host, principal, runId, 'bureau.tasks:write'))) {
      throw resourceNotFound('run', runId);
    }
    const read = await readRunFailure(host, run, runId, async () => false);
    if (read.outcome !== 'explained') throw runNotFailed();
    const steps = explanationRequestSteps({
      explanation: read.explanation,
      errorMessage: run.task.statusMessage,
      entries: await host.runTimeline(runId),
    });
    const request = modelExplanationRequest({ explanation: read.explanation, steps });
    const owner = ownerOfPrincipal(principal);
    let explanation;
    try {
      explanation = await generateModelExplanation(
        { decisions: host.decisions, catalog: host.catalog, now: host.modelExplanations.now },
        { request, taskId: runId, principal: owner },
      );
    } catch (error) {
      throw modelFault(error);
    }
    if (!(await host.modelExplanations.recordModelExplanation(runId, explanation))) {
      throw runNotFailed();
    }
    return { explanation };
  },
});
