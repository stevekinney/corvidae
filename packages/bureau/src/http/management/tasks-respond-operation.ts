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
 * resolves it. A retry never resolves a later approval round than the one its claim read: when
 * the approval was gated again in the meantime, it gets the `superseded` receipt and resolves
 * nothing.
 *
 * The receipt is the caller's own, so an exact retry inside the ledger's retention window
 * returns it before anything else is checked, even after the task itself has been removed by
 * task retention. Only a fresh command needs a live task.
 *
 * @module tasks-respond-operation
 */

import { defineOperation, type OperationFault, type Principal } from '@lostgradient/weft';
import { z } from 'zod';

import { checkFormSubmission } from '../../a2ui/input-form.ts';
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

/** The command's input: also how an A2A continuation's answer is validated. */
export const tasksRespondInput = z
  .object({
    taskId: z.string().min(1),
    /** The caller's idempotency key for this command. */
    messageId: z.string().min(1).max(200),
    /** Answer text; a list of parts is joined with a newline. */
    answer: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    /**
     * The answer of a human wait that carries an input schema: one JSON object, validated against
     * that schema before it is delivered as the signal's payload.
     */
    data: z.record(z.string(), z.unknown()).optional(),
    decision: z.enum(['approve', 'deny', 'reject']).optional(),
    /** Required, and non-blank, for `reject`. */
    reason: z.string().optional(),
    /** Addresses the human wait with this signal. */
    signalName: z.string().min(1).optional(),
    /** Addresses the tool approval for this call. */
    callId: z.string().min(1).optional(),
  })
  .refine(
    (input) =>
      [input.answer, input.data, input.decision].filter((value) => value !== undefined).length ===
      1,
    {
      message: 'Send exactly one of `answer`, `data` and `decision`',
      path: ['answer'],
    },
  )
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

/**
 * What a ledger entry of this command claims: the review it targets and, for a tool approval,
 * the supersession round the command read it at. A re-gated approval keeps its `reviewId` and
 * advances its round, so the round is what tells a retry that its decision was about an earlier
 * one. Absent for a human wait, and in an entry written before the round was recorded.
 */
export type TasksRespondClaim = { readonly reviewId: string; readonly round?: number };

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

/** JSON text with every object's keys sorted, so equal data digests equally whatever its key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, held: unknown) =>
    typeof held === 'object' && held !== null && !Array.isArray(held)
      ? Object.fromEntries(
          Object.entries(held).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : held,
  );
}

function unprocessable(message: string, reason: string): OperationFault {
  return { code: 'Unprocessable', message, data: { reason } };
}

/**
 * What a human wait with an input schema accepts, checked before anything is claimed or delivered
 * (COR-1487). The answer is untrusted: structured `data` is validated against the schema the wait
 * was parked with, text and a bare approval are refused for such a wait, and `data` is refused for
 * a wait that has no schema. Returns the value to deliver as the signal's payload, or `undefined`
 * when the command delivers the answer text or a decision as before.
 */
async function checkedSubmission(
  host: BureauTasksRespondOperationHost,
  reviewId: string,
  input: z.infer<typeof tasksRespondInput>,
): Promise<{ readonly value: unknown } | undefined> {
  // A task's view names its waits by identifier only: the schema is on the review.
  const review = await host.reviews.getReview(reviewId);
  const schema = review?.kind === 'human-wait' ? review.inputSchema : undefined;
  if (input.data === undefined) {
    if (schema === undefined) return undefined;
    if (input.answer !== undefined) {
      throw unprocessable(
        'This wait expects structured data matching its schema; send `data`, not text',
        'text answer to a wait with an input schema',
      );
    }
    if ((input.decision ?? 'approve') === 'approve') {
      throw invalid('data', 'This wait expects `data` matching its input schema');
    }
    return undefined;
  }
  if (schema === undefined) {
    throw unprocessable(
      'This wait takes no structured data; answer with text',
      'data addressed to a wait without an input schema',
    );
  }
  const checked = checkFormSubmission(schema, input.data);
  if (!checked.ok) throw invalid('data', checked.message);
  return { value: checked.value };
}

/** The input {@link respondToTask} takes, as {@link tasksRespondInput} parses it. */
export type TasksRespondInput = z.infer<typeof tasksRespondInput>;

/**
 * Answers one open wait of a task as `principal`: the body of `bureau.tasks.respond`, which an
 * A2A continuation of an `INPUT_REQUIRED` task reaches too. A refusal is thrown as the
 * operation's fault.
 */
export async function respondToTask(
  host: BureauTasksRespondOperationHost,
  principal: Principal,
  input: TasksRespondInput,
): Promise<TasksRespondResult> {
  return respond({ input, host, principal });
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
  invoke: (context) => respond(context),
});

