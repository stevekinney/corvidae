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
 * by the caller, the thread, and the sorted `id@round` list of the interrupts it
 * answers, with a digest of each entry's status and payload. Because a resume
 * must answer every interrupt pending on the run, that list identifies the
 * command without a client request id, so a client that mints a new `runId` per
 * retry is still idempotent. An exact retry attaches to the run the first attempt
 * named and touches no review; the same key with different answers is a
 * `RESUME_CONFLICT`; the round makes a resume after a supersession a new command.
 *
 * @module ag-ui-resume
 */

import type { Event, ResumeEntry } from '@ag-ui/core';
import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  buildSignalContinuationInput,
  renderSignalContinuation,
  signalMessageIdentifier,
} from '@lostgradient/operative';
import {
  createCommandLedger,
  BureauLedgerConflictError,
  canonicalJson,
  digestCommandPayload,
} from '../command-ledger.ts';
import type { CommandLedger, CommandLedgerIdentity } from '../command-ledger.ts';
import { ApprovalOutcomeNotWrittenError } from '../create-bureau.ts';
import { humanWaitDenialPayload } from '../human-wait-signal.ts';
import type { Bureau, PendingReview, ResolveReviewInput } from '../types.ts';
import { type AgUiResumePayload, interruptKey } from './ag-ui-interrupts.ts';
import { replayCall, type AgUiStreamEnvironment, openRunStream } from './ag-ui-stream.ts';
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
};

type Refusal = { readonly code: AgUiErrorCode; readonly message: string };

