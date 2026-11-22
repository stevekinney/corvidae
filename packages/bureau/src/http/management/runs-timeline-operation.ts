import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

/**
 * `bureau.runs.timeline`: the steps of one run, laid out in time, for a panel or an MCP client that
 * draws a waterfall.
 *
 * A run is an agent run (a task) or an instance of a workflow file; each has one durable timeline in
 * the engine, and this reads it. It is a read of the run, so it asks what reading the run asks: an
 * agent run is read as `bureau.tasks.get` reads it (the caller's own, or any owner's with
 * `bureau.tasks:read`), and a workflow instance as `bureau.workflows.runs.get` reads it. A run the
 * caller may not read, a run that is neither kind (a schedule tick, another plugin's workflow), and a
 * run that does not exist are answered alike with `NotFound`, and the engine is not read until the
 * caller has been let in.
 *
 * Each entry carries a step's label, status, start, duration and tries, and nothing it took in or
 * gave back: the engine's input and output summaries never leave it (`run-timeline.ts`).
 *
 * @module runs-timeline-operation
 */

import type { WorkflowTimelineEntry } from '@lostgradient/weft';
import { defineOperation, type OperationFault, type Principal } from '@lostgradient/backchannel';
import { z } from 'zod';

import { projectRunTimeline, RUN_TIMELINE_ENTRY_LIMIT } from '../../run-timeline.ts';
import type { TaskView } from '../../task-registry.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';
import { type BureauTasksOperationHost, mayAccessTask } from './tasks-operations.ts';
import { type BureauWorkflowsOperationHost, mayAccessWorkflows } from './workflows-operations.ts';

/** What `bureau.runs.timeline` reads from the handler's `host`. */
export type BureauRunsTimelineOperationHost = BureauTasksOperationHost &
  BureauWorkflowsOperationHost & {
    /**
     * The engine's timeline of the run `runId`, or `undefined` for a Bureau with no durable engine.
     * It is read only after the caller has been let in to the run.
     */
    readonly runTimeline: (runId: string) => Promise<readonly WorkflowTimelineEntry[] | undefined>;
  };

const timelineInput = z.object({
  runId: z
    .string()
    .min(1)
    .max(256)
    .describe('The identifier of the run: an agent run’s task id, or a workflow instance’s id.'),
});

const timelineEntrySchema = z.object({
  step: z.number().int().describe('The step’s number; the run’s steps are in this order.'),
  label: z.string().describe('What the step is: an activity’s name, `sleep`, `await-signal`.'),
  operationType: z.string().describe('The kind of operation the step is.'),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'timed-out']),
  timestamp: z.number().describe('When the step started, in epoch milliseconds.'),
  duration: z
    .number()
    .optional()
    .describe('How long the step ran, in milliseconds; absent while it runs.'),
  tries: z
    .number()
    .int()
    .min(1)
    .describe(
      'How many times the engine tried this step, counting this attempt: the number of entries the run holds for the same step, since the engine writes one entry per attempt.',
    ),
});

const timelineOutput = z.object({
  runId: z.string(),
  kind: z.enum(['agent', 'workflow']).describe('Which kind of run the id named.'),
  entries: z.array(timelineEntrySchema),
  truncated: z
    .boolean()
    .describe(`True when the run has more than ${String(RUN_TIMELINE_ENTRY_LIMIT)} entries.`),
});

function unsupported(): OperationFault {
  return {
    code: 'UnsupportedCapability',
    message: 'This Bureau has no durable engine, so its runs have no timeline',
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

/** A run the caller may read: an agent run with its task, or an instance of a workflow file. */
export type ReadableRun =
  { readonly kind: 'agent'; readonly task: TaskView } | { readonly kind: 'workflow' };

/**
 * The run `runId` names, once the caller is let in to it: an agent run is read as
 * `bureau.tasks.get` reads it, and a workflow instance as `bureau.workflows.runs.get` reads it.
 * A run the caller may not read, a run that is neither kind and one that does not exist are all
 * `NotFound`, so the engine is read for nobody this refused. Shared by the operations that read
 * one run by either kind of id.
 */
export async function readableRun(
  host: BureauTasksOperationHost & BureauWorkflowsOperationHost,
  principal: Principal,
  runId: string,
): Promise<ReadableRun> {
  // An agent run is a task with a record; an id the registry holds is read as a task, and the
  // caller who may not read it is not then offered the workflow reading of the same id.
  const task = await host.tasks.get(runId);
  if (task !== undefined) {
    if (!(await mayAccessTask(host, principal, runId, 'bureau.tasks:read'))) {
      throw resourceNotFound('run', runId);
    }
    return { kind: 'agent', task };
  }
  if (!mayAccessWorkflows(host, principal, 'bureau.workflows:read')) {
    throw resourceNotFound('run', runId);
  }
  if (
    principal.method !== 'unauthenticated' &&
    principal.workspace !== undefined &&
    !host.ownership.mayAccess({
      principal,
      resourceOwner: await host.ownership.runOwner(runId),
      operatorScope: 'bureau.workflows:read',
    })
  ) {
    throw resourceNotFound('run', runId);
  }
  if (host.workflows === undefined) throw noWorkflowDirectory();
  // `getRun` is the one reading of "an instance of a workflow file"; anything else is no run here.
  if ((await host.workflows.getRun(runId)) === undefined) {
    throw resourceNotFound('run', runId);
  }
  return { kind: 'workflow' };
}

export const runsTimelineOperation = defineOperation<
  typeof timelineInput,
  typeof timelineOutput,
  BureauRunsTimelineOperationHost
>({
  name: 'bureau.runs.timeline',
  authorize: authorizeWorkspaceOperation('bureau.runs.timeline'),
  mcpExposable: true,
  summary: 'Read the step timeline of a run',
  description: `Returns the steps of one run in the order it took them, for drawing a waterfall: each entry’s \`label\`, \`operationType\`, \`status\`, \`timestamp\` (its start, in epoch milliseconds), \`duration\` (milliseconds, absent while it runs) and \`tries\` (how many attempts the engine made at the step, this one included). \`runId\` is an agent run’s task id or a workflow instance’s id, and \`kind\` says which. No step’s input or output is returned, only names and timings. An agent run is read with the access \`bureau.tasks.get\` asks and a workflow instance with the access \`bureau.workflows.runs.get\` asks; any other run, a run the caller may not read, and a run that does not exist are all \`NotFound\`. A run of more than ${String(RUN_TIMELINE_ENTRY_LIMIT)} entries is cut and \`truncated\` is true.`,
  destructive: false,
  tags: ['Runs'],
  inputSchema: timelineInput,
  outputSchema: timelineOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const { runId } = input;
    const { kind } = await readableRun(host, principal, runId);
    const entries = await host.runTimeline(runId);
    if (entries === undefined) throw unsupported();
    const timeline = projectRunTimeline(entries);
    return { runId, kind, entries: [...timeline.entries], truncated: timeline.truncated };
  },
});
