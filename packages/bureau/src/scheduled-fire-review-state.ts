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

import { type JSONValue, parkedSignalName } from '@lostgradient/operative';
import type { ToolRequestContext } from 'armorer';

import type { BureauToolbox } from './runtime-composition';
import { isPlainAuthorityRecord } from './session-authority';
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
  /** When each approval was requested, so a fire that raises several lists each at its own time. */
  readonly approvalRequestedAt: Map<string, number>;
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
  if (!state.approvalRequestedAt.has(reviewId)) {
    state.approvalRequestedAt.set(reviewId, state.now());
  }
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
  for (const id of state.approvalRequestedAt.keys()) {
    if (id.startsWith(prefix)) state.approvalRequestedAt.delete(id);
  }
  for (const id of state.invalidApprovalReviewIds) {
    if (id.startsWith(prefix)) state.invalidApprovalReviewIds.delete(id);
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

/**
 * Every in-memory home of a fire's approval state that still holds something of `runId`, by name.
 * Empty once the fire's approvals have all ended: this is what the matrix of endings asserts, and
 * the one place that lists the homes, so a home added to {@link ScheduledFireReviewState} is
 * checked by every ending's test (COR-1596).
 */
export function scheduledFireHoldings(state: ScheduledFireReviewState, runId: string): string[] {
  const prefix = `approval:${runId}:`;
  const holdsIds = (ids: Iterable<string>) => Array.from(ids).some((id) => id.startsWith(prefix));
  // One entry per home, typed over the state's own keys, so a home added to the state fails to
  // compile until it is listed here, and every ending's test then checks it.
  const holders: {
    [Home in Exclude<keyof ScheduledFireReviewState, 'now'>]: boolean;
  } = {
    pendingApprovalOverrides: holdsIds(state.pendingApprovalOverrides.keys()),
    pendingApprovalRounds: holdsIds(state.pendingApprovalRounds.keys()),
    approvalRequestedAt: holdsIds(state.approvalRequestedAt.keys()),
    resolvedReviewIds: holdsIds(state.resolvedReviewIds),
    invalidApprovalReviewIds: holdsIds(state.invalidApprovalReviewIds),
    terminalReviewSessions: state.terminalReviewSessions.has(runId),
    runRequestContexts: state.runRequestContexts.has(runId),
    runToolboxesByRunId: state.runToolboxesByRunId.has(runId),
    scheduledFireApprovalRuns: state.scheduledFireApprovalRuns.has(runId),
    continuingScheduledFires: state.continuingScheduledFires.has(runId),
  };
  return Object.entries(holders)
    .filter(([, held]) => held)
    .map(([home]) => home);
}

const stateOfBureau = new WeakMap<object, ScheduledFireReviewState>();

/** Remembers a Bureau's review state so a test can read it; nothing in production reads it. */
export function trackScheduledFireReviewState(
  bureau: object,
  state: ScheduledFireReviewState,
): void {
  stateOfBureau.set(bureau, state);
}

/** The review state of a Bureau that {@link trackScheduledFireReviewState} was given. */
export function scheduledFireReviewStateOf(bureau: object): ScheduledFireReviewState {
  const state = stateOfBureau.get(bureau);
  if (state === undefined) throw new Error('This Bureau has no tracked fire review state.');
  return state;
}

/**
 * The patch that takes the approvals of `runId` that `drop` names out of a session's metadata:
 * their overrides and rounds, and the run's request authority with the last of them. This is the
 * one function that prunes a fire's approvals from a session, whichever way they ended (decided,
 * expired, canceled, abandoned, removed), so no ending can forget one of the keys. `undefined`
 * when the session holds none of them, so a caller writes nothing. The decision fence
 * (`resolvedReviewIds`, `resolvedReviewDecisions`) is not touched: it outlives the approval, and
 * is retired with the fire's task.
 */
export function withoutFireApprovals(
  metadata: Record<string, JSONValue>,
  runId: string,
  drop: (reviewId: string) => boolean,
): Record<string, JSONValue> | undefined {
  const prefix = `approval:${runId}:`;
  const recordOf = (value: JSONValue | undefined): Record<string, JSONValue> =>
    isPlainAuthorityRecord(value) ? value : {};
  const overrides = recordOf(metadata['pendingApprovalOverrides']);
  const dropped = Object.keys(overrides).filter((id) => id.startsWith(prefix) && drop(id));
  if (dropped.length === 0) return undefined;
  const without = (record: Record<string, JSONValue>): Record<string, JSONValue> =>
    Object.fromEntries(Object.entries(record).filter(([id]) => !dropped.includes(id)));
  const remaining = without(overrides);
  const authorities = recordOf(metadata['lastRequestAuthorities']);
  const { [runId]: _ended, ...otherAuthorities } = authorities;
  const holdsApproval = Object.keys(remaining).some((id) => id.startsWith(prefix));
  return {
    pendingApprovalOverrides: remaining,
    pendingApprovalRounds: without(recordOf(metadata['pendingApprovalRounds'])),
    lastRequestAuthorities: holdsApproval ? authorities : otherAuthorities,
  };
}

/**
 * The review ids a run's checkpoint commits, approvals and human waits both: the ones a fire can
 * still own. A park's id carries its ordinal, the count of parks the run made before it. A request
 * the history holds for any other id was made by an attempt that never committed.
 */
export function committedFireReviewIds(
  runId: string,
  steps: readonly {
    readonly results: readonly {
      readonly outcome: string;
      readonly pendingApproval?: unknown;
      readonly toolName: string;
      readonly result: unknown;
    }[];
  }[],
): Set<string> {
  const committed = committedFireApprovalIds(runId, steps);
  let ordinal = 0;
  for (const step of steps) {
    for (const result of step.results) {
      const signalName = parkedSignalName(result);
      if (signalName === undefined) continue;
      committed.add(`human-wait:${runId}:${signalName}:${ordinal}`);
      ordinal += 1;
    }
  }
  return committed;
}
