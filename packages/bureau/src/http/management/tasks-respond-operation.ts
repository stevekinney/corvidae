/**
 * `bureau.tasks.respond`: answer a task's open human-input or approval wait, over the wire.
 *
 * The operation parses the A2A-continuation-shaped input, decides which tier the caller answers
 * at, and delegates to {@link BureauTasks.respond}, which holds the command ledger, the commands in
 * flight, and every rule about which wait is answered (see `tasks/respond-to-task.ts`).
 *
 * ## Who may answer
 *
 * The task's owner answers anything. A caller that only holds `bureau.tasks:write` answers
 * human-input waits only (the in-process `operator` tier); a non-owner's approval decision is
 * answered exactly as a missing task, so approving a tool stays with the owner and with
 * `bureau.reviews.resolve`'s operator scope. A credential that names no owner (neither an API key
 * nor the local caller) is `Forbidden` once the task is found, since nothing could record who
 * answered.
 *
 * An exact retry inside the ledger's retention window returns its receipt before anything else is
 * checked, even after the task itself has been removed by task retention.
 *
 * @module tasks-respond-operation
 */

import { defineOperation, type OperationFault, type Principal } from '@lostgradient/weft';
import { z } from 'zod';

import { BureauError, TaskRespondError } from '../../create-bureau.ts';
import { type TasksRespondInput, tasksRespondInput } from '../../tasks/respond-to-task.ts';
import type { TaskRegistry } from '../../task-registry.ts';
import type { BureauTasks, TaskRespondResult } from '../../types.ts';
import { reviewFault, reviewReceiptSchema } from '../bureau-reviews-operations.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';
import { holdsScope, mayAccessTask } from './tasks-operations.ts';

const tasksRespondOutput = z.object({
  taskId: z.string(),
  messageId: z.string(),
  reviewId: z.string(),
  kind: z.enum(['tool-approval', 'human-wait']),
  decision: z.enum(['approve', 'deny', 'reject']),
  receipt: reviewReceiptSchema,
  /** `tool-approval` reject only: the reason, for the next run to splice in. */
  feedback: z.string().optional(),
});

/** What the operation reads from the handler's `host`. */
export type BureauTasksRespondOperationHost = BureauOwnershipHost & {
  /** The registry a credential that names no owner is checked against before it is refused. */
  readonly tasks: Pick<TaskRegistry, 'get' | 'ownerOf'>;
  /** {@link BureauTasks.respond}, which answers every caller that names an owner. */
  readonly respond: BureauTasks['respond'];
};

/**
 * The wire fault of a refusal of {@link BureauTasks.respond}: a missing task as `NotFound`, a
 * `BAD_REQUEST` about a field as `InvalidParams` on that path, one about what the wait accepts as
 * `Unprocessable` with its reason, and the rest as `bureau.reviews.resolve` answers them.
 */
function respondFault(error: unknown, taskId: string): unknown {
  if (!(error instanceof BureauError)) return error;
  if (error.code === 'NOT_FOUND') return resourceNotFound('task', taskId);
  if (error instanceof TaskRespondError && error.field !== undefined) {
    return {
      code: 'InvalidParams',
      message: error.message,
      data: { issues: [{ path: [error.field], message: error.message, code: 'custom' }] },
    } satisfies OperationFault;
  }
  if (error instanceof TaskRespondError && error.reason !== undefined) {
    return {
      code: 'Unprocessable',
      message: error.message,
      data: { reason: error.reason },
    } satisfies OperationFault;
  }
  return reviewFault(error, taskId);
}

/**
 * Answers one open wait of a task as `principal`: the body of `bureau.tasks.respond`, which an
 * A2A continuation of an `INPUT_REQUIRED` task reaches too. A refusal is thrown as the
 * operation's fault.
 */
export async function respondToTask(
  host: BureauTasksRespondOperationHost,
  principal: Principal,
  input: TasksRespondInput,
): Promise<TaskRespondResult> {
  const caller = ownerOfPrincipal(principal);
  if (caller === undefined) {
    // No receipt can be this caller's, and nothing could record it as the resolver: a task it may
    // not see is missing, as for anyone, and one it may see is refused for the credential.
    if (!(await mayAccessTask(host, principal, input.taskId, 'bureau.tasks:write'))) {
      throw resourceNotFound('task', input.taskId);
    }
    if ((await host.tasks.get(input.taskId)) === undefined) {
      throw resourceNotFound('task', input.taskId);
    }
    throw {
      code: 'Forbidden',
      message: 'Answering a task requires an API-key or local caller',
      data: { reason: 'unsupported credential' },
    } satisfies OperationFault;
  }
  try {
    return await host.respond({
      ...input,
      principal: caller,
      operator: holdsScope(principal, 'bureau.tasks:write'),
    });
  } catch (error) {
    throw respondFault(error, input.taskId);
  }
}

export const tasksRespondOperation = defineOperation<
  typeof tasksRespondInput,
  typeof tasksRespondOutput,
  BureauTasksRespondOperationHost
>({
  name: 'bureau.tasks.respond',
  mcpExposable: true,
  summary: 'Answer a task’s open human-input or approval wait',
  description:
    'Answers one open wait of a task as the authenticated caller. `answer` (text, or a list of parts joined with a newline) answers a human-input wait; `decision` (`approve`, `deny`, or `reject`, which requires a `reason`) decides an approval or a human wait. `signalName` or `callId` says which wait when several are open; with neither, exactly one must be. `messageId` is the idempotency key: an exact retry returns the original receipt, and the same `messageId` with a different command is a `Conflict`. The task’s owner answers anything; a caller holding `bureau.tasks:write` answers human-input waits only, and another owner’s approval answers as a missing task. The `receipt` is `applied` or `superseded` (the approval was gated again and the tool did not run).',
  destructive: true,
  tags: ['Tasks'],
  inputSchema: tasksRespondInput,
  outputSchema: tasksRespondOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'Conflict', 'Forbidden', 'Unprocessable'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: ({ input, host, principal }) => respondToTask(host, principal, input),
});
