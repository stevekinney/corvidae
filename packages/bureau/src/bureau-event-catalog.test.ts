/**
 * COR-1940 — the event catalog describes exactly the published kinds, so a new published kind
 * without an entry fails here (and at compile time).
 */
import { describe, expect, it } from 'bun:test';

import {
  type Action,
  AgentScheduledEvent,
  ScheduleAttemptedEvent,
  ScheduleCancelledEvent,
  ScheduleCompletedEvent,
  ScheduleFailedEvent,
  SchedulePausedEvent,
  ScheduleResumedEvent,
  ScheduleSkippedEvent,
  SessionCreatedEvent,
  SessionDeletedEvent,
  SessionSavedEvent,
  SteeringAcceptedEvent,
  WorkflowVersionMismatchEvent,
} from '@lostgradient/operative';

import { runOfPayload } from './hooks/hook-origin.ts';
import {
  BUREAU_EVENT_CATALOG,
  bureauEventCatalog,
  type BureauEventCatalogEntry,
  type BureauEventField,
  isPublishedEventKind,
} from './bureau-event-catalog.ts';
import {
  PUBLISHED_BUREAU_EVENT_KINDS,
  projectBureauEvent,
  type PublishedBureauEventKind,
} from './bureau-event-feed.ts';
import {
  ActionEvent,
  AssetLifecycleEvent,
  BureauDisposedEvent,
  ChildWorkflowAbortedRecordedEvent,
  ChildWorkflowCompletedRecordedEvent,
  ChildWorkflowFailedRecordedEvent,
  ChildWorkflowStartedRecordedEvent,
  HandoffOccurredRecordedEvent,
  HookPlanFailedRecordedEvent,
  PluginSecretRemovedEvent,
  PluginSecretSetEvent,
  PluginSettingsChangedEvent,
  PluginStatusChangedEvent,
  SteeringAppliedRecordedEvent,
  SteeringCommandFailedEvent,
  SteeringCommandRejectedEvent,
  SteeringCommandSupersededEvent,
  DecisionMadeEvent,
  DefinitionsChangedEvent,
  DiagnosticEvent,
  GoalLifecycleEvent,
  MemoryGovernanceEvent,
  NotificationCreatedEvent,
  SessionTaintEvent,
  RecoveryAttemptedEvent,
  RecoveryLeaseReleasedEvent,
  RecoveryRejectedEvent,
  ReviewApprovedEvent,
  ReviewCanceledEvent,
  ReviewDeniedEvent,
  ReviewExpiredEvent,
  ReviewRejectedEvent,
  ReviewRequestedEvent,
  ReviewRevokedEvent,
  ReviewSupersededEvent,
  BudgetThresholdRecordedEvent,
  RunAbortedOutcomeEvent,
  RunAbortSettledEvent,
  RunCompletedOutcomeEvent,
  RunFailedOutcomeEvent,
  RunGuardrailRecordedEvent,
  RunRegisteredEvent,
  RunTripwireRecordedEvent,
  ScorerThresholdBreachedEvent,
  ToolErrorRecordedEvent,
  ToolPolicyDeniedRecordedEvent,
  RunRemovedEvent,
  RunSettledEvent,
  ScheduleMissedEvent,
  TaskCleanupAcknowledgedEvent,
} from './events.ts';
import {
  SkillActivatedEvent,
  SkillDeactivatedEvent,
  SkillFailedEvent,
  SkillLoadedEvent,
  SkillRejectedEvent,
} from './skills/events.ts';

/** Every field a skill's correlation can carry. */
const FULL_CORRELATION = {
  runId: 'run-1',
  sessionId: 'session-1',
  traceId: 'trace-1',
  agentName: 'agent',
  sourceId: 'source-1',
  artifactDigest: 'digest',
} as const;
const TRANSITION = { dedupeKey: 'key-1', committedAtMs: 5 } as const;

