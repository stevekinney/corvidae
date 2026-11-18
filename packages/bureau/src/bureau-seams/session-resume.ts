/**
 * Resuming a context's last stopped turn (COR-2437). Built by `constructBureau` and reached only
 * through `createBureau`; the contexts facade calls into it. See `session-resume.ts` for what a
 * stopped run leaves and why each kind is refused: no path here starts or writes anything.
 */
import type { AgentDefinitions } from '../agent-catalog';
import type { BureauCore } from './core';
import { BureauError, BureauShuttingDownError, ContextArchivedError } from '../bureau-errors';
import type { SessionPendingReview } from '../bureau-types/reviews';
import {
  type ResumeTurnRequest,
  type ResumeTurnResult,
  SessionResumeRefusedError,
} from '../session-resume';
import { TASK_OWNER_LOST_FINISH_REASON } from '../task-registry';
import { sessionArchivedAtOf, sessionOriginOf } from '@lostgradient/operative';

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
}

/** Builds the session resuming of one Bureau. Synchronous, and registers nothing. */
export function createSessionResume<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: SessionResumePeers,
) {
  const { runtimeServices, runtime } = core;

  function refuse(reason: SessionResumeRefusedError['reason'], message: string): never {
    throw new SessionResumeRefusedError(reason, message);
  }

  /**
   * Judges whether the context's last turn can go on (COR-2437). See
   * {@link BureauContexts.resumeTurn}. Every kind of stop is refused today, each for its own
   * reason, and nothing is started or written.
   */
  async function resumeSessionTurn(
    sessionId: string,
    request: ResumeTurnRequest,
  ): Promise<ResumeTurnResult> {
    // Read before anything awaits: a caller changing its request object later changes nothing.
    const runId = request.runId;
    if (core.runAdmissionClosed) {
      throw new BureauShuttingDownError(
        'Cannot resume a turn: Bureau is shutting down.',
        runtimeServices.clock.nowISO(),
      );
    }
    const sessions = runtime.sessionStore;
    if (sessions === undefined) {
      throw new BureauError('This Bureau keeps no sessions to resume a turn of.', 'BAD_REQUEST');
    }
    const session = await sessions.load(sessionId);
    // A tried chat's agent is held for it alone, as for a fork: it reads as one that does not exist.
    if (session === undefined || sessionOriginOf(session.metadata) === 'try') {
      throw new BureauError(`Session "${sessionId}" not found`, 'NOT_FOUND');
    }
    if (sessionArchivedAtOf(session.metadata) !== null) throw new ContextArchivedError(sessionId);
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
      return refuse('not-latest-turn', 'Only the turn of the context’s last run could go on.');
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
        'The process running the turn stopped, and the Bureau recovers the run itself from where it was.',
      );
    }
    if (settled.status === 'completed') {
      return refuse(
        'turn-finished',
        'The turn finished, and a finished turn has nothing to go on with.',
      );
    }
    return refuse(
      'run-not-resumable',
      'The turn was stopped or failed, and its run has ended: it cannot go on as the same run.',
    );
  }

  return { resumeSessionTurn };
}
