/**
 * COR-1596 — the in-memory state a schedule fire's tool approval holds, with plain maps in
 * place of `createBureau`'s own, so each entry the registration writes and the release ends is
 * asserted by name.
 */
import type { PendingToolApproval, ToolRequestContext } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { countCheckpointParks } from './park-ordinals';
import {
  adoptRestoredScheduledFire,
  committedFireReviewIds,
  endContinuingScheduledFire,
  registerScheduledFireApproval,
  releaseScheduledFireReviews,
  type ScheduledFireReviewState,
  scheduledFireHoldings,
} from './scheduled-fire-review-state';
import type { BureauToolbox } from './runtime-composition';

function newState(now: () => number = () => 1_000): ScheduledFireReviewState {
  return {
    pendingApprovalOverrides: new Map(),
    pendingApprovalRounds: new Map(),
    terminalReviewSessions: new Map(),
    approvalRequestedAt: new Map(),
    runRequestContexts: new Map(),
    runToolboxesByRunId: new Map(),
    resolvedReviewIds: new Set(),
    invalidApprovalReviewIds: new Set(),
    scheduledFireApprovalRuns: new Set(),
    continuingScheduledFires: new Set(),
    now,
  };
}

const requestContext = {
  authority: {
    principalId: 'system:scheduler',
    tenantId: 'bureau',
    ownerId: 'researcher',
    capabilities: ['tools:execute'],
    authorizationRevision: 'scheduler:1',
  },
} as ToolRequestContext;
const toolbox = { name: 'the fire’s toolbox' } as unknown as BureauToolbox;
const fire = { runId: 'fire-1', sessionId: 'session-1', agentName: 'researcher', requestContext };
const approval = (arguments_: Record<string, number> = {}): PendingToolApproval => ({
  callId: 'call-1',
  toolName: 'charge-card',
  arguments: arguments_,
  action: { type: 'input' },
});
const reviewId = 'approval:fire-1:call-1';

describe('registerScheduledFireApproval', () => {
  it('records the approval, the fire, its session, its context and its toolbox', () => {
    const state = newState(() => 5_000);

    registerScheduledFireApproval(state, fire, toolbox, reviewId, approval(), true);

    expect(state.pendingApprovalOverrides.get(reviewId)).toEqual(approval());
    expect(state.scheduledFireApprovalRuns.has('fire-1')).toBe(true);
    expect(state.terminalReviewSessions.get('fire-1')).toEqual({
      sessionId: 'session-1',
      agentName: 'researcher',
      requestedAt: 5_000,
    });
    expect(state.runRequestContexts.get('fire-1')).toBe(requestContext);
    expect(state.runToolboxesByRunId.get('fire-1')).toBe(toolbox);
  });

  it('is the same registration when a step replays, and keeps the first request time', () => {
    let now = 5_000;
    const state = newState(() => now);
    registerScheduledFireApproval(state, fire, toolbox, reviewId, approval(), true);
    now = 9_000;

    registerScheduledFireApproval(state, fire, toolbox, reviewId, approval(), true);

    expect(state.pendingApprovalOverrides.size).toBe(1);
    expect(state.terminalReviewSessions.get('fire-1')?.requestedAt).toBe(5_000);
  });

  it('replaces an approval another attempt left under the same id', () => {
    const state = newState();
    registerScheduledFireApproval(state, fire, toolbox, reviewId, approval({ cents: 100 }), true);

    registerScheduledFireApproval(state, fire, toolbox, reviewId, approval({ cents: 200 }), true);

    expect(state.pendingApprovalOverrides.get(reviewId)?.arguments).toEqual({ cents: 200 });
  });

  it('keeps the replacement approval of a re-gate, which a replayed step must not undo', () => {
    const state = newState();
    registerScheduledFireApproval(state, fire, toolbox, reviewId, approval({ cents: 100 }), true);
    state.pendingApprovalOverrides.set(reviewId, approval({ cents: 150 }));
    state.pendingApprovalRounds.set(reviewId, 1);

    registerScheduledFireApproval(state, fire, toolbox, reviewId, approval({ cents: 100 }), true);

    expect(state.pendingApprovalOverrides.get(reviewId)?.arguments).toEqual({ cents: 150 });
  });

  it('registers nothing for a review already decided or found invalid', () => {
    const decided = newState();
    decided.resolvedReviewIds.add(reviewId);
    const invalid = newState();
    invalid.invalidApprovalReviewIds.add(reviewId);

    for (const state of [decided, invalid]) {
      registerScheduledFireApproval(state, fire, toolbox, reviewId, approval(), true);
      expect(state.pendingApprovalOverrides.size).toBe(0);
      expect(state.scheduledFireApprovalRuns.size).toBe(0);
      expect(state.runToolboxesByRunId.size).toBe(0);
    }
  });
});