export type ResumeBureau = Pick<
  Bureau,
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
  /**
   * Runs `decide` as the one decision that admits a run to `threadId` at a time,
   * the way a start does, so a resume's new run and a start cannot both be admitted.
   */
  readonly admit: <T>(threadId: string, decide: () => Promise<T>) => Promise<T>;
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
  /** Attempts this process is still settling, by command key, so a duplicate waits for them. */
  const inFlight = new Map<string, Promise<ResumeResult | Refusal>>();

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
   * The user rows a human's answers just appended to the run's conversation, as
   * the continuation will hold them: the id the run derives for each delivery and
   * the text it renders. The run appends them itself when it wakes; this says what
   * they will be, so the stream that resumed it can show them first.
   */
  async function answerRowsOf(
    request: ResumeRequest,
    reviews: ReadonlyMap<string, PendingReview>,
    result: ResumeResult,
  ): Promise<Array<{ id: string; content: string }>> {
    const session = await bureau.getSession(request.threadId);
    const known = new Set(session?.conversationHistory.ids ?? []);
    const rows: Array<{ id: string; content: string }> = [];
    for (const entry of request.entries) {
      const review = reviews.get(entry.interruptId);
      const applied = result.outcomes.some(
        (outcome) => outcome.interruptId === entry.interruptId && outcome.outcome === 'applied',
      );
      if (review?.kind !== 'human-wait' || !applied) continue;
      const resolution = resolutionFor(entry, review, request.owner);
      const payload =
        resolution.decision === 'approve'
          ? resolution.payload
          : humanWaitDenialPayload(resolution.decision, resolution.reason);
      const id = signalMessageIdentifier([...known], review.runId, review.signalName);
      if (id === undefined) continue;
      known.add(id);
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
      if (review === undefined || review.sessionId !== threadId || !mayAnswer) {
        return context.refuse(
          'INTERRUPT_NOT_FOUND',
          `Interrupt "${entry.interruptId}" was not found`,
        );
      }
      reviews.set(entry.interruptId, review);
    }

    // 2. The command: its key, its digest, and its claim.
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
    // Entries past their retention window go when the next resume comes, as the
    // run-creation ledger's do on the Bureau's own maintenance pass.
    await ledger.prune().catch(() => undefined);
    let claim;
    try {
      claim = await ledger.claim(identity, digest, { threadId });
    } catch (error) {
      if (error instanceof BureauLedgerConflictError) {
        return context.refuse(
          'RESUME_CONFLICT',
          'These interrupts were already answered differently',
        );
      }
      throw error;
    }

    const held = claim.entry;
    if (held.state === 'completed') return streamFor(request, held.result);
    const running = inFlight.get(key);
    if (running !== undefined) {
      // An attempt this process is settling: the retry gets that attempt's answer.
      const answered = await running;
      if ('code' in answered) return context.refuse(answered.code, answered.message);
      return streamFor(request, answered);
    }

    // 3. This call applies the resume: a fresh claim, or the takeover of one whose
    //    attempt is gone (its process died, or another process holds it).
    const attempt = context.admit(threadId, async (): Promise<ResumeResult | Refusal> => {
      if (claim.outcome === 'claimed') return apply(request, reviews, held, false);
      const recovered = await recover(request, reviews, held, identity, digest);
      return 'entry' in recovered ? apply(request, reviews, recovered.entry, true) : recovered;
    });
    inFlight.set(key, attempt);
    try {
      const outcome = await attempt;
      if ('code' in outcome) return context.refuse(outcome.code, outcome.message);
      if (outcome.recovered === true) return streamFor(request, outcome);
      if (outcome.mode === 'continued') {
        return streamFor(request, outcome, {
          answerRows: await answerRowsOf(request, reviews, outcome),
        });
      }
      if (outcome.mode !== 'created') return streamFor(request, outcome);
      const session = await bureau.getSession(threadId);
      return streamFor(request, outcome, {
        prelude: () =>
          [...reviews.values()].flatMap((review) =>
            review.kind === 'tool-approval'
              ? replayCall(session?.conversationHistory, review.approval.callId, {
                  nativeRunId: outcome.runId,
                  sessionId: threadId,
                  now: () => runtime.clock.now(),
                })
              : [],
          ),
      });
    } finally {
      inFlight.delete(key);
    }
  }

  /**
   * A pending entry nothing in this process is settling. Its attempt either died
   * before it took effect, after it, or somewhere between, and the answered
   * reviews say which: while any is still pending the attempt did not finish, so
   * the entry is taken over (released, so a claim is this call's, and applied
   * again; a review resolved twice is refused by the Bureau, so nothing runs
   * twice). Once every one is resolved the attempt applied them and died before
   * it said so: the run that continues from them is found (or started, under the
   * request id that makes starting it idempotent) and the entry completed.
   */
  async function recover(
    request: ResumeRequest,
    reviews: ReadonlyMap<string, PendingReview>,
    entry: ClaimedEntry,
    identity: CommandLedgerIdentity,
    digest: string,
  ): Promise<{ readonly entry: ClaimedEntry } | ResumeResult | Refusal> {
    const stillPending = new Set(bureau.listPendingReviews().map((review) => review.id));
    const answered = [...reviews.values()];
    if (answered.some((review) => stillPending.has(review.id))) {
      const released = await ledger.release(entry);
      const retaken = released
        ? await ledger.claim(identity, digest, { threadId: request.threadId })
        : undefined;
      if (retaken?.outcome === 'claimed') return { entry: retaken.entry };
      return {
        code: 'RUN_FAILED',
        message: 'Another attempt at this resume is in progress; try again',
      };
    }
    const toolApprovals = answered.some((review) => review.kind === 'tool-approval');
    let result: ResumeResult;
    if (toolApprovals) {
      const created = await continuationRun(request, reviews).catch(() => undefined);
      if (created === undefined) {
        return {
          code: 'RUN_FAILED',
          message:
            'The approvals were applied, but the run that continues from them could not be started; send a new message to continue the thread',
        };
      }
      result = { runId: created, mode: 'created', outcomes: [], recovered: true };
    } else {
      result = { runId: answered[0]!.runId, mode: 'continued', outcomes: [], recovered: true };
    }
    await ledger.complete(entry, result);
    return result;
  }

  /** The run that continues from resolved approvals. Its request id is the command's, so asking twice starts one. */
  async function continuationRun(
    request: ResumeRequest,
    reviews: ReadonlyMap<string, PendingReview>,
  ): Promise<string> {
    const created = await bureau.createRun({
      sessionId: request.threadId,
      agentName: request.agentName,
      principal: request.owner,
      runCreationRequestId: `ag-ui-resume:${request.threadId}:${interruptKey([...reviews.values()])}`,
    });
    return created.id;
  }

  async function apply(
    request: ResumeRequest,
    reviews: ReadonlyMap<string, PendingReview>,
    pendingEntry: ClaimedEntry,
    takeover: boolean,
  ): Promise<ResumeResult | Refusal> {
    const { entries } = request;
    const refuse = async (code: AgUiErrorCode, message: string): Promise<Refusal> => {
      await ledger.release(pendingEntry);
      return { code, message };
    };

    // The pending reviews of the run these answers belong to, all of which a
    // resume must answer.
    const runIds = new Set([...reviews.values()].map((review) => review.runId));
    if (runIds.size !== 1) {
      return refuse('INVALID_INPUT', 'A resume must answer the interrupts of one run');
    }
    const [runId] = runIds;
    const pending = bureau.listPendingReviews().filter((review) => review.runId === runId);
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

    const outcomes: Array<{ interruptId: string; outcome: string }> = [];
    let continued = false;
    let executed = false;
    let superseded = false;
    let failures = 0;
    let notWritten: ApprovalOutcomeNotWrittenError | undefined;
    for (const entry of entries) {
      const review = reviews.get(entry.interruptId)!;
      if (!pendingIds.has(entry.interruptId)) {
        outcomes.push({ interruptId: entry.interruptId, outcome: 'no-op' });
        continue;
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

    if (notWritten !== undefined) {
      // The approval was decided and its tool ran, but the conversation still shows
      // it as pending, so a run that continued from it would be asked the same
      // question again. No run starts; the failure is told to the client.
      return refuse(
        'RUN_FAILED',
        'The approval was applied, but its outcome was not written into the conversation, so the run was not continued; send a new message to continue the thread',
      );
    }
    if (failures > 0 && !continued && !executed && !superseded) {
      // Nothing took effect and the reviews are still pending: the answers can be given
      // again, so this command is not recorded as done.
      return refuse('RUN_FAILED', 'The answers could not be applied; answer the interrupts again');
    }

    let result: ResumeResult;
    if (continued) {
      result = { runId: runId!, mode: 'continued', outcomes };
    } else if (executed && !superseded) {
      // The conversation now ends in the executed results, so a run with no new
      // message starts from them. Its request id is the command's key, so a
      // retry that finds the claim after a restart finds the run too.
      let created;
      try {
        created = await continuationRun(request, reviews);
      } catch {
        // The approvals are resolved and their outcomes are in the conversation, so
        // a retry of this resume finds nothing pending. The thread is not stuck: a
        // start with a new message continues from the conversation as it stands.
        return refuse(
          'RUN_FAILED',
          'The approvals were applied, but the run that continues from them could not be started; send a new message to continue the thread',
        );
      }
      result = { runId: created, mode: 'created', outcomes };
    } else {
      result = { runId: runId!, mode: 'superseded', outcomes };
    }
    await ledger.complete(pendingEntry, result);
    return result;
  }

  return resume;
}
