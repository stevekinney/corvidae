/**
 * `bureau.tasks.list`, `bureau.tasks.get`, and `bureau.tasks.cancel`: the task
 * lifecycle over the task registry (`task-registry.ts`).
 *
 * A task belongs to the principal that started it. A caller sees and cancels its
 * own tasks without any scope; `bureau.tasks:read` grants every owner's tasks to
 * `list` and `get`, and `bureau.tasks:write` grants `cancel`, and neither implies
 * the other. A task the caller may not see is answered exactly as a missing one.
 *
 * @module tasks-operations
 */

import { defineOperation, type OperationFault, type Principal } from '@lostgradient/weft';
import { z } from 'zod';

import { TaskListingTokenError } from '../../task-list-snapshots.ts';
import { TASK_ORIGIN_KINDS } from '../../task-origin.ts';
import type { TaskRegistry } from '../../task-registry.ts';
import type { BureauScope } from '../bureau-scopes.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  DEFAULT_PAGE_LIMIT,
  resourceNotFound,
  taskStateSchema,
  taskViewSchema,
  unaryTransports as transports,
  unknownKeyPolicy,
  waitMillisecondsField,
} from './management-schemas.ts';

/** What the task operations read from the handler's `host`. */
export type BureauTasksOperationHost = BureauOwnershipHost & {
  readonly tasks: Pick<TaskRegistry, 'list' | 'get' | 'cancel' | 'ownerOf'>;
};

/** Whether `principal` holds an operator scope (an unauthenticated principal holds none). */
export function holdsScope(principal: Principal, scope: BureauScope): boolean {
  return principal.method !== 'unauthenticated' && principal.hasScope(scope);
}

/**
 * Whether `principal` may act on the task `taskId` with `operatorScope`: it owns
 * it, or holds the scope. The owner is the one the task's record was written with,
 * which outlives the run store and a restart; a task with no record (an id that is
 * not a task at all, such as a workflow-file instance) has no owner, so only
 * the scope reaches it, and the operation then finds no task to act on.
 */
export async function mayAccessTask(
  host: BureauOwnershipHost & { readonly tasks: Pick<TaskRegistry, 'ownerOf'> },
  principal: Principal,
  taskId: string,
  operatorScope: BureauScope,
): Promise<boolean> {
  const resourceOwner = holdsScope(principal, operatorScope)
    ? undefined
    : await host.tasks.ownerOf(taskId);
  return host.ownership.mayAccess({ principal, resourceOwner, operatorScope });
}

const tasksListInput = z.object({
  contextId: z
    .string()
    .min(1)
    .optional()
    .describe('Only the tasks in this context’s current incarnation.'),
  agentName: z.string().min(1).optional().describe('Only the tasks run by this agent.'),
  status: taskStateSchema.optional().describe('Only the tasks in this state.'),
  origin: z
    .enum(TASK_ORIGIN_KINDS)
    .optional()
    .describe(
      'Only the tasks recorded with an origin of this kind. A task recorded before origins were kept has none and matches no kind.',
    ),
  parentRunId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Only the subordinate tasks of this run: the children an agent run started, the attempts of a goal run, or the steps of a workflow instance.',
    ),
  siblingsOf: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Only the tasks that share a parent run with this task, this task excluded. A task that does not exist, that is not yours to read, or that has no parent run matches nothing.',
    ),
  statusTimestampAfter: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      'Only tasks whose status timestamp is strictly after this instant, as an ISO 8601 date-time with an offset.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('The most tasks to return in one page, from 1 to 100. Defaults to 50.'),
  pageToken: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The `nextPageToken` of the previous page, to continue that listing. An opaque token, valid for 15 minutes from the first page and only with the filters it was issued for.',
    ),
});
const tasksListOutput = z.object({
  tasks: z.array(taskViewSchema),
  nextPageToken: z.string().nullable(),
});

