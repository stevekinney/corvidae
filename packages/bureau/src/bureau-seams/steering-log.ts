/**
 * Steering log (COR-2376 slice S17): the durable steering log of a session, its in-process queue and gate,
 * the fold of its history into a cursor, the poller that tails it, appending then applying a steering
 * command, run-boundary recovery, the orphan sweep, and settling an abandoned run. Built by
 * `constructBureau` and reached only through `createBureau`; the parent, session input gates and
 * others call into it.
 */
import type {
  ActiveRun,
  AgentSession,
  DurableRunDeps,
  SteeringRequestedValue,
} from '@lostgradient/operative';
import type { AgentDefinitions } from '../agent-catalog';
import {
  type BureauCore,
  STEERING_APPEND_ATTEMPTS,
  type SteeringCursor,
  type SteeringFoldHistory,
} from './core';
import { BureauError } from '../bureau-errors';
import {
  type BureauSteeringGate,
  type ImplementedSteeringCommand,
  type SteeringCommandAdmissionOutcome,
  type SteeringRefusal,
  createSteeringCommandLedger,
  createSteeringGate,
  getSteeringLedgerEntry,
} from '../steering';
import { COMMITTED_ELSEWHERE, endedElsewhereAs } from '../durable-run-waits';
import type { ConditionalTextValueStore } from '@lostgradient/storage';
import {
  SteeringLogCorruptError,
  type SteeringLogEvent,
  appendSteeringLogEvent,
  deleteSteeringLog,
  listSteeringLogIncarnations,
  readSteeringLogEntries,
  readSteeringLogHead,
  steeringSessionRunTag,
} from '../steering-log';
import type { WorkflowState } from '@lostgradient/weft';
import { detachBestEffortPromise } from '../bureau-construction-support';
import { serializeUnknownError } from '../serialization';
import type { RunSummary } from '../types';

/** The callables steering log reads from elsewhere in `constructBureau`. */
export interface SteeringLogPeers {
  /** Releases the review state a terminal run held. */
  readonly releaseTerminalRunReviewState: (runId: string) => void;
  /** Aborts a run. */
  readonly abortRun: (id: string, reason?: string) => RunSummary;
  /** Abandons the session input gate of a run. */
  readonly abandonSessionInputGate: (runId: string) => void;
}

