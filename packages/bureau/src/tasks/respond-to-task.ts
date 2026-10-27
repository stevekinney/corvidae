/**
 * `bureau.tasks.respond`: answer a task's open human-input or approval wait, in-process.
 *
 * The request is an A2A continuation's: answer text, an optional `signalName` or `callId` that
 * says which wait, or an approval `decision`, plus a caller-supplied `messageId` that makes the
 * command idempotent, and the `principal` answering. It answers through the Bureau's
 * `reviews.resolve` and never reaches into a session, so whatever identity a review has works
 * through it unchanged.
 *
 * ## Who may answer
 *
 * The task's owner answers anything. A caller answering as an operator (`operator: true`, which
 * `createBureauHandler` sets for a caller holding `bureau.tasks:write`) answers another owner's
 * human-input waits only; its approval decision is answered exactly as a missing task, so
 * approving a tool stays with the owner and with `bureau.reviews.resolve`'s operator scope. Any
 * other caller's command on a task it does not own is answered as a missing task.
 *
 * ## Idempotency
 *
 * The command ledger keys an entry on the principal, the task, the `messageId`, and this
 * command's version, with a digest of what the command decides. An exact retry returns the
 * original receipt without resolving anything again; the same `messageId` with a different
 * intent is a `CONFLICT`. A claim whose resolution was cut short is finished by the retry: if the
 * review is already resolved the way the claim intended it completes as applied, and if it is
 * still pending the retry resolves it. A retry never resolves a later approval round than the one
 * its claim read: when the approval was gated again in the meantime, it gets the `superseded`
 * receipt and resolves nothing.
 *
 * The receipt is the caller's own, so an exact retry inside the ledger's retention window
 * returns it before anything else is checked, even after the task itself has been removed by
 * task retention. Only a fresh command needs a live task.
 *
 * @module respond-to-task
 */

import { z } from 'zod';

import { checkFormSubmission } from '../a2ui/input-form.ts';
import {
  BureauLedgerConflictError,
  type CommandLedger,
  type CommandLedgerIdentity,
  digestCommandPayload,
} from '../command-ledger.ts';
import type { TaskRegistry, TaskView } from '../task-registry.ts';
import type {
  BureauReviews,
  ResolveReviewResult,
  TaskRespondRequest,
  TaskRespondResult,
} from '../types.ts';

/** The version of this command's contract, part of every ledger identity. */
export const TASKS_RESPOND_OPERATION_VERSION = 'bureau.tasks.respond.v1';

/** The key prefix of this command's ledger, disjoint from run creation's. */
export const TASKS_RESPOND_LEDGER_KEY_PREFIX = 'command-ledger:tasks-respond:v1';

/** The command's input, without the principal: also how an A2A continuation's answer is validated. */
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

/** The command's input, as {@link tasksRespondInput} parses it. */
export type TasksRespondInput = z.infer<typeof tasksRespondInput>;

/**
 * What a ledger entry of this command claims: the review it targets and, for a tool approval,
 * the supersession round the command read it at. A re-gated approval keeps its `reviewId` and
 * advances its round, so the round is what tells a retry that its decision was about an earlier
 * one. Absent for a human wait, and in an entry written before the round was recorded.
 */
export type TasksRespondClaim = {
  readonly reviewId: string;
  readonly round?: number;
  /**
   * A structured answer, as admitted: validated against the wait's schema and normalised once, when
   * the command was claimed. A retry of a pending claim delivers it, or finds the review already
   * resolved by this command, without validating again.
   */
  readonly submission?: { readonly value: unknown };
};

/** The ledger this command records its receipts in. */
export type TasksRespondLedger = CommandLedger<TasksRespondClaim, TaskRespondResult>;

/**
 * Why {@link TaskResponder.respond} refused a command, before anything took effect. `field` names
 * the request field a `BAD_REQUEST` is about; `reason` is the short, stable cause of a
 * `BAD_REQUEST` the addressed wait cannot take, distinct from the message.
 */
export type TaskRespondRefusal = {
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST';
  readonly message: string;
  readonly field?: string;
  readonly reason?: string;
};

/** What {@link createTaskResponder} answers commands from. */
export type TaskResponderDependencies = {
  /** The task registry a fresh command reads the task, its owner, and its open waits from. */
  readonly registry: Pick<TaskRegistry, 'get' | 'ownerOf'>;
  /** The reviews a command reads and resolves. */
  readonly reviews: Pick<BureauReviews, 'get' | 'resolve'>;
  /** The ledger receipts are recorded in. */
  readonly ledger: TasksRespondLedger;
  /** The error a refusal is thrown as. */
  readonly refusal: (refusal: TaskRespondRefusal) => Error;
  /**
   * Whether `error` is a refusal of the Bureau's (a `BureauError`): one `reviews` threw having
   * changed nothing, so the command's claim is released and a retry may claim afresh.
   */
  readonly isRefusal: (error: unknown) => error is Error & { readonly code: string };
};

