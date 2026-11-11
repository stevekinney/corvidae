/**
 * Session input gates (COR-2376 slice S17): the mailbox and gate of a session's queued input, tracking its
 * settlement, attaching recovered input, releasing, retiring and settling input after a run ends, and
 * recording that a run ended. Built by `constructBureau` and reached only through `createBureau`;
 * the parent, shutdown, the steering log and others call into it.
 */
import type { AgentDefinitions } from '../agent-catalog';
import type { BureauCore, SteeringCursor } from './core';
import type { ConditionalTextValueStore } from '@lostgradient/storage';
import { Conversation } from 'conversationalist';
import type { DurableRunDeps, SessionInputGate } from '@lostgradient/operative';
import type { Mailbox } from '@lostgradient/weft';
import {
  SESSION_INPUT_RUN_END_DIAGNOSTIC_INTERVAL_MILLISECONDS,
  SESSION_INPUT_RUN_END_RETRY_CAP_MILLISECONDS,
  SESSION_INPUT_RUN_END_RETRY_DELAY_MILLISECONDS,
} from '../bureau-construction-support';
import { SteeringLogCorruptError, type SteeringLogEvent } from '../steering-log';
import { createSessionInputDeliveryGate } from '../session-input-delivery';
import {
  createSessionInputMailbox,
  isSessionInputSessionIdAddressable,
} from '../session-input-durability';
import { forEachOpenReceipt } from '../session-input-settlement';
import { serializeUnknownError } from '../serialization';

/** The callables session input gates reads from elsewhere in `constructBureau`. */
export interface SessionInputGatesPeers {
  /** Lists the live run ids of a session across the bureau. */
  readonly liveSessionRunIdsEverywhere: (
    sessionId: string,
    incarnation: string,
    namedRunId?: string,
  ) => Promise<string[]>;
  /** Appends a steering command to the durable log, then applies it. */
  readonly appendThenApplySteering: (
    kv: ConditionalTextValueStore,
    sessionId: string,
    incarnation: string,
    event: Exclude<SteeringLogEvent, { type: 'admit' | 'refused' }>,
  ) => Promise<void>;
  /** Folds the durable steering log of a session into its cursor. */
  readonly catchUpSteering: (
    kv: ConditionalTextValueStore,
    sessionId: string,
    incarnation: string,
  ) => Promise<SteeringCursor>;
  /** Returns the durable steering store, when one is configured. */
  readonly durableSteeringStore: () => ConditionalTextValueStore | undefined;
  /** Queues a steering operation behind the others of a session. */
  readonly enqueueSteering: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
}

