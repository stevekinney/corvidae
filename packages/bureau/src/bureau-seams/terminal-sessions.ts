/**
 * Terminal sessions (COR-2376 slice S13): the session store guard, the chat cost budget and spend
 * record of a run, and the terminal session record a run writes when it ends, with the settlers
 * that wait for it. Built by `constructBureau` and reached only through `createBureau`; run
 * creation, recovered runs, sessions, session forks, session input admission and shutdown call
 * into it.
 */
import type { AgentDefinitions } from '../agent-catalog';
import type { AgentSession, JSONValue, RunOptions, SessionStore } from '@lostgradient/operative';
import type { BureauCore, ChatRunSpend } from './core';
import { BureauError, TerminalSessionRecordAbandonedError } from '../bureau-errors';
import type { Conversation, ConversationHistory } from 'conversationalist';
import type { SessionAgentRun } from '../runtime-composition';
import type { createSessionPersistence } from '../bureau-session-persistence';
import { serializeUnknownError } from '../serialization';

/** The callables terminal sessions reads from elsewhere in `constructBureau`. */
export interface TerminalSessionsPeers {
  /** Persists an update to a session. */
  readonly persistSessionUpdate: ReturnType<
    typeof createSessionPersistence
  >['persistSessionUpdate'];
  /** Saves a session. */
  readonly saveSession: ReturnType<typeof createSessionPersistence>['saveSession'];
  /** Settles the session inputs of a run that ended. */
  readonly settleSessionInputsAfterRunEnd: (sessionId: string, runId: string) => Promise<void>;
  /** Tracks one session input settlement. */
  readonly trackSessionInputSettlement: (settling: Promise<void>) => void;
}

