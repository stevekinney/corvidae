/**
 * Review announcements (COR-2376 slice S13): announcing a review becoming pending, following the
 * durable history of the fires that hold one, closing the requests of an abandoned fire, the live
 * action frame, and the expiry sweep's own timer. Built by `constructBureau` and reached only
 * through `createBureau`; the store subscription, child runs, fire approval restore, maintenance,
 * session restore, shutdown and review records call into it.
 */
import { ANONYMOUS_LOCAL_OWNER } from '../owner-of-record';
import type { AgentDefinitions } from '../agent-catalog';
import type { BureauCore } from './core';
import {
  EXPIRY_SWEEP_INTERVAL_MILLISECONDS,
  detachBestEffortPromise,
  needsAutomaticMaintenance,
} from '../bureau-construction-support';
import { HumanWaitParkedEvent, type StoreActionEvent } from '@lostgradient/operative';
import {
  REPLAY_SUPERSEDING_PRINCIPAL,
  REVIEW_CLOSING_EVENT_KINDS,
  REVIEW_SUPERSEDED_EVENT_KIND,
} from '../review-closing-events';
import { ReviewRequestedEvent, ReviewSupersededEvent } from '../events';
import type { RuntimeTimeoutHandle } from '@lostgradient/lifecycle';
import type { ServerFrame } from '../bureau-types/frames';
import { committedFireReviewIds } from '../scheduled-fire-review-state';
import { serializeActionDetail, serializeUnknownError } from '../serialization';

/** The callables review announcements reads from elsewhere in `constructBureau`. */
export interface ReviewAnnouncementsPeers {
  /** Whether a fire holds a tool approval. */
  readonly holdsFireApproval: (runId: string) => boolean;
  /** Sweeps the reviews that have expired. */
  readonly sweepExpiredReviews: (now?: number) => Promise<number>;
  /** Reads the ordinal of a human wait park. */
  readonly humanWaitParkOrdinal: (
    runId: string,
    actions: readonly { type: string; detail: unknown }[],
  ) => number;
  /** Emits one live frame. */
  readonly emitLiveFrame: (frame: ServerFrame) => void;
  /** Mints the next live frame sequence of a run. */
  readonly nextRunSeq: (runId: string) => number;
}

