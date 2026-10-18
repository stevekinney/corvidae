/**
 * `bureau.tasks.respond`: answer a task's open human-input or approval wait.
 *
 * The input is an A2A continuation's: answer text, an optional `signalName` or
 * `callId` that says which wait, or an approval `decision`, plus a caller-supplied
 * `messageId` that makes the command idempotent. It answers through the Bureau's
 * public `resolveReview` and never reaches into a session, so whatever identity a
 * review has (a session run's, a catalog run's) works through it unchanged.
 *
 * ## Who may answer
 *
 * The task's owner answers anything. A caller that only holds `bureau.tasks:write`
 * answers human-input waits only; a non-owner's approval decision is answered
 * exactly as a missing task, so approving a tool stays with the owner and with
 * `bureau.reviews.resolve`'s operator scope.
 *
 * ## Idempotency
 *
 * The command ledger keys an entry on the caller, the task, the `messageId`, and
 * this operation's version, with a digest of what the command decides. An exact
 * retry returns the original receipt without resolving anything again; the same
 * `messageId` with a different intent is a `Conflict`. A claim whose resolution was
 * cut short is finished by the retry: if the review is already resolved the way the
 * claim intended it completes as applied, and if it is still pending the retry
 * resolves it.
 *
 * @module tasks-respond-operation
 */

import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

import {
  BureauLedgerConflictError,
  type CommandLedger,
  type CommandLedgerIdentity,
  digestCommandPayload,
} from '../../command-ledger.ts';
import { BureauError } from '../../create-bureau.ts';
import type { TaskRegistry, TaskView } from '../../task-registry.ts';
import type { Bureau } from '../../types.ts';
import { receiptFor, reviewFault, reviewReceiptSchema } from '../bureau-reviews-operations.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';
import { mayAccessTask } from './tasks-operations.ts';

/** The version of this command's contract, part of every ledger identity. */
export const TASKS_RESPOND_OPERATION_VERSION = 'bureau.tasks.respond.v1';

/** The key prefix of this command's ledger, disjoint from run creation's. */
export const TASKS_RESPOND_LEDGER_KEY_PREFIX = 'command-ledger:tasks-respond:v1';

const tasksRespondInput = z
  .object({
    taskId: z.string().min(1),
    /** The caller's idempotency key for this command. */
    messageId: z.string().min(1).max(200),
    /** Answer text; a list of parts is joined with a newline. */
    answer: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    decision: z.enum(['approve', 'deny', 'reject']).optional(),
    /** Required, and non-blank, for `reject`. */
    reason: z.string().optional(),
    /** Addresses the human wait with this signal. */
    signalName: z.string().min(1).optional(),
    /** Addresses the tool approval for this call. */
    callId: z.string().min(1).optional(),
  })
  .refine((input) => (input.answer === undefined) !== (input.decision === undefined), {
    message: 'Send exactly one of `answer` and `decision`',
    path: ['answer'],
  })
  .refine((input) => input.decision !== 'reject' || (input.reason ?? '').trim() !== '', {
    message: 'reject requires a reason',
    path: ['reason'],
  })
  .refine((input) => input.signalName === undefined || input.callId === undefined, {
    message: 'Name a `signalName` or a `callId`, not both',
    path: ['callId'],
  })
  .refine((input) => input.callId === undefined || input.decision !== undefined, {
    message: '`callId` addresses a tool approval, which only a `decision` answers',
    path: ['callId'],
  });

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

export type TasksRespondResult = z.infer<typeof tasksRespondOutput>;

/** What a ledger entry of this command claims: the review it targets. */
export type TasksRespondClaim = { readonly reviewId: string };

/** The ledger this command records its receipts in. */
export type TasksRespondLedger = CommandLedger<TasksRespondClaim, TasksRespondResult>;