/** The review events, which differ only in their class. */
const reviewOf = (
  Review:
    | typeof ReviewApprovedEvent
    | typeof ReviewDeniedEvent
    | typeof ReviewRejectedEvent
    | typeof ReviewExpiredEvent
    | typeof ReviewRevokedEvent
    | typeof ReviewSupersededEvent,
) => ({
  sparsest: () => new Review('review-1', 'run-1', 'api-key:a', 'tool-approval'),
});

const GOAL = (kind: ConstructorParameters<typeof GoalLifecycleEvent>[0]) => ({
  sparsest: () => new GoalLifecycleEvent(kind, { goalRunId: 'goal-1' }),
  fullest: () =>
    new GoalLifecycleEvent(kind, {
      goalRunId: 'goal-1',
      goalIdentity: { name: 'ship', version: '1' },
      attemptId: 'attempt-1',
      attemptIndex: 1,
      runId: 'run-1',
      validatorIdentity: { name: 'check', version: '1' },
      outcomeKind: 'pass',
      feedbackDigest: 'digest',
      judgedBy: {
        validator: { name: 'check', version: '1' },
        source: { kind: 'bureau', name: 'bureau', version: '0.1.0' },
      },
      retryReason: 'failed',
      terminalReason: 'done',
      validatorError: { kind: 'error', code: 'E', message: 'dropped' },
      controllerRestarts: 1,
      status: 'running',
      transitionSeq: 3,
    }),
});

const ASSET = (kind: ConstructorParameters<typeof AssetLifecycleEvent>[0]) => ({
  sparsest: () => new AssetLifecycleEvent(kind, { sequence: 1, at: '2026-01-01T00:00:00.000Z' }),
  fullest: () =>
    new AssetLifecycleEvent(kind, {
      sequence: 1,
      at: '2026-01-01T00:00:00.000Z',
      assetId: 'asset-1',
      revision: 2,
      state: 'ready',
      principal: 'api-key:a',
      uploadId: 'upload-1',
      digest: 'digest',
    }),
});

/** An action as the run store records one (COR-2096): the event's own fields are its detail. */
const recordedAction = (type: string, detail: Record<string, unknown>): Action => ({
  sequence: 1,
  runId: 'run-1',
  type,
  detail: { step: 0, ...detail },
  timestamp: 1_800_000_000_000,
});
const GUARDRAIL_DETAIL = {
  guardrailName: 'sentinel',
  category: 'prompt-injection',
  phase: 'input',
  confidence: 0.9,
};
const TOOL_DETAIL = { toolName: 'refund', toolCallId: 'call-1' };
const CHILD_DETAIL = {
  parentAgentName: 'planner',
  parentRunId: 'run-1',
  childAgentName: 'worker',
  childRunId: 'child-1',
};

const SKILL = (
  Skill:
    | typeof SkillLoadedEvent
    | typeof SkillActivatedEvent
    | typeof SkillDeactivatedEvent
    | typeof SkillFailedEvent,
) => ({
  sparsest: () => new Skill('skill', {}),
  fullest: () => new Skill('skill', FULL_CORRELATION),
});

/**
 * Every published kind, built the way its dispatch site can build it with the least: the guard
 * below projects each, as the wire carries it, and compares it with the catalog. A kind added to
 * `PUBLISHED_BUREAU_EVENT_KINDS` is a compile error here until it has a builder. `fullest` is given
 * where a kind has optional fields, so a field the catalog does not declare is found too.
 */
const EVENTS: Record<
  PublishedBureauEventKind,
  { readonly sparsest: () => unknown; readonly fullest?: () => unknown }
