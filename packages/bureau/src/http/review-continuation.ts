/**
 * The run that continues a chat once the tool approvals of one of its runs are decided (COR-2016).
 *
 * A tool approval does not park its run: the run settles, the approved tool runs out of band, and
 * its outcome replaces the waiting row in the chat's conversation. Something has to start the run
 * that answers that outcome. The chat's own AG-UI resume does (`ag-ui-resume.ts`), and so does a
 * decision made through `bureau.reviews.resolve` (the Reviews page, the CLI and MCP), once the last
 * pending review of a chat-origin run is decided there.
 *
 * Both start it here, under one command id derived from the chat and the decided run alone
 * ({@link reviewContinuationCommandId}). The run-creation ledger makes a start under an id it has
 * seen return the run it started, so whichever path decides last, and in whatever order the reviews
 * were decided, one run continues the chat: a resolve racing the chat's resume, each having decided
 * some of the reviews, starts the same run twice over and gets one. A run's approvals are decided
 * once each, and one that is gated again stays pending under its id, so no run is continued twice.
 *
 * A decision through `bureau.reviews.resolve` holds no lease when it commits, so between that commit
 * and its continuation a new message can start a turn on the chat (an AG-UI start, or Interborough's
 * `POST /api/chats/{chat}/messages` through `startIdleTurn`). The continuation therefore starts the
 * way every other door does: under the thread's lease, decided by the shared admission rule
 * (`ag-ui-thread-admission.ts`). A thread that is busy, held, or taken over gets no continuation, and
 * the run that is live there answers the decided outcome, which is already in the conversation.
 *
 * @module review-continuation
 */

import type { AgentSession } from '@lostgradient/operative';
import { getOwn } from 'conversationalist';

import type {
  Bureau,
  BureauContexts,
  BureauReviews,
  BureauTasks,
  PendingToolApprovalReview,
} from '../types.ts';
import { releaseQuietly } from './ag-ui-lease.ts';
import { readSessionOwnedBy } from './ag-ui-session-owner.ts';
import { createThreadAdmission, type ThreadAdmission } from './ag-ui-thread-admission.ts';

/**
 * The command id the continuation of a decided run starts under: the same for every path that
 * decides the run's approvals, so the run-creation ledger starts it once.
 */
export function reviewContinuationCommandId(sessionId: string, runId: string): string {
  return `review-continuation:${sessionId}:${runId}`;
}

/** The conversation still shows a decided call as waiting on approval, so no run may start from it. */
export class ContinuationOutcomeNotWrittenError extends Error {
  constructor() {
    super('The conversation still shows the decided call as waiting on approval');
    this.name = 'ContinuationOutcomeNotWrittenError';
  }
}

/** What {@link startChatContinuation} reads and starts through. */
export type ChatContinuationBureau = {
  readonly tasks: Pick<BureauTasks, 'start'>;
  readonly contexts: Pick<BureauContexts, 'get'>;
};

/** The decided run a continuation answers. */
export type ChatContinuationRequest = {
  /** The chat the run belongs to. */
  readonly sessionId: string;
  /** The run whose approvals were decided. */
  readonly runId: string;
  /** The agent the chat runs, which the continuation runs as. */
  readonly agentName: string;
  /** The chat's owner of record, who owns the continuation. */
  readonly owner: string;
  /** The calls whose decided outcome the conversation must hold before a run answers it. */
  readonly callIds: readonly string[];
};

/**
 * Starts the run that answers a chat's decided approvals, or returns the one already started for
 * them, and returns its id. It starts from the conversation as it stands, so it is refused with
 * {@link ContinuationOutcomeNotWrittenError} while that conversation still shows any of `callIds`
 * as waiting on approval: the run would be asked the same question again.
 */
export async function startChatContinuation(
  bureau: ChatContinuationBureau,
  request: ChatContinuationRequest,
): Promise<string> {
  // The session is the owner's own: another owner's under the same id is a missing one, and
  // `tasks.start` below refuses it again.
  const session = await readSessionOwnedBy(bureau, request.sessionId, request.owner);
  return startContinuationFrom(bureau, request, session);
}

/**
 * {@link startChatContinuation} from a session already read, so a caller that decided admission
 * from that record starts from the same one.
 */
async function startContinuationFrom(
  bureau: Pick<ChatContinuationBureau, 'tasks'>,
  request: ChatContinuationRequest,
  session: AgentSession | undefined,
): Promise<string> {
  const history = session?.conversationHistory;
  if (history !== undefined) {
    for (const callId of request.callIds) {
      const row = history.ids
        .map((id) => getOwn(history.messages, id))
        .find((candidate) => candidate?.toolResult?.callId === callId);
      if (row?.toolResult?.outcome === 'action_required') {
        throw new ContinuationOutcomeNotWrittenError();
      }
    }
  }
  const created = await bureau.tasks.start(
    request.agentName,
    { continue: true },
    {
      contextId: request.sessionId,
      principal: request.owner,
      commandId: reviewContinuationCommandId(request.sessionId, request.runId),
      // The continuation is the chat's own: the Bureau fills the context, agent, and principal.
      origin: { kind: 'chat' },
    },
  );
  return created.id;
}

