import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

/**
 * `bureau.runs.compare`: a forked workflow run beside the run it was forked from, step by step, for
 * a panel or an MCP client that shows what a fork changed.
 *
 * The durable engine aligns the two timelines (`engine.compare`), so every client reads the one
 * alignment Weft's `weft.workflows.compare` serves; this operation only decides who may read it. A
 * comparison reads two runs, so it asks what reading each of them asks: the fork is read as
 * `bureau.runs.timeline` reads a workflow instance (`bureau.workflows.runs.get`'s access), and the
 * source the same way, before the engine reads either timeline. A caller who may read the fork and
 * not its source cannot learn the source's steps or payloads through it: that is answered as a run
 * that does not exist, as every other run the caller may not read is. A run that does not exist, one
 * that is no instance of a workflow file, and one the caller may not read are all `NotFound`.
 *
 * A run the caller may read that is not a fork (an agent run, or an instance nobody forked) is
 * `Unprocessable`, and the message says what to do, so a panel that shows only the message is
 * enough.
 *
 * Each side of a step carries its input and output as the engine summarizes them, with payload fields
 * redacted as the timeline read redacts them. That is the same reach `bureau.workflows.runs.get`
 * already gives a reader of the run.
 *
 * @module runs-compare-operation
 */

import { defineOperation, type OperationFault, type Principal } from '@lostgradient/backchannel';
import type { ForkComparison } from '@lostgradient/weft';
import { z } from 'zod';

import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';
import { type BureauTasksOperationHost, mayAccessTask } from './tasks-operations.ts';
import { type BureauWorkflowsOperationHost, mayAccessWorkflows } from './workflows-operations.ts';

/** The most steps one page of a comparison holds, as the engine's own limit. */
const COMPARISON_PAGE_LIMIT = 1000;

/** What `bureau.runs.compare` reads from the handler's `host`. */
export type BureauRunsCompareOperationHost = BureauTasksOperationHost &
  BureauWorkflowsOperationHost & {
    /**
     * Where the run `runId` was forked from, read from the durable engine: `{ forkedFrom }` is the
     * source run's id, absent for a run that is not a fork, and the whole answer is `undefined` for a
     * Bureau with no durable engine. It is read only after the caller has been let in to the run.
     */
    readonly runForkSource: (
      runId: string,
    ) => Promise<{ readonly forkedFrom?: string | undefined } | undefined>;
    /**
     * The engine's comparison of the fork `runId` with its source, one page of it, or `undefined`
     * for a Bureau with no durable engine. It is read only after the caller has been let in to both
     * runs.
     */
    readonly runComparison: (
      runId: string,
      options: { readonly limit?: number | undefined; readonly cursor?: string | undefined },
    ) => Promise<ForkComparison | undefined>;
  };