> = {
  action: {
    sparsest: () =>
      new ActionEvent({
        sequence: 1,
        runId: 'run-1',
        type: 'step',
        detail: null,
        timestamp: 1_800_000_000_000,
      }),
  },
  'run.tripwire': {
    sparsest: () => new RunTripwireRecordedEvent(recordedAction('run.tripwire', GUARDRAIL_DETAIL)),
  },
  'run.guardrail': {
    sparsest: () =>
      new RunGuardrailRecordedEvent(
        recordedAction('run.guardrail', { ...GUARDRAIL_DETAIL, action: 'block' }),
      ),
  },
  'budget.threshold': {
    sparsest: () =>
      new BudgetThresholdRecordedEvent(
        recordedAction('budget.threshold', {
          threshold: 0.5,
          currentCost: 0.1,
          budget: 0.15,
          model: 'cheap',
        }),
      ),
    fullest: () =>
      new BudgetThresholdRecordedEvent(
        recordedAction('budget.threshold', {
          step: 0,
          threshold: 0.5,
          currentCost: 0.1,
          budget: 0.15,
          model: 'cheap',
        }),
      ),
  },
  'tool.policy-denied': {
    sparsest: () =>
      new ToolPolicyDeniedRecordedEvent(recordedAction('tool.policy-denied', TOOL_DETAIL)),
  },
  'tool.error': {
    sparsest: () =>
      new ToolErrorRecordedEvent(
        recordedAction('tool.error', { ...TOOL_DETAIL, error: new Error('no code') }),
      ),
  },
  // COR-2097: what a run records of its children, its handoffs, its steering and its hook plan.
  'multiagent.child-workflow.started': {
    sparsest: () =>
      new ChildWorkflowStartedRecordedEvent(
        recordedAction('multiagent.child-workflow.started', CHILD_DETAIL),
      ),
  },
  'multiagent.child-workflow.completed': {
    sparsest: () =>
      new ChildWorkflowCompletedRecordedEvent(
        recordedAction('multiagent.child-workflow.completed', CHILD_DETAIL),
      ),
  },
  'multiagent.child-workflow.failed': {
    sparsest: () =>
      new ChildWorkflowFailedRecordedEvent(
        recordedAction('multiagent.child-workflow.failed', { ...CHILD_DETAIL, reason: 'error' }),
      ),
  },
  'multiagent.child-workflow.aborted': {
    sparsest: () =>
      new ChildWorkflowAbortedRecordedEvent(
        recordedAction('multiagent.child-workflow.aborted', CHILD_DETAIL),
      ),
  },
  'multiagent.handoff.occurred': {
    sparsest: () =>
      new HandoffOccurredRecordedEvent(
        recordedAction('multiagent.handoff.occurred', {
          sourceAgentName: 'planner',
          targetAgentName: 'worker',
        }),
      ),
  },
  'steering.applied': {
    sparsest: () =>
      new SteeringAppliedRecordedEvent(
        recordedAction('steering.applied', { sessionId: 'session-1', effective: {} }),
      ),
  },
  'hook-plan.failed': {
    sparsest: () =>
      new HookPlanFailedRecordedEvent(
        recordedAction('hook-plan.failed', {
          hookName: 'prepareStep',
          hookId: 'agent:own',
          error: new Error('no code'),
        }),
      ),
    fullest: () =>
      new HookPlanFailedRecordedEvent(
        recordedAction('hook-plan.failed', {
          hookName: 'prepareStep',
          hookId: 'agent:own',
          source: 'agent',
          error: new Error('no code'),
        }),
      ),
  },
  'run.registered': { sparsest: () => new RunRegisteredEvent('run-1') },
  'run.settled': {
    sparsest: () => new RunSettledEvent('run-1', 'completed'),
    fullest: () => new RunSettledEvent('run-1', 'failed', 'tripwire'),
  },
  'run.completed': {
    sparsest: () => new RunCompletedOutcomeEvent('run-1'),
    fullest: () => new RunCompletedOutcomeEvent('run-1', 'stop-condition'),
  },
  'run.error': {
    sparsest: () => new RunFailedOutcomeEvent('run-1', 'error'),
    fullest: () =>
      new RunFailedOutcomeEvent('run-1', 'error', {
        step: 3,
        errorCode: 'INTERNAL_ERROR',
        errorKind: 'generate',
      }),
  },
  'run.aborted': {
    sparsest: () => new RunAbortedOutcomeEvent('run-1'),
    fullest: () => new RunAbortedOutcomeEvent('run-1', 'aborted'),
  },
  'run.removed': { sparsest: () => new RunRemovedEvent('run-1') },
  'run.abort-settled': { sparsest: () => new RunAbortSettledEvent('run-1') },
  'bureau.disposed': { sparsest: () => new BureauDisposedEvent() },
  'recovery.attempted': { sparsest: () => new RecoveryAttemptedEvent('run-1', 'reattach') },
  'recovery.rejected': { sparsest: () => new RecoveryRejectedEvent('run-1', 'session-absent') },
  'recovery.lease-released': {
    sparsest: () => new RecoveryLeaseReleasedEvent('run-1', {} as never),
  },
  'schedule.created': {
    sparsest: () => new AgentScheduledEvent({ agentName: 'a', scheduleId: 's-1', spec: {} }),
    fullest: () =>
      new AgentScheduledEvent({
        agentName: 'a',
        scheduleId: 's-1',
        spec: { every: 5 },
        sessionId: 'session-1',
      }),
  },
  'schedule.paused': {
    sparsest: () => new SchedulePausedEvent('s-1'),
    fullest: () => new SchedulePausedEvent('s-1', TRANSITION),
  },
  'schedule.resumed': {
    sparsest: () => new ScheduleResumedEvent('s-1'),
    fullest: () => new ScheduleResumedEvent('s-1', TRANSITION),
  },
  'schedule.cancelled': {
    sparsest: () => new ScheduleCancelledEvent('s-1'),
    fullest: () => new ScheduleCancelledEvent('s-1', TRANSITION),
  },
  'schedule.failed': { sparsest: () => new ScheduleFailedEvent('s-1', 'run-1') },
  'schedule.completed': { sparsest: () => new ScheduleCompletedEvent('s-1', 'run-1') },
  'schedule.attempted': {
    sparsest: () => new ScheduleAttemptedEvent('s-1'),
    fullest: () => new ScheduleAttemptedEvent('s-1', 1_000),
  },
  'schedule.skipped': {
    sparsest: () => new ScheduleSkippedEvent('s-1', 'skip'),
    fullest: () => new ScheduleSkippedEvent('s-1', 'skip', 1_000, 'run-1'),
  },
  'skill.loaded': SKILL(SkillLoadedEvent),
  'skill.activated': SKILL(SkillActivatedEvent),
  'skill.deactivated': SKILL(SkillDeactivatedEvent),
  'skill.failed': SKILL(SkillFailedEvent),
  'skill.rejected': {
    sparsest: () => new SkillRejectedEvent('skill', 'disabled'),
    fullest: () =>
      new SkillRejectedEvent('skill', 'ownership-policy', FULL_CORRELATION, 'owner-only' as never),
  },
  'session.created': { sparsest: () => new SessionCreatedEvent('s', 'agent', 'i-1', 1, 5) },
  'session.saved': { sparsest: () => new SessionSavedEvent('s', 'agent', 'i-1', 1, 5) },
  'session.deleted': { sparsest: () => new SessionDeletedEvent('s', 'i-1', 1, 5) },
  'session.tainted': {
    sparsest: () =>
      new SessionTaintEvent({
        sessionId: 's',
        runId: 'r',
        detector: 'prompt-injection',
        provenance: 'user-input',
        confidence: 0.95,
      }),
  },
  'review.requested': {
    sparsest: () => new ReviewRequestedEvent('review-1', 'run-1', 'api-key:a', 'human-wait'),
  },
  'review.approved': reviewOf(ReviewApprovedEvent),
  'review.denied': reviewOf(ReviewDeniedEvent),
  'review.rejected': reviewOf(ReviewRejectedEvent),
  'review.expired': reviewOf(ReviewExpiredEvent),
  'review.revoked': reviewOf(ReviewRevokedEvent),
  'review.canceled': {
    sparsest: () => new ReviewCanceledEvent('review-1', 'run-1', 'api-key:a', 'tool-approval'),
    fullest: () => new ReviewCanceledEvent('review-1', 'run-1', 'api-key:a', 'tool-approval', 2),
  },
  'review.superseded': reviewOf(ReviewSupersededEvent),
  'steering.accepted': { sparsest: () => new SteeringAcceptedEvent('s', 'command-1', 2) },
  'steering.rejected': {
    sparsest: () =>
      new SteeringCommandRejectedEvent({ sessionId: 's', failureReason: 'policy-denied' }),
    fullest: () =>
      new SteeringCommandRejectedEvent({
        sessionId: 's',
        commandId: 'command-1',
        failureReason: 'policy-denied',
      }),
  },
  'steering.superseded': {
    sparsest: () =>
      new SteeringCommandSupersededEvent({ sessionId: 's', failureReason: 'superseded-by' }),
    fullest: () =>
      new SteeringCommandSupersededEvent({
        sessionId: 's',
        commandId: 'command-1',
        failureReason: 'superseded-by',
      }),
  },
  'steering.failed': {
    sparsest: () =>
      new SteeringCommandFailedEvent({ sessionId: 's', failureReason: 'deadline-passed' }),
    fullest: () =>
      new SteeringCommandFailedEvent({
        sessionId: 's',
        commandId: 'command-1',
        failureReason: 'deadline-passed',
      }),
  },
  'workflow.version-mismatch': {
    sparsest: () => new WorkflowVersionMismatchEvent('workflow-1', '1.0.0', '2.0.0'),
  },
  'goal.started': GOAL('goal.started'),
  'goal.attempt.started': GOAL('goal.attempt.started'),
  'goal.attempt.evaluating': GOAL('goal.attempt.evaluating'),
  'goal.attempt.validated': GOAL('goal.attempt.validated'),
  // The two live-only kinds are always built whole, so each field is required.
  'goal.feedback.recorded': {
    sparsest: () =>
      new GoalLifecycleEvent('goal.feedback.recorded', {
        goalRunId: 'goal-1',
        attemptId: 'attempt-1',
        feedbackDigest: 'digest',
      }),
  },
  'goal.retrying': {
    sparsest: () =>
      new GoalLifecycleEvent('goal.retrying', {
        goalRunId: 'goal-1',
        attemptIndex: 0,
        retryReason: 'failed',
      }),
  },
  'goal.succeeded': GOAL('goal.succeeded'),
  'goal.exhausted': GOAL('goal.exhausted'),
  'goal.canceled': GOAL('goal.canceled'),
  'goal.failed': GOAL('goal.failed'),
  'goal.recovered': GOAL('goal.recovered'),
  'asset.upload.started': ASSET('asset.upload.started'),
  'asset.upload.purged': ASSET('asset.upload.purged'),
  'asset.blob.purged': ASSET('asset.blob.purged'),
  'asset.expired': ASSET('asset.expired'),
  'definitions.changed': {
    sparsest: () =>
      new DefinitionsChangedEvent('agents', { added: [], changed: [], removed: [], rejected: [] }),
  },
  'schedule.missed': { sparsest: () => new ScheduleMissedEvent('s-1', 1, 10, 20, 'late') },
  'task.cleanup-acknowledged': {
    sparsest: () => new TaskCleanupAcknowledgedEvent('task-1', 'cleaned-up'),
  },
  'notification.created': { sparsest: () => new NotificationCreatedEvent('n-1', 'run.failed') },
  diagnostic: { sparsest: () => new DiagnosticEvent('warn', 'hooks') },
  'memory.governance': {
    sparsest: () =>
      new MemoryGovernanceEvent({
        type: 'memory.write.admitted',
        outcome: 'ok',
        tenantId: 't',
        at: 1,
        recordIds: [],
      }),
    fullest: () =>
      new MemoryGovernanceEvent({
        type: 'memory.write.admitted',
        outcome: 'ok',
        tenantId: 't',
        at: 1,
        recordIds: ['r-1'],
        operationId: 'op-1',
      }),
  },
  // COR-2098: what a host reports of its plugins and their secrets.
  'secret.set': { sparsest: () => new PluginSecretSetEvent('kit', 'kit-api-key') },
  'secret.removed': { sparsest: () => new PluginSecretRemovedEvent('kit', 'kit-api-key') },
  'plugin.settings-changed': {
    sparsest: () => new PluginSettingsChangedEvent('kit', false, true),
  },
  'plugin.status-changed': {
    sparsest: () =>
      new PluginStatusChangedEvent('kit', 'running', 'needs-setup', ['secret-missing']),
  },
  // Sparsest: a refusal no model was reached for. Fullest: every field set.
  'decision.made': {
    sparsest: () => new DecisionMadeEvent({ kind: 'boolean', outcome: 'refused' }),
    fullest: () =>
      new DecisionMadeEvent({
        kind: 'choice',
        outcome: 'answered',
        row: 'anthropic/claude-haiku-5-5',
        path: 'native',
        taskId: 'task-1',
      }),
  },
  // Sparsest: a `fail` the scorer gave no score for. Fullest: every field set.
  'scorer.threshold-breached': {
    sparsest: () =>
      new ScorerThresholdBreachedEvent({
        runId: 'run-1',
        scorerName: 'quality',
        scorerVersion: '1.0.0',
        outcome: 'fail',
      }),
    fullest: () =>
      new ScorerThresholdBreachedEvent({
        runId: 'run-1',
        scorerName: 'quality',
        scorerVersion: '1.0.0',
        outcome: 'pass',
        score: 0.2,
      }),
  },
};