/** Builds the steering log of one Bureau. Synchronous, and registers nothing. */
export function createSteeringLog<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: SteeringLogPeers,
) {
  const {
    runtimeServices,
    store,
    runtime,
    diagnose,
    activeRuns,
    steeringGates,
    steeringRunEndWrites,
    steeringCursors,
    steeringRunIncarnations,
    settledLocalRunIds,
    steeringQueues,
    steeringPollers,
    inFlightSteeringPolls,
    steeringCommandLedger,
  } = core;

  /**
   * A run whose local handle settled with no terminal event while the store still says `running`:
   * its engine lost a checkpoint race, was disposed, or saw another engine commit the run's
   * outcome, and `driveDurableRun` stayed write-free in each case. This process no longer drives
   * the run, so its liveness is the engine's, and it stops keeping the run's input leases alive
   * (COR-1476); the claims stay, since the owner may yet replay the steps that hold them.
   *
   * COR-1614 — when the durable run is already over, the run's record here ends with that outcome
   * as well ({@link settleRunEndedElsewhere}).
   */
  function settleAbandonedRun(sessionId: string, runId: string, activeRun: ActiveRun): void {
    if (store.getRun(runId)?.status !== 'running') return;
    settledLocalRunIds.add(runId);
    releaseSessionSteeringPoll(sessionId, runId);
    peers.abandonSessionInputGate(runId);
    detachBestEffortPromise(settleRunEndedElsewhere(runId, activeRun));
  }

  /**
   * COR-1614 — ends this process's record of a run another process ended: another Bureau cancelled
   * it (`cancelDurableRun`) or timed it out (`Engine.timeout`) while this one drove it. The run
   * ends `aborted` or `error` on the store, so a stream a client opened here ends with the matching
   * terminal, the run stops counting as live and frees its concurrency slot, and this process stops
   * holding its `ActiveRun`.
   *
   * The end reaches the store only, never the run's emitter, and the store action it records is
   * marked `committedElsewhere`, which keeps it to this process's live frames. So no run hook,
   * terminal listener, session save, task record, audit record, or durable history entry comes
   * from here: the process that committed the outcome publishes what it publishes (a cancel's
   * session status), and an engine that reclaimed the run and ended it has its own driver for the
   * rest. A run whose durable state is not over (a lost checkpoint race), or cannot be read (a
   * disposed engine), stays as it was.
   */
  async function settleRunEndedElsewhere(runId: string, activeRun: ActiveRun): Promise<void> {
    let state: WorkflowState | null | undefined;
    try {
      state = await runtime.durable?.engine.get(runId);
    } catch {
      return;
    }
    const ending = state === null || state === undefined ? undefined : endedElsewhereAs(state);
    if (ending === undefined || store.getRun(runId)?.status !== 'running') return;
    store.settleRun(runId, ending.type, { error: ending.error, [COMMITTED_ELSEWHERE]: true });
    activeRuns.delete(activeRun);
    core.flowController?.settle(runId);
    queueMicrotask(() => peers.releaseTerminalRunReviewState(runId));
  }

  /** `runtime.kv`, when this bureau keeps durable steering at all. */
  function durableSteeringStore(): ConditionalTextValueStore | undefined {
    return runtime.durable && runtime.durableStorage !== undefined ? runtime.kv : undefined;
  }

  /** Runs `operation` after every earlier log operation for `sessionId`. */
  function enqueueSteering<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = steeringQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    steeringQueues.set(sessionId, settled);
    void settled.then(() => {
      if (steeringQueues.get(sessionId) === settled) steeringQueues.delete(sessionId);
      return undefined;
    });
    return next;
  }

  /** The session's gate, created on first use (non-durable bureaus). */
  function getSessionSteeringGate(sessionId: string): BureauSteeringGate {
    let gate = steeringGates.get(sessionId);
    if (gate === undefined) {
      gate = createSteeringGate(sessionId, steeringCommandLedger, runtimeServices.clock);
      steeringGates.set(sessionId, gate);
    }
    return gate;
  }

  /**
   * Applies one logged event to `gate` through the same method the live
   * path calls, with the inputs the event recorded. Deterministic: the same
   * log folds to the same state in every process.
   */
  function applySteeringEvent(
    gate: BureauSteeringGate,
    refusals: Map<string, Map<string, SteeringRefusal>>,
    event: SteeringLogEvent,
    submitted?: Map<string, Map<string, SteeringRequestedValue>>,
    // What the log so far established, when the whole log is being folded:
    // events no process could have logged after it are corruption.
    history?: SteeringFoldHistory,
  ): SteeringCommandAdmissionOutcome | undefined {
    if (history !== undefined) checkSteeringHistory(gate.sessionId, history, event);
    switch (event.type) {
      case 'admit': {
        const outcome = gate.admit(event.command, {
          liveRunIds: event.liveRunIds,
          now: event.now,
        });
        const { principal, id } = event.command;
        if (outcome.outcome === 'rejected' || outcome.outcome === 'unsupported-capability') {
          // Stored as a copy: the returned outcome is the caller's to keep.
          nestedSet(refusals, principal, id, {
            command: event.command,
            outcome: structuredClone(outcome),
            refusedAt: event.now,
          });
        }
        // Accepted or refused alike: an exact retry of the submission must
        // be recognized whichever way the gate decided.
        if (event.submittedValue !== undefined && submitted !== undefined) {
          nestedSet(submitted, principal, id, structuredClone(event.submittedValue));
        }
        return outcome;
      }
      case 'refused': {
        const { principal, id, requestedValue } = event.command;
        nestedSet(refusals, principal, id, {
          command: event.command,
          outcome: structuredClone(event.outcome),
          refusedAt: event.now,
        });
        // A refusal decided after Bureau resolved the caller's selector keeps
        // that selector; one decided before resolution was logged exactly as
        // submitted, so a `policyRef` in it is what an exact retry must match,
        // even in a process that could now resolve that selector.
        if (submitted !== undefined && event.submittedValue !== undefined) {
          nestedSet(submitted, principal, id, structuredClone(event.submittedValue));
        } else if (
          submitted !== undefined &&
          'policyRef' in requestedValue &&
          requestedValue.policyRef !== undefined
        ) {
          nestedSet(submitted, principal, id, structuredClone(requestedValue));
        }
        return structuredClone(event.outcome);
      }
      case 'applied':
        // A run observes only versions the fold so far made visible to it:
        // not later ones, and not another run's run-scoped ones. Anything
        // above that is corruption, never a floor.
        if (
          event.configVersion > gate.getRunVisibleVersion(event.runId) ||
          // Nor below what it can report at all: a boundary reports a
          // version only once there is one, and never below the version
          // the run started at.
          event.configVersion < Math.max(1, gate.getRunBaseline(event.runId))
        ) {
          throw new SteeringLogCorruptError(
            `Steering log for session "${gate.sessionId}" records run "${event.runId}" applying version ${String(event.configVersion)}, which no admission before it issued to that run.`,
          );
        }
        gate.recordApplied(event.runId, event.configVersion, event.now);
        return undefined;
      case 'promoted':
        gate.promoteForNewRun(event.runId, event.now);
        return undefined;
      case 'run-ended':
        gate.failAcceptedForRun(event.runId, event.now);
        return undefined;
    }
  }

  function createSteeringFoldHistory(): SteeringFoldHistory {
    return { runs: new Map(), keys: new Set() };
  }

  /**
   * Fails closed on history no process could have logged. A run is promoted
   * once, observes versions (`applied`) only while promoted, and ends once
   * after its promotion. A key is decided once: its binding is written in
   * the same atomic batch as its decision, conditioned on there being none.
   * Folding anything else would fail, apply, or release real commands for
   * a run that never existed or already ended, or answer one key two ways.
   */
  function checkSteeringHistory(
    sessionId: string,
    history: SteeringFoldHistory,
    event: SteeringLogEvent,
  ): void {
    const corrupt = (what: string) =>
      new SteeringLogCorruptError(`Steering log for session "${sessionId}" records ${what}.`);
    if (event.type === 'admit' || event.type === 'refused') {
      const key = JSON.stringify([event.command.principal, event.command.id]);
      if (history.keys.has(key)) {
        throw corrupt(
          `a second decision for steering key "${event.command.principal}"/"${event.command.id}"`,
        );
      }
      history.keys.add(key);
      return;
    }
    const stage = history.runs.get(event.runId);
    if (event.type === 'promoted') {
      if (stage !== undefined) throw corrupt(`run "${event.runId}" promoted again`);
      history.runs.set(event.runId, 'promoted');
      return;
    }
    if (stage !== 'promoted') {
      const verb = event.type === 'applied' ? 'applying a version' : 'ending';
      throw corrupt(
        `run "${event.runId}" ${verb} ${stage === 'ended' ? 'after it ended' : 'without a promotion'}`,
      );
    }
    if (event.type === 'run-ended') history.runs.set(event.runId, 'ended');
  }

  /** Applies a logged event to a cursor's gate and its launch markers. */
  function applyToCursor(
    cursor: SteeringCursor,
    event: SteeringLogEvent,
  ): SteeringCommandAdmissionOutcome | undefined {
    if (event.type === 'promoted') cursor.starting.set(event.runId, event.now);
    if (event.type === 'run-ended') cursor.starting.delete(event.runId);
    return applySteeringEvent(
      cursor.gate,
      cursor.refusals,
      event,
      cursor.submitted,
      cursor.history,
    );
  }

  function nestedSet<T>(
    map: Map<string, Map<string, T>>,
    outer: string,
    inner: string,
    value: T,
  ): void {
    let byInner = map.get(outer);
    if (byInner === undefined) {
      byInner = new Map();
      map.set(outer, byInner);
    }
    byInner.set(inner, value);
  }

  /**
   * A retry of an accepted command, re-expressed as the command it retries
   * when it repeats the caller's original submission exactly (a `policyRef`
   * Bureau resolved at admission). Resolving the retry again could pick a
   * different coordinate, or fail, after the policy or catalog changed;
   * matching the submission keeps the retry an exact replay.
   */
  function asSubmittedRetry(
    ledger: ReturnType<typeof createSteeringCommandLedger>,
    refusals: Map<string, Map<string, SteeringRefusal>>,
    submitted: Map<string, Map<string, SteeringRequestedValue>>,
    command: ImplementedSteeringCommand,
    rawSubmission: SteeringRequestedValue = command.requestedValue,
  ): ImplementedSteeringCommand {
    const original = submitted.get(command.principal)?.get(command.id);
    if (original === undefined) return command;
    const decided =
      getSteeringLedgerEntry(ledger, command.principal, command.id)?.requestedValue ??
      refusals.get(command.principal)?.get(command.id)?.command.requestedValue;
    if (decided === undefined) return command;
    // Compared against what the caller sent, never against a value resolved
    // afresh: a changed policy must not turn an exact retry into a conflict.
    const asked = rawSubmission as Record<string, unknown>;
    const first = original as Record<string, unknown>;
    const same =
      asked['target'] === first['target'] &&
      asked['override'] === first['override'] &&
      asked['provider'] === first['provider'] &&
      asked['policyRef'] === first['policyRef'];
    return same ? { ...command, requestedValue: decided } : command;
  }

  /**
   * Folds every entry this process has not yet applied into the session's
   * gate. The fold starts over — a fresh gate and ledger, from entry one —
   * only when the session's incarnation changed (deleted and recreated).
   * The cursor advances per entry, so a failure partway through never
   * re-applies what was already applied.
   */
  async function catchUpSteering(
    kv: ConditionalTextValueStore,
    sessionId: string,
    incarnation: string,
  ): Promise<SteeringCursor> {
    let cursor = steeringCursors.get(sessionId);
    if (cursor !== undefined && cursor.incarnation !== incarnation) {
      // The cursor is replaced only for the session's current incarnation.
      // A request for one since deleted (a boundary or poll queued before a
      // recreation) must not discard the cursor and gate the new
      // incarnation's runs read.
      const current = await runtime.sessionStore?.load(sessionId);
      if (current?.incarnation !== incarnation) {
        throw new BureauError(
          `Session "${sessionId}" no longer has incarnation "${incarnation}".`,
          'CONFLICT',
        );
      }
      forgetSessionSteering(sessionId);
      cursor = undefined;
    }
    // Live runs hold this cursor's gate, so it is never replaced while its
    // incarnation lives — only re-registered if something unmapped it.
    if (cursor !== undefined && steeringGates.get(sessionId) !== cursor.gate) {
      steeringGates.set(sessionId, cursor.gate);
    }
    if (cursor === undefined) {
      const ledger = createSteeringCommandLedger();
      const gate = createSteeringGate(sessionId, ledger, runtimeServices.clock);
      steeringGates.set(sessionId, gate);
      cursor = {
        incarnation,
        gate,
        ledger,
        refusals: new Map(),
        submitted: new Map(),
        starting: new Map(),
        history: createSteeringFoldHistory(),
        head: { raw: null, sequence: 0 },
        applied: 0,
      };
      steeringCursors.set(sessionId, cursor);
    }
    const head = await readSteeringLogHead(kv, sessionId, incarnation);
    if (head.sequence < cursor.applied) {
      // Shorter than what this process already folded: the log was deleted
      // with its session by another process, or lost entries. Nothing may be
      // appended to it, and the cursor is kept, so every later read of this
      // incarnation fails the same way rather than refolding a shortened log
      // from zero as if it were whole. A deletion is told apart by the
      // caller, which finds the incarnation gone; a recreated session has a
      // new incarnation, which resets the cursor above.
      throw new SteeringLogCorruptError(
        `Steering log for session "${sessionId}" is shorter than the ${String(cursor.applied)} entries already folded from it.`,
      );
    }
    const events = await readSteeringLogEntries(
      kv,
      sessionId,
      incarnation,
      cursor.applied,
      head.sequence,
    );
    for (const event of events) {
      applyToCursor(cursor, event);
      cursor.applied += 1;
    }
    cursor.head = head;
    return cursor;
  }

  /** How often a session with a live durable run here re-reads its log. */
  const STEERING_POLL_MS = 2_000;

  function pollSessionSteering(sessionId: string, incarnation: string, runId: string): void {
    const kv = durableSteeringStore();
    const gate = steeringCursors.get(sessionId)?.gate;
    if (kv === undefined || gate === undefined) return;
    const existing = steeringPollers.get(sessionId);
    if (existing !== undefined && existing.incarnation === incarnation && existing.gate === gate) {
      existing.runIds.add(runId);
      return;
    }
    if (existing !== undefined) {
      stopSessionSteeringPoll(sessionId);
      // A new incarnation replaced the one it polled: that one was deleted.
      // Its runs here settle as its own deletion poll would have settled
      // them: one not paused is aborted, and the paused ones are released.
      if (existing.incarnation !== incarnation) {
        for (const displacedRunId of existing.runIds) {
          if (!existing.gate.forRun(displacedRunId).getDesiredState().paused) {
            peers.abortRun(displacedRunId);
          }
        }
        existing.gate.settleForDeletion(runtimeServices.clock.nowISO());
      }
    }
    const timer = runtimeServices.timers.setInterval(() => {
      // One poll per session at a time: a slow backend skips ticks instead
      // of stacking reads behind one another.
      const current = steeringPollers.get(sessionId);
      if (current === undefined || current.inFlight !== undefined) return;
      const poll = pollSteeringOnce(kv, sessionId);
      current.inFlight = poll;
      inFlightSteeringPolls.add(poll);
      void poll.finally(() => {
        inFlightSteeringPolls.delete(poll);
        current.inFlight = undefined;
      });
    }, STEERING_POLL_MS);
    steeringPollers.set(sessionId, { incarnation, gate, runIds: new Set([runId]), timer });
  }

  async function pollSteeringOnce(kv: ConditionalTextValueStore, sessionId: string): Promise<void> {
    const poller = steeringPollers.get(sessionId);
    if (poller === undefined) return;
    try {
      const current = await runtime.sessionStore?.load(sessionId);
      if (current?.incarnation !== poller.incarnation) {
        // Deleted, or recreated, by another process. This process's runs of
        // it settle as a local deletion settles them: a run not paused is
        // aborted, and a paused one is released, since nothing can resume
        // it any more. Both finish without recreating the session: their
        // terminal saves are fenced to its incarnation.
        if (steeringPollers.get(sessionId) === poller) stopSessionSteeringPoll(sessionId);
        for (const runId of poller.runIds) {
          if (!poller.gate.forRun(runId).getDesiredState().paused) peers.abortRun(runId);
        }
        poller.gate.settleForDeletion(runtimeServices.clock.nowISO());
        return;
      }
      // Replaced while this poll read the session (deleted and recreated,
      // with a new run polling it): folding the old incarnation now would
      // replace the new cursor and gate the recreated run reads.
      await enqueueSteering(sessionId, async () => {
        if (steeringPollers.get(sessionId) !== poller) return;
        await catchUpSteering(kv, sessionId, poller.incarnation);
      });
      poller.lastFailure = undefined;
    } catch (error) {
      const failure = serializeUnknownError(error);
      if (failure === poller.lastFailure) return;
      poller.lastFailure = failure;
      diagnose({
        level: 'warn',
        scope: 'steering',
        message: `[bureau] Could not read steering for session "${sessionId}"; its runs here will see commands from other processes once it can be read: ${failure}`,
      });
    }
  }

  /** Stops polling for `runId`, and for the session once no run is left. */
  function releaseSessionSteeringPoll(sessionId: string, runId: string): void {
    const poller = steeringPollers.get(sessionId);
    if (poller === undefined) return;
    poller.runIds.delete(runId);
    if (poller.runIds.size === 0) stopSessionSteeringPoll(sessionId);
  }

  function stopSessionSteeringPoll(sessionId: string): void {
    const poller = steeringPollers.get(sessionId);
    if (poller === undefined) return;
    runtimeServices.timers.clearInterval(poller.timer);
    steeringPollers.delete(sessionId);
  }

  /** Drops this process's folded view of a session. */
  function forgetSessionSteering(sessionId: string): void {
    const cursor = steeringCursors.get(sessionId);
    if (cursor !== undefined && steeringGates.get(sessionId) === cursor.gate) {
      steeringGates.delete(sessionId);
    }
    steeringCursors.delete(sessionId);
  }

  /**
   * Appends a non-admission event after catching up, then applies it. Every
   * non-admission change to a durable gate goes through here, so the local
   * gate only ever changes in log order.
   */
  async function appendThenApplySteering(
    kv: ConditionalTextValueStore,
    sessionId: string,
    incarnation: string,
    event: Exclude<SteeringLogEvent, { type: 'admit' | 'refused' }>,
  ): Promise<void> {
    for (let attempt = 0; attempt < STEERING_APPEND_ATTEMPTS; attempt += 1) {
      const cursor = await catchUpSteering(kv, sessionId, incarnation);
      // Refused before it is written, never after: history no process could
      // log (a run's boundary outside its promotion, a version this gate
      // never issued) would leave the log unfoldable everywhere.
      if (event.type === 'promoted' && cursor.history.runs.has(event.runId)) {
        throw new BureauError(
          `Run "${event.runId}" is already in the steering log of session "${sessionId}"; a run is promoted once.`,
          'CONFLICT',
        );
      }
      // Another process ended the run first: one that adopted it after this
      // process lost it, or ended its own view of it at the same moment. The
      // log has settled the run, so this process's later boundary for it
      // has nothing to record, and logging it would make the log unfoldable.
      if (event.type !== 'promoted' && cursor.history.runs.get(event.runId) === 'ended') return;
      if (event.type !== 'promoted' && cursor.history.runs.get(event.runId) !== 'promoted') {
        throw new BureauError(
          `Run "${event.runId}" cannot log "${event.type}" in session "${sessionId}": the steering log has no live promotion of it.`,
          'CONFLICT',
        );
      }
      if (
        event.type === 'applied' &&
        (event.configVersion > cursor.gate.getRunVisibleVersion(event.runId) ||
          event.configVersion < Math.max(1, cursor.gate.getRunBaseline(event.runId)))
      ) {
        throw new BureauError(
          `Run "${event.runId}" cannot have applied steering version ${String(event.configVersion)}: session "${sessionId}" has made only ${String(cursor.gate.getRunVisibleVersion(event.runId))} visible to it.`,
          'CONFLICT',
        );
      }
      const appended = await appendSteeringLogEvent(kv, sessionId, incarnation, cursor.head, event);
      if (appended.status === 'appended') {
        applyToCursor(cursor, event);
        cursor.applied += 1;
        cursor.head = appended.head;
        return;
      }
    }
    throw steeringContention(sessionId);
  }

  /**
   * Logs a run-boundary event (a run observed a version, or ended) and
   * applies it once logged, in the session's queue. The run's own step does
   * not wait on it: per-run applied tracking lives in the run's state, so a
   * boundary event reaching the gate a moment later changes nothing the
   * run itself reads. If logging fails for good, the event is dropped (never
   * applied to a gate the log does not reflect) and a `steering` diagnostic
   * reports it.
   */
  function logRunBoundarySteering(
    sessionId: string,
    gate: BureauSteeringGate,
    event: Extract<SteeringLogEvent, { type: 'applied' | 'run-ended' }>,
  ): void {
    if (event.type === 'run-ended') {
      steeringRunIncarnations.delete(event.runId);
      releaseSessionSteeringPoll(sessionId, event.runId);
    }
    const kv = durableSteeringStore();
    const cursor = steeringCursors.get(sessionId);
    if (kv === undefined || cursor === undefined || cursor.gate !== gate) {
      // Non-durable, or a gate no longer folded from the log (its session
      // was deleted or recreated): apply directly, as an in-memory gate does.
      applySteeringEvent(gate, new Map(), event);
      return;
    }
    const { incarnation } = cursor;
    const appended = enqueueSteering(sessionId, () =>
      appendThenApplySteering(kv, sessionId, incarnation, event),
    );
    appended.catch((error: unknown) => {
      // Not applied locally: the gate must never hold state the log lacks,
      // or later admissions here would decide differently from every other
      // process. Nothing waits on it — an ended run's pause waiters are
      // released by the run's own abort — so the cost is a stale command
      // state, which the diagnostic reports.
      diagnose({
        level: 'error',
        scope: 'steering',
        message: `[bureau] Could not log a steering "${event.type}" event for run "${event.runId}" in session "${sessionId}": ${serializeUnknownError(error)}`,
      });
    });
    // COR-1476 — the `run-ended` entry is the durable write that makes the run
    // not live to every process reading `liveSessionRunIdsEverywhere`. The run's
    // session-input settlement awaits it, and retries it if it rejected, before
    // it reads the session's mailbox: the ordering that keeps an admitted input
    // from being left open.
    if (event.type === 'run-ended') steeringRunEndWrites.set(event.runId, appended);
  }

  /**
   * Folds a recovered durable run's session log and hands the run its view of
   * the gate, before replay resumes. A failure fails the recovered workflow
   * (the recovery hook rethrows), and is diagnosed.
   */
  async function recoverRunSteering(
    sessionId: string,
    session: AgentSession | undefined,
    runId: string,
    services: DurableRunDeps,
  ): Promise<BureauSteeringGate | undefined> {
    const kv = durableSteeringStore();
    if (kv === undefined || session === undefined) return undefined;
    try {
      const cursor = await enqueueSteering(sessionId, () =>
        catchUpSteering(kv, sessionId, session.incarnation),
      );
      // Ended in the log a moment before its workflow's terminal state was
      // committed (the process died in between): it has nothing left to
      // steer, and resumes without a gate rather than failing.
      if (cursor.history.runs.get(runId) === 'ended') return undefined;
      if (cursor.history.runs.get(runId) !== 'promoted') {
        // A run `createRun` started durably is tagged with its session
        // incarnation and promoted in its log before its workflow starts.
        // Tagged but not promoted, the log no longer describes it (missing,
        // emptied, or ended for it): resuming on a default gate would
        // silently drop its steering, so it fails. A workflow without the
        // tag was started elsewhere (catalog dispatch, a schedule) and never
        // had steering; it resumes without a gate, as it always has.
        const workflow = await runtime.durable?.engine.get(runId);
        if (
          workflow?.tags?.includes(steeringSessionRunTag(sessionId, session.incarnation)) !== true
        ) {
          return undefined;
        }
        throw new SteeringLogCorruptError(
          `Steering log for session "${sessionId}" has no live promotion of recovered run "${runId}".`,
        );
      }
      services.options = {
        ...services.options,
        runId,
        steering: cursor.gate.forRun(runId),
      };
      return cursor.gate;
    } catch (error) {
      // Fails the recovered workflow rather than resuming it without its
      // durable steering: the log is the only record of its desired model,
      // pause, and identity, and running on defaults would ignore them.
      diagnose({
        level: 'error',
        scope: 'steering',
        message: `[bureau] Recovered run "${runId}" cannot resume: its session's steering log could not be folded: ${serializeUnknownError(error)}`,
      });
      throw error;
    }
  }

  /**
   * Removes steering logs whose session incarnation no longer exists — left
   * behind when a process died after a session's deletion committed but
   * before its log was deleted. Safe across processes: a log is keyed by
   * incarnation, so a live session's log (any process's) is never touched,
   * and a session recreated under the same id has a different incarnation.
   */
  async function sweepOrphanedSteeringLogs(): Promise<void> {
    const kv = durableSteeringStore();
    const sessionStore = runtime.sessionStore;
    if (kv === undefined || sessionStore === undefined) return;
    for (const { sessionId, incarnation } of await listSteeringLogIncarnations(kv)) {
      const session = await sessionStore.load(sessionId);
      if (session?.incarnation === incarnation) continue;
      await enqueueSteering(sessionId, () => deleteSteeringLog(kv, sessionId, incarnation));
    }
  }

  function steeringContention(sessionId: string): BureauError {
    return new BureauError(
      `Steering log for session "${sessionId}" kept moving under ${String(STEERING_APPEND_ATTEMPTS)} consecutive append attempts.`,
      'CONFLICT',
    );
  }

  return {
    settleAbandonedRun,
    durableSteeringStore,
    enqueueSteering,
    getSessionSteeringGate,
    applySteeringEvent,
    createSteeringFoldHistory,
    applyToCursor,
    nestedSet,
    asSubmittedRetry,
    catchUpSteering,
    pollSessionSteering,
    forgetSessionSteering,
    appendThenApplySteering,
    logRunBoundarySteering,
    recoverRunSteering,
    sweepOrphanedSteeringLogs,
    steeringContention,
  };
}
