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

import { defineOperation, type Principal } from '@lostgradient/weft';
import { z } from 'zod';

import type { TaskRegistry } from '../../task-registry.ts';
import type { BureauScope } from '../bureau-scopes.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  DEFAULT_PAGE_LIMIT,
  pageFields,
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
 * not a task at all, such as a schedule fire or a child run) has no owner, so only
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
  contextId: z.string().min(1).optional(),
  agentName: z.string().min(1).optional(),
  status: taskStateSchema.optional(),
  ...pageFields,
});
const tasksListOutput = z.object({
  tasks: z.array(taskViewSchema),
  nextOffset: z.number().int().nullable(),
});

export const tasksListOperation = defineOperation<
  typeof tasksListInput,
  typeof tasksListOutput,
  BureauTasksOperationHost
>({
  name: 'bureau.tasks.list',
  mcpExposable: false,
  summary: 'List tasks',
  description:
    'Lists the caller’s own tasks, newest first; a caller holding `bureau.tasks:read` lists every owner’s. `contextId` returns only that context’s tasks in its current incarnation. Pages with `limit` (1 to 100, default 50) and `offset`; `nextOffset` is `null` on the last page.',
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
    if (!everyOwner && owner === undefined) return { tasks: [], nextOffset: null };
    const page = await host.tasks.list({
      ...(owner === undefined ? {} : { owner }),
      ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
      ...(input.agentName === undefined ? {} : { agentName: input.agentName }),
      ...(input.status === undefined ? {} : { status: input.status }),
      limit: input.limit ?? DEFAULT_PAGE_LIMIT,
      offset: input.offset ?? 0,
    });
    return {
      tasks: page.tasks.map((task) => ({ ...task, openWaits: [...task.openWaits] })),
      nextOffset: page.nextOffset,
    };
  },
});

const tasksGetInput = z.object({ taskId: z.string().min(1) });

export const tasksGetOperation = defineOperation<
  typeof tasksGetInput,
  typeof taskViewSchema,
  BureauTasksOperationHost
>({
  name: 'bureau.tasks.get',
  mcpExposable: false,
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
  taskId: z.string().min(1),
  waitMilliseconds: waitMillisecondsField,
});
const tasksCancelOutput = z.object({
  taskId: z.string(),
  receipt: taskCancelReceiptSchema,
  reason: z.literal('already-terminal').optional(),
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
  mcpExposable: false,
  summary: 'Cancel a task',
  description:
    'Cancels one of the caller’s own tasks; a caller holding `bureau.tasks:write` cancels any owner’s. The receipt says where the cancellation stands: `cancel-requested` (the run has not stopped), `canceled` (a durable run stopped with no cleanup evidence to report), `cleanup-pending`, `cleaned-up`, `cleanup-failed`, `cleanup-unresolved` (cleanup could not be confirmed and may still be running, so nothing is promised about external effects), `unknown-outcome` (an external effect may or may not have happened), or `rejected` (the task had already finished without being canceled; nothing is applied). `waitMilliseconds` (default 0) waits that long for the cleanup acknowledgement; `bureau.tasks.get` carries the same state afterwards. A repeated cancel has the same effect.',
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
