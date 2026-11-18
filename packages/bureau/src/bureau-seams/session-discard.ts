/**
 * Discarding a context's last unfinished turn (COR-2437): remove what a run that the person
 * stopped, or that failed, wrote after the person's message. Built by `constructBureau` and
 * reached only through `createBureau`; the contexts facade calls into it. See `session-discard.ts`
 * for the contract, the ledger and the receipt.
 */
import type { Mailbox } from '@lostgradient/weft';
import type { AgentDefinitions } from '../agent-catalog';
import type { BureauCore, ReviewAuditAttachment } from './core';
import { REVIEW_AUDIT_OUTBOX_NAMESPACE } from './core';
import { BureauError, BureauShuttingDownError, ContextArchivedError } from '../bureau-errors';
import {
  BureauLedgerConflictError,
  type CommandLedgerIdentity,
  type CommandLedgerPendingEntry,
  digestCommandPayload,
} from '../command-ledger';
import {
  DISCARD_AUDIT_TYPE,
  DISCARD_OPERATION_VERSION,
  DISCARD_RECEIPT_OUTBOX_NAMESPACE,
  type DiscardLedgerClaim,
  type DiscardTurnRequest,
  type DiscardTurnResult,
  SessionDiscardRefusedError,
  discardReceiptAnswersClaim,
  discardReceiptPayload,
  judgeDiscardableTurn,
  parseDiscardReceipt,
  removeSessionTurn,
} from '../session-discard';
import { forEachOpenReceipt } from '../session-input-settlement';
import { TASK_OWNER_LOST_FINISH_REASON } from '../task-registry';
import {
  type AgentSession,
  type JSONValue,
  SessionConflictError,
  type SessionStore,
  sessionArchivedAtOf,
  sessionOriginOf,
} from '@lostgradient/operative';

/** The callables session discarding reads from elsewhere in `constructBureau`. */
export interface SessionDiscardPeers {
  /**
   * The follow-up queue of one incarnation of a session, or `undefined` for a Bureau that keeps
   * none (nothing can be queued) or a session id it cannot address.
   */
  readonly tryGetSessionInputMailbox: (
    sessionId: string,
    incarnation: string,
  ) => Mailbox | undefined;
  /** The ids of the runs of one incarnation of a session that are live in any process. */
  readonly liveSessionRunIdsEverywhere: (
    sessionId: string,
    incarnation: string,
    namedRunId?: string,
  ) => Promise<string[]>;
}