/** The identity a listing's snapshot belongs to: the owner key, or the credential's own subject. */
function listingPrincipalOf(principal: Principal): string {
  const owner = ownerOfPrincipal(principal);
  if (owner !== undefined) return owner;
  return `${principal.method}:${'subject' in principal ? (principal.subject ?? '') : ''}`;
}

export const tasksListOperation = defineOperation<
  typeof tasksListInput,
  typeof tasksListOutput,
  BureauTasksOperationHost
>({
  name: 'bureau.tasks.list',
  mcpExposable: true,
  summary: 'List tasks',
  description:
    'Lists the caller’s own tasks, most recently changed first (by status timestamp, then task id ascending); a caller holding `bureau.tasks:read` lists every owner’s. `contextId` returns only that context’s tasks in its current incarnation, `origin` only the tasks recorded with an origin of that kind (`chat`, `person`, `schedule`, `api`, `agent`, `goal`, or `parent`), `parentRunId` only the subordinate tasks of that run (the children it started, the attempts of a goal, the steps of a workflow instance), `siblingsOf` only the tasks that share a parent run with the named task, that task excluded, and `statusTimestampAfter` (ISO 8601) only tasks whose status timestamp is strictly later. Pages with `limit` (1 to 100, default 50, free to change between pages) and `pageToken`; `nextPageToken` is `null` when no entries remain. The first page of a listing with a next page records the listing, and every later page returns the tasks exactly as they matched then, so a task that changes mid-enumeration keeps its place and appears once; a task removed since is skipped, so a page can hold fewer than `limit` tasks. A token is opaque, valid for 15 minutes from the first page, and only with the principal, reach, wire projection (never the one of A2A `ListTasks`), and filters (`contextId`, `agentName`, `status`, `origin`, `parentRunId`, `siblingsOf`, `statusTimestampAfter`) it was issued for, and only while the context is the incarnation it was issued for; any other token is `InvalidParams`. A principal holds at most 16 live listings, and starting another ends its oldest.',
  destructive: false,
  tags: ['Tasks'],
  inputSchema: tasksListInput,
  outputSchema: tasksListOutput,
  producibleFaults: ['InvalidParams'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const everyOwner = holdsScope(principal, 'bureau.tasks:read');
    const owner = everyOwner ? undefined : ownerOfPrincipal(principal);
    // A principal that can own nothing owns no task.
    if (!everyOwner && owner === undefined) return { tasks: [], nextPageToken: null };
    try {
      const page = await host.tasks.list({
        principal: listingPrincipalOf(principal),
        ...(owner === undefined ? {} : { owner }),
        ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
        ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.origin === undefined ? {} : { origin: input.origin }),
        ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
        ...(input.siblingsOf === undefined ? {} : { siblingsOf: input.siblingsOf }),
        ...(input.statusTimestampAfter === undefined
          ? {}
          : { statusTimestampAfter: input.statusTimestampAfter }),
        ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
        limit: input.limit ?? DEFAULT_PAGE_LIMIT,
      });
      return {
        tasks: page.tasks.map((task) => ({ ...task, openWaits: [...task.openWaits] })),
        nextPageToken: page.nextPageToken,
      };
    } catch (error) {
      if (!(error instanceof TaskListingTokenError)) throw error;
      throw {
        code: 'InvalidParams',
        message: error.message,
        data: {
          issues: [
            { path: ['pageToken'], message: error.message, code: `page-token-${error.reason}` },
          ],
        },
      } satisfies OperationFault;
    }
  },
});

const tasksGetInput = z.object({
  taskId: z.string().min(1).describe('The identifier of the task to read.'),
});

export const tasksGetOperation = defineOperation<
  typeof tasksGetInput,
  typeof taskViewSchema,
  BureauTasksOperationHost