async function respond({
  input,
  host,
  principal,
}: {
  readonly input: TasksRespondInput;
  readonly host: BureauTasksRespondOperationHost;
  readonly principal: Principal;
}): Promise<TasksRespondResult> {
  const answerText =
    input.answer === undefined
      ? undefined
      : Array.isArray(input.answer)
        ? input.answer.join('\n')
        : input.answer;
  const decision = input.decision ?? 'approve';
  const digest = digestCommandPayload({
    answer: answerText,
    data: input.data === undefined ? undefined : canonicalJson(input.data),
    decision: input.decision,
    reason: input.reason,
    signalName: input.signalName,
    callId: input.callId,
  });
  const caller = ownerOfPrincipal(principal);
  const identityOf = (actor: string): CommandLedgerIdentity => ({
    callerId: actor,
    target: input.taskId,
    requestId: input.messageId,
    operationVersion: TASKS_RESPOND_OPERATION_VERSION,
  });
  // The caller's own receipt first: a retry of a command that was applied is owed its receipt
  // while the ledger retains it, whether or not the task still has a record.
  if (caller !== undefined) {
    const located = await host.respondLedger.locate(identityOf(caller));
    if (
      located.state === 'retained' &&
      located.entry.state === 'completed' &&
      located.entry.payloadDigest === digest
    ) {
      return located.entry.result;
    }
  }
  if (!(await mayAccessTask(host, principal, input.taskId, 'bureau.tasks:write'))) {
    throw resourceNotFound('task', input.taskId);
  }
  const task = await host.tasks.get(input.taskId);
  if (task === undefined) throw resourceNotFound('task', input.taskId);
  const actor = caller;
  if (actor === undefined) {
    throw {
      code: 'Forbidden',
      message: 'Answering a task requires an API-key or local caller',
      data: { reason: 'unsupported credential' },
    } satisfies OperationFault;
  }
  const isOwner = task.owner === actor;
  const identity = identityOf(actor);

  const flightKey = `${actor}\u0000${input.taskId}\u0000${input.messageId}\u0000${digest}`;
  const running = host.respondInFlight.get(flightKey);
  if (running !== undefined) return running;

  const answer = async (): Promise<TasksRespondResult> => {
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
    // What the wait accepts is checked once it is chosen. A refusal is thrown after the ledger is
    // consulted, so a retry of a command that was applied still gets its receipt.
    let submission: { readonly value: unknown } | undefined;
    let submissionRefusal: unknown;
    if (wait !== undefined) {
      try {
        submission = await checkedSubmission(host, wait.reviewId, input);
      } catch (error) {
        submissionRefusal = error;
      }
    }
    // The round the command reads the approval at, recorded with its claim.
    let readRound: number | undefined;
    if (wait?.kind === 'tool-approval') {
      const read = await host.reviews.getReview(wait.reviewId).catch(() => undefined);
      readRound = read?.kind === 'tool-approval' ? read.round : undefined;
    }
    let claimed;
    try {
      claimed = await host.respondLedger.claim(identity, digest, {
        reviewId: wait?.reviewId ?? '',
        ...(readRound === undefined ? {} : { round: readRound }),
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
    // The payload belongs to the review the claim names, not to the wait selected now: a retry
    // can select a different wait, or none, and must still deliver the data it was sent with.
    if (reviewId !== '' && reviewId !== wait?.reviewId) {
      submission = undefined;
      submissionRefusal = undefined;
      try {
        submission = await checkedSubmission(host, reviewId, input);
      } catch (error) {
        submissionRefusal = error;
      }
    }
    const refuse = async (fault: unknown): Promise<never> => {
      // The Bureau refused it before changing anything, so a retry may claim afresh.
      if (ownClaim) await host.respondLedger.release(entry);
      throw fault;
    };
    if (submissionRefusal !== undefined) return refuse(submissionRefusal);
    // Nothing was addressed and nothing was applied: leave no claim of ours behind.
    if (reviewId === '') return refuse(notAwaiting ?? conflict('The task is not awaiting input'));
    let result: TasksRespondResult;
    try {
      const review = await host.reviews.getReview(reviewId);
      if (review === undefined) return await refuse(resourceNotFound('task', input.taskId));
      const claimedRound = entry.claim.round;
      const currentRound = review.kind === 'tool-approval' ? review.round : undefined;
      if (claimedRound !== undefined && currentRound !== undefined && currentRound > claimedRound) {
        if (ownClaim) {
          // Gated again between this command's read and its claim: its decision was about
          // the round before, and nothing has been applied.
          return await refuse(conflict('The approval was gated again; read it and decide again'));
        }
        // An earlier attempt of this command was cut short after the approval was gated
        // again, so what it decided was the earlier round, whose outcome was `superseded`.
        // The replacement round is another decision; resolving it here would approve it.
        result = {
          taskId: input.taskId,
          messageId: input.messageId,
          reviewId,
          kind: review.kind,
          decision,
          receipt: 'superseded',
        };
      } else if (
        !ownClaim &&
        review.status === EXPECTED_STATUS[decision] &&
        review.resolvedBy === actor
      ) {
        // An earlier attempt of this same command (it left its claim pending) resolved it
        // before it could record its receipt. A fresh claim has no such history: the review
        // was decided by another command, whoever made it, and its text was never delivered.
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
          ...(submission !== undefined
            ? { payload: submission.value }
            : answerText === undefined
              ? {}
              : { payload: answerText }),
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

  const flight = answer().finally(() => host.respondInFlight.delete(flightKey));
  host.respondInFlight.set(flightKey, flight);
  return flight;
}
