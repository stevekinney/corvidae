/**
 * Resuming a context's last stopped turn (COR-2437): start a continuation run on the stored
 * conversation, with no message from the person. Built by `constructBureau` and reached only
 * through `createBureau`; the contexts facade calls into it. See `session-resume.ts` for the
 * contract, the continuation row and what is refused.
 */
import type { Mailbox } from '@lostgradient/weft';
import type { AgentDefinitions } from '../agent-catalog';
import type { BureauCore } from './core';
import type { CreateRunRequest } from '../bureau-types/runs';
import type { CreatedRunSummary } from '../command-ledger';
import { BureauError, BureauShuttingDownError, ContextArchivedError } from '../bureau-errors';
import type { SessionPendingReview } from '../bureau-types/reviews';
import type { SessionTaskFields } from '../run-request-validation';
import {
  type ResumeTurnRequest,
  type ResumeTurnResult,
  SessionResumeRefusedError,
  commandContinuesAnotherRun,
  CONTINUATION_PREVIOUS_PROJECTION_METADATA_KEY,
  continuationAdmissionFenceKey,
  continuationMarker,
  continuationRow,
  judgeResumableTurn,
  startedContinuation,
} from '../session-resume';
import { forEachOpenReceipt } from '../session-input-settlement';
import { processLeaseKey, readProcessLease } from '../process-lease';
import { TASK_OWNER_LOST_FINISH_REASON, TASK_RECORD_KEY_PREFIX } from '../task-registry';
import {
  type AgentSession,
  type SessionStore,
  sessionArchivedAtOf,
  sessionOriginOf,
} from '@lostgradient/operative';
import { getOwn, removeMessage } from 'conversationalist';

/** The finish reasons of a failed run that going on may get past: the model call itself failed. */
const RETRYABLE_FAILURES: ReadonlySet<string> = new Set(['error']);

/** The callables session resuming reads from elsewhere in `constructBureau`. */
export interface SessionResumePeers {
  /** The reviews pending on any run of this Bureau. */
  readonly listPendingReviews: () => SessionPendingReview[];
  /** The ids of the runs of one incarnation of a session that are live in any process. */
  readonly liveSessionRunIdsEverywhere: (
    sessionId: string,
    incarnation: string,
    namedRunId?: string,
  ) => Promise<string[]>;
  /** The follow-up queue of one incarnation of a session, when this Bureau keeps one. */
  readonly tryGetSessionInputMailbox: (
    sessionId: string,
    incarnation: string,
  ) => Mailbox | undefined;
  /** Creates a session run from a request, as `Bureau.createRun` does. */
  readonly createRunFromRequest: (
    request: CreateRunRequest & SessionTaskFields,
  ) => Promise<CreatedRunSummary>;
}