>({
  name: 'bureau.tasks.get',
  mcpExposable: true,
  summary: 'Read one task',
  description:
    'Returns one of the caller’s own tasks; a caller holding `bureau.tasks:read` reads any owner’s. Another owner’s task answers as a missing one does.',
  destructive: false,
  tags: ['Tasks'],
  inputSchema: tasksGetInput,
  outputSchema: taskViewSchema,
  producibleFaults: ['InvalidParams', 'NotFound'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    if (!(await mayAccessTask(host, principal, input.taskId, 'bureau.tasks:read'))) {
      throw resourceNotFound('task', input.taskId);
    }
    const task = await host.tasks.get(input.taskId);
    if (task === undefined) throw resourceNotFound('task', input.taskId);
    return { ...task, openWaits: [...task.openWaits] };
  },
});

export const taskCancelReceiptSchema = z.enum([
  'cancel-requested',
  'canceled',
  'cleanup-pending',
  'cleaned-up',
  'cleanup-failed',
  'cleanup-unresolved',
  'unknown-outcome',
  'rejected',
]);

const tasksCancelInput = z.object({
  taskId: z.string().min(1).describe('The identifier of the task to cancel.'),
  waitMilliseconds: waitMillisecondsField,
});
const tasksCancelOutput = z.object({
  taskId: z.string(),
  receipt: taskCancelReceiptSchema,
  reason: z.enum(['already-terminal', 'owned-by-goal', 'owned-by-workflow']).optional(),
  /**
   * The task as it stands. Present only for a caller that may read it (its owner, or
   * `bureau.tasks:read`): a caller that can only write is given the receipt and nothing else.
   */
  task: taskViewSchema.optional(),
});

export const tasksCancelOperation = defineOperation<
  typeof tasksCancelInput,
  typeof tasksCancelOutput,
  BureauTasksOperationHost
>({
  name: 'bureau.tasks.cancel',
  mcpExposable: true,
  summary: 'Cancel a task',
  description:
    'Cancels one of the caller’s own tasks; a caller holding `bureau.tasks:write` cancels any owner’s. The receipt says where the cancellation stands: `cancel-requested` (the run has not stopped), `canceled` (a durable run stopped with no cleanup evidence to report), `cleanup-pending`, `cleaned-up`, `cleanup-failed`, `cleanup-unresolved` (cleanup could not be confirmed and may still be running, so nothing is promised about external effects), `unknown-outcome` (an external effect may or may not have happened), or `rejected` (nothing is applied). A rejection carries a `reason`: `already-terminal` (the task had already finished without being canceled), `owned-by-goal` (the task is one attempt of a goal, which only cancelling the goal stops) or `owned-by-workflow` (the task is a step of a workflow instance, which is not cancelled on its own). Cancelling the task of a child run stops the child as `bureau.children.cancel` does. `waitMilliseconds` (default 0) waits that long for the cleanup acknowledgement; `bureau.tasks.get` carries the same state afterwards. A repeated cancel has the same effect.',
  destructive: true,
  tags: ['Tasks'],
  inputSchema: tasksCancelInput,
  outputSchema: tasksCancelOutput,
  producibleFaults: ['InvalidParams', 'NotFound'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    if (!(await mayAccessTask(host, principal, input.taskId, 'bureau.tasks:write'))) {
      throw resourceNotFound('task', input.taskId);
    }
    const outcome = await host.tasks.cancel(input.taskId, input.waitMilliseconds ?? 0);
    if (outcome === undefined) throw resourceNotFound('task', input.taskId);
    const receipt = {
      taskId: input.taskId,
      receipt: outcome.receipt,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    };
    // The write scope does not imply the read scope: the task view goes only to a caller that
    // could read it.
    if (!(await mayAccessTask(host, principal, input.taskId, 'bureau.tasks:read'))) return receipt;
    const task = await host.tasks.get(input.taskId);
    if (task === undefined) throw resourceNotFound('task', input.taskId);
    return { ...receipt, task: { ...task, openWaits: [...task.openWaits] } };
  },
});