function typeMatches(field: BureauEventField, value: unknown): boolean {
  switch (field.type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'string[]':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'unknown':
      return true;
  }
}

/** What a hook sees: the projection as JSON, which drops every field the dispatch site left undefined. */
function wirePayload(event: unknown, kind: PublishedBureauEventKind): Record<string, unknown> {
  const projected = projectBureauEvent(event);
  expect(projected?.kind).toBe(kind);
  return JSON.parse(JSON.stringify(projected?.payload)) as Record<string, unknown>;
}

describe('isPublishedEventKind (COR-2223)', () => {
  it('is true for a core kind, with or without declared kinds', () => {
    expect(isPublishedEventKind('run.settled', [])).toBe(true);
    expect(isPublishedEventKind('run.settled', ['demo:greeted'])).toBe(true);
  });

  it('is true for a kind a plugin declares', () => {
    expect(isPublishedEventKind('demo:greeted', ['demo:greeted'])).toBe(true);
  });

  it('is false for a kind nobody publishes or declares', () => {
    expect(isPublishedEventKind('run.nonexistent', [])).toBe(false);
    expect(isPublishedEventKind('demo:greeted', [])).toBe(false);
    expect(isPublishedEventKind('demo:greeted', ['demo:other'])).toBe(false);
  });

  it('never reads an inherited key as a published kind', () => {
    for (const kind of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(isPublishedEventKind(kind, [])).toBe(false);
    }
  });
});