/** Builds the session resuming of one Bureau. Synchronous, and registers nothing. */
export function createSessionResume<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: SessionResumePeers,
) {
  const { runtimeServices, runtime } = core;

  /** Resumes this process is running, by command, so a duplicate shares one. */
  const inFlightResumes = new Map<string, { runId: string; result: Promise<ResumeTurnResult> }>();

  function refuse(reason: SessionResumeRefusedError['reason'], message: string): never {
    throw new SessionResumeRefusedError(reason, message);
  }

  /**
   * Lets the context's last stopped turn go on (COR-2437). See {@link BureauContexts.resumeTurn}.
   * A concurrent duplicate in this process shares the one attempt; one in another process loses
   * the start's atomic judgment and is answered the run the first one started.
   */
  async function resumeSessionTurn(
    sessionId: string,
    request: ResumeTurnRequest,
  ): Promise<ResumeTurnResult> {
    // Read before anything awaits: a caller changing its request object later changes nothing.
    const owner = request.owner;
    const commandId = request.commandId;
    const runId = request.runId;
    if (core.runAdmissionClosed) {
      throw new BureauShuttingDownError(
        'Cannot resume a turn: Bureau is shutting down.',
        runtimeServices.clock.nowISO(),
      );
    }
    const key = JSON.stringify([owner, sessionId, commandId]);
    const running = inFlightResumes.get(key);
    if (running !== undefined) {
      if (running.runId !== runId) {
        refuse('command-conflict', `The command "${commandId}" resumes another run's turn.`);
      }
      return running.result;
    }
    const attempt = runResumeAttempt(sessionId, runId, owner, commandId);
    inFlightResumes.set(key, { runId, result: attempt });
    try {
      return await attempt;
    } finally {
      inFlightResumes.delete(key);
    }
  }

  async function runResumeAttempt(
    sessionId: string,
    runId: string,
    owner: string,
    commandId: string,
  ): Promise<ResumeTurnResult> {
    const sessions = runtime.sessionStore;
    if (sessions === undefined) {
      throw new BureauError('This Bureau keeps no sessions to resume a turn of.', 'BAD_REQUEST');
    }
    let session = await loadVisible(sessions, sessionId);
    if (await retireOrphanedContinuation(sessions, session, runId, owner, commandId)) {
      session = await loadVisible(sessions, sessionId);
    }
    // A command that already started its continuation is answered with it, before any judgment:
    // the turn it went on from is no longer the chat's last.
    const replay = await replayOf(session, runId, owner, commandId);
    if (replay !== undefined) return replay;
    if (sessionArchivedAtOf(session.metadata) !== null) throw new ContextArchivedError(sessionId);
    await assertLastResumableRun(session, runId);
    const judged = judgeResumableTurn(session, runId);
    if (!judged.ok) return refuse(judged.reason, judged.message);
    await assertNothingQueued(session);
    let savedContinuation: { readonly runId: string; readonly incarnation: string } | undefined;
    let started: CreatedRunSummary;
    try {
      started = await peers.createRunFromRequest({
        agentName: session.agentName,
        sessionId,
        principal: owner,
        origin: { kind: 'chat' },
        appendMessagesForRun: (continuationRunId) => [
          continuationRow(
            runId,
            commandId,
            owner,
            continuationRunId,
            runtimeServices.clock.nowISO(),
            core.processLease.processId,
            JSON.stringify(stoppedProjection(session.metadata)),
          ),
        ],
        taskAdmissionFence: continuationAdmissionFenceKey,
        authorizeTaskAdmission: async (continuationRunId) => {
          if (runtime.kv === undefined) return;
          const key = continuationAdmissionFenceKey(continuationRunId);
          const authorizedReceipt = continuationReceiptValue('authorized', continuationRunId);
          const authorized = await runtime.kv.conditionalBatch(
            [{ key, expectedValue: null }],
            [{ type: 'set', key, value: authorizedReceipt }],
          );
          if (!authorized)
            throw new Error(`Continuation admission for "${continuationRunId}" was retired.`);
        },
        confirmTaskAdmission: async (continuationRunId) => {
          if (runtime.kv === undefined) return;
          const key = continuationAdmissionFenceKey(continuationRunId);
          const authorizedReceipt = continuationReceiptValue('authorized', continuationRunId);
          const launchedReceipt = continuationReceiptValue('launched', continuationRunId);
          if (
            !(await runtime.kv.conditionalBatch(
              [{ key, expectedValue: authorizedReceipt }],
              [{ type: 'set', key, value: launchedReceipt }],
            )) &&
            continuationReceipt(await runtime.kv.get(key), continuationRunId) !== 'launched'
          ) {
            throw new Error(`Continuation admission for "${continuationRunId}" was retired.`);
          }
        },
        rejectTaskAdmission: async (continuationRunId) => {
          if (runtime.kv === undefined) return true;
          const key = continuationAdmissionFenceKey(continuationRunId);
          const authorizedReceipt = continuationReceiptValue('authorized', continuationRunId);
          const rejectedReceipt = continuationReceiptValue('rejected', continuationRunId);
          if (
            await runtime.kv.conditionalBatch(
              [{ key, expectedValue: authorizedReceipt }],
              [{ type: 'set', key, value: rejectedReceipt }],
            )
          )
            return true;
          return continuationReceipt(await runtime.kv.get(key), continuationRunId) !== 'launched';
        },
        assertTaskAdmissionLive: async (continuationRunId) => {
          if (
            runtime.kv !== undefined &&
            (await runtime.kv.get(continuationAdmissionFenceKey(continuationRunId))) !== null
          ) {
            throw new Error(`Continuation admission for "${continuationRunId}" was retired.`);
          }
        },
        // Judged again inside the save that starts the run: whatever landed since wins.
        startGuard: (current: AgentSession | undefined) => {
          if (current === undefined || current.incarnation !== session.incarnation) {
            refuse('nothing-to-resume', 'The context was deleted after it was read.');
          }
          const again = judgeResumableTurn(current, runId);
          if (!again.ok) refuse(again.reason, again.message);
        },
        onSessionSaved: (continuationRunId, saved) => {
          savedContinuation = { runId: continuationRunId, incarnation: saved.incarnation };
        },
      });
    } catch (error) {
      if (savedContinuation !== undefined) {
        await rollbackFailedContinuation(
          sessions,
          session,
          runId,
          owner,
          commandId,
          savedContinuation,
        );
      }
      // A duplicate in another process may have started the continuation first: its row answers.
      if (error instanceof SessionResumeRefusedError) {
        const latest = await sessions.load(sessionId);
        const raced =
          latest === undefined ? undefined : await replayOf(latest, runId, owner, commandId);
        if (raced !== undefined) return raced;
      }
      throw error;
    }
    return { contextId: sessionId, runId: started.id, resumedRunId: runId };
  }

  /** The session, or the not-found every caller sees for one this Bureau does not show. */
  async function loadVisible(sessions: SessionStore, sessionId: string): Promise<AgentSession> {
    const session = await sessions.load(sessionId);
    // A tried chat's agent is held for it alone, as for a fork: it reads as one that does not exist.
    if (session === undefined || sessionOriginOf(session.metadata) === 'try') {
      throw new BureauError(`Session "${sessionId}" not found`, 'NOT_FOUND');
    }
    return session;
  }

  /** The answer to a command that already started its continuation, or `undefined`. */
  async function replayOf(
    session: AgentSession,
    runId: string,
    owner: string,
    commandId: string,
  ): Promise<ResumeTurnResult | undefined> {
    if (commandContinuesAnotherRun(session, runId, commandId, owner)) {
      return refuse('command-conflict', `The command "${commandId}" resumed another run's turn.`);
    }
    const started = startedContinuation(session, runId, commandId, owner);
    if (started === undefined) return undefined;
    if (started.kind === 'other-command') {
      return refuse('not-latest-turn', 'The turn already went on under another command.');
    }
    await assertContinuationStarted(started.runId);
    return { contextId: session.id, runId: started.runId, resumedRunId: runId };
  }

  /**
   * Retires a marker whose owner demonstrably died before recording its task. The lease value and
   * absent task record share one conditional write with the negative admission fence, so a paused
   * original process cannot admit after this caller has removed its marker.
   */
  async function retireOrphanedContinuation(
    sessions: SessionStore,
    session: AgentSession,
    resumedRunId: string,
    owner: string,
    _commandId: string,
  ): Promise<boolean> {
    const marker = continuationMarker(session, resumedRunId);
    if (marker === undefined || marker.owner !== owner || runtime.kv === undefined) return false;
    const { commandId: storedCommandId, continuationRunId, processId } = marker;
    if (processId === undefined || processId === '') return false;
    const lease = await readProcessLease(runtime.kv, processId, runtimeServices.clock.now());
    if (lease.state !== 'absent' && lease.state !== 'expired') return false;
    const fenceKey = continuationAdmissionFenceKey(continuationRunId);
    const taskKey = `${TASK_RECORD_KEY_PREFIX}${continuationRunId}`;
    const observedTask = await runtime.kv.get(taskKey);
    const observedReceipt = await runtime.kv.get(fenceKey);
    const state = continuationReceipt(observedReceipt, continuationRunId);
    if (state === 'authorized') {
      const task = await core.tasks.record(continuationRunId);
      if (task?.settled?.finishReason !== TASK_OWNER_LOST_FINISH_REASON) return false;
      const acknowledged = await runtime.kv.conditionalBatch(
        [
          { key: processLeaseKey(processId), expectedValue: lease.raw },
          { key: taskKey, expectedValue: observedTask },
          { key: fenceKey, expectedValue: observedReceipt },
        ],
        [
          {
            type: 'set',
            key: fenceKey,
            value: continuationReceiptValue('launched', continuationRunId),
          },
        ],
      );
      return (
        acknowledged ||
        continuationReceipt(await runtime.kv.get(fenceKey), continuationRunId) === 'launched'
      );
    }
    const replacementReceipt = continuationReceiptValue('retired', continuationRunId);
    const reserved = await runtime.kv.conditionalBatch(
      [
        { key: processLeaseKey(processId), expectedValue: lease.raw },
        { key: taskKey, expectedValue: observedTask },
        { key: fenceKey, expectedValue: observedReceipt },
      ],
      [{ type: 'set', key: fenceKey, value: replacementReceipt }],
    );
    if (!reserved) return false;
    // The fence makes a late prepared holder abandon before any lifecycle work. Its task record
    // is now a pre-launch admission only, so remove it before the replacement continuation starts.
    if (observedTask !== null) await core.tasks.remove(continuationRunId);
    let removed = false;
    await sessions.update(session.id, (current) => {
      if (current === undefined || current.incarnation !== session.incarnation) return undefined;
      const recorded = continuationMarker(current, resumedRunId);
      if (
        recorded?.commandId !== storedCommandId ||
        recorded.owner !== owner ||
        recorded.continuationRunId !== continuationRunId
      )
        return undefined;
      const projection = projectionOf(
        getOwn(current.conversationHistory.messages, `${resumedRunId}:continuation`)?.metadata?.[
          CONTINUATION_PREVIOUS_PROJECTION_METADATA_KEY
        ],
      );
      const metadata = { ...current.metadata };
      if (metadata['lastRunId'] === continuationRunId && projection !== undefined) {
        restoreStoppedProjection(metadata, projection);
      }
      removed = true;
      return {
        ...current,
        metadata,
        conversationHistory: removeMessage(
          current.conversationHistory,
          `${resumedRunId}:continuation`,
        ),
      };
    });
    return removed;
  }

  /** Refuses unless the continuation's scoped durable admission receipt was written. */
  async function assertContinuationStarted(continuationRunId: string): Promise<void> {
    if (runtime.durable === undefined) {
      if (core.store.getRun(continuationRunId) !== undefined) return;
      if (
        runtime.kv !== undefined &&
        continuationReceipt(
          await runtime.kv.get(continuationAdmissionFenceKey(continuationRunId)),
          continuationRunId,
        ) === 'launched'
      )
        return;
      return refuse('turn-running', 'The continuation is still being prepared.');
    }
    if (runtime.kv === undefined) {
      const record = await runtime.durable.engine.get(continuationRunId);
      if (record !== null && record !== undefined && record.status !== 'pending') return;
      return refuse('turn-running', 'The continuation is still being prepared.');
    }
    const receipt = await runtime.kv.get(continuationAdmissionFenceKey(continuationRunId));
    if (continuationReceipt(receipt, continuationRunId) === 'authorized') return;
    // A task and a prepared engine shell both precede authorization. Neither proves that this
    // continuation can launch: its owner may have died after prepare, and recovery may retire the
    // exact unclaimed admission. The scoped receipt is the only durable start fact.
    const task = await core.tasks.record(continuationRunId);
    if (task !== undefined) {
      return refuse('turn-running', 'The continuation is still being prepared.');
    }
    return refuse('turn-running', 'The continuation start is in doubt.');
  }

  function continuationReceipt(
    value: string | null | undefined,
    continuationRunId: string,
  ): 'authorized' | 'launched' | 'rejected' | 'retired' | undefined {
    if (value === null || value === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      const state =
        parsed !== null &&
        typeof parsed === 'object' &&
        (parsed as Record<string, unknown>)['runId'] === continuationRunId
          ? (parsed as Record<string, unknown>)['state']
          : undefined;
      return state === 'authorized' ||
        state === 'launched' ||
        state === 'rejected' ||
        state === 'retired'
        ? state
        : undefined;
    } catch {
      return undefined;
    }
  }

  function continuationReceiptValue(
    state: 'authorized' | 'launched' | 'rejected' | 'retired',
    runId: string,
  ): string {
    return JSON.stringify({ state, runId });
  }

  /**
   * Removes the marker of this exact rejected admission. The atomic update keeps rows and metadata
   * that arrived after the failure, and only restores the stopped-run projection while this failed
   * attempt still owns it.
   */
  async function rollbackFailedContinuation(
    sessions: SessionStore,
    before: AgentSession,
    resumedRunId: string,
    owner: string,
    commandId: string,
    continuation: { readonly runId: string; readonly incarnation: string },
  ): Promise<void> {
    const markerId = `${resumedRunId}:continuation`;
    await sessions.update(before.id, (current) => {
      if (current === undefined || current.incarnation !== continuation.incarnation)
        return undefined;
      const recorded = startedContinuation(current, resumedRunId, commandId, owner);
      if (recorded?.kind !== 'started' || recorded.runId !== continuation.runId) return undefined;
      const metadata = { ...current.metadata };
      if (metadata['lastRunId'] === continuation.runId) {
        restoreStoppedProjection(metadata, before.metadata);
      }
      return {
        ...current,
        metadata,
        conversationHistory: removeMessage(current.conversationHistory, markerId),
      };
    });
  }

  function restoreStoppedProjection(
    metadata: AgentSession['metadata'],
    before: AgentSession['metadata'],
  ): void {
    for (const key of [
      'lastRunId',
      'lastRunStatus',
      'lastFinishReason',
      'lastError',
      'lastRunEndReason',
    ]) {
      const value = Object.hasOwn(before, key) ? before[key] : undefined;
      if (value === undefined) delete metadata[key];
      else metadata[key] = value;
    }
  }

  function stoppedProjection(metadata: AgentSession['metadata']): AgentSession['metadata'] {
    const projection: AgentSession['metadata'] = {};
    for (const key of [
      'lastRunId',
      'lastRunStatus',
      'lastFinishReason',
      'lastError',
      'lastRunEndReason',
    ]) {
      const value = Object.hasOwn(metadata, key) ? metadata[key] : undefined;
      if (value !== undefined) projection[key] = value;
    }
    return projection;
  }

  function projectionOf(value: unknown): AgentSession['metadata'] | undefined {
    if (typeof value !== 'string') return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as AgentSession['metadata'])
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Refuses, from the task registry, a run that is not this context's last, that is going or
   * waiting on a person, whose process stopped, that finished, or that failed on a cause going on
   * would meet again. A run of another context, or of an earlier incarnation of this one, reads as
   * one the context does not have.
   */
  async function assertLastResumableRun(session: AgentSession, runId: string): Promise<void> {
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
      return refuse('not-latest-turn', 'Only the turn of the context’s last run can go on.');
    }
    const view = await core.tasks.get(runId);
    const waiting =
      (view?.openWaits.length ?? 0) > 0 ||
      peers.listPendingReviews().some((review) => review.runId === runId);
    if (waiting) {
      return refuse(
        'turn-awaiting-person',
        'The turn waits on an approval or a question, and goes on once it is answered.',
      );
    }
    const settled = record.settled;
    const live = await peers.liveSessionRunIdsEverywhere(session.id, session.incarnation, runId);
    if (settled === undefined || live.includes(runId)) {
      return refuse('turn-running', 'The turn is still going.');
    }
    if (settled.finishReason === TASK_OWNER_LOST_FINISH_REASON) {
      return refuse(
        'turn-recovering',
        'The process running the turn stopped; the Bureau that next boots goes on with the run from its checkpoint, or ends it when it cannot.',
      );
    }
    if (settled.status === 'completed') {
      return refuse(
        'turn-finished',
        'The turn finished, and a finished turn has nothing to go on with.',
      );
    }
    if (settled.status === 'failed' && !RETRYABLE_FAILURES.has(settled.finishReason ?? '')) {
      return refuse(
        'run-not-resumable',
        'The run failed on a cause that going on would only meet again.',
      );
    }
  }

  /** Refuses while a follow-up the person sent is still queued for the context. */
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

  return { resumeSessionTurn };
}