/** Builds the terminal sessions of one Bureau. Synchronous, and registers nothing. */
export function createTerminalSessions<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: TerminalSessionsPeers,
) {
  const {
    runtimeServices,
    runSessionIncarnations,
    runtime,
    diagnose,
    inFlightSessionInputSettlements,
    terminalSessionRecords,
    terminalSessionRecordSettlers,
  } = core;

  function requireSessionStore(): SessionStore {
    if (!runtime.sessionStore) {
      throw new BureauError(
        'No SessionStore configured (set options.storage)',
        'NOT_CONFIGURED',
        'persistence',
      );
    }
    return runtime.sessionStore;
  }

  /**
   * The run's `costBudget` with the chat's spend so far (COR-1915), or `undefined` when the agent
   * limits no chat. A chat with no session yet has spent nothing.
   */
  async function chatCostBudgetOf(
    sessionAgent: SessionAgentRun,
    sessionId: string,
    session: { readonly incarnation?: string | undefined } | undefined,
  ): Promise<NonNullable<RunOptions['costBudget']> | undefined> {
    const budget = sessionAgent?.options.costBudget;
    if (budget?.perChatUsd === undefined) return undefined;
    let spent = 0;
    if (session?.incarnation !== undefined) {
      try {
        spent = await core.chatSpendLedger.totalOf(sessionId, session.incarnation);
      } catch (error) {
        // COR-1933 — a typed refusal, not the store's own error: the caller branches on the code.
        diagnose({
          level: 'error',
          scope: 'chat-spend',
          message: `[bureau] Could not read the spend of chat "${sessionId}": ${serializeUnknownError(error)}`,
          cause: error,
        });
        throw new BureauError(
          `The spend of chat "${sessionId}" could not be read, so its run was not started: ${serializeUnknownError(error)}`,
          'STORAGE_UNAVAILABLE',
        );
      }
    }
    return { ...budget, priorChatSpendUsd: spent };
  }

  /**
   * Writes a chat run's spend to the chat's ledger (COR-1915), before the session records how the
   * run ended (COR-1933): a crash in between then leaves a session that still says `running`, which
   * recovery reattaches and replays into a ledger that already holds the record. A run with no
   * price on its requests spent nothing the ledger can count. The ledger writes a run's record
   * once, so a terminal event a recovery replays records nothing more, and a write that fails is
   * diagnosed by the ledger and never fails the run's settlement.
   */
  async function recordChatRunSpend(
    runId: string,
    sessionId: string,
    incarnation: string | undefined,
    spend: ChatRunSpend | undefined,
  ): Promise<void> {
    const usd = spend?.costEstimate?.totalCost;
    if (spend === undefined || usd === undefined || !Number.isFinite(usd) || usd <= 0) return;
    if (incarnation === undefined) return;
    try {
      const written = await core.chatSpendLedger.record({
        sessionId,
        incarnation,
        runId,
        agentName: spend.agentName,
        owner: spend.owner,
        usd,
        recordedAt: runtimeServices.clock.nowISO(),
      });
      // COR-1933 — a chat deleted while this run ran has had its records forgotten already, so
      // the one just written would stay behind. Checked AFTER the write: either the deletion
      // committed before this read and the record is removed here, or after it, and the
      // deletion's own `forget` runs after the write and removes it.
      if (written && runtime.sessionStore) {
        const session = await runtime.sessionStore.load(sessionId);
        if (session?.incarnation !== incarnation) {
          await core.chatSpendLedger.forget(sessionId, incarnation);
        }
      }
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'chat-spend',
        message: `[bureau] Could not record the spend of run "${runId}" in chat "${sessionId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  /**
   * Persists a run's terminal session state, then settles the session's input
   * (COR-1476): the settlement reads the session as the run left it.
   */
  function persistTerminalSession(
    saveSessionUpdate: () => Promise<unknown>,
    context: {
      runId: string;
      sessionId: string;
      status: 'completed' | 'error' | 'aborted';
      /** What the run spent, for the chat's ledger (COR-1915); written before the session's save. */
      spend?: ChatRunSpend;
    },
  ): void {
    // The incarnation is read now, with the terminal event, and not after the save: the map that
    // holds it is dropped when the run's records are, which can be before the save finishes.
    const spentIn = runSessionIncarnations.get(context.runId);
    // The spend is recorded BEFORE the session's end record (COR-1933), inside the tracked save,
    // so `drain()` waits for both and a crash between them is repaired by recovery's replay.
    // `recordChatRunSpend` never rejects, and a save retry finds the record already written.
    const spendRecorded = recordChatRunSpend(
      context.runId,
      context.sessionId,
      spentIn,
      context.spend,
    );
    const recorded = peers
      .persistSessionUpdate(async () => {
        await spendRecorded;
        return saveSessionUpdate();
      }, context)
      .then(() => peers.settleSessionInputsAfterRunEnd(context.sessionId, context.runId));
    const settler = terminalSessionRecordSettlers.get(context.runId);
    terminalSessionRecordSettlers.delete(context.runId);
    if (settler !== undefined) {
      recorded.then(settler.resolve, settler.reject);
    } else {
      // A run nobody told us to expect: its record is this save.
      terminalSessionRecords.set(context.runId, recorded);
      void recorded
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          if (terminalSessionRecords.get(context.runId) === recorded) {
            terminalSessionRecords.delete(context.runId);
          }
        });
    }
    peers.trackSessionInputSettlement(recorded);
  }

  /**
   * Makes `whenRunRecorded(runId)` wait from now on, until the run's terminal save has finished,
   * even when it is asked before the run has reached its end. A durable terminal event can reach a
   * reader before this process's own run listener has started the save.
   */
  function expectTerminalSessionRecord(runId: string): void {
    if (terminalSessionRecords.has(runId)) return;
    const record = Promise.withResolvers<void>();
    terminalSessionRecords.set(runId, record.promise);
    terminalSessionRecordSettlers.set(runId, { resolve: record.resolve, reject: record.reject });
    void record.promise
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (terminalSessionRecords.get(runId) === record.promise) {
          terminalSessionRecords.delete(runId);
        }
      });
  }

  /**
   * A run that is over without its terminal save ever starting: the engine lost a checkpoint
   * compare-and-swap, or was disposed, and abandoned the run to whoever owns it
   * (`driveDurableRun`), so no terminal listener ran. Whoever waits on its record is told it will
   * not come. Rejecting writes nothing, which the abandoned path requires: another engine over the
   * same store may own the run's outcome and records it itself. A run whose save did start has no
   * settler left, so this does nothing for it.
   */
  function abandonTerminalSessionRecord(runId: string): void {
    const settler = terminalSessionRecordSettlers.get(runId);
    if (settler === undefined) return;
    terminalSessionRecordSettlers.delete(runId);
    settler.reject(new TerminalSessionRecordAbandonedError(runId));
  }

  /**
   * Resolves once the session has recorded the end of `runId`, however long its save takes, and
   * at once for a run whose end is already recorded or is not this process's.
   *
   * Rejects with `TerminalSessionRecordAbandonedError` when the run ended without this process
   * saving its end: the engine lost a checkpoint compare-and-swap, or was disposed, and abandoned
   * the run to whoever owns it, or the Bureau shut down before the save began. It settles with the
   * run's result in those cases, never with a deadline. A save that starts and keeps failing does
   * not reject: it is diagnosed after its last attempt and resolves, so a reader should check that
   * the session holds what it needs. A reader in another process can read a session that does not
   * yet hold the run's final rows, because this resolves at once for a run it does not hold.
   */
  async function whenRunRecorded(runId: string): Promise<void> {
    await terminalSessionRecords.get(runId);
  }

  /**
   * The identifiers of the rows (conversation messages) `runId` itself took session input into, in
   * delivery order. Read from the durable delivery record, which commits with the transcript the
   * run saved, so it is the same answer before and after the session records the run's end. A
   * Bureau with no session mailbox delivered none.
   */
  async function sessionInputsDeliveredBy(
    runId: string,
    sessionId: string,
  ): Promise<readonly string[]> {
    if (core.sessionInputDeliveryStore === undefined) return [];
    const records = await core.sessionInputDeliveryStore.read(sessionId);
    return Object.values(records)
      .filter((record) => record.runId === runId && record.promotion !== undefined)
      .toSorted(
        (left, right) => (left.promotion?.providerTurn ?? 0) - (right.promotion?.providerTurn ?? 0),
      )
      .flatMap((record) =>
        record.promotion === undefined ? [] : [record.promotion.conversationMessageId],
      );
  }

  /** Resolves once every run-end session-input settlement already started has finished. */
  async function drainSessionInputSettlements(): Promise<void> {
    while (inFlightSessionInputSettlements.size > 0) {
      await Promise.allSettled(inFlightSessionInputSettlements);
    }
  }

  /**
   * COR-718 — a run's terminal save, pinned to the session incarnation the run
   * started in (`runSessionIncarnations`, recorded by its first save and restored
   * on recovery), whether or not durable steering is composed. The session may
   * have expired and been recreated under another owner while the run ran, and a
   * save that is not pinned would write the run's prompt and reply into that
   * owner's session. A run with no recorded incarnation never started in any
   * session this Bureau still knows, so its save goes nowhere.
   */
  function saveRunTerminalSession(
    runId: string,
    sessionId: string,
    conversation: Conversation,
    metadata: Record<string, JSONValue>,
    agentName?: string,
    baseConversationHistory?: ConversationHistory,
  ): Promise<AgentSession | undefined> {
    if (!runtime.sessionStore) return Promise.resolve(undefined);
    const incarnation = runSessionIncarnations.get(runId);
    if (incarnation === undefined) {
      diagnose({
        level: 'warn',
        scope: 'session',
        message: `[bureau] Run "${runId}" has no recorded session incarnation; its terminal save into session "${sessionId}" was skipped rather than written into a session it did not start in.`,
      });
      return Promise.resolve(undefined);
    }
    return peers.saveSession(
      sessionId,
      conversation,
      metadata,
      agentName,
      baseConversationHistory,
      incarnation,
      runId,
    );
  }

  return {
    requireSessionStore,
    chatCostBudgetOf,
    persistTerminalSession,
    expectTerminalSessionRecord,
    abandonTerminalSessionRecord,
    whenRunRecorded,
    sessionInputsDeliveredBy,
    drainSessionInputSettlements,
    saveRunTerminalSession,
  };
}