/** Builds the session discarding of one Bureau. Synchronous, and registers nothing. */
export function createSessionDiscard<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: SessionDiscardPeers,
) {
  const { runtimeServices, runtime } = core;

  /** Discards this process is running, by ledger identity, so a duplicate shares one. */
  const inFlightDiscards = new Map<
    string,
    { digest: string; result: Promise<DiscardTurnResult> }
  >();

  /**
   * Discards the context's last unfinished turn (COR-2437). See {@link BureauContexts.discardTurn}.
   * A concurrent duplicate in this process shares the one attempt; one in another process finds
   * the ledger's pending claim and is answered from the committed receipt, or as in doubt.
   */
  async function discardSessionTurn(
    sessionId: string,
    request: DiscardTurnRequest,
  ): Promise<DiscardTurnResult> {
    // Read before anything awaits: a caller changing its request object later changes nothing.
    const owner = request.owner;
    const commandId = request.commandId;
    const runId = request.runId;
    if (core.runAdmissionClosed) {
      throw new BureauShuttingDownError(
        'Cannot discard a turn: Bureau is shutting down.',
        runtimeServices.clock.nowISO(),
      );
    }
    const identity: CommandLedgerIdentity = {
      callerId: owner,
      target: sessionId,
      requestId: commandId,
      operationVersion: DISCARD_OPERATION_VERSION,
    };
    const digest = digestCommandPayload({ runId });
    const key = JSON.stringify([identity.callerId, identity.target, identity.requestId]);
    const running = inFlightDiscards.get(key);
    if (running !== undefined) {
      if (running.digest !== digest) throw commandConflict(commandId);
      return running.result;
    }
    const attempt = runDiscardAttempt(sessionId, runId, owner, identity, digest);
    inFlightDiscards.set(key, { digest, result: attempt });
    try {
      return await attempt;
    } finally {
      inFlightDiscards.delete(key);
    }
  }

  function commandConflict(commandId: string): SessionDiscardRefusedError {
    return new SessionDiscardRefusedError(
      'command-conflict',
      `The command "${commandId}" was already used to discard another run's turn.`,
    );
  }

  function refuse(
    reason: SessionDiscardRefusedError['reason'],
    message: string,
    cause?: unknown,
  ): never {
    throw new SessionDiscardRefusedError(
      reason,
      message,
      cause === undefined ? undefined : { cause },
    );
  }

  async function runDiscardAttempt(
    sessionId: string,
    runId: string,
    owner: string,
    identity: CommandLedgerIdentity,
    digest: string,
  ): Promise<DiscardTurnResult> {
    const sessions = runtime.sessionStore;
    if (sessions === undefined) {
      throw new BureauError('This Bureau keeps no sessions to discard a turn of.', 'BAD_REQUEST');
    }
    const ledger = core.discardLedger;
    // A command already answered is answered again without judging the context afresh: the turn
    // it removed is gone, and the retry must see what the first attempt did.
    const located = await ledger.locate(identity);
    const retained = located.state === 'retained' ? located.entry : undefined;
    if (retained !== undefined && retained.payloadDigest === digest) {
      if (retained.state === 'completed') return structuredClone(retained.result);
      return recoverPending(sessions, retained, identity, digest);
    }
    const session = await sessions.load(sessionId);
    // A tried chat's agent is held for it alone, as for a fork: it reads as one that does not exist.
    if (session === undefined || sessionOriginOf(session.metadata) === 'try') {
      throw new BureauError(`Session "${sessionId}" not found`, 'NOT_FOUND');
    }
    // An archive that commits after this read moves the revision the removal is fenced on.
    if (sessionArchivedAtOf(session.metadata) !== null) throw new ContextArchivedError(sessionId);
    // A retained claim under another payload is refused by the claim below, before any judgment.
    const judged = judgeDiscardableTurn(session, runId);
    if (retained === undefined) {
      await assertLastUnfinishedRun(session, runId);
      if (!judged.ok) return refuse(judged.reason, judged.message);
      await assertNothingQueued(session);
    }
    let outcome: Awaited<ReturnType<typeof ledger.claim>>;
    try {
      outcome = await ledger.claim(identity, digest, {
        incarnation: session.incarnation,
        revision: session.revision,
      });
    } catch (error) {
      if (error instanceof BureauLedgerConflictError) throw commandConflict(identity.requestId);
      throw error;
    }
    if (outcome.outcome === 'existing') {
      if (outcome.entry.state === 'completed') return structuredClone(outcome.entry.result);
      return recoverPending(sessions, outcome.entry, identity, digest);
    }
    const claimed = outcome.entry;
    // Every refusal from here until the commit leaves the history as it was, so the claim is
    // released and an exact retry may try again.
    const released = async (
      reason: SessionDiscardRefusedError['reason'],
      message: string,
      cause?: unknown,
    ): Promise<never> => {
      await ledger.release(claimed);
      return refuse(reason, message, cause);
    };
    if (!judged.ok) return released(judged.reason, judged.message);
    const now = runtimeServices.clock.nowISO();
    const result: DiscardTurnResult = {
      contextId: session.id,
      runId,
      removed: judged.removed.length,
      incarnation: session.incarnation,
      previousRevision: session.revision,
      revision: session.revision + 1,
    };
    // The audit entry, in the shape the `audit-record` drain replays (`ReviewAuditAttachment`):
    // identifiers and a count, never a removed row's text.
    const audit = {
      runId,
      type: DISCARD_AUDIT_TYPE,
      detail: { contextId: session.id, commandId: identity.requestId, removed: result.removed },
      principal: owner,
    } satisfies ReviewAuditAttachment & JSONValue;
    // Why the updater wrote nothing, as its last attempt judged it.
    const fence: { lost: { reason: SessionDiscardRefusedError['reason']; message: string } } = {
      lost: { reason: 'history-changed', message: 'The context changed after it was read.' },
    };
    let committed: AgentSession | undefined;
    try {
      committed = await sessions.update(
        session.id,
        (current) => {
          // The fence: the exact incarnation and revision the turn was judged on. Another write, a
          // deletion, or a deletion and a new context under the id all lose here.
          if (
            current === undefined ||
            current.incarnation !== session.incarnation ||
            current.revision !== session.revision
          ) {
            fence.lost = {
              reason: 'history-changed',
              message: 'The context changed after it was read.',
            };
            return undefined;
          }
          // Judged again on what is written over, so the rows removed are the ones it holds.
          const again = judgeDiscardableTurn(current, runId);
          if (!again.ok) {
            fence.lost = { reason: again.reason, message: again.message };
            return undefined;
          }
          return removeSessionTurn(current, runId, again.removed, now);
        },
        {
          outbox: [
            {
              namespace: DISCARD_RECEIPT_OUTBOX_NAMESPACE,
              payload: discardReceiptPayload({ identity, payloadDigest: digest, result }),
            },
            { namespace: REVIEW_AUDIT_OUTBOX_NAMESPACE, payload: audit },
          ],
        },
      );
    } catch (error) {
      // Contention the store gave up on committed nothing. Any other failure may have committed,
      // so the claim stays pending for the receipt to settle.
      if (error instanceof SessionConflictError) {
        return released(
          'history-changed',
          'The context kept changing while it was written.',
          error,
        );
      }
      throw error;
    }
    if (committed === undefined) return released(fence.lost.reason, fence.lost.message);
    // The receipt is committed: completing the ledger here only spares the drain the work, and
    // the drain completes it from the receipt if this process stops first.
    const completed = await ledger.complete(claimed, result);
    return structuredClone(completed.result);
  }

  /**
   * Refuses, from the task registry, a run that is not this context's last, or that has not ended
   * without finishing: one still going (or waiting on an approval or a question), one that
   * finished normally, and one whose process stopped before it recorded its end, which recovery
   * may still pick up and which may then write again. A run of another context, or of an earlier
   * incarnation of this one, reads as one the context does not have.
   */
  async function assertLastUnfinishedRun(session: AgentSession, runId: string): Promise<void> {
    const record = await core.tasks.record(runId);
    if (
      record === undefined ||
      record.contextId !== session.id ||
      record.incarnation !== session.incarnation
    ) {
      return refuse('run-not-found', `The context has no run "${runId}".`);
    }
    const newest = await core.tasks.enumerate({ contextId: session.id, limit: 1, offset: 0 });
    if (newest.tasks[0]?.id !== runId) {
      return refuse('not-latest-turn', 'Only the turn of the context’s last run can be discarded.');
    }
    const settled = record.settled;
    const live = await peers.liveSessionRunIdsEverywhere(session.id, session.incarnation, runId);
    if (settled === undefined || live.includes(runId)) {
      return refuse('turn-running', 'The turn is still going: cancel it before discarding it.');
    }
    if (settled.status === 'completed') {
      return refuse('turn-finished', 'The turn finished normally, and a finished turn is kept.');
    }
    if (settled.finishReason === TASK_OWNER_LOST_FINISH_REASON) {
      return refuse(
        'turn-outcome-unknown',
        'The process running the turn stopped before it recorded its end, so it may still be recovered.',
      );
    }
  }

  /**
   * Refuses while a follow-up the person sent is still queued for the context: a run that ends
   * cancels what it did not deliver, and until it has, the follow-up still waits on this turn.
   */
  async function assertNothingQueued(session: AgentSession): Promise<void> {
    const mailbox = peers.tryGetSessionInputMailbox(session.id, session.incarnation);
    if (mailbox === undefined) return;
    let open = 0;
    await forEachOpenReceipt(mailbox, () => {
      open += 1;
      return Promise.resolve();
    });
    if (open > 0) {
      return refuse(
        'follow-ups-queued',
        'A follow-up the person sent is still queued for the context.',
      );
    }
  }

  /**
   * A command whose claim is pending: the committed receipt answers it, completing the claim, and
   * without one it is in doubt.
   */
  async function recoverPending(
    sessions: SessionStore,
    entry: CommandLedgerPendingEntry<DiscardLedgerClaim>,
    identity: CommandLedgerIdentity,
    digest: string,
  ): Promise<DiscardTurnResult> {
    const ledger = core.discardLedger;
    for (const pending of await sessions.outbox.pending()) {
      if (
        pending.kind !== 'session.attachment' ||
        pending.namespace !== DISCARD_RECEIPT_OUTBOX_NAMESPACE ||
        pending.sessionId !== identity.target
      ) {
        continue;
      }
      const receipt = parseDiscardReceipt(pending.payload);
      if (
        receipt === undefined ||
        !discardReceiptAnswersClaim(receipt, identity, digest, entry.claim)
      ) {
        continue;
      }
      const completed = await ledger.complete(entry, receipt.result);
      return structuredClone(completed.result);
    }
    // The drain may have completed the claim from its receipt since it was read.
    const stored = await ledger.read(identity);
    if (stored?.state === 'completed' && stored.payloadDigest === digest) {
      return structuredClone(stored.result);
    }
    return refuse(
      'command-in-doubt',
      'An earlier attempt of this command has not finished and left no receipt; the turn is unchanged.',
    );
  }

  return { discardSessionTurn };
}