const compareInput = z.object({
  runId: z
    .string()
    .min(1)
    .max(256)
    .describe('The identifier of the fork: a workflow instance’s id.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(COMPARISON_PAGE_LIMIT)
    .optional()
    .describe(`Steps in a page. Defaults to 100; at most ${String(COMPARISON_PAGE_LIMIT)}.`),
  cursor: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('The nextCursor of the previous page; omit it for the first page.'),
});

const timelineStatus = z.enum(['running', 'completed', 'failed', 'cancelled', 'timed-out']);

const comparedSide = z.object({
  operationType: z.string().describe('The kind of operation the step is, such as `activity`.'),
  label: z.string().describe('What the step is: an activity’s name, `sleep`, `await-signal`.'),
  status: timelineStatus,
  input: z.string().describe('The step’s input as the engine summarizes it, redacted: JSON text.'),
  output: z
    .string()
    .optional()
    .describe('The step’s output or error in the same form; absent while the step runs.'),
});

const compareOutput = z.object({
  runId: z.string().describe('The fork that was compared.'),
  sourceRunId: z.string().describe('The run the fork was made from.'),
  forkPoint: z.number().describe('The source checkpoint step the fork started from.'),
  steps: z.array(
    z.object({
      index: z.number().int().describe('The durable step index both sides share.'),
      shared: z
        .boolean()
        .describe('True before the fork point: the fork kept the source’s result, on both sides.'),
      source: comparedSide.optional().describe('The source run’s entry for the step.'),
      fork: comparedSide.optional().describe('The fork’s entry for the step.'),
    }),
  ),
  nextCursor: z
    .string()
    .optional()
    .describe('Pass as `cursor` for the next page; absent on the last.'),
});

function unsupported(): OperationFault {
  return {
    code: 'UnsupportedCapability',
    message: 'This Bureau has no durable engine, so its runs cannot be compared',
    data: { capability: 'durable-engine' },
  };
}

/** The fault the workflow operations answer for a Bureau with no workflow directory. */
function noWorkflowDirectory(): OperationFault {
  return {
    code: 'UnsupportedCapability',
    message: 'This Bureau has no workflow directory, so it has no workflows',
    data: { capability: 'workflow-directory' },
  };
}

/** A run that exists and cannot be compared, with what to do about it in the message itself. */
function notComparable(message: string, reason: string): OperationFault {
  return { code: 'Unprocessable', message, data: { reason } };
}

/**
 * Whether `principal` may read the workflow instance `runId` as `bureau.workflows.runs.get` reads
 * it: the workflows read, the run's owner, and the run being an instance of a workflow file.
 */
async function mayReadWorkflowRun(
  host: BureauRunsCompareOperationHost,
  principal: Principal,
  runId: string,
): Promise<boolean> {
  if (!mayAccessWorkflows(host, principal, 'bureau.workflows:read')) return false;
  if (
    principal.method !== 'unauthenticated' &&
    principal.workspace !== undefined &&
    !host.ownership.mayAccess({
      principal,
      resourceOwner: await host.ownership.runOwner(runId),
      operatorScope: 'bureau.workflows:read',
    })
  ) {
    return false;
  }
  if (host.workflows === undefined) throw noWorkflowDirectory();
  // `getRun` is the one reading of "an instance of a workflow file"; anything else is no run here.
  return (await host.workflows.getRun(runId)) !== undefined;
}

export const runsCompareOperation = defineOperation<
  typeof compareInput,
  typeof compareOutput,
  BureauRunsCompareOperationHost
>({
  name: 'bureau.runs.compare',
  authorize: authorizeWorkspaceOperation('bureau.runs.compare'),
  mcpExposable: true,
  summary: 'Compare a forked workflow run with its source, step by step',
  description: `Takes the id of a workflow run made by forking another and returns the run it was forked from (\`sourceRunId\`), the \`forkPoint\` (the source checkpoint step the fork started from) and the two runs aligned by durable step: each step's \`index\`, whether it is \`shared\` (before the fork point, so both sides are the source's entry) and, for \`source\` and \`fork\`, the \`operationType\`, \`label\`, \`status\`, \`input\` and \`output\` the engine summarizes, with payload fields redacted as the timeline read redacts them. A side is absent when that run has no entry for the step. Pages by step: \`limit\` (100 by default, at most ${String(COMPARISON_PAGE_LIMIT)}) and \`nextCursor\`. The fork and its source are each read with the access \`bureau.workflows.runs.get\` asks; a run the caller may not read, a source the caller may not read, a run that is no instance of a workflow file, and a run that does not exist are all \`NotFound\`. A run that is not a fork is \`Unprocessable\`, and its message says what to do.`,
  destructive: false,
  tags: ['Runs'],
  inputSchema: compareInput,
  outputSchema: compareOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'Unprocessable', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { runId } = input;
    // An id the task registry holds is an agent run; the caller who may read it is told it cannot be
    // compared, and one who may not read it is told what a missing run is told.
    if ((await host.tasks.get(runId)) !== undefined) {
      if (!(await mayAccessTask(host, principal, runId, 'bureau.tasks:read'))) {
        throw resourceNotFound('run', runId);
      }
      throw notComparable(
        `Run ${runId} is an agent run, and only a workflow run made by forking another can be compared with its source. Open a forked workflow run.`,
        'agent-run',
      );
    }
    if (!(await mayReadWorkflowRun(host, principal, runId))) throw resourceNotFound('run', runId);
    const lineage = await host.runForkSource(runId);
    if (lineage === undefined) throw unsupported();
    const sourceRunId = lineage.forkedFrom;
    if (sourceRunId === undefined) {
      throw notComparable(
        `Run ${runId} is not a fork, so there is no source to compare it with. Fork a run, then compare the fork.`,
        'not-a-fork',
      );
    }
    // The source is another run: a caller cleared for the fork reads it only if cleared for it, and
    // is told the same thing a run that does not exist is told, before the engine reads either.
    if (!(await mayReadWorkflowRun(host, principal, sourceRunId))) {
      throw resourceNotFound('run', runId);
    }
    const comparison = await host
      .runComparison(runId, { limit: input.limit, cursor: input.cursor })
      .catch((error: unknown) => {
        // A cursor this operation did not issue is the caller's input, not an engine failure.
        if (error instanceof Error && error.name === 'CompareWindowError') {
          const fault: OperationFault = {
            code: 'InvalidParams',
            message: error.message,
            data: { issues: [{ path: ['cursor'], message: error.message, code: 'custom' }] },
          };
          throw fault;
        }
        throw error;
      });
    if (comparison === undefined) throw unsupported();
    return {
      runId: comparison.workflowId,
      sourceRunId: comparison.sourceWorkflowId,
      forkPoint: comparison.forkPoint,
      steps: comparison.steps.map((step) => ({
        index: step.index,
        shared: step.shared,
        ...(step.source === undefined ? {} : { source: step.source }),
        ...(step.fork === undefined ? {} : { fork: step.fork }),
      })),
      ...(comparison.nextCursor === undefined ? {} : { nextCursor: comparison.nextCursor }),
    };
  },
});
