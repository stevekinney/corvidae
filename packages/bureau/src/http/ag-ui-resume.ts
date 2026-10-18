/**
 * Resuming a run: the `resume` entries of a `RunAgentInput`, applied as one
 * authorized command.
 *
 * A resume is a new command, never an in-place change to a request the model
 * provider is serving: it resolves the reviews its entries answer, then opens a
 * new AG-UI stream. What the stream attaches to depends on the reviews' kinds.
 * A human wait parks the native run, so answering it signals the same run, and
 * the stream attaches to that run. A tool approval does not park the run (the
 * run settles and the approved tool runs out of band), so answering it ends in a
 * new native run started from the updated conversation, and the stream is that
 * run's. When the policy gates an approved call again, the review stays pending
 * under the same id with its round incremented and no run starts: the stream
 * re-emits the interrupt on the old run.
 *
 * The command is recorded in a command ledger before anything is resolved, keyed
 * by the caller, the thread, and the sorted `[id, round]` pairs of the interrupts it
 * answers (a JSON array, so no id can collide with another), with a digest of each entry's status and payload. Because a resume
 * must answer every interrupt pending on the run, that list identifies the
 * command without a client request id, so a client that mints a new `runId` per
 * retry is still idempotent. An exact retry attaches to the run the first attempt
 * named and touches no review; the same key with different answers is a
 * `RESUME_CONFLICT`; the round makes a resume after a supersession a new command.
 *
 * Several processes can share one store, so nothing here rests on state in one of
 * them. A resume is applied under a lease on its command and a lease on its
 * thread (`ag-ui-lease.ts`), both renewed before each step that cannot be taken
 * back; a process that finds the command's lease held is told it is in progress,
 * and takes over a command whose lease has expired, applying again what the dead
 * attempt did not. What a lease cannot fence is a tool that outlives it. Inside one
 * process Armorer's single-use approval binding stops it running twice, but that
 * binding lives in the process's memory, so across processes only the ledger's
 * compare-and-swap on the exact entry and the idempotent run-creation request id
 * hold (one entry, one run): a tool that outlives its lease can run twice, a
 * documented residual.
 *
 * @module ag-ui-resume
 */

import type { Event, ResumeEntry } from '@ag-ui/core';
import type { RuntimeServices } from '@lostgradient/lifecycle';
import { buildSignalContinuationInput, renderSignalContinuation } from '@lostgradient/operative';
import {
  createCommandLedger,
  BureauLedgerConflictError,
  canonicalJson,
  digestCommandPayload,
} from '../command-ledger.ts';
import type { CommandLedger, CommandLedgerIdentity } from '../command-ledger.ts';
import { ApprovalOutcomeNotWrittenError } from '../create-bureau.ts';
import { humanWaitAnswerRowIdentifier, humanWaitDenialPayload } from '../human-wait-signal.ts';
import type { Bureau, PendingReview, ResolveReviewInput } from '../types.ts';
import { type AgUiResumePayload, interruptKey } from './ag-ui-interrupts.ts';
import { type AgUiLeases, releaseQuietly } from './ag-ui-lease.ts';
import {
  interruptibleReviews,
  openRunStream,
  replayCall,
  runIsGoing,
  type AgUiStreamEnvironment,
} from './ag-ui-stream.ts';
import type { AgUiErrorCode } from './ag-ui-vocabulary.ts';
import type { OwnerAccessPredicate } from './owner-predicate.ts';

/** The version of the resume command's contract the ledger keys on. */
export const AG_UI_OPERATION_VERSION = 'bureau.ag-ui.v1';

type Principal = Parameters<OwnerAccessPredicate>[0]['principal'];

