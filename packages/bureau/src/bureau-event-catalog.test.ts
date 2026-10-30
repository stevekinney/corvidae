/**
 * COR-1940 — the event catalog describes exactly the published kinds, so a new published kind
 * without an entry fails here (and at compile time).
 */
import { describe, expect, it } from 'bun:test';

import {
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
} from '@lostgradient/operative';

import { runOfPayload } from './hooks/hook-origin.ts';
import {
  BUREAU_EVENT_CATALOG,
  bureauEventCatalog,
  type BureauEventCatalogEntry,
  type BureauEventField,
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
  DefinitionsChangedEvent,
  DiagnosticEvent,
  GoalLifecycleEvent,
  MemoryGovernanceEvent,
  NotificationCreatedEvent,
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
  RunAbortSettledEvent,
  RunRegisteredEvent,
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
  'run.registered': { sparsest: () => new RunRegisteredEvent('run-1') },
  'run.settled': { sparsest: () => new RunSettledEvent('run-1') },
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
  'goal.started': GOAL('goal.started'),
  'goal.attempt.started': GOAL('goal.attempt.started'),
  'goal.attempt.evaluating': GOAL('goal.attempt.evaluating'),
  'goal.attempt.validated': GOAL('goal.attempt.validated'),
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
        'diagnostic',
        'memory.governance',
        'notification.created',
        'schedule.cancelled',
        'schedule.created',
        'schedule.paused',
        'schedule.resumed',
        'session.created',
        'session.deleted',
        'session.saved',
        'skill.activated',
        'skill.deactivated',
        'skill.failed',
        'skill.loaded',
        'skill.rejected',
        'steering.accepted',
      ].toSorted(),
    );
    expect(byOrigin('external')).toEqual(
      [
        'bureau.disposed',
        'definitions.changed',
        'schedule.attempted',
        'schedule.missed',
        'schedule.skipped',
      ].toSorted(),
    );
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
            ['runId', 'goalRunId', 'taskId'].includes(field.name),
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
