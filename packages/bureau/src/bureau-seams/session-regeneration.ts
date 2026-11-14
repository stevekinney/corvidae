/**
 * Session regeneration (COR-2296): replace the latest answer of a context with a new one from the
 * model, without running a tool. Built by `constructBureau` and reached only through
 * `createBureau`; the contexts facade calls into it. See `session-regenerate.ts` for the contract,
 * the ledger and the receipt. The one model call is made as a run's step makes it: held to the
 * model policy, after the run's `prepareStep` hooks and before its `validateResponse` hooks, so
 * Bureau's identity prompt and guardrails (COR-567) bind it as they bind every run.
 */
import type { AgentDefinitions } from '../agent-catalog';
import type { BureauCore, SteeringCursor } from './core';
import { BureauError, BureauShuttingDownError, ContextArchivedError } from '../bureau-errors';
import {
  BureauLedgerConflictError,
  type CommandLedgerIdentity,
  type CommandLedgerPendingEntry,
  digestCommandPayload,
} from '../command-ledger';
import type { ConditionalTextValueStore } from '@lostgradient/storage';
import type { SessionPendingReview } from '../bureau-types/reviews';
import { SessionForkRefusedError, assertBranchPoint } from '../session-fork';
import {
  REGENERATE_OPERATION_VERSION,
  REGENERATE_RECEIPT_OUTBOX_NAMESPACE,
  type RegenerateSessionRequest,
  type RegenerateSessionResult,
  SessionRegenerateRefusedError,
  historyBeforeAnswer,
  parseRegenerateReceipt,
  receiptAnswersClaim,
  regenerateReceiptPayload,
  replaceSessionAnswer,
  type RegenerateLedgerClaim,
} from '../session-regenerate';
import {
  type AgentSession,
  type GenerateResponse,
  SessionConflictError,
  type SessionStore,
  type StepContext,
  parseStepRowIdentifier,
  sessionArchivedAtOf,
  sessionOriginOf,
  sessionOwnerOf,
} from '@lostgradient/operative';
import { type AnyToolbox, createToolbox } from 'armorer';
import { Conversation, getOwn, type Message } from 'conversationalist';
import { ownerOrLocal } from '../owner-of-record';

/** The callables session regeneration reads from elsewhere in `constructBureau`. */
export interface SessionRegenerationPeers {
  /** The reviews pending on any run of this Bureau. */
  readonly listPendingReviews: () => SessionPendingReview[];
  /** Folds the durable steering log of a session into its cursor. */
  readonly catchUpSteering: (
    kv: ConditionalTextValueStore,
    sessionId: string,
    incarnation: string,
  ) => Promise<SteeringCursor>;
  /** `runtime.kv`, when this Bureau keeps durable steering. */
  readonly durableSteeringStore: () => ConditionalTextValueStore | undefined;
  /** Runs an operation after every earlier steering log operation for the session. */
  readonly enqueueSteering: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
}

/** Builds the session regeneration of one Bureau. Synchronous, and registers nothing. */

/**
 * Whether the request was aborted, read afresh at each call: an abort can land during any await,
 * and a comparison written inline is narrowed away by the first check that returned.
 */
function wasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createSessionRegeneration<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: SessionRegenerationPeers,
) {
  const { runtimeServices, runtime, steeringGates } = core;

  /** Regeneration attempts this process is running, by ledger identity, so a duplicate shares one. */
  const inFlightRegenerations = new Map<
    string,
    { digest: string; result: Promise<RegenerateSessionResult> }
  >();

  /**
   * Replaces the context's latest answer (COR-2296). See {@link BureauContexts.regenerate}. A
   * concurrent duplicate in this process shares the one attempt; one in another process finds
   * the ledger's pending claim and is answered from the committed receipt, or as in doubt.
   */
  async function regenerateSession(
    sessionId: string,
    request: RegenerateSessionRequest,
  ): Promise<RegenerateSessionResult> {
    // Read before anything awaits: a caller changing its request object later changes nothing.
    const owner = request.owner;
    const commandId = request.commandId;
    const messageId = request.messageId;
    const signal = request.signal;
    if (core.runAdmissionClosed) {
      throw new BureauShuttingDownError(
        'Cannot regenerate: Bureau is shutting down.',
        runtimeServices.clock.nowISO(),
      );
    }
    const identity: CommandLedgerIdentity = {
      callerId: owner,
      target: sessionId,
      requestId: commandId,
      operationVersion: REGENERATE_OPERATION_VERSION,
    };
    const digest = digestCommandPayload({ messageId });
    const key = JSON.stringify([identity.callerId, identity.target, identity.requestId]);
    const running = inFlightRegenerations.get(key);
    if (running !== undefined) {
      if (running.digest !== digest) throw commandConflict(commandId);
      return running.result;
    }
    const attempt = runRegenerationAttempt(sessionId, messageId, identity, digest, signal);
    inFlightRegenerations.set(key, { digest, result: attempt });
    try {
      return await attempt;
    } finally {
      inFlightRegenerations.delete(key);
    }
  }

  function commandConflict(commandId: string): SessionRegenerateRefusedError {
    return new SessionRegenerateRefusedError(
      'command-conflict',
      `The command "${commandId}" was already used to regenerate another message.`,
    );
  }

  function refuse(
    reason: SessionRegenerateRefusedError['reason'],
    message: string,
    cause?: unknown,
  ): never {
    throw new SessionRegenerateRefusedError(
      reason,
      message,
      cause === undefined ? undefined : { cause },
    );
  }

  async function runRegenerationAttempt(
    sessionId: string,
    messageId: string,
    identity: CommandLedgerIdentity,
    digest: string,
    signal: AbortSignal | undefined,
  ): Promise<RegenerateSessionResult> {
    const sessions = runtime.sessionStore;
    if (sessions === undefined) {
      throw new BureauError('This Bureau keeps no sessions to regenerate.', 'BAD_REQUEST');
    }
    const ledger = core.regenerateLedger;
    // A command already answered is answered again without judging the context afresh: the answer
    // it replaced is gone, and the retry must see what the first attempt did.
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
    // COR-2285: an archived context asks no model. An archive that commits after this read moves
    // the revision the replacement below is fenced on, so the answer is refused there.
    if (sessionArchivedAtOf(session.metadata) !== null) throw new ContextArchivedError(sessionId);
    // A retained claim under another payload is refused by the claim below, before any judgment.
    if (retained === undefined) await assertLatestEndedAnswer(session, messageId);
    const steering = await desiredSteeringOf(session);
    // The session's taint, so an agent that resolves its own guardrails starts from it, as the
    // context's runs do.
    const taintSource = { sessionId: session.id, metadata: session.metadata };
    const resolution = await runtime.resolveSessionAgentRun(
      session.agentName,
      '',
      ownerOrLocal(sessionOwnerOf(session.metadata) ?? undefined),
      undefined,
      taintSource,
    );
    if (resolution.status !== 'resolved') {
      const cause = 'error' in resolution ? resolution.error : undefined;
      return refuse(
        'generation-failed',
        `The agent "${session.agentName}" cannot answer: ${resolution.status}.`,
        cause,
      );
    }
    const agent = resolution.run;
    // COR-1996: held to the model policy as every path that runs a catalog agent holds it, so a
    // plugin code agent is judged here too, not only a file agent, whose generate judges itself.
    const generate = runtime.holdToModelPolicy(agent.options, agent.generationMode).generate;
    // COR-567: the Bureau invariants (the identity prompt and the guardrails, which an agent that
    // resolves its own carries in its tier instead), the plugin tier and the agent's own hooks,
    // composed as a run of the context composes them. Seeded from the session's taint, under the
    // session's id, as the agent tier is: no run of the context asks this model. A taint a
    // guardrail stores here is a write of the session, so the fence below then refuses the answer
    // as `history-changed`, and an exact retry, which starts tainted, asks again.
    const hooks = runtime.composeRunHooks({
      bureau: runtime.createBureauInvariantHooks(undefined, {
        agentResolvesGuardrails: agent.agentResolvesGuardrails,
        sessionTaint: runtime.sessionTaintSeam(session.id, session.id, session.metadata),
      }),
      agent: agent.options.hooks,
    });
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
      // Another attempt claimed the command first. Only the claimant asks the model.
      if (outcome.entry.state === 'completed') return structuredClone(outcome.entry.result);
      return recoverPending(sessions, outcome.entry, identity, digest);
    }
    const claimed = outcome.entry;
    // Every refusal from here until the commit leaves the history as it was, so the claim is
    // released and an exact retry may try again.
    const released = async (
      reason: SessionRegenerateRefusedError['reason'],
      message: string,
      cause?: unknown,
    ): Promise<never> => {
      await ledger.release(claimed);
      return refuse(reason, message, cause);
    };
    if (wasAborted(signal)) {
      return released('aborted', 'The request was aborted before the model was asked.');
    }
    const through = parseStepRowIdentifier(messageId);
    // A toolbox that holds no tool: a structural guarantee, not an instruction, that nothing runs.
    const toolbox: AnyToolbox = createToolbox([]);
    // One step's context, shared by its hooks and the call, so what a `prepareStep` hook adds (the
    // identity prompt) is what the model is asked over.
    const stepContext: StepContext = {
      conversation: new Conversation(historyBeforeAnswer(session.conversationHistory, messageId)),
      step: through?.step ?? 0,
      ...(signal === undefined ? {} : { signal }),
    };
    const maximumTokens = agent.options.maximumTokens;
    // `undefined` when a `prepareStep` hook answered in the model's place.
    let response: GenerateResponse | undefined;
    try {
      // `runFirst`, as the run loop dispatches it: the first handler to answer ends the question.
      const prepared = hooks.has('prepareStep')
        ? await hooks.runFirst('prepareStep', stepContext)
        : undefined;
      if (prepared === undefined) {
        const generated = await generate({
          conversation: stepContext.conversation,
          step: stepContext.step,
          toolbox,
          ...(signal === undefined ? {} : { signal }),
          ...(maximumTokens === undefined ? {} : { maximumTokens }),
          ...(steering === undefined ? {} : { steering }),
          ...(through === undefined ? {} : { runId: through.runId }),
          assistantMessageId: messageId,
        });
        // The waterfall's last answer is the response, whether a handler replaced it (a
        // redaction) or let it through; a tripwire throws, and is refused below.
        const validated = hooks.has('validateResponse')
          ? await hooks.run('validateResponse', generated, stepContext)
          : undefined;
        response = validated ?? generated;
      }
    } catch (error) {
      if (wasAborted(signal)) {
        return released('aborted', 'The request was aborted while the model answered.', error);
      }
      // A model that failed, a model the policy forbids, and a guardrail that halted the step.
      return released('generation-failed', 'The model could not answer.', error);
    }
    if (response === undefined) {
      return released(
        'generation-failed',
        'A hook answered in the model’s place, and regeneration takes only the model’s answer.',
      );
    }
    // An answer that arrives after the abort is discarded, never committed.
    if (wasAborted(signal)) {
      return released('aborted', 'The request was aborted before the answer was committed.');
    }
    if (response.toolCalls.length > 0) {
      return released(
        'answer-has-tool-calls',
        'The model asked for a tool, and regeneration runs none.',
      );
    }
    if (response.content.trim().length === 0) {
      return released('generation-failed', 'The model answered with no text.');
    }
    const previous = getOwn(session.conversationHistory.messages, messageId);
    if (previous === undefined) {
      return released('message-not-found', `The context holds no message "${messageId}".`);
    }
    const now = runtimeServices.clock.nowISO();
    const answer: Message = {
      ...previous,
      content: response.content,
      metadata: response.metadata ?? {},
      createdAt: now,
      tokenUsage: response.usage,
    };
    const result: RegenerateSessionResult = {
      contextId: session.id,
      messageId,
      incarnation: session.incarnation,
      previousRevision: session.revision,
      revision: session.revision + 1,
    };
    // Why the updater wrote nothing, as its last attempt judged it.
    const fence: { lost: 'history-changed' | 'aborted' | undefined } = { lost: undefined };
    let committed: AgentSession | undefined;
    try {
      committed = await sessions.update(
        session.id,
        (current) => {
          // The fence: the exact incarnation and revision the answer was asked over. Another
          // write, a deletion, or a deletion and a new context under the id all lose here, and the
          // updater is asked again on every contended attempt, so it is judged afresh each time.
          if (
            current === undefined ||
            current.incarnation !== session.incarnation ||
            current.revision !== session.revision
          ) {
            fence.lost = 'history-changed';
            return undefined;
          }
          if (wasAborted(signal)) {
            fence.lost = 'aborted';
            return undefined;
          }
          fence.lost = undefined;
          return replaceSessionAnswer(current, messageId, answer, now);
        },
        {
          outbox: [
            {
              namespace: REGENERATE_RECEIPT_OUTBOX_NAMESPACE,
              payload: regenerateReceiptPayload({ identity, payloadDigest: digest, result }),
            },
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
    if (committed === undefined) {
      return fence.lost === 'aborted'
        ? released('aborted', 'The request was aborted before the answer was committed.')
        : released('history-changed', 'The context changed after the answer was asked for.');
    }
    // The receipt is committed: completing the ledger here only spares the drain the work, and
    // the drain completes it from the receipt if this process stops first.
    const completed = await ledger.complete(claimed, result);
    return structuredClone(completed.result);
  }

  /**
   * A command whose claim is pending: the committed receipt answers it, completing the claim, and
   * without one it is in doubt. Never asks the model.
   */
  async function recoverPending(
    sessions: SessionStore,
    entry: CommandLedgerPendingEntry<RegenerateLedgerClaim>,
    identity: CommandLedgerIdentity,
    digest: string,
  ): Promise<RegenerateSessionResult> {
    const ledger = core.regenerateLedger;
    for (const pending of await sessions.outbox.pending()) {
      if (
        pending.kind !== 'session.attachment' ||
        pending.namespace !== REGENERATE_RECEIPT_OUTBOX_NAMESPACE ||
        pending.sessionId !== identity.target
      ) {
        continue;
      }
      const receipt = parseRegenerateReceipt(pending.payload);
      if (receipt === undefined || !receiptAnswersClaim(receipt, identity, digest, entry.claim)) {
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
      'An earlier attempt of this command has not finished and left no receipt; the answer is unchanged.',
    );
  }

  /**
   * Refuses, before the model is asked, a message that is not the last reply of the context's
   * newest run, which must have ended with no approval waiting and no call unanswered.
   */
  async function assertLatestEndedAnswer(session: AgentSession, messageId: string): Promise<void> {
    try {
      await assertBranchPoint(session, messageId, {
        record: (runId) => core.tasks.record(runId),
        pendingApprovals: async (runId) => {
          const live = peers
            .listPendingReviews()
            .filter((review) => review.kind === 'tool-approval' && review.runId === runId)
            .map((review) => review.id);
          const view = await core.tasks.get(runId);
          const durable = (view?.openWaits ?? [])
            .filter((wait) => wait.kind === 'tool-approval')
            .map((wait) => wait.reviewId);
          return [...new Set([...live, ...durable])];
        },
      });
    } catch (error) {
      if (!(error instanceof SessionForkRefusedError) || error.reason === 'command-conflict') {
        throw error;
      }
      return refuse(error.reason, error.message, error);
    }
    if (session.conversationHistory.ids.at(-1) !== messageId) {
      return refuse('not-latest-answer', 'Only the last row of the context can be regenerated.');
    }
    const through = parseStepRowIdentifier(messageId);
    const newest = await core.tasks.enumerate({ contextId: session.id, limit: 1, offset: 0 });
    if (through === undefined || newest.tasks[0]?.id !== through.runId) {
      return refuse(
        'not-latest-answer',
        "Only an answer of the context's newest run can be regenerated.",
      );
    }
  }

  /**
   * The context's desired steering as the next step would read it: the model, provider and effort
   * it was switched to. `undefined` when it has none, so the agent's own default answers. Read
   * afresh, never from the replaced answer's metadata, so a model no longer allowed is refused.
   */
  async function desiredSteeringOf(session: AgentSession) {
    const kv = peers.durableSteeringStore();
    if (kv === undefined) return steeringGates.get(session.id)?.getDesiredState();
    const cursor = await peers.enqueueSteering(session.id, () =>
      peers.catchUpSteering(kv, session.id, session.incarnation),
    );
    return cursor.gate.getDesiredState();
  }

  return { regenerateSession };
}