/** What a claimed resume records, so a retry knows which run its stream is. */
type ResumeClaim = { readonly threadId: string };
type ClaimedEntry = Parameters<CommandLedger<ResumeClaim, ResumeResult>['release']>[0];
type ResumeResult = {
  /** The native run the resume continued (a human wait) or created (a tool approval), or the old run when the policy gated again. */
  readonly runId: string;
  readonly mode: 'continued' | 'created' | 'superseded';
  readonly outcomes: ReadonlyArray<{ readonly interruptId: string; readonly outcome: string }>;
  /** Set when a retry found the earlier attempt's effect already in place and finished it. */
  readonly recovered?: true;
  /** Set when this attempt took over a command another attempt had begun, so a `no-op` outcome is that attempt's work. */
  readonly takenOver?: true;
};

/** What a resume came to: an answer to stream, with whether this attempt is the one that applied it. */
type Settled = { readonly result: ResumeResult; readonly applied: boolean };

type Refusal = { readonly code: AgUiErrorCode; readonly message: string };

export type ResumeBureau = Pick<
  Bureau,
  | 'getRun'
  | 'createRun'
  | 'getReview'
  | 'getSession'
  | 'listPendingReviews'
  | 'locateRunCreationReceipt'
  | 'resolveReview'
  | 'kv'
>;

export type ResumeContext = {
  readonly bureau: ResumeBureau;
  readonly environment: AgUiStreamEnvironment;
  readonly runtime: Pick<RuntimeServices, 'clock' | 'identifiers'>;
  readonly mayWrite: (principal: Principal, resourceOwner: string | undefined) => boolean;
  /** The durable leases a start's admission and this command are fenced by. */
  readonly leases: AgUiLeases;
  readonly ownerOfReview: (reviewId: string) => Promise<string | undefined>;
  readonly refuse: (code: AgUiErrorCode, message: string) => Response;
};

export type ResumeRequest = {
  readonly threadId: string;
  readonly runId: string;
  readonly agentName: string;
  readonly entries: ReadonlyArray<ResumeEntry>;
  readonly principal: Principal;
  readonly owner: string;
};

const CANCELLED_REASON = 'cancelled by the client';

function isPayload(value: unknown): value is AgUiResumePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (
    payload['decision'] !== 'approve' &&
    payload['decision'] !== 'deny' &&
    payload['decision'] !== 'reject'
  ) {
    return false;
  }
  if (payload['reason'] !== undefined && typeof payload['reason'] !== 'string') return false;
  if (payload['decision'] === 'reject') {
    return typeof payload['reason'] === 'string' && payload['reason'].trim() !== '';
  }
  return true;
}

/** How one entry is resolved: the call `resolveReview` takes, or nothing for a no-op. */
function resolutionFor(
  entry: ResumeEntry,
  review: PendingReview,
  owner: string,
): ResolveReviewInput {
  if (entry.status === 'cancelled') {
    return { id: review.id, decision: 'deny', principal: owner, reason: CANCELLED_REASON };
  }
  const payload = entry.payload as AgUiResumePayload;
  const base = { id: review.id, decision: payload.decision, principal: owner } as const;
  if (payload.decision === 'approve') {
    if (review.kind === 'tool-approval') {
      return Object.prototype.hasOwnProperty.call(payload, 'arguments')
        ? { ...base, arguments: payload.arguments }
        : base;
    }
    return { ...base, payload: payload.answer };
  }
  return payload.reason === undefined ? base : { ...base, reason: payload.reason };
}