/** Builds the review announcements of one Bureau. Synchronous, and registers nothing. */
export function createReviewAnnouncements<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: ReviewAnnouncementsPeers,
) {
  const {
    options,
    runtimeServices,
    store,
    emitter,
    runtime,
    diagnose,
    currentSettings,
    catalogRunIds,
    resolvedReviewIds,
    pendingApprovalOverrides,
    invalidApprovalReviewIds,
    runAttribution,
    announcedReviewRequests,
  } = core;

  // COR-1622: the expiry sweep's own timer. The id sets whose additions check whether it is still
  // needed reach it only through `stopLazyExpirySweepWhenNoneHeld`, when an id is added, which is
  // after this factory has run, so no order of construction can read it before it exists.
  // `RuntimeTimeoutHandle` is opaque, so a flag tracks whether the timer is armed.
  let lazyExpirySweepTimer: RuntimeTimeoutHandle;
  let lazyExpirySweepArmed = false;

  /**
   * Announces one review once (`review.requested`), however many times its run reports it.
   * COR-1596: a schedule fire is not on the store, so its reviews are announced from where they
   * are registered, not from the store's action stream.
   */
  /**
   * COR-1613 — what a fire's durable history already says of its reviews, read once per run per
   * process: the ids requested, and the ids since closed. A process that replays a step finds the
   * dead one's requests here, which its own memory cannot hold.
   */
  async function readFireReviewHistory(runId: string): Promise<{
    requested: Set<string>;
    closed: Set<string>;
    /**
     * COR-1622 — the requests whose current round no decision has ended, by review id: the
     * candidates a canceled fire's boot repairs. A review's round advances only on a
     * `review.superseded` paired with that round's decision (a re-gate records the supersession,
     * then the decision of the round it leaves). A supersession with no decision after it ends the
     * request, as `closeAbandonedFireRequests` writes for a request a crashed attempt abandoned. A
     * request whose current round has a terminal event other than `review.canceled` is closed. A
     * lone `review.canceled` stays a candidate, flagged, because its audit half may be missing.
     */
    open: Map<string, { readonly round: number; readonly canceled: boolean }>;
  }> {
    const requested = new Set<string>();
    const closed = new Set<string>();
    const rounds = new Map<
      string,
      {
        round: number;
        decided: boolean;
        awaitingDecision: boolean;
        ended: boolean;
        canceled: boolean;
      }
    >();
    const open = new Map<string, { readonly round: number; readonly canceled: boolean }>();
    if (core.eventHistoryInstance === undefined) return { requested, closed, open };
    // The events this process dispatched are written asynchronously: wait for them first.
    await core.durableEventProducerInstance?.waitForActiveWrites({ kind: 'run', id: runId });
    let since: string | undefined;
    for (;;) {
      const page = await core.eventHistoryInstance.page(
        { kind: 'run', id: runId },
        { limit: 500, ...(since === undefined ? {} : { since }) },
      );
      if (!('events' in page)) break;
      for (const event of page.events) {
        const reviewId = (event.payload as { reviewId?: unknown } | null)?.reviewId;
        if (typeof reviewId !== 'string') continue;
        const state = rounds.get(reviewId) ?? {
          round: 0,
          decided: false,
          awaitingDecision: false,
          ended: false,
          canceled: false,
        };
        rounds.set(reviewId, state);
        if (event.kind === 'review.requested') requested.add(reviewId);
        else if (event.kind === 'review.canceled') {
          closed.add(reviewId);
          state.canceled = true;
        } else if (REVIEW_CLOSING_EVENT_KINDS.has(event.kind)) {
          closed.add(reviewId);
          if (state.awaitingDecision) {
            // The decision of the round a re-gate left: the next round is now the current one.
            state.round += 1;
            state.awaitingDecision = false;
            state.decided = false;
            state.canceled = false;
          } else {
            state.decided = true;
          }
        } else if (event.kind === REVIEW_SUPERSEDED_EVENT_KIND) {
          closed.add(reviewId);
          // A second supersession with no decision between them leaves the first one lone.
          if (state.awaitingDecision) state.ended = true;
          state.awaitingDecision = true;
        }
      }
      if (!page.hasMore || page.nextCursor === undefined) break;
      since = page.nextCursor;
    }
    for (const reviewId of requested) {
      const state = rounds.get(reviewId);
      if (state === undefined || state.ended || state.awaitingDecision || state.decided) continue;
      open.set(reviewId, { round: state.round, canceled: state.canceled });
    }
    return { requested, closed, open };
  }

  /** A review of the fire is held here, announced or restored: follow its history. */
  function followFireReviews(runId: string): void {
    core.fireReviewFollower?.follow(runId);
  }

  /** The fire's last review here was released: stop following its history. */
  function unfollowFireReviewsWhenNoneRemain(runId: string): void {
    if (peers.holdsFireApproval(runId) || core.runHumanWaits.holds(runId)) return;
    core.fireReviewFollower?.unfollow(runId);
  }

  /**
   * COR-1613 — announces a fire's review once across processes. A replay that makes the same call
   * under the same id finds the dead process's request in the history and does not announce it
   * again; the in-memory set alone is lost with the process.
   */
  async function announceFireReview(
    runId: string,
    reviewId: string,
    kind: 'human-wait' | 'tool-approval',
    target: { signalName?: string; callId?: string },
  ): Promise<void> {
    followFireReviews(runId);
    // The request is announced after the read of what the history already says, and a close
    // written meanwhile waits for the same read (`fireReviewSeeds.pending`), so it follows the request.
    await core.fireReviewSeeds.ensure(runId);
    announceReview(runId, reviewId, kind, target);
  }

  /**
   * COR-1613 — closes, with `review.superseded`, each request a fire's history holds that its
   * checkpoint never committed and nothing closed: the request of an attempt that died between
   * announcing it and committing its step, whose replay made the call under another id. A review
   * the run still owns, or already closed, is left alone.
   */
  async function closeAbandonedFireRequests(runId: string): Promise<void> {
    const durable = runtime.durable;
    if (durable === undefined || core.eventHistoryInstance === undefined) return;
    await core.fireReviewSeeds.pending(runId);
    const history = await readFireReviewHistory(runId);
    const committed = committedFireReviewIds(
      runId,
      await durable.checkpointStore.loadSteps(runId, { strict: true }),
    );
    for (const reviewId of history.requested) {
      if (history.closed.has(reviewId) || committed.has(reviewId)) continue;
      const kind = reviewId.startsWith('human-wait:') ? 'human-wait' : 'tool-approval';
      emitter.dispatch(
        new ReviewSupersededEvent(reviewId, runId, REPLAY_SUPERSEDING_PRINCIPAL, kind),
      );
    }
  }

  function announceReview(
    runId: string,
    reviewId: string,
    kind: 'human-wait' | 'tool-approval',
    target: { signalName?: string; callId?: string },
  ): void {
    const announced = announcedReviewRequests.get(runId) ?? new Set<string>();
    announcedReviewRequests.set(runId, announced);
    if (announced.has(reviewId)) return;
    announced.add(reviewId);
    if (kind === 'tool-approval') ensureLazyExpirySweep();
    const owner = runAttribution.get(runId)?.principal ?? ANONYMOUS_LOCAL_OWNER;
    emitter.dispatch(new ReviewRequestedEvent(reviewId, runId, owner, kind, target));
    // COR-1754 — a park changes the task's view (it now waits on its requester) without writing
    // its record, so whoever waits on the task is told here, the one place a park is noticed.
    detachBestEffortPromise(core.tasks.announceChanged(runId));
  }

  /**
   * COR-1622 — whether the Bureau's own maintenance timer runs, and so sweeps expired reviews: the
   * same rule that starts it below. A Bureau without one (no durable engine, memory or audit
   * retention to drive) would never expire an approval it holds, so it keeps a timer of its own
   * for as long as it holds one. A `'manual'` host drives the sweep with `maintain`.
   */
  function automaticMaintenanceRuns(): boolean {
    const auditRetention = currentSettings()['retention.audit'];
    return (
      needsAutomaticMaintenance({
        durableEngine: Boolean(runtime.durable),
        memory: runtime.memory !== undefined,
        keyValueStore: Boolean(runtime.kv),
        activeAuditRetention: auditRetention !== undefined && auditRetention !== 'forever',
        activeNotificationRetention: currentSettings()['retention.notifications'] !== undefined,
        activeHookDeliveryRetention: currentSettings()['retention.hookDeliveries'] !== undefined,
      }) && options.maintenance !== 'manual'
    );
  }

  /**
   * Whether this process holds a tool approval, of a live run or a restored one, counting an
   * approval whose binding has run out and that no sweep has yet released (which
   * `listPendingReviews` leaves out) and one whose resolution is in flight (not yet recorded as
   * resolved). The sweep's timer stops when this is false and not before.
   */
  function holdsToolApproval(): boolean {
    const leftOrInvalid = (id: string): boolean =>
      resolvedReviewIds.has(id) || invalidApprovalReviewIds.has(id);
    for (const [runId, runState] of store.getState().runs) {
      if (catalogRunIds.has(runId)) continue;
      for (const step of runState.steps) {
        for (const result of step.results) {
          if (result.outcome !== 'action_required' || !result.pendingApproval) continue;
          if (!leftOrInvalid(`approval:${runId}:${result.pendingApproval.callId}`)) return true;
        }
      }
    }
    for (const id of pendingApprovalOverrides.keys()) if (!leftOrInvalid(id)) return true;
    return false;
  }

  /** The check every approval's leaving makes: with none held, the sweep's timer is not needed. */
  function stopLazyExpirySweepWhenNoneHeld(): void {
    if (lazyExpirySweepArmed && !holdsToolApproval()) stopLazyExpirySweep();
  }

  function stopLazyExpirySweep(): void {
    if (!lazyExpirySweepArmed) return;
    runtimeServices.timers.clearInterval(lazyExpirySweepTimer);
    lazyExpirySweepArmed = false;
  }

  /**
   * COR-1622 — arms the expiry sweep's own timer when this Bureau holds a tool approval and no
   * other timer sweeps for it. It stops itself on the first tick that finds none held, so an idle
   * process is never kept alive by it, and `shutdown` clears it.
   */
  function ensureLazyExpirySweep(): void {
    if (
      lazyExpirySweepArmed ||
      core.automaticRunOwnershipPruneTimerStarted ||
      automaticMaintenanceRuns()
    )
      return;
    if (options.maintenance === 'manual' || core.maintenanceAdmissionClosed) return;
    lazyExpirySweepArmed = true;
    lazyExpirySweepTimer = runtimeServices.timers.setInterval(() => {
      if (core.lazyExpirySweepPass !== undefined) return;
      const pass = (async () => {
        try {
          await peers.sweepExpiredReviews();
        } catch (error: unknown) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Expired-review sweep failed: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
        stopLazyExpirySweepWhenNoneHeld();
      })().finally(() => {
        core.lazyExpirySweepPass = undefined;
      });
      core.lazyExpirySweepPass = pass;
      detachBestEffortPromise(pass);
    }, EXPIRY_SWEEP_INTERVAL_MILLISECONDS);
  }

  /**
   * Announces a review becoming pending (`review.requested`), from the action that
   * created it: a human-wait park, or a step that ended with a tool call awaiting
   * approval. Reviews are derived from run state on read and have no event of their
   * own; this is the one place that notices the moment one appears. The id is the
   * id `listPendingReviews` mints for the same review. A park that recovery
   * reconstructs (it carries a seeded `parkOrdinal`) happened in an earlier
   * process, which announced it, so it is not announced again.
   */
  function announceReviewRequests(action: {
    readonly runId: string;
    readonly type: string;
    readonly detail: unknown;
  }): void {
    const detail =
      action.detail !== null && typeof action.detail === 'object'
        ? (action.detail as Record<string, unknown>)
        : undefined;
    const announce = (
      reviewId: string,
      kind: 'human-wait' | 'tool-approval',
      target: { signalName?: string; callId?: string },
    ): void => announceReview(action.runId, reviewId, kind, target);
    if (action.type === HumanWaitParkedEvent.type) {
      const signalName = detail?.['signalName'];
      const runState = store.getRun(action.runId);
      if (typeof signalName !== 'string' || signalName.length === 0 || runState === undefined) {
        return;
      }
      if (typeof detail?.['parkOrdinal'] === 'number') return;
      const ordinal = peers.humanWaitParkOrdinal(action.runId, runState.actions);
      announce(`human-wait:${action.runId}:${signalName}:${ordinal}`, 'human-wait', { signalName });
      return;
    }
    if (action.type === 'step.completed' && Array.isArray(detail?.['results'])) {
      for (const result of detail['results'] as readonly unknown[]) {
        if (result === null || typeof result !== 'object') continue;
        const { outcome, pendingApproval } = result as {
          outcome?: unknown;
          pendingApproval?: { callId?: unknown };
        };
        const callId = pendingApproval?.callId;
        if (outcome !== 'action_required' || typeof callId !== 'string') continue;
        announce(`approval:${action.runId}:${callId}`, 'tool-approval', { callId });
      }
    }
  }

  /** A store action as the live `event` frame streams read. */
  function emitActionFrame(action: StoreActionEvent['action']): void {
    peers.emitLiveFrame({
      type: 'event',
      runId: action.runId,
      event: action.type,
      detail: serializeActionDetail(action.type, action.detail),
      sequence: action.sequence,
      runSeq: peers.nextRunSeq(action.runId),
      timestamp: action.timestamp,
    });
  }

  return {
    readFireReviewHistory,
    followFireReviews,
    unfollowFireReviewsWhenNoneRemain,
    announceFireReview,
    closeAbandonedFireRequests,
    automaticMaintenanceRuns,
    stopLazyExpirySweepWhenNoneHeld,
    stopLazyExpirySweep,
    ensureLazyExpirySweep,
    announceReviewRequests,
    emitActionFrame,
  };
}