/**
 * What became of the continuation after a decision through `bureau.reviews.resolve`:
 *
 * - `started`: the decision was the last the run waited on, and `runId` continues the chat (a run
 *   another path started for the same decisions is this one).
 * - `waiting`: another review of the run is still pending, and the decision that settles it starts
 *   the continuation.
 * - `not-chat`: the run is not a chat's, so nothing continues it here.
 * - `not-started`: the decision took effect and the run should continue, but it could not be
 *   started; `reason` says why. That includes a chat another run is live on, or whose lease another
 *   start holds or took over: that run answers the decided outcome. The chat is not stuck: a new
 *   message continues from it.
 */
export type ReviewContinuationOutcome =
  | { readonly status: 'started'; readonly runId: string }
  | { readonly status: 'waiting' }
  | { readonly status: 'not-chat' }
  | { readonly status: 'not-started'; readonly reason: string };

/** Continues the chat of a tool approval that a call to `bureau.reviews.resolve` just applied. */
export type ReviewContinuation = (
  decided: PendingToolApprovalReview,
) => Promise<ReviewContinuationOutcome>;

/** What {@link createReviewContinuation} reads, and the store and clock the thread's lease is kept with. */
export type ReviewContinuationBureau = {
  readonly tasks: Pick<BureauTasks, 'get' | 'start' | 'workflow'>;
  readonly contexts: Pick<BureauContexts, 'get'>;
  readonly reviews: Pick<BureauReviews, 'list' | 'pendingOf'>;
  readonly internals: Pick<Bureau['internals'], 'kv'>;
  readonly runtimeServices: Bureau['runtimeServices'];
};

/** Why a continuation that should have started did not, as a person reads it. */
const NOT_STARTED_REASONS = {
  noAgent: 'The run names no agent to continue it as',
  outcomeNotWritten:
    'The conversation still shows the decided call as waiting on approval, so no run continued it',
  failed: 'The run that continues the chat could not be started',
  threadBusy:
    'Another run is live on the chat, or is starting there, so it answers the decision and no second run started',
  leaseLost: 'Another start took the chat while this one was deciding, so no run continued it',
  noLeaseStore: 'The Bureau has no store to hold the chat’s lease in, so no run continued it',
} as const;

/**
 * The continuation `bureau.reviews.resolve` runs after it applies a tool approval: once no review
 * of a chat-origin run is still pending, it starts the run that answers the decisions, owned by the
 * chat's owner of record, whoever decided. It starts under the chat's thread lease and only when
 * the shared admission rule finds the chat idle, as every other start on a chat does.
 */
export function createReviewContinuation(bureau: ReviewContinuationBureau): ReviewContinuation {
  // One admission for every decision, as the AG-UI mount builds one for every start. Built on the
  // first decision, so a Bureau with no store to hold a lease in refuses that decision's
  // continuation instead of failing to compose.
  let admission: ThreadAdmission | undefined;
  const admissionFor = (): ThreadAdmission | undefined => {
    if (bureau.internals.kv === undefined) return undefined;
    admission ??= createThreadAdmission({ bureau, runtime: bureau.runtimeServices });
    return admission;
  };
  return async (decided) => {
    const task = await bureau.tasks.get(decided.runId).catch(() => undefined);
    if (task === undefined || task.origin?.kind !== 'chat') return { status: 'not-chat' };
    // The reviews of the run a person can still be asked, as the chat's own resume reads them: this
    // process's, and the waits a run another process holds is parked on.
    const derived = await bureau.reviews.pendingOf(decided.runId).catch(() => []);
    const pending = [...bureau.reviews.list(), ...derived].some(
      (review) => review.runId === decided.runId && review.id !== decided.id,
    );
    if (pending) return { status: 'waiting' };
    const agentName = decided.agentName ?? task.agentName;
    if (agentName === null) return { status: 'not-started', reason: NOT_STARTED_REASONS.noAgent };
    const thread = admissionFor();
    if (thread === undefined)
      return { status: 'not-started', reason: NOT_STARTED_REASONS.noLeaseStore };
    // Another start or resume holds the chat: whatever it starts answers the decided outcome.
    const lease = await thread.leases.acquire('thread', decided.sessionId);
    if (lease === undefined)
      return { status: 'not-started', reason: NOT_STARTED_REASONS.threadBusy };
    try {
      // Read again under the lease: admission and the start below are decided from this record. A
      // read that fails is a busy thread, because a start admitted on a guess forks the thread.
      let session: AgentSession | undefined;
      try {
        session = await readSessionOwnedBy(bureau, decided.sessionId, task.owner);
      } catch {
        return { status: 'not-started', reason: NOT_STARTED_REASONS.threadBusy };
      }
      // Admission alone decides. When it refuses, the same rule is asked again only to word the
      // reason: a newer read can change the words, never whether a run started.
      const admitted = await thread.admit(lease, session, () =>
        startContinuationFrom(
          bureau,
          {
            sessionId: decided.sessionId,
            runId: decided.runId,
            agentName,
            owner: task.owner,
            callIds: [decided.approval.callId],
          },
          session,
        ),
      );
      if (!admitted.admitted) {
        const busy = await thread.threadBusy(session);
        return {
          status: 'not-started',
          reason: busy ? NOT_STARTED_REASONS.threadBusy : NOT_STARTED_REASONS.leaseLost,
        };
      }
      return { status: 'started', runId: admitted.value };
    } catch (error) {
      return {
        status: 'not-started',
        reason:
          error instanceof ContinuationOutcomeNotWrittenError
            ? NOT_STARTED_REASONS.outcomeNotWritten
            : NOT_STARTED_REASONS.failed,
      };
    } finally {
      await releaseQuietly(lease);
    }
  };
}