export function createResume(context: ResumeContext) {
  const { bureau, environment, runtime } = context;
  const ledger: CommandLedger<ResumeClaim, ResumeResult> = createCommandLedger({
    kv: bureau.kv!,
    keyPrefix: 'command-ledger:ag-ui-resume:v1',
    clock: runtime.clock,
    nextConflictId: () => runtime.identifiers.next('ag-ui-resume-conflict'),
  });
  /** Attempts this process is still settling, by command key, so a duplicate joins them. */
  const inFlight = new Map<
    string,
    { readonly digest: string; readonly work: Promise<Refusal | Settled> }
  >();

  /**
   * The stream for a resume that has an answer. A run the resume just created is
   * the client's to read from its first event, behind a replay of the call it
   * approved; any other stream, a retry's included, attaches to the run as it
   * stands.
   */
  function streamFor(
    request: ResumeRequest,
    result: ResumeResult,
    fresh?: {
      readonly prelude?: () => Event[];
      readonly answerRows?: ReadonlyArray<{ readonly id: string; readonly content: string }>;
    },
  ): Response {
    const started = fresh?.prelude !== undefined;
    return openRunStream(environment, {
      threadId: request.threadId,
      runId: request.runId,
      nativeRunId: result.runId,
      replay: started ? 'beginning' : 'open-step',
      messagesSnapshot: !started,
      ...(fresh?.prelude === undefined ? {} : { preludeEvents: fresh.prelude }),
      ...(fresh?.answerRows === undefined ? {} : { answerRows: fresh.answerRows }),
    });
  }

  /**
   * The user rows a human's answers append to the run's conversation, as the
   * continuation will hold them: the id the park gives each (its review id carries
   * the ordinal the run names the row by) and the text the run renders. The run
   * appends them itself when it wakes; this says what they will be, so the stream
   * that resumed it can show them first. `delivered` says which entries' answers
   * this attempt or an attempt it took over put on the signal.
   */
  function answerRowsOf(
    request: ResumeRequest,
    reviews: ReadonlyMap<string, PendingReview>,
    delivered: (entry: ResumeEntry) => boolean,
  ): Array<{ id: string; content: string }> {
    const rows: Array<{ id: string; content: string }> = [];
    for (const entry of request.entries) {
      const review = reviews.get(entry.interruptId);
      if (review?.kind !== 'human-wait' || !delivered(entry)) continue;
      const id = humanWaitAnswerRowIdentifier(review);
      if (id === undefined) continue;
      const resolution = resolutionFor(entry, review, request.owner);
      const payload =
        resolution.decision === 'approve'
          ? resolution.payload
          : humanWaitDenialPayload(resolution.decision, resolution.reason);
      rows.push({
        id,
        content: renderSignalContinuation(
          buildSignalContinuationInput(review.signalName, payload, runtime.clock.nowISO()),
        ),
      });
    }
    return rows;
  }

  async function resume(request: ResumeRequest): Promise<Response> {
    const { threadId, owner, entries } = request;

    // 1. What the entries say, and whether the caller may answer them. Nothing
    //    here depends on whether a review is still pending, so a retry of a resume
    //    that already took effect gets the same answers it did.
    if (new Set(entries.map((entry) => entry.interruptId)).size !== entries.length) {
      return context.refuse('INVALID_INPUT', 'A resume must answer each interrupt once');
    }
    for (const entry of entries) {
      if (entry.status === 'resolved' && !isPayload(entry.payload)) {
        return context.refuse(
          'INVALID_INPUT',
          'A resolved entry needs a payload with a decision (and a reason, to reject)',
        );
      }
    }
    const reviews = new Map<string, PendingReview>();
    let sessionAgentName: Promise<string | undefined> | undefined;
    const sessionAgent = (): Promise<string | undefined> => {
      sessionAgentName ??= bureau.getSession(threadId).then((session) => session?.agentName);
      return sessionAgentName;
    };
    for (const entry of entries) {
      const review = await bureau.getReview(entry.interruptId);
      const reviewOwner =
        review === undefined ? undefined : await context.ownerOfReview(entry.interruptId);
      // A tool approval is the owner's alone: it authorizes a tool to run, so a write
      // scope that lets an operator answer a human's question does not reach it. The
      // refusal is the one a missing interrupt gets, and nothing has been resolved yet.
      const mayAnswer =
        review?.kind === 'tool-approval'
          ? reviewOwner !== undefined && reviewOwner === owner
          : context.mayWrite(request.principal, reviewOwner);
      // An approval of a run that is still going has not been offered: the run has not
      // stored its conversation, so the outcome could not be written into it. It is
      // answered once the run has settled, and until then it is not found.
      const notYetOffered =
        review?.kind === 'tool-approval' &&
        review.status === 'pending' &&
        runIsGoing(bureau, review.runId);
      // The continuation is the agent's that raised the interrupt: it runs under that
      // agent's route, so a resume through another published agent's route is refused as
      // an interrupt that does not exist there, and nothing is resolved.
      // A review with no agent recorded (one read back after a restart) is the session's;
      // with neither, nothing says which agent's it is, so no route is let through.
      const raisedBy =
        review === undefined ? undefined : (review.agentName ?? (await sessionAgent()));
      const otherAgents = review !== undefined && raisedBy !== request.agentName;
      if (
        review === undefined ||
        review.sessionId !== threadId ||
        !mayAnswer ||
        notYetOffered ||
        otherAgents
      ) {
        return context.refuse(
          'INTERRUPT_NOT_FOUND',
          `Interrupt "${entry.interruptId}" was not found`,
        );
      }
      reviews.set(entry.interruptId, review);
    }

    // 2. The command: its key and its digest.
    const identity: CommandLedgerIdentity = {
      callerId: owner,
      target: `ag-ui:resume:${threadId}`,
      requestId: interruptKey([...reviews.values()]),
      operationVersion: AG_UI_OPERATION_VERSION,
    };
    const digest = digestCommandPayload({
      entries: canonicalJson(
        entries
          .map((entry) => ({
            interruptId: entry.interruptId,
            status: entry.status,
            payload: entry.status === 'resolved' ? entry.payload : null,
          }))
          .toSorted((left, right) => (left.interruptId < right.interruptId ? -1 : 1)),
      ),
    });
    const key = `${identity.callerId}\u0000${identity.target}\u0000${identity.requestId}`;

    // An attempt this process is settling: an exact retry gets that attempt's answer,
    // and the same interrupts answered differently are a conflict, not a join (the
    // other answer must not take effect on the strength of this one's request).
    const running = inFlight.get(key);
    if (running !== undefined) {
      if (running.digest !== digest) {
        return context.refuse(
          'RESUME_CONFLICT',
          'These interrupts were already answered differently',
        );
      }
      const answered = await running.work;
      if ('code' in answered) return context.refuse(answered.code, answered.message);
      return streamFor(request, answered.result);
    }
    const work = settle(request, reviews, identity, digest, key);
    inFlight.set(key, { digest, work });
    try {
      const outcome = await work;
      if ('code' in outcome) return context.refuse(outcome.code, outcome.message);
      return await streamForSettled(request, reviews, outcome);
    } finally {
      inFlight.delete(key);
    }
  }

  /** The stream of an answer: a fresh one gets what the client has not seen, any other attaches to the run as it stands. */
  async function streamForSettled(
    request: ResumeRequest,
    reviews: ReadonlyMap<string, PendingReview>,
    { result, applied }: Settled,
  ): Promise<Response> {
    if (!applied) return streamFor(request, result);
    // Whether this attempt, or an attempt it took over, put the entry's answer to work.
    const delivered = (entry: ResumeEntry): boolean =>
      result.recovered === true ||
      result.outcomes.some(
        (outcome) =>
          outcome.interruptId === entry.interruptId &&
          (outcome.outcome === 'applied' ||
            (result.takenOver === true && outcome.outcome === 'no-op')),
      );
    if (result.mode === 'continued') {
      return streamFor(request, result, { answerRows: answerRowsOf(request, reviews, delivered) });
    }
    if (result.mode !== 'created' || result.recovered === true) return streamFor(request, result);
    const session = await bureau.getSession(request.threadId);
    const executed = executedArguments(request, reviews, delivered);
    return streamFor(request, result, {
      prelude: () =>
        [...reviews.values()].flatMap((review) =>
          review.kind === 'tool-approval'
            ? replayCall(
                session?.conversationHistory,
                review.approval.callId,
                {
                  nativeRunId: result.runId,
                  sessionId: request.threadId,
                  now: () => runtime.clock.now(),
                },
                executed.get(review.approval.callId),
              )
            : [],
        ),
    });
  }

  /**
   * The arguments each approved call was run with, by call id, for the calls whose
   * approval overrode them: the conversation holds the call as the model proposed it,
   * and the client is shown the call that ran.
   */
  function executedArguments(
    request: ResumeRequest,
    reviews: ReadonlyMap<string, PendingReview>,
    delivered: (entry: ResumeEntry) => boolean,
  ): Map<string, { readonly arguments: unknown }> {
    const executed = new Map<string, { readonly arguments: unknown }>();
    for (const entry of request.entries) {
      const review = reviews.get(entry.interruptId);
      if (review?.kind !== 'tool-approval' || !delivered(entry)) continue;
      const resolution = resolutionFor(entry, review, request.owner);
      if (resolution.decision === 'approve' && 'arguments' in resolution) {
        executed.set(review.approval.callId, { arguments: resolution.arguments });
      }
    }
    return executed;
  }

  /**
   * Takes the command's lease, claims it in the ledger, and applies it under the
   * thread's lease: the one place a resume does anything. A command whose lease
   * another attempt holds is in progress, and one the ledger already completed is
   * its recorded answer.
   */
  async function settle(
    request: ResumeRequest,
    reviews: ReadonlyMap<string, PendingReview>,
    identity: CommandLedgerIdentity,
    digest: string,
    key: string,
  ): Promise<Refusal | Settled> {
    const { threadId } = request;
    // Entries past their retention window go when the next resume comes, as the
    // run-creation ledger's do on the Bureau's own maintenance pass.
    await ledger.prune().catch(() => undefined);
    const commandLease = await context.leases.acquire('resume', key);
    if (commandLease === undefined) {
      const stored = await ledger.read(identity).catch(() => undefined);
      if (stored?.state === 'completed' && stored.payloadDigest === digest) {
        return { result: stored.result, applied: false };
      }
      return {
        code: 'RUN_FAILED',
        message: 'An earlier attempt at this resume is still being applied; try again shortly',
      };
    }
    try {
      let claim;
      try {
        claim = await ledger.claim(identity, digest, { threadId });
      } catch (error) {
        if (error instanceof BureauLedgerConflictError) {
          return {
            code: 'RESUME_CONFLICT',
            message: 'These interrupts were already answered differently',
          };
        }
        throw error;
      }
      const held = claim.entry;
      if (held.state === 'completed') return { result: held.result, applied: false };

      // A resume creates a run on the thread, so it is admitted the way a start is.
      const threadLease = await context.leases.acquire('thread', threadId);
      if (threadLease === undefined) {
        if (claim.outcome === 'claimed') await ledger.release(held).catch(() => false);
        return { code: 'THREAD_BUSY', message: `Thread "${threadId}" has a run in progress` };
      }
      try {
        const holds = async (): Promise<boolean> =>
          (await commandLease.renew()) && (await threadLease.renew());
        const outcome =
          claim.outcome === 'claimed'
            ? await apply(request, reviews, held, false, holds)
            : await takeOver(request, reviews, held, identity, digest, holds);
        return 'code' in outcome ? outcome : { result: outcome, applied: true };
      } finally {
        await releaseQuietly(threadLease);
      }
    } finally {
      await releaseQuietly(commandLease);
    }
  }

  /**
   * A pending entry whose lease has expired, or is free: its attempt is dead or
   * finished without saying so, and which the answered reviews say. While any is
   * still pending the attempt did not finish, so the entry is released, claimed
   * afresh, and applied again (a review resolved twice is refused by the Bureau,
   * so nothing runs twice). Once every one is resolved the attempt applied them
   * and died before it said so: the run that continues from them is found (or
   * started, under the request id that makes starting it idempotent) and the
   * entry completed.
   */
  async function takeOver(
    request: ResumeRequest,
    reviews: ReadonlyMap<string, PendingReview>,
    entry: ClaimedEntry,
    identity: CommandLedgerIdentity,
    digest: string,
    holds: () => Promise<boolean>,
  ): Promise<ResumeResult | Refusal> {
    const stillPending = new Set(bureau.listPendingReviews().map((review) => review.id));
    const answered = [...reviews.values()];
    if (answered.some((review) => stillPending.has(review.id))) {
      const released = await ledger.release(entry);
      const retaken = released
        ? await ledger.claim(identity, digest, { threadId: request.threadId })
        : undefined;
      if (retaken?.outcome === 'claimed')
        return apply(request, reviews, retaken.entry, true, holds);
      return {
        code: 'RUN_FAILED',
        message: 'Another attempt at this resume is in progress; try again',
      };
    }
    if (!(await holds())) return LEASE_LOST;
    const toolApprovals = answered.some((review) => review.kind === 'tool-approval');
    let result: ResumeResult;
    if (
      toolApprovals &&
      !approvesTool(request.entries, reviews) &&
      !(await conversationAnswerable(request.threadId))
    ) {
      // Every tool approval was refused and no run can start from the conversation, as
      // when the attempt that died first saw it: the refusals are written, the command is
      // complete, and the settled run is shown.
      result = { runId: answered[0]!.runId, mode: 'superseded', outcomes: [], recovered: true };
    } else if (toolApprovals) {
      let created: string;
      try {
        created = await continuationRun(request, reviews);
      } catch (error) {
        await ledger.release(entry).catch(() => false);
        return error instanceof OutcomeNotWritten ? OUTCOME_NOT_WRITTEN : CONTINUATION_NOT_STARTED;
      }
      result = { runId: created, mode: 'created', outcomes: [], recovered: true };
    } else {
      result = { runId: answered[0]!.runId, mode: 'continued', outcomes: [], recovered: true };
    }
    return completed(entry, result);
  }

  /** Records the answer. A completion that cannot be recorded does not undo what it records: the answer is still streamed. */
  async function completed(entry: ClaimedEntry, result: ResumeResult): Promise<ResumeResult> {
    await ledger.complete(entry, result).catch(() => undefined);
    return result;
  }

  /** The conversation still shows a call this resume answered as waiting on approval, so no run may start from it. */
  class OutcomeNotWritten extends Error {}

  /**
   * The run that continues from resolved approvals. Its request id is the
   * command's, so asking twice starts one. It starts from the conversation as it
   * stands, so it is refused while that conversation still shows any call this
   * resume answered as waiting on approval: the run would be asked the same
   * question again.
   */
  async function continuationRun(
    request: ResumeRequest,
    reviews: ReadonlyMap<string, PendingReview>,
  ): Promise<string> {
    const session = await bureau.getSession(request.threadId);
    const history = session?.conversationHistory;
    for (const review of reviews.values()) {
      if (review.kind !== 'tool-approval' || history === undefined) continue;
      const row = history.ids
        .map((id) => history.messages[id]!)
        .find((candidate) => candidate.toolResult?.callId === review.approval.callId);
      if (row?.toolResult?.outcome === 'action_required') throw new OutcomeNotWritten();
    }
    const created = await bureau.createRun({
      sessionId: request.threadId,
      agentName: request.agentName,
      principal: request.owner,
      runCreationRequestId: `ag-ui-resume:${request.threadId}:${interruptKey([...reviews.values()])}`,
    });
    return created.id;
  }

  /** Whether any entry approves a tool call: the one answer that runs a tool. */
  function approvesTool(
    entries: ReadonlyArray<ResumeEntry>,
    reviews: ReadonlyMap<string, PendingReview>,
  ): boolean {
    return entries.some(
      (entry) =>
        reviews.get(entry.interruptId)?.kind === 'tool-approval' &&
        entry.status === 'resolved' &&
        (entry.payload as AgUiResumePayload).decision === 'approve',
    );
  }

  /** Whether a run can start from the thread's conversation: it ends in a user or tool-result row, as `createRun` requires. */
  async function conversationAnswerable(threadId: string): Promise<boolean> {
    const session = await bureau.getSession(threadId);
    const history = session?.conversationHistory;
    const last = history?.ids.at(-1);
    const role = last === undefined ? undefined : history?.messages[last]?.role;
    return role === 'user' || role === 'tool-result';
  }

  async function apply(
    request: ResumeRequest,
    reviews: ReadonlyMap<string, PendingReview>,
    pendingEntry: ClaimedEntry,
    takeover: boolean,
    holds: () => Promise<boolean>,
  ): Promise<ResumeResult | Refusal> {
    const { entries } = request;
    const refuse = async (code: AgUiErrorCode, message: string): Promise<Refusal> => {
      await ledger.release(pendingEntry);
      return { code, message };
    };

    // The reviews of the run these answers belong to that a client can be asked
    // to answer now, all of which a resume must answer.
    const runIds = new Set([...reviews.values()].map((review) => review.runId));
    if (runIds.size !== 1) {
      return refuse('INVALID_INPUT', 'A resume must answer the interrupts of one run');
    }
    const [runId] = runIds;
    const pending = interruptibleReviews(bureau, runId!);
    const pendingIds = new Set(pending.map((review) => review.id));

    const unaddressed = pending.filter(
      (review) => !entries.some((entry) => entry.interruptId === review.id),
    );
    if (unaddressed.length > 0) {
      return refuse(
        'INTERRUPTS_UNADDRESSED',
        `The resume leaves interrupts unanswered: ${unaddressed.map((review) => review.id).join(', ')}`,
      );
    }
    for (const entry of entries) {
      // A cancelled answer to what is no longer pending is a no-op; a resolved one is not an answer to anything,
      // unless an earlier attempt at this very resume is what resolved it.
      if (!takeover && !pendingIds.has(entry.interruptId) && entry.status === 'resolved') {
        return refuse('INTERRUPT_NOT_FOUND', `Interrupt "${entry.interruptId}" was not found`);
      }
    }

    // Approving a tool approval runs the tool, and the run that continues from it
    // starts from the conversation as it stands. If no run can start from that
    // conversation, nothing is approved: the tool must not run to a dead end. A cancel,
    // a deny, or a reject runs no tool, so it always resolves; with no run to start it
    // writes the refusal as the outcome, completes the command with no run, and frees
    // the thread, which is the only way out of that state through this mount.
    const hasToolApproval = entries.some(
      (entry) => reviews.get(entry.interruptId)?.kind === 'tool-approval',
    );
    const canContinue = hasToolApproval ? await conversationAnswerable(request.threadId) : true;
    if (!takeover && !canContinue && approvesTool(entries, reviews)) {
      return refuse('CONTINUATION_UNAVAILABLE', CONTINUATION_UNAVAILABLE_MESSAGE);
    }

    const outcomes: Array<{ interruptId: string; outcome: string }> = [];
    let continued = false;
    let executed = false;
    let superseded = false;
    let failures = 0;
    let leaseLost = false;
    let notWritten: ApprovalOutcomeNotWrittenError | undefined;
    for (const entry of entries) {
      const review = reviews.get(entry.interruptId)!;
      if (!pendingIds.has(entry.interruptId)) {
        outcomes.push({ interruptId: entry.interruptId, outcome: 'no-op' });
        continue;
      }
      // Nothing below can be taken back, so it is not begun without the leases.
      if (!(await holds())) {
        leaseLost = true;
        break;
      }
      try {
        const resolved = await bureau.resolveReview(resolutionFor(entry, review, request.owner));
        outcomes.push({
          interruptId: entry.interruptId,
          outcome: resolved.superseded === true ? 'superseded' : 'applied',
        });
        if (resolved.superseded === true) superseded = true;
        else if (review.kind === 'tool-approval') executed = true;
        else continued = true;
      } catch (error) {
        // Another resolver won, or the review changed: the pending set decides what the stream shows.
        failures += 1;
        if (error instanceof ApprovalOutcomeNotWrittenError) notWritten = error;
        outcomes.push({
          interruptId: entry.interruptId,
          outcome: error instanceof Error ? error.name : 'failed',
        });
      }
    }

    // The entry is left as it is: another attempt holds the command now. A lease
    // lost while the last call ran means what it did may have been done twice over.
    if (leaseLost || !(await holds())) return LEASE_LOST;
    if (notWritten !== undefined) {
      // The approval was decided and its tool ran, but the conversation still shows
      // it as pending, so a run that continued from it would be asked the same
      // question again. No run starts; the failure is told to the client.
      return refuse('RUN_FAILED', OUTCOME_NOT_WRITTEN.message);
    }
    const appliedAny = continued || executed || superseded;
    if (failures > 0) {
      // A review that could not be resolved is still pending: continuing, or
      // recording the command as done, would strand it. Nothing applied means
      // the command can start over; a part applied means the entry stays, and
      // the retry that takes it over applies the rest.
      const addressed = new Set(entries.map((entry) => entry.interruptId));
      const stranded = bureau
        .listPendingReviews()
        .some((review) => review.runId === runId && addressed.has(review.id));
      if (stranded) {
        if (!appliedAny) {
          return refuse(
            'RUN_FAILED',
            'The answers could not be applied; answer the interrupts again',
          );
        }
        return {
          code: 'RUN_FAILED',
          message: 'Some of the answers could not be applied; answer the interrupts again',
        };
      }
    }

    const takenOver = takeover ? { takenOver: true as const } : {};
    if (continued) {
      return completed(pendingEntry, { runId: runId!, mode: 'continued', outcomes, ...takenOver });
    }
    if (executed && !superseded && !canContinue) {
      // Every tool approval was refused, and no run can start from the conversation: the
      // refusals are written, the command is complete, and the settled run is shown.
      return completed(pendingEntry, { runId: runId!, mode: 'superseded', outcomes, ...takenOver });
    }
    if (executed && !superseded) {
      // The conversation now ends in the executed results, so a run with no new
      // message starts from them. Its request id is the command's key, so a
      // retry that finds the claim after a restart finds the run too.
      if (!(await holds())) return LEASE_LOST;
      let created;
      try {
        created = await continuationRun(request, reviews);
      } catch (error) {
        // The approvals are resolved, so a retry of this resume finds nothing pending.
        // The thread is not stuck: a start with a new message continues from the
        // conversation as it stands.
        return error instanceof OutcomeNotWritten
          ? refuse('RUN_FAILED', OUTCOME_NOT_WRITTEN.message)
          : refuse('RUN_FAILED', CONTINUATION_NOT_STARTED.message);
      }
      return completed(pendingEntry, { runId: created, mode: 'created', outcomes, ...takenOver });
    }
    return completed(pendingEntry, { runId: runId!, mode: 'superseded', outcomes, ...takenOver });
  }

  return resume;
}

const CONTINUATION_UNAVAILABLE_MESSAGE =
  'No run can continue from this thread’s conversation as it stands (it does not end in a user or tool-result message), so this approval cannot be approved. Deny or cancel it, which frees the thread; a new message is refused while it is pending';
const LEASE_LOST: Refusal = {
  code: 'RUN_FAILED',
  message: 'This resume lost its lease to another attempt before it finished; try again',
};
const OUTCOME_NOT_WRITTEN: Refusal = {
  code: 'RUN_FAILED',
  message:
    'The approval was applied, but its outcome was not written into the conversation, so the run was not continued; send a new message to continue the thread',
};
const CONTINUATION_NOT_STARTED: Refusal = {
  code: 'RUN_FAILED',
  message:
    'The approvals were applied, but the run that continues from them could not be started; send a new message to continue the thread',
};