describe('the Bureau event catalog', () => {
  it('lists exactly PUBLISHED_BUREAU_EVENT_KINDS, in order', () => {
    expect(bureauEventCatalog().map((entry) => entry.kind)).toEqual([
      ...PUBLISHED_BUREAU_EVENT_KINDS,
    ]);
    expect(Object.keys(BUREAU_EVENT_CATALOG).toSorted()).toEqual(
      [...PUBLISHED_BUREAU_EVENT_KINDS].toSorted(),
    );
    for (const entry of bureauEventCatalog()) {
      expect(BUREAU_EVENT_CATALOG[entry.kind].kind).toBe(entry.kind);
    }
  });

  it('describes every kind, and names each payload field once', () => {
    for (const entry of bureauEventCatalog()) {
      expect(entry.description.length).toBeGreaterThanOrEqual(15);
      const names = entry.payload.map((field) => field.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('classifies every kind’s origin as run, external or unattributed, and nothing else', () => {
    for (const entry of bureauEventCatalog()) {
      expect(['run', 'external', 'unattributed']).toContain(entry.origin);
    }
    // A kind with no classification would read as `undefined`: none may.
    expect(Object.values(BUREAU_EVENT_CATALOG).filter((entry) => !entry.origin)).toEqual([]);
  });

  it('classifies the kinds a run can raise without naming it as unattributed, so no start-workflow hook listens to them', () => {
    const byOrigin = (origin: string) =>
      bureauEventCatalog()
        .filter((entry) => entry.origin === origin)
        .map((entry): string => entry.kind)
        .toSorted();
    expect(byOrigin('unattributed')).toEqual(
      [
        'asset.blob.purged',
        'asset.expired',
        'asset.upload.purged',
        'asset.upload.started',
        'decision.made',
        'definitions.changed',
        'diagnostic',
        'memory.governance',
        'notification.created',
        'plugin.settings-changed',
        'plugin.status-changed',
        'schedule.attempted',
        'schedule.cancelled',
        'schedule.created',
        'schedule.paused',
        'schedule.resumed',
        'schedule.skipped',
        'secret.removed',
        'secret.set',
        'session.created',
        'session.deleted',
        'session.saved',
        'skill.activated',
        'skill.deactivated',
        'skill.failed',
        'skill.loaded',
        'skill.rejected',
        'steering.accepted',
        'steering.applied',
        'steering.failed',
        'steering.rejected',
        'steering.superseded',
        'workflow.version-mismatch',
      ].toSorted(),
    );
    // A narrow allowlist: each needs an argument that no run can cause it (see the catalog).
    expect(byOrigin('external')).toEqual(['bureau.disposed', 'schedule.missed']);
  });

  it('has a builder for every published kind', () => {
    expect(Object.keys(EVENTS).toSorted()).toEqual([...PUBLISHED_BUREAU_EVENT_KINDS].toSorted());
  });

  describe.each(PUBLISHED_BUREAU_EVENT_KINDS.map((kind) => [kind] as const))('%s', (kind) => {
    const entry: BureauEventCatalogEntry = BUREAU_EVENT_CATALOG[kind];
    const declared = new Map(entry.payload.map((field) => [field.name, field]));

    it('at its sparsest, carries every field the catalog calls required and no undeclared one', () => {
      const payload = wirePayload(EVENTS[kind].sparsest(), kind);
      for (const field of entry.payload.filter((candidate) => !candidate.optional)) {
        expect(Object.keys(payload)).toContain(field.name);
      }
      for (const [name, value] of Object.entries(payload)) {
        expect(declared.has(name)).toBe(true);
        expect(typeMatches(declared.get(name)!, value)).toBe(true);
      }
    });

    it('names a run the hook guard reads, in every event of a run kind', () => {
      // The guard follows the id `runOfPayload` returns, so a `run` kind must always carry one it
      // reads; the sparsest event is the one a dispatch site builds with the least.
      const sparsest = wirePayload(EVENTS[kind].sparsest(), kind);
      const named = runOfPayload(sparsest);
      if (entry.origin === 'run') {
        expect(typeof named).toBe('string');
        const requiredRunField = entry.payload.some(
          (field) =>
            !field.optional &&
            field.type === 'string' &&
            ['runId', 'goalRunId', 'taskId', 'parentRunId'].includes(field.name),
        );
        expect(requiredRunField).toBe(true);
      }
    });

    it('at its fullest, carries no undeclared field and every declared one of the right type', () => {
      const build = EVENTS[kind].fullest ?? EVENTS[kind].sparsest;
      const payload = wirePayload(build(), kind);
      for (const [name, value] of Object.entries(payload)) {
        expect(declared.has(name)).toBe(true);
        expect(typeMatches(declared.get(name)!, value)).toBe(true);
      }
      if (EVENTS[kind].fullest !== undefined) {
        // Every declared field is present in the fullest event, so none is declared that no event sets.
        expect(Object.keys(payload).toSorted()).toEqual([...declared.keys()].toSorted());
      }
    });
  });
});

describe('the decision.made kind (COR-2249)', () => {
  it('is unattributed with no scope, because taskId is optional, and names exactly its fields', () => {
    expect(BUREAU_EVENT_CATALOG['decision.made']).toMatchObject({
      kind: 'decision.made',
      origin: 'unattributed',
      scopes: [],
    });
    expect(
      BUREAU_EVENT_CATALOG['decision.made'].payload.map((field) => [field.name, field.optional]),
    ).toEqual([
      ['kind', false],
      ['outcome', false],
      ['row', true],
      ['path', true],
      ['taskId', true],
    ]);
  });

  it('names no field that could hold the request, the value, the rationale or the schema', () => {
    const names = BUREAU_EVENT_CATALOG['decision.made'].payload.map((field) => field.name);
    for (const forbidden of [
      'question',
      'context',
      'value',
      'rationale',
      'schema',
      'schemaSha256',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('the guardrail, budget and tool kinds (COR-2096)', () => {
  const GUARDRAIL_FIELDS = [
    ['runId', false],
    ['step', false],
    ['guardrailName', false],
    ['category', false],
    ['phase', false],
    ['confidence', false],
  ];
  const TOOL_FIELDS = [
    ['runId', false],
    ['step', false],
    ['toolName', false],
    ['toolCallId', false],
  ];
  const FIELDS_BY_KIND = {
    'run.tripwire': GUARDRAIL_FIELDS,
    'run.guardrail': [...GUARDRAIL_FIELDS, ['action', false]],
    'budget.threshold': [
      ['runId', false],
      ['step', true],
      ['threshold', false],
      ['currentCost', false],
      ['budget', false],
      ['model', false],
    ],
    'tool.policy-denied': TOOL_FIELDS,
    'tool.error': [...TOOL_FIELDS, ['errorCode', false]],
    'scorer.threshold-breached': [
      ['runId', false],
      ['scorerName', false],
      ['scorerVersion', false],
      ['outcome', false],
      ['score', true],
    ],
  } as const;

  it.each(Object.entries(FIELDS_BY_KIND))(
    'lists %s with origin run, every scope and exactly its fields',
    (kind, fields) => {
      const entry = BUREAU_EVENT_CATALOG[kind as keyof typeof FIELDS_BY_KIND];

      expect(entry).toMatchObject({
        kind,
        origin: 'run',
        scopes: ['agent', 'workflow', 'schedule'],
      });
      expect(entry.payload.map((field) => [field.name, field.optional])).toEqual(
        fields.map(([name, optional]) => [name, optional]),
      );
    },
  );

  it('names no free text: no payload field is a reason, a message, a detail or an argument list', () => {
    const forbidden = ['reason', 'message', 'detail', 'arguments', 'input', 'error', 'text'];
    for (const kind of Object.keys(FIELDS_BY_KIND)) {
      const names = BUREAU_EVENT_CATALOG[kind as keyof typeof FIELDS_BY_KIND].payload.map(
        (field) => field.name,
      );
      for (const name of forbidden) expect(names).not.toContain(name);
    }
  });
});

describe('the run outcome kinds (COR-2095)', () => {
  it.each(['run.completed', 'run.error', 'run.aborted'] as const)(
    'lists %s with origin run, scoped to agent, workflow and schedule',
    (kind) => {
      expect(BUREAU_EVENT_CATALOG[kind]).toMatchObject({
        kind,
        origin: 'run',
        scopes: ['agent', 'workflow', 'schedule'],
      });
    },
  );

  it('gives run.error exactly the fields the issue names, in projection order', () => {
    expect(
      BUREAU_EVENT_CATALOG['run.error'].payload.map((field) => [field.name, field.optional]),
    ).toEqual([
      ['runId', false],
      ['finishReason', false],
      ['step', true],
      ['errorCode', true],
      ['errorKind', true],
    ]);
  });

  it('gives run.settled a status and an optional finishReason', () => {
    expect(
      BUREAU_EVENT_CATALOG['run.settled'].payload.map((field) => [field.name, field.optional]),
    ).toEqual([
      ['runId', false],
      ['status', false],
      ['finishReason', true],
    ]);
  });

  it('states that no payload carries error text, and the owner-lost double announcement, in its header', async () => {
    const source = await Bun.file(new URL('./bureau-event-catalog.ts', import.meta.url)).text();
    const header = source.slice(0, source.indexOf('*/') + 2);

    expect(header).toContain('no free text, errors included');
    expect(header).toContain('bureau.tasks.get');
    expect(header).not.toContain('redactErrorMessage');
    expect(header).toContain('owner-lost');
  });
});