/** What the operation reads from the handler's `host`. */
export type BureauTasksRespondOperationHost = BureauOwnershipHost & {
  readonly tasks: Pick<TaskRegistry, 'get' | 'ownerOf'>;
  readonly reviews: Pick<Bureau, 'getReview' | 'resolveReview'>;
  readonly respondLedger: TasksRespondLedger;
  /** Commands in flight in this process, so two identical ones do not race one review. */
  readonly respondInFlight: Map<string, Promise<TasksRespondResult>>;
};

const EXPECTED_STATUS = { approve: 'approved', deny: 'denied', reject: 'rejected' } as const;

function conflict(reason: string): OperationFault {
  return { code: 'Conflict', message: reason, data: { reason } };
}

function invalid(path: string, message: string): OperationFault {
  return {
    code: 'InvalidParams',
    message,
    data: { issues: [{ path: [path], message, code: 'custom' }] },
  };
}

type OpenWait = TaskView['openWaits'][number];

/**
 * The wait this command addresses, or the fault that says why none is. A caller
 * that is not the owner is offered the human-input waits only.
 */
function selectWait(
  task: TaskView,
  input: z.infer<typeof tasksRespondInput>,
  isOwner: boolean,
): OpenWait {
  const offered = isOwner
    ? task.openWaits
    : task.openWaits.filter((wait) => wait.kind === 'human-wait');
  if (offered.length === 0) {
    // A non-owner is never told an approval is open: for it the task has nothing to answer.
    if (!isOwner && task.openWaits.length > 0) throw resourceNotFound('task', task.id);
    throw conflict('The task is not awaiting input');
  }
  let matches: readonly OpenWait[] = offered;
  if (input.signalName !== undefined) {
    matches = offered.filter(
      (wait) => wait.kind === 'human-wait' && wait.signalName === input.signalName,
    );
  } else if (input.callId !== undefined) {
    matches = offered.filter(
      (wait) => wait.kind === 'tool-approval' && wait.callId === input.callId,
    );
  }
  const [only, ...rest] = matches;
  if (only === undefined) {
    if (!isOwner && input.callId !== undefined) throw resourceNotFound('task', task.id);
    throw conflict(
      input.signalName !== undefined
        ? `The task has no open wait for signal "${input.signalName}"`
        : input.callId !== undefined
          ? `The task has no open approval for call "${input.callId}"`
          : 'The task is not awaiting input',
    );
  }
  if (rest.length > 0) {
    throw invalid(
      'signalName',
      'The task has several open waits; name the one to answer with `signalName` or `callId`',
    );
  }
  if (input.answer !== undefined && only.kind !== 'human-wait') {
    throw {
      code: 'Unprocessable',
      message: 'An answer addresses a human wait; a tool approval takes a `decision`',
      data: { reason: 'answer addressed to a tool approval' },
    } satisfies OperationFault;
  }
  return only;
}

export const tasksRespondOperation = defineOperation<
  typeof tasksRespondInput,
  typeof tasksRespondOutput,
  BureauTasksRespondOperationHost
