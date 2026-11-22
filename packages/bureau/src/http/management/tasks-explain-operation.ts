import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

/**
 * `bureau.tasks.explain`: why one run failed, answered from what Bureau stored about it (COR-2532).
 *
 * The answer is a pure function of the run's stored facts: the task's failure record, the engine's
 * category and failed step, the engine's timeline for how many times the step was tried, and the
 * guardrails the audit trail holds for it. No model is called, so the same settled run answers the
 * same every time, on every surface. The sentence is built from identifiers (the category, the
 * error's code and kind, the step's label) and never from an error's message or a stack.
 *
 * A run is an agent run (a task) or an instance of a workflow file, read with the access
 * `bureau.runs.timeline` asks. A run that did not fail has nothing to explain and is a fault, not
 * an empty answer; a run that is still going is out of scope and is refused the same way.
 *
 * @module tasks-explain-operation
 */

import { defineOperation, type OperationFault } from '@lostgradient/backchannel';
import { z } from 'zod';

import { RUN_FAILURE_CATEGORIES, RUN_VERDICT_OUTCOMES } from '../../run-failure-explanation.ts';
import { readRunFailure, type RunFailureReads } from '../../run-failure-read.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';
import { readableRun, unsupported } from './runs-timeline-operation.ts';
import type { BureauTasksOperationHost } from './tasks-operations.ts';
import { type BureauWorkflowsOperationHost, retryableStepFor } from './workflows-operations.ts';

/**
 * What `bureau.tasks.explain` reads from the handler's `host`: the run's task and instance as the
 * other run operations read them, and what the engine and the audit trail hold of it
 * ({@link RunFailureReads}), read only after the caller has been let in to the run.
 */
export type BureauTasksExplainOperationHost = BureauTasksOperationHost &
  BureauWorkflowsOperationHost &
  RunFailureReads;

const explainInput = z.object({
  runId: z
    .string()
    .min(1)
    .max(256)
    .describe(
      'The identifier of the failed run: an agent run’s task id, or a workflow instance’s id.',
    ),
});

const stepSchema = z.object({
  index: z.number().int().min(0).describe('The step’s index in the run, from zero.'),
  label: z
    .string()
    .describe('The step’s label: a tool’s name, `model` for a model step, or the engine’s label.'),
});

const verdictSchema = z.object({
  name: z.string().describe('The guardrail’s name.'),
  kind: z
    .enum(['guardrail', 'tripwire'])
    .describe(
      '`tripwire` for a guardrail that halted the run, `guardrail` for one that let it go on.',
    ),
  outcome: z
    .enum(RUN_VERDICT_OUTCOMES)
    .describe(
      'What it did: `tripwire`, or for a validate-mode guardrail `block`, `warn`, `sanitize` or `redact`.',
    ),
  step: z.number().int().min(0).nullable().describe('The step it fired at, or `null`.'),
});

const explainOutput = z.object({
  summary: z.string().describe('One sentence naming the step the run failed at and the cause.'),
  cause: z.object({
    category: z
      .enum(RUN_FAILURE_CATEGORIES)
      .nullable()
      .describe('The failure’s category; `null` for a failure nothing classifies.'),
    code: z.string().nullable().describe('The error’s code, or `null`.'),
    kind: z.string().nullable().describe('The error’s kind, or `null`.'),
  }),
  step: stepSchema
    .nullable()
    .describe('The step the run failed at, or `null` when none was recorded.'),
  tries: z
    .number()
    .int()
    .min(1)
    .nullable()
    .describe('How many times the engine tried that step, or `null` when it kept no history.'),
  verdicts: z.array(verdictSchema).describe('Each guardrail that fired in the run.'),
  remediation: z.string().describe('What to do next, in one or two sentences.'),
  nextCommands: z
    .array(z.string())
    .describe(
      '`interborough` command lines for the run, each one a command the CLI has: `runs get` always, and `runs retry` for a failed workflow instance that `bureau.workflows.runs.retry` would run again for the caller.',
    ),
});

/** The fault for a run that did not fail: nothing to explain. */
function runNotFailed(): OperationFault {
  return {
    code: 'Unprocessable',
    message: 'This run has not failed, so there is no failure to explain',
    data: { reason: 'run-not-failed' },
    remediation:
      'Explain a run only after it has failed; read the run to see its status, and wait for a run that is still going to settle.',
  };
}

export const tasksExplainOperation = defineOperation<
  typeof explainInput,
  typeof explainOutput,
  BureauTasksExplainOperationHost
>({
  name: 'bureau.tasks.explain',
  authorize: authorizeWorkspaceOperation('bureau.tasks.explain'),
  mcpExposable: true,
  summary: 'Explain why a run failed',
  description:
    'Returns why one failed run failed, from what Bureau stored about it and nothing else: no model is called, so the same settled run answers the same every time. `runId` is an agent run’s task id or a workflow instance’s id. `summary` is one sentence naming the step and the cause, built from the failure category (`application`, `timeout`, `cancellation`, `resource`, `system`, or `null` when nothing classifies the failure: a workflow instance’s is the engine’s, an agent run’s is read from its finish reason and its error’s kind) and the error’s kind. `cause` is the category, the error’s `code` and its `kind` (an agent run’s; `null` for a workflow instance). `step` is the step the run failed at (its index and label), `tries` how many times the engine tried that step (`null` when its history records no failed attempt, as for an agent run that ended on a failed result), `verdicts` each guardrail that fired in the run (its `name`, whether it halted the run as a `tripwire` or let it go on as a `guardrail`, and its `outcome`; a workflow instance’s own steps included), `remediation` what to do next, and `nextCommands` `interborough` command lines for the run (`runs get`, and `runs retry` for a failed workflow instance `bureau.workflows.runs.retry` would run again for the caller). It carries no error message, stack, tool argument or flagged text. A run that did not fail, one that is still going included, is `Unprocessable` with `data.reason` `run-not-failed` and a `remediation`; a workflow instance whose run state or timeline the Bureau cannot read, because it has no durable engine, is `UnsupportedCapability` (`durable-engine`), never `run-not-failed`. An agent run is read with the access `bureau.tasks.get` asks and a workflow instance with the access `bureau.workflows.runs.get` asks; any other run, a run the caller may not read, and a run that does not exist are all `NotFound`.',
  destructive: false,
  tags: ['Tasks'],
  inputSchema: explainInput,
  outputSchema: explainOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'Unprocessable', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { runId } = input;
    const run = await readableRun(host, principal, runId);
    // Only an instance can run again, and only for a caller the retry would let in (COR-2533).
    const read = await readRunFailure(
      host,
      run,
      runId,
      async () => (await retryableStepFor(host, principal, runId)) !== undefined,
    );
    if (read.outcome === 'not-failed') throw runNotFailed();
    if (read.outcome === 'unsupported') throw unsupported();
    return read.explanation;
  },
});