/** `bureau.tasks.respond`, over its own ledger and the commands in flight in this process. */
export type TaskResponder = {
  readonly respond: (request: TaskRespondRequest) => Promise<TaskRespondResult>;
};

const EXPECTED_STATUS = { approve: 'approved', deny: 'denied', reject: 'rejected' } as const;

type OpenWait = TaskView['openWaits'][number];

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

/**
 * The receipt for a resolution that reached the Bureau: `superseded` when the approval was gated
 * again, else `applied`. A landed `reject` is `applied`, not `rejected`: `rejected` means the
 * command was refused and nothing took effect, and a refusal is a fault.
 */
export function reviewReceiptOf(result: unknown): TaskRespondResult['receipt'] {
  // `resumeApproval` re-ran the tool's policy and gated it again: the tool did not run and the
  // review remains pending under a replacement approval.
  if (
    typeof result === 'object' &&
    result !== null &&
    'outcome' in result &&
    result.outcome === 'action_required'
  ) {
    return 'superseded';
  }
  return 'applied';
}

/**
 * Build `bureau.tasks.respond` over `dependencies`. Two identical commands in flight in this
 * process share one resolution, so they never race one review.
 */
export function createTaskResponder(dependencies: TaskResponderDependencies): TaskResponder {
  const { registry, reviews, ledger } = dependencies;
  const inFlight = new Map<string, Promise<TaskRespondResult>>();
  const refuse = (refusal: TaskRespondRefusal): Error => dependencies.refusal(refusal);
  const notFound = (taskId: string): Error =>
    refuse({ code: 'NOT_FOUND', message: `Task "${taskId}" not found` });
  const conflict = (message: string): Error => refuse({ code: 'CONFLICT', message });
  const invalid = (field: string, message: string): Error =>
    refuse({ code: 'BAD_REQUEST', message, field });
  const unprocessable = (message: string, reason: string): Error =>
    refuse({ code: 'BAD_REQUEST', message, reason });

  /**
   * The wait this command addresses, or the refusal that says why none is. A caller that is not
   * the owner is offered the human-input waits only.
   */
  function selectWait(task: TaskView, input: TasksRespondInput, isOwner: boolean): OpenWait {
    const offered = isOwner
      ? task.openWaits
      : task.openWaits.filter((wait) => wait.kind === 'human-wait');
    if (offered.length === 0) {
      // A non-owner is never told an approval is open: for it the task has nothing to answer.
      if (!isOwner && task.openWaits.length > 0) throw notFound(task.id);
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
      if (!isOwner && input.callId !== undefined) throw notFound(task.id);
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
      throw unprocessable(
        'An answer addresses a human wait; a tool approval takes a `decision`',
        'answer addressed to a tool approval',
      );
    }
    return only;
  }

  /**
   * What a human wait with an input schema accepts, checked before anything is claimed or
   * delivered (COR-1487). The answer is untrusted: structured `data` is validated against the
   * schema the wait was parked with, text and a bare approval are refused for such a wait, and
   * `data` is refused for a wait that has no schema. Returns the value to deliver as the signal's
   * payload, or `undefined` when the command delivers the answer text or a decision as before.
   */
  async function checkedSubmission(
    reviewId: string,
    input: TasksRespondInput,
  ): Promise<{ readonly value: unknown } | undefined> {
    // A task's view names its waits by identifier only: the schema is on the review.
    const review = await reviews.get(reviewId);
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

  /** The request, read once and checked: a malformed one is `BAD_REQUEST` before anything is read. */
  function parseRequest(request: TaskRespondRequest): {
    readonly input: TasksRespondInput;
    readonly principal: string;
    readonly operator: boolean;
  } {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw invalid('request', '"request" must be an object');
    }
    const { principal, operator, ...rest } = request;
    if (typeof principal !== 'string' || principal.trim() === '') {
      throw invalid('principal', '"principal" must be a non-empty string');
    }
    if (operator !== undefined && typeof operator !== 'boolean') {
      throw invalid('operator', '"operator" must be a boolean');
    }
    const parsed = tasksRespondInput.safeParse(rest);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      throw invalid(issue?.path.join('.') ?? 'request', issue?.message ?? 'Invalid request');
    }
    return { input: parsed.data, principal, operator: operator === true };
  }

  async function respond(request: TaskRespondRequest): Promise<TaskRespondResult> {
    const { input, principal: actor, operator } = parseRequest(request);
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
    const identity: CommandLedgerIdentity = {
      callerId: actor,
      target: input.taskId,
      requestId: input.messageId,
      operationVersion: TASKS_RESPOND_OPERATION_VERSION,
    };
    // The caller's own receipt first: a retry of a command that was applied is owed its receipt
    // while the ledger retains it, whether or not the task still has a record.
    const located = await ledger.locate(identity);
    if (
      located.state === 'retained' &&
      located.entry.state === 'completed' &&
      located.entry.payloadDigest === digest
    ) {
      return located.entry.result;
    }
    // Another owner's task is answered exactly as a missing one, unless the caller is an operator.
    if (!operator && (await registry.ownerOf(input.taskId)) !== actor) {
      throw notFound(input.taskId);
    }
    const task = await registry.get(input.taskId);
    if (task === undefined) throw notFound(input.taskId);
    const isOwner = task.owner === actor;

    const flightKey = `${actor}\u0000${input.taskId}\u0000${input.messageId}\u0000${digest}`;
    const running = inFlight.get(flightKey);
    if (running !== undefined) return running;

    const answer = async (): Promise<TaskRespondResult> => {
      // The wait is chosen first, so a command that addresses nothing claims nothing. A retry of a
      // command that has since been answered finds no open wait, so the ledger is consulted before
      // that is held against it.
      let wait: OpenWait | undefined;
      let notAwaiting: unknown;
      try {
        wait = selectWait(task, input, isOwner);
      } catch (error) {
        notAwaiting = error;
      }
      // What the wait accepts is checked once it is chosen. A refusal is thrown after the ledger
      // is consulted, so a retry of a command that was applied still gets its receipt.
      let submission: { readonly value: unknown } | undefined;
      let submissionRefusal: unknown;
      if (wait !== undefined) {
        try {
          submission = await checkedSubmission(wait.reviewId, input);
        } catch (error) {
          submissionRefusal = error;
        }
      }
      // The round the command reads the approval at, recorded with its claim.
      let readRound: number | undefined;
      if (wait?.kind === 'tool-approval') {
        const read = await reviews.get(wait.reviewId).catch(() => undefined);
        readRound = read?.kind === 'tool-approval' ? read.round : undefined;
      }
      let claimed;
      try {
        claimed = await ledger.claim(identity, digest, {
          reviewId: wait?.reviewId ?? '',
          ...(readRound === undefined ? {} : { round: readRound }),
          ...(submission === undefined || submissionRefusal !== undefined ? {} : { submission }),
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
      // Only a claim this invocation made is this invocation's to release. A pending claim another
      // attempt made belongs to it: that attempt may be resolving the review right now, possibly
      // in another process, and deleting its claim would lose its receipt.
      const ownClaim = claimed.outcome === 'claimed';
      // A retry completes from the claim, not from current state: the submission was validated
      // and normalised once, at the admission that made the claim, and is recorded in it.
      // Revalidating here would judge the same command against a review that may since have
      // closed, lost its schema in the audit record, or been joined by another wait.
      const replay = !ownClaim && entry.claim.submission !== undefined;
      const delivered = replay ? entry.claim.submission : submission;
      // Set once a refusal has released the claim, so the catch below passes that refusal on
      // rather than releasing again.
      let released = false;
      const release = async (refusal: unknown): Promise<never> => {
        released = true;
        // The Bureau refused it before changing anything, so a retry may claim afresh.
        if (ownClaim) await ledger.release(entry);
        throw refusal;
      };
      if (!replay && submissionRefusal !== undefined) return release(submissionRefusal);
      // Nothing was addressed and nothing was applied: leave no claim of ours behind.
      if (reviewId === '') {
        return release(notAwaiting ?? conflict('The task is not awaiting input'));
      }
      let result: TaskRespondResult;
      try {
        const review = await reviews.get(reviewId);
        if (review === undefined) return await release(notFound(input.taskId));
        const claimedRound = entry.claim.round;
        const currentRound = review.kind === 'tool-approval' ? review.round : undefined;
        if (
          claimedRound !== undefined &&
          currentRound !== undefined &&
          currentRound > claimedRound
        ) {
          if (ownClaim) {
            // Gated again between this command's read and its claim: its decision was about the
            // round before, and nothing has been applied.
            return await release(
              conflict('The approval was gated again; read it and decide again'),
            );
          }
          // An earlier attempt of this command was cut short after the approval was gated again,
          // so what it decided was the earlier round, whose outcome was `superseded`. The
          // replacement round is another decision; resolving it here would approve it.
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
          // before it could record its receipt. A fresh claim has no such history: the review was
          // decided by another command, whoever made it, and its text was never delivered.
          result = {
            taskId: input.taskId,
            messageId: input.messageId,
            reviewId,
            kind: review.kind,
            decision,
            receipt: 'applied',
          };
        } else if (review.status !== 'pending') {
          return await release(conflict('The review was already resolved'));
        } else {
          const resolved: ResolveReviewResult = await reviews.resolve({
            id: reviewId,
            decision,
            principal: actor,
            ...(delivered !== undefined
              ? { payload: delivered.value }
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
            receipt: reviewReceiptOf(resolved.result),
            ...(resolved.feedback === undefined ? {} : { feedback: resolved.feedback }),
          };
        }
      } catch (error) {
        // A review the Bureau refused to read or resolve changed nothing: release the claim and
        // pass the refusal on. Anything else (a store failure) leaves the claim for a retry.
        if (!released && dependencies.isRefusal(error)) {
          return await release(error.code === 'NOT_FOUND' ? notFound(input.taskId) : error);
        }
        throw error;
      }
      const completed = await ledger.complete(entry, result);
      return completed.result;
    };

    const flight = answer().finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, flight);
    return flight;
  }

  return { respond };
}