describe('scheduledFireHoldings', () => {
  it('names every home that holds something of the run, and none for another run', () => {
    const state = newState();
    registerScheduledFireApproval(state, fire, toolbox, reviewId, approval(), false);
    state.resolvedReviewIds.add(reviewId);
    state.invalidApprovalReviewIds.add(reviewId);
    state.pendingApprovalRounds.set(reviewId, 1);

    expect(scheduledFireHoldings(state, 'fire-1').toSorted()).toEqual(
      [
        'approvalRequestedAt',
        'continuingScheduledFires',
        'invalidApprovalReviewIds',
        'pendingApprovalOverrides',
        'pendingApprovalRounds',
        'resolvedReviewIds',
        'runRequestContexts',
        'runToolboxesByRunId',
        'scheduledFireApprovalRuns',
        'terminalReviewSessions',
      ].toSorted(),
    );
    expect(scheduledFireHoldings(state, 'fire-2')).toEqual([]);
  });

  it('is empty once the fire is released, an approval found invalid included', () => {
    const state = newState();
    registerScheduledFireApproval(state, fire, toolbox, reviewId, approval(), true);
    state.invalidApprovalReviewIds.add(reviewId);

    releaseScheduledFireReviews(state, 'fire-1');
    endContinuingScheduledFire(state, 'fire-1');
    state.pendingApprovalOverrides.delete(reviewId);

    expect(scheduledFireHoldings(state, 'fire-1')).toEqual([]);
  });
});

describe('a fire that continues past its approval', () => {
  it('is marked while it has steps to take, through a release, until it settles', () => {
    const state = newState();

    registerScheduledFireApproval(state, fire, toolbox, reviewId, approval(), false);

    expect(state.continuingScheduledFires.has('fire-1')).toBe(true);
    // The release comes as the approval is decided, ahead of the write of its outcome, which asks.
    releaseScheduledFireReviews(state, 'fire-1');
    expect(state.continuingScheduledFires.has('fire-1')).toBe(true);
    endContinuingScheduledFire(state, 'fire-1');
    expect(state.continuingScheduledFires.has('fire-1')).toBe(false);
  });

  it('is not marked when the step that left the approval was its last', () => {
    const state = newState();

    registerScheduledFireApproval(state, fire, toolbox, reviewId, approval(), true);

    expect(state.continuingScheduledFires.has('fire-1')).toBe(false);
  });
});

describe('releaseScheduledFireReviews', () => {
  it('ends every entry of the fire and nothing of another run', () => {
    const state = newState();
    registerScheduledFireApproval(state, fire, toolbox, reviewId, approval(), true);
    state.resolvedReviewIds.add(reviewId);
    state.pendingApprovalRounds.set(reviewId, 0);
    const other = { ...fire, runId: 'fire-2' };
    registerScheduledFireApproval(
      state,
      other,
      toolbox,
      'approval:fire-2:call-1',
      approval(),
      true,
    );
    state.resolvedReviewIds.add('approval:fire-2:call-1');

    expect(releaseScheduledFireReviews(state, 'fire-1')).toBe(true);

    expect(state.scheduledFireApprovalRuns.has('fire-1')).toBe(false);
    expect(state.runRequestContexts.has('fire-1')).toBe(false);
    expect(state.runToolboxesByRunId.has('fire-1')).toBe(false);
    expect(state.terminalReviewSessions.has('fire-1')).toBe(false);
    expect(state.resolvedReviewIds.has(reviewId)).toBe(false);
    expect(state.pendingApprovalRounds.has(reviewId)).toBe(false);
    expect(state.scheduledFireApprovalRuns.has('fire-2')).toBe(true);
    expect(state.runToolboxesByRunId.has('fire-2')).toBe(true);
    expect(state.resolvedReviewIds.has('approval:fire-2:call-1')).toBe(true);
  });

  it('leaves a run that was never a fire’s alone', () => {
    const state = newState();
    state.runToolboxesByRunId.set('session-run', toolbox);
    state.resolvedReviewIds.add('approval:session-run:call-1');

    expect(releaseScheduledFireReviews(state, 'session-run')).toBe(false);

    expect(state.runToolboxesByRunId.has('session-run')).toBe(true);
    expect(state.resolvedReviewIds.has('approval:session-run:call-1')).toBe(true);
  });

  it('ends a fire the boot restore adopted as it ends one registered live', () => {
    const state = newState();
    adoptRestoredScheduledFire(state, 'fire-1');
    state.runToolboxesByRunId.set('fire-1', toolbox);

    expect(releaseScheduledFireReviews(state, 'fire-1')).toBe(true);
    expect(state.runToolboxesByRunId.has('fire-1')).toBe(false);
  });
});

describe('committedFireReviewIds', () => {
  const parked = (signalName: string) => ({
    outcome: 'success',
    toolName: 'requestHumanInput',
    result: { parked: true, signalName },
  });

  it('numbers a park by the shared rule: results on one signal in a step are one park', () => {
    const committed = committedFireReviewIds('run-1', [
      { results: [parked('s'), parked('s')] },
      { results: [parked('t')] },
    ]);

    expect([...committed].filter((id) => id.startsWith('human-wait:')).toSorted()).toEqual([
      'human-wait:run-1:s:0',
      'human-wait:run-1:t:1',
    ]);
  });

  it('agrees with the checkpoint walk about the ordinal of the park a run is waiting on', () => {
    const steps = [{ results: [parked('s'), parked('s')] }, { results: [parked('t')] }];

    const outstanding = countCheckpointParks(steps).outstanding;

    expect(committedFireReviewIds('run-1', steps)).toContain(
      `human-wait:run-1:${outstanding?.signalName}:${outstanding?.ordinal}`,
    );
  });
});