/** Builds the session input gates of one Bureau. Synchronous, and registers nothing. */
export function createSessionInputGates<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: SessionInputGatesPeers,
) {
  const {
    runtimeServices,
    runSessionIncarnations,
    runtime,
    diagnose,
    sessionInputSessionBacklogLimit,
    backgroundShutdownController,
    sessionInputMailboxes,
    steeringRunEndWrites,
    inFlightSessionInputSettlements,
    sessionInputClosing,
    sessionInputGates,
    sessionPersistenceSleep,
  } = core;

  /** `undefined` for a non-durable bureau — nothing to persist against. */
  function getSessionInputMailbox(sessionId: string, incarnation: string): Mailbox | undefined {
    const storage = runtime.durableStorage;
    if (!runtime.durable || storage === undefined) return undefined;
    const cacheKey = `${sessionId}\u0000${incarnation}`;
    let mailbox = sessionInputMailboxes.get(cacheKey);
    if (!mailbox) {
      mailbox = createSessionInputMailbox(
        storage,
        sessionId,
        incarnation,
        sessionInputSessionBacklogLimit(),
        runtimeServices.clock.now,
      );
      sessionInputMailboxes.set(cacheKey, mailbox);
    }
    return mailbox;
  }

  /**
   * {@link getSessionInputMailbox}, or `undefined` when Weft could not carry
   * this session id as a command's target (over its identity limit). Such a
   * session still runs and steers, but admission has no mailbox to write to,
   * so `submitSessionInput` answers it `unsupported-capability` and no input
   * can ever be waiting for its runs.
   */
  function tryGetSessionInputMailbox(sessionId: string, incarnation: string): Mailbox | undefined {
    if (!isSessionInputSessionIdAddressable(sessionId)) return undefined;
    try {
      return getSessionInputMailbox(sessionId, incarnation);
    } catch {
      return undefined;
    }
  }

  /** The settlement in flight for each ended run: a run is settled once, however many paths report its end. */
  const sessionInputSettlementsByRun = new Map<string, Promise<void>>();

  /** Tracks a settlement, which never rejects, so shutdown lands it before it tears the stores down. */
  function trackSessionInputSettlement(settling: Promise<void>): void {
    inFlightSessionInputSettlements.add(settling);
    void settling.finally(() => inFlightSessionInputSettlements.delete(settling));
  }

  /**
   * Whether `runId` will still replay or re-run the step that appended its
   * input: the run is live in some process, or is starting. A run that is not
   * live has released its claims or will never resume.
   */
  async function isSessionRunLive(
    sessionId: string,
    incarnation: string,
    runId: string,
  ): Promise<boolean> {
    const live = await peers.liveSessionRunIdsEverywhere(sessionId, incarnation, runId);
    return live.includes(runId);
  }

  /**
   * COR-1476 — the gate through which one of this session's durable runs
   * receives input `submitSessionInput` admitted while it is live. `undefined`
   * when the bureau has no durable mailbox, or the run has no recorded
   * incarnation, in which case there is nothing to deliver.
   *
   * The gate drains the mailbox of `incarnation`, the one the run started in
   * (`runSessionIncarnations`, which its first save or its recovery records,
   * or that same value read before the record is made). Each incarnation has
   * its own mailbox, so a session deleted and recreated under the same id
   * while the run is live leaves this gate draining the retired mailbox, which
   * its session's deletion cancelled and the sweep retires, and never the
   * recreated session's input: no reader checks an incarnation.
   */
  function sessionInputGateFor(
    sessionId: string,
    runId: string,
    incarnation: string | undefined,
  ): SessionInputGate | undefined {
    if (incarnation === undefined || core.sessionInputDeliveryStore === undefined) return undefined;
    const mailbox = tryGetSessionInputMailbox(sessionId, incarnation);
    if (mailbox === undefined) return undefined;
    const gate = createSessionInputDeliveryGate({
      sessionId,
      runId,
      incarnation,
      mailbox,
      deliveryStore: core.sessionInputDeliveryStore,
      isOwnerLive: (ownerRunId) => isSessionRunLive(sessionId, incarnation, ownerRunId),
      now: runtimeServices.clock.now,
      timers: runtimeServices.timers,
      signal: backgroundShutdownController.signal,
      onError: (error) =>
        diagnose({
          level: 'error',
          scope: 'session-input',
          message: `[bureau] A session-input lease of run "${runId}" in session "${sessionId}" could not be kept or retired: ${serializeUnknownError(error)}`,
          cause: error,
        }),
    });
    sessionInputGates.set(runId, { gate, sessionId });
    return gate;
  }

  /**
   * Hands a recovered durable run its session's input gate before replay
   * resumes, the way {@link recoverRunSteering} hands it its steering gate.
   */
  async function attachRecoveredSessionInput(
    sessionId: string,
    runId: string,
    services: DurableRunDeps,
    incarnation: string | undefined,
  ): Promise<void> {
    const gate = sessionInputGateFor(
      sessionId,
      runId,
      runSessionIncarnations.get(runId) ?? incarnation,
    );
    if (gate !== undefined) {
      services.options = { ...services.options, sessionId, sessionInput: gate };
    }
  }

  /**
   * The release half of a run's termination: disposes its gate, which returns
   * each lease it holds to the mailbox, and releases the run's unpromoted claims
   * so the next run can deliver them. Safe whenever it runs: an unpromoted input
   * is in no durable transcript. Needs no live bureau beyond its stores, so
   * shutdown runs it too, and never starts a run.
   */
  async function releaseSessionInputs(sessionId: string, runId: string): Promise<void> {
    const held = sessionInputGates.get(runId);
    sessionInputGates.delete(runId);
    try {
      await held?.gate.dispose?.();
      await core.sessionInputDeliveryStore?.release(sessionId, runId);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'session-input',
        message: `[bureau] Could not release the session input run "${runId}" held in session "${sessionId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  /**
   * COR-1476 — a run has ended, however it ended: completed, failed, aborted by
   * `abortRun`, cancelled by `cancelDurableRun`, or promoted but never started.
   * A run is settled once: every path that reports its end shares the one
   * settlement in flight. In this order, it
   *
   * 1. releases what it held (its gate's leases and its unpromoted claims),
   *    which reads no mailbox and so keeps the ordering below;
   * 2. writes its steering `run-ended` entry, the durable not-live write every
   *    process's `liveSessionRunIdsEverywhere` honours over the engine's status,
   *    retrying with a growing backoff until it is acknowledged, the bureau
   *    closes, or the log proves corrupt;
   * 3. catches up steering;
   * 4. reads the session's liveness without itself;
   * 5. cancels every open input whose turn is not in its checkpoint transcript,
   *    in admission order, so the client learns it was not delivered and
   *    resends it, unless another run of the session is live or starting, the
   *    bureau is closing, the write was never acknowledged, or liveness could
   *    not be read: that run's end, or the sweep, then decides. A turn the
   *    transcript holds was promoted by the write that saved it, and stays
   *    `promoted`.
   *
   * `submitSessionInput` orders itself the other way round, admission before
   * liveness, so one side always sees the other: see
   * `session-input-settlement.ts`.
   */
  function settleSessionInputsAfterRunEnd(sessionId: string, runId: string): Promise<void> {
    const inFlight = sessionInputSettlementsByRun.get(runId);
    if (inFlight !== undefined) return inFlight;
    const settling = settleSessionInputsOnce(sessionId, runId).finally(() => {
      sessionInputSettlementsByRun.delete(runId);
    });
    sessionInputSettlementsByRun.set(runId, settling);
    return settling;
  }

  async function settleSessionInputsOnce(sessionId: string, runId: string): Promise<void> {
    await releaseSessionInputs(sessionId, runId);
    const acknowledged = await recordRunEnded(sessionId, runId);
    if (!acknowledged || core.sessionInputSettlement === undefined || isSessionInputClosed())
      return;
    // The cancel pass is over the mailbox of the incarnation the run started
    // in, like its gate and its terminal save; a run with no recorded
    // incarnation drained no mailbox and has nothing to settle.
    const incarnation = runSessionIncarnations.get(runId);
    if (incarnation === undefined) return;
    try {
      const session = await runtime.sessionStore?.load(sessionId);
      // A deleted or recreated session retired this incarnation: its mailbox
      // is nobody's, so whatever is open in it is cancelled without a liveness
      // read, which its steering log, gone with the incarnation, could not
      // answer anyway. The sweep does the same for what this misses.
      const retired = session === undefined || session.incarnation !== incarnation;
      if (!retired) {
        const steeringKv = peers.durableSteeringStore();
        if (steeringKv !== undefined) {
          await peers.enqueueSteering(sessionId, () =>
            peers.catchUpSteering(steeringKv, sessionId, incarnation),
          );
        }
        const live = await peers.liveSessionRunIdsEverywhere(sessionId, incarnation);
        if (live.some((liveRunId) => liveRunId !== runId)) return;
      }
      const delivered = await sessionInputCommandsInTranscript(runId);
      await core.sessionInputSettlement.cancelUndelivered(sessionId, incarnation, delivered);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'session-input',
        message: `[bureau] Could not settle the open session input of session "${sessionId}" after run "${runId}" ended; the sweep will: ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  /**
   * Makes sure `runId`'s steering `run-ended` entry is in the log, retrying the
   * write with a backoff that doubles from 10 ms to 2 s, and reports whether it
   * is. A run the log never promoted, or whose session is gone or recreated, was
   * never counted live from the log, so there is nothing to write and the answer
   * is yes. The answer is no when the bureau closes first, or when the log
   * proves corrupt, which no retry repairs: the input is left to the sweep. The
   * first failure is reported at once and later ones at most once a minute.
   */
  async function recordRunEnded(sessionId: string, runId: string): Promise<boolean> {
    const pending = steeringRunEndWrites.get(runId);
    steeringRunEndWrites.delete(runId);
    if (pending !== undefined) {
      try {
        await pending;
        return true;
      } catch {
        // Rejected: retried below until it lands.
      }
    }
    const steeringKv = peers.durableSteeringStore();
    if (steeringKv === undefined) return true;
    let delay = SESSION_INPUT_RUN_END_RETRY_DELAY_MILLISECONDS;
    let lastReportedAt: number | undefined;
    for (let attempt = 1; ; attempt += 1) {
      if (isSessionInputClosed()) return false;
      try {
        const session = await runtime.sessionStore?.load(sessionId);
        // Gone, or recreated under the same id since the run started: the log
        // that promoted the run went with its incarnation, so there is nothing
        // to write, and the current incarnation's log never counted it live.
        const started = runSessionIncarnations.get(runId);
        if (session === undefined || (started !== undefined && session.incarnation !== started)) {
          return true;
        }
        const cursor = await peers.enqueueSteering(sessionId, () =>
          peers.catchUpSteering(steeringKv, sessionId, session.incarnation),
        );
        if (cursor.history.runs.get(runId) !== 'promoted') return true;
        await peers.enqueueSteering(sessionId, () =>
          peers.appendThenApplySteering(steeringKv, sessionId, session.incarnation, {
            type: 'run-ended',
            runId,
            now: runtimeServices.clock.nowISO(),
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof SteeringLogCorruptError) {
          diagnose({
            level: 'error',
            scope: 'session-input',
            message: `[bureau] The end of run "${runId}" in session "${sessionId}" cannot be recorded in a corrupt steering log; its open session input is left to the sweep: ${serializeUnknownError(error)}`,
            cause: error,
          });
          return false;
        }
        // Contention, a storage failure, or a session recreated under this
        // read: the next attempt reloads the session and refolds its log, so a
        // session that is gone or no longer promotes this run ends the loop.
        const now = runtimeServices.clock.now();
        if (
          lastReportedAt === undefined ||
          now - lastReportedAt >= SESSION_INPUT_RUN_END_DIAGNOSTIC_INTERVAL_MILLISECONDS
        ) {
          lastReportedAt = now;
          diagnose({
            level: 'error',
            scope: 'session-input',
            message: `[bureau] The end of run "${runId}" in session "${sessionId}" could not be recorded (attempt ${String(attempt)}); retrying before its session input is settled: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        // Shutdown ends the wait at once; the loop then sees the bureau closed.
        await Promise.race([sessionPersistenceSleep(delay), sessionInputClosing.promise]);
        delay = Math.min(delay * 2, SESSION_INPUT_RUN_END_RETRY_CAP_MILLISECONDS);
      }
    }
  }

  /** The mailbox commands whose user turns `runId`'s checkpoint transcript holds. */
  async function sessionInputCommandsInTranscript(runId: string): Promise<Set<string>> {
    const delivered = new Set<string>();
    const snapshot = await runtime.durable?.checkpointStore.loadConversation(runId);
    if (snapshot === undefined || snapshot === null) return delivered;
    for (const message of Conversation.from(snapshot, { runtime: runtimeServices }).getMessages()) {
      const commandId = message.metadata?.['sessionInputCommandId'];
      if (typeof commandId === 'string') delivered.add(commandId);
    }
    return delivered;
  }

  /** A run abandoned to another owner: stop keeping its leases alive, but keep its claims. */
  function abandonSessionInputGate(runId: string): void {
    const held = sessionInputGates.get(runId);
    sessionInputGates.delete(runId);
    void Promise.resolve(held?.gate.dispose?.()).catch((error: unknown) => {
      diagnose({
        level: 'error',
        scope: 'session-input',
        message: `[bureau] Could not stop the leases of abandoned run "${runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    });
  }

  /** Whether the bureau is shutting down, when open input is released, never cancelled. */
  function isSessionInputClosed(): boolean {
    return core.runAdmissionClosed || core.maintenanceAdmissionClosed;
  }

  /**
   * Retires the input a deleted session incarnation left pending: cancels what
   * is open in that incarnation's mailbox, and marks the incarnation so the
   * sweep keeps maintaining its mailbox until retention has emptied it, since
   * no run will drain a retired mailbox and its terminal records would
   * otherwise never retire. An admission that commits after this pass, under
   * the same marker, is cancelled by the sweep.
   */
  async function retireSessionInputs(sessionId: string, incarnation: string): Promise<void> {
    const mailbox = tryGetSessionInputMailbox(sessionId, incarnation);
    if (mailbox === undefined) return;
    await forEachOpenReceipt(mailbox, async (commandId) => {
      await mailbox.requestCancellation({ commandId, reason: 'the session was deleted' });
    });
    await core.sessionInputSettlement?.markOpen(sessionId, incarnation);
  }

  return {
    tryGetSessionInputMailbox,
    trackSessionInputSettlement,
    sessionInputGateFor,
    attachRecoveredSessionInput,
    releaseSessionInputs,
    settleSessionInputsAfterRunEnd,
    abandonSessionInputGate,
    isSessionInputClosed,
    retireSessionInputs,
  };
}
