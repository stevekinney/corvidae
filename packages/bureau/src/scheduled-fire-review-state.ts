/**
 * The in-memory state a schedule fire's tool approval holds while it is a pending review
 * (COR-1596), kept apart from `createBureau`'s closure so each rule is a function a test can
 * call with plain maps.
 *
 * A fire has no `ActiveRun` on the run store, so the store scan in `listPendingReviews` never
 * sees its approval. The approval is registered here as its step records it, and listed by the
 * terminal-run loop at the end of that function, which reads `terminalReviewSessions`. The set
 * `scheduledFireApprovalRuns` is not that loop's gate: it marks the runs whose per-run state is a
 * fire's, so the release, the resolution's persisted prune, and the expiry sweep end that state
 * where a run on the store would have ended it with its removal from the store.
 *
 * @module scheduled-fire-review-state
 */

import type { ToolRequestContext } from 'armorer';

import type { BureauToolbox } from './runtime-composition';
import type { PendingReview } from './types';

type ToolApproval = Extract<PendingReview, { kind: 'tool-approval' }>['approval'];

/** The maps and sets of `createBureau` that a fire's approval is recorded in. */
export type ScheduledFireReviewState = {
  readonly pendingApprovalOverrides: Map<string, ToolApproval>;
  readonly pendingApprovalRounds: Map<string, number>;
  readonly terminalReviewSessions: Map<
    string,
    { sessionId: string; agentName: string; requestedAt: number }
  >;
  readonly runRequestContexts: Map<string, ToolRequestContext>;
  readonly runToolboxesByRunId: Map<string, BureauToolbox>;
  readonly resolvedReviewIds: Set<string>;
  readonly invalidApprovalReviewIds: Set<string>;
  /** The runs of schedule fires that hold a tool approval, registered or restored. */
  readonly scheduledFireApprovalRuns: Set<string>;
  /**
   * The fires whose approval was left by a step that was not their last, so they take another
   * step, and that step's write-back would put the approval's stale row over its outcome.
   */
  readonly continuingScheduledFires: Set<string>;
  readonly now: () => number;
};

/** What a fire's approval needs of the fire. */
export type ScheduledFireApprovalTarget = {
  readonly runId: string;
  readonly sessionId: string;
  readonly agentName: string;
  readonly requestContext: ToolRequestContext;
};

/**
 * Lists a fire's tool approval as a review. Idempotent by review id: a replayed step lists the
 * same review once, and never replaces the approval a re-gate (round above zero) has put in its
 * place. An approval another attempt left behind is replaced: only a step that survived to commit
 * is restored (see `committedScheduledFireApprovalIds`), so what a live step registers is current.
 */
export function registerScheduledFireApproval(
  state: ScheduledFireReviewState,
  fire: ScheduledFireApprovalTarget,
  toolbox: BureauToolbox,
  reviewId: string,
  approval: ToolApproval,
  stepWasFinal: boolean,
): void {
  if (state.resolvedReviewIds.has(reviewId) || state.invalidApprovalReviewIds.has(reviewId)) {
    return;
  }
  if ((state.pendingApprovalRounds.get(reviewId) ?? 0) === 0) {
    state.pendingApprovalOverrides.set(reviewId, approval);
  }
  state.scheduledFireApprovalRuns.add(fire.runId);
  if (!stepWasFinal) state.continuingScheduledFires.add(fire.runId);
  if (!state.terminalReviewSessions.has(fire.runId)) {
    state.terminalReviewSessions.set(fire.runId, {
      sessionId: fire.sessionId,
      agentName: fire.agentName,
      requestedAt: state.now(),
    });
  }
  state.runRequestContexts.set(fire.runId, fire.requestContext);
  state.runToolboxesByRunId.set(fire.runId, toolbox);
}

/** Marks a run the boot restore recovered as a fire's, so its state is released as a fire's is. */
export function adoptRestoredScheduledFire(state: ScheduledFireReviewState, runId: string): void {
  state.scheduledFireApprovalRuns.add(runId);
}

/**
 * A fire has settled, so it takes no further step: an approval it left behind keeps its outcome
 * when it is decided. This is not part of the release, which runs when the approval is decided,
 * before its outcome is written, and that write has to know whether the fire is still going.
 */
export function endContinuingScheduledFire(state: ScheduledFireReviewState, runId: string): void {
  state.continuingScheduledFires.delete(runId);
}

/**
 * Ends a fire's per-run review state once it holds no review: the request context and toolbox
 * (which keeps the fire's services alive), its entry in the fire set, and the in-memory ids of
 * its resolved approvals. Persisted ids are retired with the fire's task, not here, because they
 * fence a concurrent resolver. Returns whether the run was a fire's.
 */
export function releaseScheduledFireReviews(
  state: ScheduledFireReviewState,
  runId: string,
): boolean {
  if (!state.scheduledFireApprovalRuns.delete(runId)) return false;
  state.runRequestContexts.delete(runId);
  state.runToolboxesByRunId.delete(runId);
  state.terminalReviewSessions.delete(runId);
  const prefix = `approval:${runId}:`;
  for (const id of state.resolvedReviewIds) {
    if (id.startsWith(prefix)) state.resolvedReviewIds.delete(id);
  }
  for (const id of state.pendingApprovalRounds.keys()) {
    if (id.startsWith(prefix)) state.pendingApprovalRounds.delete(id);
  }
  return true;
}

/**
 * The review ids of the tool approvals a run's checkpoint holds, which is the only source of truth
 * for which of a fire's approvals exist (COR-1596). A fire's session records an approval before
 * the step that raised it commits, so the session's record is a claim, and a reader of it, at boot
 * or when the fire settles, checks it against these.
 */
export function committedFireApprovalIds(
  runId: string,
  steps: readonly {
    readonly results: readonly { readonly outcome: string; readonly pendingApproval?: unknown }[];
  }[],
): Set<string> {
  const committed = new Set<string>();
  for (const step of steps) {
    for (const result of step.results) {
      if (result.outcome !== 'action_required' || result.pendingApproval === undefined) continue;
      const callId = (result.pendingApproval as { callId?: unknown }).callId;
      if (typeof callId === 'string') committed.add(`approval:${runId}:${callId}`);
    }
  }
  return committed;
}