>({
  name: 'bureau.tasks.respond',
  mcpExposable: false,
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
  invoke: async ({ input, host, principal }) => {
    if (!(await mayAccessTask(host, principal, input.taskId, 'bureau.tasks:write'))) {
      throw resourceNotFound('task', input.taskId);
    }
    const task = await host.tasks.get(input.taskId);
    if (task === undefined) throw resourceNotFound('task', input.taskId);
    const actor = ownerOfPrincipal(principal);
    if (actor === undefined) {
      throw {
        code: 'Forbidden',
        message: 'Answering a task requires an API-key or local caller',
        data: { reason: 'unsupported credential' },
      } satisfies OperationFault;
    }
    const isOwner = task.owner === actor;
    const answerText =
      input.answer === undefined
        ? undefined
        : Array.isArray(input.answer)
          ? input.answer.join('\n')
          : input.answer;
    const decision = input.decision ?? 'approve';
    const identity: CommandLedgerIdentity = {
      callerId: actor,
      target: input.taskId,
      requestId: input.messageId,
      operationVersion: TASKS_RESPOND_OPERATION_VERSION,
    };
    const digest = digestCommandPayload({
      answer: answerText,
      decision: input.decision,
      reason: input.reason,
      signalName: input.signalName,
      callId: input.callId,
    });

    const flightKey = `${actor}\u0000${input.taskId}\u0000${input.messageId}\u0000${digest}`;
    const running = host.respondInFlight.get(flightKey);
    if (running !== undefined) return running;

    const respond = async (): Promise<TasksRespondResult> => {
      // The wait is chosen first, so a command that addresses nothing claims nothing.
      // A retry of a command that has since been answered finds no open wait, so the
      // ledger is consulted before that is held against it.
      let wait: OpenWait | undefined;
      let notAwaiting: unknown;
      try {
        wait = selectWait(task, input, isOwner);
      } catch (error) {
        notAwaiting = error;
      }
      let claimed;
      try {
        claimed = await host.respondLedger.claim(identity, digest, {
          reviewId: wait?.reviewId ?? '',
        });
      } catch (error) {
        if (error instanceof BureauLedgerConflictError) {
          throw conflict(
            `Message "${input.messageId}" was already used for a different command on this task`,
          );
        }
        throw error;
      }
      if (claimed.outcome === 'existing' && claimed.entry.state === 'completed') {
        return claimed.entry.result;
      }
      const entry = claimed.entry as Parameters<TasksRespondLedger['release']>[0];
      // An earlier attempt that was cut short names the review it meant to resolve.
      const reviewId =
        claimed.outcome === 'existing' && entry.claim.reviewId !== ''
          ? entry.claim.reviewId
          : (wait?.reviewId ?? '');
      // Only a claim this invocation made is this invocation's to release. A pending claim
      // another attempt made belongs to it: that attempt may be resolving the review right
      // now, possibly in another process, and deleting its claim would lose its receipt.
      const ownClaim = claimed.outcome === 'claimed';
      const refuse = async (fault: unknown): Promise<never> => {
        // The Bureau refused it before changing anything, so a retry may claim afresh.
        if (ownClaim) await host.respondLedger.release(entry);
        throw fault;
      };
      // Nothing was addressed and nothing was applied: leave no claim of ours behind.
      if (reviewId === '') return refuse(notAwaiting ?? conflict('The task is not awaiting input'));
      let result: TasksRespondResult;
      try {
        const review = await host.reviews.getReview(reviewId);
        if (review === undefined) return await refuse(resourceNotFound('task', input.taskId));
        if (review.status === EXPECTED_STATUS[decision] && review.resolvedBy === actor) {
          // The earlier attempt of this caller resolved it before it could record its receipt.
          result = {
            taskId: input.taskId,
            messageId: input.messageId,
            reviewId,
            kind: review.kind,
            decision,
            receipt: 'applied',
          };
        } else if (review.status !== 'pending') {
          return await refuse(conflict('The review was already resolved'));
        } else {
          const resolved = await host.reviews.resolveReview({
            id: reviewId,
            decision,
            principal: actor,
            ...(answerText === undefined ? {} : { payload: answerText }),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          });
          result = {
            taskId: input.taskId,
            messageId: input.messageId,
            reviewId,
            kind: resolved.kind,
            decision: resolved.decision,
            receipt: receiptFor(resolved.result),
            ...(resolved.feedback === undefined ? {} : { feedback: resolved.feedback }),
          };
        }
      } catch (error) {
        if (error instanceof BureauError && error.code === 'NOT_FOUND') {
          return await refuse(resourceNotFound('task', input.taskId));
        }
        if (error instanceof BureauError) return await refuse(reviewFault(error, reviewId));
        throw error;
      }
      const completed = await host.respondLedger.complete(entry, result);
      return completed.result;
    };

    const flight = respond().finally(() => host.respondInFlight.delete(flightKey));
    host.respondInFlight.set(flightKey, flight);
    return flight;
  },
});
